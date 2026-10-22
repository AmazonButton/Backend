import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UnregisterFcmTokenDto {
  @ApiProperty({ description: 'FCM Device Registration Token can huy dang ky' })
  @IsString()
  @IsNotEmpty({ message: 'Token FCM khong duoc de trong' })
  @MaxLength(500, { message: 'Token FCM toi da 500 ky tu' })
  token: string;
}
