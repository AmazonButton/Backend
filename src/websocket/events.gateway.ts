import * as crypto from 'crypto';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { TokenBlacklist } from '../auth/token-blacklist';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
      : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:4173', 'https://smartorder.vn'],
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);
  constructor(@Optional() private readonly prisma?: PrismaService) {}
  private readonly jwtService = new JwtService({
    secret: process.env.JWT_SECRET || 'sob_jwt_secret_dev_2026',
  });

  async handleConnection(client: Socket) {
    try {
      const authHeader =
        client.handshake.headers?.authorization ||
        client.handshake.auth?.token ||
        (client.handshake.query?.token as string);

      let token = '';
      if (typeof authHeader === 'string') {
        token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
      }

      await this.authenticateSocket(client, token);
    } catch (err: any) {
      this.logger.warn(`⚠️ [WS] Fallback to guest connection for socket ${client.id}: ${err.message}`);
      client.join('public');
      client.join('storefront');
    }
  }

  async authenticateSocket(client: Socket, token: string) {
    client.join('public');
    client.join('storefront');

    if (!token) {
      this.logger.log(`⚡ [WS] Guest/Storefront socket connected: ${client.id}`);
      return;
    }

    try {
      const secret = process.env.JWT_SECRET || 'sob_jwt_secret_dev_2026';
      const payload: any = this.jwtService.verify(token, { secret });
      if (!payload || !payload.userId) {
        this.logger.warn(`⚠️ [WS] Invalid token payload for socket: ${client.id}`);
        return;
      }

      // 1. Check if token is in blacklist
      if (this.prisma) {
        const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
        const dbRevoked = await this.prisma.revokedToken.findUnique({
          where: { tokenHash },
        });
        if (dbRevoked) {
          this.logger.warn(`⚠️ [WS] Token found in PostgreSQL revoked_tokens for socket: ${client.id}`);
          return;
        }
      }

      // Check in-memory blacklist
      const isRevoked = TokenBlacklist.isRevoked(payload.userId, payload.iat, token);
      if (isRevoked) {
        this.logger.warn(`⚠️ [WS] Token revoked in memory for socket: ${client.id}`);
        return;
      }

      // 2. Query user to verify ACTIVE status and passwordChangedAt
      const dbUser = this.prisma
        ? await this.prisma.user.findUnique({
            where: { userId: BigInt(payload.userId) },
            select: { status: true, passwordChangedAt: true },
          })
        : null;

      if (this.prisma && (!dbUser || dbUser.status !== 'ACTIVE')) {
        this.logger.warn(`⚠️ [WS] Inactive or non-existent user for socket: ${client.id}`);
        return;
      }

      if (dbUser?.passwordChangedAt && payload.iat) {
        const pwTimeSec = Math.floor(dbUser.passwordChangedAt.getTime() / 1000);
        if (payload.iat < pwTimeSec) {
          this.logger.warn(`⚠️ [WS] Token invalidated by password change for socket: ${client.id}`);
          return;
        }
      }

      client.data.user = {
        userId: payload.userId?.toString(),
        role: payload.role,
        storeId: payload.storeId ? payload.storeId.toString() : null,
        customerId: payload.customerProfileId ? payload.customerProfileId.toString() : null,
      };

      // Auto-join personal rooms
      client.join(`user:${payload.userId}`);
      client.join(`user_${payload.userId}`);
      client.join(`driver:${payload.userId}`);
      if (payload.storeId) {
        client.join(`store_${payload.storeId}`);
        client.join(`store:${payload.storeId}`);
      }
      if (payload.customerProfileId) {
        client.join(`customer_${payload.customerProfileId}`);
        client.join(`customer:${payload.customerProfileId}`);
      }
      if (payload.role === 'SUPER_ADMIN' || payload.role === 'SYSTEM_ADMIN' || payload.role === 'ADMIN') {
        client.join('admin');
      }

      // Automatically join all stores owned or staffed by this user
      if (this.prisma && payload.userId) {
        try {
          const userStores = await this.prisma.user.findUnique({
            where: { userId: BigInt(payload.userId) },
            select: {
              ownedStores: { select: { storeId: true } },
              storeStaffs: { select: { storeId: true } },
            },
          });
          if (userStores) {
            for (const s of userStores.ownedStores) {
              client.join(`store_${s.storeId}`);
              client.join(`store:${s.storeId}`);
              this.logger.log(`🔌 [WS] User ${payload.userId} joined owned store_${s.storeId}`);
            }
            for (const s of userStores.storeStaffs) {
              client.join(`store_${s.storeId}`);
              client.join(`store:${s.storeId}`);
              this.logger.log(`🔌 [WS] User ${payload.userId} joined staff store_${s.storeId}`);
            }
          }
        } catch (err: any) {
          this.logger.warn(`Failed to auto-join store rooms: ${err.message}`);
        }
      }

      this.logger.log(
        `⚡ [WS] Authenticated socket connected: ${client.id} (User: ${payload.userId}, Role: ${payload.role}${
          payload.storeId ? ', Store: ' + payload.storeId : ''
        })`,
      );
      client.emit('authenticated', { success: true, user: client.data.user });
    } catch (err: any) {
      this.logger.warn(`⚠️ [WS] Token verification failed for socket ${client.id}: ${err.message}`);
    }
  }

  @SubscribeMessage('authenticate')
  async handleClientAuth(client: Socket, data: { token: string }) {
    const token = typeof data === 'string' ? data : data?.token;
    if (token) {
      await this.authenticateSocket(client, token);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`❌ [WS] Socket disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe:store')
  handleSubscribeStore(client: Socket, storeId: string) {
    if (!storeId) return;
    const user = client.data?.user;
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Vui lòng xác thực trước khi tham gia room cửa hàng' });
      return;
    }

    const cleanStoreId = storeId.toString().trim();
    const isStoreStaff = Boolean(user.storeId && user.storeId.toString() === cleanStoreId);

    if (isStoreStaff) {
      client.join(`store_${cleanStoreId}`);
      client.join(`store:${cleanStoreId}`);
      this.logger.log(`🔌 Socket ${client.id} (Store: ${user.storeId}) joined store_${cleanStoreId}`);
    } else {
      this.logger.warn(`⛔ [WS] Socket ${client.id} (role: ${user.role}) denied access to store_${cleanStoreId}`);
      client.emit('error', { code: 'FORBIDDEN', message: 'Bạn không có quyền truy cập kênh của cửa hàng này' });
    }
  }

  @SubscribeMessage('subscribe:customer')
  handleSubscribeCustomer(client: Socket, customerId: string) {
    const user = client.data?.user;
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Vui lòng xác thực trước khi tham gia room khách hàng' });
      return;
    }

    // Only this specific customer can subscribe to their personal order tracking channel
    const isCustomer = user.role === 'CUSTOMER' && Boolean(user.customerId && user.customerId.toString() === customerId?.toString());

    if (isCustomer) {
      client.join(`customer_${customerId}`);
      client.join(`customer:${customerId}`);
      this.logger.log(`🔌 Socket ${client.id} (Customer: ${user.customerId}) joined customer_${customerId}`);
    } else {
      this.logger.warn(`⛔ [WS] Socket ${client.id} (role: ${user.role}) denied access to customer_${customerId}`);
      client.emit('error', { code: 'FORBIDDEN', message: 'Bạn không có quyền truy cập kênh của khách hàng này' });
    }
  }

  emitToAdmin(event: string, payload: any) {
    if (this.server) {
      this.server.to('admin').emit(event, payload);
      this.logger.log(`📢 [WS -> Admin] ${event}`);
    }
  }

  emitToStore(storeId: string, event: string, payload: any) {
    if (this.server) {
      this.server.to(`store_${storeId}`).to(`store:${storeId}`).emit(event, payload);
      this.logger.log(`📢 [WS -> Store ${storeId}] ${event}`);
    }
  }

  emitToUser(userId: string, event: string, payload: any) {
    if (this.server) {
      this.server.to(`user:${userId}`).to(`user_${userId}`).emit(event, payload);
      this.logger.log(`📢 [WS -> User ${userId}] ${event}`);
    }
  }

  emitToDriver(driverId: string, event: string, payload: any) {
    if (this.server) {
      this.server.to(`driver:${driverId}`).to(`user:${driverId}`).emit(event, payload);
      this.logger.log(`📢 [WS -> Driver ${driverId}] ${event}`);
    }
  }

  emitToCustomer(customerId: string, event: string, payload: any) {
    if (this.server) {
      this.server.to(`customer_${customerId}`).to(`customer:${customerId}`).emit(event, payload);
      this.logger.log(`📢 [WS -> Customer ${customerId}] ${event}`);
    }
  }

  emitGlobal(event: string, payload: any) {
    if (this.server) {
      this.server.emit(event, payload);
    }
  }

  emitDeviceEvent(storeId: string | null, customerId: string | null, event: string, payload: any) {
    if (storeId) {
      this.emitToStore(storeId, event, payload);
    }
    if (customerId) {
      this.emitToCustomer(customerId, event, payload);
    }
  }
}
