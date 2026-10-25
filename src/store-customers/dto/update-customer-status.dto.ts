import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class UpdateStoreCustomerStatusDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['ACTIVE', 'BLOCKED'])
  status: 'ACTIVE' | 'BLOCKED';
}
