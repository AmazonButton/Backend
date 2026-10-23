import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { RegisterFcmTokenDto } from './dto/register-fcm-token.dto';
import { UnregisterFcmTokenDto } from './dto/unregister-fcm-token.dto';
import { QueryNotificationsDto } from './dto/query-notifications.dto';

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notificationsService: NotificationsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Xem danh sách thông báo của người dùng hiện tại (phân trang)' })
  @ApiResponse({ status: 200, description: 'Lấy danh sách thông báo thành công' })
  async getNotifications(
    @Request() req: any,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryNotificationsDto,
  ) {
    const userId = req.user?.id || req.user?.userId;
    return this.notificationsService.getNotifications(userId, query);
  }

  @Get('unread-count')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lấy số lượng thông báo chưa đọc của người dùng hiện tại' })
  @ApiResponse({ status: 200, description: 'Lấy số lượng thông báo chưa đọc thành công' })
  async getUnreadCount(@Request() req: any) {
    const userId = req.user?.id || req.user?.userId;
    return this.notificationsService.getUnreadCount(userId);
  }

  @Patch(':id/read')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Đánh dấu một thông báo là đã đọc (chống IDOR)' })
  @ApiResponse({ status: 200, description: 'Đánh dấu đã đọc thành công' })
  async markAsRead(@Request() req: any, @Param('id') id: string) {
    const userId = req.user?.id || req.user?.userId;
    return this.notificationsService.markAsRead(id, userId);
  }

  @Patch('read-all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Đánh dấu tất cả thông báo của người dùng là đã đọc' })
  @ApiResponse({ status: 200, description: 'Đánh dấu tất cả đã đọc thành công' })
  async markAllAsRead(@Request() req: any) {
    const userId = req.user?.id || req.user?.userId;
    return this.notificationsService.markAllAsRead(userId);
  }

  @Post('fcm-token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Đăng ký hoặc cập nhật FCM Token cho thiết bị người dùng' })
  @ApiResponse({ status: 200, description: 'Đăng ký FCM token thành công' })
  async registerFcmToken(
    @Request() req: any,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: RegisterFcmTokenDto }))
    dto: RegisterFcmTokenDto,
  ) {
    const userId = req.user?.id || req.user?.userId;
    return this.notificationsService.registerFcmToken(userId, dto);
  }

  @Delete('fcm-token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Hủy đăng ký FCM Token (vô hiệu hóa khi logout hoặc tắt thông báo)' })
  @ApiResponse({ status: 200, description: 'Hủy FCM token thành công' })
  async unregisterFcmToken(
    @Request() req: any,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: UnregisterFcmTokenDto }))
    dto: UnregisterFcmTokenDto,
  ) {
    const userId = req.user?.id || req.user?.userId;
    return this.notificationsService.unregisterFcmToken(userId, dto.token);
  }
}
