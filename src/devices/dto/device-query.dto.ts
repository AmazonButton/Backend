import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class DeviceQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsString()
  custodyStoreId?: string;

  @IsOptional()
  @IsString()
  inventoryState?: string;

  @IsOptional()
  @IsString()
  allocatedOnly?: string;

  @IsOptional()
  @IsString()
  customerId?: string;
}

