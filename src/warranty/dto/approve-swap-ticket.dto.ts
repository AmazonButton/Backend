import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ApproveSwapTicketDto {
  @ApiPropertyOptional({
    description: 'Mã device_id nút mới xuất kho thay thế (nếu có sẵn)',
    example: 'SOB-000088',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  replacementDeviceId?: string;

  @ApiPropertyOptional({
    description: 'Ghi chú phê duyệt của Admin',
    example: 'Đã xuất nút mới thay thế từ kho trung tâm',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adminNote?: string;
}
