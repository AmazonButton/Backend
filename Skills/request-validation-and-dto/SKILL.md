---
name: request-validation-and-dto
description: >-
  Use this skill when designing, implementing, or auditing input validation, request DTOs, type coercion,
  parameter sanitization, and security boundaries across NestJS / Express backend endpoints.
---

# Enterprise Input Validation & Request DTO Standard

## Overview & The Zero-Trust Input Philosophy

In enterprise backend engineering, **all input data originating from the outside world is considered hostile and untrusted until proven otherwise**. This includes:
- `req.body` (JSON, forms, payloads)
- `req.query` (URL search parameters, pagination, filters)
- `req.params` (Route path parameters, IDs, slugs)
- `req.headers` (Authentication tokens, device signatures, nonces)
- `req.file` / `req.files` (Multipart file uploads)

Frontend validation is merely **User Experience (UX)**. The Backend is the **Sole Security Boundary**. A single unvalidated field can lead to SQL Injection, Cross-Site Scripting (XSS), Denial of Service (DoS), or Mass Assignment privilege escalation.

---

## 1. Global Validation Pipeline Configuration (`main.ts`)

Every request entering the application must pass through NestJS's centralized `ValidationPipe` before reaching any Controller method:

```typescript
// src/main.ts
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { ValidationError } from 'class-validator';

export function setupGlobalValidation(app: INestApplication) {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,              // Automatically strip properties not defined in the DTO
      forbidNonWhitelisted: true,   // Throw 400 Bad Request if client sends unknown/extraneous fields
      transform: true,              // Automatically transform incoming payloads into DTO class instances
      transformOptions: {
        enableImplicitConversion: true, // Coerce primitives (string -> number/boolean) based on TS types
      },
      stopAtFirstError: false,      // Validate all fields and return complete error list for UX
      exceptionFactory: (errors: ValidationError[]) => {
        const formattedErrors = formatValidationErrors(errors);
        return new BadRequestException({
          success: false,
          errorCode: 'VALIDATION_FAILED',
          message: 'Dữ liệu đầu vào không hợp lệ',
          errors: formattedErrors,
          timestamp: new Date().toISOString(),
        });
      },
    }),
  );
}

function formatValidationErrors(errors: ValidationError[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  function traverse(error: ValidationError, prefix = '') {
    const field = prefix ? `${prefix}.${error.property}` : error.property;
    if (error.constraints) {
      result[field] = Object.values(error.constraints);
    }
    if (error.children && error.children.length > 0) {
      error.children.forEach((child) => traverse(child, field));
    }
  }

  errors.forEach((err) => traverse(err));
  return result;
}
```

---

## 2. Core Input Sources & Validation Patterns

### A. HTTP Request Body Validation (`@Body()`)

All mutation endpoints (`POST`, `PUT`, `PATCH`) must define a strongly typed DTO class utilizing `class-validator` decorators.

#### 1. Primitives, Text Sanitization & Trimming
Always trim whitespace and sanitize strings to prevent empty space exploits and formatting inconsistencies:

```typescript
import { IsString, IsNotEmpty, MinLength, MaxLength, Matches, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateStoreProfileDto {
  @ApiProperty({ example: 'Cửa hàng Cà phê Sài Gòn', description: 'Tên cửa hàng' })
  @IsString({ message: 'Tên cửa hàng phải là chuỗi' })
  @IsNotEmpty({ message: 'Tên cửa hàng không được để trống' })
  @MinLength(3, { message: 'Tên cửa hàng tối thiểu 3 ký tự' })
  @MaxLength(100, { message: 'Tên cửa hàng tối đa 100 ký tự' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  logoUrl?: string;
}
```

#### 2. Strict Credential & Password Complexity
Enforce strong password policy via Regex matching:

```typescript
export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: 'Email không đúng định dạng tiêu chuẩn' })
  @IsNotEmpty({ message: 'Email bắt buộc phải cung cấp' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email: string;

  @ApiProperty({ 
    example: 'Password123!@#', 
    description: 'Tối thiểu 8 ký tự, gồm ít nhất 1 chữ hoa, 1 chữ thường, 1 chữ số và 1 ký tự đặc biệt' 
  })
  @IsString()
  @MinLength(8, { message: 'Mật khẩu phải có ít nhất 8 ký tự' })
  @MaxLength(64, { message: 'Mật khẩu tối đa 64 ký tự' })
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/,
    { message: 'Mật khẩu phải chứa ít nhất 1 chữ hoa, 1 chữ thường, 1 số và 1 ký tự đặc biệt' }
  )
  password: string;
}
```

#### 3. Strict Enums & Fixed Choices
Always validate against TypeScript `enum` to block invalid state transitions:

```typescript
export enum OrderStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  PREPARING = 'PREPARING',
  DELIVERING = 'DELIVERING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED'
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: OrderStatus, example: OrderStatus.CONFIRMED })
  @IsEnum(OrderStatus, { message: 'Trạng thái đơn hàng không hợp lệ' })
  @IsNotEmpty()
  status: OrderStatus;

  @ApiPropertyOptional({ example: 'Khách hàng yêu cầu hủy đơn' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
```

---

### B. HTTP Query Parameters Validation (`@Query()`)

In HTTP GET requests, all query parameters arrive as **raw strings** (`"10"`, `"true"`). They must be safely coerced and validated.

#### Pagination, Sorting, Search & Boolean Flags DTO
```typescript
import { IsInt, Min, Max, IsOptional, IsString, IsIn, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Page phải là số nguyên' })
  @Min(1, { message: 'Page tối thiểu là 1' })
  page: number = 1;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'PageSize phải là số nguyên' })
  @Min(1, { message: 'PageSize tối thiểu là 1' })
  @Max(100, { message: 'PageSize tối đa là 100 để tránh cạn kiệt tài nguyên' })
  pageSize: number = 10;

  @ApiPropertyOptional({ example: 'created_at', enum: ['created_at', 'name', 'price', 'status'] })
  @IsOptional()
  @IsString()
  @IsIn(['created_at', 'name', 'price', 'status'], { message: 'Trường sắp xếp sortBy không nằm trong danh sách cho phép' })
  sortBy: string = 'created_at';

  @ApiPropertyOptional({ example: 'DESC', enum: ['ASC', 'DESC'] })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : 'DESC'))
  @IsIn(['ASC', 'DESC'], { message: 'Thứ tự sắp xếp sortOrder chỉ nhận ASC hoặc DESC' })
  sortOrder: 'ASC' | 'DESC' = 'DESC';

  @ApiPropertyOptional({ description: 'Từ khóa tìm kiếm' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @ApiPropertyOptional({ description: 'Chỉ lấy sản phẩm đang hoạt động' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true || value === 1 || value === '1')
  @IsBoolean({ message: 'isActive phải là kiểu boolean' })
  isActive?: boolean;
}
```

---

### C. Route Path Parameters Validation (`@Param()`)

Never trust URL parameters like `:id`. Always enforce UUID v4 or Integer validation to prevent SQLi and Path Traversal.

#### 1. Method 1: Using Built-in NestJS Pipes (Recommended for simple params)
```typescript
@Get(':id')
async getDeviceById(
  @Param('id', new ParseUUIDPipe({ version: '4', errorHttpStatusCode: 400 })) id: string
) {
  return this.devicesService.findOne(id);
}
```

#### 2. Method 2: Using Param DTO (Recommended when route has multiple parameters)
```typescript
import { IsUUID, IsNotEmpty } from 'class-validator';

export class DeviceParamDto {
  @ApiProperty({ example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  @IsUUID('4', { message: 'Mã định danh thiết bị phải là UUID phiên bản 4 hợp lệ' })
  @IsNotEmpty()
  deviceId: string;
}

// Controller usage:
@Get(':deviceId/telemetry')
async getTelemetry(@Param() params: DeviceParamDto) {
  return this.devicesService.getTelemetry(params.deviceId);
}
```

---

### D. Header Inputs Validation (Edge Security & HMAC)

For sensitive IoT requests or Webhooks, validate custom HTTP headers against timing attacks and replay windows:

```typescript
export interface ValidatedIoTHeaders {
  deviceId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

export function validateIoTHeaders(headers: Record<string, string | string[]>): ValidatedIoTHeaders {
  const deviceId = headers['x-device-id'] as string;
  const timestampStr = headers['x-timestamp'] as string;
  const nonce = headers['x-nonce'] as string;
  const signature = headers['x-signature'] as string;

  if (!deviceId || typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) {
    throw new BadRequestException('Header x-device-id thiếu hoặc định dạng không hợp lệ');
  }

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) {
    throw new BadRequestException('Header x-timestamp phải là Unix epoch timestamp (ms)');
  }

  // Clock Skew Verification: Anti-Replay tolerance window (+/- 5 minutes)
  const now = Date.now();
  if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
    throw new BadRequestException('Request timestamp nằm ngoài phạm vi cho phép (Clock Drift)');
  }

  if (!nonce || typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 64) {
    throw new BadRequestException('Header x-nonce thiếu hoặc không đủ độ dài bảo mật');
  }

  if (!signature || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {
    throw new BadRequestException('Header x-signature phải là chuỗi HMAC-SHA256 hex 64 ký tự');
  }

  return { deviceId, timestamp, nonce, signature };
}
```

---

### E. Multipart File Upload Validation (`req.file`)

Never trust the file extension provided by the client (e.g., `image.png.php` or spoofed MIME types).

```typescript
import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class FileValidationPipe implements PipeTransform {
  private readonly MAX_SIZE = 5 * 1024 * 1024; // 5 MB
  private readonly ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

  transform(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('File tải lên không được để trống');
    }

    // 1. Check size limit
    if (file.size > this.MAX_SIZE) {
      throw new BadRequestException('Kích thước file vượt quá giới hạn cho phép (Tối đa 5MB)');
    }

    // 2. Check reported MIME type
    if (!this.ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestException('Định dạng file không được hỗ trợ (Chỉ chấp nhận JPEG, PNG, WEBP)');
    }

    // 3. Magic Bytes Verification (File Signature check)
    const magicBytes = file.buffer.slice(0, 4).toString('hex');
    const isJpeg = magicBytes.startsWith('ffd8ff');
    const isPng = magicBytes.startsWith('89504e47');
    const isWebp = file.buffer.slice(8, 12).toString() === 'WEBP';

    if (!isJpeg && !isPng && !isWebp) {
      throw new BadRequestException('Nội dung nhị phân của file không khớp với định dạng ảnh hợp lệ');
    }

    return file;
  }
}
```

---

## 3. Complex & Nested Data Validation

### A. Nested Objects & Array of Objects (e.g. Order Items)

When validating array items, **`@ValidateNested({ each: true })` together with `@Type(() => SubClass)` is mandatory**. Omitting `@Type()` will cause validation inside the array to be silently skipped!

```typescript
import { IsArray, ValidateNested, ArrayMinSize, ArrayMaxSize, ArrayUnique } from 'class-validator';
import { Type } from 'class-transformer';

export class OrderItemDto {
  @ApiProperty({ example: 'b5e1b6f2-1a2c-4b5a-9c7d-8e9f0a1b2c3d' })
  @IsUUID('4', { message: 'Mã sản phẩm productId phải là UUID v4' })
  @IsNotEmpty()
  productId: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 99 })
  @Type(() => Number)
  @IsInt({ message: 'Số lượng phải là số nguyên' })
  @Min(1, { message: 'Số lượng tối thiểu là 1' })
  @Max(99, { message: 'Số lượng đặt mỗi món tối đa là 99' })
  quantity: number;

  @ApiPropertyOptional({ example: 'Ít đường, không đá' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  note?: string;
}

export class CreateOrderDto {
  @ApiProperty({ type: [OrderItemDto], description: 'Danh sách sản phẩm trong đơn' })
  @IsArray({ message: 'items phải là một mảng danh sách' })
  @ArrayMinSize(1, { message: 'Đơn hàng phải chứa ít nhất 1 sản phẩm' })
  @ArrayMaxSize(50, { message: 'Đơn hàng không được vượt quá 50 sản phẩm khác nhau' })
  @ArrayUnique((o: OrderItemDto) => o.productId, { message: 'Không được truyền trùng lặp productId trong cùng đơn hàng' })
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto) // BẮT BUỘC để kích hoạt validation lồng nhau
  items: OrderItemDto[];

  @ApiPropertyOptional({ example: 'Bàn số 5' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  tableNumber?: string;
}
```

---

## 4. Input Sanitization & Security Defenses

### A. Anti-Mass Assignment Protection
- **The Threat:** Attackers add unexpected fields to the JSON payload:
  `{ "name": "Test", "role": "ADMIN", "isVerified": true, "balance": 9999999 }`
- **The Defense:** With `forbidNonWhitelisted: true`, any request sending properties not declared with a decorator in the DTO will be **immediately rejected with 400 Bad Request**.

### B. Anti-XSS Sanitization
For fields that accept rich text or descriptions, strip potentially dangerous HTML script tags:

```typescript
import sanitizeHtml from 'sanitize-html';

export class CreatePostDto {
  @ApiProperty({ example: 'Tiêu đề bài viết' })
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title: string;

  @ApiProperty({ example: '<p>Nội dung mô tả...</p>' })
  @IsString()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    return sanitizeHtml(value, {
      allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'ul', 'li', 'br'],
      allowedAttributes: { a: ['href', 'target'] },
    });
  })
  content: string;
}
```

---

## 5. Verification Checklist for Developers & Code Reviewers

Before merging any Controller or Endpoint PR, run this checklist:

- [ ] **Every Controller Method** receiving `@Body()`, `@Query()`, or `@Param()` has an explicit DTO class.
- [ ] **`whitelist: true` & `forbidNonWhitelisted: true`** are enabled in `ValidationPipe`.
- [ ] **String inputs** use `@Transform(({ value }) => value.trim())` to eliminate leading/trailing whitespace exploits.
- [ ] **Numeric & Boolean queries** use `@Type(() => Number)` or explicit `@Transform()` to prevent string falsy bugs.
- [ ] **Route IDs** are guarded by `ParseUUIDPipe` or validated DTO.
- [ ] **Nested Objects and Arrays** have both `@ValidateNested({ each: true })` AND `@Type(() => ChildDto)`.
- [ ] **Array inputs** specify `@ArrayMinSize()` and `@ArrayMaxSize()` to avoid memory exhaustion DoS.
- [ ] **OpenAPI `@ApiProperty`** decorators match the DTO validation rules 100%.
