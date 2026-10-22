import { IsOptional, IsString, MaxLength, IsUrl, Matches } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString({ message: 'Họ và tên phải là chuỗi ký tự' })
  @MaxLength(100, { message: 'Họ và tên không được vượt quá 100 ký tự' })
  fullName?: string;

  @IsOptional()
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { message: 'avatarUrl phải là một đường dẫn URL hợp lệ (http hoặc https)' },
  )
  @MaxLength(512, { message: 'avatarUrl không được vượt quá 512 ký tự' })
  avatarUrl?: string;

  @IsOptional()
  @IsString({ message: 'Số điện thoại phải là chuỗi ký tự' })
  @Matches(/^[0-9+]{8,15}$/, { message: 'Số điện thoại không hợp lệ' })
  phone?: string;
}
