import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyFirebasePhoneDto {
  @ApiProperty({
    description: 'Firebase ID Token obtained from Firebase Phone Auth on client/mobile after SMS OTP verification',
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ij...',
    minLength: 100,
    maxLength: 5000,
  })
  @IsString({ message: 'firebaseIdToken phải là chuỗi ký tự' })
  @Length(100, 5000, { message: 'firebaseIdToken phải có độ dài từ 100 đến 5000 ký tự' })
  firebaseIdToken!: string;
}
