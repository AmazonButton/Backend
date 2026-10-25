import { IsNotEmpty, IsString, IsOptional, IsIn } from 'class-validator';

export class CreateCategoryDto {
  @IsNotEmpty({ message: 'Tên danh mục không được để trống' })
  @IsString({ message: 'Tên danh mục phải là chuỗi ký tự' })
  categoryName: string;

  @IsOptional()
  parentCategoryId?: string | number;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'], { message: 'Trạng thái chỉ có thể là ACTIVE hoặc INACTIVE' })
  status?: string;
}
