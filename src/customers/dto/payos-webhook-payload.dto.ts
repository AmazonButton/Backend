import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PayosWebhookPayloadDto {
  @ApiPropertyOptional({ description: 'URL Webhook dùng cho handshake ping xác nhận URL từ PayOS Dashboard' })
  @IsOptional()
  @IsString()
  webhookUrl?: string;

  @ApiPropertyOptional({ description: 'Trạng thái thành công theo contract PayOS', example: true })
  @IsOptional()
  @IsBoolean()
  success?: boolean;

  @ApiPropertyOptional({ description: 'Mã kết quả PayOS', example: '00' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional({ description: 'Mô tả thông điệp PayOS', example: 'success' })
  @IsOptional()
  @IsString()
  desc?: string;

  @ApiPropertyOptional({ description: 'Dữ liệu giao dịch đã ký của PayOS' })
  @IsOptional()
  @IsObject()
  data?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Chữ ký số HMAC-SHA256 của payload' })
  @IsOptional()
  @IsString()
  signature?: string;
}