import {
  Injectable,
  Inject,
  ForbiddenException,
  Optional,
  Logger,
} from '@nestjs/common';
import { StoreCashRepository } from './store-cash.repository';
import {
  IssueCashVoucherDto,
  CollectCashDto,
  validatePathId,
  validateZod,
  cashPaginationQuerySchema,
} from './dto/store-cash.dto';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';

@Injectable()
export class StoreCashService {
  private readonly logger = new Logger(StoreCashService.name);

  constructor(
    @Inject(StoreCashRepository) private readonly repository: StoreCashRepository,
    @Optional() @Inject(DashboardCacheService) private readonly dashboardCache?: DashboardCacheService,
  ) {}

  /** Customer creates a single-use QR voucher token for paying cash at a specific store. */
  async issueCashVoucher(rentalIdStr: string, dto: IssueCashVoucherDto, user: any) {
    const rentalId = validatePathId(rentalIdStr, 'rentalId');
    if (!user?.userId) {
      throw new ForbiddenException('Chỉ tài khoản khách hàng mới có thể tạo mã xác nhận thanh toán tiền mặt');
    }
    const actorUserId = validatePathId(String(user.userId), 'userId');

    const result = await this.repository.issueVoucher(
      actorUserId,
      rentalId,
      BigInt(dto.chargeId),
      BigInt(dto.collectingStoreId),
    );

    return {
      success: true,
      message: 'Tạo mã xác nhận thanh toán tiền mặt thành công',
      data: {
        voucherId: result.voucherId.toString(),
        voucherToken: result.rawToken,
        expiresAt: result.expiresAt,
        amount: result.amount,
        collectingStoreId: result.collectingStoreId.toString(),
        rentalId: result.rentalId.toString(),
        chargeId: result.chargeId.toString(),
      },
    };
  }

  /** Store staff confirms cash collection, offsets wallet balance, and optionally hands over buttons. */
  async collectCash(storeIdStr: string, rentalIdStr: string, dto: CollectCashDto, user: any) {
    const storeId = validatePathId(storeIdStr, 'storeId');
    const rentalId = validatePathId(rentalIdStr, 'rentalId');
    if (!user?.userId) {
      throw new ForbiddenException('Tài khoản nhân viên không hợp lệ');
    }
    const actorUserId = validatePathId(String(user.userId), 'userId');

    const result = await this.repository.collect(
      storeId,
      rentalId,
      actorUserId,
      dto,
    );

    // Invalidate dashboard & wallet caches post-commit using exact system prefixes
    await this.invalidateAffectedCaches(storeIdStr, result.context);

    return {
      success: true,
      message: result.idempotent
        ? 'Giao dịch thu tiền mặt đã được ghi nhận trước đó'
        : 'Thu tiền mặt và cấn trừ ví cửa hàng thành công',
      data: {
        receiptId: result.receipt.id.toString(),
        chargeId: result.receipt.chargeId.toString(),
        voucherId: result.receipt.voucherId.toString(),
        collectingStoreId: result.receipt.collectingStoreId.toString(),
        amount: Number(result.receipt.amount),
        createdAt: result.receipt.createdAt,
        idempotent: result.idempotent,
      },
    };
  }

  /** Retrieve receipt details by ID with strict BOLA verification against actor authority. */
  async getReceipt(storeIdStr: string, receiptIdStr: string, user: any) {
    const storeId = validatePathId(storeIdStr, 'storeId');
    const receiptId = validatePathId(receiptIdStr, 'receiptId');
    if (!user?.userId) {
      throw new ForbiddenException('Yêu cầu đăng nhập để truy cập biên nhận');
    }
    const actorUserId = validatePathId(String(user.userId), 'userId');
    const actorRoles = Array.isArray(user?.roles)
      ? user.roles
      : [user?.role].filter(Boolean);

    const receipt = await this.repository.findReceiptById(receiptId, storeId, actorUserId, actorRoles);
    return {
      success: true,
      message: 'Lấy thông tin biên lai thu tiền mặt thành công',
      data: {
        receiptId: receipt.id.toString(),
        chargeId: receipt.chargeId.toString(),
        voucherId: receipt.voucherId.toString(),
        collectingStoreId: receipt.collectingStoreId.toString(),
        amount: Number(receipt.amount),
        createdAt: receipt.createdAt,
        collectedByUser: receipt.collectedBy
          ? {
              userId: receipt.collectedBy.userId.toString(),
              fullName: receipt.collectedBy.fullName,
              email: receipt.collectedBy.email,
            }
          : undefined,
      },
    };
  }

  /** Admin reconciliation queue for overpayments. */
  async listOverpayments(query: any) {
    const validQuery = validateZod(cashPaginationQuerySchema, query);
    const result = await this.repository.listOverpaymentObligations(
      validQuery.page,
      validQuery.pageSize,
      validQuery.status,
    );

    const items = result.items.map((item) => ({
      obligationId: item.id.toString(),
      receiptId: item.receiptId.toString(),
      amount: Number(item.amount),
      status: item.status,
      receiptClassification: item.receiptClassification,
      createdAt: item.createdAt,
      receipt: item.receipt
        ? {
            id: item.receipt.id.toString(),
            chargeId: item.receipt.chargeId.toString(),
            provider: item.receipt.provider,
            channel: item.receipt.channel,
            providerTransactionRef: item.receipt.providerTransactionRef,
            amount: Number(item.receipt.amount),
            currency: item.receipt.currency,
            classification: item.receipt.classification,
            receivedAt: item.receipt.receivedAt,
          }
        : undefined,
    }));

    return {
      success: true,
      message: 'Lấy danh sách nghĩa vụ hoàn trả tiền thừa thành công',
      data: items,
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / result.pageSize),
      },
    };
  }

  /** Invalidate all related store, staff, customer, and admin analytics cache prefixes matching actual keys. */
  private async invalidateAffectedCaches(
    storeId: string,
    context?: {
      customerUserId?: string | null;
      collectingStoreId?: string;
      fulfillmentStoreId?: string;
      affectedButtonIds?: string[];
    } | null,
  ) {
    if (!this.dashboardCache) return;
    const storeStr = storeId.toString();
    const prefixes = [
      `dash:store:${storeStr}:`,
      `staff:dashboard:store:${storeStr}:`,
      `wallet:${storeStr}:`,
      `store:wallet:${storeStr}:`,
      'admin:dashboard:',
      'admin:revenue:',
      'admin:operations',
      'admin:stores-leaderboard:',
      'admin:growth:',
    ];

    if (context?.fulfillmentStoreId && context.fulfillmentStoreId !== storeStr) {
      prefixes.push(
        `dash:store:${context.fulfillmentStoreId}:`,
        `staff:dashboard:store:${context.fulfillmentStoreId}:`,
      );
    }

    try {
      const operations = prefixes.map((p) => this.dashboardCache!.invalidatePrefix(p));
      if (context?.customerUserId) {
        for (const resource of ['dashboard', 'rentals', 'devices']) {
          operations.push(this.dashboardCache.invalidateKey(`customer:${resource}:${context.customerUserId}`));
        }
      }
      await Promise.all(operations);
    } catch (err: any) {
      this.logger.warn(`Post-commit cache invalidation failed: ${err.message}`);
    }
  }

  /** Preview rental details and check store inventory availability for multi-button handover. */
  async getHandoverPreview(storeIdStr: string, rentalIdStr: string, user: any, query: unknown = {}) {
    const storeId = validatePathId(storeIdStr, 'storeId');
    const rentalId = validatePathId(rentalIdStr, 'rentalId');
    if (!user?.userId) {
      throw new ForbiddenException('Yêu cầu đăng nhập để truy cập thông tin bàn giao');
    }
    const actorUserId = validatePathId(String(user.userId), 'userId');
    const actorRoles = Array.isArray(user?.roles)
      ? user.roles
      : [user?.role].filter(Boolean);

    const pagination = validateZod(cashPaginationQuerySchema, query);
    const data = await this.repository.getHandoverPreview(storeId, rentalId, actorUserId, actorRoles,
      { page: pagination.page ?? 1, pageSize: pagination.pageSize ?? 20 });
    return {
      success: true,
      message: 'Lấy thông tin thiết bị khả dụng cho hợp đồng thuê thành công',
      data,
    };
  }
}
