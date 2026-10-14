import { PrismaService } from '../prisma/prisma.service';
import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Request,
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
import { MediaService } from './media.service';
import { ProductsRepository } from '../products/products.repository';

@ApiTags('Media & Cloud Storage')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('media')
export class MediaController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly productsRepo: ProductsRepository,
    private readonly prisma: PrismaService,
  ) {}

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_ORDER', 'STAFF_INVENTORY', 'STAFF_DELIVERY', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get('signature')
  @ApiOperation({
    summary: 'Tạo chữ ký số Cloudinary (Presigned Signature) để Frontend React upload trực tiếp',
    description:
      'Frontend gọi API này lấy signature, sau đó gửi file trực tiếp lên Cloudinary API mà không làm tốn RAM/băng thông của Backend.',
  })
  getUploadSignature(@Query('folder') folder?: string, @Request() req?: any) {
    const user = req?.user;
    let targetFolder = folder || 'smart-order';
    if (user && user.role === 'STAFF_DELIVERY' && user.storeId) {
      targetFolder = `stores/${user.storeId}/pod`;
    }
    if (user && user.storeId && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      const allowedPrefix = `stores/${user.storeId}/`;
      if (folder) {
        if (!folder.startsWith(allowedPrefix)) {
          throw new ForbiddenException(`Cửa hàng chỉ được phép lưu vào thư mục ${allowedPrefix}`);
        }
        targetFolder = folder;
      } else {
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

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_ORDER', 'STAFF_INVENTORY', 'STAFF_DELIVERY', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
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
      const allowedPrefix = `stores/${user.storeId}/`;
      if (folder) {
        if (!folder.startsWith(allowedPrefix)) {
          throw new ForbiddenException(`Cửa hàng chỉ được phép lưu vào thư mục ${allowedPrefix}`);
        }
        targetFolder = folder;
      } else {
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
    if (!publicId) {
      throw new BadRequestException('publicId không được để trống');
    }
    const user = req?.user;
    if (user && user.storeId && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      const allowedPrefix = `stores/${user.storeId}/`;
      if (!publicId.startsWith(allowedPrefix)) {
        throw new ForbiddenException('Bạn chỉ có quyền xóa tài nguyên trong thư mục của cửa hàng mình');
      }
    }
    if (publicId.startsWith('smart-order/') || publicId.startsWith('smart-button/')) {
      throw new ForbiddenException('Không thể xóa tài nguyên hệ thống dùng chung');
    }
    const refCount = await this.productsRepo.countImageReferences(publicId);
    if (refCount > 0) {
      throw new BadRequestException({
        success: false,
        code: 'ASSET_IN_USE',
        message: `Hình ảnh vẫn đang được sử dụng bởi ${refCount} sản phẩm, không thể xóa trực tiếp`,
      });
    }
    const success = await this.mediaService.deleteAsset(publicId);
    return {
      success,
      message: success ? 'Xóa tài nguyên trên Cloudinary thành công' : 'Không thể xóa tài nguyên hoặc tệp không tồn tại',
    };
  }

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'STAFF_DELIVERY', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Post('upload-pod')
  @ApiOperation({
    summary: 'Tải ảnh bằng chứng giao hàng (POD) lên Cloudinary (Giới hạn 1.5MB, thư mục stores/{storeId}/pod)',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: Math.floor(1.5 * 1024 * 1024) }, // Max 1.5MB per PRD requirement
    }),
  )
  async uploadPodImage(
    @UploadedFile() file: Express.Multer.File,
    @Body('orderId') orderId?: string,
    @Request() req?: any,
  ) {
    const user = req?.user;
    if (!file) {
      throw new BadRequestException('Vui lòng chọn tệp hình ảnh để tải lên');
    }
    if (!user || !user.storeId) {
      throw new ForbiddenException('Tài khoản thiếu thông tin cửa hàng để lưu trữ POD');
    }
    if (orderId) {
      if (!/^\d+$/.test(orderId)) {
        throw new BadRequestException('Mã đơn hàng không hợp lệ');
      }
      const order = await this.prisma.order.findUnique({
        where: { orderId: BigInt(orderId) },
      });
      if (!order) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }
      if (order.storeId.toString() !== user.storeId.toString()) {
        throw new ForbiddenException('Đơn hàng không thuộc cửa hàng bạn đang làm việc');
      }
      if (user.role === 'STAFF_DELIVERY') {
        if (!order.assignedDriverId || order.assignedDriverId.toString() !== user.userId.toString()) {
          throw new ForbiddenException('Bạn không phải tài xế được chỉ định cho đơn hàng này');
        }
        if (order.orderStatus !== 'SHIPPING') {
          throw new BadRequestException(`Chỉ có thể tải ảnh POD khi đơn hàng đang ở trạng thái SHIPPING (hiện tại: ${order.orderStatus})`);
        }
      }
    }

    const targetFolder = `stores/${user.storeId}/pod`;
    const result = await this.mediaService.uploadImageBuffer(file, targetFolder);
    return {
      success: true,
      message: 'Tải tệp hình ảnh POD lên Cloudinary thành công',
      data: {
        ...result,
        orderId: orderId || null,
        podFolder: targetFolder,
      },
    };
  }

}
