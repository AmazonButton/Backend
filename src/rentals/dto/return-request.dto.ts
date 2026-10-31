import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateReturnRequestDto {
  @IsOptional()
  @IsString({ message: 'buttonId phải là chuỗi định danh' })
  buttonId?: string;

  @IsOptional()
  @IsString({ message: 'Lý do trả nút phải là chuỗi' })
  @MaxLength(500, { message: 'Lý do trả nút tối đa 500 ký tự' })
  reason?: string;
}

export class ConfirmReturnReceiptDto {
  @IsOptional()
  @IsString({ message: 'Ghi chú kiểm tra thiết bị phải là chuỗi' })
  @MaxLength(500, { message: 'Ghi chú kiểm tra thiết bị tối đa 500 ký tự' })
  inspectionNote?: string;
}
