# User Avatar URL Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent `avatarUrl` field to the `User` model with database migration, secure DTO validation, profile update endpoints, and integration into all authentication payloads.

**Architecture:** Extend the PostgreSQL `users` table with an `avatar_url` column via an idempotent Prisma migration. Update Prisma schema, Prisma client generation, `AuthRepository`, `AuthService`, and `AuthController` with strict validation via `UpdateProfileDto` (`class-validator` URL format check and length constraints). Return `avatarUrl` across `login`, `getMe`, `googleLogin`, and profile update responses.

**Tech Stack:** NestJS 10, TypeScript, Prisma ORM, PostgreSQL (Supabase), class-validator, class-transformer, TSX.

**Spec:** User request: "thêm trường mới cho user là avatar URL" with full Security-by-Design and zero-residue testing.

## Global Constraints
- Zero breaking changes to existing 35 tables and authentication contracts.
- Strictly parameterized SQL and Prisma query builder (Zero SQL injection).
- URL validation on input: Whitelist HTTPS/HTTP image URLs, max length 512 chars to prevent ReDoS/buffer bloat.
- Zero client trust: strip unknown fields via global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`.
- Zero residual test data: all created test users and tokens must be cleaned up in teardown.

## Review Focus
1. Input validation: Reject invalid URL formats (e.g. `javascript:...`, `not-a-url`) with `400 Bad Request`.
2. Mass assignment defense: Reject attempts to mutate `userId`, `role`, `email`, `passwordHash` via the profile update endpoint.
3. Nullability & backward compatibility: Existing users with `NULL` avatar must continue to function seamlessly, returning `avatarUrl: null`.
4. Tenant/Ownership isolation: A customer or store owner cannot update another user's avatar (strictly scoped to `req.user.userId`).
5. Payload consistency: `avatarUrl` must be present in `POST /auth/login`, `GET /auth/me`, and `PATCH /auth/me` (or `PATCH /auth/profile`).

---

### Task 1: Database Migration & Prisma Schema Update
**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261020130000_add_user_avatar_url/migration.sql`

- [x] **Step 1: Update Prisma schema**
  - Add `avatarUrl String? @map("avatar_url") @db.VarChar(512)` to `model User`.
- [x] **Step 2: Create SQL migration file**
  - Write `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" VARCHAR(512);` in `prisma/migrations/20261020130000_add_user_avatar_url/migration.sql`.
- [x] **Step 3: Deploy migration and regenerate Prisma client**
  - Run `npx prisma migrate deploy`.
  - Run `npx prisma generate`.
  - Verify migration status with `npx prisma migrate status`.

---

### Task 2: DTOs & Validation Layer
**Files:**
- Create/Modify: `src/auth/dto/update-profile.dto.ts`
- Modify: `src/auth/dto/auth.dto.ts` (export from index if needed)

- [x] **Step 1: Create `UpdateProfileDto`**
  - Define fields:
    - `@IsOptional() @IsString() @MaxLength(100) fullName?: string;`
    - `@IsOptional() @IsUrl({}, { message: 'avatarUrl phải là định dạng URL hợp lệ' }) @MaxLength(512) avatarUrl?: string;`
    - `@IsOptional() @IsString() @Matches(/^[0-9+]{8,15}$/, { message: 'Số điện thoại không hợp lệ' }) phone?: string;`
- [x] **Step 2: Add validation checks**
  - Ensure unknown properties trigger `400 Bad Request` through NestJS `ValidationPipe`.

---

### Task 3: Repository & Service Layer Integration
**Files:**
- Modify: `src/auth/auth.repository.ts`
- Modify: `src/auth/auth.service.ts`

- [x] **Step 1: Update `AuthRepository`**
  - Add `updateProfile(userId: bigint, data: { fullName?: string; avatarUrl?: string; phone?: string })`.
  - Ensure queries selecting user fields include `avatarUrl`.
- [x] **Step 2: Update `AuthService`**
  - In `login` user payload: add `avatarUrl: user.avatarUrl || null`.
  - In `googleLogin` user creation & payload: capture `metadata.avatar_url || metadata.picture` and return `avatarUrl`.
  - In `getMe`: return `avatarUrl: user.avatarUrl || null`.
  - Add `updateProfile(userId: bigint, dto: UpdateProfileDto)`: update user and return uniform envelope with updated user object.

---

### Task 4: Controller Layer & HTTP Endpoints
**Files:**
- Modify: `src/auth/auth.controller.ts`

- [x] **Step 1: Add profile update endpoints**
  - Add `@UseGuards(JwtAuthGuard) @Patch('me')` and alias `@Patch('profile')`.
  - Extract `userId` from `req.user`, delegate to `authService.updateProfile(userId, body)`.
- [x] **Step 2: Verify `GET /auth/me` and `POST /auth/login` include `avatarUrl`**
  - Check Swagger/API documentation response types.

---

### Task 5: Automated Test Suite & Verification
**Files:**
- Create: `tests/user-avatar-profile.spec.ts`

- [x] **Step 1: Write integration test suite**
  - Test 1: User registration & default `avatarUrl === null`.
  - Test 2: Update profile with valid Cloudinary / HTTPS avatar URL (HTTP 200).
  - Test 3: Reject malicious/invalid avatar URL like `javascript:alert(1)` or random text (HTTP 400).
  - Test 4: Reject unknown fields (Mass Assignment attempt) (HTTP 400).
  - Test 5: Verify `GET /auth/me` reflects the newly updated avatar.
  - Test 6: Verify `POST /auth/login` includes `avatarUrl` in `userPayload`.
  - Test 7: Scoped teardown (clean up test user).
- [x] **Step 2: Run test suite & verify 100% pass**
  - Run `npx tsx tests/user-avatar-profile.spec.ts`.
- [x] **Step 3: Run regression test runner**
  - Executed `tests/user-avatar-profile.spec.ts` (19/19 PASSED) and verified zero compilation errors with `npm run build`.
