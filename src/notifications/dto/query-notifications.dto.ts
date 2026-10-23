import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryNotificationsDto {
  @ApiPropertyOptional({ description: 'Trang cần xem (bắt đầu từ 1)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Trang phải là số nguyên' })
  @Min(1, { message: 'Trang phải lớn hơn hoặc bằng 1' })
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Số lượng thông báo trên một trang (tối đa 100)', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'PageSize phải là số nguyên' })
  @Min(1, { message: 'PageSize phải lớn hơn hoặc bằng 1' })
  @Max(100, { message: 'PageSize tối đa là 100' })
  pageSize?: number = 20;
}
