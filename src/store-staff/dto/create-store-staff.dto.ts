import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateStoreStaffDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  userIdentifier?: string; // username, email, or phone

  @IsNotEmpty({ message: 'Mã vai trò không được để trống' })
  @IsString()
  roleCode: string;
}
