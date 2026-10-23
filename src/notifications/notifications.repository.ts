import { Injectable, Inject, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findMany(
    userId: bigint,
    pagination: { page?: number; pageSize?: number } = {},
  ) {
    const page = pagination.page && pagination.page > 0 ? Number(pagination.page) : 1;
    const pageSize = pagination.pageSize && pagination.pageSize > 0 ? Math.min(Number(pagination.pageSize), 100) : 20;
    const skip = (page - 1) * pageSize;

    const [items, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      unreadCount,
    };
  }

  async getUnreadCount(userId: bigint): Promise<number> {
    return this.prisma.notification.count({
      where: {
        userId,
        readAt: null,
      },
    });
  }

  async findById(notificationId: bigint) {
    return this.prisma.notification.findUnique({
      where: { notificationId },
    });
  }

  async markAsRead(notificationId: bigint, userId: bigint) {
    const notification = await this.prisma.notification.findUnique({
      where: { notificationId },
    });

    if (!notification) {
      throw new NotFoundException('Không tìm thấy thông báo');
    }

    // BOLA / IDOR Protection: User can only mark their own notification as read
    if (notification.userId !== userId) {
      throw new ForbiddenException('Bạn không có quyền thao tác trên thông báo này');
    }

    if (notification.readAt) {
      return notification; // Already marked as read
    }

    return this.prisma.notification.update({
      where: { notificationId },
      data: {
        readAt: new Date(),
      },
    });
  }

  async markAllAsRead(userId: bigint) {
    const result = await this.prisma.notification.updateMany({
      where: {
        userId,
        readAt: null,
      },
      data: {
        readAt: new Date(),
      },
    });

    return {
      updatedCount: result.count,
    };
  }

  async createNotification(data: {
    userId: bigint;
    type: string;
    title: string;
    body: string;
    data?: any;
    idempotencyKey: string;
  }) {
    const jsonData = data.data ? JSON.stringify(data.data) : null;
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO notifications (user_id, type, title, body, data, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *;`,
      data.userId,
      data.type,
      data.title,
      data.body,
      jsonData,
      data.idempotencyKey,
    );

    if (rows && rows.length > 0) {
      return rows[0];
    }
    return this.prisma.notification.findUnique({
      where: { idempotencyKey: data.idempotencyKey },
    });
  }
}
