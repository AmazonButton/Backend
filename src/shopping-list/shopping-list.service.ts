import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ShoppingListService {
  constructor(private readonly prisma: PrismaService) {}

  async getHouseholdList(householdId: string) {
    let list = await this.prisma.shoppingList.findUnique({
      where: { householdId },
      include: {
        items: {
          include: { product: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!list) {
      list = await this.prisma.shoppingList.create({
        data: { householdId },
        include: {
          items: {
            include: { product: true },
            orderBy: { createdAt: 'desc' },
          },
        },
      });
    }

    return list;
  }

  async addItem(data: {
    householdId: string;
    productId: string;
    quantity?: number;
    userId?: string;
    addedFromDeviceId?: string;
  }) {
    let list = await this.prisma.shoppingList.findUnique({
      where: { householdId: data.householdId },
    });

    if (!list) {
      list = await this.prisma.shoppingList.create({
        data: { householdId: data.householdId },
      });
    }

    // Check if item already exists in list and is not checked
    const existing = await this.prisma.shoppingListItem.findFirst({
      where: {
        shoppingListId: list.id,
        productId: data.productId,
        isChecked: false,
      },
    });

    if (existing) {
      return this.prisma.shoppingListItem.update({
        where: { id: existing.id },
        data: {
          quantity: existing.quantity + (data.quantity || 1),
          addedFromDeviceId: data.addedFromDeviceId || existing.addedFromDeviceId,
        },
        include: { product: true },
      });
    }

    return this.prisma.shoppingListItem.create({
      data: {
        shoppingListId: list.id,
        productId: data.productId,
        quantity: data.quantity || 1,
        addedByUserId: data.userId,
        addedFromDeviceId: data.addedFromDeviceId,
      },
      include: { product: true },
    });
  }

  async toggleItem(itemId: string, isChecked: boolean) {
    return this.prisma.shoppingListItem.update({
      where: { id: itemId },
      data: { isChecked },
      include: { product: true },
    });
  }

  async removeItem(itemId: string) {
    return this.prisma.shoppingListItem.delete({
      where: { id: itemId },
    });
  }

  async batchOrder(householdId: string, userId: string) {
    const list = await this.getHouseholdList(householdId);
    const unpurchasedItems = list.items.filter((i) => !i.isChecked);

    if (unpurchasedItems.length === 0) {
      throw new BadRequestException('Danh sách mua sắm không có món hàng nào cần đặt.');
    }

    const household = await this.prisma.household.findUnique({
      where: { id: householdId },
    });

    const userProfile = await this.prisma.customerProfile.findUnique({
      where: { userId },
    });

    // Group items by storeId
    const storeGroups: Record<string, typeof unpurchasedItems> = {};
    for (const item of unpurchasedItems) {
      const sId = item.product.storeId;
      if (!storeGroups[sId]) storeGroups[sId] = [];
      storeGroups[sId].push(item);
    }

    const createdOrders: any[] = [];

    for (const [storeId, items] of Object.entries(storeGroups)) {
      let total = 0;
      const orderItemsData = items.map((i) => {
        const itemTotal = i.product.price * i.quantity;
        total += itemTotal;
        return {
          productId: i.productId,
          productName: i.product.name,
          quantity: i.quantity,
          unitPrice: i.product.price,
          totalPrice: itemTotal,
        };
      });

      const order = await this.prisma.order.create({
        data: {
          orderNumber: `SS-BATCH-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 90 + 10)}`,
          storeId,
          customerId: userProfile?.id || (await this.prisma.customerProfile.findFirst())!.id,
          householdId,
          totalAmount: total,
          status: 'PENDING',
          deliveryAddress: household?.address || userProfile?.deliveryAddress || 'Giao tại căn hộ',
          customerPhone: userProfile?.phone || '0988776655',
          customerName: userProfile ? 'Khách Hàng' : 'Cư Dân SmartSupply',
          cancelExpiresAt: new Date(Date.now() + 60000), // 60s cancellation window
          items: {
            create: orderItemsData,
          },
        },
        include: { items: true },
      });

      createdOrders.push(order);
    }

    // Mark list items as checked
    await this.prisma.shoppingListItem.updateMany({
      where: { shoppingListId: list.id, isChecked: false },
      data: { isChecked: true },
    });

    return {
      success: true,
      message: `Đã tạo thành công ${createdOrders.length} đơn hàng gộp từ danh sách mua sắm!`,
      orders: createdOrders,
    };
  }
}
