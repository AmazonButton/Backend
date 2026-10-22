import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../websocket/events.gateway';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CreateStorefrontOrderDto } from './dto/create-storefront-order.dto';

@UseGuards(OptionalJwtAuthGuard)
@Controller('storefront/orders')
export class StorefrontController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EventsGateway) private readonly events: EventsGateway,
  ) {}

  @Post()
  async checkout(@Request() req: any, @Body() body: CreateStorefrontOrderDto) {
    const { storeId: rawStoreId, items, customerName, customerPhone, deliveryAddress, paymentMethod, orderNote } = body;

    let storeId: bigint;
    try {
      storeId = BigInt(rawStoreId);
    } catch {
      throw new BadRequestException('Mã cửa hàng storeId không hợp lệ');
    }

    const createdOrder = await this.prisma.$transaction(async (tx) => {
      // 1. Verify Store
      const store = await tx.store.findUnique({
        where: { storeId },
        select: { storeId: true, name: true, status: true, commissionRate: true },
      });
      if (!store || store.status !== 'ACTIVE') {
        throw new BadRequestException('Cửa hàng không tồn tại hoặc tạm ngưng hoạt động');
      }

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
        // A cart can outlive a catalog migration or a deleted product. Never
        // let an invalid client-side id turn into an unhandled RangeError/500.
        throw new BadRequestException('Giỏ hàng có sản phẩm không còn hợp lệ. Vui lòng tải lại danh mục và chọn lại sản phẩm.');
      }

      // 3. Query active products with current inventory & discounts
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

      // 4. Validate stock & build items payload
      let subtotalAmount = 0;
      let discountAmount = 0;
      const orderItemsData: any[] = [];

      for (const product of products) {
        const qty = quantities.get(product.productId.toString())!;
        const inv = product.inventory;
        const available = (inv?.quantityOnHand || 0) - (inv?.reservedQuantity || 0);

        if (available < qty) {
          throw new BadRequestException(
            `Sản phẩm "${product.productName}" không đủ số lượng trong kho (còn ${Math.max(0, available)} sản phẩm)`,
          );
        }

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
        const finalUnitPrice = Math.max(0, unitPrice - discountAmt);
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
      const totalAmount = Math.max(0, subtotalAmount - discountAmount + shippingFee);
      const commissionRate = store.commissionRate ? Number(store.commissionRate) : 8.0;
      const commissionAmount = Math.round(((totalAmount * commissionRate) / 100) * 100) / 100;
      const netAmount = Math.max(0, totalAmount - commissionAmount);

      // 5. Check if user is authenticated customer
      let customerId: bigint | null = null;
      if (req.user?.userId) {
        const profile = await tx.customerProfile.findUnique({
          where: { userId: BigInt(req.user.userId) },
        });
        if (profile) {
          customerId = profile.customerId;
        }
      }

      // 6. Generate order code
      const orderCode = `WEB-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

      // 7. Create Order in Database
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
          items: {
            create: orderItemsData,
          },
        },
        include: {
          items: true,
          store: { select: { storeId: true, name: true, phone: true } },
        },
      });

      // 8. Update Inventory reserved quantities
      for (const item of orderItemsData) {
        await tx.inventory.update({
          where: { productId: item.productId },
          data: { reservedQuantity: { increment: item.quantity } },
        });
      }

      // 9. Record status history
      await tx.orderStatusHistory.create({
        data: {
          orderId: created.orderId,
          oldStatus: 'NONE',
          newStatus: 'PENDING',
          reason: 'Khách hàng đặt hàng trực tuyến qua Storefront Web',
        },
      });

      return created;
    });

    // 10. Realtime notification to store dashboard & customer
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
        items: createdOrder.items.map((it) => ({
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

    this.events.emitToStore(storeId.toString(), 'ORDER_CREATED', orderPayload);
    if (createdOrder.customerId) {
      this.events.emitToCustomer(createdOrder.customerId.toString(), 'ORDER_CREATED', orderPayload);
    }

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
        items: createdOrder.items.map((it) => ({
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
