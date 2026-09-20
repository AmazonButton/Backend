import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  MaxLength,
  Matches,
  IsOptional,
  IsBoolean,
} from 'class-validator';

export class RegisterDto {
  @IsNotEmpty({ message: 'Vui lòng nhập họ và tên' })
  @IsString({ message: 'Họ tên phải là chuỗi ký tự' })
  fullName: string;

  @IsNotEmpty({ message: 'Vui lòng nhập tên đăng nhập' })
  @IsString({ message: 'Tên đăng nhập phải là chuỗi ký tự' })
  @MinLength(3, { message: 'Tên đăng nhập phải từ 3 ký tự trở lên' })
  @MaxLength(30, { message: 'Tên đăng nhập tối đa 30 ký tự' })
  @Matches(/^[a-zA-Z0-9_.]+$/, {
    message: 'Tên đăng nhập chỉ được chứa chữ cái, số, dấu gạch dưới và dấu chấm',
  })
  username: string;

  @IsNotEmpty({ message: 'Vui lòng nhập địa chỉ email' })
  @IsEmail({}, { message: 'Định dạng email không hợp lệ' })
  email: string;

  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu' })
  @IsString({ message: 'Mật khẩu phải là chuỗi ký tự' })
  @MinLength(8, { message: 'Mật khẩu phải có ít nhất 8 ký tự' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()_+\-=\[\]{}|;:,.<>~`]).*$/, {
    message: 'Mật khẩu phải chứa ít nhất 1 chữ hoa, 1 chữ thường, 1 số và 1 ký tự đặc biệt',
  })
  password: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  storeName?: string;

  @IsOptional()
  @IsString()
  role?: string;
}

export class LoginDto {
  @IsNotEmpty({ message: 'Vui lòng nhập email hoặc tên đăng nhập' })
  @IsString({ message: 'Tài khoản phải là chuỗi ký tự' })
  email: string;

  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu' })
  @IsString({ message: 'Mật khẩu phải là chuỗi ký tự' })
  password: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}

export class ForgotPasswordDto {
  @IsNotEmpty({ message: 'Vui lòng nhập email' })
  @IsEmail({}, { message: 'Định dạng email không hợp lệ' })
  email: string;
}

export class ResetPasswordDto {
  @IsNotEmpty({ message: 'Thiếu mã xác thực đặt lại mật khẩu' })
  @IsString()
  token: string;

  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu mới' })
  @MinLength(8, { message: 'Mật khẩu phải có ít nhất 8 ký tự' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()_+\-=\[\]{}|;:,.<>~`]).*$/, {
    message: 'Mật khẩu phải chứa ít nhất 1 chữ hoa, 1 chữ thường, 1 số và 1 ký tự đặc biệt',
  })
  newPassword: string;
}

export class VerifyEmailDto {
  @IsNotEmpty({ message: 'Thiếu mã xác minh email' })
  @IsString()
  token: string;
}

export class ResendVerificationDto {
  @IsNotEmpty({ message: 'Vui lòng nhập email' })
  @IsEmail({}, { message: 'Định dạng email không hợp lệ' })
  email: string;
}

export class RefreshTokenDto {
  @IsNotEmpty({ message: 'Thiếu refresh token' })
  @IsString()
  refreshToken: string;
}
