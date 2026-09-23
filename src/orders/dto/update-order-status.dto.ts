import { IsNotEmpty, IsString, IsIn } from 'class-validator';

const VALID_ORDER_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'OUT_FOR_DELIVERY',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
] as const;

export class UpdateOrderStatusDto {
  @IsNotEmpty({ message: 'Trạng thái đơn hàng không được để trống' })
  @IsString()
  @IsIn([...VALID_ORDER_STATUSES], {
    message: `Trạng thái phải là một trong: ${VALID_ORDER_STATUSES.join(', ')}`,
  })
  status: string;
}
