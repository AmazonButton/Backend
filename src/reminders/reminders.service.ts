import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RemindersService {
  constructor(private readonly prisma: PrismaService) {}

  async getHouseholdReminders(householdId: string) {
    return this.prisma.smartReminder.findMany({
      where: { householdId },
      include: { product: true },
      orderBy: { expectedDate: 'asc' },
    });
  }

  async snoozeReminder(reminderId: string, days: number = 3) {
    const reminder = await this.prisma.smartReminder.findUnique({
      where: { id: reminderId },
    });
    if (!reminder) throw new NotFoundException('Không tìm thấy nhắc nhở');

    const newDate = new Date(Date.now() + days * 24 * 3600 * 1000);
    return this.prisma.smartReminder.update({
      where: { id: reminderId },
      data: {
        status: 'SNOOZED',
        expectedDate: newDate,
      },
    });
  }

  async dismissReminder(reminderId: string) {
    return this.prisma.smartReminder.update({
      where: { id: reminderId },
      data: { status: 'DISMISSED' },
    });
  }

  async convertToShoppingList(reminderId: string, userId: string) {
    const reminder = await this.prisma.smartReminder.findUnique({
      where: { id: reminderId },
      include: { household: { include: { shoppingList: true } } },
    });

    if (!reminder) throw new NotFoundException('Không tìm thấy nhắc nhở');

    let listId = reminder.household.shoppingList?.id;
    if (!listId) {
      const newList = await this.prisma.shoppingList.create({
        data: { householdId: reminder.householdId },
      });
      listId = newList.id;
    }

    await this.prisma.shoppingListItem.create({
      data: {
        shoppingListId: listId,
        productId: reminder.productId,
        quantity: 1,
        addedByUserId: userId,
      },
    });

    return this.prisma.smartReminder.update({
      where: { id: reminderId },
      data: { status: 'ADDED_TO_LIST' },
    });
  }
}
