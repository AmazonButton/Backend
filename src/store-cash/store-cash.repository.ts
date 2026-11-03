import { ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTransactionRetry } from '../common/utils/transaction-retry.util';
import { handoverRentalButtonsInTx } from '../rentals/rental-handover.transaction';
import { createCashVoucherToken, hashCashVoucherToken } from './cash-voucher-token';
import { CollectCashDto, collectCashSchema, cashResourceIdSchema, validateZod } from './dto/store-cash.dto';
import { cashConflict, settleInitialRentalInTx, storeCashEnabled } from './store-cash-settlement.transaction';

@Injectable()
export class StoreCashRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Customer authorizes a specific collecting Store via a random 32-byte QR token. */
  async issueVoucher(
    actorUserId: bigint,
    rentalId: bigint,
    chargeId: bigint,
    collectingStoreId: bigint,
    ttlMinutes = 120,
  ) {
    if (!storeCashEnabled()) throw new ServiceUnavailableException('Store cash collection is disabled');
    for (const id of [actorUserId, rentalId, chargeId, collectingStoreId]) {
      cashResourceIdSchema.parse(String(id));
    }
    const { token, tokenHash } = createCashVoucherToken();
    return runWithTransactionRetry(() => this.prisma.$transaction(async (tx) => {
      // 1. Verify user is ACTIVE and find their CustomerProfile.customerId
      const profiles = await tx.$queryRawUnsafe<any[]>(
        `SELECT cp.customer_id FROM customer_profile cp
         JOIN users u ON u.user_id = cp.user_id
         WHERE u.user_id = $1 AND u.status = 'ACTIVE' FOR SHARE OF cp, u`,
        actorUserId,
      );
      if (!profiles.length) {
        throw new ForbiddenException('Active customer account required');
      }
      const customerId = BigInt(profiles[0].customer_id);

      // 2. Verify collecting store is ACTIVE
      const stores = await tx.$queryRawUnsafe<any[]>(
        'SELECT store_id FROM store WHERE store_id = $1 AND status = \'ACTIVE\' FOR SHARE',
        collectingStoreId,
      );
      if (!stores.length) throw new NotFoundException('Active collecting store required');

      // 3. Lock billing_charges FIRST (consistent lock graph with cash settlement)
      const charges = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM billing_charges WHERE charge_id = $1 FOR UPDATE',
        chargeId,
      );
      const charge = charges[0];
      if (!charge) throw new NotFoundException('Billing charge not found');
      if (
        charge.target_id !== rentalId ||
        charge.target_type !== 'RENTAL' ||
        charge.purpose !== 'RENTAL_INITIAL' ||
        charge.currency !== 'VND'
      ) {
        cashConflict('INVALID_CASH_CHARGE', 'Voucher requires the specified initial rental charge');
      }
      if (charge.status !== 'PENDING') {
        cashConflict('CHARGE_NOT_PENDING', 'Charge is already paid or cancelled');
      }

      // 4. Lock button_rentals SECOND
      const rentals = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM button_rentals WHERE rental_id = $1 AND customer_id = $2 FOR UPDATE',
        rentalId,
        customerId,
      );
      const rental = rentals[0];
      if (!rental) throw new NotFoundException('Rental contract not found');
      if (rental.status !== 'PENDING_PAYMENT') {
        cashConflict('RENTAL_NOT_PENDING_PAYMENT', 'Rental contract is not awaiting payment');
      }

      // 5. Lock and atomically revoke prior ACTIVE vouchers for this rental
      await tx.$queryRawUnsafe<any[]>(
        'SELECT id FROM store_cash_vouchers WHERE rental_id = $1 AND status = \'ACTIVE\' FOR UPDATE',
        rentalId,
      );
      await tx.storeCashVoucher.updateMany({
        where: { rentalId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });

      const clock = await tx.$queryRawUnsafe<any[]>('SELECT clock_timestamp() AS now');
      const expiresAt = new Date(clock[0].now.getTime() + ttlMinutes * 60 * 1000);
      const amount = new Prisma.Decimal(charge.total_amount);

      // 6. Insert new voucher bound to CustomerProfile.customerId
      const voucher = await tx.storeCashVoucher.create({
        data: {
          tokenHash,
          customerId,
          rentalId,
          chargeId,
          collectingStoreId,
          amount,
          status: 'ACTIVE',
          expiresAt,
        },
      });

      return {
        voucherId: voucher.id,
        rawToken: token,
        expiresAt,
        amount: amount.toNumber(),
        collectingStoreId,
        rentalId,
        chargeId,
        customerId,
      };
    }, { timeout: 15000 }), { operationName: 'IssueCashVoucher' });
  }

  /** Atomic cash collection & store wallet balance offset. */
  async collect(storeId: bigint, rentalId: bigint, actorUserId: bigint, input: CollectCashDto) {
    if (!storeCashEnabled()) throw new ServiceUnavailableException('Store cash collection is disabled');
    for (const id of [storeId, rentalId, actorUserId]) cashResourceIdSchema.parse(String(id));
    const dto = validateZod(collectCashSchema, input);
    const chargeId = BigInt(dto.chargeId);
    const tokenHash = hashCashVoucherToken(dto.voucherToken);
    const ids = dto.handover === 'IMMEDIATE' ? dto.buttonIds.map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0) : [];
    const requestHash = createHash('sha256').update(JSON.stringify({
      storeId: String(storeId), rentalId: String(rentalId), chargeId: String(chargeId),
      tokenHash, handover: dto.handover, buttonIds: ids.map(String),
    })).digest('hex');
    return runWithTransactionRetry(() => this.prisma.$transaction(async tx => {
      // Authority is checked before revealing charge/voucher status, and locked
      // until commit so an ACTIVE membership cannot be revoked halfway through.
      const users = await tx.$queryRawUnsafe<any[]>('SELECT user_id FROM users WHERE user_id = $1 AND status = \'ACTIVE\' FOR SHARE', actorUserId);
      if (!users.length) throw new ForbiddenException('Active account required');
      const stores = await tx.$queryRawUnsafe<any[]>('SELECT owner_user_id FROM store WHERE store_id = $1 AND status = \'ACTIVE\' FOR SHARE', storeId);
      if (!stores.length) throw new ForbiddenException('Active collecting store required');
      let actorRole = 'STORE_OWNER';
      if (stores[0].owner_user_id !== actorUserId) {
        const staff = await tx.$queryRawUnsafe<any[]>(
          `SELECT r.role_code FROM store_staff ss JOIN roles r ON r.role_id = ss.role_id
           WHERE ss.store_id = $1 AND ss.user_id = $2 AND ss.status = 'ACTIVE'
             AND r.role_code IN ('STORE_MANAGER', 'STAFF_BUTTON') FOR SHARE OF ss, r`, storeId, actorUserId,
        );
        if (!staff.length) throw new ForbiddenException('Cash collection is restricted to this store owner, manager or button staff');
        actorRole = staff[0].role_code;
      }
      const wallets = await tx.$queryRawUnsafe<any[]>('SELECT * FROM store_wallets WHERE store_id = $1 FOR UPDATE', storeId);
      if (!wallets.length) throw new NotFoundException('Store wallet not found');
      const wallet = wallets[0];
      const charges = await tx.$queryRawUnsafe<any[]>('SELECT * FROM billing_charges WHERE charge_id = $1 FOR UPDATE', chargeId);
      const charge = charges[0];
      if (!charge) throw new NotFoundException('Charge not found');
      if (charge.purpose !== 'RENTAL_INITIAL' || charge.target_type !== 'RENTAL' || charge.target_id !== rentalId || charge.currency !== 'VND') {
        cashConflict('INVALID_CASH_CHARGE', 'Cash collection requires the specified initial rental charge');
      }
      const vouchers = await tx.$queryRawUnsafe<any[]>('SELECT * FROM store_cash_vouchers WHERE token_hash = $1 FOR UPDATE', tokenHash);
      const voucher = vouchers[0];
      const amount = new Prisma.Decimal(charge.total_amount);
      if (!voucher || voucher.rental_id !== rentalId || voucher.charge_id !== chargeId ||
          voucher.collecting_store_id !== storeId || !amount.eq(voucher.amount)) {
        throw new ForbiddenException('Voucher is not authorized for this collection');
      }
      const prior = await tx.storeCashReceipt.findUnique({ where: { chargeId } });
      if (prior) {
        if (prior.collectingStoreId !== storeId || prior.voucherId !== voucher.id ||
            prior.requestHash !== requestHash || voucher.status !== 'CONSUMED') {
          cashConflict('CASH_RECEIPT_REQUEST_CONFLICT', 'Charge was collected with a different request');
        }
        const existingRental = await tx.buttonRental.findUnique({ where: { rentalId }, include: { customer: true } });
        return { receipt: prior, idempotent: true, context: {
          customerUserId: existingRental?.customer?.userId?.toString() ?? null,
          collectingStoreId: String(storeId), fulfillmentStoreId: existingRental?.fulfillmentStoreId?.toString(),
          affectedButtonIds: ids.map(String),
        } };
      }
      if (charge.status === 'PAID') cashConflict('CHARGE_ALREADY_PAID_ONLINE',
        'Khoản thu đã thanh toán online. Không cấn trừ ví; vui lòng trả lại tiền mặt nếu đã nhận tại quầy.');
      if (charge.status !== 'PENDING') cashConflict('CHARGE_NOT_PENDING', 'Charge is not awaiting payment');
      const clock = await tx.$queryRawUnsafe<any[]>('SELECT clock_timestamp() AS now');
      if (voucher.status !== 'ACTIVE' || new Date(voucher.expires_at) <= clock[0].now) {
        cashConflict('CASH_VOUCHER_EXPIRED_OR_USED', 'Voucher expired, revoked or already consumed');
      }
      if (!amount.isInteger() || !amount.gt(0) || new Prisma.Decimal(wallet.balance).lt(amount)) {
        cashConflict('STORE_WALLET_INSUFFICIENT_BALANCE', 'Số dư khả dụng không đủ để cấn trừ');
      }
      const buttons = ids.length ? await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM iot_button WHERE button_id = ANY($1::bigint[]) ORDER BY button_id ASC FOR UPDATE', ids,
      ) : [];
      const rentals = await tx.$queryRawUnsafe<any[]>('SELECT * FROM button_rentals WHERE rental_id = $1 FOR UPDATE', rentalId);
      const rental = rentals[0];
      if (!rental || rental.customer_id !== voucher.customer_id || rental.status !== 'PENDING_PAYMENT') {
        cashConflict('RENTAL_NOT_PENDING_PAYMENT', 'Rental owner or payment state changed');
      }
      if (ids.length) {
        if (buttons.length !== ids.length || buttons.length !== rental.button_quantity ||
            (rental.fulfillment_store_id !== null && rental.fulfillment_store_id !== storeId)) {
          cashConflict('HANDOVER_ASSIGNMENT_MISMATCH', 'Pickup must match full quantity and fulfillment store');
        }
        const assigned = await tx.ioTButton.findMany({ where: { rentalId }, select: { buttonId: true } });
        if (assigned.some(b => !ids.includes(b.buttonId))) cashConflict('RENTAL_HAS_OTHER_DEVICES', 'Rental has other assigned devices');
        for (const button of buttons) {
          if (button.custody_store_id !== storeId ||
              (button.rental_id !== null && button.rental_id !== rentalId) ||
              (button.customer_id !== null && button.customer_id !== rental.customer_id) ||
              !['ALLOCATED_TO_STORE', 'ASSIGNED_TO_RENTAL'].includes(button.inventory_state)) {
            cashConflict('DEVICE_NOT_AVAILABLE_FOR_PICKUP', 'Device is not available in this store for this rental');
          }
          await tx.ioTButton.update({ where: { buttonId: button.button_id }, data: {
            rentalId, inventoryState: 'ASSIGNED_TO_RENTAL', canOrder: false,
          } });
          button.rental_id = rentalId;
          button.inventory_state = 'ASSIGNED_TO_RENTAL';
        }
        await tx.buttonRental.update({ where: { rentalId }, data: { fulfillmentStoreId: storeId } });
        rental.fulfillment_store_id = storeId;
      }
      const debit = await tx.storeWallet.updateMany({ where: { walletId: wallet.wallet_id, balance: { gte: amount } },
        data: { balance: { decrement: amount } } });
      if (debit.count !== 1) cashConflict('STORE_WALLET_INSUFFICIENT_BALANCE', 'Available wallet balance changed');
      const ledger = await tx.walletTransaction.create({ data: {
        walletId: wallet.wallet_id, type: 'RENTAL_CASH_COLLECTION_OFFSET', referenceId: String(chargeId),
        amount: amount.negated(), balanceBefore: wallet.balance, balanceAfter: new Prisma.Decimal(wallet.balance).minus(amount),
        description: 'Platform rental cash collection offset',
      } });
      // Check expiry again at consumption using DB wall-clock, not transaction start time.
      const consumed = await tx.$executeRawUnsafe(
        `UPDATE store_cash_vouchers SET status = 'CONSUMED', consumed_at = clock_timestamp()
         WHERE id = $1 AND status = 'ACTIVE' AND expires_at > clock_timestamp()`, voucher.id,
      );
      if (consumed !== 1) cashConflict('CASH_VOUCHER_EXPIRED_OR_USED', 'Voucher expired or became unavailable');
      await settleInitialRentalInTx(tx, charge, 'STORE_CASH_OFFSET', { userId: actorUserId, role: actorRole });
      const receipt = await tx.storeCashReceipt.create({ data: {
        chargeId, voucherId: voucher.id, collectingStoreId: storeId, amount,
        walletTransactionId: ledger.transactionId, collectedByUserId: actorUserId, requestHash,
      } });
      if (ids.length) await handoverRentalButtonsInTx(tx, rentalId, { userId: actorUserId, role: actorRole }, clock[0].now,
        { buttons, rental: { ...rental, status: 'PENDING_HANDOVER' } });

      let customerUserId: string | null = null;
      try {
        const cust = await tx.customerProfile.findUnique({
          where: { customerId: BigInt(rental.customer_id) },
          select: { userId: true },
        });
        if (cust) customerUserId = cust.userId.toString();
      } catch {
        // Fallback if raw query is preferred
        const custs = await tx.$queryRawUnsafe<any[]>('SELECT user_id FROM customer_profile WHERE customer_id = $1', rental.customer_id);
        if (custs.length) customerUserId = String(custs[0].user_id);
      }

      const context = {
        customerUserId,
        collectingStoreId: storeId.toString(),
        fulfillmentStoreId: rental.fulfillment_store_id?.toString(),
        affectedButtonIds: ids.map(String),
      };

      return { receipt, idempotent: false, context };
    }, { timeout: 15000 }), { operationName: 'StoreCashCollection' });
  }

  /** Find cash receipt by ID with strict BOLA tenant authorization. */
  async findReceiptById(
    receiptId: bigint,
    storeId: bigint,
    actorUserId: bigint,
    actorRoles: string[] = [],
  ) {
    cashResourceIdSchema.parse(String(receiptId));
    cashResourceIdSchema.parse(String(storeId));
    cashResourceIdSchema.parse(String(actorUserId));

    // 1. BOLA Check: Verify caller has legitimate authority for this storeId
    const isAdmin = actorRoles.some((r) => ['ADMIN', 'SYSTEM_ADMIN', 'SUPER_ADMIN'].includes(r));
    if (!isAdmin) {
      const stores = await this.prisma.$queryRawUnsafe<any[]>(
        'SELECT owner_user_id FROM store WHERE store_id = $1 AND status = \'ACTIVE\'',
        storeId,
      );
      if (!stores.length) {
        throw new ForbiddenException('Cửa hàng không tồn tại hoặc đã bị vô hiệu hóa');
      }
      if (stores[0].owner_user_id !== actorUserId) {
        const staff = await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT r.role_code FROM store_staff ss
           JOIN roles r ON r.role_id = ss.role_id
           WHERE ss.store_id = $1 AND ss.user_id = $2 AND ss.status = 'ACTIVE'
             AND r.role_code IN ('STORE_MANAGER', 'STAFF_BUTTON')`,
          storeId,
          actorUserId,
        );
        if (!staff.length) {
          throw new ForbiddenException('Bạn không có quyền truy cập dữ liệu của cửa hàng này');
        }
      }
    }

    // 2. Fetch receipt and verify tenant binding
    const receipt = await this.prisma.storeCashReceipt.findUnique({
      where: { id: receiptId },
      include: {
        collectedBy: {
          select: { userId: true, fullName: true, email: true },
        },
      },
    });
    if (!receipt) throw new NotFoundException(`Biên nhận #${receiptId} không tồn tại`);
    if (receipt.collectingStoreId !== storeId) {
      throw new ForbiddenException('Không có quyền truy cập biên nhận của cửa hàng khác');
    }
    return receipt;
  }

  /** Find cash receipt by charge ID. */
  async findReceiptByChargeId(chargeId: bigint) {
    cashResourceIdSchema.parse(String(chargeId));
    return this.prisma.storeCashReceipt.findUnique({
      where: { chargeId },
      include: {
        collectedBy: { select: { userId: true, fullName: true, email: true } },
      },
    });
  }

  /** List overpayment obligations for admin reconciliation queue. */
  async listOverpaymentObligations(page = 1, pageSize = 20, status?: string) {
    const take = Math.min(Math.max(pageSize, 1), 100);
    const skip = (Math.max(page, 1) - 1) * take;
    const where: Prisma.BillingOverpaymentObligationWhereInput = status ? { status } : {};
    const [items, total] = await Promise.all([
      this.prisma.billingOverpaymentObligation.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          receipt: {
            select: {
              id: true,
              chargeId: true,
              provider: true,
              channel: true,
              providerTransactionRef: true,
              amount: true,
              currency: true,
              classification: true,
              receivedAt: true,
            },
          },
        },
      }),
      this.prisma.billingOverpaymentObligation.count({ where }),
    ]);
    return { items, total, page, pageSize: take };
  }

  /** Preview rental handover requirements and available buttons in store inventory. */
  async getHandoverPreview(storeId: bigint, rentalId: bigint, actorUserId: bigint, actorRoles: string[] = [], pagination = { page: 1, pageSize: 20 }) {
    cashResourceIdSchema.parse(String(storeId));
    cashResourceIdSchema.parse(String(rentalId));
    cashResourceIdSchema.parse(String(actorUserId));

    const isAdmin = actorRoles.some((r) => ['ADMIN', 'SYSTEM_ADMIN', 'SUPER_ADMIN'].includes(r));
    if (!isAdmin) {
      const stores = await this.prisma.$queryRawUnsafe<any[]>(
        'SELECT owner_user_id FROM store WHERE store_id = $1 AND status = \'ACTIVE\'',
        storeId,
      );
      if (!stores.length) throw new ForbiddenException('Cửa hàng không tồn tại hoặc đã bị vô hiệu hóa');
      if (stores[0].owner_user_id !== actorUserId) {
        const staff = await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT r.role_code FROM store_staff ss
           JOIN roles r ON r.role_id = ss.role_id
           WHERE ss.store_id = $1 AND ss.user_id = $2 AND ss.status = 'ACTIVE'
             AND r.role_code IN ('STORE_MANAGER', 'STAFF_BUTTON')`,
          storeId,
          actorUserId,
        );
        if (!staff.length) throw new ForbiddenException('Bạn không có quyền truy cập dữ liệu của cửa hàng này');
      }
    }

    const rental = await this.prisma.buttonRental.findUnique({
      where: { rentalId },
      include: { package: true },
    });
    if (!rental) throw new NotFoundException('Hợp đồng thuê không tồn tại');

    // 2. Rental Scope Verification:
    // Store must be fulfillmentStoreId OR customer issued an ACTIVE unexpired cash voucher targeting this store
    let hasStoreScope = false;
    if (rental.fulfillmentStoreId === storeId) {
      hasStoreScope = true;
    } else {
      const now = new Date();
      const validVoucher = await this.prisma.storeCashVoucher.findFirst({
        where: {
          rentalId,
          collectingStoreId: storeId,
          status: 'ACTIVE',
          expiresAt: { gt: now },
          customerId: rental.customerId,
          charge: { status: 'PENDING', purpose: 'RENTAL_INITIAL', targetType: 'RENTAL', targetId: rentalId },
        },
      });
      if (validVoucher) {
        hasStoreScope = true;
      }
    }

    if (!hasStoreScope && !isAdmin) {
      throw new NotFoundException('Hợp đồng thuê không tồn tại');
    }

    if (rental.status === 'PENDING_PAYMENT' && !storeCashEnabled()) {
      throw new ServiceUnavailableException('New cash collection is disabled');
    }
    const eligibility: Prisma.IoTButtonWhereInput = {
      custodyStoreId: storeId,
      OR: [
        { rentalId, inventoryState: { in: ['ALLOCATED_TO_STORE', 'ASSIGNED_TO_RENTAL'] },
          OR: [{ customerId: null }, { customerId: rental.customerId }] },
        { rentalId: null, customerId: null, inventoryState: 'ALLOCATED_TO_STORE' },
      ],
    };
    const [availableButtons, totalEligibleButtons, conflictingAssignments] = await Promise.all([
      this.prisma.ioTButton.findMany({
        where: eligibility, select: { buttonId: true, deviceId: true, buttonCode: true, inventoryState: true },
        orderBy: { buttonId: 'asc' }, skip: (pagination.page - 1) * pagination.pageSize, take: pagination.pageSize,
      }),
      this.prisma.ioTButton.count({ where: eligibility }),
      this.prisma.ioTButton.count({ where: { rentalId, NOT: eligibility } }),
    ]);
    const isPickupStatus = ['PENDING_PAYMENT', 'PENDING_HANDOVER'].includes(rental.status);
    const isStoreFulfillment = rental.status === 'PENDING_HANDOVER'
      ? rental.fulfillmentStoreId === storeId
      : rental.fulfillmentStoreId === null || rental.fulfillmentStoreId === storeId;
    const canFulfillImmediately = isPickupStatus && isStoreFulfillment &&
      conflictingAssignments === 0 && totalEligibleButtons >= rental.buttonQuantity;

    return {
      rentalId: rental.rentalId.toString(),
      buttonQuantity: rental.buttonQuantity,
      depositAmount: Number(rental.depositAmount),
      totalRentAmount: Number(rental.totalRentAmount),
      status: rental.status,
      availableStoreButtons: availableButtons.map((b) => ({
        buttonId: b.buttonId.toString(),
        deviceId: b.deviceId,
        buttonCode: b.buttonCode,
        inventoryState: b.inventoryState,
      })),
      canFulfillImmediately,
      totalEligibleButtons,
      pagination: { ...pagination, totalItems: totalEligibleButtons, totalPages: Math.ceil(totalEligibleButtons / pagination.pageSize) },
    };
  }
}
