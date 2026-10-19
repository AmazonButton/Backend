import { ALLOWED_ORDER_TRANSITIONS, OrderStatusType } from './dto/update-order-status.dto';
import { DeliverOrderDto } from './dto/deliver-order.dto';
import { DeliveryFailureDto } from './dto/delivery-failure.dto';
import { DriverOrdersQueryDto } from './dto/driver-orders-query.dto';
import { Injectable, Inject, NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrdersRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
        customer: { include: { user: true } },
        buttonProducts: { include: { product: true } },
      },
    });
  }

  async findButtonByDeviceId(deviceId: string) {
    return this.prisma.ioTButton.findUnique({
      where: { deviceId },
      include: {
        customer: true,
        store: true,
        buttonProducts: { include: { product: true } },
      },
    });
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

  async createOrderFallbackTx(button: any, paymentMethod: string, shippingFee: number, iotRequestId?: string): Promise<bigint> {
    return this.prisma.$transaction(async (tx) => {
      let subtotal = 0;
      const orderCode = `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

      const address = await tx.customerAddress.findFirst({
        where: { addressId: button.addressId },
      });
      const shippingAddress = address
        ? `${address.addressDetail}${address.ward ? ', ' + address.ward : ''}${address.district ? ', ' + address.district : ''}${address.province ? ', ' + address.province : ''}`
        : 'Địa chỉ mặc định của khách hàng';
      const recipientName = address?.recipientName || button.customer.user.fullName;
      const phone = address?.phone || button.customer.user.phone || '';

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
          subtotalAmount: 0,
          discountAmount: 0,
          totalAmount: shippingFee,
          shippingRecipientName: recipientName,
          shippingPhone: phone,
          shippingAddress,
          shippingLatitude: address?.latitude || null,
          shippingLongitude: address?.longitude || null,
          orderNote: 'Đơn hàng tự động từ nút bấm IoT',
          iotRequestId: iotRequestId || null,
        },
      });

      for (const bp of button.buttonProducts) {
        const lineSubtotal = Number(bp.product.basePrice) * bp.quantity;
        subtotal += lineSubtotal;

        await tx.orderItem.create({
          data: {
            orderId: createdOrder.orderId,
            productId: bp.productId,
            productNameSnapshot: bp.product.productName,
            unitPriceSnapshot: bp.product.basePrice,
            discountPercentSnapshot: 0,
            discountAmountSnapshot: 0,
            finalUnitPrice: bp.product.basePrice,
            quantity: bp.quantity,
            itemSubtotal: lineSubtotal,
          },
        });

        // Giữ chỗ tồn kho (Two-Phase Commit)
        await tx.inventory.updateMany({
          where: { productId: bp.productId },
          data: {
            reservedQuantity: { increment: bp.quantity },
          },
        });
      }

      const total = subtotal + shippingFee;
      const store = await tx.store.findUnique({
        where: { storeId: button.storeId },
        select: { commissionRate: true },
      });
      const commissionRate = store?.commissionRate ? Number(store.commissionRate) : 8.0;
      const commissionAmount = Math.round((total * commissionRate / 100) * 100) / 100;
      const netAmount = Math.max(0, total - commissionAmount);

      await tx.order.update({
        where: { orderId: createdOrder.orderId },
        data: {
          subtotalAmount: subtotal,
          totalAmount: total,
          commissionRate,
          commissionAmount,
          netAmount,
        },
      });

      return createdOrder.orderId;
    });
  }

  async findOrderById(orderId: bigint) {
    return this.prisma.order.findUnique({
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

  async findOrders(whereClause: any) {
    return this.prisma.order.findMany({
      where: whereClause,
      include: {
        items: { include: { product: true } },
        button: true,
        customer: { include: { user: true } },
        store: true,
      },
      orderBy: { orderDate: 'desc' },
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
    for (const item of items) {
      await this.prisma.inventory.updateMany({
        where: { productId: item.productId },
        data: {
          reservedQuantity: { decrement: item.quantity },
        },
      });
    }
  }

  async deductInventoryOnCompleted(items: { productId: bigint; quantity: number }[]) {
    for (const item of items) {
      await this.prisma.inventory.updateMany({
        where: { productId: item.productId },
        data: {
          quantityOnHand: { decrement: item.quantity },
          reservedQuantity: { decrement: item.quantity },
        },
      });
    }
  }

  async completeOrderAtomicTx(orderId: bigint): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
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

      // 2. Lock & Deduct inventory with reserved_quantity check
      const items = await tx.orderItem.findMany({ where: { orderId } });
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
          const wallets = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM store_wallets WHERE store_id = $1 FOR UPDATE`,
            storeId,
          );
          let wallet = wallets[0];
          if (!wallet) {
            wallet = await tx.storeWallet.create({
              data: {
                storeId,
                balance: 0,
                frozenBalance: 0,
              },
            });
          }

          const orderRef = `ORDER:${orderId}`;
          const existingTx = await tx.walletTransaction.findFirst({
            where: {
              walletId: wallet.walletId || wallet.wallet_id,
              referenceId: orderRef,
              type: 'ORDER_REVENUE',
            },
          });

          if (!existingTx) {
            const currentBal = Number(wallet.balance);
            const payoutAmount = order.net_amount ? Number(order.net_amount) : Math.round(Number(order.total_amount) * 0.92);
            const newBal = currentBal + payoutAmount;

            await tx.storeWallet.update({
              where: { walletId: wallet.walletId || wallet.wallet_id },
              data: { balance: newBal },
            });

            await tx.walletTransaction.create({
              data: {
                walletId: wallet.walletId || wallet.wallet_id,
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
    });
  }

  async cancelOrderAtomicTx(
    orderId: bigint,
    reason: string = 'Khách hàng hủy đơn',
    userId?: any,
    targetStatus: 'CANCELLED' | 'REJECTED' = 'CANCELLED',
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

      if (order.order_status === 'CANCELLED' || order.order_status === 'REJECTED') {
        // Idempotent: already terminal, do not release stock again
        return this.findOrderByIdTx(tx, orderId);
      }

      if (['COMPLETED', 'DELIVERED', 'SHIPPING'].includes(order.order_status)) {
        throw new BadRequestException('Đơn hàng đã được xử lý giao hàng hoặc hoàn tất, không thể hủy');
      }

      const items = await tx.orderItem.findMany({ where: { orderId } });
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

      if (userId) {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', $1, true)`,
          userId.toString(),
        );
      }

      await tx.order.update({
        where: { orderId },
        data: { orderStatus: targetStatus },
      });

      // Lịch sử trạng thái được tự động ghi nhận bởi DB trigger trg_sync_inventory_on_order_status_change

      return this.findOrderByIdTx(tx, orderId);
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

  async completeDeliveryAtomicTx(orderId: bigint, driverUser: any, dto: DeliverOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
        orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }
      const order = lockedOrders[0];

      if (driverUser.storeId && order.store_id.toString() !== driverUser.storeId.toString()) {
        throw new ForbiddenException('Bạn không có quyền xử lý đơn hàng của cửa hàng khác');
      }

      if (driverUser.role === 'STAFF_DELIVERY') {
        if (!order.assigned_driver_id || order.assigned_driver_id.toString() !== driverUser.userId.toString()) {
          throw new ForbiddenException('Bạn không phải tài xế được chỉ định cho đơn hàng này');
        }
      }

      if (order.order_status !== 'SHIPPING') {
        throw new BadRequestException(`Chỉ có thể hoàn tất giao hàng từ trạng thái SHIPPING (hiện tại: ${order.order_status})`);
      }

      let isValidPodUrl = false;
      try {
        const parsed = new URL(dto.podImageUrl);
        const isCloudinaryDomain = parsed.hostname === 'cloudinary.com' || parsed.hostname.endsWith('.cloudinary.com');
        const uploadIdx = parsed.pathname.indexOf('/image/upload/');
        if (isCloudinaryDomain && uploadIdx !== -1) {
          const pathAfterUpload = parsed.pathname.slice(uploadIdx + '/image/upload/'.length);
          const pathNoVersion = pathAfterUpload.replace(/^v\d+\//, '');
          if (pathNoVersion.startsWith(`stores/${order.store_id}/pod/`)) {
            isValidPodUrl = true;
          }
        }
      } catch (e) {
        isValidPodUrl = false;
      }

      if (!isValidPodUrl) {
        throw new BadRequestException(`Ảnh xác thực giao hàng (POD) phải là URL Cloudinary hợp lệ thuộc thư mục stores/${order.store_id}/pod/`);
      }

      const existingWithPod = await tx.order.findFirst({
        where: {
          podImageUrl: dto.podImageUrl,
          orderId: { not: orderId },
        },
      });
      if (existingWithPod) {
        throw new BadRequestException('Ảnh xác thực giao hàng (POD) này đã được sử dụng cho đơn hàng khác, không thể tái sử dụng');
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

      await tx.order.update({
        where: { orderId },
        data: {
          orderStatus: 'DELIVERED',
          paymentStatus: 'PAID',
          paymentMethod: dto.paymentMethod,
          podImageUrl: dto.podImageUrl,
          deliveredAt: deliveredAtDate,
        },
      });

      const driverId = order.assigned_driver_id;
      if (driverId) {
        const codAmount = dto.paymentMethod === 'COD' ? Number(order.total_amount) : 0;
        const vietqrAmount = dto.paymentMethod !== 'COD' ? Number(order.total_amount) : 0;
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

      return this.findOrderByIdTx(tx, orderId);
    });
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

      if (driverUser.storeId && order.store_id.toString() !== driverUser.storeId.toString()) {
        throw new ForbiddenException('Bạn không có quyền xử lý đơn hàng của cửa hàng khác');
      }

      if (driverUser.role === 'STAFF_DELIVERY') {
        if (!order.assigned_driver_id || order.assigned_driver_id.toString() !== driverUser.userId.toString()) {
          throw new ForbiddenException('Bạn không phải tài xế được chỉ định cho đơn hàng này');
        }
      }

      if (order.order_status !== 'SHIPPING') {
        throw new BadRequestException(`Chỉ có thể báo giao hàng thất bại từ trạng thái SHIPPING (hiện tại: ${order.order_status})`);
      }

      if (!dto.evidenceImageUrl) {
        throw new BadRequestException('Bắt buộc phải có ảnh bằng chứng giao hàng thất bại');
      }

      // Release reserved inventory back
      const items = await tx.orderItem.findMany({ where: { orderId } });
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

}
