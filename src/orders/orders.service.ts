import { StoreWalletService } from '../store-wallet/store-wallet.service';
import { MIN_ORDER_TOTAL_VND } from './orders.constants';
export { MIN_ORDER_TOTAL_VND } from './orders.constants';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Inject,
  Optional,
  Logger,
} from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersRepository } from './orders.repository';
import { CryptoService } from '../security/crypto.service';
import { EventsGateway } from '../websocket/events.gateway';
import { toOrderResponseDto } from './dto/order-response.dto';

import { ALLOWED_ORDER_TRANSITIONS } from './dto/update-order-status.dto';
import { DeliverOrderDto } from './dto/deliver-order.dto';
import { DeliveryFailureDto } from './dto/delivery-failure.dto';
import { DriverOrdersQueryDto } from './dto/driver-orders-query.dto';
import { CreateStorefrontOrderDto } from './dto/create-storefront-order.dto';
import { OrderQueryDto } from './dto/order-query.dto';
import { OrderTimelineResponseDto } from './dto/order-timeline-response.dto';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(OrdersRepository) private readonly ordersRepo: OrdersRepository,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
    @Inject(StoreWalletService) private readonly storeWalletService: StoreWalletService,
    @Optional() @Inject(NotificationsService) private readonly notificationsService?: NotificationsService,
    @Optional() @Inject(DashboardCacheService) private readonly cacheService?: DashboardCacheService,
  ) {}

  private async invalidateDashboardCaches(storeId?: string | number | bigint, customerUserId?: string | number | bigint) {
    if (!this.cacheService || typeof this.cacheService.invalidatePrefix !== 'function') return;
    try {
      const storeIdStr = storeId ? storeId.toString() : '';
      const customerUserIdStr = customerUserId ? customerUserId.toString() : '';
      const promises: Promise<void>[] = [
        this.cacheService.invalidatePrefix('admin:dashboard:'),
        this.cacheService.invalidatePrefix('admin:revenue:'),
        this.cacheService.invalidatePrefix('admin:growth:'),
        this.cacheService.invalidatePrefix('admin:operations'),
        this.cacheService.invalidatePrefix('admin:stores-leaderboard:'),
      ];
      if (storeIdStr) {
        promises.push(this.cacheService.invalidatePrefix(`dash:store:${storeIdStr}:`));
        promises.push(this.cacheService.invalidatePrefix(`staff:dashboard:store:${storeIdStr}:`));
      }
      if (customerUserIdStr) {
        promises.push(this.cacheService.invalidateKey(`customer:dashboard:${customerUserIdStr}`));
        promises.push(this.cacheService.invalidatePrefix(`customer:orders:${customerUserIdStr}:`));
      }
      await Promise.all(promises);
    } catch (err: any) {
      this.logger.warn(`Failed to invalidate dashboard cache on order change: ${err.message}`);
    }
  }

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

    if ((button as any).inventoryState === 'RETURN_IN_TRANSIT') {
      throw new BadRequestException('Nút bấm đang trong quá trình yêu cầu trả hàng, không thể đặt hàng');
    }
    if (['IN_PLATFORM_WAREHOUSE', 'ALLOCATED_TO_STORE'].includes((button as any).inventoryState)) {
      throw new BadRequestException('Nút bấm chưa được bàn giao cho khách hàng');
    }

    // Rental Lifecycle & Expiry Invariant Check (Fail-Closed)
    if (button.rentalId || (button as any).rental) {
      const rental = (button as any).rental;
      if (!rental) {
        throw new BadRequestException('Không tìm thấy thông tin hợp đồng thuê hợp lệ cho nút bấm');
      }
      const expiry = rental.effectiveExpiresAt || rental.paidThrough || rental.endDate;
      if (expiry && new Date(expiry) <= new Date()) {
        throw new BadRequestException('Nút bấm thông minh đã hết hạn thuê. Vui lòng gia hạn gói 30.000đ/tháng để tiếp tục đặt hàng.');
      }
      if (rental.status === 'EXPIRED') {
        throw new BadRequestException('Nút bấm thông minh đã hết hạn thuê. Vui lòng gia hạn gói 30.000đ/tháng để tiếp tục đặt hàng.');
      }
      const allowedRentalStatuses = ['ACTIVE'];
      if (!allowedRentalStatuses.includes(rental.status)) {
        throw new BadRequestException('Hợp đồng thuê nút bấm không ở trạng thái hoạt động để đặt hàng');
      }
    }
    if ((button as any).canOrder === false) {
      throw new BadRequestException('Nút bấm thông minh đã hết hạn thuê. Vui lòng gia hạn gói 30.000đ/tháng để tiếp tục đặt hàng.');
    }

    if (!button.buttonProducts || button.buttonProducts.length === 0) {
      throw new BadRequestException('Nút bấm chưa được cấu hình sản phẩm đặt hàng');
    }

    // 0. Idempotency Check (Safe Hit): Tra cứu đơn hàng cũ nếu trùng requestId
    if (requestId) {
      const existingOrder = await this.ordersRepo.findOrderByButtonAndRequestId(button.buttonId, requestId);
      if (existingOrder) {
        return {
          order: toOrderResponseDto(existingOrder),
          isDuplicate: true,
          message: 'Đơn hàng đã được tạo trước đó cho yêu cầu này (Idempotent Hit)',
        };
      }
    }

    // 1. Kiểm tra sớm tổng tiền ước tính nếu có giá sản phẩm (Fast-Fail)
    if (button.buttonProducts && button.buttonProducts.length > 0) {
      let knownSubtotal = 0;
      let allPricesAvailable = true;
      for (const bp of button.buttonProducts) {
        if (bp.product && bp.product.basePrice !== undefined && bp.product.basePrice !== null) {
          knownSubtotal += Number(bp.product.basePrice) * bp.quantity;
        } else {
          allPricesAvailable = false;
        }
      }
      if (allPricesAvailable) {
        const estimatedTotal = knownSubtotal + shippingFee;
        if (estimatedTotal < MIN_ORDER_TOTAL_VND) {
          throw new BadRequestException({
            errorCode: 'ORDER_TOTAL_BELOW_MINIMUM',
            message: 'Giá trị đơn hàng tối thiểu là 2.000 VND',
          });
        }
      }
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
      // Bắt lỗi ràng buộc giá trị đơn hàng tối thiểu từ Stored Procedure (P0010)
      const isBelowMinimum =
        procErr?.code === 'P0010' ||
        procErr?.meta?.code === 'P0010' ||
        procErr?.message?.includes('P0010') ||
        procErr?.message?.includes('Giá trị đơn hàng tối thiểu');
      if (isBelowMinimum) {
        throw new BadRequestException({
          errorCode: 'ORDER_TOTAL_BELOW_MINIMUM',
          message: 'Giá trị đơn hàng tối thiểu là 2.000 VND',
        });
      }

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
          if (fallbackErr instanceof BadRequestException) {
            throw fallbackErr;
          }
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

    // Send FCM Push Notification
    if (this.notificationsService) {
      const customerUserId = button.customer?.userId || (button.customer as any)?.user?.userId;
      const storeOwnerUserId = button.store?.ownerUserId;
      this.notificationsService.sendOrderCreated(formattedOrder, customerUserId, storeOwnerUserId).catch((err) => {
        this.logger.warn(`Failed to send order created push notification: ${err.message}`);
      });
    }

    const customerUserId = button.customer?.userId || (button.customer as any)?.user?.userId;
    await this.invalidateDashboardCaches(button.storeId, customerUserId);

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

    // Rental Lifecycle & Expiry Invariant Check (Fail-Closed)
    if (button.rentalId || (button as any).rental) {
      const rental = (button as any).rental;
      if (!rental) {
        throw new BadRequestException('Không tìm thấy thông tin hợp đồng thuê hợp lệ cho nút bấm');
      }
      const expiry = rental.effectiveExpiresAt || rental.paidThrough || rental.endDate;
      if (expiry && new Date(expiry) <= new Date()) {
        throw new BadRequestException('Nút bấm thông minh đã hết hạn thuê. Vui lòng gia hạn gói 30.000đ/tháng để tiếp tục đặt hàng.');
      }
      if (rental.status === 'EXPIRED') {
        throw new BadRequestException('Nút bấm thông minh đã hết hạn thuê. Vui lòng gia hạn gói 30.000đ/tháng để tiếp tục đặt hàng.');
      }
      const allowedRentalStatuses = ['ACTIVE', 'PAID'];
      if (!allowedRentalStatuses.includes(rental.status)) {
        throw new BadRequestException('Hợp đồng thuê nút bấm không ở trạng thái hoạt động để đặt hàng');
      }
    }
    if ((button as any).canOrder === false) {
      throw new BadRequestException('Nút bấm thông minh đã hết hạn thuê. Vui lòng gia hạn gói 30.000đ/tháng để tiếp tục đặt hàng.');
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

  async list(user: any, queryOrStatus?: OrderQueryDto | string) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');

    const query: OrderQueryDto =
      typeof queryOrStatus === 'string'
        ? { status: queryOrStatus }
        : queryOrStatus || {};

    const page = query.page || 1;
    const pageSize = query.pageSize || query.limit || 20;
    const cappedPageSize = Math.min(pageSize, 100);
    const skip = (page - 1) * cappedPageSize;

    const whereClause: any = {};
    if (user.role === 'CUSTOMER') {
      if (!user.customerProfileId) {
        throw new ForbiddenException('Tài khoản khách hàng thiếu hồ sơ định danh (customerProfileId)');
      }
      whereClause.customerId = BigInt(user.customerProfileId);
    } else if (
      [
        'STORE_OWNER',
        'STORE_MANAGER',
        'STORE_STAFF',
        'STAFF_ORDER',
        'STAFF_INVENTORY',
        'STAFF_BUTTON',
        'STAFF_DELIVERY',
      ].includes(user.role)
    ) {
      if (!user.storeId) {
        throw new ForbiddenException('Tài khoản cửa hàng thiếu thông tin cửa hàng liên kết (storeId)');
      }
      whereClause.storeId = BigInt(user.storeId);
    } else if (['ADMIN', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role)) {
      // Admin may view all orders or filter
    } else {
      throw new ForbiddenException('Không có quyền truy cập danh sách đơn hàng');
    }

    if (query.status) {
      whereClause.orderStatus = query.status;
    }
    if (query.paymentStatus) {
      whereClause.paymentStatus = query.paymentStatus;
    }
    if (query.driverId) {
      try {
        whereClause.assignedDriverId = BigInt(query.driverId);
      } catch {
        // ignore
      }
    }
    if (query.fromDate || query.toDate) {
      whereClause.orderDate = {};
      if (query.fromDate) whereClause.orderDate.gte = new Date(query.fromDate);
      if (query.toDate) whereClause.orderDate.lte = new Date(query.toDate);
    }

    const { orders, total } = await this.ordersRepo.findPaginatedOrders(
      whereClause,
      skip,
      cappedPageSize,
    );
    const totalPages = Math.ceil(total / cappedPageSize);

    return {
      orders: orders.map((o) => toOrderResponseDto(o)),
      pagination: {
        page,
        pageSize: cappedPageSize,
        totalItems: total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  async getDeliveryQueue(user: any, page: number = 1, pageSize: number = 20) {
    const cappedPageSize = Math.min(pageSize, 100);
    const skip = (page - 1) * cappedPageSize;

    let storeId: bigint | undefined = undefined;
    if (user?.storeId) {
      storeId = BigInt(user.storeId);
    }

    const { orders, total } = await this.ordersRepo.findDeliveryQueueOrders(
      storeId,
      skip,
      cappedPageSize,
    );
    const totalPages = Math.ceil(total / cappedPageSize);

    return {
      orders: orders.map((o) => toOrderResponseDto(o)),
      pagination: {
        page,
        pageSize: cappedPageSize,
        totalItems: total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  async getTimeline(orderIdStr: string, user: any): Promise<OrderTimelineResponseDto> {
    let orderId: bigint;
    try {
      orderId = BigInt(orderIdStr);
    } catch {
      throw new BadRequestException('Mã đơn hàng không hợp lệ');
    }

    const order = await this.ordersRepo.findOrderForTimeline(orderId);
    if (!order) {
      throw new NotFoundException('Đơn hàng không tồn tại');
    }

    // BOLA / IDOR Protection: verify ownership
    if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      const isCustomerOwner =
        user.customerProfileId && order.customerId === BigInt(user.customerProfileId);
      const isStoreOwner = user.storeId && order.storeId === BigInt(user.storeId);
      const isAssignedDriver = user.userId && order.assignedDriverId === BigInt(user.userId);
      if (!isCustomerOwner && !isStoreOwner && !isAssignedDriver) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền xem thông tin dòng thời gian đơn hàng này.',
        });
      }
    }

    return OrderTimelineResponseDto.fromOrder(order);
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

    // Cancellation window validation (BRD-ORD-CANCEL)
    const isButtonOrder = !!(order as any).buttonId;
    const cancelWindowSeconds = Number((order as any).button?.cancelWindowSeconds || 60);
    const elapsedSeconds = (Date.now() - new Date(order.createdAt).getTime()) / 1000;

    const isPrivilegedStaff =
      user && ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'STORE_OWNER', 'STORE_MANAGER'].includes(user.role);

    // If caller is CUSTOMER or unprivileged
    if (!isPrivilegedStaff) {
      const isUnpaid =
        order.paymentStatus === 'UNPAID' ||
        (order.paymentStatus !== 'PAID' && order.paymentMethod !== 'COD' && order.paymentMethod !== 'CASH_ON_DELIVERY');

      if (isButtonOrder) {
        if (order.orderStatus !== 'PENDING') {
          throw new BadRequestException(
            `Khách hàng chỉ có thể hủy đơn hàng khi đơn ở trạng thái PENDING. Trạng thái hiện tại: ${order.orderStatus}`,
          );
        }
        if (elapsedSeconds > cancelWindowSeconds) {
          throw new BadRequestException(
            `Đã hết thời gian cho phép hủy đơn hàng từ nút bấm (${cancelWindowSeconds} giây kể từ khi đặt đơn). Cửa sổ hủy đã kết thúc.`,
          );
        }
      } else {
        // Storefront orders or unpaid orders can be cancelled while PENDING or CONFIRMED (before being prepared/shipped)
        if (!['PENDING', 'CONFIRMED'].includes(order.orderStatus)) {
          throw new BadRequestException(
            `Đơn hàng đã được xử lý (${order.orderStatus}), không thể tự hủy. Vui lòng liên hệ cửa hàng để được hỗ trợ.`,
          );
        }
      }
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
    const cancelPayload = { order: formattedOrder, reason, storeId: order.storeId.toString(), customerId: order.customerId ? order.customerId.toString() : null };
    this.eventsGateway.emitToStore(order.storeId.toString(), 'ORDER_CANCELLED', cancelPayload);
    if (order.customerId) {
      this.eventsGateway.emitToCustomer(order.customerId.toString(), 'ORDER_CANCELLED', cancelPayload);
    }
    const customerUserId = order.customer?.userId || (order.customer as any)?.user?.userId;
    await this.invalidateDashboardCaches(order.storeId, customerUserId);

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
    const statusPayload = { order: formattedOrder, storeId: order.storeId.toString(), customerId: order.customerId ? order.customerId.toString() : null };
    this.eventsGateway.emitToStore(order.storeId.toString(), 'ORDER_STATUS_CHANGED', statusPayload);
    if (order.customerId) {
      this.eventsGateway.emitToCustomer(order.customerId.toString(), 'ORDER_STATUS_CHANGED', statusPayload);
    }

    // Send FCM Push Notification
    if (this.notificationsService) {
      const customerUserId = order.customer?.userId || (order.customer as any)?.user?.userId;
      this.notificationsService.sendOrderStatusChanged(formattedOrder, customerUserId, newStatus).catch((err) => {
        this.logger.warn(`Failed to send order status changed push notification: ${err.message}`);
      });
    }

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

    const customerUserId = order.customer?.userId || (order.customer as any)?.user?.userId;
    await this.invalidateDashboardCaches(order.storeId, customerUserId);

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

    const customerUserId = order.customer?.userId || (order.customer as any)?.user?.userId;
    await this.invalidateDashboardCaches(storeId, customerUserId);

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

    await this.invalidateDashboardCaches(updated.storeId, updated.customerId ? updated.customer?.userId : undefined);

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

    await this.invalidateDashboardCaches(updated.storeId, updated.customerId ? updated.customer?.userId : undefined);

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

  /**
   * Tạo đơn hàng Storefront trực tiếp từ Web, gọi Repository transaction và phát Event an toàn (Task 1.1)
   */
  async createStorefrontOrder(body: CreateStorefrontOrderDto, customerUserId?: string | bigint) {
    const { storeId: rawStoreId, items, customerName, customerPhone, deliveryAddress, paymentMethod, orderNote } = body;

    let storeId: bigint;
    try {
      storeId = BigInt(rawStoreId);
    } catch {
      throw new BadRequestException('Mã cửa hàng storeId không hợp lệ');
    }

    let customerUserBigInt: bigint | undefined = undefined;
    if (customerUserId) {
      try {
        customerUserBigInt = BigInt(customerUserId);
      } catch {
        // ignore invalid customer id
      }
    }

    const createdOrder = await this.ordersRepo.createStorefrontOrderTx({
      storeId,
      items,
      customerName,
      customerPhone,
      deliveryAddress,
      paymentMethod,
      orderNote,
      customerUserId: customerUserBigInt,
    });

    // Event emission after transaction successfully committed
    const orderPayload = {
      order: {
        id: createdOrder.orderId.toString(),
        orderId: createdOrder.orderId.toString(),
        orderNumber: createdOrder.orderCode,
        orderCode: createdOrder.orderCode,
        storeId: createdOrder.storeId.toString(),
        totalAmount: Number(createdOrder.totalAmount),
        subtotalAmount: Number(createdOrder.subtotalAmount),
        shippingFee: Number(createdOrder.shippingFee),
        status: createdOrder.orderStatus,
        orderStatus: createdOrder.orderStatus,
        paymentStatus: createdOrder.paymentStatus,
        paymentMethod: createdOrder.paymentMethod,
        customerName: createdOrder.shippingRecipientName,
        customerPhone: createdOrder.shippingPhone,
        deliveryAddress: createdOrder.shippingAddress,
        items: createdOrder.items.map((it: any) => ({
          orderItemId: it.orderItemId.toString(),
          productId: it.productId.toString(),
          productName: it.productNameSnapshot,
          product: { name: it.productNameSnapshot },
          quantity: it.quantity,
          unitPrice: Number(it.finalUnitPrice),
          totalPrice: Number(it.itemSubtotal),
        })),
        createdAt: createdOrder.createdAt,
      },
      orderNumber: createdOrder.orderCode,
      orderCode: createdOrder.orderCode,
      customerName: createdOrder.shippingRecipientName,
      customerPhone: createdOrder.shippingPhone,
      productName: createdOrder.items[0]?.productNameSnapshot || 'Nhu yếu phẩm',
      quantity: createdOrder.items[0]?.quantity || 1,
      totalAmount: Number(createdOrder.totalAmount),
      deliveryAddress: createdOrder.shippingAddress,
      orderId: createdOrder.orderId.toString(),
      id: createdOrder.orderId.toString(),
      storeId: storeId.toString(),
      customerId: createdOrder.customerId ? createdOrder.customerId.toString() : null,
    };

    this.eventsGateway.emitToStore(storeId.toString(), 'ORDER_CREATED', orderPayload);
    if (createdOrder.customerId) {
      this.eventsGateway.emitToCustomer(createdOrder.customerId.toString(), 'ORDER_CREATED', orderPayload);
    }

    await this.invalidateDashboardCaches(
      storeId,
      createdOrder.customerId ? customerUserBigInt?.toString() : undefined,
    );

    return {
      success: true,
      message: 'Đặt hàng thành công',
      data: {
        id: createdOrder.orderId.toString(),
        orderId: createdOrder.orderId.toString(),
        orderNumber: createdOrder.orderCode,
        orderCode: createdOrder.orderCode,
        storeId: createdOrder.storeId.toString(),
        totalAmount: Number(createdOrder.totalAmount),
        subtotalAmount: Number(createdOrder.subtotalAmount),
        shippingFee: Number(createdOrder.shippingFee),
        discountAmount: Number(createdOrder.discountAmount),
        orderStatus: createdOrder.orderStatus,
        paymentStatus: createdOrder.paymentStatus,
        paymentMethod: createdOrder.paymentMethod,
        customerName: createdOrder.shippingRecipientName,
        customerPhone: createdOrder.shippingPhone,
        deliveryAddress: createdOrder.shippingAddress,
        items: createdOrder.items.map((it: any) => ({
          orderItemId: it.orderItemId.toString(),
          productId: it.productId.toString(),
          productName: it.productNameSnapshot,
          quantity: it.quantity,
          unitPrice: Number(it.finalUnitPrice),
          totalPrice: Number(it.itemSubtotal),
        })),
        createdAt: createdOrder.createdAt,
      },
    };
  }
}

