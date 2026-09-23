import { IsNotEmpty, IsString, IsIn } from 'class-validator';

const VALID_ROLES = [
  'SUPER_ADMIN',
  'STORE_OWNER',
  'STORE_MANAGER',
  'STORE_STAFF',
  'CUSTOMER',
  'TECHNICIAN',
] as const;

export class UpdateUserRoleDto {
  @IsNotEmpty({ message: 'Vai trò không được để trống' })
  @IsString()
  @IsIn([...VALID_ROLES], {
    message: `Vai trò phải là một trong: ${VALID_ROLES.join(', ')}`,
  })
  role: string;
}
