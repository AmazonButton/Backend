import { IsNotEmpty, IsString, IsIn, IsOptional } from 'class-validator';

export const VALID_DELIVERY_FAILURE_CODES = [
  'CUSTOMER_UNREACHABLE',
  'WRONG_ADDRESS',
  'CUSTOMER_REJECTED',
  'GOODS_DAMAGED_IN_TRANSIT',
] as const;

export type DeliveryFailureCodeType = (typeof VALID_DELIVERY_FAILURE_CODES)[number];

export class DeliveryFailureDto {
  @IsNotEmpty({ message: 'Mã lý do giao hàng thất bại không được để trống' })
  @IsString()
  @IsIn([...VALID_DELIVERY_FAILURE_CODES], {
    message: `Lý do phải là một trong: ${VALID_DELIVERY_FAILURE_CODES.join(', ')}`,
  })
  failureReasonCode: DeliveryFailureCodeType;

  @IsOptional()
  @IsString()
  failureNote?: string;

  @IsNotEmpty({ message: 'Ảnh chụp bằng chứng không được để trống' })
  @IsString()
  evidenceImageUrl: string;
}
