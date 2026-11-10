import { IsNumber, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class IotTelemetryDto {
  @ApiPropertyOptional({ description: 'Mức pin thiết bị (0-100)', example: 98 })
  @IsOptional()
  @IsNumber()
  battery?: number;

  @ApiPropertyOptional({ description: 'Cường độ tín hiệu WiFi RSSI (dBm)', example: -55 })
  @IsOptional()
  @IsNumber()
  rssi?: number;
}
