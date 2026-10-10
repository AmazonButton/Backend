import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

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
  private readonly jwtService = new JwtService({
    secret: process.env.JWT_SECRET || 'sob_jwt_secret_dev_2026',
  });

  async handleConnection(client: Socket) {
    try {
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

      const secret = process.env.JWT_SECRET || 'sob_jwt_secret_dev_2026';
      const payload: any = this.jwtService.verify(token, { secret });
      if (!payload || !payload.userId) {
        this.logger.warn(`⚠️ [WS] Invalid token payload for socket: ${client.id}`);
        client.disconnect(true);
        return;
      }

      client.data.user = {
        userId: payload.userId?.toString(),
        role: payload.role,
        storeId: payload.storeId ? payload.storeId.toString() : null,
        customerId: payload.customerProfileId ? payload.customerProfileId.toString() : null,
      };

      this.logger.log(`⚡ [WS] Authenticated socket connected: ${client.id} (User: ${payload.userId}, Role: ${payload.role})`);
    } catch (err: any) {
      this.logger.warn(`⚠️ [WS] Authentication failed for socket ${client.id}: ${err.message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`❌ [WS] Socket disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe:store')
  handleSubscribeStore(client: Socket, storeId: string) {
    const user = client.data?.user;
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Vui lòng xác thực trước khi tham gia room' });
      return;
    }

    const isSuperAdmin = user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN';
    const isStoreStaff = user.storeId && user.storeId.toString() === storeId?.toString();

    if (isSuperAdmin || isStoreStaff) {
      client.join(`store_${storeId}`);
      this.logger.log(`🔌 Socket ${client.id} joined store_${storeId}`);
    } else {
      this.logger.warn(`⛔ [WS] Socket ${client.id} denied access to store_${storeId}`);
      client.emit('error', { code: 'FORBIDDEN', message: 'Bạn không có quyền truy cập kênh của cửa hàng này' });
    }
  }

  @SubscribeMessage('subscribe:customer')
  handleSubscribeCustomer(client: Socket, customerId: string) {
    const user = client.data?.user;
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Vui lòng xác thực trước khi tham gia room' });
      return;
    }

    const isSuperAdmin = user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN';
    const isCustomer = user.customerId && user.customerId.toString() === customerId?.toString();

    if (isSuperAdmin || isCustomer) {
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
      this.logger.log(`📢 [WS -> Store ${storeId}] ${event}`);
    }
  }

  emitToCustomer(customerId: string, event: string, payload: any) {
    if (this.server) {
      this.server.to(`customer_${customerId}`).emit(event, payload);
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
