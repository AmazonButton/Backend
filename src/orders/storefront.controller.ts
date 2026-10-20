import { BadRequestException, Body, Controller, Inject, Post, Request, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../websocket/events.gateway';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';

@UseGuards(OptionalJwtAuthGuard)
@Controller('storefront/orders')
export class StorefrontController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EventsGateway) private readonly events: EventsGateway,
  ) {}

  @Post()
  async checkout(@Request() req: any, @Body() body: any) {
    const { storeId, items, customerName, customerPhone, deliveryAddress, paymentMethod } = body || {};
    if (!storeId || !Array.isArray(items) || !items.length || !customerName?.trim() || !customerPhone?.trim() || !deliveryAddress?.trim()) {
      throw new BadRequestException('Vui lòng nhập thông tin nhận hàng và sản phẩm cần mua');
    }
    if (!['PAYOS', 'CASH_ON_DELIVERY'].includes(paymentMethod)) {
      throw new BadRequestException('Phương thức thanh toán không hợp lệ');
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const quantities = new Map<string, number>();
      for (const item of items) {
        const productId = String(item.productId || '');
        const quantity = Number(item.quantity);
        if (!productId || !Number.isInteger(quantity) || quantity < 1) throw new BadRequestException('Số lượng sản phẩm không hợp lệ');
        quantities.set(productId, (quantities.get(productId) || 0) + quantity);
      }
      const productIds = [...quantities.keys()];
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, storeId, isActive: true, status: 'ACTIVE', store: { status: 'ACTIVE' } },
      });
      if (products.length !== productIds.length) throw new BadRequestException('Một số sản phẩm không còn bán');
      const normalized = productIds.map((productId) => {
        const product = products.find((p) => p.id === productId);
        const quantity = quantities.get(productId)!;
        if (!product || !Number.isFinite(quantity) || quantity < 1 || product.stock - product.reservedStock < quantity) {
          throw new BadRequestException(`Sản phẩm ${product?.name || ''} không đủ số lượng trong kho`);
        }
        return { productId: product.id, productName: product.name, quantity, unitPrice: product.price, totalPrice: product.price * quantity };
      });
      const totalAmount = normalized.reduce((sum, item) => sum + item.totalPrice, 0);
      const orderNumber = `WEB-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
      const created = await tx.order.create({
        data: {
          orderNumber, storeId,
          customerId: req.user?.role === 'CUSTOMER' ? req.user.customerProfileId || null : null,
          status: 'PENDING', paymentMethod,
          paymentStatus: paymentMethod === 'CASH_ON_DELIVERY' ? 'COD_DUE' : 'PENDING',
          totalAmount, customerName: customerName.trim(), customerPhone: customerPhone.trim(), deliveryAddress: deliveryAddress.trim(),
          items: { create: normalized },
        }, include: { items: true, store: { select: { id: true, name: true } } },
      });
      for (const item of normalized) await tx.product.update({ where: { id: item.productId }, data: { reservedStock: { increment: item.quantity } } });
      return created;
    });
    this.events.emitToStore(storeId, 'ORDER_CREATED', { order, storeId, customerId: null });
    return { success: true, data: order };
  }
}
