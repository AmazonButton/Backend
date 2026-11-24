import { IsString, MaxLength, MinLength } from 'class-validator';

export class RevokeUserKycDto {
  @IsString({ message: 'reason phải là chuỗi ký tự' })
  @MinLength(5, { message: 'reason phải có ít nhất 5 ký tự' })
  @MaxLength(500, { message: 'reason không được vượt quá 500 ký tự' })
  reason!: string;
}
