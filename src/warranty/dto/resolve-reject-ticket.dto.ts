import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ResolveRejectTicketDto {
  @ApiPropertyOptional({
    description: 'Ghi chú đóng phiếu hoặc lý do từ chối bảo hành của Admin',
    example: 'Thiết bị đã xử lý xong hoặc không đủ điều kiện bảo hành',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adminNote?: string;
}
