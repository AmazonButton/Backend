import { IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateStoreStaffDto {
  @IsOptional()
  @IsString()
  roleCode?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'ON_LEAVE', 'TERMINATED', 'INACTIVE'], {
    message: 'Trạng thái phải là ACTIVE, ON_LEAVE, TERMINATED hoặc INACTIVE',
  })
  status?: string;
}
