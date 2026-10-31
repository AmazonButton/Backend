import { IsOptional, IsString, IsNotEmpty, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class AdminConfirmPayoutDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Mã providerReferenceId phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Mã providerReferenceId không được là chuỗi rỗng' })
  @MinLength(1, { message: 'Mã providerReferenceId tối thiểu 1 ký tự' })
  @MaxLength(100, { message: 'Mã providerReferenceId tối đa 100 ký tự' })
  providerReferenceId?: string;
}
