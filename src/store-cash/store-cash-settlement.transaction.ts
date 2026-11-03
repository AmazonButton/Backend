import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { settleRentalRenewalInTx } from '../rentals/rental-renewal.transaction';

export const storeCashEnabled = () => process.env.STORE_CASH_COLLECTION_ENABLED === 'true';
export const BILLING_PAYOS_CHANNEL = 'PAYOS_BILLING'; // Same money channel for webhook and polling.
type Tx = Prisma.TransactionClient;
export type SettlementActor = { userId?: bigint; role?: string };

export function cashConflict(errorCode: string, message: string): never {
  throw new ConflictException({ success: false, errorCode, message });
}

/** Shared initial-rental effects. Caller already holds charge (+ devices for pickup) locks. */
export async function settleInitialRentalInTx(
  tx: Tx, charge: any, method: 'PAYOS' | 'STORE_CASH_OFFSET', actor?: SettlementActor,
  providerReference?: string,
) {
  if (charge.status !== 'PENDING' || charge.purpose !== 'RENTAL_INITIAL' || charge.target_type !== 'RENTAL') {
    cashConflict('CHARGE_NOT_PENDING_INITIAL_RENTAL', 'Charge is not an unpaid initial rental charge');
  }
  const rentals = await tx.$queryRawUnsafe<any[]>(
    'SELECT * FROM button_rentals WHERE rental_id = $1 FOR UPDATE', charge.target_id,
  );
  const rental = rentals[0];
  if (!rental) throw new NotFoundException('Rental not found');
  if (rental.status !== 'PENDING_PAYMENT') cashConflict('RENTAL_NOT_PENDING_PAYMENT', 'Rental is not awaiting initial payment');
  const lines = await tx.billingChargeLine.findMany({ where: { chargeId: charge.charge_id } });
  const rent = lines.filter(l => l.lineType === 'RENT');
  const deposit = lines.filter(l => l.lineType === 'DEPOSIT');
  const amount = new Prisma.Decimal(charge.total_amount);
  if (rent.length !== 1 || deposit.length !== 1 || lines.length !== 2 ||
      !Number.isInteger(rent[0].durationCount) || rent[0].durationCount! <= 0 ||
      rent[0].durationUnit !== 'MONTH' || !rent[0].amount.gt(0) || deposit[0].amount.lt(0) ||
      !rent[0].amount.plus(deposit[0].amount).eq(amount) ||
      !deposit[0].amount.eq(rental.deposit_amount)) {
    cashConflict('INVALID_INITIAL_CHARGE_LINES', 'Charge lines do not match the rental deposit and paid term');
  }
  const changed = await tx.billingCharge.updateMany({
    where: { chargeId: charge.charge_id, status: 'PENDING' },
    data: { status: 'PAID', paidAt: new Date(), paymentMethod: method,
      ...(providerReference ? { providerTransactionCode: providerReference } : {}) },
  });
  if (changed.count !== 1) cashConflict('CHARGE_SETTLEMENT_CONFLICT', 'Charge has already been settled');

  // Never reset a deposit ledger which may already contain holds/refunds.
  const current = await tx.rentalDeposit.findUnique({ where: { rentalId: rental.rental_id } });
  if (current) {
    if (![current.collectedAmount, current.heldAmount, current.refundReservedAmount, current.refundedAmount].every(v => v.isZero())) {
      cashConflict('EXISTING_DEPOSIT_LEDGER', 'Initial deposit already has financial activity');
    }
    await tx.rentalDeposit.update({ where: { rentalId: rental.rental_id }, data: {
      collectedAmount: { increment: deposit[0].amount }, heldAmount: { increment: deposit[0].amount },
    } });
  } else {
    await tx.rentalDeposit.create({ data: { rentalId: rental.rental_id,
      collectedAmount: deposit[0].amount, heldAmount: deposit[0].amount,
      refundReservedAmount: 0, refundedAmount: 0 } });
  }
  await tx.buttonRental.update({ where: { rentalId: rental.rental_id }, data: {
    status: 'PENDING_HANDOVER', paidThrough: null, effectiveExpiresAt: null,
  } });
  await tx.outboxEvent.create({ data: { eventType: 'BILLING_CHARGE_SETTLED', status: 'PENDING', payload: {
    chargeId: String(charge.charge_id), chargeCode: charge.charge_code, purpose: charge.purpose,
    targetId: String(charge.target_id), totalAmount: amount.toNumber(),
  } } });
  await tx.rentalAuditLog.create({ data: { actorType: actor?.userId ? 'STAFF' : 'SYSTEM',
    actorUserId: actor?.userId ?? null, action: 'SETTLE_CHARGE', targetType: 'RENTAL',
    targetId: rental.rental_id, beforeState: 'PENDING', afterState: 'PAID', amount,
    correlationId: charge.charge_code, metadata: { chargeId: String(charge.charge_id), method },
  } });
  return { ...rental, status: 'PENDING_HANDOVER' };
}

export interface InitialPayosReceipt {
  provider: string;
  providerTransactionCode: string;
  amount: number;
  currency: string;
  verified: true;
  paymentLinkId?: string;
  paidAt?: Date;
}

/** Called only after server-side signature/provider verification, never with an HTTP body. */
export async function recordRentalPayosReceiptInTx(tx: Tx, charge: any, receipt: InitialPayosReceipt, actor?: SettlementActor) {
  if (receipt.verified !== true || receipt.provider !== 'PAYOS' || receipt.currency !== 'VND' || charge.currency !== 'VND' ||
      !Number.isSafeInteger(receipt.amount) || receipt.amount <= 0 ||
      typeof receipt.providerTransactionCode !== 'string' ||
      !/^[^\s]{1,128}$/.test(receipt.providerTransactionCode) ||
      !charge.payment_link_id || receipt.paymentLinkId !== charge.payment_link_id ||
      (receipt.paidAt && (!(receipt.paidAt instanceof Date) || !Number.isFinite(receipt.paidAt.getTime())))) {
    throw new BadRequestException('Invalid verified payment identity, amount or link binding');
  }
  if (!['RENTAL_INITIAL', 'RENTAL_EXTENSION'].includes(charge.purpose) || charge.target_type !== 'RENTAL') {
    throw new BadRequestException('Receipt integration only supports rental charges');
  }
  const key = { provider: 'PAYOS', channel: BILLING_PAYOS_CHANNEL, providerTransactionRef: receipt.providerTransactionCode };
  const existing = await tx.billingPaymentReceipt.findUnique({ where: { provider_channel_providerTransactionRef: key } });
  if (existing) {
    if (existing.chargeId !== charge.charge_id || !new Prisma.Decimal(existing.amount).eq(receipt.amount) || existing.currency !== receipt.currency) {
      cashConflict('PROVIDER_RECEIPT_CONFLICT', 'Provider transaction identity conflicts with recorded receipt');
    }
    return { alreadySettled: true, overpayment: existing.classification === 'OVERPAYMENT_RECEIPT', storeWalletCredited: false };
  }
  let classification = 'SETTLEMENT_RECEIPT';
  if (charge.status === 'PENDING') {
    if (!new Prisma.Decimal(charge.total_amount).eq(receipt.amount)) {
      classification = 'OVERPAYMENT_RECEIPT';
    } else if (charge.purpose === 'RENTAL_EXTENSION') {
      const applied = await settleRentalRenewalInTx(tx, charge, receipt.providerTransactionCode);
      if (!applied) classification = 'OVERPAYMENT_RECEIPT';
    } else {
      const rentals = await tx.$queryRawUnsafe<any[]>('SELECT * FROM button_rentals WHERE rental_id = $1 FOR UPDATE', charge.target_id);
      if (rentals[0]?.status !== 'PENDING_PAYMENT') classification = 'OVERPAYMENT_RECEIPT';
      else await settleInitialRentalInTx(tx, charge, 'PAYOS', actor, receipt.providerTransactionCode);
    }
  } else if (charge.status !== 'PAID') {
    // Verified real money is durable even when the quote was cancelled/expired.
    classification = 'OVERPAYMENT_RECEIPT';
  } else if (charge.payment_method === 'STORE_CASH_OFFSET') {
    classification = 'OVERPAYMENT_RECEIPT';
  } else if (charge.provider_transaction_code === receipt.providerTransactionCode) {
    // Legacy exact-reference replay: adopt the receipt WITHOUT settling again.
    if (!new Prisma.Decimal(charge.total_amount).eq(receipt.amount)) {
      cashConflict('LEGACY_RECEIPT_MISMATCH', 'Legacy payment amount requires reconciliation');
    }
  } else {
    const prior = await tx.billingPaymentReceipt.findFirst({ where: { chargeId: charge.charge_id, classification: 'SETTLEMENT_RECEIPT' } });
    if (!prior) cashConflict('LEGACY_PAYMENT_RECONCILIATION_REQUIRED', 'Historical payment identity must be reconciled before recording a different receipt');
    classification = 'OVERPAYMENT_RECEIPT';
  }
  const saved = await tx.billingPaymentReceipt.create({ data: { ...key, chargeId: charge.charge_id,
    amount: receipt.amount, currency: receipt.currency, classification, receivedAt: receipt.paidAt ?? new Date(),
  } });
  if (classification === 'OVERPAYMENT_RECEIPT') {
    await tx.billingOverpaymentObligation.create({ data: {
      receiptId: saved.id, amount: receipt.amount, receiptClassification: 'OVERPAYMENT_RECEIPT', status: 'PENDING_RECONCILIATION',
    } });
  }
  return { alreadySettled: charge.status === 'PAID', overpayment: classification === 'OVERPAYMENT_RECEIPT', storeWalletCredited: false };
}

// Compatibility export for callers/tests of the initial-only helper. One implementation.
export const recordInitialPayosReceiptInTx = recordRentalPayosReceiptInTx;
