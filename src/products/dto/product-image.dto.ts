import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
  isURL,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProductImageDto {
  @IsNotEmpty({ message: 'imageUrl không được để trống' })
  @IsUrl({}, { message: 'imageUrl phải là một URL hợp lệ' })
  imageUrl: string;

  @IsOptional()
  @IsString({ message: 'cloudinaryPublicId phải là chuỗi ký tự' })
  cloudinaryPublicId?: string;

  @IsOptional()
  @IsBoolean({ message: 'isThumbnail phải là boolean' })
  isThumbnail?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'displayOrder phải là số nguyên' })
  @Min(0, { message: 'displayOrder không được âm' })
  displayOrder?: number;
}

export function IsImageArray(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isImageArray',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          if (!Array.isArray(value)) return false;
          for (const item of value) {
            if (typeof item === 'string') {
              if (!isURL(item)) return false;
            } else if (typeof item === 'object' && item !== null) {
              if (!item.imageUrl || typeof item.imageUrl !== 'string' || !isURL(item.imageUrl)) {
                return false;
              }
            } else {
              return false;
            }
          }
          return true;
        },
        defaultMessage(args: ValidationArguments) {
          return 'Mỗi phần tử trong images phải là một URL hợp lệ hoặc đối tượng ảnh hợp lệ';
        },
      },
    });
  };
}
