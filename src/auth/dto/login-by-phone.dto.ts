import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginByPhoneDto {
  @ApiProperty({
    description: 'Firebase ID Token nhận từ Firebase Phone Auth trên client sau khi xác thực SMS OTP',
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMzQ1In0...',
    minLength: 100,
    maxLength: 5000,
  })
  @IsString({ message: 'firebaseIdToken phải là chuỗi ký tự' })
  @Length(100, 5000, { message: 'firebaseIdToken phải có độ dài từ 100 đến 5000 ký tự' })
  firebaseIdToken!: string;
}
