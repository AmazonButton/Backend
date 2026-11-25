import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ReviewKycSessionDto {
  @IsIn(['APPROVE', 'DECLINE'], {
    message: "decision phải là 'APPROVE' hoặc 'DECLINE'",
  })
  decision!: 'APPROVE' | 'DECLINE';

  @IsString({ message: 'reason phải là chuỗi ký tự' })
  @MinLength(3, { message: 'reason phải có ít nhất 3 ký tự' })
  @MaxLength(500, { message: 'reason không được vượt quá 500 ký tự' })
  reason!: string;

  @IsOptional()
  @IsBoolean({ message: 'acceptOcrNameAsVerified phải là boolean' })
  acceptOcrNameAsVerified?: boolean;
}
