import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsArray,
  IsBoolean,
  IsInt,
  Min,
  Max,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PayosPayoutItemDto {
  @IsString({ message: 'referenceId phải là chuỗi' })
  @IsNotEmpty({ message: 'referenceId không được để trống' })
  referenceId: string;

  @IsNumber({}, { message: 'amount phải là số tiền nguyên' })
  @Min(1000, { message: 'Số tiền chi tối thiểu là 1,000 VND' })
  amount: number;

  @IsString({ message: 'description phải là chuỗi' })
  @IsNotEmpty({ message: 'description không được để trống' })
  description: string;

  @IsString({ message: 'toBin phải là chuỗi' })
  @Matches(/^\d{6}$/, { message: 'toBin phải là 6 chữ số BIN ngân hàng (VD: 970422 cho MBBank)' })
  toBin: string;

  @IsString({ message: 'toAccountNumber phải là chuỗi' })
  @IsNotEmpty({ message: 'toAccountNumber không được để trống' })
  toAccountNumber: string;
}

export class CreatePayosBatchPayoutDto {
  @IsString({ message: 'referenceId phải là chuỗi' })
  @IsNotEmpty({ message: 'referenceId không được để trống' })
  referenceId: string;

  @IsOptional()
  @IsArray({ message: 'category phải là một mảng chuỗi' })
  @IsString({ each: true, message: 'Mỗi phần tử trong category phải là chuỗi' })
  category?: string[];

  @IsOptional()
  @IsBoolean({ message: 'validateDestination phải là boolean' })
  validateDestination?: boolean;

  @IsArray({ message: 'payouts phải là mảng danh sách lệnh chi' })
  @ValidateNested({ each: true })
  @Type(() => PayosPayoutItemDto)
  payouts: PayosPayoutItemDto[];
}

export class EstimatePayoutCreditDto extends CreatePayosBatchPayoutDto {}

export class ListPayosPayoutsQueryDto {
  @IsOptional()
  @IsString()
  referenceId?: string;

  @IsOptional()
  @IsString()
  approvalState?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit phải là số nguyên' })
  @Min(1, { message: 'limit tối thiểu là 1' })
  @Max(100, { message: 'limit tối đa là 100' })
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset phải là số nguyên' })
  @Min(0, { message: 'offset không được âm' })
  offset?: number;
}
