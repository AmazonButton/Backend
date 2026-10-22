import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

export class StorefrontOrderItemDto {
  @IsNotEmpty({ message: 'productId không được để trống' })
  productId: string | number;

  @Type(() => Number)
  @IsNumber({}, { message: 'quantity phải là số' })
  @Min(1, { message: 'Số lượng tối thiểu là 1' })
  quantity: number;
}

export class CreateStorefrontOrderDto {
  @IsNotEmpty({ message: 'storeId không được để trống' })
  storeId: string | number;

  @IsArray({ message: 'items phải là một danh sách' })
  @ArrayMinSize(1, { message: 'Đơn hàng phải có ít nhất 1 sản phẩm' })
  @ValidateNested({ each: true })
  @Type(() => StorefrontOrderItemDto)
  items: StorefrontOrderItemDto[];

  @IsString({ message: 'customerName phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập tên người nhận hàng' })
  customerName: string;

  @IsString({ message: 'customerPhone phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập số điện thoại nhận hàng' })
  customerPhone: string;

  @IsString({ message: 'deliveryAddress phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập địa chỉ nhận hàng' })
  deliveryAddress: string;

  @IsIn(['PAYOS', 'CASH_ON_DELIVERY', 'COD'], { message: 'Phương thức thanh toán phải là PAYOS hoặc CASH_ON_DELIVERY' })
  paymentMethod: string;

  @IsOptional()
  @IsString()
  orderNote?: string;
}
