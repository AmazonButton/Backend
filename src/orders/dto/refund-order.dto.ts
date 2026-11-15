import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RefundOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  refundReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  adminNote?: string;
}
