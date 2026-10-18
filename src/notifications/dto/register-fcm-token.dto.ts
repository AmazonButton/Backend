import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterFcmTokenDto {
  @ApiProperty({ description: 'FCM Device Registration Token' })
  @IsString()
  @IsNotEmpty({ message: 'Token FCM khong duoc de trong' })
  @MaxLength(500, { message: 'Token FCM toi da 500 ky tu' })
  token: string;

  @ApiProperty({ description: 'Device type (android, ios, web)', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(50, { message: 'Loai thiet bi toi da 50 ky tu' })
  deviceType?: string;
}
