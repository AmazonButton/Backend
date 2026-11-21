import * as crypto from 'crypto';
import Redis from 'ioredis';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { TokenBlacklist } from '../auth/token-blacklist';
import {
  ADMIN_GOVERNANCE_ROLES,
  isTokenInvalidatedByTimestamps,
  resolveAuthority,
} from '../auth/authority.policy';

export const WS_AUTH_REVOKE_CHANNEL = 'ws:auth:revoke';

export interface WsRevocationPubSubTransport {
  publish(channel: string, payload: string): Promise<void> | void;
  subscribe(channel: string, onMessage: (payload: string) => void): Promise<void> | void;
  close?(): Promise<void> | void;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'test') {
      return 'ci_test_jwt_secret_key_minimum_32_characters_long_for_security!';
    }
    throw new Error('FATAL: JWT_SECRET environment variable is required and must not be empty');
  }
  return secret;
}

@Injectable()
@WebSocketGateway({
  cors: {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
      : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:4173', 'https://smartorder.vn'],
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private readonly instanceId = crypto.randomUUID();
  private readonly localUserSockets = new Map<string, Set<Socket>>();
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;
  private customPubSub: WsRevocationPubSubTransport | null = null;
  private watermarkTimer: NodeJS.Timeout | null = null;

  constructor(@Optional() private readonly prisma?: PrismaService) { }
  private readonly jwtService = new JwtService({
    secret: getJwtSecret(),
  });

  async onModuleInit() {
    await this.initRedisPubSub();
    if (this.prisma && !this.watermarkTimer) {
      this.watermarkTimer = setInterval(() => {
        this.enforceActiveSocketsWatermark().catch(() => { });
      }, 30_000);
      this.watermarkTimer.unref();
    }
  }

  async onModuleDestroy() {
    if (this.watermarkTimer) {
      clearInterval(this.watermarkTimer);
      this.watermarkTimer = null;
    }
    if (this.customPubSub?.close) {
      await Promise.resolve(this.customPubSub.close()).catch(() => { });
    }
    if (this.subClient) {
      try {
        await this.subClient.unsubscribe(WS_AUTH_REVOKE_CHANNEL);
        await this.subClient.quit();
      } catch {
        try {
          this.subClient.disconnect();
        } catch { }
      }
      this.subClient = null;
    }
    if (this.pubClient) {
      try {
        await this.pubClient.quit();
      } catch {
        try {
          this.pubClient.disconnect();
        } catch { }
      }
      this.pubClient = null;
    }
  }

  async attachPubSubTransport(transport: WsRevocationPubSubTransport) {
    this.customPubSub = transport;
    await Promise.resolve(
      transport.subscribe(WS_AUTH_REVOKE_CHANNEL, (payload) => {
        this.handleRemoteRevocationMessage(payload);
      }),
    );
  }

  private async initRedisPubSub() {
    if (this.customPubSub) return;
    const rawRedisUrl = process.env.REDIS_URL || process.env.REDIS_CACHE_URL || process.env.REDIS_HOST;
    if (!rawRedisUrl || process.env.DISABLE_REDIS === 'true') {
      this.logger.log('EventsGateway WebSocket revocation operating in local-only mode (no REDIS_URL).');
      return;
    }

    try {
      const redisOpts = {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        connectTimeout: 2000,
        retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 100, 1000)),
      };

      this.pubClient = new Redis(rawRedisUrl, redisOpts);
      this.subClient = new Redis(rawRedisUrl, redisOpts);

      this.pubClient.on('error', (err) => {
        this.logger.warn(`⚠️ [WS Pub] Redis error: ${err.message}`);
      });
      this.subClient.on('error', (err) => {
        this.logger.warn(`⚠️ [WS Sub] Redis error: ${err.message}`);
      });

      this.subClient.on('message', (channel, message) => {
        if (channel === WS_AUTH_REVOKE_CHANNEL) {
          this.handleRemoteRevocationMessage(message);
        }
      });

      await Promise.race([
        Promise.all([
          this.pubClient.ping(),
          this.subClient.subscribe(WS_AUTH_REVOKE_CHANNEL),
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis WS pubsub timeout')), 2000)),
      ]);

      this.logger.log(`⚡ [WS Pub/Sub] Distributed revocation channel '${WS_AUTH_REVOKE_CHANNEL}' active.`);
    } catch (err: any) {
      this.logger.warn(`⚠️ [WS Pub/Sub] Failed initializing Redis adapter channel: ${err?.message}. Falling back cleanly.`);
      if (this.subClient) {
        try {
          this.subClient.disconnect();
        } catch { }
        this.subClient = null;
      }
      if (this.pubClient) {
        try {
          this.pubClient.disconnect();
        } catch { }
        this.pubClient = null;
      }
    }
  }

  private handleRemoteRevocationMessage(raw: string) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed?.userId || parsed.originInstanceId === this.instanceId) {
        return;
      }
      this.disconnectLocalUserSockets(
        parsed.userId.toString(),
        parsed.reason || 'Quyền truy cập hoặc phiên đăng nhập đã bị thu hồi',
      );
    } catch (err: any) {
      this.logger.warn(`⚠️ [WS Pub/Sub] Malformed revocation payload: ${err?.message}`);
    }
  }

  async handleConnection(client: Socket) {
    try {
      // Security: Only accept token via Authorization header or Socket.IO handshake.auth
      // Query parameters are strictly rejected to prevent tokens appearing in access/proxy logs
      const authHeader =
        client.handshake.headers?.authorization ||
        client.handshake.auth?.token;

      let token = '';
      if (typeof authHeader === 'string') {
        token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
      }

      if (!token) {
        this.logger.warn(`⚠️ [WS] Rejecting unauthenticated socket connection: ${client.id}`);
        client.disconnect(true);
        return;
      }

      const secret = getJwtSecret();
      const payload: any = this.jwtService.verify(token, { secret });
      if (!payload || !payload.userId) {
        this.logger.warn(`⚠️ [WS] Invalid token payload for socket: ${client.id}`);
        client.disconnect(true);
        return;
      }

      // 1. Check if token is in blacklist (multi-instance PostgreSQL + in-memory fallback)
      if (this.prisma) {
        const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
        const dbRevoked = await this.prisma.revokedToken.findUnique({
          where: { tokenHash },
        });
        if (dbRevoked) {
          this.logger.warn(`⚠️ [WS] Token found in PostgreSQL revoked_tokens for socket: ${client.id}`);
          client.disconnect(true);
          return;
        }
      }

      // Check in-memory blacklist with correct parameter order: (userId, iat, rawToken)
      const isRevoked = TokenBlacklist.isRevoked(payload.userId, payload.iat, token);
      if (isRevoked) {
        this.logger.warn(`⚠️ [WS] Token revoked in memory for socket: ${client.id}`);
        client.disconnect(true);
        return;
      }

      // 2. Query user to verify ACTIVE status, revocation timestamps & current DB authority
      const dbUser = this.prisma
        ? await this.prisma.user.findUnique({
          where: { userId: BigInt(payload.userId) },
          include: {
            customerProfile: { select: { customerId: true } },
            ownedStores: { select: { storeId: true, status: true } },
            storeStaffs: { where: { status: 'ACTIVE' }, include: { role: true } },
            platformMemberships: { where: { status: 'ACTIVE' }, include: { role: true } },
          },
        })
        : null;

      if (this.prisma && (!dbUser || dbUser.status !== 'ACTIVE')) {
        this.logger.warn(`⚠️ [WS] Inactive or non-existent user for socket: ${client.id}`);
        client.disconnect(true);
        return;
      }

      if (
        dbUser &&
        isTokenInvalidatedByTimestamps(payload.iat, dbUser.passwordChangedAt, dbUser.tokensInvalidBefore)
      ) {
        this.logger.warn(`⚠️ [WS] Token invalidated by password/role revocation for socket: ${client.id}`);
        client.disconnect(true);
        return;
      }

      const authority = dbUser
        ? resolveAuthority(dbUser)
        : {
          role: payload.role,
          storeId: payload.storeId ? payload.storeId.toString() : null,
          platformRole: null,
        };

      client.data.user = {
        userId: payload.userId?.toString(),
        role: authority.role,
        storeId: authority.storeId,
        customerId: dbUser?.customerProfile?.customerId
          ? dbUser.customerProfile.customerId.toString()
          : payload.customerProfileId
            ? payload.customerProfileId.toString()
            : null,
      };

      // Auto-join personal identity rooms
      client.join(`user:${payload.userId}`);
      client.join(`user_${payload.userId}`);

      if ((ADMIN_GOVERNANCE_ROLES as readonly string[]).includes(authority.role)) {
        client.join('admin');
        client.join(`role:${authority.role}`);
        client.join('devices:ops');
      } else if (authority.role === 'SYSTEM_STAFF') {
        // SYSTEM_STAFF joins dedicated hardware/warranty operational rooms only (never 'admin' room)
        client.join('system_staff');
        client.join('role:SYSTEM_STAFF');
        client.join('devices:ops');
      }

      const targetStoreIds = new Set<string>();

      // Only active Store Owners auto-join store rooms (legacy store_staff membership removed)
      if (dbUser && authority.role === 'STORE_OWNER') {
        for (const s of dbUser.ownedStores || []) {
          if (s.status === 'ACTIVE') {
            targetStoreIds.add(s.storeId.toString());
          }
        }
        if (authority.storeId && !targetStoreIds.has(authority.storeId)) {
          client.data.user.storeId = null;
        }
      } else if (!this.prisma && authority.storeId) {
        targetStoreIds.add(authority.storeId);
      }

      for (const sId of targetStoreIds) {
        client.join(`store_${sId}`);
        client.join(`store:${sId}`);
      }

      if (payload.customerProfileId) {
        client.join(`customer_${payload.customerProfileId}`);
        client.join(`customer:${payload.customerProfileId}`);
      }

      // Schedule disconnect timer when token expires (check before registering active socket)
      if (payload.exp) {
        const expiresInMs = payload.exp * 1000 - Date.now();
        if (expiresInMs <= 0) {
          this.logger.warn(`⚠️ [WS] Token already expired for socket: ${client.id}`);
          client.disconnect(true);
          return;
        }
        const timer = setTimeout(() => {
          this.logger.warn(`⚠️ [WS] Token expired for socket: ${client.id}, disconnecting`);
          client.emit('auth:expired', { message: 'Phiên kết nối đã hết hạn, vui lòng kết nối lại' });
          client.disconnect(true);
        }, Math.min(expiresInMs, 2147483647));
        client.data.disconnectTimer = timer;
      }

      const userIdStr = payload.userId?.toString();
      client.data.tokenIat = typeof payload.iat === 'number' ? payload.iat : null;
      if (userIdStr) {
        let userSet = this.localUserSockets.get(userIdStr);
        if (!userSet) {
          userSet = new Set();
          this.localUserSockets.set(userIdStr, userSet);
        }
        userSet.add(client);
      }

      this.logger.log(`⚡ [WS] Authenticated socket connected: ${client.id} (User: ${payload.userId}, Role: ${authority.role})`);
    } catch (err: any) {
      this.logger.warn(`⚠️ [WS] Authentication failed for socket ${client.id}: ${err.message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    if (client.data?.disconnectTimer) {
      clearTimeout(client.data.disconnectTimer);
    }
    const userIdStr = client.data?.user?.userId?.toString();
    if (userIdStr) {
      const userSet = this.localUserSockets.get(userIdStr);
      if (userSet) {
        userSet.delete(client);
        if (userSet.size === 0) {
          this.localUserSockets.delete(userIdStr);
        }
      }
    }
    this.logger.log(`❌ [WS] Socket disconnected: ${client.id}`);
  }

  private async verifySocketNotRevoked(client: Socket): Promise<boolean> {
    if (!this.prisma || !client.data?.user?.userId) return true;
    try {
      const uId = BigInt(client.data.user.userId);
      const dbUser = await this.prisma.user.findUnique({
        where: { userId: uId },
        select: { userId: true, status: true, passwordChangedAt: true, tokensInvalidBefore: true },
      });
      if (
        !dbUser ||
        dbUser.status !== 'ACTIVE' ||
        isTokenInvalidatedByTimestamps(client.data.tokenIat, dbUser.passwordChangedAt, dbUser.tokensInvalidBefore)
      ) {
        client.emit('auth:revoked', { message: 'Quyền truy cập hoặc phiên đăng nhập đã bị thu hồi' });
        client.disconnect(true);
        return false;
      }
      return true;
    } catch (err: any) {
      const rawMsg = typeof err?.message === 'string' ? err.message : 'Database verification unavailable';
      const sanitizedMsg = rawMsg
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT_REDACTED]')
        .replace(/((?:bearer|authorization|token|password|secret)[\s=:]+)[^\s,;]+/gi, '$1[REDACTED]')
        .slice(0, 200);
      this.logger.error(
        `⛔ [WS] Failed checking session validity for socket ${client.id} (User: ${client.data?.user?.userId}): ${sanitizedMsg}`,
      );
      client.emit('error', {
        code: 'SESSION_VALIDATION_UNAVAILABLE',
        message: 'Không thể kiểm tra hiệu lực phiên kết nối lúc này. Vui lòng thử lại hoặc kết nối lại.',
      });
      client.disconnect(true);
      return false;
    }
  }

  async enforceActiveSocketsWatermark(): Promise<number> {
    if (!this.prisma || this.localUserSockets.size === 0) return 0;
    const userIds: bigint[] = [];
    for (const id of this.localUserSockets.keys()) {
      try {
        userIds.push(BigInt(id));
      } catch { }
    }
    if (userIds.length === 0) return 0;

    let users: any[] = [];
    try {
      users = await this.prisma.user.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, status: true, passwordChangedAt: true, tokensInvalidBefore: true },
      });
    } catch (err: any) {
      const sanitizedMsg = (typeof err?.message === 'string' ? err.message : 'DB query failed').slice(0, 200);
      this.logger.warn(`⚠️ [WS] Watermark sweep skipped due to DB query failure: ${sanitizedMsg}`);
      return 0;
    }
    const byId = new Map(users.map((u: any) => [u.userId.toString(), u]));
    let disconnected = 0;

    for (const [uId, sockets] of this.localUserSockets.entries()) {
      const dbUser: any = byId.get(uId);
      for (const sock of Array.from(sockets)) {
        const revoked =
          !dbUser ||
          dbUser.status !== 'ACTIVE' ||
          isTokenInvalidatedByTimestamps(sock.data?.tokenIat, dbUser.passwordChangedAt, dbUser.tokensInvalidBefore);
        if (revoked) {
          try {
            sock.emit('auth:revoked', { message: 'Phiên kết nối đã hết hiệu lực do thu hồi quyền hoặc khóa tài khoản' });
            sock.disconnect(true);
            disconnected++;
          } catch { }
          sockets.delete(sock);
        }
      }
      if (sockets.size === 0) {
        this.localUserSockets.delete(uId);
      }
    }

    return disconnected;
  }

  @SubscribeMessage('subscribe:store')
  async handleSubscribeStore(client: Socket, storeId: string) {
    const user = client.data?.user;
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Vui lòng xác thực trước khi tham gia room' });
      return;
    }
    if (!(await this.verifySocketNotRevoked(client))) return;

    const isSuperAdmin = user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN';
    let isAuthorized = isSuperAdmin;

    if (!isAuthorized && this.prisma && storeId) {
      try {
        const uId = BigInt(user.userId);
        const sId = BigInt(storeId);
        const owned = await this.prisma.store.findFirst({
          where: { storeId: sId, ownerUserId: uId, status: 'ACTIVE' },
          select: { storeId: true },
        });
        if (owned) {
          isAuthorized = true;
        }
      } catch (err: any) {
        this.logger.warn(`⚠️ [WS] Error verifying store authority: ${err.message}`);
      }
    } else if (!isAuthorized && !this.prisma) {
      isAuthorized = user.storeId && user.storeId.toString() === storeId?.toString();
    }

    if (isAuthorized) {
      client.join(`store_${storeId}`);
      client.join(`store:${storeId}`);
      this.logger.log(`🔌 Socket ${client.id} joined store_${storeId} and store:${storeId}`);
    } else {
      this.logger.warn(`⛔ [WS] Socket ${client.id} denied access to store_${storeId}`);
      client.emit('error', { code: 'FORBIDDEN', message: 'Bạn không có quyền truy cập kênh của cửa hàng này' });
    }
  }

  @SubscribeMessage('subscribe:customer')
  async handleSubscribeCustomer(client: Socket, customerId: string) {
    const user = client.data?.user;
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Vui lòng xác thực trước khi tham gia room' });
      return;
    }
    if (!(await this.verifySocketNotRevoked(client))) return;

    const isSuperAdmin = user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN';
    let isAuthorized = isSuperAdmin;

    if (!isAuthorized && this.prisma && customerId) {
      try {
        const uId = BigInt(user.userId);
        const cId = BigInt(customerId);
        const profile = await this.prisma.customerProfile.findFirst({
          where: { customerId: cId, userId: uId },
          select: { customerId: true },
        });
        if (profile) {
          isAuthorized = true;
        }
      } catch (err: any) {
        this.logger.warn(`⚠️ [WS] Error verifying customer authority: ${err.message}`);
      }
    } else if (!isAuthorized && !this.prisma) {
      isAuthorized = user.customerId && user.customerId.toString() === customerId?.toString();
    }

    if (isAuthorized) {
      client.join(`customer_${customerId}`);
      this.logger.log(`🔌 Socket ${client.id} joined customer_${customerId}`);
    } else {
      this.logger.warn(`⛔ [WS] Socket ${client.id} denied access to customer_${customerId}`);
      client.emit('error', { code: 'FORBIDDEN', message: 'Bạn không có quyền truy cập kênh của khách hàng này' });
    }
  }

  emitToStore(storeId: string, event: string, payload: any) {
    if (this.server) {
      this.server.to(`store_${storeId}`).emit(event, payload);
      this.server.to(`store:${storeId}`).emit(event, payload);
      this.logger.log(`📢 [WS -> Store ${storeId}] ${event}`);
    }
  }

  emitToDriver(driverId: string, event: string, payload: any) {
    if (this.server) {
      this.server.to(`driver:${driverId}`).emit(event, payload);
      this.server.to(`user:${driverId}`).emit(event, payload);
      this.logger.log(`📢 [WS -> Driver ${driverId}] ${event}`);
    }
  }

  emitToUser(userId: string, event: string, payload: any) {
    if (this.server) {
      this.server.to(`user:${userId}`).emit(event, payload);
      this.server.to(`user_${userId}`).emit(event, payload);
      this.logger.log(`📢 [WS -> User ${userId}] ${event}`);
    }
  }

  emitToCustomer(customerId: string, event: string, payload: any) {
    if (this.server) {
      this.server.to(`customer_${customerId}`).emit(event, payload);
      this.logger.log(`📢 [WS -> Customer ${customerId}] ${event}`);
    }
  }

  emitToAdmin(event: string, payload: any) {
    if (this.server) {
      this.server.to('admin').emit(event, payload);
      this.logger.log(`📢 [WS -> Admin] ${event}`);
    }
  }

  emitToSystemStaff(event: string, payload: any) {
    if (this.server) {
      this.server.to('system_staff').emit(event, payload);
      this.logger.log(`📢 [WS -> SystemStaff] ${event}`);
    }
  }

  emitToHardwareOps(event: string, payload: any) {
    if (this.server) {
      this.server.to('devices:ops').emit(event, payload);
      this.logger.log(`📢 [WS -> HardwareOps] ${event}`);
    }
  }

  disconnectLocalUserSockets(userId: string, reason = 'Quyền truy cập hoặc phiên đăng nhập đã bị thu hồi') {
    if (!userId) return;
    try {
      const tracked = this.localUserSockets.get(userId);
      if (tracked && tracked.size > 0) {
        for (const sock of Array.from(tracked)) {
          try {
            sock.emit('auth:revoked', { message: reason });
            sock.disconnect(true);
          } catch { }
        }
        this.localUserSockets.delete(userId);
      }

      if (this.server) {
        this.server.to(`user:${userId}`).emit('auth:revoked', { message: reason });
        if (typeof (this.server as any).in === 'function') {
          (this.server as any).in(`user:${userId}`).disconnectSockets(true);
        }
      }
      this.logger.log(`🔌 [WS:${this.instanceId.slice(0, 8)}] Disconnected active sockets for user ${userId}`);
    } catch (err: any) {
      this.logger.warn(`⚠️ [WS] Failed disconnecting local sockets for user ${userId}: ${err?.message}`);
    }
  }

  async disconnectUserSockets(userId: string, reason = 'Quyền truy cập hoặc phiên đăng nhập đã bị thu hồi') {
    if (!userId) return;
    this.disconnectLocalUserSockets(userId, reason);

    const payload = JSON.stringify({
      originInstanceId: this.instanceId,
      userId: userId.toString(),
      reason,
      revokedAtMs: Date.now(),
    });

    try {
      if (this.customPubSub) {
        await Promise.resolve(this.customPubSub.publish(WS_AUTH_REVOKE_CHANNEL, payload));
      } else if (this.pubClient) {
        await this.pubClient.publish(WS_AUTH_REVOKE_CHANNEL, payload);
      }
    } catch (err: any) {
      this.logger.warn(`⚠️ [WS Pub/Sub] Failed broadcasting revocation for user ${userId}: ${err?.message}`);
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
