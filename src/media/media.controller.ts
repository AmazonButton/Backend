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
import { MediaService } from './media.service';

@ApiTags('Media & Cloud Storage')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Get('signature')
  @ApiOperation({
    summary: 'Tạo chữ ký số Cloudinary (Presigned Signature) để Frontend React upload trực tiếp',
    description:
      'Frontend gọi API này lấy signature, sau đó gửi file trực tiếp lên Cloudinary API mà không làm tốn RAM/băng thông của Backend.',
  })
  getUploadSignature(@Query('folder') folder?: string) {
    const signatureData = this.mediaService.getUploadSignature(folder || 'smart-order');
    return {
      success: true,
      message: 'Khởi tạo chữ ký số Cloudinary thành công',
      data: signatureData,
    };
  }

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
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Body('folder') folder?: string,
  ) {
    const result = await this.mediaService.uploadImageBuffer(file, folder || 'smart-order');
    return {
      success: true,
      message: 'Tải tệp hình ảnh lên Cloudinary thành công',
      data: result,
    };
  }
}
