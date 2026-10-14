import { IsNotEmpty, IsString, IsIn, IsOptional, IsNumber, Min } from 'class-validator';

export class DeliverOrderDto {
  @IsNotEmpty({ message: 'Trạng thái phải là DELIVERED' })
  @IsString()
  @IsIn(['DELIVERED'], { message: 'Trạng thái phải là DELIVERED' })
  status: 'DELIVERED';

  @IsNotEmpty({ message: 'Phương thức thanh toán không được để trống' })
  @IsString()
  @IsIn(['COD', 'VIETQR', 'PAYOS'], { message: 'Phương thức thanh toán phải là COD, VIETQR hoặc PAYOS' })
  paymentMethod: string;

  @IsOptional()
  @IsNumber({}, { message: 'Số tiền thu phải là dạng số' })
  @Min(0, { message: 'Số tiền thu không được âm' })
  collectedAmount?: number;

  @IsNotEmpty({ message: 'Ảnh xác thực giao hàng (POD) không được để trống' })
  @IsString()
  podImageUrl: string;

  @IsOptional()
  @IsString()
  deliveredAt?: string;
}
