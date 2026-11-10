import { Injectable, Inject, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class CustomersRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private toNumber(val: unknown): number {
    return Number(val || 0);
  }

  async getCustomerProfileByUserId(userId: bigint) {
    return this.prisma.customerProfile.findUnique({
      where: { userId },
    });
  }

  async getCustomerDashboard(userId: bigint) {
    const profile = await this.getCustomerProfileByUserId(userId);
    const customerId = profile?.customerId;

    const [ordersSummaryRows, recentOrdersRows, connectedStoresRows, devicesRows, rentalsRows, unreadNotifCount] =
      await Promise.all([
        customerId
          ? this.prisma.$queryRaw<Array<{
              total: number;
              pending: number;
              delivering: number;
              completed: number;
              cancelled: number;
              total_spent: any;
            }>>(Prisma.sql`
              SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE order_status IN ('PENDING', 'CONFIRMED'))::int AS pending,
                COUNT(*) FILTER (WHERE order_status IN ('PREPARING', 'READY_FOR_DELIVERY', 'SHIPPING'))::int AS delivering,
                COUNT(*) FILTER (WHERE order_status IN ('DELIVERED', 'COMPLETED'))::int AS completed,
                COUNT(*) FILTER (WHERE order_status IN ('CANCELLED', 'REJECTED', 'DELIVERY_FAILED'))::int AS cancelled,
                COALESCE(SUM(total_amount) FILTER (WHERE order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS total_spent
              FROM orders
              WHERE customer_id = ${customerId}
            `)
          : [{ total: 0, pending: 0, delivering: 0, completed: 0, cancelled: 0, total_spent: 0 }],

        customerId
          ? this.prisma.$queryRaw<Array<{
              order_id: bigint;
              order_code: string;
              order_status: string;
              total_amount: any;
              order_date: Date;
              store_name: string;
              store_id: bigint;
              items_count: number;
            }>>(Prisma.sql`
              SELECT
                o.order_id,
                o.order_code,
                o.order_status,
                o.total_amount,
                o.order_date,
                s.name AS store_name,
                s.store_id,
                (SELECT COUNT(*)::int FROM order_item oi WHERE oi.order_id = o.order_id) AS items_count
              FROM orders o
              JOIN store s ON s.store_id = o.store_id
              WHERE o.customer_id = ${customerId}
              ORDER BY o.order_date DESC
              LIMIT 5
            `)
          : [],

        customerId
          ? this.prisma.$queryRaw<Array<{
              store_id: bigint;
              name: string;
              code: string;
              logo_url: string | null;
            }>>(Prisma.sql`
              SELECT DISTINCT
                s.store_id,
                s.name,
                s.code,
                NULL::text AS logo_url
              FROM orders o
              JOIN store s ON s.store_id = o.store_id
              WHERE o.customer_id = ${customerId}
              LIMIT 10
            `)
          : [],

        customerId
          ? this.prisma.$queryRaw<Array<{
              total: number;
              active: number;
              low_battery: number;
            }>>(Prisma.sql`
              SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                COUNT(*) FILTER (WHERE battery_level < 20)::int AS low_battery
              FROM iot_button
              WHERE customer_id = ${customerId}
            `)
          : [{ total: 0, active: 0, low_battery: 0 }],

        customerId
          ? this.prisma.$queryRaw<Array<{
              total: number;
              active: number;
              expiring_soon: number;
            }>>(Prisma.sql`
              SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                COUNT(*) FILTER (WHERE status = 'ACTIVE' AND end_date <= NOW() + INTERVAL '7 days')::int AS expiring_soon
              FROM button_rentals
              WHERE customer_id = ${customerId}
            `)
          : [{ total: 0, active: 0, expiring_soon: 0 }],

        this.prisma.notification.count({
          where: {
            userId,
            readAt: null,
          },
        }),
      ]);

    const sum = ordersSummaryRows[0] || {
      total: 0,
      pending: 0,
      delivering: 0,
      completed: 0,
      cancelled: 0,
      total_spent: 0,
    };
    const dev = devicesRows[0] || { total: 0, active: 0, low_battery: 0 };
    const rent = rentalsRows[0] || { total: 0, active: 0, expiring_soon: 0 };

    return {
      ordersSummary: {
        total: this.toNumber(sum.total),
        pending: this.toNumber(sum.pending),
        delivering: this.toNumber(sum.delivering),
        completed: this.toNumber(sum.completed),
        cancelled: this.toNumber(sum.cancelled),
        totalSpent: this.toNumber(sum.total_spent),
      },
      recentOrders: recentOrdersRows.map((o) => ({
        orderId: o.order_id.toString(),
        orderCode: o.order_code,
        orderStatus: o.order_status,
        totalAmount: this.toNumber(o.total_amount),
        orderDate: o.order_date,
        storeId: o.store_id.toString(),
        storeName: o.store_name,
        itemsCount: this.toNumber(o.items_count),
      })),
      connectedStores: connectedStoresRows.map((s) => ({
        storeId: s.store_id.toString(),
        name: s.name,
        code: s.code,
        logoUrl: s.logo_url,
      })),
      devices: {
        total: this.toNumber(dev.total),
        active: this.toNumber(dev.active),
        lowBattery: this.toNumber(dev.low_battery),
      },
      rentals: {
        total: this.toNumber(rent.total),
        active: this.toNumber(rent.active),
        expiringSoon: this.toNumber(rent.expiring_soon),
      },
      unreadNotificationsCount: unreadNotifCount,
    };
  }

  async getCustomerOrdersAnalytics(
    userId: bigint,
    dateRange: { fromDate?: Date; toDateExclusive?: Date } = {},
  ) {
    const profile = await this.getCustomerProfileByUserId(userId);
    const customerId = profile?.customerId;
    if (!customerId) {
      return { timeline: [], statusBreakdown: [], topProducts: [] };
    }

    const conditions: Prisma.Sql[] = [Prisma.sql`o.customer_id = ${customerId}`];
    if (dateRange.fromDate) conditions.push(Prisma.sql`o.order_date >= ${dateRange.fromDate}`);
    if (dateRange.toDateExclusive) conditions.push(Prisma.sql`o.order_date < ${dateRange.toDateExclusive}`);
    const whereClause = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;

    const [timelineRows, statusRows, topProductRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ period: string; count: number; spent: any }>>(Prisma.sql`
        SELECT
          to_char(date_trunc('day', o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') AS period,
          COUNT(*)::int AS count,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS spent
        FROM orders o
        ${whereClause}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      this.prisma.$queryRaw<Array<{ order_status: string; count: number }>>(Prisma.sql`
        SELECT
          o.order_status,
          COUNT(*)::int AS count
        FROM orders o
        ${whereClause}
        GROUP BY 1
      `),
      this.prisma.$queryRaw<Array<{ product_name: string; total_quantity: number; total_spent: any }>>(Prisma.sql`
        SELECT
          oi.product_name_snapshot AS product_name,
          SUM(oi.quantity)::int AS total_quantity,
          SUM(oi.item_subtotal)::numeric AS total_spent
        FROM order_item oi
        JOIN orders o ON o.order_id = oi.order_id
        ${whereClause}
        GROUP BY 1
        ORDER BY total_quantity DESC
        LIMIT 10
      `),
    ]);

    return {
      timeline: timelineRows.map((t) => ({
        period: t.period,
        count: this.toNumber(t.count),
        spent: this.toNumber(t.spent),
      })),
      statusBreakdown: statusRows.map((s) => ({
        status: s.order_status,
        count: this.toNumber(s.count),
      })),
      topProducts: topProductRows.map((p) => ({
        productName: p.product_name,
        totalQuantity: this.toNumber(p.total_quantity),
        totalSpent: this.toNumber(p.total_spent),
      })),
    };
  }

  async getCustomerDevicesAnalytics(userId: bigint) {
    const profile = await this.getCustomerProfileByUserId(userId);
    const customerId = profile?.customerId;
    if (!customerId) return { devices: [] };

    const devices = await this.prisma.ioTButton.findMany({
      where: { customerId },
      include: {
        store: { select: { storeId: true, name: true, code: true } },
        deployedTemplate: { select: { templateId: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      devices: devices.map((d) => ({
        buttonId: d.buttonId.toString(),
        deviceId: d.deviceId,
        buttonCode: d.buttonCode,
        buttonName: d.buttonName,
        status: d.status,
        batteryLevel: d.batteryLevel,
        storeId: d.storeId.toString(),
        storeName: d.store?.name || null,
        deployedTemplate: d.deployedTemplate?.name || null,
        installedAt: d.installedAt,
      })),
    };
  }

  async getCustomerRentalsAnalytics(userId: bigint) {
    const profile = await this.getCustomerProfileByUserId(userId);
    const customerId = profile?.customerId;
    if (!customerId) return { rentals: [] };

    const rentals = await this.prisma.buttonRental.findMany({
      where: { customerId },
      include: {
        package: true,
        buttons: { select: { buttonId: true, deviceId: true, buttonCode: true, status: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      rentals: rentals.map((r) => ({
        rentalId: r.rentalId.toString(),
        status: r.status,
        packageName: r.package?.packageName || null,
        monthlyPrice: this.toNumber(r.package?.monthlyPrice),
        depositAmount: this.toNumber(r.depositAmount),
        totalRentAmount: this.toNumber(r.totalRentAmount),
        startDate: r.startDate,
        endDate: r.endDate,
        assignedButtonsCount: r.buttons?.length || 0,
        buttons: r.buttons?.map((b) => ({
          buttonId: b.buttonId.toString(),
          deviceId: b.deviceId,
          buttonCode: b.buttonCode,
          status: b.status,
        })) || [],
      })),
    };
  }

  async createCustomerBankAccount(data: {
    customerId: bigint;
    bankBin: string;
    bankCode?: string;
    bankName: string;
    accountNumberEncrypted: string;
    accountNumberHash: string;
    accountNumberMasked: string;
    accountName: string;
    isDefault?: boolean;
    verificationStatus?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        // Lock customer profile exclusively so concurrent creations for the same customer are strictly serialized, even if no bank accounts exist yet
        await tx.$queryRaw`
          SELECT customer_id FROM customer_profile
          WHERE customer_id = ${data.customerId}
          FOR UPDATE
        `;
        await tx.customerBankAccount.updateMany({
          where: { customerId: data.customerId },
          data: { isDefault: false },
        });
      }
      return tx.customerBankAccount.create({
        data: {
          customerId: data.customerId,
          bankBin: data.bankBin,
          bankCode: data.bankCode,
          bankName: data.bankName,
          accountNumberEncrypted: data.accountNumberEncrypted,
          accountNumberHash: data.accountNumberHash,
          accountNumberMasked: data.accountNumberMasked,
          accountName: data.accountName,
          isDefault: data.isDefault ?? true,
          verificationStatus: data.verificationStatus || 'PENDING',
        },
      });
    });
  }

  async findCustomerBankAccountById(customerId: bigint, accountId: bigint) {
    return this.prisma.customerBankAccount.findFirst({
      where: { id: accountId, customerId },
      select: {
        id: true,
        customerId: true,
        bankBin: true,
        bankCode: true,
        bankName: true,
        accountNumberMasked: true,
        accountNumberHash: true,
        accountName: true,
        verificationStatus: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async verifyCustomerBankAccount(customerId: bigint, accountId: bigint, status: string = 'VERIFIED') {
    return this.prisma.customerBankAccount.updateMany({
      where: { id: accountId, customerId },
      data: { verificationStatus: status, updatedAt: new Date() },
    });
  }

  async setDefaultCustomerBankAccount(customerId: bigint, accountId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT customer_id FROM customer_profile
        WHERE customer_id = ${customerId}
        FOR UPDATE
      `;

      await tx.customerBankAccount.updateMany({
        where: { customerId },
        data: { isDefault: false },
      });

      return tx.customerBankAccount.update({
        where: { id: accountId, customerId },
        data: { isDefault: true, updatedAt: new Date() },
      });
    });
  }

  async deleteCustomerBankAccount(customerId: bigint, accountId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Check pending deposit refunds
      const pendingRefunds = await tx.depositRefund.count({
        where: {
          bankAccountId: accountId,
          status: { in: ['PENDING_APPROVAL', 'PENDING', 'PROCESSING'] },
        },
      });
      if (pendingRefunds > 0) {
        throw new BadRequestException('Không thể xóa tài khoản ngân hàng đang có yêu cầu hoàn cọc chưa hoàn tất');
      }

      // 2. Check active refund obligations
      const activeObligations = await tx.customerBankRefundObligation.count({
        where: {
          refundStatus: { in: ['PENDING_REFUND', 'PROCESSING_REFUND', 'PENDING_MANUAL_REFUND'] },
          inboundTransaction: {
            proof: { accountId },
          },
        },
      });
      if (activeObligations > 0) {
        throw new BadRequestException('Không thể xóa tài khoản ngân hàng đang có nghĩa vụ hoàn tiền chưa hoàn tất');
      }

      // 3. Check active verification sessions
      const activeSessions = await tx.customerBankVerificationProof.count({
        where: {
          accountId,
          sessionStatus: 'ACTIVE',
        },
      });
      if (activeSessions > 0) {
        throw new BadRequestException('Không thể xóa tài khoản ngân hàng đang có phiên xác minh chưa hoàn tất');
      }

      // 4. Clean up inactive verification proofs without inbound transactions
      await tx.customerBankVerificationProof.deleteMany({
        where: {
          accountId,
          inboundTransactions: { none: {} },
        },
      });

      // 5. If there are still proofs (having financial inbound transactions), prevent deletion to protect financial audit log
      const remainingProofs = await tx.customerBankVerificationProof.count({
        where: { accountId },
      });
      if (remainingProofs > 0) {
        throw new BadRequestException('Không thể xóa tài khoản ngân hàng đã có lịch sử giao dịch đối soát tài chính');
      }

      return tx.customerBankAccount.delete({
        where: { id: accountId, customerId },
      });
    });
  }

  async createBankVerificationProof(data: {
    proofReference: string;
    customerId: bigint;
    accountId: bigint;
    bankBin: string;
    accountNumberHash: string;
    status?: string;
    provider?: string;
    expiresAt: Date;
  }) {
    return this.prisma.customerBankVerificationProof.create({
      data: {
        proofReference: data.proofReference,
        customerId: data.customerId,
        accountId: data.accountId,
        bankBin: data.bankBin,
        accountNumberHash: data.accountNumberHash,
        status: data.status || 'PENDING',
        provider: data.provider || 'PAYOS',
        expiresAt: data.expiresAt,
      },
    });
  }

  async findBankVerificationProof(proofReference: string) {
    return this.prisma.customerBankVerificationProof.findUnique({
      where: { proofReference },
    });
  }

  async confirmBankVerificationProof(params: {
    proofReference: string;
    status: 'SUCCESS' | 'FAILED';
    providerEventId?: string;
    expectedBinding?: {
      customerId?: bigint;
      accountId?: bigint;
      bankBin?: string;
      accountNumberHash?: string;
    };
  }) {
    return this.prisma.$transaction(async (tx) => {
      const [proof] = await tx.$queryRaw<Array<{
        id: bigint;
        customer_id: bigint;
        account_id: bigint;
        bank_bin: string;
        account_number_hash: string;
        status: string;
        expires_at: Date;
        used_at: Date | null;
      }>>`
        SELECT id, customer_id, account_id, bank_bin, account_number_hash, status, expires_at, used_at
        FROM customer_bank_verification_proofs
        WHERE proof_reference = ${params.proofReference}
        FOR UPDATE
      `;
      if (!proof) {
        throw new NotFoundException('Không tìm thấy phiên xác minh ngân hàng');
      }

      // 1. Guard against updating already consumed proofs
      if (proof.used_at !== null) {
        throw new ConflictException('Bằng chứng xác minh đã được sử dụng trước đó (đã tiêu thụ). Không thể thay đổi trạng thái.');
      }

      // 2. Validate binding if caller provided expectedBinding
      if (params.expectedBinding) {
        if (
          (params.expectedBinding.customerId && proof.customer_id.toString() !== params.expectedBinding.customerId.toString()) ||
          (params.expectedBinding.accountId && proof.account_id.toString() !== params.expectedBinding.accountId.toString()) ||
          (params.expectedBinding.bankBin && proof.bank_bin !== params.expectedBinding.bankBin) ||
          (params.expectedBinding.accountNumberHash && proof.account_number_hash !== params.expectedBinding.accountNumberHash)
        ) {
          throw new BadRequestException('Thông tin xác minh từ provider không khớp với phiên đã khởi tạo');
        }
      }

      // 3. Guard against expired proof
      if (new Date(proof.expires_at).getTime() <= Date.now()) {
        throw new BadRequestException('Phiên xác minh đã hết hạn');
      }

      // 4. Idempotency: duplicate callback with the same status returns current record without error
      if (proof.status === params.status) {
        return tx.customerBankVerificationProof.findUnique({
          where: { id: proof.id },
        });
      }

      // 5. Terminal state guard: only allow transition from PENDING -> SUCCESS | FAILED
      if (proof.status !== 'PENDING') {
        throw new ConflictException(
          `Phiên xác minh đã ở trạng thái kết thúc (${proof.status}). Không thể thay đổi sang ${params.status} (chặn callback trái thứ tự / mâu thuẫn).`,
        );
      }

      return tx.customerBankVerificationProof.update({
        where: { id: proof.id },
        data: { status: params.status, updatedAt: new Date() },
      });
    });
  }

  async consumeBankVerificationProofTx(params: {
    proofReference: string;
    customerId: bigint;
    accountId: bigint;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock customer bank account row exclusively FIRST (consistent lock hierarchy: account -> proof)
      const [account] = await tx.$queryRaw<Array<{
        id: bigint;
        customer_id: bigint;
        bank_bin: string;
        account_number_hash: string;
        verification_status: string;
      }>>`
        SELECT id, customer_id, bank_bin, account_number_hash, verification_status
        FROM customer_bank_accounts
        WHERE id = ${params.accountId} AND customer_id = ${params.customerId}
        FOR UPDATE
      `;
      if (!account) {
        throw new NotFoundException('Tài khoản ngân hàng không tồn tại hoặc không thuộc sở hữu của bạn');
      }

      // Check idempotent early return if already VERIFIED
      if (account.verification_status === 'VERIFIED') {
        return { alreadyVerified: true };
      }

      // 2. Lock proof row exclusively SECOND
      const [proof] = await tx.$queryRaw<Array<{
        id: bigint;
        customer_id: bigint;
        account_id: bigint;
        bank_bin: string;
        account_number_hash: string;
        status: string;
        expires_at: Date;
        used_at: Date | null;
      }>>`
        SELECT id, customer_id, account_id, bank_bin, account_number_hash, status, expires_at, used_at
        FROM customer_bank_verification_proofs
        WHERE proof_reference = ${params.proofReference}
        FOR UPDATE
      `;
      if (!proof) {
        throw new BadRequestException('Bằng chứng xác minh không tồn tại hoặc không hợp lệ');
      }

      // 3. In-transaction validation of all bindings & invariants
      if (proof.customer_id.toString() !== params.customerId.toString()) {
        throw new BadRequestException('Bằng chứng xác minh không thuộc về khách hàng này');
      }
      if (proof.account_id.toString() !== params.accountId.toString()) {
        throw new BadRequestException('Bằng chứng xác minh không khớp với tài khoản ngân hàng này');
      }
      if (proof.bank_bin !== account.bank_bin) {
        throw new BadRequestException('Bằng chứng xác minh không khớp với mã ngân hàng (BIN)');
      }
      if (proof.account_number_hash !== account.account_number_hash) {
        throw new BadRequestException('Bằng chứng xác minh không khớp với số tài khoản ngân hàng');
      }
      if (proof.status !== 'SUCCESS') {
        throw new BadRequestException(
          `Bằng chứng xác minh đang ở trạng thái ${proof.status} (chưa được đối tác/ngân hàng xác nhận). Không thể hoàn tất xác minh.`,
        );
      }
      if (new Date(proof.expires_at).getTime() <= Date.now()) {
        throw new BadRequestException('Bằng chứng xác minh đã hết hạn');
      }
      if (proof.used_at !== null) {
        throw new ConflictException('Bằng chứng xác minh đã được sử dụng trước đó (Anti-replay)');
      }

      // 4. Atomic conditional update (CAS) for single-use proof consumption
      const affectedProofs = await tx.$executeRaw`
        UPDATE customer_bank_verification_proofs
        SET used_at = NOW(), updated_at = NOW()
        WHERE id = ${proof.id}
          AND customer_id = ${params.customerId}
          AND account_id = ${params.accountId}
          AND status = 'SUCCESS'
          AND used_at IS NULL
          AND expires_at > NOW()
      `;
      if (affectedProofs !== 1) {
        throw new ConflictException('Xung đột đồng thời: Bằng chứng xác minh đã được tiêu thụ bởi yêu cầu khác hoặc đã hết hạn');
      }

      // 5. Update bank account status to VERIFIED
      const affectedAccounts = await tx.$executeRaw`
        UPDATE customer_bank_accounts
        SET verification_status = 'VERIFIED', updated_at = NOW()
        WHERE id = ${params.accountId} AND customer_id = ${params.customerId}
      `;
      if (affectedAccounts !== 1) {
        throw new ConflictException('Không thể cập nhật trạng thái tài khoản ngân hàng');
      }

      return { alreadyVerified: false };
    });
  }

  async findCustomerBankAccounts(customerId: bigint) {
    return this.prisma.customerBankAccount.findMany({
      where: { customerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        customerId: true,
        bankBin: true,
        bankCode: true,
        bankName: true,
        accountNumberMasked: true,
        accountName: true,
        verificationStatus: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findActiveVerificationSessionByAccount(customerId: bigint, accountId: bigint) {
    return this.prisma.customerBankVerificationProof.findFirst({
      where: {
        customerId,
        accountId,
        sessionStatus: 'ACTIVE',
        expiresAt: { gt: new Date() },
        usedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        inboundTransactions: true,
      },
    });
  }

  async getOrCreatePennyVerificationSessionTx(data: {
    customerId: bigint;
    accountId: bigint;
    bankBin: string;
    accountNumberHash: string;
    expiresAt: Date;
    generateOrderCode: () => bigint;
    generateProofReference: () => string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock customer bank account exclusively FIRST (consistent lock hierarchy: account -> proof)
      const [account] = await tx.$queryRaw<Array<{ id: bigint; customer_id: bigint; verification_status: string }>>`
        SELECT id, customer_id, verification_status
        FROM customer_bank_accounts
        WHERE id = ${data.accountId} AND customer_id = ${data.customerId}
        FOR UPDATE
      `;
      if (!account) {
        throw new NotFoundException('Tài khoản ngân hàng không tồn tại');
      }

      // 2. Check for active, unexpired, unused session under lock
      const activeSessions = await tx.$queryRaw<Array<{
        id: bigint;
        proof_reference: string;
        payment_order_code: bigint | null;
        payment_checkout_url: string | null;
        payment_link_id: string | null;
        session_status: string;
        verification_status: string;
        expires_at: Date;
      }>>`
        SELECT id, proof_reference, payment_order_code, payment_checkout_url, payment_link_id,
               session_status, verification_status, expires_at
        FROM customer_bank_verification_proofs
        WHERE customer_id = ${data.customerId}
          AND account_id = ${data.accountId}
          AND session_status = 'ACTIVE'
          AND expires_at > NOW()
          AND used_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `;

      if (activeSessions && activeSessions.length > 0) {
        const existing = activeSessions[0];
        return {
          session: {
            id: existing.id,
            proofReference: existing.proof_reference,
            customerId: data.customerId,
            accountId: data.accountId,
            paymentOrderCode: existing.payment_order_code,
            paymentLinkId: existing.payment_link_id,
            paymentCheckoutUrl: existing.payment_checkout_url,
            sessionStatus: existing.session_status,
            verificationStatus: existing.verification_status,
            expiresAt: existing.expires_at,
          },
          isReused: true,
        };
      }

      // 3. Create fresh session with stable orderCode BEFORE calling provider
      const paymentOrderCode = data.generateOrderCode();
      const proofReference = data.generateProofReference();

      const created = await tx.customerBankVerificationProof.create({
        data: {
          proofReference,
          customerId: data.customerId,
          accountId: data.accountId,
          bankBin: data.bankBin,
          accountNumberHash: data.accountNumberHash,
          status: 'PENDING',
          sessionStatus: 'ACTIVE',
          verificationStatus: 'PENDING',
          paymentOrderCode,
          paymentLinkId: null,
          paymentCheckoutUrl: null,
          expiresAt: data.expiresAt,
        },
      });

      return {
        session: {
          id: created.id,
          proofReference: created.proofReference,
          customerId: created.customerId,
          accountId: created.accountId,
          paymentOrderCode: created.paymentOrderCode,
          paymentLinkId: created.paymentLinkId,
          paymentCheckoutUrl: created.paymentCheckoutUrl,
          sessionStatus: created.sessionStatus,
          verificationStatus: created.verificationStatus,
          expiresAt: created.expiresAt,
        },
        isReused: false,
      };
    });
  }

  async attachPaymentLinkToSessionCAS(sessionId: bigint, paymentLinkId: string, paymentCheckoutUrl: string) {
    const updated = await this.prisma.customerBankVerificationProof.updateMany({
      where: {
        id: sessionId,
        sessionStatus: 'ACTIVE',
        OR: [
          { paymentCheckoutUrl: null },
          { paymentCheckoutUrl: paymentCheckoutUrl },
        ],
      },
      data: {
        paymentLinkId,
        paymentCheckoutUrl,
        updatedAt: new Date(),
      },
    });
    return updated.count > 0;
  }

  async createPennyVerificationSession(data: {
    proofReference: string;
    customerId: bigint;
    accountId: bigint;
    bankBin: string;
    accountNumberHash: string;
    paymentOrderCode: bigint;
    paymentLinkId?: string;
    paymentCheckoutUrl?: string;
    expiresAt: Date;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock on customer bank account to prevent concurrent session creation races
      const [account] = await tx.$queryRaw<Array<{ id: bigint; customer_id: bigint; verification_status: string }>>`
        SELECT id, customer_id, verification_status
        FROM customer_bank_accounts
        WHERE id = ${data.accountId} AND customer_id = ${data.customerId}
        FOR UPDATE
      `;
      if (!account) {
        throw new NotFoundException('Tài khoản ngân hàng không tồn tại');
      }

      // 2. Check for active, unexpired, unused session under lock
      const activeSessions = await tx.$queryRaw<Array<{
        id: bigint;
        proof_reference: string;
        payment_order_code: bigint | null;
        payment_checkout_url: string | null;
        payment_link_id: string | null;
        session_status: string;
        verification_status: string;
        expires_at: Date;
      }>>`
        SELECT id, proof_reference, payment_order_code, payment_checkout_url, payment_link_id,
               session_status, verification_status, expires_at
        FROM customer_bank_verification_proofs
        WHERE customer_id = ${data.customerId}
          AND account_id = ${data.accountId}
          AND session_status = 'ACTIVE'
          AND expires_at > NOW()
          AND used_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `;

      if (activeSessions && activeSessions.length > 0) {
        const existing = activeSessions[0];
        return {
          id: existing.id,
          proofReference: existing.proof_reference,
          customerId: data.customerId,
          accountId: data.accountId,
          paymentOrderCode: existing.payment_order_code,
          paymentLinkId: existing.payment_link_id,
          paymentCheckoutUrl: existing.payment_checkout_url,
          sessionStatus: existing.session_status,
          verificationStatus: existing.verification_status,
          expiresAt: existing.expires_at,
          isReused: true,
        };
      }

      // 3. Create fresh session
      const created = await tx.customerBankVerificationProof.create({
        data: {
          proofReference: data.proofReference,
          customerId: data.customerId,
          accountId: data.accountId,
          bankBin: data.bankBin,
          accountNumberHash: data.accountNumberHash,
          status: 'PENDING',
          sessionStatus: 'ACTIVE',
          verificationStatus: 'PENDING',
          paymentOrderCode: data.paymentOrderCode,
          paymentLinkId: data.paymentLinkId,
          paymentCheckoutUrl: data.paymentCheckoutUrl,
          expiresAt: data.expiresAt,
        },
      });

      return {
        id: created.id,
        proofReference: created.proofReference,
        customerId: created.customerId,
        accountId: created.accountId,
        paymentOrderCode: created.paymentOrderCode,
        paymentLinkId: created.paymentLinkId,
        paymentCheckoutUrl: created.paymentCheckoutUrl,
        sessionStatus: created.sessionStatus,
        verificationStatus: created.verificationStatus,
        expiresAt: created.expiresAt,
        isReused: false,
      };
    });
  }

  async findVerificationSessionByOrderCode(orderCode: bigint) {
    return this.prisma.customerBankVerificationProof.findUnique({
      where: { paymentOrderCode: orderCode },
      include: {
        customer: true,
        bankAccount: true,
        inboundTransactions: true,
      },
    });
  }

  async findVerificationSessionById(sessionId: bigint) {
    return this.prisma.customerBankVerificationProof.findUnique({
      where: { id: sessionId },
      include: {
        customer: true,
        bankAccount: true,
        inboundTransactions: {
          include: {
            refundObligation: true,
          },
        },
      },
    });
  }

  async findLatestVerificationSessionByAccount(customerId: bigint, accountId: bigint) {
    return this.prisma.customerBankVerificationProof.findFirst({
      where: { customerId, accountId },
      orderBy: { createdAt: 'desc' },
      include: {
        inboundTransactions: {
          include: {
            refundObligation: true,
          },
        },
      },
    });
  }

  async findVerificationSessionsHistory(customerId: bigint, skip = 0, take = 20) {
    const [items, total] = await Promise.all([
      this.prisma.customerBankVerificationProof.findMany({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          bankAccount: true,
          inboundTransactions: {
            include: {
              refundObligation: true,
            },
          },
        },
      }),
      this.prisma.customerBankVerificationProof.count({
        where: { customerId },
      }),
    ]);
    return { items, total };
  }

  async findInboundTransactionByProviderRef(provider: string, channel: string, ref: string) {
    return this.prisma.customerBankInboundTransaction.findUnique({
      where: {
        provider_channel_providerTransactionRef: {
          provider,
          channel,
          providerTransactionRef: ref,
        },
      },
      include: {
        refundObligation: true,
      },
    });
  }

  async flagConflictingInboundTransaction(txId: bigint, reconciliationFlag: string) {
    return this.prisma.customerBankInboundTransaction.update({
      where: { id: txId },
      data: { reconciliationFlag },
    });
  }

  /**
   * Quy trình ghép các quan sát (observations) cụ thể vào một giao dịch xác định (confirmed receipt)
   * - Bắt buộc nhận danh sách observationIds cụ thể, không được tự động quét toàn bộ phiên.
   * - Khóa và xác minh các observation: phải thuộc cùng phiên, chưa từng được ghép (merged_into_inbound_id IS NULL),
   *   không bị chuyển liên kết sang giao dịch khác.
   * - Kiểm tra Idempotency: nếu cùng confirmedTransactionRef đã tồn tại, kiểm tra tính nhất quán dữ liệu và trả kết quả cũ,
   *   tuyệt đối không tạo thêm nghĩa vụ hoàn tiền (obligation) mới.
   * - ĐÚNG THỨ TỰ KHÓA VÀ LOGIC XÁC NHẬN CỦA LUỒNG NHẬN TIỀN:
   *   1. Khóa customer_bank_accounts trước (account FOR UPDATE)
   *   2. Khóa customer_bank_verification_proofs sau (proof FOR UPDATE)
   *   3. Kiểm tra binding: BIN, accountHash, 2.000đ, expiresAt, usedAt, single-use.
   *   4. Chỉ khi ĐỦ TẤT CẢ ĐIỀU KIỆN mới kích hoạt tài khoản qua CAS. Nếu thiếu/sai điều kiện:
   *      vẫn ghi nhận confirmed receipt + obligation hoàn trả, nhưng KHÔNG xác nhận tài khoản!
   * - Lưu liên kết ghép bằng FK (merged_into_inbound_id) và cập nhật match_decision = 'MERGED_INTO_CONFIRMED'.
   */
  async reconcileObservationsIntoConfirmedReceiptTx(params: {
    sessionId: bigint;
    observationIds: bigint[];
    confirmedTransactionRef: string;
    provider?: string;
    channel?: string;
    amount: number | string;
    receivedAt?: Date;
    sourceBankBin?: string | null;
    sourceAccountMasked?: string | null;
    sourceAccountHash?: string | null;
    sourceAccountEncrypted?: string | null;
    sourceAccountName?: string | null;
    rawPayloadChecksum?: string | null;
  }) {
    const provider = params.provider || 'PAYOS';
    const channel = params.channel || 'PAYOS_WEBHOOK';
    const confirmedRef = params.confirmedTransactionRef.trim();
    const amountNum = Number(params.amount);
    const receivedAt = params.receivedAt || new Date();

    if (!Array.isArray(params.observationIds) || params.observationIds.length === 0) {
      throw new BadRequestException('Danh sách observationIds cần ghép không được rỗng');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Khóa và lấy thông tin phiên & tài khoản ngân hàng (account -> proof lock order)
      const proofMeta = await tx.customerBankVerificationProof.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true, customerId: true },
      });
      if (!proofMeta) {
        throw new NotFoundException('Không tìm thấy phiên xác minh');
      }

      // 1a. Khóa tài khoản ngân hàng TRƯỚC (account FOR UPDATE)
      const [lockedAccount] = await tx.$queryRaw<Array<{
        id: bigint;
        customer_id: bigint;
        bank_bin: string;
        account_number_hash: string;
        verification_status: string;
      }>>`
        SELECT id, customer_id, bank_bin, account_number_hash, verification_status
        FROM customer_bank_accounts
        WHERE id = ${proofMeta.accountId} AND customer_id = ${proofMeta.customerId}
        FOR UPDATE
      `;
      if (!lockedAccount) {
        throw new NotFoundException('Tài khoản ngân hàng không tồn tại');
      }

      // 1b. Khóa phiên xác minh SAU (proof FOR UPDATE)
      const [lockedSession] = await tx.$queryRaw<Array<{
        id: bigint;
        customer_id: bigint;
        account_id: bigint;
        bank_bin: string;
        account_number_hash: string;
        session_status: string;
        verification_status: string;
        expires_at: Date;
        used_at: Date | null;
      }>>`
        SELECT id, customer_id, account_id, bank_bin, account_number_hash,
               session_status, verification_status, expires_at, used_at
        FROM customer_bank_verification_proofs
        WHERE id = ${params.sessionId}
        FOR UPDATE
      `;
      if (!lockedSession) {
        throw new NotFoundException('Không tìm thấy phiên xác minh');
      }

      // 2. KHÓA VÀ KIỂM TRA TỪNG OBSERVATION CỤ THỂ ĐƯỢC YÊU CẦU
      const observations = await tx.$queryRaw<Array<{
        id: bigint;
        proof_id: bigint | null;
        provider: string;
        channel: string;
        provider_transaction_ref: string;
        amount: string;
        source_bank_bin: string | null;
        source_account_hash: string | null;
        source_account_masked: string | null;
        merged_into_inbound_id: bigint | null;
        match_decision: string;
        reconciliation_flag: string | null;
      }>>`
        SELECT id, proof_id, provider, channel, provider_transaction_ref, amount,
               source_bank_bin, source_account_hash, source_account_masked,
               merged_into_inbound_id, match_decision, reconciliation_flag
        FROM customer_bank_inbound_transactions
        WHERE id = ANY(${params.observationIds}::bigint[])
        FOR UPDATE
      `;

      // 2a. Kiểm tra đủ tất cả ID yêu cầu phải tồn tại
      if (observations.length !== params.observationIds.length) {
        throw new NotFoundException('Một hoặc nhiều bản ghi observation không tồn tại trong hệ thống');
      }

      // 3. KIỂM TRA TÍNH HỢP LỆ VÀ ĐỐI CHIẾU DỮ LIỆU CỦA TỪNG OBSERVATION VỚI BẰNG CHỨNG XÁC NHẬN
      for (const obs of observations) {
        // a) Phải thuộc đúng session này
        if (!obs.proof_id || obs.proof_id.toString() !== params.sessionId.toString()) {
          throw new BadRequestException(
            `Quan sát #${obs.id} không thuộc về phiên xác minh #${params.sessionId}`,
          );
        }

        // b) Phải là bản ghi quan sát hợp lệ
        const isObsRecord =
          obs.reconciliation_flag === 'FLAGGED_MISSING_PROVIDER_REF' ||
          obs.match_decision === 'MISSING_TRANSACTION_REF' ||
          obs.provider_transaction_ref.startsWith('UNREF_OBS_') ||
          obs.match_decision === 'MERGED_INTO_CONFIRMED';
        if (!isObsRecord) {
          throw new BadRequestException(
            `Bản ghi #${obs.id} (${obs.provider_transaction_ref}) không phải là quan sát đối soát hợp lệ để ghép`,
          );
        }

        // c) Đối chiếu Provider và Channel
        if (obs.provider !== provider) {
          throw new ConflictException(
            `Quan sát #${obs.id} có provider (${obs.provider}) không khớp với giao dịch xác nhận (${provider})`,
          );
        }
        if (obs.channel !== channel) {
          throw new ConflictException(
            `Quan sát #${obs.id} có channel (${obs.channel}) không khớp với kênh giao dịch xác nhận (${channel})`,
          );
        }

        // d) ĐỐI CHIẾU SỐ TIỀN: Không được ghép các khoản khác số tiền vào cùng một giao dịch
        if (Number(obs.amount) !== amountNum) {
          throw new ConflictException(
            `Số tiền của quan sát #${obs.id} (${obs.amount}đ) không khớp với giao dịch xác nhận (${amountNum}đ). Không thể tự động ghép các khoản khác số tiền.`,
          );
        }

        // e) ĐỐI CHIẾU TÀI KHOẢN NGUỒN (nếu observation có thông tin)
        if (params.sourceBankBin && obs.source_bank_bin && obs.source_bank_bin !== params.sourceBankBin) {
          throw new ConflictException(
            `Mã BIN nguồn của quan sát #${obs.id} (${obs.source_bank_bin}) mâu thuẫn với chứng từ xác nhận (${params.sourceBankBin})`,
          );
        }
        if (
          params.sourceAccountHash &&
          obs.source_account_hash &&
          obs.source_account_hash !== params.sourceAccountHash
        ) {
          throw new ConflictException(
            `Tài khoản nguồn của quan sát #${obs.id} mâu thuẫn với chứng từ xác nhận`,
          );
        }
      }

      // 4. KIỂM TRA NẾU GIAO DỊCH XÁC NHẬN ĐÃ TỒN TẠI (Idempotency hoặc Bổ sung liên kết)
      const existingInbound = await tx.customerBankInboundTransaction.findUnique({
        where: {
          provider_channel_providerTransactionRef: {
            provider,
            channel,
            providerTransactionRef: confirmedRef,
          },
        },
        include: {
          refundObligation: true,
        },
      });

      if (existingInbound) {
        // So sánh các thuộc tính bất biến của existingInbound
        const isAmountMatch = Number(existingInbound.amount) === amountNum;
        const isSessionMatch = existingInbound.proofId?.toString() === params.sessionId.toString();
        const isBinMatch = (existingInbound.sourceBankBin || null) === (params.sourceBankBin || null);
        const isAccountMatch = (existingInbound.sourceAccountHash || null) === (params.sourceAccountHash || null);

        if (!isAmountMatch || !isSessionMatch || !isBinMatch || !isAccountMatch) {
          throw new ConflictException(
            `Giao dịch xác nhận ${confirmedRef} đã tồn tại nhưng có dữ liệu mâu thuẫn (amount/session/bin/account)`,
          );
        }

        // Kiểm tra từng observation đối với existingInbound
        const pendingObsIds: bigint[] = [];
        for (const obs of observations) {
          if (obs.merged_into_inbound_id) {
            if (obs.merged_into_inbound_id.toString() !== existingInbound.id.toString()) {
              throw new ConflictException(
                `Quan sát #${obs.id} đã được ghép vào giao dịch khác (#${obs.merged_into_inbound_id}), không thể đổi liên kết`,
              );
            }
            // Đã liên kết đúng vào existingInbound
          } else {
            // Chưa được liên kết -> Cho phép bổ sung vào existingInbound
            pendingObsIds.push(obs.id);
          }
        }

        if (pendingObsIds.length > 0) {
          // Bổ sung các observation chưa liên kết vào existingInbound
          await tx.customerBankInboundTransaction.updateMany({
            where: { id: { in: pendingObsIds } },
            data: {
              mergedIntoInboundId: existingInbound.id,
              matchDecision: 'MERGED_INTO_CONFIRMED',
              reconciliationFlag: `RECONCILED_MERGED_INTO_${confirmedRef}`.slice(0, 64),
            },
          });
        }

        const totalLinked = await tx.customerBankInboundTransaction.count({
          where: { mergedIntoInboundId: existingInbound.id },
        });

        return {
          idempotent: pendingObsIds.length === 0,
          confirmedInbound: existingInbound,
          obligation: existingInbound.refundObligation,
          mergedObservationsCount: totalLinked,
          shouldActivate: false,
          matchDecision: existingInbound.matchDecision,
        };
      }

      // 5. NẾU GIAO DỊCH CHƯA TỒN TẠI: Kiểm tra tất cả observation phải chưa từng được ghép
      for (const obs of observations) {
        if (obs.merged_into_inbound_id !== null || obs.match_decision === 'MERGED_INTO_CONFIRMED') {
          throw new ConflictException(
            `Quan sát #${obs.id} đã được ghép vào giao dịch #${obs.merged_into_inbound_id || 'UNKNOWN'}, không thể ghép lại`,
          );
        }
      }

      // 6. ĐÁNH GIÁ ĐIỀU KIỆN KÍCH HOẠT THEO CHUẨN LUỒNG NHẬN TIỀN
      const isSessionActive = lockedSession.session_status === 'ACTIVE';
      const isSessionUnused = lockedSession.used_at === null;
      const isSessionUnexpired =
        new Date(lockedSession.expires_at).getTime() > receivedAt.getTime() &&
        new Date(lockedSession.expires_at).getTime() > Date.now();
      const isLate = !isSessionUnexpired;

      const isExactPolicyAmount = amountNum === 2000;
      const isAccountUnverified = lockedAccount.verification_status !== 'VERIFIED';

      const isBinMatched = Boolean(params.sourceBankBin && params.sourceBankBin === lockedSession.bank_bin);
      const isAccountMatched = Boolean(
        params.sourceAccountHash && params.sourceAccountHash === lockedSession.account_number_hash,
      );
      const hasSufficientEvidence = Boolean(params.sourceBankBin && params.sourceAccountHash);

      let matchDecision = 'PENDING';
      let reconciliationFlag: string | null = 'RECONCILED_CONFIRMED';

      if (!hasSufficientEvidence) {
        matchDecision = 'INSUFFICIENT_DATA';
      } else if (!isBinMatched) {
        matchDecision = 'MISMATCH_BIN';
      } else if (!isAccountMatched) {
        matchDecision = 'MISMATCH_ACCOUNT';
      } else if (!isExactPolicyAmount) {
        matchDecision = 'INVALID_AMOUNT';
      } else {
        matchDecision = 'MATCHED';
      }

      if (isLate) {
        reconciliationFlag = 'FLAGGED_LATE_PAYMENT';
      } else if (!isExactPolicyAmount) {
        reconciliationFlag = 'FLAGGED_INVALID_AMOUNT';
      }

      // Chỉ kích hoạt khi thỏa mãn 100% điều kiện chuẩn!
      const shouldActivate =
        matchDecision === 'MATCHED' &&
        isExactPolicyAmount &&
        !isLate &&
        isSessionActive &&
        isSessionUnused &&
        isAccountUnverified;

      // 7. TẠO GIAO DỊCH THỰC NHẬN DUY NHẤT (confirmed receipt)
      const confirmedInbound = await tx.customerBankInboundTransaction.create({
        data: {
          proofId: lockedSession.id,
          provider,
          channel,
          providerTransactionRef: confirmedRef,
          amount: params.amount,
          receivedAt,
          isLatePayment: isLate,
          sourceBankBin: params.sourceBankBin,
          sourceAccountMasked: params.sourceAccountMasked,
          sourceAccountHash: params.sourceAccountHash,
          sourceAccountEncrypted: params.sourceAccountEncrypted,
          sourceAccountName: params.sourceAccountName,
          hasSufficientEvidence,
          sessionMatchStatus: 'MATCHED_SESSION',
          matchDecision,
          rawPayloadChecksum: params.rawPayloadChecksum,
          reconciliationFlag,
        },
      });

      // 8. CẬP NHẬT CÁC OBSERVATION ĐÃ CHỌN VỚI FK mergedIntoInboundId
      await tx.customerBankInboundTransaction.updateMany({
        where: {
          id: { in: params.observationIds },
        },
        data: {
          mergedIntoInboundId: confirmedInbound.id,
          matchDecision: 'MERGED_INTO_CONFIRMED',
          reconciliationFlag: `RECONCILED_MERGED_INTO_${confirmedRef}`.slice(0, 64),
        },
      });

      // 9. TẠO DUY NHẤT 1 NGHĨA VỤ HOÀN TRẢ (1:1 với confirmed receipt)
      const initialRefundStatus = hasSufficientEvidence ? 'PENDING_REFUND' : 'PENDING_MANUAL_REFUND';
      const obligation = await tx.customerBankRefundObligation.create({
        data: {
          inboundTransactionId: confirmedInbound.id,
          refundAmount: params.amount,
          refundStatus: initialRefundStatus,
          targetBankBin: params.sourceBankBin,
          targetAccountMasked: params.sourceAccountMasked,
          targetAccountHash: params.sourceAccountHash,
          targetAccountEncrypted: params.sourceAccountEncrypted,
          targetAccountName: params.sourceAccountName,
          refundPayoutReference: `REF_PAYOS_${confirmedRef}_${Date.now()}`.slice(0, 64),
        },
      });

      // 10. CẬP NHẬT TRẠNG THÁI PHIÊN VÀ TÀI KHOẢN THEO CHUẨN CAS
      if (shouldActivate) {
        // CAS: Consume session and mark VERIFIED
        const affectedProofs = await tx.$executeRaw`
          UPDATE customer_bank_verification_proofs
          SET session_status = 'CONSUMED',
              verification_status = 'VERIFIED',
              status = 'SUCCESS',
              verified_at = NOW(),
              verified_by_transaction_id = ${confirmedInbound.id},
              used_at = NOW(),
              updated_at = NOW()
          WHERE id = ${lockedSession.id}
            AND session_status = 'ACTIVE'
            AND used_at IS NULL
        `;
        if (affectedProofs !== 1) {
          throw new ConflictException('Xung đột đồng thời: Phiên xác minh đã được tiêu thụ bởi giao dịch khác');
        }

        // Kích hoạt tài khoản ngân hàng
        await tx.$executeRaw`
          UPDATE customer_bank_accounts
          SET verification_status = 'VERIFIED',
              updated_at = NOW()
          WHERE id = ${lockedAccount.id} AND customer_id = ${lockedAccount.customer_id}
        `;
      } else {
        // Không đủ điều kiện kích hoạt -> Giữ tài khoản PENDING, ghi nhận lý do vào session nếu chưa VERIFIED
        const sessionUpdateData: any = { updatedAt: new Date() };
        if (matchDecision === 'INSUFFICIENT_DATA') {
          sessionUpdateData.verificationStatus = 'PENDING_SOURCE_EVIDENCE';
        } else if (matchDecision === 'MISMATCH_BIN' || matchDecision === 'MISMATCH_ACCOUNT') {
          sessionUpdateData.verificationStatus = 'FAILED_MISMATCH';
          sessionUpdateData.rejectionReason = `Giao dịch đối soát không khớp thông tin tài khoản đăng ký (${matchDecision})`;
        } else if (matchDecision === 'INVALID_AMOUNT') {
          sessionUpdateData.rejectionReason = `Số tiền chuyển khoản (${params.amount}đ) không đúng chính sách 2.000đ`;
        } else if (isLate) {
          sessionUpdateData.rejectionReason = 'Giao dịch đối soát nhận sau khi phiên xác minh đã hết hạn';
        }

        await tx.customerBankVerificationProof.updateMany({
          where: {
            id: lockedSession.id,
            verificationStatus: { not: 'VERIFIED' },
          },
          data: sessionUpdateData,
        });
      }

      const totalLinked = await tx.customerBankInboundTransaction.count({
        where: { mergedIntoInboundId: confirmedInbound.id },
      });

      return {
        idempotent: false,
        confirmedInbound,
        obligation,
        mergedObservationsCount: totalLinked,
        shouldActivate,
        matchDecision,
      };
    });
  }

  async recordInboundTransactionAndObligationAtomicTx(params: {
    proofId?: bigint | null;
    provider: string;
    channel: string;
    providerTransactionRef: string;
    amount: number | string;
    receivedAt: Date;
    sourceBankBin?: string | null;
    sourceAccountMasked?: string | null;
    sourceAccountHash?: string | null;
    sourceAccountEncrypted?: string | null;
    sourceAccountName?: string | null;
    hasSufficientEvidence: boolean;
    rawPayloadChecksum?: string | null;
    reconciliationFlag?: string | null;
    refundPayoutReference: string;
  }) {
    const amountNum = Number(params.amount);

    return this.prisma.$transaction(async (tx) => {
      let isLate = false;
      let sessionMatchStatus = params.proofId ? 'MATCHED_SESSION' : 'UNMATCHED_NO_SESSION';
      let matchDecision = 'PENDING';
      let reconciliationFlag = params.reconciliationFlag || null;
      let shouldActivate = false;

      let lockedSession: any = null;
      let lockedAccount: any = null;

      // 1. If proofId is attached, lock account and session in strict uniform hierarchy (account -> proof)
      if (params.proofId) {
        // Read proof metadata first without row lock to obtain customerId & accountId
        const proofMeta = await tx.customerBankVerificationProof.findUnique({
          where: { id: params.proofId },
          select: { accountId: true, customerId: true },
        });

        if (proofMeta) {
          // Lock customer bank account row exclusively FIRST (consistent lock hierarchy: account -> proof)
          const [acc] = await tx.$queryRaw<Array<{
            id: bigint;
            customer_id: bigint;
            bank_bin: string;
            account_number_hash: string;
            verification_status: string;
          }>>`
            SELECT id, customer_id, bank_bin, account_number_hash, verification_status
            FROM customer_bank_accounts
            WHERE id = ${proofMeta.accountId} AND customer_id = ${proofMeta.customerId}
            FOR UPDATE
          `;
          lockedAccount = acc;

          // Lock session row exclusively SECOND
          const [sess] = await tx.$queryRaw<Array<{
            id: bigint;
            customer_id: bigint;
            account_id: bigint;
            bank_bin: string;
            account_number_hash: string;
            session_status: string;
            verification_status: string;
            expires_at: Date;
            used_at: Date | null;
          }>>`
            SELECT id, customer_id, account_id, bank_bin, account_number_hash,
                   session_status, verification_status, expires_at, used_at
            FROM customer_bank_verification_proofs
            WHERE id = ${params.proofId}
            FOR UPDATE
          `;
          lockedSession = sess;

          // In-transaction validation of all lifecycle invariants
          const isSessionActive = lockedSession.session_status === 'ACTIVE';
          const isSessionUnused = lockedSession.used_at === null;
          const isSessionUnexpired =
            new Date(lockedSession.expires_at).getTime() > params.receivedAt.getTime() &&
            new Date(lockedSession.expires_at).getTime() > Date.now();
          isLate = !isSessionUnexpired;

          const isExactPolicyAmount = amountNum === 2000;
          const isAccountUnverified = lockedAccount && lockedAccount.verification_status !== 'VERIFIED';

          const isBinMatched = Boolean(params.sourceBankBin && params.sourceBankBin === lockedSession.bank_bin);
          const isAccountMatched = Boolean(
            params.sourceAccountHash && params.sourceAccountHash === lockedSession.account_number_hash,
          );

          if (params.reconciliationFlag === 'FLAGGED_MISSING_PROVIDER_REF') {
            matchDecision = 'MISSING_TRANSACTION_REF';
            shouldActivate = false;
          } else if (!params.hasSufficientEvidence) {
            matchDecision = 'INSUFFICIENT_DATA';
            shouldActivate = false;
          } else if (!isBinMatched) {
            matchDecision = 'MISMATCH_BIN';
          } else if (!isAccountMatched) {
            matchDecision = 'MISMATCH_ACCOUNT';
          } else if (!isExactPolicyAmount) {
            matchDecision = 'INVALID_AMOUNT';
          } else {
            matchDecision = 'MATCHED';
          }

          if (isLate) {
            reconciliationFlag = reconciliationFlag || 'FLAGGED_LATE_PAYMENT';
          } else if (!isExactPolicyAmount) {
            reconciliationFlag = reconciliationFlag || 'FLAGGED_INVALID_AMOUNT';
          }

          // Full criteria required for activating account and consuming session
          shouldActivate =
            matchDecision === 'MATCHED' &&
            isExactPolicyAmount &&
            !isLate &&
            isSessionActive &&
            isSessionUnused &&
            Boolean(isAccountUnverified);
        } else {
          sessionMatchStatus = 'UNMATCHED_NO_SESSION';
          if (params.reconciliationFlag === 'FLAGGED_MISSING_PROVIDER_REF') {
            matchDecision = 'MISSING_TRANSACTION_REF';
            reconciliationFlag = 'FLAGGED_MISSING_PROVIDER_REF';
          } else {
            matchDecision = 'UNMATCHED_SESSION';
            reconciliationFlag = params.reconciliationFlag || 'FLAGGED_UNMATCHED_SESSION';
          }
        }
      } else {
        if (params.reconciliationFlag === 'FLAGGED_MISSING_PROVIDER_REF') {
          matchDecision = 'MISSING_TRANSACTION_REF';
          reconciliationFlag = 'FLAGGED_MISSING_PROVIDER_REF';
        } else {
          matchDecision = 'UNMATCHED_SESSION';
          reconciliationFlag = params.reconciliationFlag || 'FLAGGED_UNMATCHED_SESSION';
        }
      }

      // 2. Insert Inbound Transaction (Sổ giao dịch thực nhận)
      const inbound = await tx.customerBankInboundTransaction.create({
        data: {
          proofId: params.proofId || null,
          provider: params.provider,
          channel: params.channel || 'DEFAULT',
          providerTransactionRef: params.providerTransactionRef,
          amount: params.amount,
          receivedAt: params.receivedAt,
          isLatePayment: isLate,
          sourceBankBin: params.sourceBankBin,
          sourceAccountMasked: params.sourceAccountMasked,
          sourceAccountHash: params.sourceAccountHash,
          sourceAccountEncrypted: params.sourceAccountEncrypted,
          sourceAccountName: params.sourceAccountName,
          hasSufficientEvidence: params.hasSufficientEvidence,
          sessionMatchStatus,
          matchDecision,
          rawPayloadChecksum: params.rawPayloadChecksum,
          reconciliationFlag,
        },
      });

      // 3. Insert Refund Obligation (Sổ nghĩa vụ hoàn trả - chỉ ghi nhận khi phân biệt được giao dịch thực nhận)
      // P2 Invariant Fix (custbank/unmatched-session-auto-refund-obligation):
      // Khi giao dịch không khớp phiên (UNMATCHED_SESSION) hoặc proofId null, tuyệt đối không tạo PENDING_REFUND
      // tự động payout. Luôn đặt PENDING_MANUAL_REFUND để kế toán đối soát thủ công.
      const isMissingRef = params.reconciliationFlag === 'FLAGGED_MISSING_PROVIDER_REF';
      const isUnmatchedOrNoProof = !params.proofId || matchDecision === 'UNMATCHED_SESSION';
      let obligation: any = null;
      if (!isMissingRef) {
        const initialRefundStatus =
          (params.hasSufficientEvidence && !isUnmatchedOrNoProof)
            ? 'PENDING_REFUND'
            : 'PENDING_MANUAL_REFUND';
        obligation = await tx.customerBankRefundObligation.create({
          data: {
            inboundTransactionId: inbound.id,
            refundAmount: params.amount,
            refundStatus: initialRefundStatus,
            targetBankBin: params.sourceBankBin,
            targetAccountMasked: params.sourceAccountMasked,
            targetAccountHash: params.sourceAccountHash,
            targetAccountEncrypted: params.sourceAccountEncrypted,
            targetAccountName: params.sourceAccountName,
            refundPayoutReference: params.refundPayoutReference,
          },
        });
      }

      // 4. Update session and account status based on strict in-transaction checks
      if (lockedSession) {
        if (shouldActivate) {
          // Atomic CAS: Consume session and mark VERIFIED
          const affectedProofs = await tx.$executeRaw`
            UPDATE customer_bank_verification_proofs
            SET session_status = 'CONSUMED',
                verification_status = 'VERIFIED',
                status = 'SUCCESS',
                verified_at = NOW(),
                verified_by_transaction_id = ${inbound.id},
                used_at = NOW(),
                updated_at = NOW()
            WHERE id = ${lockedSession.id}
              AND session_status = 'ACTIVE'
              AND used_at IS NULL
          `;
          if (affectedProofs !== 1) {
            throw new ConflictException(
              'Xung đột đồng thời: Phiên xác minh đã được tiêu thụ bởi giao dịch khác',
            );
          }

          // Atomic activate bank account
          await tx.$executeRaw`
            UPDATE customer_bank_accounts
            SET verification_status = 'VERIFIED',
                updated_at = NOW()
            WHERE id = ${lockedAccount.id} AND customer_id = ${lockedAccount.customer_id}
          `;
        } else {
          // Session is NOT activated or consumed. Update verification status if not already VERIFIED
          const sessionUpdateData: any = { updatedAt: new Date() };

          if (matchDecision === 'INSUFFICIENT_DATA') {
            sessionUpdateData.verificationStatus = 'PENDING_SOURCE_EVIDENCE';
          } else if (matchDecision === 'MISMATCH_BIN' || matchDecision === 'MISMATCH_ACCOUNT') {
            sessionUpdateData.verificationStatus = 'FAILED_MISMATCH';
            sessionUpdateData.rejectionReason = `Giao dịch không khớp thông tin tài khoản đăng ký (${matchDecision})`;
          } else if (matchDecision === 'INVALID_AMOUNT') {
            sessionUpdateData.rejectionReason = `Số tiền chuyển khoản (${params.amount}đ) không đúng chính sách 2.000đ`;
          } else if (isLate) {
            sessionUpdateData.rejectionReason = 'Giao dịch nhận sau khi phiên xác minh đã hết hạn';
          }

          await tx.customerBankVerificationProof.updateMany({
            where: {
              id: lockedSession.id,
              verificationStatus: { not: 'VERIFIED' },
            },
            data: sessionUpdateData,
          });
        }
      }

      return { inbound, obligation, shouldActivate, matchDecision };
    });
  }

  async findPendingRefundObligations(limit = 20) {
    return this.prisma.customerBankRefundObligation.findMany({
      where: {
        refundStatus: 'PENDING_REFUND',
        activePayoutAttemptId: null,
      },
      take: limit,
      orderBy: { createdAt: 'asc' },
      include: {
        inboundTransaction: true,
      },
    });
  }

  async findPendingReconciliationAttempts(limit = 20) {
    const now = new Date();
    return this.prisma.customerBankRefundPayoutAttempt.findMany({
      where: {
        status: { in: ['PREPARING', 'SUBMITTED', 'PENDING_RECONCILIATION', 'PROCESSING'] },
        OR: [
          { nextReconcileAt: null },
          { nextReconcileAt: { lte: now } },
        ],
      },
      take: limit,
      orderBy: [
        { nextReconcileAt: 'asc' },
        { createdAt: 'asc' },
      ],
      include: {
        obligation: true,
      },
    });
  }

  async updateAttemptReconcileBackoff(attemptId: bigint, backoffMs: number, reason?: string) {
    const nextReconcileAt = new Date(Date.now() + backoffMs);
    return this.prisma.customerBankRefundPayoutAttempt.update({
      where: { id: attemptId },
      data: {
        nextReconcileAt,
        reconcileAttempts: { increment: 1 },
        failureReason: reason ? reason.slice(0, 255) : undefined,
      },
    });
  }

  async moveObligationToManualRefund(obligationId: bigint, reason: string) {
    return this.prisma.customerBankRefundObligation.update({
      where: { id: obligationId },
      data: {
        refundStatus: 'PENDING_MANUAL_REFUND',
        failureReason: reason,
        updatedAt: new Date(),
      },
    });
  }

  async createPayoutAttemptAndLockObligationTx(obligationId: bigint, payoutProvider = 'PAYOS') {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock obligation row
      const [obligation] = await tx.$queryRaw<Array<{
        id: bigint;
        refund_status: string;
        refund_amount: string;
        target_bank_bin: string | null;
        target_account_masked: string | null;
        target_account_encrypted: string | null;
        target_account_name: string | null;
        active_payout_attempt_id: bigint | null;
      }>>`
        SELECT id, refund_status, refund_amount, target_bank_bin, target_account_masked,
               target_account_encrypted, target_account_name, active_payout_attempt_id
        FROM customer_bank_refund_obligations
        WHERE id = ${obligationId}
        FOR UPDATE
      `;
      if (!obligation) {
        throw new NotFoundException('Không tìm thấy nghĩa vụ hoàn tiền');
      }

      if (obligation.refund_status !== 'PENDING_REFUND' && obligation.refund_status !== 'PROCESSING_REFUND') {
        throw new ConflictException(`Nghĩa vụ hoàn tiền ở trạng thái ${obligation.refund_status}, không thể chi trả.`);
      }

      // Check if there is an existing in-flight attempt
      if (obligation.active_payout_attempt_id) {
        throw new ConflictException('Đang có một đợt chi trả payout đang xử lý cho nghĩa vụ này (chờ đối soát)');
      }

      // 2. Count existing attempts to determine next attempt number
      const count = await tx.customerBankRefundPayoutAttempt.count({
        where: { obligationId },
      });
      const attemptNumber = count + 1;
      const payoutReference = `REF_OBL_${obligation.id}_ATT_${attemptNumber}_${Date.now()}`.slice(0, 64);

      // 3. Create payout attempt in PREPARING status
      const attempt = await tx.customerBankRefundPayoutAttempt.create({
        data: {
          obligationId,
          attemptNumber,
          payoutProvider,
          payoutReference,
          status: 'PREPARING',
        },
      });

      // 4. Update obligation to point to this active attempt
      await tx.customerBankRefundObligation.update({
        where: { id: obligationId },
        data: {
          activePayoutAttemptId: attempt.id,
          refundStatus: 'PROCESSING_REFUND',
          updatedAt: new Date(),
        },
      });

      return { obligation, attempt };
    });
  }

  async finalizePayoutAttemptTx(params: {
    obligationId: bigint;
    attemptId: bigint;
    status: 'SUCCESS' | 'FAILED' | 'PENDING_RECONCILIATION';
    providerPayoutId?: string;
    responseCode?: string;
    failureReason?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock obligation row
      const [obligation] = await tx.$queryRaw<Array<{
        id: bigint;
        refund_status: string;
        refund_amount: string;
        active_payout_attempt_id: bigint | null;
      }>>`
        SELECT id, refund_status, refund_amount, active_payout_attempt_id
        FROM customer_bank_refund_obligations
        WHERE id = ${params.obligationId}
        FOR UPDATE
      `;
      if (!obligation) {
        throw new NotFoundException('Không tìm thấy nghĩa vụ hoàn tiền');
      }

      // 2. Lock attempt row
      const [attempt] = await tx.$queryRaw<Array<{
        id: bigint;
        obligation_id: bigint;
        attempt_number: number;
        status: string;
      }>>`
        SELECT id, obligation_id, attempt_number, status
        FROM customer_bank_refund_payout_attempts
        WHERE id = ${params.attemptId}
        FOR UPDATE
      `;
      if (!attempt) {
        throw new NotFoundException('Không tìm thấy lượt chi trả payout');
      }

      // 3. Verify attempt belongs to obligation
      if (attempt.obligation_id.toString() !== obligation.id.toString()) {
        throw new BadRequestException('Lượt chi trả không thuộc về nghĩa vụ hoàn tiền này');
      }

      // 4. Anti-reversal & terminal state protection:
      // a) Kiểm tra trạng thái kết thúc của chính attempt:
      const isAttemptTerminal = attempt.status === 'SUCCESS' || attempt.status === 'FAILED';
      if (isAttemptTerminal) {
        if (params.status === attempt.status) {
          // Idempotent duplicate callback matching current terminal status
          return { success: true, idempotent: true };
        }
        throw new ConflictException(
          `Lượt chi trả #${attempt.id} đã ở trạng thái kết thúc (${attempt.status}), không thể ghi đè sang ${params.status}`,
        );
      }

      // b) Kiểm tra trạng thái kết thúc của obligation: Không bao giờ đảo ngược REFUNDED
      if (obligation.refund_status === 'REFUNDED') {
        if (params.status === 'SUCCESS') {
          return { success: true, idempotent: true };
        }
        throw new ConflictException('Không thể đảo ngược trạng thái nghĩa vụ hoàn tiền đã hoàn thành (REFUNDED)');
      }

      // c) Với chuyển trạng thái đang hoạt động: bắt buộc active pointer khớp chính xác!
      // Nếu active pointer là null (hoặc trỏ tới attempt khác), từ chối cập nhật!
      if (
        !obligation.active_payout_attempt_id ||
        obligation.active_payout_attempt_id.toString() !== attempt.id.toString()
      ) {
        throw new ConflictException(
          `Lượt chi trả #${attempt.id} không phải là lượt chi trả đang hoạt động của nghĩa vụ (active pointer: ${obligation.active_payout_attempt_id || 'null'})`,
        );
      }

      // 5. Update attempt
      await tx.customerBankRefundPayoutAttempt.update({
        where: { id: params.attemptId },
        data: {
          status: params.status,
          providerPayoutId: params.providerPayoutId,
          responseCode: params.responseCode,
          failureReason: params.failureReason,
          reconciledAt: params.status !== 'PENDING_RECONCILIATION' ? new Date() : null,
        },
      });

      // 6. Update obligation
      const obligationUpdate: any = {
        updatedAt: new Date(),
      };

      if (params.status === 'SUCCESS') {
        obligationUpdate.refundStatus = 'REFUNDED';
        obligationUpdate.refundedAt = new Date();
        obligationUpdate.activePayoutAttemptId = null;
        obligationUpdate.failureReason = null;
      } else if (params.status === 'FAILED') {
        if (attempt.attempt_number < 3) {
          obligationUpdate.refundStatus = 'PENDING_REFUND';
          obligationUpdate.failureReason = params.failureReason || 'Chi trả thất bại, chờ thử lại';
          obligationUpdate.activePayoutAttemptId = null;
        } else {
          obligationUpdate.refundStatus = 'PENDING_MANUAL_REFUND';
          obligationUpdate.failureReason = `Vượt quá số lần thử lại tối đa (3 lần): ${params.failureReason || 'Lỗi PayOS'}`;
          obligationUpdate.activePayoutAttemptId = null;
        }
      } else if (params.status === 'PENDING_RECONCILIATION') {
        obligationUpdate.refundStatus = 'PROCESSING_REFUND';
        obligationUpdate.activePayoutAttemptId = attempt.id;
      }

      await tx.customerBankRefundObligation.update({
        where: { id: params.obligationId },
        data: obligationUpdate,
      });

      return { success: true, idempotent: false };
    });
  }
}
