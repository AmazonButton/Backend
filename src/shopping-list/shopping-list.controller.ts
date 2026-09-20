import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards, Request } from '@nestjs/common';
import { ShoppingListService } from './shopping-list.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('shopping-list')
@UseGuards(JwtAuthGuard)
export class ShoppingListController {
  constructor(private readonly shoppingListService: ShoppingListService) {}

  @Get('household/:householdId')
  async getHouseholdList(@Param('householdId') householdId: string) {
    return this.shoppingListService.getHouseholdList(householdId);
  }

  @Post('household/:householdId/items')
  async addItem(
    @Param('householdId') householdId: string,
    @Body() body: { productId: string; quantity?: number },
    @Request() req: any,
  ) {
    return this.shoppingListService.addItem({
      householdId,
      productId: body.productId,
      quantity: body.quantity || 1,
      userId: req.user.userId,
    });
  }

  @Put('items/:itemId/toggle')
  async toggleItem(@Param('itemId') itemId: string, @Body('isChecked') isChecked: boolean) {
    return this.shoppingListService.toggleItem(itemId, isChecked);
  }

  @Delete('items/:itemId')
  async removeItem(@Param('itemId') itemId: string) {
    return this.shoppingListService.removeItem(itemId);
  }

  @Post('household/:householdId/batch-order')
  async batchOrder(@Param('householdId') householdId: string, @Request() req: any) {
    return this.shoppingListService.batchOrder(householdId, req.user.userId);
  }
}
