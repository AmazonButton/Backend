import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class StorefrontOrderItemDto {
  @IsNotEmpty({ message: 'productId không được để trống' })
  productId: string | number;

  @Type(() => Number)
  @IsNumber({}, { message: 'quantity phải là số' })
  @Min(1, { message: 'Số lượng tối thiểu là 1' })
  @Max(1000, { message: 'Số lượng tối đa cho mỗi sản phẩm là 1000' })
  quantity: number;
}

export class CreateStorefrontOrderDto {
  @IsNotEmpty({ message: 'storeId không được để trống' })
  storeId: string | number;

  @IsArray({ message: 'items phải là một danh sách' })
  @ArrayMinSize(1, { message: 'Đơn hàng phải có ít nhất 1 sản phẩm' })
  @ArrayMaxSize(50, { message: 'Đơn hàng không được vượt quá 50 loại sản phẩm' })
  @ValidateNested({ each: true })
  @Type(() => StorefrontOrderItemDto)
  items: StorefrontOrderItemDto[];

  @IsString({ message: 'customerName phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập tên người nhận hàng' })
  @MaxLength(100, { message: 'Tên người nhận không được vượt quá 100 ký tự' })
  customerName: string;

  @IsString({ message: 'customerPhone phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập số điện thoại nhận hàng' })
  @MaxLength(20, { message: 'Số điện thoại không được vượt quá 20 ký tự' })
  customerPhone: string;

  @IsString({ message: 'deliveryAddress phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập địa chỉ nhận hàng' })
  @MaxLength(255, { message: 'Địa chỉ nhận hàng không được vượt quá 255 ký tự' })
  deliveryAddress: string;

  @IsIn(['PAYOS', 'CASH_ON_DELIVERY', 'COD'], { message: 'Phương thức thanh toán phải là PAYOS hoặc CASH_ON_DELIVERY' })
  paymentMethod: string;

  @IsOptional()
  @IsString({ message: 'orderNote phải là chuỗi ký tự' })
  @MaxLength(500, { message: 'Ghi chú đơn hàng không được vượt quá 500 ký tự' })
  orderNote?: string;
}
