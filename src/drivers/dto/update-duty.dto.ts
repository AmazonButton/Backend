import { IsNotEmpty, IsString, IsIn } from 'class-validator';

export class UpdateDutyDto {
  @IsNotEmpty({ message: 'Trạng thái hoạt động không được để trống' })
  @IsString()
  @IsIn(['ONLINE', 'OFFLINE'], { message: 'Trạng thái phải là ONLINE hoặc OFFLINE' })
  status: 'ONLINE' | 'OFFLINE';
}
