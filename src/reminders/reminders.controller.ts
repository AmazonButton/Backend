import { Controller, Get, Post, Put, Param, Body, UseGuards, Request } from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('reminders')
@UseGuards(JwtAuthGuard)
export class RemindersController {
  constructor(private readonly remindersService: RemindersService) {}

  @Get('household/:householdId')
  async getHouseholdReminders(@Param('householdId') householdId: string) {
    return this.remindersService.getHouseholdReminders(householdId);
  }

  @Put(':id/snooze')
  async snoozeReminder(@Param('id') id: string, @Body('days') days?: number) {
    return this.remindersService.snoozeReminder(id, days || 3);
  }

  @Put(':id/dismiss')
  async dismissReminder(@Param('id') id: string) {
    return this.remindersService.dismissReminder(id);
  }

  @Post(':id/convert-to-list')
  async convertToList(@Param('id') id: string, @Request() req: any) {
    return this.remindersService.convertToShoppingList(id, req.user.userId);
  }
}
