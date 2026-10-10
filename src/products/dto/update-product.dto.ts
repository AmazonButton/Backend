import { IsString, IsNumber, IsOptional, Min, IsArray, IsUrl, ArrayMaxSize, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ProductImageDto, IsImageArray } from './product-image.dto';

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  productName?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Giá phải là số hợp lệ' })
  @Min(0, { message: 'Giá không được âm' })
  price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Giá phải là số hợp lệ' })
  @Min(0, { message: 'Giá không được âm' })
  basePrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Số lượng tồn kho phải là số' })
  @Min(0)
  stock?: number;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsUrl({}, { message: 'imageUrl phải là một URL hợp lệ' })
  imageUrl?: string;

  @IsOptional()
  @IsString({ message: 'cloudinaryPublicId phải là chuỗi ký tự' })
  cloudinaryPublicId?: string;

  @IsOptional()
  @IsArray({ message: 'images phải là một danh sách' })
  @ArrayMaxSize(10, { message: 'Tối đa 10 ảnh cho mỗi sản phẩm' })
  @IsImageArray({ message: 'Mỗi đường dẫn trong images phải là một URL hợp lệ' })
  images?: any[];

  @IsOptional()
  @IsArray({ message: 'imageDetails phải là danh sách chi tiết ảnh' })
  @ArrayMaxSize(10, { message: 'Tối đa 10 ảnh cho mỗi sản phẩm' })
  @ValidateNested({ each: true })
  @Type(() => ProductImageDto)
  imageDetails?: ProductImageDto[];
}
