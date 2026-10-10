import { IsString, IsNumber, IsOptional, IsBoolean, Min, IsArray, IsUrl, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Giá phải là số hợp lệ' })
  @Min(0, { message: 'Giá không được âm' })
  price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Số lượng tồn kho phải là số' })
  @Min(0)
  stock?: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { message: 'URL hình ảnh phải hợp lệ (http/https)' })
  imageUrl?: string;

  @IsOptional()
  @IsArray({ message: 'Danh sách hình ảnh phải là mảng chuỗi' })
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { each: true, message: 'Mỗi URL hình ảnh phải hợp lệ (http/https)' })
  @ArrayMaxSize(10, { message: 'Tối đa 10 ảnh cho mỗi sản phẩm' })
  images?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
