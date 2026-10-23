import { IsNotEmpty, IsString, MinLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ description: 'Mật khẩu hiện tại của tài khoản', example: 'CurrentPassword123@' })
  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu hiện tại' })
  @IsString()
  currentPassword: string;

  @ApiProperty({ description: 'Mật khẩu mới (tối thiểu 8 ký tự, gồm chữ hoa, thường, số và ký tự đặc biệt)', example: 'NewPassword123@' })
  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu mới' })
  @MinLength(8, { message: 'Mật khẩu phải có ít nhất 8 ký tự' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()_+\-=\[\]{}|;:,.<>~`]).*$/, {
    message: 'Mật khẩu phải chứa ít nhất 1 chữ hoa, 1 chữ thường, 1 số và 1 ký tự đặc biệt',
  })
  newPassword: string;
}
