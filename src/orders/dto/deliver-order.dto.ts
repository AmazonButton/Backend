import { IsNotEmpty, IsString, IsIn, IsOptional, IsNumber, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DeliverOrderDto {
  @ApiProperty({ example: 'DELIVERED', enum: ['DELIVERED'] })
  @IsNotEmpty({ message: 'Trạng thái phải là DELIVERED' })
  @IsString()
  @IsIn(['DELIVERED'], { message: 'Trạng thái phải là DELIVERED' })
  status: 'DELIVERED';

  @ApiProperty({ example: 'COD', enum: ['COD', 'VIETQR', 'PAYOS'] })
  @IsNotEmpty({ message: 'Phương thức thanh toán không được để trống' })
  @IsString()
  @IsIn(['COD', 'VIETQR', 'PAYOS'], { message: 'Phương thức thanh toán phải là COD, VIETQR hoặc PAYOS' })
  paymentMethod: string;

  @ApiPropertyOptional({ example: 50000, description: 'Số tiền mặt tài xế thu khi giao hàng (với COD)' })
  @IsOptional()
  @IsNumber({}, { message: 'Số tiền thu phải là dạng số' })
  @Min(0, { message: 'Số tiền thu không được âm' })
  collectedAmount?: number;

  @ApiPropertyOptional({
    example: 'https://res.cloudinary.com/demo/image/upload/stores/1/pod/image.jpg',
    description: 'URL ảnh Cloudinary (Legacy / tương thích ngược)',
  })
  @IsOptional()
  @IsString()
  podImageUrl?: string;

  @ApiPropertyOptional({
    example: 'stores/1/pod/2026/11/order_842_x8f9a.webp',
    description: 'Object Key trên Cloudflare R2 / AWS S3 (Target Architecture)',
  })
  @IsOptional()
  @IsString()
  podObjectKey?: string;

  @ApiPropertyOptional({ example: 10.8529241, description: 'Tọa độ vĩ độ thực tế của tài xế khi giao hàng' })
  @IsOptional()
  @IsNumber({}, { message: 'Tọa độ driverLatitude phải là dạng số' })
  driverLatitude?: number;

  @ApiPropertyOptional({ example: 106.6295123, description: 'Tọa độ kinh độ thực tế của tài xế khi giao hàng' })
  @IsOptional()
  @IsNumber({}, { message: 'Tọa độ driverLongitude phải là dạng số' })
  driverLongitude?: number;

  @ApiPropertyOptional({ example: '2026-11-15T13:10:25.000Z', description: 'Thời điểm hoàn tất giao hàng' })
  @IsOptional()
  @IsString()
  deliveredAt?: string;
}
