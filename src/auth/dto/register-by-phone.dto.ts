import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterByPhoneDto {
  @ApiProperty({
    description: 'Firebase ID Token nhận từ Firebase Phone Auth trên client sau khi xác thực SMS OTP',
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMzQ1In0...',
    minLength: 100,
    maxLength: 5000,
  })
  @IsString({ message: 'firebaseIdToken phải là chuỗi ký tự' })
  @Length(100, 5000, { message: 'firebaseIdToken phải có độ dài từ 100 đến 5000 ký tự' })
  firebaseIdToken!: string;

  @ApiProperty({
    description: 'Họ và tên của người dùng',
    example: 'Nguyễn Văn A',
    minLength: 2,
    maxLength: 100,
  })
  @IsString({ message: 'fullName phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'fullName không được để trống' })
  @MinLength(2, { message: 'fullName phải có ít nhất 2 ký tự' })
  @MaxLength(100, { message: 'fullName không được vượt quá 100 ký tự' })
  fullName!: string;

  @ApiPropertyOptional({
    description: 'Email liên hệ của người dùng (tùy chọn)',
    example: 'user@example.com',
    maxLength: 255,
  })
  @IsOptional()
  @IsEmail({}, { message: 'email không đúng định dạng hợp lệ' })
  @MaxLength(255, { message: 'email không được vượt quá 255 ký tự' })
  email?: string;

  @ApiPropertyOptional({
    description: 'Vai trò người dùng (chỉ cho phép đăng ký CUSTOMER)',
    example: 'CUSTOMER',
    default: 'CUSTOMER',
  })
  @IsOptional()
  @IsIn(['CUSTOMER'], { message: 'Chỉ cho phép đăng ký tài khoản với vai trò CUSTOMER' })
  role?: string;
}
