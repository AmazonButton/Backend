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
}
