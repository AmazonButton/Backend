import { IsNotEmpty, IsString, IsArray, ArrayNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class AssignFulfillmentDto {
  @IsNotEmpty({ message: 'fulfillmentStoreId không được để trống' })
  @IsString({ message: 'fulfillmentStoreId phải là chuỗi định danh cửa hàng' })
  fulfillmentStoreId: string;

  @IsArray({ message: 'buttonIds phải là một mảng chuỗi mã/ID thiết bị' })
  @ArrayNotEmpty({ message: 'Danh sách buttonIds không được rỗng' })
  @IsString({ each: true, message: 'Mỗi phần tử trong buttonIds phải là chuỗi' })
  buttonIds: string[];

  @IsOptional()
  @IsString({ message: 'Ghi chú phải là chuỗi' })
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  notes?: string;
}
