import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable } from '@nestjs/common';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    console.log(`⚡ [NestJS Socket.io] Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`❌ [NestJS Socket.io] Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe:store')
  handleSubscribeStore(client: Socket, storeId: string) {
    if (storeId) {
      client.join(`store_${storeId}`);
      console.log(`🔌 Socket ${client.id} joined store_${storeId}`);
    }
  }

  @SubscribeMessage('subscribe:customer')
  handleSubscribeCustomer(client: Socket, customerId: string) {
    if (customerId) {
      client.join(`customer_${customerId}`);
      console.log(`🔌 Socket ${client.id} joined customer_${customerId}`);
    }
  }

  emitToStore(storeId: string, event: string, payload: any) {
    if (this.server) {
      this.server.to(`store_${storeId}`).emit(event, payload);
      console.log(`📢 [WS -> Store ${storeId}] ${event}`);
    }
  }

  emitToCustomer(customerId: string, event: string, payload: any) {
    if (this.server) {
      this.server.to(`customer_${customerId}`).emit(event, payload);
      console.log(`📢 [WS -> Customer ${customerId}] ${event}`);
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
    this.emitGlobal(event, payload);
  }
}
