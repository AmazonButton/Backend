import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IotEventType, IotPaymentMethod } from '../../iot/dto/iot-event.dto';

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

  @ApiPropertyOptional({ description: 'Loại sự kiện nút bấm', enum: IotEventType, example: IotEventType.SINGLE_PRESS })
  @IsOptional()
  @IsEnum(IotEventType)
  eventType?: IotEventType | `${IotEventType}`;

  @ApiPropertyOptional({ description: 'Mã yêu cầu idempotency', example: 'req_sim_123456' })
  @IsOptional()
  @IsString()
  requestId?: string;

  @ApiPropertyOptional({ description: 'Phương thức thanh toán', enum: IotPaymentMethod, example: IotPaymentMethod.COD })
  @IsOptional()
  @IsEnum(IotPaymentMethod)
  paymentMethod?: IotPaymentMethod | `${IotPaymentMethod}`;
}