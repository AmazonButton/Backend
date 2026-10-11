import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SubscribePlanDto {
  @IsNotEmpty({ message: 'Mã gói cước (planId) không được để trống' })
  planId: string | number;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
