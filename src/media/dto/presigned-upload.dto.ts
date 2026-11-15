import { IsNotEmpty, IsString, IsOptional, IsNumber, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PresignedUploadDto {
  @ApiProperty({
    description: 'Mã ID của đơn hàng cần tải ảnh xác thực giao hàng (POD)',
    example: '842',
  })
  @IsNotEmpty({ message: 'Mã đơn hàng (orderId) không được để trống' })
  @IsString({ message: 'Mã đơn hàng phải là dạng chuỗi' })
  @Matches(/^\d+$/, { message: 'Mã đơn hàng phải là số hợp lệ' })
  orderId: string;

  @ApiPropertyOptional({
    description: 'MIME type của ảnh (ưu tiên image/webp, image/jpeg, image/png)',
    example: 'image/webp',
    default: 'image/webp',
  })
  @IsOptional()
  @IsString()
  contentType?: string;

  @ApiPropertyOptional({
    description: 'Dung lượng file tính bằng bytes (khuyến nghị < 350KB)',
    example: 245800,
  })
  @IsOptional()
  @IsNumber({}, { message: 'fileSizeBytes phải là dạng số' })
  fileSizeBytes?: number;
}
