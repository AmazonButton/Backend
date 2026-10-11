import { IsNotEmpty, IsOptional, IsString, Length, Matches, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class SubscribePlanDto {
  @IsNotEmpty({ message: 'Mã gói cước (planId) không được để trống' })
  @Type(() => Number)
  @IsInt({ message: 'Mã gói cước (planId) phải là số nguyên hợp lệ' })
  @Min(1, { message: 'Mã gói cước (planId) phải lớn hơn hoặc bằng 1' })
  planId: number;

  @IsOptional()
  @IsString({ message: 'Idempotency key phải là chuỗi ký tự' })
  @Length(1, 128, { message: 'Idempotency key phải có độ dài từ 1 đến 128 ký tự' })
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'Idempotency key chỉ được chứa các ký tự chữ, số và các ký tự: . _ : -',
  })
  idempotencyKey?: string;
}
