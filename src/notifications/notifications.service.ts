import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FirebaseService, SendPushResult } from './firebase.service';
import { RegisterFcmTokenDto } from './dto/register-fcm-token.dto';
import { NotificationsRepository } from './notifications.repository';
import { QueryNotificationsDto } from './dto/query-notifications.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly repo: NotificationsRepository;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FirebaseService) private readonly firebaseService: FirebaseService,
    @Optional() @Inject(NotificationsRepository) private readonly notificationsRepo?: NotificationsRepository,
  ) {
    this.repo = this.notificationsRepo || new NotificationsRepository(this.prisma);
  }


  /**
   * 1. Dang ky FCM Token cho User
   * Ho tro luu nhieu token cho mot user (da thiet bi: dien thoai, tablet, web).
   * Neu token da ton tai, tu dong re-bind ve userId hien tai va bat is_active = true.
   */
  async registerFcmToken(userId: bigint | number, dto: RegisterFcmTokenDto) {
    const targetUserId = BigInt(userId);
    const trimmedToken = dto.token.trim();
    const normalizedDeviceType = dto.deviceType ? dto.deviceType.trim().toUpperCase() : null;

    // Nguyen tu hoa (Atomic Upsert) de loai bo triet de Race Condition
    // Neu co 2 request dong thoi cung mot token, Prisma Upsert hoac P2002 retry se xu ly an toan tuyet doi.
    try {
      const record = await this.prisma.userFcmToken.upsert({
        where: { token: trimmedToken },
        update: {
          userId: targetUserId,
          ...(normalizedDeviceType ? { deviceType: normalizedDeviceType } : {}),
          isActive: true,
          updatedAt: new Date(),
        },
        create: {
          userId: targetUserId,
          token: trimmedToken,
          deviceType: normalizedDeviceType,
          isActive: true,
        },
      });

      return {
        success: true,
        message: 'FCM token registered successfully',
        tokenId: record.id.toString(),
      };
    } catch (err: any) {
      // P2002: Unique constraint failed on token do collision dong thoi
      if (err.code === 'P2002') {
        const fallback = await this.prisma.userFcmToken.update({
          where: { token: trimmedToken },
          data: {
            userId: targetUserId,
            ...(normalizedDeviceType ? { deviceType: normalizedDeviceType } : {}),
            isActive: true,
            updatedAt: new Date(),
          },
        });
        return {
          success: true,
          message: 'FCM token registered successfully (concurrency resolved)',
          tokenId: fallback.id.toString(),
        };
      }
      throw err;
    }
  }

  /**
   * 2. Huy dang ky / Vo hieu hoa FCM Token
   * Bat buoc scope theo userId, khong duoc unregister chi theo token de bao mat IDOR!
   */
  async unregisterFcmToken(userId: bigint | number, token: string) {
    const targetUserId = BigInt(userId);
    const trimmedToken = token.trim();

    const result = await this.prisma.userFcmToken.updateMany({
      where: {
        userId: targetUserId,
        token: trimmedToken,
      },
      data: {
        isActive: false,
        updatedAt: new Date(),
      },
    });

    return {
      success: true,
      deactivatedCount: result.count,
      message: result.count > 0 ? 'FCM token deactivated successfully' : 'No matching active token found for this user',
    };
  }

  /**
   * 3. Vo hieu hoa token khi logout
   * Neu client gui fcmToken len: vo hieu hoa dung token do cua user.
   * Neu client khong gui token cu the: co the vo hieu hoa tat ca token cua user do.
   */
  async deactivateTokensOnLogout(userId: bigint | number, specificToken?: string) {
    const targetUserId = BigInt(userId);

    if (specificToken && specificToken.trim().length > 0) {
      return this.unregisterFcmToken(targetUserId, specificToken);
    }

    const result = await this.prisma.userFcmToken.updateMany({
      where: {
        userId: targetUserId,
        isActive: true,
      },
      data: {
        isActive: false,
        updatedAt: new Date(),
      },
    });

    return {
      success: true,
      deactivatedCount: result.count,
      message: 'All FCM tokens for this user have been deactivated upon logout',
    };
  }

  /**
   * 4. Gui notification toi User qua FCM va tu dong don dep token khong hop le / het han
   */
  async sendPushToUser(
    userId: bigint | number,
    payload: { title: string; body: string; data?: Record<string, string> },
  ): Promise<SendPushResult> {
    const targetUserId = BigInt(userId);

    const activeTokens = await this.prisma.userFcmToken.findMany({
      where: {
        userId: targetUserId,
        isActive: true,
      },
      select: { token: true },
    });

    if (activeTokens.length === 0) {
      return { successTokens: [], invalidTokens: [], failureCount: 0 };
    }

    const tokenList = activeTokens.map((t) => t.token);
    const result = await this.firebaseService.sendMulticast(
      tokenList,
      payload.title,
      payload.body,
      payload.data,
    );

    // Tu dong don dep token khong hop le / token het han
    if (result.invalidTokens.length > 0) {
      this.logger.warn(
        `[NotificationsService] Cleaning up ${result.invalidTokens.length} expired/invalid FCM tokens for User ${targetUserId.toString()}`,
      );
      await this.prisma.userFcmToken.deleteMany({
        where: {
          token: { in: result.invalidTokens },
        },
      });
    }

    return result;
  }

  /**
   * 5. Gui thong bao khi Tao don hang moi (ORDER_CREATED)
   */
  async sendOrderCreated(order: any, customerUserId: bigint | number, storeOwnerUserId?: bigint | number) {
    const orderCode = order?.orderCode || order?.orderId?.toString() || '';
    const orderId = order?.orderId?.toString() || '';

    // A. Thong bao cho khach hang
    if (customerUserId) {
      await this.sendPushToUser(customerUserId, {
        title: 'Don hang dat thanh cong',
        body: `Don hang #${orderCode} cua ban da duoc he thong tiep nhan.`,
        data: {
          type: 'ORDER_CREATED',
          orderId,
          orderCode,
        },
      });
    }

    // B. Thong bao cho chu cua hang (neu co)
    if (storeOwnerUserId) {
      await this.sendPushToUser(storeOwnerUserId, {
        title: 'Co don hang moi!',
        body: `Cua hang vua nhan duoc don hang moi #${orderCode}.`,
        data: {
          type: 'ORDER_CREATED',
          orderId,
          orderCode,
        },
      });
    }
  }

  /**
   * 6. Gui thong bao khi Thay doi trang thai don hang (ORDER_STATUS_CHANGED)
   */
  async sendOrderStatusChanged(order: any, customerUserId: bigint | number, newStatus: string) {
    const orderCode = order?.orderCode || order?.orderId?.toString() || '';
    const orderId = order?.orderId?.toString() || '';

    if (!customerUserId) return;

    let statusText = newStatus;
    switch (newStatus) {
      case 'PAID':
        statusText = 'da duoc thanh toan thanh cong';
        break;
      case 'CONFIRMED':
        statusText = 'da duoc cua hang xac nhan';
        break;
      case 'PREPARING':
        statusText = 'dang duoc cua hang chuan bi';
        break;
      case 'READY_FOR_DELIVERY':
        statusText = 'da san sang giao';
        break;
      case 'SHIPPING':
        statusText = 'dang tren duong giao den ban';
        break;
      case 'DELIVERED':
        statusText = 'da giao hang thanh cong';
        break;
      case 'COMPLETED':
        statusText = 'da hoan tat';
        break;
      case 'CANCELLED':
        statusText = 'da bi huy';
        break;
      case 'REJECTED':
        statusText = 'da bi tu choi';
        break;
    }

    await this.sendPushToUser(customerUserId, {
      title: 'Cap nhat trang thai don hang',
      body: `Don hang #${orderCode} ${statusText}.`,
      data: {
        type: 'ORDER_STATUS_CHANGED',
        orderId,
        orderCode,
        status: newStatus,
      },
    });
  }

  private formatNotification(item: any) {
    return {
      notificationId: item.notificationId.toString(),
      userId: item.userId.toString(),
      type: item.type,
      title: item.title,
      body: item.body,
      data: item.data,
      idempotencyKey: item.idempotencyKey,
      readAt: item.readAt,
      createdAt: item.createdAt,
    };
  }

  /**
   * 7. Lay danh sach thong bao cua user (phan trang)
   */
  async getNotifications(userId: string | number | bigint, query: QueryNotificationsDto) {
    const targetUserId = BigInt(userId);
    const res = await this.repo.findMany(targetUserId, {
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      success: true,
      data: res.items.map((item) => this.formatNotification(item)),
      unreadCount: res.unreadCount,
      pagination: {
        page: res.page,
        pageSize: res.pageSize,
        total: res.total,
        totalPages: Math.ceil(res.total / res.pageSize) || 1,
      },
    };
  }

  /**
   * 8. Lay so luong thong bao chua doc
   */
  async getUnreadCount(userId: string | number | bigint) {
    const targetUserId = BigInt(userId);
    const unreadCount = await this.repo.getUnreadCount(targetUserId);
    return {
      success: true,
      data: {
        unreadCount,
      },
    };
  }

  /**
   * 9. Danh dau mot thong bao la da doc (BOLA protected)
   */
  async markAsRead(notificationId: string | number | bigint, userId: string | number | bigint) {
    const notifId = BigInt(notificationId);
    const targetUserId = BigInt(userId);
    const updated = await this.repo.markAsRead(notifId, targetUserId);
    return {
      success: true,
      message: 'Đã đánh dấu thông báo là đã đọc',
      data: this.formatNotification(updated),
    };
  }

  /**
   * 10. Danh dau tat ca thong bao la da doc
   */
  async markAllAsRead(userId: string | number | bigint) {
    const targetUserId = BigInt(userId);
    const res = await this.repo.markAllAsRead(targetUserId);
    return {
      success: true,
      message: 'Đã đánh dấu tất cả thông báo là đã đọc',
      data: {
        updatedCount: res.updatedCount,
      },
    };
  }

  /**
   * 11. Tao va phat thong bao (DB History + FCM Push)
   */
  async createAndDispatchNotification(params: {
    userId: bigint | number;
    type: string;
    title: string;
    body: string;
    data?: any;
    idempotencyKey: string;
  }) {
    const targetUserId = BigInt(params.userId);
    // 1. Luu lich su thong bao voi idempotency key
    const record = await this.repo.createNotification({
      userId: targetUserId,
      type: params.type,
      title: params.title,
      body: params.body,
      data: params.data,
      idempotencyKey: params.idempotencyKey,
    });

    // 2. Gui FCM Push notification
    this.sendPushToUser(targetUserId, {
      title: params.title,
      body: params.body,
      data: params.data ? Object.fromEntries(
        Object.entries(params.data).map(([k, v]) => [k, String(v)])
      ) : undefined,
    }).catch((err) => {
      this.logger.error(`[NotificationsService] Failed to dispatch push for user ${targetUserId}: ${err.message}`);
    });

    return record ? this.formatNotification(record) : null;
  }
}
