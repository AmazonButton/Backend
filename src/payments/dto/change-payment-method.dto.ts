import { IsNotEmpty, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePaymentMethodDto {
  @ApiProperty({ description: 'Phương thức thanh toán mới', enum: ['PAYOS', 'COD'], example: 'PAYOS' })
  @IsNotEmpty({ message: 'Vui lòng cung cấp phương thức thanh toán mới' })
  @IsIn(['PAYOS', 'COD'], { message: 'Phương thức thanh toán chỉ hỗ trợ PAYOS hoặc COD' })
  paymentMethod: string;
}
