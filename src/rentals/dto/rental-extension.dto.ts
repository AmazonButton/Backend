import { IsInt, Min, Max } from 'class-validator';

export class RentalExtensionDto {
  @IsInt({ message: 'Số tháng gia hạn phải là số nguyên' })
  @Min(1, { message: 'Số tháng gia hạn tối thiểu là 1 tháng' })
  @Max(24, { message: 'Số tháng gia hạn tối đa là 24 tháng' })
  additionalMonths: number;
}
