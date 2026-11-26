import { IsNotEmpty, IsString, IsOptional, IsInt, IsIn, Min, Max, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PresignedUploadDto {
  @ApiProperty({
    description: 'Mã ID của đơn hàng cần tải ảnh xác thực giao hàng (POD)',
    example: '842',
  })
  @IsNotEmpty({ message: 'Mã đơn hàng (orderId) không được để trống' })
  @IsString({ message: 'Mã đơn hàng phải là dạng chuỗi' })
  @Matches(/^[1-9]\d{0,18}$/, { message: 'Mã đơn hàng phải là số nguyên dương hợp lệ' })
  orderId: string;

  @ApiPropertyOptional({
    description: 'MIME type của ảnh (ưu tiên image/webp, image/jpeg, image/png)',
    example: 'image/webp',
    default: 'image/webp',
  })
  @IsOptional()
  @IsString()
  @IsIn(['image/webp', 'image/jpeg', 'image/png'], {
    message: 'Định dạng ảnh chỉ hỗ trợ image/webp, image/jpeg hoặc image/png',
  })
  contentType?: string;

  @ApiPropertyOptional({
    description: 'Dung lượng file tính bằng bytes (tối đa 5MB)',
    example: 245800,
  })
  @IsOptional()
  @IsInt({ message: 'fileSizeBytes phải là số nguyên' })
  @Min(1, { message: 'fileSizeBytes phải lớn hơn 0' })
  @Max(5 * 1024 * 1024, { message: 'Dung lượng ảnh không được vượt quá 5MB' })
  fileSizeBytes?: number;
}
