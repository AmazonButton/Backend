import { IsNotEmpty, IsString, IsNumber, IsOptional, Min, IsArray, IsUrl, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductDto {
  @IsNotEmpty({ message: 'Tên sản phẩm không được để trống' })
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsNotEmpty({ message: 'Mã SKU không được để trống' })
  @IsString()
  sku: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsNotEmpty({ message: 'Đơn vị tính không được để trống' })
  @IsString()
  unit: string;

  @IsNotEmpty({ message: 'Giá sản phẩm không được để trống' })
  @Type(() => Number)
  @IsNumber({}, { message: 'Giá phải là số hợp lệ' })
  @Min(0, { message: 'Giá không được âm' })
  price: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Số lượng tồn kho phải là số' })
  @Min(0)
  stock?: number;

  @IsOptional()
  @IsUrl({}, { message: 'imageUrl phải là một URL hợp lệ' })
  imageUrl?: string;

  @IsOptional()
  @IsArray({ message: 'images phải là một danh sách URL' })
  @ArrayMaxSize(10, { message: 'Tối đa 10 ảnh cho mỗi sản phẩm' })
  @IsUrl({}, { each: true, message: 'Mỗi đường dẫn trong images phải là một URL hợp lệ' })
  images?: string[];
}
