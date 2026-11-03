import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const RENEWABLE_RENTAL_STATES = ['PENDING_HANDOVER', 'ACTIVE', 'EXPIRED'];

export function priceRentalRenewal(snapshot: Prisma.Decimal | string | number | null, quantity: number, months: number) {
  if (snapshot == null) throw new BadRequestException('RECONCILIATION_REQUIRED: missing verified monthly price snapshot');
  const unitPrice = new Prisma.Decimal(snapshot);
  if (!unitPrice.isFinite() || !unitPrice.isInteger() || !unitPrice.gt(0) ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > 100 ||
      !Number.isInteger(months) || months < 1 || months > 120) {
    throw new BadRequestException('Invalid rental renewal snapshot, quantity or term');
  }
  const amount = unitPrice.mul(quantity).mul(months);
  if (amount.gt('9999999999999')) throw new BadRequestException('Renewal amount exceeds VND storage limit');
  return { amount, periodPricePerButton: unitPrice.mul(months) };
}

/** Device locks precede rental locks, matching handover/return request. No provider I/O. */
export async function lockRentalRenewalContext(tx: Prisma.TransactionClient, rentalId: bigint, actorUserId?: bigint) {
  const buttons = await tx.$queryRawUnsafe<any[]>(
    'SELECT * FROM iot_button WHERE rental_id = $1 ORDER BY button_id ASC FOR UPDATE', rentalId,
  );
  const rentals = await tx.$queryRawUnsafe<any[]>(
    'SELECT * FROM button_rentals WHERE rental_id = $1 FOR UPDATE', rentalId,
  );
  const rental = rentals[0];
  if (!rental) throw new NotFoundException('Rental not found');
  if (actorUserId !== undefined) {
    const profile = await tx.customerProfile.findUnique({ where: { customerId: rental.customer_id }, select: { userId: true } });
    if (profile?.userId !== actorUserId) throw new ForbiddenException('Rental does not belong to this customer');
  }
  const returns = await tx.rentalReturn.findMany({
    where: { rentalId, status: { in: ['PENDING_RECEIPT', 'RECEIVED'] } }, select: { buttonId: true },
  });
  const returning = new Set(returns.map(r => String(r.buttonId)));
  const eligibleButtons = buttons.filter(b => b.customer_id === rental.customer_id &&
    b.inventory_state === 'IN_CUSTOMER_CUSTODY' && !returning.has(String(b.button_id)));
  const quantity = rental.status === 'PENDING_HANDOVER' ? rental.button_quantity : eligibleButtons.length;
  return { rental, eligibleButtons, quantity };
}

/** Returns false for paid-but-no-longer-applicable quotes; caller records unapplied money. */
export async function settleRentalRenewalInTx(tx: Prisma.TransactionClient, charge: any, providerReference: string) {
  const { rental, eligibleButtons, quantity } = await lockRentalRenewalContext(tx, charge.target_id);
  if (!RENEWABLE_RENTAL_STATES.includes(rental.status) || rental.monthly_rent_per_button_snapshot == null ||
      rental.pricing_review_required || quantity < 1) return false;
  const lines = await tx.billingChargeLine.findMany({ where: { chargeId: charge.charge_id } });
  const line = lines[0];
  if (lines.length !== 1 || line.lineType !== 'RENT' || line.quantity !== quantity ||
      line.durationUnit !== 'MONTH' || !Number.isInteger(line.durationCount) || line.durationCount! < 1 || line.durationCount! > 120) return false;
  const pricing = priceRentalRenewal(rental.monthly_rent_per_button_snapshot, quantity, line.durationCount!);
  if (!pricing.amount.eq(charge.total_amount) || !line.amount.eq(pricing.amount) ||
      !line.unitPrice?.eq(pricing.periodPricePerButton)) return false;
  const now = new Date();
  const additionalMs = line.durationCount! * 30 * 86400000;
  const next = (value: Date | null) => new Date(Math.max(value ? new Date(value).getTime() : 0, now.getTime()) + additionalMs);
  const paidThrough = rental.status === 'PENDING_HANDOVER' ? null : next(rental.paid_through);
  // Keep financial paidThrough separate from granted/reduced effective entitlement.
  const effectiveExpiry = rental.status === 'PENDING_HANDOVER' ? null : next(rental.effective_expires_at);
  const updated = await tx.billingCharge.updateMany({ where: { chargeId: charge.charge_id, status: 'PENDING' },
    data: { status: 'PAID', paidAt: now, paymentMethod: 'PAYOS', providerTransactionCode: providerReference } });
  if (updated.count !== 1) throw new BadRequestException('CHARGE_SETTLEMENT_CONFLICT');
  await tx.buttonRental.update({ where: { rentalId: rental.rental_id }, data: {
    monthsRented: { increment: line.durationCount! },
    ...(rental.status === 'PENDING_HANDOVER' ? {} : { status: 'ACTIVE', paidThrough, effectiveExpiresAt: effectiveExpiry, endDate: effectiveExpiry! }),
  } });
  for (const button of eligibleButtons) {
    // Operational ACTIVE is preserved by expiry. Never unlock manual/legacy INACTIVE.
    await tx.ioTButton.update({ where: { buttonId: button.button_id }, data: { canOrder: button.status === 'ACTIVE' } });
  }
  await tx.outboxEvent.create({ data: { eventType: 'BILLING_CHARGE_SETTLED', status: 'PENDING', payload: {
    chargeId: String(charge.charge_id), purpose: 'RENTAL_EXTENSION', targetId: String(rental.rental_id), totalAmount: pricing.amount.toNumber(),
  } } });
  await tx.rentalAuditLog.create({ data: { actorType: 'SYSTEM', action: 'RENEW_RENTAL', targetType: 'RENTAL',
    targetId: rental.rental_id, beforeState: rental.status, afterState: rental.status === 'PENDING_HANDOVER' ? rental.status : 'ACTIVE',
    amount: pricing.amount, metadata: { chargeId: String(charge.charge_id), quantity, months: line.durationCount },
  } });
  return true;
}
