import { Injectable, BadRequestException } from '@nestjs/common';
import { cloudinary, configureCloudinary } from '../config/cloudinary.config';
import crypto from 'crypto';

export interface CloudinarySignatureResponse {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  folder: string;
}

export interface UploadResult {
  url: string;
  secureUrl: string;
  publicId: string;
  format: string;
  bytes: number;
}

@Injectable()
export class MediaService {
  constructor() {
    configureCloudinary();
  }

  /**
   * Validate image magic bytes to prevent spoofed file extensions (RCE / Stored XSS defense).
   * Verifies PNG, JPEG, WEBP, and GIF magic signatures.
   */
  validateImageMagicBytes(buffer: Buffer): { valid: boolean; mime: string; ext: string } {
    if (!buffer || buffer.length < 12) {
      return { valid: false, mime: '', ext: '' };
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return { valid: true, mime: 'image/png', ext: 'png' };
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { valid: true, mime: 'image/jpeg', ext: 'jpg' };
    }

    // WEBP: 52 49 46 46 ... 57 45 42 50 ("RIFF" ... "WEBP")
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return { valid: true, mime: 'image/webp', ext: 'webp' };
    }

    // GIF: 47 49 46 38 ("GIF8")
    if (
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38
    ) {
      return { valid: true, mime: 'image/gif', ext: 'gif' };
    }

    return { valid: false, mime: '', ext: '' };
  }

  /**
   * Generates a signed upload signature for direct-to-cloud client uploads.
   * This preserves backend memory and bandwidth.
   */
  getUploadSignature(folder: string = 'smart-order'): CloudinarySignatureResponse {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      throw new BadRequestException(
        'Cloudinary chưa được cấu hình. Vui lòng cung cấp CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY và CLOUDINARY_API_SECRET trong file .env.',
      );
    }

    const timestamp = Math.round(new Date().getTime() / 1000);
    const paramsToSign = {
      folder,
      timestamp,
    };

    const signature = cloudinary.utils.api_sign_request(paramsToSign, apiSecret);

    return {
      signature,
      timestamp,
      apiKey,
      cloudName,
      folder,
    };
  }

  /**
   * Upload image file buffer directly to Cloudinary with magic byte validation.
   */
  async uploadImageBuffer(
    file: Express.Multer.File,
    folder: string = 'smart-order',
  ): Promise<UploadResult> {
    if (!file || !file.buffer) {
      throw new BadRequestException('Không tìm thấy tệp tải lên');
    }

    // Max 5MB
    const MAX_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      throw new BadRequestException('Kích thước tệp vượt quá giới hạn tối đa 5MB');
    }

    // Magic bytes verification
    const inspection = this.validateImageMagicBytes(file.buffer);
    if (!inspection.valid) {
      throw new BadRequestException(
        'Tệp không hợp lệ hoặc đuôi file bị giả mạo. Chỉ chấp nhận định dạng ảnh JPG, PNG, WEBP, GIF.',
      );
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      throw new BadRequestException(
        'Cloudinary chưa được cấu hình trên server. Vui lòng điền thông tin trong file .env.',
      );
    }

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
          public_id: `${Date.now()}_${crypto.randomBytes(8).toString('hex')}`,
        },
        (error, result) => {
          if (error || !result) {
            return reject(
              new BadRequestException(`Lỗi tải ảnh lên Cloudinary: ${error?.message || 'Không xác định'}`),
            );
          }
          resolve({
            url: result.url,
            secureUrl: result.secure_url,
            publicId: result.public_id,
            format: result.format,
            bytes: result.bytes,
          });
        },
      );

      uploadStream.end(file.buffer);
    });
  }
}
