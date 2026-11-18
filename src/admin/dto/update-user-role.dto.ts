import { IsNotEmpty, IsString, IsIn, IsOptional, MaxLength } from 'class-validator';

const VALID_ROLES = [
  'SUPER_ADMIN',
  'SYSTEM_ADMIN',
  'ADMIN',
  'SYSTEM_STAFF',
  'STORE_OWNER',
  'CUSTOMER',
] as const;

const VALID_PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'SYSTEM_ADMIN',
  'ADMIN',
  'SYSTEM_STAFF',
] as const;

export class UpdateUserRoleDto {
  @IsNotEmpty({ message: 'Vai trò không được để trống' })
  @IsString()
  @IsIn([...VALID_ROLES], {
    message: `Vai trò phải là một trong: ${VALID_ROLES.join(', ')}`,
  })
  role: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class GrantPlatformRoleDto {
  @IsNotEmpty({ message: 'Vai trò hệ thống không được để trống' })
  @IsString()
  @IsIn([...VALID_PLATFORM_ROLES], {
    message: `Vai trò hệ thống phải là một trong: ${VALID_PLATFORM_ROLES.join(', ')}`,
  })
  roleCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RevokePlatformRoleDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
