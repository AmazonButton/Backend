import { StoreWalletService } from '../store-wallet/store-wallet.service';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { OrdersRepository } from './orders.repository';
import { CryptoService } from '../security/crypto.service';
import { EventsGateway } from '../websocket/events.gateway';
import { toOrderResponseDto } from './dto/order-response.dto';

import { ALLOWED_ORDER_TRANSITIONS } from './dto/update-order-status.dto';
import { DeliverOrderDto } from './dto/deliver-order.dto';
import { DeliveryFailureDto } from './dto/delivery-failure.dto';
import { DriverOrdersQueryDto } from './dto/driver-orders-query.dto';

@Injectable()
export class OrdersService {
  constructor(
    @Inject(OrdersRepository) private readonly ordersRepo: OrdersRepository,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
    @Inject(StoreWalletService) private readonly storeWalletService: StoreWalletService,
  ) {}

  /**
   * Xử lý tín hiệu bấm nút IoT — Gọi Stored Procedure sp_create_order_from_button
   * trong PostgreSQL chống Race-Condition & 2-Phase Commit (BRD-INV-06),
   * có cơ chế Fallback Transaction an toàn qua OrdersRepository.
   */
  async handleButtonEvent(
    device: any,
    eventPayload: {
      eventType: string;
      requestId: string;
      paymentMethod?: string;
      shippingFee?: number;
      battery?: number;
      rssi?: number;
      [key: string]: any;
    },
  ) {
    const { eventType, requestId, paymentMethod = 'COD', shippingFee = 0 } = eventPayload;
    const targetIdentifier = device.deviceId || device.buttonCode || device.id;

    const button = await this.ordersRepo.findButtonByIdentifier(targetIdentifier);

    if (!button) {
      throw new BadRequestException('Nút bấm chưa được đăng ký trong hệ thống');
    }

    if (button.status !== 'ACTIVE') {
      throw new BadRequestException('Nút bấm hiện đang bị tạm dừng hoặc khóa (INACTIVE/LOCKED)');
    }

    if (!button.buttonProducts || button.buttonProducts.length === 0) {
      throw new BadRequestException('Nút bấm chưa được cấu hình sản phẩm đặt hàng');
    }

    let newOrderId: any = null;

    // 1. Cố gắng thực thi qua Stored Procedure PostgreSQL (Atomic với iot_request_id)
    try {
      newOrderId = await this.ordersRepo.executeSpCreateOrder(
        button.buttonId,
        paymentMethod,
        shippingFee,
        requestId ? `Đơn hàng tự động từ nút bấm IoT [REQ:${requestId}]` : 'Đơn hàng tự động từ nút bấm IoT',
        requestId,
      );
    } catch (procErr: any) {
      // Bắt vi phạm Unique Constraint (button_id, iot_request_id) -> Idempotency Safe Hit
      const isUniqueConflict =
        procErr?.code === '23505' ||
        procErr?.meta?.code === '23505' ||
        procErr?.message?.includes('uq_orders_button_request');
      if (isUniqueConflict && requestId) {
        const existingOrder = await this.ordersRepo.findOrderByButtonAndRequestId(button.buttonId, requestId);
        if (existingOrder) {
          return {
            order: toOrderResponseDto(existingOrder),
            isDuplicate: true,
            message: 'Đơn hàng đã được tạo trước đó cho yêu cầu này (Idempotent Hit)',
          };
        }
      }

      // Chỉ fallback khi stored procedure chưa được nạp (mã lỗi 42883 hoặc không tìm thấy function)
      const isMissingProcedure =
        procErr?.meta?.code === '42883' ||
        procErr?.code === '42883';
      if (isMissingProcedure) {
        try {
          newOrderId = await this.ordersRepo.createOrderFallbackTx(button, paymentMethod, shippingFee, requestId);
        } catch (fallbackErr: any) {
          if ((fallbackErr?.code === 'P2002' || fallbackErr?.message?.includes('uq_orders_button_request')) && requestId) {
            const existingOrder = await this.ordersRepo.findOrderByButtonAndRequestId(button.buttonId, requestId);
            if (existingOrder) {
              return {
                order: toOrderResponseDto(existingOrder),
                isDuplicate: true,
                message: 'Đơn hàng đã được tạo trước đó cho yêu cầu này (Idempotent Hit)',
              };
            }
          }
          throw fallbackErr;
        }
      } else {
        // Bảo lưu các lỗi nghiệp vụ từ stored procedure (hết hàng, store không hoạt động, v.v.)
        throw new BadRequestException(procErr.message || 'Lỗi khi tạo đơn hàng');
      }
    }

    if (!newOrderId) {
      throw new BadRequestException('Không thể khởi tạo đơn hàng từ hệ thống');
    }

    // Fetch the created order with full details
    const newOrder = await this.ordersRepo.findOrderById(BigInt(newOrderId));

    const formattedOrder = toOrderResponseDto(newOrder);

    const orderPayload = {
      order: formattedOrder,
      buttonCode: button.buttonCode,
      customerName: (button.customer?.user?.fullName || (button.customer as any)?.fullName || ""),
      storeId: button.storeId.toString(),
      customerId: button.customerId.toString(),
    };

    // Emit Realtime WebSockets to authorized rooms ONLY (no emitGlobal)
    this.eventsGateway.emitToStore(button.storeId.toString(), 'ORDER_CREATED', orderPayload);
    this.eventsGateway.emitToCustomer(button.customerId.toString(), 'ORDER_CREATED', orderPayload);

    return {
      order: formattedOrder,
      isDuplicate: false,
      message: 'Tạo đơn hàng thành công qua hệ thống xử lý IoT Button!',
    };
  }

  /**
   * Mô phỏng tín hiệu bấm nút từ UI để kiểm thử (Sandbox Simulation)
   */
  async simulateButtonPress(body: any, user: any) {
    const targetIdentifier = body.deviceId || body.buttonCode || body.buttonId;
    if (!targetIdentifier) {
      throw new BadRequestException('Thiếu thông tin nhận diện nút (deviceId, buttonCode hoặc buttonId)');
    }

    const button = await this.ordersRepo.findButtonByIdentifier(targetIdentifier.toString());

    if (!button) {
      throw new NotFoundException('Không tìm thấy nút bấm được chỉ định');
    }

    // BOLA Check
    if (user?.role === 'CUSTOMER') {
      if (!user.customerProfileId || button.customerId?.toString() !== user.customerProfileId.toString()) {
        throw new ForbiddenException('Bạn không sở hữu nút bấm này');
      }
    } else if (['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_ORDER', 'STAFF_INVENTORY', 'STAFF_BUTTON', 'STAFF_DELIVERY'].includes(user?.role)) {
      if (!user.storeId || button.storeId?.toString() !== user.storeId.toString()) {
        throw new ForbiddenException('Nút bấm không thuộc quyền quản lý của cửa hàng bạn');
      }
    } else if (!['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user?.role)) {
      throw new ForbiddenException('Không có quyền mô phỏng nút bấm này');
    }

    const result = await this.handleButtonEvent(button, {
      eventType: body.eventType || 'SINGLE_PRESS',
      requestId: body.requestId || `sim_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      paymentMethod: body.paymentMethod || 'COD',
      shippingFee: body.shippingFee || 0,
    });

    return {
      success: true,
      message: 'Mô phỏng bấm nút thành công!',
      data: result,
    };
  }

  /**
   * Đặt hàng nhanh từ App dựa trên Nút bấm
   */
  async quickReorder(user: any, deviceId: string) {
    const button = await this.ordersRepo.findButtonByDeviceId(deviceId);

    if (!button) {
      throw new NotFoundException('Thiết bị không tồn tại');
    }

    if (user.role === 'CUSTOMER') {
      if (!user.customerProfileId) {
        throw new ForbiddenException('Tài khoản khách hàng thiếu hồ sơ định danh');
      }
      if (button.customerId?.toString() !== user.customerProfileId.toString()) {
        throw new ForbiddenException('Thiết bị không thuộc sở hữu của bạn');
      }
    } else if (!['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role)) {
      throw new ForbiddenException('Chỉ khách hàng mới có thể đặt hàng nhanh qua thiết bị');
    }

    const data = await this.handleButtonEvent(button, {
      eventType: 'APP_QUICK_REORDER',
      requestId: `app_req_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    });

    return data;
  }

  async list(user: any, status?: string) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');

    const whereClause: any = {};
    if (user.role === 'CUSTOMER') {
      if (!user.customerProfileId) {
        throw new ForbiddenException('Tài khoản khách hàng thiếu hồ sơ định danh (customerProfileId)');
      }
      whereClause.customerId = BigInt(user.customerProfileId);
    } else if (['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_ORDER', 'STAFF_INVENTORY', 'STAFF_BUTTON', 'STAFF_DELIVERY'].includes(user.role)) {
      if (!user.storeId) {
        throw new ForbiddenException('Tài khoản cửa hàng thiếu thông tin cửa hàng liên kết (storeId)');
      }
      whereClause.storeId = BigInt(user.storeId);
    } else if (['ADMIN', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role)) {
      // Admin may view all orders or filter
    } else {
      throw new ForbiddenException('Không có quyền truy cập danh sách đơn hàng');
    }

    if (status) {
      whereClause.orderStatus = status;
    }

    const orders = await this.ordersRepo.findOrders(whereClause);

    return orders.map((o) => toOrderResponseDto(o));
  }

  async getById(id: string | number | bigint, user?: any) {
    if (typeof id === 'string' && !/^\d+$/.test(id)) {
      throw new NotFoundException('Đơn hàng không tồn tại');
    }
    const targetOrderId = BigInt(id);
    const order = await this.ordersRepo.findOrderById(targetOrderId);

    if (!order) return null;

    // BOLA / IDOR Protection: verify ownership
    if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      const isCustomerOwner = user.customerProfileId && order.customerId === BigInt(user.customerProfileId);
      const isStoreOwner = user.storeId && order.storeId === BigInt(user.storeId);
      if (!isCustomerOwner && !isStoreOwner) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền xem đơn hàng này.',
        });
      }
    }

    return toOrderResponseDto(order);
  }

  async cancelOrder(orderId: string | number | bigint, reason: string = 'Khách hàng hủy đơn', user?: any) {
    const targetOrderId = BigInt(orderId);
    const order = await this.ordersRepo.findOrderById(targetOrderId);

    if (!order) {
      throw new NotFoundException('Đơn hàng không tồn tại');
    }

    if (order.orderStatus === 'CANCELLED') {
      return toOrderResponseDto(order);
    }

    if (!['PENDING', 'CONFIRMED', 'PREPARING', 'PROCESSING'].includes(order.orderStatus)) {
      throw new BadRequestException('Đơn hàng đã được xử lý giao hàng hoặc hoàn tất, không thể hủy');
    }

    // BOLA / IDOR Protection
    if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      const isCustomerOwner = user.customerProfileId && order.customerId === BigInt(user.customerProfileId);
      const isStoreOwner = user.storeId && order.storeId === BigInt(user.storeId);
      if (!isCustomerOwner && !isStoreOwner) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền hủy đơn hàng này.',
        });
      }
    }

    const updated = await this.ordersRepo.cancelOrderAtomicTx(targetOrderId, reason, user?.userId || user?.id);
    const formattedOrder = toOrderResponseDto(updated);
    const cancelPayload = { order: formattedOrder, reason, storeId: order.storeId.toString(), customerId: order.customerId.toString() };
    this.eventsGateway.emitToStore(order.storeId.toString(), 'ORDER_CANCELLED', cancelPayload);
    this.eventsGateway.emitToCustomer(order.customerId.toString(), 'ORDER_CANCELLED', cancelPayload);

    return formattedOrder;
  }

  async updateOrderStatus(orderId: string | number | bigint, newStatus: string, user?: any) {
    const targetOrderId = BigInt(orderId);
    const order = await this.ordersRepo.findOrderById(targetOrderId);

    if (!order) {
      throw new NotFoundException('Đơn hàng không tồn tại');
    }

    if (user) {
      const isSuperAdmin = user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN';
      const isSameStore = user.storeId && order.storeId && user.storeId.toString() === order.storeId.toString();
      if (!isSuperAdmin && !isSameStore) {
        throw new ForbiddenException('Bạn không có quyền cập nhật đơn hàng của cửa hàng khác');
      }
    }

    // Idempotent check: if already at target status, return directly
    if (order.orderStatus === newStatus) {
      return toOrderResponseDto(order);
    }

    // Validate transition graph according to BRD
    const allowedNext = ALLOWED_ORDER_TRANSITIONS[order.orderStatus] || [];
    if (!allowedNext.includes(newStatus)) {
      throw new BadRequestException(
        `Không thể chuyển trạng thái đơn hàng từ ${order.orderStatus} sang ${newStatus}`,
      );
    }

    let updated: any;
    if (newStatus === 'COMPLETED') {
      updated = await this.ordersRepo.completeOrderAtomicTx(targetOrderId);
    } else if (['CANCELLED', 'REJECTED'].includes(newStatus)) {
      updated = await this.ordersRepo.cancelOrderAtomicTx(
        targetOrderId,
        newStatus === 'REJECTED' ? 'Cửa hàng từ chối tiếp nhận đơn' : 'Cập nhật hủy đơn',
        user?.userId || user?.id,
        newStatus as 'CANCELLED' | 'REJECTED',
      );
    } else {
      updated = await this.ordersRepo.transitionOrderStatusAtomicTx(
        targetOrderId,
        newStatus,
        user?.userId || user?.id,
        `Chuyển trạng thái sang ${newStatus}`,
      );
    }

    const formattedOrder = toOrderResponseDto(updated);
    const statusPayload = { order: formattedOrder, storeId: order.storeId.toString(), customerId: order.customerId.toString() };
    this.eventsGateway.emitToStore(order.storeId.toString(), 'ORDER_STATUS_CHANGED', statusPayload);
    this.eventsGateway.emitToCustomer(order.customerId.toString(), 'ORDER_STATUS_CHANGED', statusPayload);

    if (newStatus === 'READY_FOR_DELIVERY') {
      const readyPayload = {
        orderId: formattedOrder.orderId,
        orderCode: formattedOrder.orderCode,
        storeId: formattedOrder.storeId,
        customerName: formattedOrder.customer?.fullName || 'Khách hàng',
        addressDetail: formattedOrder.shippingAddress || '',
        totalAmount: formattedOrder.totalAmount,
        itemCount: formattedOrder.items?.length || 0,
        shippingLatitude: formattedOrder.shippingLatitude,
        shippingLongitude: formattedOrder.shippingLongitude,
      };
      this.eventsGateway.emitToStore(order.storeId.toString(), 'ORDER_READY_FOR_DELIVERY', readyPayload);
    }

    return formattedOrder;
  }


  async claimOrder(orderId: string | number | bigint, user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    if (!['STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role)) {
      throw new ForbiddenException('Chỉ tài xế hoặc quản lý cửa hàng mới có quyền nhận đơn hàng');
    }
    if (!user.storeId && !['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role)) {
      throw new ForbiddenException('Tài khoản thiếu thông tin cửa hàng liên kết (storeId)');
    }

    const targetOrderId = BigInt(orderId);
    const order = await this.ordersRepo.findOrderById(targetOrderId);
    if (!order) {
      throw new NotFoundException('Đơn hàng không tồn tại');
    }

    const storeId = user.storeId ? BigInt(user.storeId) : order.storeId;
    const driverId = BigInt(user.userId || user.id);

    const updated = await this.ordersRepo.claimOrderAtomicTx(targetOrderId, storeId, driverId);
    const formatted = toOrderResponseDto(updated);

    // Emit socket events
    const payload = { order: formatted, storeId: storeId.toString(), driverId: driverId.toString() };
    this.eventsGateway.emitToStore(storeId.toString(), 'ORDER_CLAIMED', payload);
    this.eventsGateway.emitToStore(storeId.toString(), 'ORDER_STATUS_CHANGED', payload);

    return formatted;
  }

  async completeDelivery(orderId: string | number | bigint, dto: DeliverOrderDto, user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    if (!['STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role)) {
      throw new ForbiddenException('Không có quyền hoàn tất đơn giao hàng');
    }

    const targetOrderId = BigInt(orderId);
    const updated = await this.ordersRepo.completeDeliveryAtomicTx(targetOrderId, user, dto);
    const formatted = toOrderResponseDto(updated);

    const payload = { order: formatted, storeId: updated.storeId.toString(), driverId: user.userId || user.id };
    this.eventsGateway.emitToStore(updated.storeId.toString(), 'ORDER_STATUS_CHANGED', payload);
    this.eventsGateway.emitToStore(updated.storeId.toString(), 'ORDER_DELIVERED', payload);
    this.eventsGateway.emitToCustomer(updated.customerId.toString(), 'ORDER_STATUS_CHANGED', payload);

    return formatted;
  }

  async failDelivery(orderId: string | number | bigint, dto: DeliveryFailureDto, user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    if (!['STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role)) {
      throw new ForbiddenException('Không có quyền báo giao hàng thất bại');
    }

    const targetOrderId = BigInt(orderId);
    const updated = await this.ordersRepo.failDeliveryAtomicTx(targetOrderId, user, dto);
    const formatted = toOrderResponseDto(updated);

    const payload = {
      order: formatted,
      reasonCode: dto.failureReasonCode,
      note: dto.failureNote,
      evidenceImageUrl: dto.evidenceImageUrl,
      storeId: updated.storeId.toString(),
      driverId: user.userId || user.id,
    };
    this.eventsGateway.emitToStore(updated.storeId.toString(), 'ORDER_DELIVERY_FAILED', payload);
    this.eventsGateway.emitToStore(updated.storeId.toString(), 'ORDER_STATUS_CHANGED', payload);

    return formatted;
  }

  async getDriverOrders(user: any, query: DriverOrdersQueryDto) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    if (!user.storeId) {
      throw new ForbiddenException('Tài khoản thiếu thông tin cửa hàng liên kết (storeId)');
    }
    const driverId = BigInt(user.userId || user.id);
    const storeId = BigInt(user.storeId);

    const result = await this.ordersRepo.findDriverOrders(driverId, storeId, query);
    return {
      orders: result.orders.map((o: any) => toOrderResponseDto(o)),
      pagination: result.pagination,
      summary: result.summary,
    };
  }

}
