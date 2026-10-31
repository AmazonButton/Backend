import { IsInt, Min, Max, NotEquals, IsNotEmpty, IsString, MinLength, MaxLength } from 'class-validator';

export class AdminAdjustDurationDto {
  @IsInt({ message: 'Số ngày điều chỉnh phải là số nguyên' })
  @Min(-365, { message: 'Số ngày điều chỉnh tối thiểu là -365 ngày' })
  @Max(365, { message: 'Số ngày điều chỉnh tối đa là 365 ngày' })
  @NotEquals(0, { message: 'Số ngày điều chỉnh không được bằng 0' })
  additionalDays: number;

  @IsNotEmpty({ message: 'Lý do điều chỉnh không được để trống' })
  @IsString({ message: 'Lý do điều chỉnh phải là chuỗi' })
  @MinLength(5, { message: 'Lý do điều chỉnh phải có ít nhất 5 ký tự' })
  @MaxLength(500, { message: 'Lý do điều chỉnh tối đa 500 ký tự' })
  reason: string;
}
