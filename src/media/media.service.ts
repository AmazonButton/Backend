import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { cloudinary, configureCloudinary } from '../config/cloudinary.config';
import crypto from 'crypto';

export interface CloudinarySignatureResponse {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  folder: string;
  allowedFormats?: string;
}

export interface UploadResult {
  url: string;
  secureUrl: string;
  publicId: string;
  format: string;
  bytes: number;
}

export interface UploadImageOptions {
  maxBytes?: number;
  allowedMimes?: string[];
  publicIdPrefix?: string;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly ALLOWED_ROOTS = ['smart-order', 'smart-button', 'products', 'avatars', 'stores', 'general'];

  private validateFolder(folder: string): string {
    const clean = (folder || 'smart-order').trim();
    if (clean.includes('..') || clean.includes('\\') || clean.startsWith('/')) {
      throw new BadRequestException('Tên thư mục không hợp lệ hoặc chứa ký tự bị cấm (Path Traversal)');
    }
    const rootFolder = clean.split('/')[0];
    if (!this.ALLOWED_ROOTS.includes(rootFolder)) {
      throw new BadRequestException(`Thư mục "${clean}" không nằm trong danh sách thư mục được phép (products, avatars, stores, smart-order, smart-button, general)`);
    }
    return clean;
  }

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
    folder = this.validateFolder(folder);
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      throw new BadRequestException(
        'Cloudinary chưa được cấu hình. Vui lòng cung cấp CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY và CLOUDINARY_API_SECRET trong file .env.',
      );
    }

    const timestamp = Math.round(new Date().getTime() / 1000);
    const allowedFormats = 'jpg,png,webp,jpeg';
    const paramsToSign = {
      allowed_formats: allowedFormats,
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
      allowedFormats,
    };
  }

  /**
   * Upload image file buffer directly to Cloudinary with magic byte validation.
   */
  async uploadImageBuffer(
    file: Express.Multer.File,
    folder: string = 'smart-order',
    options?: UploadImageOptions,
  ): Promise<UploadResult> {
    folder = this.validateFolder(folder);
    if (!file || !file.buffer) {
      throw new BadRequestException('Không tìm thấy tệp tải lên');
    }

    const maxBytes = options?.maxBytes ?? 5 * 1024 * 1024;
    const allowedMimes = options?.allowedMimes ?? [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
    ];
    const actualBytes = Math.max(file.size || 0, file.buffer.length || 0);
    if (actualBytes > maxBytes) {
      const maxMb = Number((maxBytes / (1024 * 1024)).toFixed(1));
      throw new BadRequestException(`Kích thước tệp vượt quá giới hạn tối đa ${maxMb}MB`);
    }

    // Magic bytes verification prevents spoofed extensions & XSS/SVG uploads
    const inspection = this.validateImageMagicBytes(file.buffer);
    if (!inspection.valid || !allowedMimes.includes(inspection.mime)) {
      const allowedText = allowedMimes
        .map((m) => m.replace('image/', '').toUpperCase().replace('JPEG', 'JPG'))
        .join(', ');
      throw new BadRequestException(
        `Tệp không hợp lệ hoặc đuôi file bị giả mạo. Chỉ chấp nhận định dạng ảnh ${allowedText}.`,
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

    const safePrefix = options?.publicIdPrefix
      ? options.publicIdPrefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
      : '';
    const generatedPublicId = `${safePrefix ? `${safePrefix}_` : ''}${Date.now()}_${crypto
      .randomBytes(8)
      .toString('hex')}`;

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
          public_id: generatedPublicId,
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

  /**
   * Delete asset from Cloudinary by public ID
   */
  async deleteAsset(publicId: string): Promise<boolean> {
    if (!publicId) return false;
    try {
      const res = await cloudinary.uploader.destroy(publicId);
      return res.result === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Best-effort deletion helper when replacing or cleaning up orphaned media assets.
   */
  async deleteAssetBestEffort(publicId?: string | null): Promise<void> {
    if (!publicId) return;
    const deleted = await this.deleteAsset(publicId);
    if (!deleted) {
      this.logger.warn(`[MediaCleanup] Could not delete asset cleanly: ${publicId}`);
    }
  }
}
