import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { WarrantyFaultGroupEnum } from './create-warranty-ticket.dto';

export enum WarrantyTicketStatusEnum {
  PENDING = 'PENDING',
  APPROVED_SWAP = 'APPROVED_SWAP',
  RESOLVED = 'RESOLVED',
  REJECTED = 'REJECTED',
}

export class QueryWarrantyTicketDto {
  @ApiPropertyOptional({ description: 'Số trang (mặc định: 1)', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Kích thước trang (mặc định: 20, tối đa: 100)', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @ApiPropertyOptional({ description: 'Lọc theo trạng thái phiếu', enum: WarrantyTicketStatusEnum })
  @IsOptional()
  @IsEnum(WarrantyTicketStatusEnum)
  status?: WarrantyTicketStatusEnum;

  @ApiPropertyOptional({ description: 'Lọc theo nhóm lỗi', enum: WarrantyFaultGroupEnum })
  @IsOptional()
  @IsEnum(WarrantyFaultGroupEnum)
  faultGroup?: WarrantyFaultGroupEnum;

  @ApiPropertyOptional({ description: 'Lọc theo mã thiết bị deviceId' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Lọc theo cửa hàng (Chỉ Admin mới có quyền đổi storeId)' })
  @IsOptional()
  storeId?: string | number;
}
