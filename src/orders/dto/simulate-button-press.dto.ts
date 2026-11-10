import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SimulateButtonPressDto {
  @ApiPropertyOptional({ description: 'Mã nhận diện phần cứng nút bấm (ví dụ: BTN-8829-WTR)', example: 'BTN-8829-WTR' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Mã định danh button', example: 'BTN-8829' })
  @IsOptional()
  @IsString()
  buttonCode?: string;

  @ApiPropertyOptional({ description: 'ID cơ sở dữ liệu của button', example: '1' })
  @IsOptional()
  @IsString()
  buttonId?: string;
}
