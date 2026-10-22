import { IsNotEmpty, IsOptional, IsString, MaxLength, IsIn } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterFcmTokenDto {
  @ApiProperty({ description: 'FCM Device Registration Token' })
  @IsString({ message: 'Token FCM phai la chuoi ky tu' })
  @IsNotEmpty({ message: 'Token FCM khong duoc de trong' })
  @MaxLength(500, { message: 'Token FCM toi da 500 ky tu' })
  token: string;

  @ApiProperty({
    description: 'Device type (ANDROID, IOS, WEB)',
    required: false,
    enum: ['ANDROID', 'IOS', 'WEB'],
    example: 'ANDROID',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsIn(['ANDROID', 'IOS', 'WEB'], {
    message: 'deviceType hop le chi bao gom ANDROID, IOS hoac WEB',
  })
  deviceType?: string;
}
