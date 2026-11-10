import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class IotTelemetryDto {
  @ApiPropertyOptional({ description: 'Mức pin thiết bị (0-100)', example: 98 })
  @IsOptional()
  @IsInt({ message: 'battery phải là số nguyên' })
  @Min(0, { message: 'battery tối thiểu 0%' })
  @Max(100, { message: 'battery tối đa 100%' })
  battery?: number;

  @ApiPropertyOptional({ description: 'Cường độ tín hiệu WiFi RSSI (dBm)', example: -55 })
  @IsOptional()
  @IsInt({ message: 'rssi phải là số nguyên' })
  @Min(-150, { message: 'rssi không hợp lệ' })
  @Max(0, { message: 'rssi không hợp lệ' })
  rssi?: number;
}