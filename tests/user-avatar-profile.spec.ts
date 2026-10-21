import * as dotenv from 'dotenv';
dotenv.config();
import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { NotFoundException } from '@nestjs/common';

import { AuthRepository } from '../src/auth/auth.repository';
import { AuthService } from '../src/auth/auth.service';
import { AuthController } from '../src/auth/auth.controller';
import { UpdateProfileDto } from '../src/auth/dto/update-profile.dto';
import { JwtStrategy } from '../src/auth/jwt.strategy';

const prisma = new PrismaClient();

async function runUserAvatarTestSuite() {
  console.log('================================================================================');
  console.log('🖼️ USER AVATAR URL & PROFILE MANAGEMENT TEST SUITE');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${testName}`);
      passed++;
    } else {
      console.error(`  \x1b[31m✖ [FAIL]\x1b[0m ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const ts = Date.now();
  let createdUser: any = null;
  let googleCreatedUser: any = null;

  try {
    // -------------------------------------------------------------------------
    // 1. DTO VALIDATION TESTS
    // -------------------------------------------------------------------------
    console.log('[Phase 1: UpdateProfileDto Validation & Security Invariants]');

    // 1a. Valid HTTPS URL
    const validHttps = plainToInstance(UpdateProfileDto, {
      avatarUrl: 'https://res.cloudinary.com/smart-order/image/upload/v1/avatars/user_1.jpg',
    });
    const errorsHttps = await validate(validHttps);
    assert(errorsHttps.length === 0, 'DTO accepts valid HTTPS avatar URL');

    // 1b. Valid HTTP URL
    const validHttp = plainToInstance(UpdateProfileDto, {
      avatarUrl: 'http://cdn.example.com/images/avatar.png',
    });
    const errorsHttp = await validate(validHttp);
    assert(errorsHttp.length === 0, 'DTO accepts valid HTTP avatar URL');

    // 1c. Invalid URL without protocol
    const noProtocol = plainToInstance(UpdateProfileDto, {
      avatarUrl: 'res.cloudinary.com/smart-order/image.jpg',
    });
    const errorsNoProto = await validate(noProtocol);
    assert(errorsNoProto.length > 0, 'DTO rejects URL missing protocol (http/https)');

    // 1d. Invalid script / javascript URI (XSS injection defense)
    const xssUri = plainToInstance(UpdateProfileDto, {
      avatarUrl: 'javascript:alert(document.cookie)',
    });
    const errorsXss = await validate(xssUri);
    assert(errorsXss.length > 0, 'DTO rejects javascript: URI scheme');

    // 1e. URL exceeding 512 characters
    const longUrl = 'https://example.com/' + 'a'.repeat(510);
    const excessiveDto = plainToInstance(UpdateProfileDto, {
      avatarUrl: longUrl,
    });
    const errorsExcessive = await validate(excessiveDto);
    assert(errorsExcessive.length > 0, 'DTO rejects avatar URL exceeding 512 characters max limit');

    // 1f. Optional fields allowed
    const emptyDto = plainToInstance(UpdateProfileDto, {});
    const errorsEmpty = await validate(emptyDto);
    assert(errorsEmpty.length === 0, 'DTO accepts empty object (all fields are optional)');

    // -------------------------------------------------------------------------
    // 2. DATABASE FIXTURE & BACKWARD COMPATIBILITY
    // -------------------------------------------------------------------------
    console.log('\n[Phase 2: Database Persistence & Backward Compatibility]');

    const passwordHash = await bcrypt.hash('SecurePassword123!', 10);
    createdUser = await prisma.user.create({
      data: {
        username: `avatar_test_${ts}`,
        email: `avatar_test_${ts}@smartorder.test`,
        fullName: 'Test User Avatar Initial',
        passwordHash,
        status: 'ACTIVE',
      },
    });

    assert(createdUser.avatarUrl === null, 'Existing/new user without avatar defaults to null (backward compatible)');

    // -------------------------------------------------------------------------
    // 3. SERVICE LAYER GET ME & PROFILE UPDATE
    // -------------------------------------------------------------------------
    console.log('\n[Phase 3: AuthService getMe & updateProfile]');

    const authRepo = new AuthRepository(prisma as any);
    const mockMailService: any = {
      sendVerificationEmail: async () => {},
      sendPasswordResetEmail: async () => {},
    };
    const jwtSecret = process.env.JWT_SECRET || 'super_secret_jwt_key_test';
    const jwtService = new JwtService({ secret: jwtSecret });
    const authService = new AuthService(mockMailService, authRepo, jwtService);

    // 3a. getMe returns avatarUrl: null initially
    const meInitial = await authService.getMe(createdUser.userId);
    assert(
      meInitial.success === true && meInitial.data.avatarUrl === null,
      'authService.getMe returns avatarUrl: null for user with no avatar',
    );

    // 3b. Update avatarUrl successfully
    const targetAvatar = 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=400';
    const updateResult = await authService.updateProfile(createdUser.userId, {
      avatarUrl: targetAvatar,
    });

    assert(updateResult.success === true, 'authService.updateProfile returns success: true');
    assert(updateResult.data.avatarUrl === targetAvatar, 'authService.updateProfile response contains new avatarUrl');

    // Check direct DB query
    const dbUserAfterUpdate = await prisma.user.findUnique({
      where: { userId: createdUser.userId },
    });
    assert(
      dbUserAfterUpdate?.avatarUrl === targetAvatar,
      'PostgreSQL user.avatar_url column persisted the updated URL correctly',
    );

    // 3c. Update fullName and phone without affecting avatarUrl
    const multiUpdateResult = await authService.updateProfile(createdUser.userId, {
      fullName: 'Tris Nguyen Master Developer',
      phone: '+84912345678',
    });
    assert(
      multiUpdateResult.data.fullName === 'Tris Nguyen Master Developer',
      'authService.updateProfile updates fullName',
    );
    assert(
      multiUpdateResult.data.phone === '+84912345678',
      'authService.updateProfile updates phone',
    );
    assert(
      multiUpdateResult.data.avatarUrl === targetAvatar,
      'authService.updateProfile preserves avatarUrl when only fullName and phone are passed',
    );

    // -------------------------------------------------------------------------
    // 4. AUTH SERVICE LOGIN & JWT STRATEGY PAYLOAD
    // -------------------------------------------------------------------------
    console.log('\n[Phase 4: Login & JWT Strategy Integration]');

    const loginRes = await authService.login(
      {
        email: createdUser.email,
        password: 'SecurePassword123!',
      },
      '127.0.0.1',
      'TestSuite/1.0',
    );

    assert(
      loginRes.data.user.avatarUrl === targetAvatar,
      'authService.login returns updated avatarUrl in data.user',
    );

    // Test JwtStrategy validate hook
    const jwtStrategy = new JwtStrategy(prisma as any);
    const validatedReqUser = await jwtStrategy.validate(
      { headers: {} },
      {
        userId: createdUser.userId.toString(),
        email: createdUser.email,
        role: 'CUSTOMER',
      },
    );
    assert(
      validatedReqUser.avatarUrl === targetAvatar,
      'jwtStrategy.validate includes avatarUrl in authenticated req.user object',
    );

    // -------------------------------------------------------------------------
    // 5. CONTROLLER ENDPOINTS: PATCH /auth/me & PATCH /auth/profile
    // -------------------------------------------------------------------------
    console.log('\n[Phase 5: Controller Endpoints (/auth/me & /auth/profile)]');

    const mockFirebaseService: any = {};
    const authController = new AuthController(authService, mockFirebaseService);

    // 5a. PATCH /auth/me
    const meNewAvatar = 'https://res.cloudinary.com/smart-order/image/upload/avatar-me.png';
    const patchMeRes = await authController.updateMe(
      { user: { id: createdUser.userId.toString() } },
      { avatarUrl: meNewAvatar },
    );
    assert(
      patchMeRes.success === true && patchMeRes.data.avatarUrl === meNewAvatar,
      'PATCH /auth/me updates avatarUrl via authenticated controller handler',
    );

    // 5b. PATCH /auth/profile alias
    const profileNewAvatar = 'https://res.cloudinary.com/smart-order/image/upload/avatar-profile.png';
    const patchProfileRes = await authController.updateProfile(
      { user: { userId: createdUser.userId.toString() } },
      { avatarUrl: profileNewAvatar },
    );
    assert(
      patchProfileRes.success === true && patchProfileRes.data.avatarUrl === profileNewAvatar,
      'PATCH /auth/profile alias updates avatarUrl successfully',
    );

    // -------------------------------------------------------------------------
    // 6. GOOGLE OAUTH AVATAR SYNCHRONIZATION
    // -------------------------------------------------------------------------
    console.log('\n[Phase 6: Google OAuth Avatar Synchronization]');
    const originalFetch = global.fetch;
    const googleAuthId = `11111111-2222-3333-4444-${ts.toString().slice(-12).padStart(12, '0')}`;
    const googleEmail = `google_avatar_${ts}@smartorder.test`;
    const googleAvatar = 'https://lh3.googleusercontent.com/a/ACg8ocL_test_avatar_image=s96-c';

    try {
      global.fetch = (async (url: string) => {
        if (typeof url === 'string' && url.includes('/auth/v1/user')) {
          return {
            ok: true,
            json: async () => ({
              id: googleAuthId,
              email: googleEmail,
              email_confirmed_at: new Date().toISOString(),
              identities: [{ provider: 'google' }],
              user_metadata: {
                full_name: 'Google Avatar Test User',
                avatar_url: googleAvatar,
                picture: googleAvatar,
              },
            }),
          };
        }
        return (originalFetch as any)(url);
      }) as any;

      const googleLoginRes = await authService.googleLogin('mock-google-oauth-token');
      assert(
        googleLoginRes.success === true,
        'authService.googleLogin succeeds with mocked Google token',
      );
      assert(
        googleLoginRes.data?.user?.avatarUrl === googleAvatar,
        'googleLogin response payload contains avatarUrl extracted from metadata.avatar_url',
      );

      googleCreatedUser = await prisma.user.findUnique({
        where: { email: googleEmail },
      });
      assert(
        googleCreatedUser?.avatarUrl === googleAvatar,
        'googleLogin automatically persists Google avatarUrl into PostgreSQL database',
      );

      // Test backfill when existing Google user has no avatar and logs in again with avatar
      await prisma.user.update({
        where: { userId: googleCreatedUser.userId },
        data: { avatarUrl: null },
      });
      const userBeforeSync = await prisma.user.findUnique({
        where: { userId: googleCreatedUser.userId },
      });
      assert(userBeforeSync?.avatarUrl === null, 'Temporarily set Google user avatarUrl to null in DB');

      // Call googleLogin again to test backfill
      const reloginRes = await authService.googleLogin('mock-google-oauth-token');
      assert(
        reloginRes.data?.user?.avatarUrl === googleAvatar,
        'googleLogin backfills avatarUrl for existing user if currently null',
      );
      const userAfterSync = await prisma.user.findUnique({
        where: { userId: googleCreatedUser.userId },
      });
      assert(
        userAfterSync?.avatarUrl === googleAvatar,
        'Database has backfilled avatarUrl for existing Google user',
      );
    } finally {
      global.fetch = originalFetch;
    }

    // -------------------------------------------------------------------------
    // 7. ERROR & BOUNDARY CASES
    // -------------------------------------------------------------------------
    console.log('\n[Phase 7: Error Handling & Non-existent User Guard]');

    let notFoundThrown = false;
    try {
      await authService.updateProfile(BigInt(999999999999), {
        avatarUrl: 'https://example.com/avatar.jpg',
      });
    } catch (e: any) {
      if (e instanceof NotFoundException) {
        notFoundThrown = true;
      }
    }
    assert(notFoundThrown, 'authService.updateProfile throws NotFoundException when user does not exist');

  } catch (err: any) {
    console.error('Fatal test error occurred:', err);
    failed++;
  } finally {
    // -------------------------------------------------------------------------
    // 8. ZERO TEST RESIDUE TEARDOWN
    // -------------------------------------------------------------------------
    console.log('\n[Phase 8: Zero Test Residue Cleanup]');
    if (createdUser && createdUser.userId) {
      try {
        await prisma.refreshToken.deleteMany({ where: { userId: createdUser.userId } });
        await prisma.user.delete({ where: { userId: createdUser.userId } });
        console.log(`  \x1b[32m✔ [CLEANUP]\x1b[0m Successfully deleted test user ID: ${createdUser.userId}`);
      } catch (cleanErr: any) {
        console.error('  \x1b[31m✖ [CLEANUP ERROR]\x1b[0m Could not delete test user:', cleanErr.message);
      }
    }
    if (googleCreatedUser && googleCreatedUser.userId) {
      try {
        await prisma.customerProfile.deleteMany({ where: { userId: googleCreatedUser.userId } });
        await prisma.refreshToken.deleteMany({ where: { userId: googleCreatedUser.userId } });
        await prisma.user.delete({ where: { userId: googleCreatedUser.userId } });
        console.log(`  \x1b[32m✔ [CLEANUP]\x1b[0m Successfully deleted test Google user ID: ${googleCreatedUser.userId}`);
      } catch (cleanErr: any) {
        console.error('  \x1b[31m✖ [CLEANUP ERROR]\x1b[0m Could not delete test Google user:', cleanErr.message);
      }
    }
    await prisma.$disconnect();
  }

  console.log('\n================================================================================');
  console.log(`📊 TEST SUITE SUMMARY: PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runUserAvatarTestSuite();
