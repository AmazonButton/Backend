import { IsNotEmpty, IsInt, Min, Max } from 'class-validator';

export class CreateRentalOrderDto {
  @IsNotEmpty()
  packageId: string | number;

  @IsInt({ message: 'Số tháng thuê phải là số nguyên' })
  @Min(1, { message: 'Số tháng thuê tối thiểu là 1 tháng' })
  @Max(12, { message: 'Thời gian thuê ban đầu tối đa là 12 tháng' })
  monthsRented: number;
}
