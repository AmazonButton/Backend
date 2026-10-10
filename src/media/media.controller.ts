import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ForbiddenException, Request } from '@nestjs/common';
import { MediaService } from './media.service';

@ApiTags('Media & Cloud Storage')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_ORDER', 'STAFF_INVENTORY', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get('signature')
  @ApiOperation({
    summary: 'Tạo chữ ký số Cloudinary (Presigned Signature) để Frontend React upload trực tiếp',
    description:
      'Frontend gọi API này lấy signature, sau đó gửi file trực tiếp lên Cloudinary API mà không làm tốn RAM/băng thông của Backend.',
  })
  getUploadSignature(@Query('folder') folder?: string, @Request() req?: any) {
    const user = req?.user;
    let targetFolder = folder || 'smart-order';
    if (user && user.storeId && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      if (folder && folder.startsWith('stores/')) {
        const parts = folder.split('/');
        if (parts[1] && parts[1] !== user.storeId.toString()) {
          throw new ForbiddenException('Bạn không được phép tải ảnh vào thư mục của cửa hàng khác');
        }
      } else if (!folder || !folder.startsWith('smart-button')) {
        targetFolder = `stores/${user.storeId}/products`;
      }
    }

    const signatureData = this.mediaService.getUploadSignature(targetFolder);
    return {
      success: true,
      message: 'Khởi tạo chữ ký số Cloudinary thành công',
      data: signatureData,
    };
  }

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_ORDER', 'STAFF_INVENTORY', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Post('upload')
  @ApiOperation({
    summary: 'Tải ảnh lên Cloudinary qua Server (Hỗ trợ kiểm tra Magic Bytes chống mã độc)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Tệp hình ảnh (JPG, PNG, WEBP, GIF tối đa 5MB)',
        },
        folder: {
          type: 'string',
          description: 'Thư mục đích trên Cloudinary (mặc định: smart-order)',
          example: 'products',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit before memory allocation
    }),
  )
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Body('folder') folder?: string,
    @Request() req?: any,
  ) {
    const user = req?.user;
    let targetFolder = folder || 'smart-order';
    if (user && user.storeId && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      if (folder && folder.startsWith('stores/')) {
        const parts = folder.split('/');
        if (parts[1] && parts[1] !== user.storeId.toString()) {
          throw new ForbiddenException('Bạn không được phép tải ảnh vào thư mục của cửa hàng khác');
        }
      } else if (!folder || !folder.startsWith('smart-button')) {
        targetFolder = `stores/${user.storeId}/products`;
      }
    }

    const result = await this.mediaService.uploadImageBuffer(file, targetFolder);
    return {
      success: true,
      message: 'Tải tệp hình ảnh lên Cloudinary thành công',
      data: result,
    };
  }

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Post('destroy')
  @ApiOperation({ summary: 'Xóa tệp ảnh trên Cloudinary khi thay thế hoặc hủy ảnh' })
  async destroyAsset(@Body('publicId') publicId: string, @Request() req?: any) {
    const user = req?.user;
    if (user && user.storeId && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      const allowedPrefix = `stores/${user.storeId}/`;
      if (!publicId || !publicId.startsWith(allowedPrefix)) {
        throw new ForbiddenException('Bạn chỉ có quyền xóa tài nguyên trong thư mục của cửa hàng mình');
      }
    }
    const success = await this.mediaService.deleteAsset(publicId);
    return {
      success,
      message: success ? 'Xóa tài nguyên trên Cloudinary thành công' : 'Không thể xóa tài nguyên hoặc tệp không tồn tại',
    };
  }
}
