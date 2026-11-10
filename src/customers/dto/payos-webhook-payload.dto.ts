import { IsObject, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PayosWebhookPayloadDto {
  @ApiPropertyOptional({ description: 'Mã kết quả PayOS', example: '00' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional({ description: 'Mô tả thông điệp PayOS', example: 'success' })
  @IsOptional()
  @IsString()
  desc?: string;

  @ApiPropertyOptional({ description: 'Dữ liệu giao dịch đã ký của PayOS' })
  @IsObject()
  data!: Record<string, any>;

  @ApiPropertyOptional({ description: 'Chữ ký số HMAC-SHA256 của payload' })
  @IsString()
  signature!: string;
}
