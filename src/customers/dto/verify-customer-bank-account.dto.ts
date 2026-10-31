import { IsNotEmpty, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyCustomerBankAccountDto {
  @ApiProperty({
    description: 'Mã tham chiếu phiên xác minh do hệ thống/ngân hàng cấp',
    example: 'CUST_VRF_970422_ABC123XYZ',
  })
  @IsNotEmpty({ message: 'Mã tham chiếu xác minh (proofReference) không được để trống' })
  @IsString({ message: 'proofReference phải là chuỗi ký tự' })
  @Length(8, 128, { message: 'proofReference phải có độ dài từ 8 đến 128 ký tự' })
  proofReference: string;
}
