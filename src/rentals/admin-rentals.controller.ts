import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { RentalsService } from './rentals.service';
import { OutboxConsumerService } from './outbox-consumer.service';
import { AssignFulfillmentDto } from './dto/assign-fulfillment.dto';
import { AdminAdjustDurationDto } from './dto/admin-adjust-duration.dto';
import { AdminConfirmPayoutDto } from './dto/admin-confirm-payout.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
@Controller('admin/rentals')
export class AdminRentalsController {
  constructor(
    private readonly rentalsService: RentalsService,
    private readonly outboxConsumerService: OutboxConsumerService,
  ) {}

  @Get()
  async listAllRentals(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
  ) {
    const result = await this.rentalsService.listAllRentalsAdmin({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      status,
    });

    return buildPaginatedResponse(
      result.items,
      result.total,
      result.page,
      result.pageSize,
      'Lấy danh sách hợp đồng thuê thành công',
    );
  }

  @Patch(':id/status')
  async updateRentalStatus(
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    const data = await this.rentalsService.updateRentalStatusAdmin(id, status);
    return {
      success: true,
      message: 'Cập nhật trạng thái hợp đồng thuê thành công',
      data,
    };
  }

  @Post(':id/assign-fulfillment')
  async assignFulfillment(
    @Param('id') id: string,
    @Body() body: AssignFulfillmentDto,
    @Request() req: any,
  ) {
    const data = await this.rentalsService.assignFulfillmentAndDevicesAdmin(id, body, req.user);
    return {
      success: true,
      message: 'Gán cửa hàng xử lý và thiết bị nút bấm thành công',
      data,
    };
  }

  @Post(':id/handover')
  async handoverRental(
    @Param('id') id: string,
    @Request() req: any,
  ) {
    const data = await this.rentalsService.handoverRental(id, req.user);
    return {
      success: true,
      message: 'Bàn giao thiết bị và kích hoạt thời hạn thuê thành công',
      data,
    };
  }

  @Roles('SUPER_ADMIN')
  @Post('refunds/:refundId/confirm-payout')
  async confirmPayout(
    @Param('refundId') refundId: string,
    @Body() body: AdminConfirmPayoutDto,
    @Request() req: any,
  ) {
    const data = await this.rentalsService.confirmDepositRefundPayout(
      refundId,
      req.user,
      body?.providerReferenceId,
    );
    return {
      success: true,
      message: 'Đối soát và xác nhận hoàn tất chi trả Payout thành công',
      data,
    };
  }

  @Post(':id/adjust-duration')
  async adjustDuration(
    @Param('id') id: string,
    @Body() body: AdminAdjustDurationDto,
    @Request() req: any,
  ) {
    const data = await this.rentalsService.adjustRentalDurationAdmin(
      id,
      body.additionalDays,
      body.reason,
      req.user,
    );
    return {
      success: true,
      message: 'Điều chỉnh thời hạn thuê thành công',
      data,
    };
  }

  @Post('outbox/process')
  async processOutbox(
    @Query('batchSize') batchSize?: string,
  ) {
    const data = await this.outboxConsumerService.processPendingEvents(
      batchSize ? Number(batchSize) : 10,
    );
    return {
      success: true,
      message: 'Xử lý hàng đợi outbox hoàn tất',
      data,
    };
  }
}
