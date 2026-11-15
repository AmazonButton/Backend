import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PresignedUploadResult {
  uploadUrl: string;
  objectKey: string;
  expiresInSeconds: number;
}

export interface PresignedViewResult {
  viewUrl: string;
  expiresAt: string;
}

@Injectable()
export class ObjectStorageService {
  private readonly logger = new Logger(ObjectStorageService.name);
  private s3Client: S3Client | null = null;
  private bucketName: string = '';
  private isConfiguredState: boolean = false;

  constructor() {
    this.initClient();
  }

  private initClient(): void {
    const accountId =
      process.env.R2_ACCOUNT_ID ||
      process.env.CLOUDFLARE_R2_ACCOUNT_ID;

    const accessKeyId =
      process.env.R2_ACCESS_KEY_ID ||
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.S3_ACCESS_KEY_ID;

    const secretAccessKey =
      process.env.R2_SECRET_ACCESS_KEY ||
      process.env.AWS_SECRET_ACCESS_KEY ||
      process.env.S3_SECRET_ACCESS_KEY;

    this.bucketName =
      process.env.R2_BUCKET_NAME ||
      process.env.AWS_S3_BUCKET_NAME ||
      process.env.S3_BUCKET_NAME ||
      'smart-order-pod-private';

    const customEndpoint =
      process.env.S3_ENDPOINT ||
      (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);

    const region =
      process.env.R2_REGION ||
      process.env.AWS_REGION ||
      process.env.S3_REGION ||
      'auto';

    if (accessKeyId && secretAccessKey) {
      try {
        this.s3Client = new S3Client({
          region,
          endpoint: customEndpoint,
          credentials: {
            accessKeyId,
            secretAccessKey,
          },
          forcePathStyle: Boolean(process.env.S3_FORCE_PATH_STYLE === 'true'),
        });
        this.isConfiguredState = true;
        this.logger.log(
          `ObjectStorageService initialized for bucket "${this.bucketName}" via ${
            customEndpoint ? (customEndpoint.includes('r2.cloudflarestorage.com') ? 'Cloudflare R2' : 'Custom S3') : 'AWS S3'
          }`,
        );
      } catch (err: any) {
        this.logger.warn(`Failed to initialize S3Client: ${err?.message}`);
        this.isConfiguredState = false;
      }
    } else {
      this.logger.warn(
        'Object Storage (R2/S3) is not configured in .env. Presigned URLs will fallback to Cloudinary/Mock mode.',
      );
      this.isConfiguredState = false;
    }
  }

  isConfigured(): boolean {
    return this.isConfiguredState && Boolean(this.s3Client);
  }

  getBucketName(): string {
    return this.bucketName;
  }

  /**
   * Generates a Presigned PUT URL for direct client upload.
   * Client uploads directly to R2 / S3 without touching backend RAM.
   */
  async generatePresignedUploadUrl(
    objectKey: string,
    contentType: string = 'image/webp',
    expiresInSeconds: number = 300,
  ): Promise<PresignedUploadResult> {
    if (!this.s3Client || !this.isConfiguredState) {
      // Graceful fallback URL when R2/S3 credentials are not yet configured
      return {
        uploadUrl: `/api/v1/media/upload-pod`,
        objectKey,
        expiresInSeconds,
      };
    }

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: expiresInSeconds,
    });

    return {
      uploadUrl,
      objectKey,
      expiresInSeconds,
    };
  }

  /**
   * Generates a temporary Presigned GET URL for viewing private POD images.
   * Expires after expiresInSeconds (default 15 minutes / 900s) to protect customer PII.
   */
  async generatePresignedViewUrl(
    objectKey: string,
    expiresInSeconds: number = 900,
  ): Promise<PresignedViewResult> {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    if (!this.s3Client || !this.isConfiguredState) {
      // If objectKey is a full URL (e.g. Cloudinary), return as is
      return {
        viewUrl: objectKey,
        expiresAt,
      };
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
    });

    const viewUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: expiresInSeconds,
    });

    return {
      viewUrl,
      expiresAt,
    };
  }

  /**
   * Check if an object exists in the private bucket.
   */
  async checkObjectExists(objectKey: string): Promise<boolean> {
    if (!this.s3Client || !this.isConfiguredState) {
      return true; // Assume true if storage client is disabled
    }

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
      });
      await this.s3Client.send(command);
      return true;
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
        return false;
      }
      return false;
    }
  }

  /**
   * Delete an object (used for manual cleanup or tests).
   */
  async deleteObject(objectKey: string): Promise<boolean> {
    if (!this.s3Client || !this.isConfiguredState) return false;
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
      });
      await this.s3Client.send(command);
      return true;
    } catch {
      return false;
    }
  }
}
