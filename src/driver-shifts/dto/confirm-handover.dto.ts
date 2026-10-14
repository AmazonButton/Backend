import { IsOptional, IsString } from 'class-validator';

export class ConfirmHandoverDto {
  @IsOptional()
  @IsString()
  note?: string;
}
