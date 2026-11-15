import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export enum WarrantyFaultGroupEnum {
  GROUP_A = 'GROUP_A',
  GROUP_B = 'GROUP_B',
  GROUP_C = 'GROUP_C',
  GROUP_D = 'GROUP_D',
}

export class CreateWarrantyTicketDto {
  @ApiProperty({ description: 'Mã device_id phần cứng của nút (VD: SOB-000003)', example: 'SOB-000003' })
  @IsNotEmpty({ message: 'Mã thiết bị không được để trống' })
  @IsString()
  @MaxLength(64)
  deviceId: string;

  @ApiPropertyOptional({ description: 'Mã cửa hàng sở hữu (tùy chọn nếu Admin tạo)', example: 1 })
  @IsOptional()
  storeId?: number | string;

  @ApiProperty({
    description: 'Nhóm lỗi phân loại: GROUP_A | GROUP_B | GROUP_C | GROUP_D',
    enum: WarrantyFaultGroupEnum,
    example: 'GROUP_A',
  })
  @IsNotEmpty({ message: 'Nhóm lỗi không được để trống' })
  @IsEnum(WarrantyFaultGroupEnum, { message: 'Nhóm lỗi phải là GROUP_A, GROUP_B, GROUP_C hoặc GROUP_D' })
  faultGroup: WarrantyFaultGroupEnum;

  @ApiProperty({
    description: 'Mã chi tiết lỗi: LOW_BATTERY, BUTTON_STUCK, TIER_C_SHELL_CRACK_30%, WATER_DAMAGE,...',
    example: 'LOW_BATTERY',
  })
  @IsNotEmpty({ message: 'Mã lỗi chi tiết không được để trống' })
  @IsString()
  @MaxLength(64)
  faultCode: string;

  @ApiPropertyOptional({ description: 'Tiền cọc ban đầu của nút (mặc định 100.000đ)', example: 100000 })
  @IsOptional()
  @IsNumber({}, { message: 'Tiền cọc phải là dạng số' })
  @Min(0, { message: 'Tiền cọc không được âm' })
  depositAmount?: number;

  @ApiPropertyOptional({ description: 'Tỷ lệ khấu trừ cọc (%) theo quy chuẩn nhóm lỗi', example: 0 })
  @IsOptional()
  @IsNumber({}, { message: 'Tỷ lệ khấu trừ phải là dạng số' })
  deductionPercent?: number;

  @ApiPropertyOptional({ description: 'Ghi chú kiểm tra tình trạng lỗi của nhân viên', example: 'Nút liệt phím không nảy' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  inspectionNote?: string;
}
