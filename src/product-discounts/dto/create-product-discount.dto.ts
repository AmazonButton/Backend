import { IsNotEmpty, IsOptional, IsNumber, IsDateString, IsIn, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductDiscountDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'discountPercent phải là số' })
  @Min(0, { message: 'discountPercent tối thiểu là 0' })
  @Max(100, { message: 'discountPercent tối đa là 100' })
  discountPercent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'discountAmount phải là số' })
  @Min(0, { message: 'discountAmount tối thiểu là 0' })
  discountAmount?: number;

  @IsNotEmpty({ message: 'startAt không được để trống' })
  @IsDateString({}, { message: 'startAt phải là định dạng ISO 8601 hợp lệ' })
  startAt: string;

  @IsNotEmpty({ message: 'endAt không được để trống' })
  @IsDateString({}, { message: 'endAt phải là định dạng ISO 8601 hợp lệ' })
  endAt: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'], { message: 'status chỉ có thể là ACTIVE hoặc INACTIVE' })
  status?: string;
}
