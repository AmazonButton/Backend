---
name: secure-file-upload-and-storage
description: >-
  Use this skill when implementing file or media uploads (avatars, book covers, documents).
  It enforces file size limits, magic bytes validation, path traversal defense, SVG XSS sanitization,
  and Cloud Storage Presigned URL generation (S3/Cloudinary).
---

# Secure File Upload & Cloud Storage Runbook

This skill prevents Remote Code Execution (RCE), Server-Side Request Forgery (SSRF), SVG Cross-Site Scripting (XSS), and Server Memory Exhaustion during file handling.

---

## 1. Local Multer Pipeline with Magic Bytes Validation (`src/middlewares/upload.js`)

Do not rely solely on the `Content-Type` header or file extension sent by the client. Always inspect the file's **magic bytes**:

```javascript
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { fileTypeFromBuffer } from 'file-type';
import { AppError } from '../utils/apiError.js';

// 1. Whitelist allowed MIME types and extensions
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB limit

// Memory storage for buffer-based validation before saving
const storage = multer.memoryStorage();

export const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1 // Only 1 file per upload request
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext) || !ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new AppError('Invalid file type. Only JPG, PNG, and WEBP are allowed.', 400));
    }
    cb(null, true);
  }
});

/**
 * Middleware: Verify true magic bytes from the buffer
 */
export const verifyFileSignature = async (req, res, next) => {
  if (!req.file) return next();

  try {
    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !ALLOWED_MIME_TYPES.includes(detected.mime)) {
      return next(new AppError('File content does not match its claimed extension (Spoofed file)', 400));
    }

    // Generate safe, unpredictable filename
    const safeExt = `.${detected.ext}`;
    const randomName = `${crypto.randomUUID()}${safeExt}`;
    req.file.safeFilename = randomName;

    next();
  } catch (error) {
    next(error);
  }
};
```

---

## 2. SVG Sanitization Warning (Preventing Stored XSS)

> [!WARNING]
> SVG files are XML documents that can execute embedded `<script>` tags.
> If SVGs must be supported, **always** sanitize them using `dompurify` + `jsdom` before storing, or serve them exclusively with the header `Content-Disposition: attachment`.

```javascript
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

export const sanitizeSvgBuffer = (svgBuffer) => {
  const window = new JSDOM('').window;
  const purify = DOMPurify(window);
  const cleanSvgString = purify.sanitize(svgBuffer.toString('utf-8'));
  return Buffer.from(cleanSvgString, 'utf-8');
};
```

---

## 3. Direct-to-Cloud Pattern (S3 / Cloudinary Presigned URLs)

For large files or production architectures, generate a **Presigned Upload URL** on the backend so the React client uploads directly to S3/Cloudflare R2/Cloudinary. This preserves Node.js server RAM and network bandwidth:

```javascript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { env } from '../config/env.js';

const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY
  }
});

export const generatePresignedUploadUrl = async (userId, fileExtension, contentType) => {
  const fileKey = `uploads/${userId}/${crypto.randomUUID()}.${fileExtension}`;

  const command = new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: fileKey,
    ContentType: contentType
  });

  // URL expires in 15 minutes
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

  return {
    uploadUrl,
    fileKey,
    publicUrl: `https://${env.AWS_S3_BUCKET}.s3.amazonaws.com/${fileKey}`
  };
};
```

---

## 4. Cloudinary Signed Direct Upload Pattern (Recommended)

When using Cloudinary, **never** put `CLOUDINARY_API_SECRET` in the React frontend, and **avoid** piping large files through your Express backend.
Instead, have Express generate an authenticated **Upload Signature**, allowing React to upload directly to Cloudinary safely.

### A. Cloudinary Configuration (`src/config/cloudinary.js`)
```javascript
import { v2 as cloudinary } from 'cloudinary';
import { env } from './env.js';

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true
});

export { cloudinary };
```

### B. Generate Cloudinary Signature Endpoint (`src/services/media.service.js`)
```javascript
import { cloudinary } from '../config/cloudinary.js';
import { env } from '../config/env.js';

export const getCloudinaryUploadSignature = (folder = 'books') => {
  const timestamp = Math.round(new Date().getTime() / 1000);

  // Parameters that will be locked by the signature
  const paramsToSign = {
    folder,
    timestamp
  };

  // Sign using API_SECRET kept strictly on the backend
  const signature = cloudinary.utils.api_sign_request(paramsToSign, env.CLOUDINARY_API_SECRET);

  return {
    signature,
    timestamp,
    apiKey: env.CLOUDINARY_API_KEY,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    folder
  };
};
```

### C. Safe Cloudinary Image Deletion (Preventing Storage Leaks)
When a user updates an avatar or deletes a book, delete the old image from Cloudinary using its `public_id`:

```javascript
export const deleteCloudinaryMedia = async (publicId) => {
  if (!publicId) return;
  try {
    const res = await cloudinary.uploader.destroy(publicId, { invalidate: true });
    return res;
  } catch (error) {
    console.error(`Failed to delete Cloudinary media: ${publicId}`, error);
  }
};
```

> [!IMPORTANT]
> **Database Rule for Cloudinary**:
> Always store BOTH `image_url` and `cloudinary_public_id` in your PostgreSQL schema:
> ```sql
> ALTER TABLE books ADD COLUMN cover_image_url VARCHAR(500);
> ALTER TABLE books ADD COLUMN cover_image_public_id VARCHAR(255);
> ```
> Without storing `public_id`, you will never be able to delete old images, causing permanent storage leaks and escalating Cloudinary costs!

