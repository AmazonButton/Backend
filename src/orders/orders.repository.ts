import { MIN_ORDER_TOTAL_VND } from './orders.constants';
import { ALLOWED_ORDER_TRANSITIONS, OrderStatusType } from './dto/update-order-status.dto';
import { DeliverOrderDto } from './dto/deliver-order.dto';
import { DeliveryFailureDto } from './dto/delivery-failure.dto';
import { DriverOrdersQueryDto } from './dto/driver-orders-query.dto';
import { Injectable, Inject, Optional, NotFoundException, BadRequestException, ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTransactionRetry } from '../common/utils/transaction-retry.util';
import { ensureAndLockStoreWalletByStoreId } from '../store-wallet/store-wallet.lock';
import { PaymentRefundsRepository } from '../payments/payment-refunds.repository';
import { hasStoreActiveSubscription } from '../common/utils/store-subscription-policy.util';

@Injectable()
export class OrdersRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() private readonly paymentRefundsRepo?: PaymentRefundsRepository,
  ) {}

  private getRefundsRepo(): PaymentRefundsRepository {
    return this.paymentRefundsRepo || new PaymentRefundsRepository(this.prisma);
  }

  async findButtonByIdentifier(identifier: string) {
    const isNum = !isNaN(Number(identifier));
    return this.prisma.ioTButton.findFirst({
      where: {
        OR: [
          { deviceId: identifier },
          { buttonCode: identifier },
          ...(isNum ? [{ buttonId: BigInt(identifier) }] : []),
        ],
      },
      include: {
        store: true,
        address: true,
        customer: {
          include: {
            user: true,
            addresses: {
              where: { isDefault: true },
              take: 1,
            },
          },
        },
        buttonProducts: { include: { product: true } },
        rental: true,
      },
    });
  }

  async findButtonByDeviceId(deviceId: string) {
    return this.prisma.ioTButton.findFirst({
      where: {
        OR: [{ deviceId }, { buttonCode: deviceId }],
      },
      include: {
        customer: {
          include: {
            user: true,
            addresses: {
              where: { isDefault: true },
              take: 1,
            },
          },
        },
        address: true,
        store: true,
        buttonProducts: { include: { product: true } },
        rental: true,
      },
    });
  }

  async createCustomerDeliveryRejectionNotification(params: {
    userId: bigint;
    buttonCode: string;
    reasonMessage: string;
    errorCode: string;
    requestId?: string;
  }) {
    const idempotencyKey = `iot-deliv-reject:${params.userId.toString()}:${params.buttonCode}:${params.requestId || Date.now()}`;
    return this.prisma.notification.upsert({
      where: { idempotencyKey },
      update: {},
      create: {
        userId: params.userId,
        type: 'DELIVERY_INELIGIBLE',
        title: 'Không thể tạo đơn từ nút bấm thông minh',
        body: `${params.reasonMessage} Vui lòng kiểm tra và cập nhật địa chỉ giao hàng mặc định trong phạm vi 5 km của cửa hàng trên ứng dụng.`,
        data: {
          buttonCode: params.buttonCode,
          errorCode: params.errorCode,
        },
        idempotencyKey,
      },
    });
  }

  async assertCustomerNotBlockedByStore(
    storeId: bigint,
    customerId: bigint,
    prismaOrTx: any = this.prisma,
  ): Promise<void> {
    const relation = await prismaOrTx.storeCustomer?.findFirst?.({
      where: { storeId, customerId },
      select: { status: true },
    });
    if (relation && relation.status === 'BLOCKED') {
      throw new ForbiddenException({
        success: false,
        errorCode: 'STORE_CUSTOMER_BLOCKED',
        code: 'STORE_CUSTOMER_BLOCKED',
        message: 'Tài khoản của bạn đã bị cửa hàng tạm chặn đặt hàng',
      });
    }
  }

  async checkStoreEligibleForOrders(
    storeId: bigint,
    prismaOrTx: any = this.prisma,
  ): Promise<{
    eligible: boolean;
    reasonCode?: 'STORE_NOT_FOUND' | 'STORE_INACTIVE' | 'STORE_SUBSCRIPTION_EXPIRED';
    storeName?: string;
    ownerUserId?: bigint | null;
  }> {
    const store = await prismaOrTx.store.findUnique({
      where: { storeId },
      select: { storeId: true, name: true, status: true, ownerUserId: true },
    });
    if (!store) {
      return { eligible: false, reasonCode: 'STORE_NOT_FOUND' };
    }
    if (store.status !== 'ACTIVE') {
      return {
        eligible: false,
        reasonCode: 'STORE_INACTIVE',
        storeName: store.name,
        ownerUserId: store.ownerUserId,
      };
    }
    const hasValidSub = await hasStoreActiveSubscription(prismaOrTx, storeId);
    if (!hasValidSub) {
      return {
        eligible: false,
        reasonCode: 'STORE_SUBSCRIPTION_EXPIRED',
        storeName: store.name,
        ownerUserId: store.ownerUserId,
      };
    }
    return {
      eligible: true,
      storeName: store.name,
      ownerUserId: store.ownerUserId,
    };
  }

  async createStoreSubscriptionRejectedNotifications(params: {
    customerUserId?: bigint | null;
    ownerUserId?: bigint | null;
    storeId: bigint;
    storeName?: string;
    buttonCode?: string;
    buttonName?: string;
    reasonCode: string;
    requestId?: string;
  }) {
    const reqSuffix = params.requestId || String(Date.now());
    const storeLabel = params.storeName || `Cửa hàng #${params.storeId.toString()}`;
    const btnLabel = params.buttonName || params.buttonCode || 'Smart Order Button';
    const tasks: Promise<any>[] = [];

    if (params.customerUserId) {
      const custKey = `iot-store-reject:cust:${params.customerUserId.toString()}:${params.storeId.toString()}:${reqSuffix}`;
      tasks.push(
        this.prisma.notification.upsert({
          where: { idempotencyKey: custKey },
          update: {},
          create: {
            userId: params.customerUserId,
            type: 'ORDER_REJECTED_STORE_INACTIVE',
            title: 'Cửa hàng đang tạm ngưng nhận đơn',
            body:
              params.reasonCode === 'STORE_SUBSCRIPTION_EXPIRED'
                ? `Không thể đặt đơn từ nút "${btnLabel}": ${storeLabel} hiện đang tạm ngưng nhận đơn do gói dịch vụ đã hết hạn. Hệ thống chưa tạo đơn và chưa trừ tiền.`
                : `Không thể đặt đơn từ nút "${btnLabel}": ${storeLabel} hiện đang tạm ngưng hoạt động. Hệ thống chưa tạo đơn và chưa trừ tiền.`,
            data: {
              storeId: params.storeId.toString(),
              buttonCode: params.buttonCode || null,
              errorCode: params.reasonCode,
            },
            idempotencyKey: custKey,
          },
        }),
      );
    }

    if (params.ownerUserId) {
      const ownerKey = `iot-store-reject:owner:${params.ownerUserId.toString()}:${params.storeId.toString()}:${reqSuffix}`;
      tasks.push(
        this.prisma.notification.upsert({
          where: { idempotencyKey: ownerKey },
          update: {},
          create: {
            userId: params.ownerUserId,
            type: 'STORE_MISSED_IOT_ORDER',
            title: 'Bỏ lỡ đơn đặt hàng từ nút bấm IoT',
            body:
              params.reasonCode === 'STORE_SUBSCRIPTION_EXPIRED'
                ? `Khách hàng vừa bấm nút đặt hàng (${btnLabel}) tại ${storeLabel} nhưng đơn bị chặn tự động do gói dịch vụ gian hàng đã hết hạn. Vui lòng gia hạn ngay để tiếp tục nhận đơn.`
                : `Khách hàng vừa bấm nút đặt hàng (${btnLabel}) tại ${storeLabel} nhưng đơn bị chặn do cửa hàng đang ở trạng thái tạm ngưng.`,
            data: {
              storeId: params.storeId.toString(),
              buttonCode: params.buttonCode || null,
              errorCode: params.reasonCode,
            },
            idempotencyKey: ownerKey,
          },
        }),
      );
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  async executeSpCreateOrder(
    buttonId: bigint,
    paymentMethod: string,
    shippingFee: number,
    orderNote: string = 'Đơn hàng tự động từ nút bấm IoT',
    iotRequestId?: string,
  ): Promise<any> {
    const result: any[] = await this.prisma.$queryRaw`
      SELECT sp_create_order_from_button(
        ${buttonId}::bigint,
        ${paymentMethod}::varchar,
        ${shippingFee}::decimal,
        ${orderNote}::text,
        ${iotRequestId || null}::varchar
      ) AS order_id
    `;
    return result[0]?.order_id;
  }

  async createOrderFallbackTx(
    button: any,
    paymentMethod: string,
    shippingFee: number,
    iotRequestId?: string,
    orderNote?: string,
    deliverySnapshot?: {
      deliveryAddressId?: bigint | null;
      shippingRecipientName?: string;
      shippingPhone?: string;
      shippingAddress?: string;
      shippingLatitude?: number | null;
      shippingLongitude?: number | null;
      deliveryDistanceMeters?: number | null;
      deliveryDistanceSource?: string | null;
    },
  ): Promise<bigint> {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          // 0. Idempotency Check (Safe Hit)
      if (iotRequestId) {
        const existingOrder = await tx.order.findFirst({
          where: {
            buttonId: button.buttonId,
            iotRequestId,
          },
        });
        if (existingOrder) {
          return existingOrder.orderId;
        }
      }

      // 0.1 In-Transaction Rental & Ordering Eligibility Check with Pessimistic Row Lock
      const lockedButtons = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM iot_button WHERE button_id = $1 FOR UPDATE',
        button.buttonId,
      );
      if (!lockedButtons || lockedButtons.length === 0) {
        throw new BadRequestException('Nút bấm không tồn tại');
      }
      const lockedButton = lockedButtons[0];

      if (lockedButton.status !== 'ACTIVE') {
        throw new BadRequestException('Nút bấm không ở trạng thái ACTIVE');
      }
      if (lockedButton.can_order === false) {
        throw new BadRequestException('Nút bấm thông minh đang bị tạm khóa tính năng đặt hàng (Khóa trẻ em từ xa hoặc tạm ngưng). Vui lòng kiểm tra trên ứng dụng để tiếp tục đặt hàng.');
      }
      if (lockedButton.inventory_state === 'RETURN_IN_TRANSIT') {
        throw new BadRequestException('Nút bấm đang trong quá trình yêu cầu trả hàng, không thể đặt hàng');
      }
      if (['IN_PLATFORM_WAREHOUSE', 'ALLOCATED_TO_STORE'].includes(lockedButton.inventory_state)) {
        throw new BadRequestException('Nút bấm chưa được bàn giao cho khách hàng');
      }

      if (lockedButton.rental_id) {
        const lockedRentals = await tx.$queryRawUnsafe<any[]>(
          'SELECT * FROM button_rentals WHERE rental_id = $1 FOR UPDATE',
          lockedButton.rental_id,
        );
        if (!lockedRentals || lockedRentals.length === 0) {
          throw new BadRequestException('Không tìm thấy thông tin hợp đồng thuê hợp lệ cho nút bấm');
        }
        const lockedRental = lockedRentals[0];

        // STRICT INVARIANT: Chỉ cho phép đặt hàng khi hợp đồng ở trạng thái ACTIVE (đã bàn giao thực tế)!
        // Tuyệt đối không cho phép 'PAID' hoặc 'PENDING_HANDOVER' đặt hàng trước khi bàn giao!
        if (lockedRental.status !== 'ACTIVE') {
          throw new BadRequestException('Hợp đồng thuê nút bấm không ở trạng thái hoạt động để đặt hàng');
        }

        // R07: Thống nhất đặc tả eligibility với Stored Procedure: effective_expires_at IS NULL OR effective_expires_at <= NOW()
        if (!lockedRental.effective_expires_at || new Date(lockedRental.effective_expires_at) <= new Date()) {
          throw new BadRequestException('Nút bấm thông minh đã hết hạn thuê. Vui lòng gia hạn gói 30.000đ/tháng để tiếp tục đặt hàng.');
        }
      }

      // 0.2 Store status invariant check under lock (matches sp_create_order_from_button P0004)
      const lockedStores = await tx.$queryRawUnsafe<any[]>(
        'SELECT store_id, status, commission_rate FROM store WHERE store_id = $1 FOR SHARE',
        button.storeId,
      );
      const storeRecord =
        lockedStores && lockedStores.length > 0
          ? lockedStores[0]
          : await tx.store.findUnique({
              where: { storeId: button.storeId },
              select: { storeId: true, status: true, commissionRate: true },
            });
      if (!storeRecord || storeRecord.status !== 'ACTIVE') {
        throw new BadRequestException('Cửa hàng hiện không hoạt động');
      }
      if (!(await hasStoreActiveSubscription(tx, BigInt(button.storeId)))) {
        throw new BadRequestException({
          errorCode: 'STORE_SUBSCRIPTION_EXPIRED',
          code: 'STORE_SUBSCRIPTION_EXPIRED',
          message: 'Cửa hàng hiện đang tạm ngưng nhận đơn do gói dịch vụ đã hết hạn',
        });
      }
      if (button.customerId) {
        await this.assertCustomerNotBlockedByStore(BigInt(button.storeId), BigInt(button.customerId), tx);
      }

      // 1. Pre-calculate subtotal & discounts from current database products
      let subtotal = 0;
      let totalDiscount = 0;
      const productMap = new Map<bigint, any>();

      for (const bp of button.buttonProducts) {
        const product = await tx.product.findUnique({
          where: { productId: bp.productId },
        });
        if (!product || product.status !== 'ACTIVE') {
          throw new BadRequestException(`Sản phẩm ${product?.productName || bp.productId} không còn kinh doanh`);
        }
        productMap.set(bp.productId, product);

        // Check active discount
        const now = new Date();
        const discount = await (tx as any).productDiscount?.findFirst?.({
          where: {
            productId: bp.productId,
            status: 'ACTIVE',
            startAt: { lte: now },
            endAt: { gte: now },
          },
        });

        const basePrice = Number(product.basePrice);
        let unitDiscount = 0;
        if (discount) {
          if (discount.discountPercent != null) {
            unitDiscount = Math.round((basePrice * Number(discount.discountPercent) / 100) * 100) / 100;
          } else if (discount.discountAmount != null) {
            unitDiscount = Number(discount.discountAmount);
          }
        }
        unitDiscount = Math.min(basePrice, Math.max(0, unitDiscount));

        subtotal += basePrice * bp.quantity;
        totalDiscount += unitDiscount * bp.quantity;
      }

      const total = subtotal - totalDiscount + shippingFee;

      // 2. Minimum order total constraint: totalAmount >= 2000 VND
      if (total < MIN_ORDER_TOTAL_VND) {
        throw new BadRequestException({
          errorCode: 'ORDER_TOTAL_BELOW_MINIMUM',
          message: 'Giá trị đơn hàng tối thiểu là 2.000 VND',
        });
      }

      // 3. NV-10: Lock inventories in sorted order with FOR UPDATE to prevent race conditions and deadlocks
      const sortedProductIds: bigint[] = Array.from(
        new Set(button.buttonProducts.map((bp: any) => BigInt(bp.productId))),
      );
      sortedProductIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      // Canonical Lock Order (product -> inventory ascending) matching ProductsRepository to prevent AB/BA deadlocks
      for (const pId of sortedProductIds) {
        await tx.$queryRawUnsafe<any[]>(
          `SELECT product_id FROM product WHERE product_id = $1 FOR UPDATE`,
          pId,
        );
      }

      const inventoryMap = new Map<bigint, { quantityOnHand: number; reservedQuantity: number }>();
      for (const pId of sortedProductIds) {
        const lockedInv = await tx.$queryRawUnsafe<any[]>(
          `SELECT quantity_on_hand, reserved_quantity FROM inventory WHERE product_id = $1 FOR UPDATE`,
          pId,
        );
        if (!lockedInv || lockedInv.length === 0) {
          throw new BadRequestException(`Không tìm thấy tồn kho cho sản phẩm ${pId}`);
        }
        inventoryMap.set(pId, {
          quantityOnHand: Number(lockedInv[0].quantity_on_hand),
          reservedQuantity: Number(lockedInv[0].reserved_quantity),
        });
      }

      // Verify available inventory under acquired row locks
      for (const bp of button.buttonProducts) {
        const inv = inventoryMap.get(BigInt(bp.productId));
        if (!inv || (inv.quantityOnHand - inv.reservedQuantity) < bp.quantity) {
          throw new BadRequestException('Không đủ tồn kho khả dụng cho sản phẩm trong nút bấm');
        }
        inv.reservedQuantity += bp.quantity;
      }

      // 4. Create order directly with correct subtotal, discount, and total
      const orderCode = `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

      const address = deliverySnapshot
        ? null
        : button.addressId
        ? await tx.customerAddress.findFirst({
            where: { addressId: button.addressId },
          })
        : null;
      const shippingAddress =
        deliverySnapshot?.shippingAddress ||
        (address
          ? `${address.addressDetail}${address.ward ? ', ' + address.ward : ''}${address.district ? ', ' + address.district : ''}${address.province ? ', ' + address.province : ''}`
          : 'Địa chỉ mặc định của khách hàng');
      const recipientName =
        deliverySnapshot?.shippingRecipientName ||
        address?.recipientName ||
        button.customer?.user?.fullName ||
        'Khách hàng';
      const phone =
        deliverySnapshot?.shippingPhone ||
        address?.phone ||
        button.customer?.user?.phone ||
        '';
      const shippingLat =
        deliverySnapshot?.shippingLatitude !== undefined
          ? deliverySnapshot.shippingLatitude
          : address?.latitude || null;
      const shippingLng =
        deliverySnapshot?.shippingLongitude !== undefined
          ? deliverySnapshot.shippingLongitude
          : address?.longitude || null;
      const resolvedDeliveryAddressId =
        deliverySnapshot?.deliveryAddressId !== undefined
          ? deliverySnapshot.deliveryAddressId
          : address?.addressId || button.addressId || null;

      const rawCommissionRate = storeRecord.commission_rate ?? storeRecord.commissionRate;
      const commissionRate = rawCommissionRate != null ? Number(rawCommissionRate) : 8.0;
      const commissionAmount = Math.round((total * commissionRate / 100) * 100) / 100;
      const netAmount = Math.max(0, total - commissionAmount);

      const createdOrder = await tx.order.create({
        data: {
          orderCode,
          storeId: button.storeId,
          customerId: button.customerId,
          buttonId: button.buttonId,
          orderStatus: 'PENDING',
          paymentStatus: 'UNPAID',
          paymentMethod,
          shippingFee,
          subtotalAmount: subtotal,
          discountAmount: totalDiscount,
          totalAmount: total,
          commissionRate,
          commissionAmount,
          netAmount,
          shippingRecipientName: recipientName,
          shippingPhone: phone,
          shippingAddress,
          shippingLatitude: shippingLat,
          shippingLongitude: shippingLng,
          deliveryAddressId: resolvedDeliveryAddressId,
          deliveryDistanceMeters:
            deliverySnapshot?.deliveryDistanceMeters !== undefined
              ? deliverySnapshot.deliveryDistanceMeters
              : null,
          deliveryDistanceSource:
            deliverySnapshot?.deliveryDistanceSource !== undefined
              ? deliverySnapshot.deliveryDistanceSource
              : null,
          orderNote: orderNote || 'Đơn hàng tự động từ nút bấm IoT',
          iotRequestId: iotRequestId || null,
        },
      });

      // 5. Create order items and update inventory
      for (const bp of button.buttonProducts) {
        const product = productMap.get(bp.productId)!;
        const basePrice = Number(product.basePrice);

        const now = new Date();
        const discount = await (tx as any).productDiscount?.findFirst?.({
          where: {
            productId: bp.productId,
            status: 'ACTIVE',
            startAt: { lte: now },
            endAt: { gte: now },
          },
        });

        let unitDiscount = 0;
        let discountPercent = 0;
        if (discount) {
          if (discount.discountPercent != null) {
            discountPercent = Number(discount.discountPercent);
            unitDiscount = Math.round((basePrice * discountPercent / 100) * 100) / 100;
          } else if (discount.discountAmount != null) {
            unitDiscount = Number(discount.discountAmount);
          }
        }
        unitDiscount = Math.min(basePrice, Math.max(0, unitDiscount));

        const finalUnitPrice = basePrice - unitDiscount;
        const lineSubtotal = finalUnitPrice * bp.quantity;

        await tx.orderItem.create({
          data: {
            orderId: createdOrder.orderId,
            productId: bp.productId,
            productNameSnapshot: product.productName,
            unitPriceSnapshot: product.basePrice,
            discountPercentSnapshot: discountPercent,
            discountAmountSnapshot: unitDiscount,
            finalUnitPrice,
            quantity: bp.quantity,
            itemSubtotal: lineSubtotal,
          },
        });

        // Giữ chỗ tồn kho (Two-Phase Commit, row already locked in step 3)
        await tx.$executeRawUnsafe(
          `UPDATE inventory
           SET reserved_quantity = reserved_quantity + $1,
               updated_at = NOW()
           WHERE product_id = $2`,
          bp.quantity,
          bp.productId,
        );
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: createdOrder.orderId,
          newStatus: 'PENDING',
          reason: 'Khách hàng nhấn nút tạo đơn thành công (Fallback Tx)',
        },
      });

      return createdOrder.orderId;
        }),
      { operationName: 'CreateOrderFallbackTx' },
    );
  }

  async findOrderById(orderId: bigint) {
    return this.prisma.order.findUnique({
      where: { orderId },
      include: {
        items: { include: { product: true } },
        button: true,
        customer: { include: { user: true } },
        store: true,
        assignedDriver: {
          select: { userId: true, fullName: true, phone: true },
        },
        statusHistories: true,
        paymentTransactions: true,
      },
    });
  }

  async findOrders(whereClause: any) {
    return this.prisma.order.findMany({
      where: whereClause,
      include: {
        items: { include: { product: true } },
        button: true,
        customer: { include: { user: true } },
        store: true,
        assignedDriver: {
          select: { userId: true, fullName: true, phone: true },
        },
        paymentTransactions: {
          select: { status: true, paymentMethod: true, paidAt: true },
        },
      },
      orderBy: { orderDate: 'desc' },
    });
  }

  async findPaginatedOrders(whereClause: any, skip: number, take: number) {
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: whereClause,
        include: {
          items: { include: { product: true } },
          button: {
            select: { buttonId: true, buttonCode: true, deviceId: true, buttonName: true },
          },
          customer: {
            select: {
              customerId: true,
              phone: true,
              user: {
                select: { userId: true, fullName: true, phone: true, email: true },
              },
            },
          },
          store: {
            select: { storeId: true, name: true, code: true, phone: true, address: true },
          },
          assignedDriver: {
            select: { userId: true, fullName: true, phone: true },
          },
          paymentTransactions: {
            select: { status: true, paymentMethod: true, paidAt: true },
          },
        },
        orderBy: { orderDate: 'desc' },
        skip,
        take,
      }),
      this.prisma.order.count({ where: whereClause }),
    ]);

    return { orders, total };
  }

  async findDeliveryQueueOrders(storeId?: bigint, skip: number = 0, take: number = 50) {
    const whereClause: any = {
      orderStatus: { in: ['CONFIRMED', 'READY_FOR_DELIVERY', 'PENDING'] },
      assignedDriverId: null,
    };

    if (storeId) {
      whereClause.storeId = storeId;
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: whereClause,
        include: {
          items: { include: { product: true } },
          store: true,
          customer: { include: { user: true } },
        },
        orderBy: { orderDate: 'asc' },
        skip,
        take,
      }),
      this.prisma.order.count({ where: whereClause }),
    ]);

    return { orders, total };
  }

  async findOrderForTimeline(orderId: bigint) {
    return this.prisma.order.findUnique({
      where: { orderId },
      include: {
        button: true,
        customer: { include: { user: true } },
        store: true,
        assignedDriver: {
          select: { userId: true, fullName: true, phone: true },
        },
        statusHistories: {
          orderBy: { changedAt: 'asc' },
        },
        paymentTransactions: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }


  async transitionOrderStatusAtomicTx(
    orderId: bigint,
    newStatus: string,
    userId?: any,
    reason?: string,
  ): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
        orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }
      const order = lockedOrders[0];

      // Idempotent: already at target status
      if (order.order_status === newStatus) {
        const existing = await this.findOrderByIdTx(tx, orderId);
        if (existing) {
          (existing as any)._statusChanged = false;
        }
        return existing;
      }

      // Check transition validity
      const allowedNext = (ALLOWED_ORDER_TRANSITIONS as any)[order.order_status] || [];
      if (!allowedNext.includes(newStatus)) {
        throw new BadRequestException(
          `Không thể chuyển trạng thái đơn hàng từ ${order.order_status} sang ${newStatus}`,
        );
      }

      if (userId) {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', $1, true)`,
          userId.toString(),
        );
      }

      await tx.order.update({
        where: { orderId },
        data: { orderStatus: newStatus },
      });

      // Lịch sử trạng thái được tự động ghi nhận bởi DB trigger trg_sync_inventory_on_order_status_change
      const updated = await this.findOrderByIdTx(tx, orderId);
      if (updated) {
        (updated as any)._statusChanged = true;
      }
      return updated;
    });
  }

  async updateOrderStatus(orderId: bigint, orderStatus: string) {
    return this.prisma.order.update({
      where: { orderId },
      data: { orderStatus },
      include: { items: true },
    });
  }

  async releaseReservedInventory(items: { productId: bigint; quantity: number }[]) {
    if (!items || items.length === 0) return;
    const sorted = [...items].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
    await runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          for (const item of sorted) {
            const invRows = await tx.$queryRawUnsafe<Array<{ reserved_quantity: number }>>(
              `SELECT reserved_quantity FROM inventory WHERE product_id = $1 FOR UPDATE`,
              item.productId,
            );
            const currentReserved = invRows?.[0] ? Number(invRows[0].reserved_quantity) : 0;
            const releaseQty = Math.min(currentReserved, Number(item.quantity));
            if (releaseQty > 0) {
              await tx.$executeRawUnsafe(
                `UPDATE inventory
                 SET reserved_quantity = GREATEST(0, reserved_quantity - $1),
                     updated_at = NOW()
                 WHERE product_id = $2`,
                releaseQty,
                item.productId,
              );
            }
          }
        }),
      { operationName: 'ReleaseReservedInventory' },
    );
  }

  async deductInventoryOnCompleted(items: { productId: bigint; quantity: number }[]) {
    if (!items || items.length === 0) return;
    const sorted = [...items].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
    await runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          for (const item of sorted) {
            const invRows = await tx.$queryRawUnsafe<Array<{ quantity_on_hand: number; reserved_quantity: number }>>(
              `SELECT quantity_on_hand, reserved_quantity FROM inventory WHERE product_id = $1 FOR UPDATE`,
              item.productId,
            );
            const inv = invRows?.[0];
            if (!inv) {
              throw new BadRequestException(`Không tìm thấy tồn kho cho sản phẩm ${item.productId}`);
            }
            if (Number(inv.quantity_on_hand) < Number(item.quantity)) {
              throw new BadRequestException(`Số lượng tồn kho thực tế không đủ cho sản phẩm ${item.productId}`);
            }
            const deductReserved = Math.min(Number(inv.reserved_quantity || 0), Number(item.quantity));
            await tx.$executeRawUnsafe(
              `UPDATE inventory
               SET quantity_on_hand = GREATEST(0, quantity_on_hand - $1),
                   reserved_quantity = GREATEST(0, reserved_quantity - $2),
                   updated_at = NOW()
               WHERE product_id = $3`,
              item.quantity,
              deductReserved,
              item.productId,
            );
          }
        }),
      { operationName: 'DeductInventoryOnCompleted' },
    );
  }

  async completeOrderAtomicTx(orderId: bigint): Promise<any> {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          // 1. Lock order row
          const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
        orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }
      const order = lockedOrders[0];

      if (order.order_status === 'COMPLETED') {
        return this.findOrderByIdTx(tx, orderId);
      }

      if (!['DELIVERED', 'SHIPPING', 'OUT_FOR_DELIVERY', 'READY_FOR_DELIVERY', 'PROCESSING', 'PREPARING', 'CONFIRMED'].includes(order.order_status)) {
        throw new BadRequestException(`Không thể hoàn tất đơn hàng từ trạng thái ${order.order_status}`);
      }

      // 2. Lock & Deduct inventory with reserved_quantity check (skip if already settled at DELIVERED stage)
      const alreadySettledInv = await tx.orderStatusHistory.findFirst({
        where: {
          orderId,
          reason: { contains: '[INV_SETTLED]' },
        },
      });
      const items = await tx.orderItem.findMany({ where: { orderId }, orderBy: { productId: 'asc' } });
      if (!alreadySettledInv) {
        for (const item of items) {
          await tx.$executeRawUnsafe(
            `SELECT * FROM inventory WHERE product_id = $1 FOR UPDATE`,
            item.productId,
          );
          const invRows = await tx.$queryRawUnsafe<any[]>(
            `SELECT quantity_on_hand, reserved_quantity FROM inventory WHERE product_id = $1 FOR UPDATE`,
            item.productId,
          );
          const inv = invRows[0];
          if (!inv) {
            throw new BadRequestException(`Không tìm thấy tồn kho cho sản phẩm ${item.productId}`);
          }
          if (Number(inv.quantity_on_hand) < Number(item.quantity)) {
            throw new BadRequestException(`Số lượng tồn kho thực tế không đủ cho sản phẩm ${item.productId}`);
          }
          const currentReserved = Number(inv.reserved_quantity);
          const deductReserved = Math.min(currentReserved, Number(item.quantity));

          if (currentReserved < Number(item.quantity)) {
            console.warn(
              `[OrdersRepository.completeOrderAtomicTx] Data discrepancy for product ${item.productId}: reserved_quantity (${currentReserved}) < item quantity (${item.quantity}). Clamping reserved deduction to ${deductReserved}.`,
            );
          }

          await tx.$executeRawUnsafe(
            `UPDATE inventory
             SET quantity_on_hand = GREATEST(0, quantity_on_hand - $1),
                 reserved_quantity = GREATEST(0, reserved_quantity - $2),
                 updated_at = NOW()
             WHERE product_id = $3`,
            item.quantity,
            deductReserved,
            item.productId,
          );
        }
      }

      // 3. Credit store wallet strictly if paid via PayOS online gateway
      const isPayosMethod = order.payment_method === 'PAYOS';
      const isPaidStatus = ['PAID', 'SUCCESS'].includes(order.payment_status);
      
      let shouldCreditWallet = false;
      if (isPayosMethod && isPaidStatus) {
        const payosTx = await tx.paymentTransaction.findFirst({
          where: {
            orderId: BigInt(orderId),
            provider: 'PAYOS',
            status: 'PAID',
          },
        });
        if (payosTx) {
          shouldCreditWallet = true;
        }
      }

      if (shouldCreditWallet) {
        const storeId = order.store_id;
        if (storeId) {
          const wallet = await ensureAndLockStoreWalletByStoreId(tx, BigInt(storeId));
          const walletId = wallet.wallet_id;

          const orderRef = `ORDER:${orderId}`;
          const existingTx = await tx.walletTransaction.findFirst({
            where: {
              walletId,
              referenceId: orderRef,
              type: 'ORDER_REVENUE',
            },
          });

          if (!existingTx) {
            const currentBal = new Prisma.Decimal(wallet.balance);
            const payoutAmount = order.net_amount
              ? new Prisma.Decimal(order.net_amount)
              : new Prisma.Decimal(order.total_amount).mul('0.92').toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
            const newBal = currentBal.plus(payoutAmount);

            await tx.storeWallet.update({
              where: { walletId },
              data: { balance: newBal },
            });

            await tx.walletTransaction.create({
              data: {
                walletId,
                amount: payoutAmount,
                type: 'ORDER_REVENUE',
                balanceBefore: currentBal,
                balanceAfter: newBal,
                referenceId: orderRef,
                description: `Doanh thu thực nhận đơn hàng #${order.order_code || orderId} (sau hoa hồng)`,
              },
            });
          }
        }
      }

      // 4. Update order status
      await tx.order.update({
        where: { orderId },
        data: {
          orderStatus: 'COMPLETED',
          completedAt: new Date(),
        },
      });

      // 5. Status history is recorded by DB trigger trg_sync_inventory_on_order_status_change

      return this.findOrderByIdTx(tx, orderId);
        }),
      { operationName: 'CompleteOrderAtomicTx' },
    );
  }

  async cancelOrderAtomicTx(
    orderId: bigint,
    reason: string = 'Khách hàng hủy đơn',
    userId?: any,
    targetStatus: 'CANCELLED' | 'REJECTED' = 'CANCELLED',
    options?: {
      mode?: 'MANUAL' | 'PAYMENT_TIMEOUT';
      excludePaymentMethods?: string[];
    },
  ): Promise<any> {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
        orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }
      const order = lockedOrders[0];

      if (order.order_status === 'CANCELLED' || order.order_status === 'REJECTED') {
        // Idempotent: already terminal, do not release stock again
        return this.findOrderByIdTx(tx, orderId);
      }

      // Enforce non-COD / unpaid-only guards strictly when explicit business mode is PAYMENT_TIMEOUT
      // (or when caller explicitly provides excludePaymentMethods). NEVER infer timeout from reason string.
      const cancelMode = options?.mode ?? 'MANUAL';
      const excludedMethods = (
        options?.excludePaymentMethods ??
        (cancelMode === 'PAYMENT_TIMEOUT' ? ['COD', 'CASH_ON_DELIVERY'] : [])
      ).map((m) => String(m).trim().toUpperCase());

      if (
        excludedMethods.length > 0 &&
        excludedMethods.includes(String(order.payment_method || '').trim().toUpperCase())
      ) {
        return {
          ...(await this.findOrderByIdTx(tx, orderId)),
          skipped: true,
          skippedReason: 'EXCLUDED_PAYMENT_METHOD',
        };
      }

      if (cancelMode === 'PAYMENT_TIMEOUT') {
        if (order.payment_status === 'PAID' || order.order_status !== 'PENDING' || order.button_id != null) {
          return {
            ...(await this.findOrderByIdTx(tx, orderId)),
            skipped: true,
            skippedReason: 'NOT_TIMEOUT_ELIGIBLE',
          };
        }
      }

      if (['COMPLETED', 'DELIVERED', 'SHIPPING'].includes(order.order_status)) {
        throw new BadRequestException('Đơn hàng đã được xử lý giao hàng hoặc hoàn tất, không thể hủy');
      }

      // NV-08: If order was marked DELIVERY_FAILED, its reserved inventory was ALREADY released
      // in completeDeliveryFailedTx. Re-releasing here would decrement reserved_quantity belonging to other orders!
      const alreadyReleased = order.order_status === 'DELIVERY_FAILED';
      if (!alreadyReleased) {
        const items = await tx.orderItem.findMany({ where: { orderId }, orderBy: { productId: 'asc' } });
        for (const item of items) {
          await tx.$executeRawUnsafe(
            `SELECT * FROM inventory WHERE product_id = $1 FOR UPDATE`,
            item.productId,
          );
          const invRows = await tx.$queryRawUnsafe<any[]>(
            `SELECT reserved_quantity FROM inventory WHERE product_id = $1 FOR UPDATE`,
            item.productId,
          );
          const inv = invRows[0];
          const currentReserved = inv ? Number(inv.reserved_quantity) : 0;
          const releaseQty = Math.min(currentReserved, Number(item.quantity));

          if (currentReserved < Number(item.quantity)) {
            console.warn(
              `[OrdersRepository.cancelOrderAtomicTx] Data discrepancy for product ${item.productId}: reserved_quantity (${currentReserved}) < item quantity (${item.quantity}). Clamping release to ${releaseQty}.`,
            );
          }

          if (releaseQty > 0 || currentReserved > 0) {
            await tx.$executeRawUnsafe(
              `UPDATE inventory
               SET reserved_quantity = GREATEST(0, reserved_quantity - $1),
                   updated_at = NOW()
               WHERE product_id = $2`,
              releaseQty,
              item.productId,
            );
          }
        }
      }

      if (userId) {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', $1, true)`,
          userId.toString(),
        );
      }

      const orderUpdateData: any = { orderStatus: targetStatus };
      if (order.payment_status === 'PAID') {
        orderUpdateData.paymentStatus = 'REFUND_PENDING';
      }

      await tx.order.update({
        where: { orderId },
        data: orderUpdateData,
      });

      // Ý 7: Cancel any active PENDING payment transactions atomically inside the TX and
      // return their paymentLinkIds non-enumerably so post-commit code cancels remote PayOS links.
      let cancelledPayosLinkIds: string[] = [];
      if (tx.paymentTransaction?.findMany) {
        const pendingPayosTxs = await tx.paymentTransaction.findMany({
          where: { orderId, status: 'PENDING' },
          select: { paymentTransactionId: true, paymentLinkId: true },
        });
        if (pendingPayosTxs && pendingPayosTxs.length > 0) {
          await tx.paymentTransaction.updateMany({
            where: { orderId, status: 'PENDING' },
            data: { status: 'CANCELLED' },
          });
          cancelledPayosLinkIds = pendingPayosTxs
            .map((p: any) => p.paymentLinkId)
            .filter((id: any): id is string => Boolean(id && String(id).trim()));
        }
      }

      if (
        (orderUpdateData.paymentStatus === 'REFUND_PENDING' || order.payment_status === 'REFUND_PENDING') &&
        typeof (tx as any)?.paymentOrderReceipt?.findMany === 'function'
      ) {
        await this.getRefundsRepo().ensureOrderRefundObligationsForCancelledOrderInTx(tx, orderId);
      }

      // Lịch sử trạng thái được tự động ghi nhận bởi DB trigger trg_sync_inventory_on_order_status_change

      const cancelledOrder = await this.findOrderByIdTx(tx, orderId);
      if (cancelledOrder && cancelledPayosLinkIds.length > 0) {
        Object.defineProperty(cancelledOrder, '__cancelledPayosLinkIds', {
          value: cancelledPayosLinkIds,
          enumerable: false,
        });
      }
      return cancelledOrder;
        }),
      { operationName: 'CancelOrderAtomicTx' },
    );
  }

  /**
   * @deprecated Manual blind REFUNDED mutation is disabled (F2 P1 remediation).
   * Paid order refunds must be dispatched & verified via PaymentRefundsService + PayOSPayoutService.
   */
  async refundOrderAtomicTx(orderId: bigint, _note: string, _changedByUserId?: bigint | null) {
    return this.prisma.$transaction(async (tx) => {
      const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
        orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }
      const order = lockedOrders[0];
      if (order.payment_status === 'REFUNDED') {
        return this.findOrderByIdTx(tx, orderId);
      }
      if (order.payment_status !== 'REFUND_PENDING') {
        throw new BadRequestException(
          `Đơn hàng không ở trạng thái chờ hoàn tiền (Trạng thái hiện tại: ${order.payment_status})`,
        );
      }
      throw new BadRequestException(
        'MANUAL_ORDER_REFUND_DEPRECATED: Không thể đóng trạng thái REFUNDED khi chưa có chứng từ chi hộ PayOS xác thực. Vui lòng xử lý qua PaymentRefundsService.',
      );
    });
  }

  async findOrderByIdTx(tx: any, orderId: bigint) {
    return tx.order.findUnique({
      where: { orderId },
      include: {
        items: { include: { product: true } },
        button: true,
        customer: { include: { user: true } },
        store: true,
        statusHistories: true,
        paymentTransactions: true,
      },
    });
  }


  async findOrderByButtonAndRequestId(buttonId: bigint, iotRequestId: string): Promise<any> {
    return this.prisma.order.findFirst({
      where: {
        buttonId,
        iotRequestId,
      },
      include: {
        items: true,
        button: {
          include: {
            customer: { include: { user: true } },
          },
        },
        store: true,
      },
    });
  }



  async claimOrderAtomicTx(orderId: bigint, storeId: bigint, driverId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.order.findUnique({
        where: { orderId },
        select: { orderId: true, storeId: true, orderStatus: true, assignedDriverId: true },
      });

      if (!existing) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }

      if (existing.storeId.toString() !== storeId.toString()) {
        throw new ForbiddenException('Đơn hàng không thuộc quyền quản lý của cửa hàng bạn');
      }

      if (existing.orderStatus !== 'READY_FOR_DELIVERY' || existing.assignedDriverId != null) {
        throw new ConflictException({
          success: false,
          code: 'ORDER_ALREADY_CLAIMED',
          message: 'Đơn hàng đã được tài xế khác nhận hoặc không ở trạng thái sẵn sàng giao (READY_FOR_DELIVERY)',
        });
      }

      const updatedCount = await tx.$executeRawUnsafe(
        `UPDATE orders
         SET order_status = 'SHIPPING',
             assigned_driver_id = $1,
             updated_at = NOW()
         WHERE order_id = $2
           AND store_id = $3
           AND order_status = 'READY_FOR_DELIVERY'
           AND assigned_driver_id IS NULL`,
        driverId,
        orderId,
        storeId,
      );

      if (updatedCount === 0) {
        throw new ConflictException({
          success: false,
          code: 'ORDER_ALREADY_CLAIMED',
          message: 'Đơn hàng đã được tài xế khác tiếp nhận trước đó',
        });
      }

      if (driverId) {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', $1, true)`,
          driverId.toString(),
        );
      }

      return this.findOrderByIdTx(tx, orderId);
    });
  }

  async takeoverShippingOrderTx(
    orderId: bigint,
    expectedStoreId: bigint | null,
    newAssigneeUserId: bigint,
    isPlatformAdmin: boolean,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT order_id, store_id, order_status, assigned_driver_id FROM orders WHERE order_id = $1 FOR UPDATE`,
        orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }
      const order = lockedOrders[0];

      if (!isPlatformAdmin) {
        if (!expectedStoreId || order.store_id.toString() !== expectedStoreId.toString()) {
          throw new ForbiddenException('Đơn hàng không thuộc quyền quản lý của cửa hàng bạn');
        }
      }

      if (order.order_status !== 'SHIPPING') {
        throw new BadRequestException(
          `Chỉ có thể tiếp nhận lại đơn đang ở trạng thái SHIPPING (hiện tại: ${order.order_status})`,
        );
      }

      await tx.$executeRawUnsafe(
        `UPDATE orders
         SET assigned_driver_id = $1,
             updated_at = NOW()
         WHERE order_id = $2`,
        newAssigneeUserId,
        orderId,
      );

      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_user_id', $1, true)`,
        newAssigneeUserId.toString(),
      );

      return this.findOrderByIdTx(tx, orderId);
    });
  }

  async completeDeliveryAtomicTx(orderId: bigint, driverUser: any, dto: DeliverOrderDto) {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const lockedOrders = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
            orderId,
          );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }
      const order = lockedOrders[0];

      const isPlatformAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(driverUser?.role);
      if (!isPlatformAdmin) {
        if (!driverUser?.storeId || order.store_id.toString() !== driverUser.storeId.toString()) {
          throw new ForbiddenException('Bạn không có quyền xử lý đơn hàng của cửa hàng khác');
        }
      }

      if (order.order_status !== 'SHIPPING') {
        throw new BadRequestException(`Chỉ có thể hoàn tất giao hàng từ trạng thái SHIPPING (hiện tại: ${order.order_status})`);
      }

      let isValidPod = false;
      let canonicalPodRef = '';
      let canonicalSubpath = '';

      if (dto.podObjectKey && typeof dto.podObjectKey === 'string') {
        const cleanKey = dto.podObjectKey.trim().replace(/^\/+/, '');
        if (cleanKey.startsWith(`stores/${order.store_id}/pod/`) && !cleanKey.includes('..')) {
          isValidPod = true;
          canonicalSubpath = cleanKey;
          canonicalPodRef = cleanKey;
        }
      } else if (dto.podImageUrl && typeof dto.podImageUrl === 'string') {
        try {
          const parsed = new URL(dto.podImageUrl);
          const configuredCloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
          const isSecure = parsed.protocol === 'https:';
          const isCloudinaryHost = parsed.hostname === 'res.cloudinary.com' || parsed.hostname.endsWith('.cloudinary.com');
          const uploadIdx = parsed.pathname.indexOf('/image/upload/');

          if (isSecure && isCloudinaryHost && uploadIdx !== -1) {
            const cloudNameInUrl = parsed.pathname.slice(1, uploadIdx);
            if (!configuredCloudName || cloudNameInUrl === configuredCloudName) {
              const rawAfterUpload = parsed.pathname.slice(uploadIdx + '/image/upload/'.length);
              // Split segments to strip transformation options and version prefix (v12345)
              const segments = rawAfterUpload.split('/');
              const cleanSegments = segments.filter((seg) => !seg.includes(',') && !/^v\d+$/.test(seg));
              canonicalSubpath = cleanSegments.join('/');

              if (canonicalSubpath.startsWith(`stores/${order.store_id}/pod/`)) {
                isValidPod = true;
                const effectiveCloud = configuredCloudName || cloudNameInUrl;
                canonicalPodRef = `https://res.cloudinary.com/${effectiveCloud}/image/upload/${canonicalSubpath}`;
              }
            }
          } else if (isSecure && (parsed.hostname.includes('r2.cloudflarestorage.com') || parsed.hostname.includes('s3.') || parsed.hostname.includes('amazonaws.com'))) {
            const rawPath = parsed.pathname.replace(/^\/+/, '');
            const subpath = rawPath.replace(/^[^\/]+\//, '');
            if (rawPath.startsWith(`stores/${order.store_id}/pod/`)) {
              canonicalSubpath = rawPath;
              canonicalPodRef = rawPath;
              isValidPod = true;
            } else if (subpath.startsWith(`stores/${order.store_id}/pod/`)) {
              canonicalSubpath = subpath;
              canonicalPodRef = subpath;
              isValidPod = true;
            }
          }
        } catch (e) {
          isValidPod = false;
        }
      }

      if (!isValidPod || !canonicalSubpath) {
        throw new BadRequestException(`Ảnh xác thực giao hàng (POD) phải thuộc thư mục stores/${order.store_id}/pod/`);
      }

      // Geofencing verification (Haversine formula)
      let geofenceNote: string | null = null;
      if (
        dto.driverLatitude != null &&
        dto.driverLongitude != null &&
        order.shipping_latitude != null &&
        order.shipping_longitude != null
      ) {
        const toRad = (deg: number) => (deg * Math.PI) / 180;
        const lat1 = toRad(Number(order.shipping_latitude));
        const lon1 = toRad(Number(order.shipping_longitude));
        const lat2 = toRad(Number(dto.driverLatitude));
        const lon2 = toRad(Number(dto.driverLongitude));
        const dLat = lat2 - lat1;
        const dLon = lon2 - lon1;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const R = 6371000;
        const distanceMeters = Math.round(R * c);
        if (distanceMeters > 500) {
          geofenceNote = `[GEOFENCE_ALERT] Giao hàng cách điểm nhận ${distanceMeters}m (GPS tài xế: ${dto.driverLatitude}, ${dto.driverLongitude})`;
        } else {
          geofenceNote = `[GEOFENCE_OK] Vị trí giao hàng khớp thực tế (${distanceMeters}m)`;
        }
      }

      // NV-07: Acquire transaction-level advisory lock on canonical POD subpath to serialize concurrent claims
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext('pod_claim:' || $1))`,
        canonicalSubpath,
      );

      const duplicatePod = await tx.$queryRawUnsafe<any[]>(
        `SELECT order_id FROM orders 
         WHERE order_id != $1 
           AND pod_image_url IS NOT NULL 
           AND pod_image_url LIKE $2 
         LIMIT 1`,
        orderId,
        `%${canonicalSubpath}%`,
      );
      if (duplicatePod && duplicatePod.length > 0) {
        throw new BadRequestException('Ảnh xác thực giao hàng (POD) này đã được sử dụng cho đơn hàng khác, không thể tái sử dụng');
      }

      // NV-09: Prevent changing payment method of orders already paid via online gateway (PAYOS/VIETQR) to COD
      const isPaidGateway = order.payment_status === 'PAID' && ['PAYOS', 'VIETQR'].includes(order.payment_method);
      if (isPaidGateway && dto.paymentMethod !== order.payment_method) {
        throw new BadRequestException(
          `Đơn hàng đã được thanh toán trực tuyến qua ${order.payment_method}, không thể thay đổi phương thức thanh toán sang ${dto.paymentMethod}`,
        );
      }

      if (dto.paymentMethod === 'COD') {
        const orderTotal = Number(order.total_amount);
        if (dto.collectedAmount == null) {
          throw new BadRequestException('Đơn hàng thanh toán COD bắt buộc phải có số tiền đã thu (collectedAmount)');
        }
        if (Math.abs(Number(dto.collectedAmount) - orderTotal) > 0.01) {
          throw new BadRequestException(`Số tiền thu (${dto.collectedAmount}) không khớp với tổng tiền đơn hàng (${orderTotal})`);
        }
      } else if (['VIETQR', 'PAYOS'].includes(dto.paymentMethod)) {
        if (['REFUND_PENDING', 'REFUNDED'].includes(order.payment_status)) {
          throw new BadRequestException('Đơn hàng đang chờ hoàn tiền hoặc đã hoàn tiền, không thể chốt giao hàng qua cổng trực tuyến');
        }
        if (order.payment_status !== 'PAID') {
          const paidTx = await tx.paymentTransaction.findFirst({
            where: { orderId: BigInt(orderId), status: 'PAID' },
          });
          if (!paidTx) {
            throw new BadRequestException('Đơn hàng thanh toán chuyển khoản VietQR/PayOS chưa được thanh toán thành công');
          }
        }
      }

      const deliveredAtDate = dto.deliveredAt ? new Date(dto.deliveredAt) : new Date();
      const effectivePaymentMethod = isPaidGateway ? order.payment_method : dto.paymentMethod;

      // Ý 1: If an UNPAID PayOS/QR order is settled at doorstep via COD, mark any lingering PENDING
      // PayOS payment transactions as CANCELLED so the remote QR link can be invalidated after commit.
      let doorstepCancelledLinkIds: string[] = [];
      if (!isPaidGateway && effectivePaymentMethod === 'COD' && tx.paymentTransaction?.findMany) {
        const pendingPayosTxs = await tx.paymentTransaction.findMany({
          where: { orderId, status: 'PENDING' },
          select: { paymentTransactionId: true, paymentLinkId: true },
        });
        if (pendingPayosTxs && pendingPayosTxs.length > 0) {
          await tx.paymentTransaction.updateMany({
            where: { orderId, status: 'PENDING' },
            data: { status: 'CANCELLED' },
          });
          doorstepCancelledLinkIds = pendingPayosTxs
            .map((p: any) => p.paymentLinkId)
            .filter((id: any): id is string => Boolean(id && String(id).trim()));
        }
      }

      // Deduct physical inventory (quantity_on_hand & reserved_quantity) immediately on DELIVERED
      const alreadySettledInv = await tx.orderStatusHistory.findFirst({
        where: {
          orderId,
          reason: { contains: '[INV_SETTLED]' },
        },
      });
      if (!alreadySettledInv) {
        const items = await tx.orderItem.findMany({ where: { orderId }, orderBy: { productId: 'asc' } });
        for (const item of items) {
          const invRows = await tx.$queryRawUnsafe<any[]>(
            `SELECT quantity_on_hand, reserved_quantity FROM inventory WHERE product_id = $1 FOR UPDATE`,
            item.productId,
          );
          const inv = invRows[0];
          if (inv) {
            const currentReserved = Number(inv.reserved_quantity || 0);
            const deductReserved = Math.min(currentReserved, Number(item.quantity));
            await tx.$executeRawUnsafe(
              `UPDATE inventory
               SET quantity_on_hand = GREATEST(0, quantity_on_hand - $1),
                   reserved_quantity = GREATEST(0, reserved_quantity - $2),
                   updated_at = NOW()
               WHERE product_id = $3`,
              item.quantity,
              deductReserved,
              item.productId,
            );
          }
        }
      }

      // Credit store wallet immediately on DELIVERED if paid via online gateway (PAYOS / VIETQR)
      if (['PAYOS', 'VIETQR'].includes(effectivePaymentMethod)) {
        const payosTx = await tx.paymentTransaction.findFirst({
          where: {
            orderId: BigInt(orderId),
            provider: 'PAYOS',
            status: 'PAID',
          },
        });
        if (payosTx && order.store_id) {
          const wallet = await ensureAndLockStoreWalletByStoreId(tx, BigInt(order.store_id));
          const walletId = wallet.wallet_id;

          const orderRef = `ORDER:${orderId}`;
          const existingTx = await tx.walletTransaction.findFirst({
            where: {
              walletId,
              referenceId: orderRef,
              type: 'ORDER_REVENUE',
            },
          });

          if (!existingTx) {
            const currentBal = new Prisma.Decimal(wallet.balance);
            const payoutAmount = order.net_amount
              ? new Prisma.Decimal(order.net_amount)
              : new Prisma.Decimal(order.total_amount).mul('0.92').toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
            const newBal = currentBal.plus(payoutAmount);

            await tx.storeWallet.update({
              where: { walletId },
              data: { balance: newBal },
            });

            await tx.walletTransaction.create({
              data: {
                walletId,
                amount: payoutAmount,
                type: 'ORDER_REVENUE',
                balanceBefore: currentBal,
                balanceAfter: newBal,
                referenceId: orderRef,
                description: `Doanh thu thực nhận đơn hàng #${order.order_code || orderId} (sau hoa hồng)`,
              },
            });
          }
        }
      }

      await tx.order.update({
        where: { orderId },
        data: {
          orderStatus: 'DELIVERED',
          paymentStatus: 'PAID',
          paymentMethod: effectivePaymentMethod,
          podImageUrl: canonicalPodRef,
          deliveredAt: deliveredAtDate,
          ...(geofenceNote
            ? {
                orderNote: order.order_note
                  ? `${order.order_note}\n${geofenceNote}`
                  : geofenceNote,
              }
            : {}),
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          oldStatus: order.order_status,
          newStatus: 'DELIVERED',
          changedByUserId: driverUser?.userId ? BigInt(driverUser.userId) : null,
          reason: 'Giao hàng thành công kèm bằng chứng ảnh POD [INV_SETTLED]',
        },
      });

      const driverId = order.assigned_driver_id;
      if (driverId) {
        const codAmount = effectivePaymentMethod === 'COD' ? Number(order.total_amount) : 0;
        const vietqrAmount = effectivePaymentMethod === 'VIETQR' ? Number(order.total_amount) : 0;
        await tx.$executeRawUnsafe(
          `UPDATE driver_shifts
           SET total_orders_delivered = total_orders_delivered + 1,
               total_cod_collected = total_cod_collected + $1,
               total_vietqr_collected = total_vietqr_collected + $2,
               updated_at = NOW()
           WHERE driver_id = $3 AND status = 'OPEN'`,
          codAmount,
          vietqrAmount,
          driverId,
        );
      }

      if (driverUser && driverUser.userId) {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', $1, true)`,
          driverUser.userId.toString(),
        );
      }

      const deliveredOrder = await this.findOrderByIdTx(tx, orderId);
      if (deliveredOrder && doorstepCancelledLinkIds.length > 0) {
        Object.defineProperty(deliveredOrder, '__cancelledPayosLinkIds', {
          value: doorstepCancelledLinkIds,
          enumerable: false,
        });
      }
      return deliveredOrder;
        }),
      { operationName: 'CompleteDeliveryAtomicTx' },
    );
  }

  async failDeliveryAtomicTx(orderId: bigint, driverUser: any, dto: DeliveryFailureDto) {
    return this.prisma.$transaction(async (tx) => {
      const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
        orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }
      const order = lockedOrders[0];

      const isPlatformAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(driverUser?.role);
      if (!isPlatformAdmin) {
        if (!driverUser?.storeId || order.store_id.toString() !== driverUser.storeId.toString()) {
          throw new ForbiddenException('Bạn không có quyền xử lý đơn hàng của cửa hàng khác');
        }
      }

      if (order.order_status !== 'SHIPPING') {
        throw new BadRequestException(`Chỉ có thể báo giao hàng thất bại từ trạng thái SHIPPING (hiện tại: ${order.order_status})`);
      }

      if (!dto.evidenceImageUrl) {
        throw new BadRequestException('Bắt buộc phải có ảnh bằng chứng giao hàng thất bại');
      }

      // Release reserved inventory back
      const items = await tx.orderItem.findMany({ where: { orderId }, orderBy: { productId: 'asc' } });
      for (const item of items) {
        await tx.$executeRawUnsafe(
          `SELECT * FROM inventory WHERE product_id = $1 FOR UPDATE`,
          item.productId,
        );
        const invRows = await tx.$queryRawUnsafe<any[]>(
          `SELECT reserved_quantity FROM inventory WHERE product_id = $1 FOR UPDATE`,
          item.productId,
        );
        const inv = invRows[0];
        const currentReserved = inv ? Number(inv.reserved_quantity) : 0;
        const releaseQty = Math.min(currentReserved, Number(item.quantity));
        if (releaseQty > 0 || currentReserved > 0) {
          await tx.$executeRawUnsafe(
            `UPDATE inventory
             SET reserved_quantity = GREATEST(0, reserved_quantity - $1),
                 updated_at = NOW()
             WHERE product_id = $2`,
            releaseQty,
            item.productId,
          );
        }
      }

      await tx.order.update({
        where: { orderId },
        data: {
          orderStatus: 'DELIVERY_FAILED',
          failureReasonCode: dto.failureReasonCode,
          failureNote: dto.failureNote || null,
          evidenceImageUrl: dto.evidenceImageUrl,
        },
      });

      const driverId = order.assigned_driver_id;
      if (driverId) {
        await tx.$executeRawUnsafe(
          `UPDATE driver_shifts
           SET total_orders_failed = total_orders_failed + 1,
               updated_at = NOW()
           WHERE driver_id = $1 AND status = 'OPEN'`,
          driverId,
        );
      }

      if (driverUser && driverUser.userId) {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', $1, true)`,
          driverUser.userId.toString(),
        );
      }

      return this.findOrderByIdTx(tx, orderId);
    });
  }

  async findDriverOrders(driverId: bigint, storeId: bigint, query: DriverOrdersQueryDto) {
    const where: any = {
      assignedDriverId: driverId,
      storeId: storeId,
    };

    if (query.status) {
      where.orderStatus = query.status;
    }

    // Date range filtering
    const now = new Date();
    if (query.dateRange === 'today') {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      where.createdAt = { gte: startOfDay };
    } else if (query.dateRange === 'yesterday') {
      const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const endOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, -1);
      where.createdAt = { gte: startOfYesterday, lte: endOfYesterday };
    } else if (query.dateRange === 'last7days') {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      where.createdAt = { gte: sevenDaysAgo };
    } else if (query.fromDate || query.toDate) {
      where.createdAt = {};
      if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
      if (query.toDate) where.createdAt.lte = new Date(query.toDate);
    }

    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          items: { include: { product: true } },
          customer: { include: { user: true } },
          store: true,
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    // Aggregate driver stats
    const deliveredCount = await this.prisma.order.count({
      where: { ...where, orderStatus: 'DELIVERED' },
    });
    const failedCount = await this.prisma.order.count({
      where: { ...where, orderStatus: 'DELIVERY_FAILED' },
    });
    const codSumRaw = await this.prisma.order.aggregate({
      where: { ...where, orderStatus: 'DELIVERED', paymentMethod: 'COD' },
      _sum: { totalAmount: true },
    });

    return {
      orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      summary: {
        totalDelivered: deliveredCount,
        totalFailed: failedCount,
        totalCodCollected: Number(codSumRaw._sum.totalAmount || 0),
      },
    };
  }

  private computeStorefrontCheckoutHash(payload: {
    storeId: bigint;
    items: Array<{ productId: string | number; quantity: number }>;
    customerName: string;
    customerPhone: string;
    deliveryAddress: string;
    paymentMethod: string;
    orderNote?: string;
    customerUserId?: bigint;
  }): string {
    const normalizedItems = (payload.items || [])
      .map((it) => ({
        productId: String(it.productId || '').trim(),
        quantity: Number(it.quantity),
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId));

    const canonical = JSON.stringify({
      storeId: payload.storeId.toString(),
      customerUserId: payload.customerUserId ? payload.customerUserId.toString() : null,
      items: normalizedItems,
      customerName: (payload.customerName || '').trim(),
      customerPhone: (payload.customerPhone || '').trim(),
      deliveryAddress: (payload.deliveryAddress || '').trim(),
      paymentMethod: (payload.paymentMethod || '').trim().toUpperCase(),
      orderNote: (payload.orderNote || '').trim(),
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Tạo đơn hàng Storefront trực tiếp trong Transaction an toàn với Row-Locking (Task 1.1 + Task 1.2)
   * Kèm ràng buộc định danh checkout bền vững (F4) để chống tạo đơn trùng khi retry sau crash window.
   */
  async createStorefrontOrderTx(payload: {
    storeId: bigint;
    items: Array<{ productId: string | number; quantity: number }>;
    customerName: string;
    customerPhone: string;
    deliveryAddress: string;
    paymentMethod: string;
    orderNote?: string;
    customerUserId?: bigint;
    idempotency?: {
      actorScope?: string;
      idempotencyKey: string;
      requestHash?: string;
      recordId?: bigint;
      lockToken?: string;
    };
  }) {
    const { storeId, items, customerName, customerPhone, deliveryAddress, paymentMethod, orderNote, customerUserId, idempotency } = payload;

    const cleanIdempKey = idempotency?.idempotencyKey?.trim() || null;
    const cleanActorScope = cleanIdempKey
      ? (idempotency?.actorScope?.trim() || (customerUserId ? `user:${customerUserId.toString()}` : 'public'))
      : null;
    const checkoutRequestHash = cleanIdempKey
      ? (idempotency?.requestHash?.trim() || this.computeStorefrontCheckoutHash(payload))
      : null;

    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          // 0. Durable checkout identity lock & crash-recovery lookup inside the business transaction (F4)
          if (cleanActorScope && cleanIdempKey) {
            const lockKey = `storefront_checkout:${cleanActorScope}:${cleanIdempKey}`;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

            const existingOrder = await tx.order.findFirst({
              where: {
                checkoutActorScope: cleanActorScope,
                checkoutIdempotencyKey: cleanIdempKey,
              },
              include: {
                items: true,
                store: { select: { storeId: true, name: true, phone: true } },
              },
            });

            if (existingOrder) {
              if (
                existingOrder.checkoutRequestHash &&
                checkoutRequestHash &&
                existingOrder.checkoutRequestHash.trim() !== checkoutRequestHash.trim()
              ) {
                throw new UnprocessableEntityException(
                  'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: Khóa Idempotency đã được sử dụng với nội dung yêu cầu khác',
                );
              }
              Object.defineProperty(existingOrder, '__reusedFromCheckoutIdempotency', {
                value: true,
                enumerable: false,
              });
              return existingOrder;
            }
          }
          // 1. Lock Store FOR SHARE to guarantee consistent ACTIVE state throughout transaction
          const storeRows: any[] = await tx.$queryRaw`
            SELECT store_id, name, status, commission_rate
            FROM store
            WHERE store_id = ${storeId}
            FOR SHARE
          `;
          const storeRow = storeRows?.[0];
          if (!storeRow || storeRow.status !== 'ACTIVE') {
            throw new BadRequestException('Cửa hàng không tồn tại hoặc tạm ngưng hoạt động');
          }
          if (!(await hasStoreActiveSubscription(tx, storeId))) {
            throw new BadRequestException({
              success: false,
              errorCode: 'STORE_SUBSCRIPTION_EXPIRED',
              code: 'STORE_SUBSCRIPTION_EXPIRED',
              message: 'Cửa hàng hiện đang tạm ngưng nhận đơn do gói dịch vụ đã hết hạn',
            });
          }
          if (customerUserId) {
            const earlyProfile = await tx.customerProfile.findUnique({
              where: { userId: customerUserId },
              select: { customerId: true },
            });
            if (earlyProfile) {
              await this.assertCustomerNotBlockedByStore(storeId, earlyProfile.customerId, tx);
            }
          }
          const store = {
            storeId: storeRow.store_id,
            name: storeRow.name,
            status: storeRow.status,
            commissionRate: storeRow.commission_rate,
          };

          // 2. Aggregate quantities per product
          const quantities = new Map<string, number>();
          for (const item of items) {
            const pId = String(item.productId || '').trim();
            const qty = Number(item.quantity);
            if (!pId || !Number.isInteger(qty) || qty < 1) {
              throw new BadRequestException('Số lượng sản phẩm không hợp lệ');
            }
            quantities.set(pId, (quantities.get(pId) || 0) + qty);
          }

          let productIds: bigint[];
          try {
            productIds = Array.from(quantities.keys()).map((id) => BigInt(id));
          } catch {
            throw new BadRequestException('Giỏ hàng có sản phẩm không còn hợp lệ. Vui lòng tải lại danh mục và chọn lại sản phẩm.');
          }

          // 3. Canonical Lock Order: lock product rows ascending FOR UPDATE first,
          //    then inventory rows ascending FOR UPDATE (matches ProductsRepository.updateProductAtomicTx).
          const sortedProductIds = [...productIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          for (const pId of sortedProductIds) {
            const lockedProdRows: any[] = await tx.$queryRaw`
              SELECT product_id, status
              FROM product
              WHERE product_id = ${pId} AND store_id = ${storeId}
              FOR UPDATE
            `;
            if (!lockedProdRows || lockedProdRows.length === 0 || lockedProdRows[0].status !== 'ACTIVE') {
              throw new BadRequestException('Một số sản phẩm không còn kinh doanh hoặc không thuộc cửa hàng này');
            }
          }

          for (const pId of sortedProductIds) {
            const lockedRows: any[] = await tx.$queryRaw`
              SELECT product_id, quantity_on_hand, reserved_quantity
              FROM inventory
              WHERE product_id = ${pId} AND store_id = ${storeId}
              FOR UPDATE
            `;
            if (!lockedRows || lockedRows.length === 0) {
              throw new BadRequestException(`Sản phẩm không có thông tin kho hàng hoặc không thuộc cửa hàng này`);
            }
            const invRow = lockedRows[0];
            const onHand = Number(invRow.quantity_on_hand || 0);
            const reserved = Number(invRow.reserved_quantity || 0);
            const available = onHand - reserved;
            const requiredQty = quantities.get(pId.toString())!;
            if (available < requiredQty) {
              const prodInfo = await tx.product.findUnique({
                where: { productId: pId },
                select: { productName: true },
              });
              const name = prodInfo?.productName || 'Sản phẩm';
              throw new BadRequestException(
                `Sản phẩm "${name}" không đủ số lượng trong kho (còn ${Math.max(0, available)} sản phẩm)`,
              );
            }
          }

      // 4. Query active products with current discounts
      const products = await tx.product.findMany({
        where: {
          productId: { in: productIds },
          storeId,
          status: 'ACTIVE',
        },
        include: {
          inventory: true,
          discounts: {
            where: {
              status: 'ACTIVE',
              startAt: { lte: new Date() },
              endAt: { gte: new Date() },
            },
            orderBy: { discountId: 'desc' },
            take: 1,
          },
        },
      });

      if (products.length !== productIds.length) {
        throw new BadRequestException('Một số sản phẩm không còn kinh doanh hoặc không thuộc cửa hàng này');
      }

      // 5. Build items payload & calculate financials
      let subtotalAmount = 0;
      let discountAmount = 0;
      const orderItemsData: any[] = [];

      for (const product of products) {
        const qty = quantities.get(product.productId.toString())!;
        const unitPrice = Number(product.basePrice);
        const discount = product.discounts?.[0];
        let discountPercent = 0;
        let discountAmt = 0;
        if (discount) {
          if (discount.discountPercent != null) {
            discountPercent = Number(discount.discountPercent);
            discountAmt = Math.round((unitPrice * discountPercent) / 100);
          } else if (discount.discountAmount != null) {
            discountAmt = Number(discount.discountAmount);
          }
        }
        discountAmt = Math.min(unitPrice, Math.max(0, discountAmt));
        const finalUnitPrice = unitPrice - discountAmt;
        const itemSubtotal = finalUnitPrice * qty;

        subtotalAmount += unitPrice * qty;
        discountAmount += discountAmt * qty;

        orderItemsData.push({
          productId: product.productId,
          productNameSnapshot: product.productName,
          unitPriceSnapshot: unitPrice,
          discountPercentSnapshot: discountPercent,
          discountAmountSnapshot: discountAmt,
          finalUnitPrice,
          quantity: qty,
          itemSubtotal,
        });
      }

      const shippingFee = 0;
      const itemsSubtotalSum = orderItemsData.reduce((sum, item) => sum + item.itemSubtotal, 0);
      const totalAmount = Math.max(0, subtotalAmount - discountAmount + shippingFee);
      if (Math.abs(itemsSubtotalSum + shippingFee - totalAmount) > 0.01) {
        throw new BadRequestException('Lỗi tính toán tổng tiền đơn hàng không nhất quán');
      }

      // Enforce platform minimum order value (2,000 VND)
      if (totalAmount < MIN_ORDER_TOTAL_VND) {
        throw new BadRequestException({
          errorCode: 'ORDER_TOTAL_BELOW_MINIMUM',
          message: 'Giá trị đơn hàng tối thiểu là 2.000 VND',
        });
      }

      const commissionRate = store.commissionRate ? Number(store.commissionRate) : 8.0;
      const commissionAmount = Math.round(((totalAmount * commissionRate) / 100) * 100) / 100;
      const netAmount = Math.max(0, totalAmount - commissionAmount);

      // 6. Check customer profile if customerUserId is present
      let customerId: bigint | null = null;
      if (customerUserId) {
        const profile = await tx.customerProfile.findUnique({
          where: { userId: customerUserId },
        });
        if (profile) {
          customerId = profile.customerId;
        }
      }

      // 7. Order Code
      const orderCode = `WEB-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

      // 8. Create Order in DB
      const created = await tx.order.create({
        data: {
          orderCode,
          storeId,
          customerId,
          buttonId: null,
          orderStatus: 'PENDING',
          paymentStatus: 'UNPAID',
          paymentMethod: ['COD', 'CASH_ON_DELIVERY'].includes(paymentMethod) ? 'COD' : 'PAYOS',
          subtotalAmount,
          discountAmount,
          shippingFee,
          totalAmount,
          commissionRate,
          commissionAmount,
          netAmount,
          shippingRecipientName: customerName.trim(),
          shippingPhone: customerPhone.trim(),
          shippingAddress: deliveryAddress.trim(),
          orderNote: orderNote?.trim() || 'Đơn hàng mua trực tiếp từ cửa hàng trực tuyến (Storefront Web)',
          ...(cleanActorScope && cleanIdempKey
            ? {
                checkoutActorScope: cleanActorScope,
                checkoutIdempotencyKey: cleanIdempKey,
                checkoutRequestHash,
              }
            : {}),
          items: {
            create: orderItemsData,
          },
        },
        include: {
          items: true,
          store: { select: { storeId: true, name: true, phone: true } },
        },
      });

      // 9. Increment reserved quantities
      for (const item of orderItemsData) {
        await tx.inventory.update({
          where: { productId: item.productId },
          data: { reservedQuantity: { increment: item.quantity } },
        });
      }

      // 10. Record status history
      await tx.orderStatusHistory.create({
        data: {
          orderId: created.orderId,
          oldStatus: 'NONE',
          newStatus: 'PENDING',
          reason: 'Khách hàng đặt hàng trực tuyến qua Storefront Web',
        },
      });

      return created;
        }),
      { operationName: 'CreateStorefrontOrderTx' },
    );
  }
}

