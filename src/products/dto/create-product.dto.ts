import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsOptional,
  Min,
  Max,
  IsInt,
  IsArray,
  IsUrl,
  ArrayMaxSize,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ProductImageDto, IsImageArray } from './product-image.dto';
import { POSTGRES_INT_MAX } from '../../common/utils/validation.util';

export class CreateProductDto {
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
  productCode?: string;

  @IsOptional()
  @IsString({ message: 'categoryId phải là chuỗi hoặc ID hợp lệ' })
  categoryId?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Giá phải là số hợp lệ' })
  @Min(0, { message: 'Giá không được âm' })
  @Max(1000000000, { message: 'Giá không được vượt quá 1.000.000.000 VND' })
  price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Giá phải là số hợp lệ' })
  @Min(0, { message: 'Giá không được âm' })
  @Max(1000000000, { message: 'Giá không được vượt quá 1.000.000.000 VND' })
  basePrice?: number;

  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^(0|[1-9]\d{0,9})$/.test(trimmed)) {
        return Number(trimmed);
      }
    }
    return value;
  })
  @IsInt({ message: 'Số lượng tồn kho phải là số nguyên không âm' })
  @Min(0, { message: 'Số lượng tồn kho không được âm' })
  @Max(POSTGRES_INT_MAX, { message: 'Số lượng tồn kho vượt quá giới hạn tối đa cho phép' })
  stock?: number;

  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^(0|[1-9]\d{0,9})$/.test(trimmed)) {
        return Number(trimmed);
      }
    }
    return value;
  })
  @IsInt({ message: 'Số lượng tồn kho ban đầu phải là số nguyên không âm' })
  @Min(0, { message: 'Số lượng tồn kho ban đầu không được âm' })
  @Max(POSTGRES_INT_MAX, { message: 'Số lượng tồn kho ban đầu vượt quá giới hạn tối đa cho phép' })
  initialStock?: number;

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
