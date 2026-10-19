import * as dotenv from 'dotenv';
dotenv.config();
import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { FirebasePhoneService } from '../src/auth/firebase-phone.service';
import { AuthRepository } from '../src/auth/auth.repository';
import { AuthController } from '../src/auth/auth.controller';
import { VerifyFirebasePhoneDto } from '../src/auth/dto/verify-firebase-phone.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function runFirebasePhoneAuthTestSuite() {
  console.log('================================================================================');
  console.log('🔥 FIREBASE PHONE AUTHENTICATION INTEGRATION & UNIT TEST SUITE');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const ts = Date.now();
  let user1: any = null;
  let user2: any = null;

  try {
    // -------------------------------------------------------------------------
    // 1. DTO VALIDATION TESTS
    // -------------------------------------------------------------------------
    console.log('[Phase 1: DTO Validation Testing]');

    const emptyDto = plainToInstance(VerifyFirebasePhoneDto, { firebaseIdToken: '' });
    const emptyErrors = await validate(emptyDto);
    assert(emptyErrors.length > 0, 'DTO rejects empty string firebaseIdToken');

    const shortDto = plainToInstance(VerifyFirebasePhoneDto, { firebaseIdToken: 'too-short-token' });
    const shortErrors = await validate(shortDto);
    assert(shortErrors.length > 0, 'DTO rejects firebaseIdToken with length < 100 characters');

    const longStr = 'a'.repeat(5001);
    const longDto = plainToInstance(VerifyFirebasePhoneDto, { firebaseIdToken: longStr });
    const longErrors = await validate(longDto);
    assert(longErrors.length > 0, 'DTO rejects firebaseIdToken with length > 5000 characters');

    const validTokenStr = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMzQ1In0.' + 'b'.repeat(120) + '.' + 'c'.repeat(60);
    const validDto = plainToInstance(VerifyFirebasePhoneDto, { firebaseIdToken: validTokenStr });
    const validErrors = await validate(validDto);
    assert(validErrors.length === 0, 'DTO accepts valid length (100-5000) token string');

    // -------------------------------------------------------------------------
    // 2. SETUP DATABASE TEST FIXTURES
    // -------------------------------------------------------------------------
    console.log('\n[Phase 2: Database Fixtures Setup]');
    const passwordHash = await bcrypt.hash('Secret123!', 10);

    user1 = await prisma.user.create({
      data: {
        username: `phone_test_user_1_${ts}`,
        email: `phone_test_1_${ts}@example.com`,
        fullName: 'Nguyen Van Phone One',
        passwordHash,
        status: 'ACTIVE',
      },
    });

    user2 = await prisma.user.create({
      data: {
        username: `phone_test_user_2_${ts}`,
        email: `phone_test_2_${ts}@example.com`,
        fullName: 'Le Thi Phone Two',
        passwordHash,
        status: 'ACTIVE',
      },
    });
    console.log(`Created test users: User1 (ID: ${user1.userId}), User2 (ID: ${user2.userId})`);

    const authRepo = new AuthRepository(prisma as any);

    // -------------------------------------------------------------------------
    // 3. SERVICE LOGIC: VALID TOKEN VERIFICATION & DATABASE PERSISTENCE
    // -------------------------------------------------------------------------
    console.log('\n[Phase 3: Valid Token Verification & Database Persistence]');

    const mockAuthSuccess: any = {
      verifyIdToken: async (token: string, checkRevoked?: boolean) => {
        if (!checkRevoked) throw new Error('checkRevoked must be true');
        return {
          uid: `fb_uid_user1_${ts}`,
          phone_number: '+84901234567',
          firebase: {
            sign_in_provider: 'phone',
            project_id: process.env.FIREBASE_PROJECT_ID || 'iot-button-e59d7',
          },
          aud: process.env.FIREBASE_PROJECT_ID || 'iot-button-e59d7',
        };
      },
    };

    const phoneService = new FirebasePhoneService(mockAuthSuccess, authRepo);
    const result1 = await phoneService.verifyPhoneToken(validTokenStr, user1.userId);

    assert(result1.phoneNumber === '+84901234567', 'Service returns verified phoneNumber extracted from token');
    assert(result1.firebaseUid === `fb_uid_user1_${ts}`, 'Service returns firebaseUid from decoded token');
    assert(result1.verifiedAt instanceof Date, 'Service returns verifiedAt timestamp');

    // Check DB persistence
    const updatedUser1 = await prisma.user.findUnique({ where: { userId: user1.userId } });
    assert(updatedUser1?.phone === '+84901234567', 'Database user.phone updated with token phone number');
    assert(updatedUser1?.phoneVerifiedAt !== null, 'Database user.phone_verified_at set to non-null timestamp');
    assert(updatedUser1?.firebaseUid === `fb_uid_user1_${ts}`, 'Database user.firebase_uid stored properly');

    // -------------------------------------------------------------------------
    // 4. SECURITY CHECKS: REJECTIONS OF INVALID TOKENS
    // -------------------------------------------------------------------------
    console.log('\n[Phase 4: Security Invariants & Rejection Tests]');

    // 4a. Expired / tampered / revoked token -> 401
    const mockAuthExpired: any = {
      verifyIdToken: async () => {
        throw new Error('Firebase ID token has expired or signature is invalid');
      },
    };
    const phoneServiceExpired = new FirebasePhoneService(mockAuthExpired, authRepo);
    let expiredRejected = false;
    try {
      await phoneServiceExpired.verifyPhoneToken(validTokenStr, user1.userId);
    } catch (e: any) {
      expiredRejected = e instanceof UnauthorizedException && e.message === 'Invalid Firebase ID token';
    }
    assert(expiredRejected, 'Rejects expired/tampered Firebase token with 401 Unauthorized');

    // 4b. Provider is not 'phone' (e.g. google.com or password) -> 401
    const testProjectId = process.env.FIREBASE_PROJECT_ID || 'iot-button-e59d7';
    const mockAuthNonPhoneProvider: any = {
      verifyIdToken: async () => ({
        uid: `fb_uid_google_${ts}`,
        email: 'user@gmail.com',
        firebase: { sign_in_provider: 'google.com', project_id: testProjectId },
        aud: testProjectId,
      }),
    };
    const phoneServiceNonPhone = new FirebasePhoneService(mockAuthNonPhoneProvider, authRepo);
    let nonPhoneRejected = false;
    try {
      await phoneServiceNonPhone.verifyPhoneToken(validTokenStr, user1.userId);
    } catch (e: any) {
      nonPhoneRejected = e instanceof UnauthorizedException && e.message === 'Token is not from Firebase phone authentication';
    }
    assert(nonPhoneRejected, 'Rejects non-phone sign_in_provider (e.g. google.com) with 401');

    // 4c. Missing phone_number claim in token -> 401
    const mockAuthNoPhone: any = {
      verifyIdToken: async () => ({
        uid: `fb_uid_nophone_${ts}`,
        firebase: { sign_in_provider: 'phone', project_id: testProjectId },
        aud: testProjectId,
      }),
    };
    const phoneServiceNoPhone = new FirebasePhoneService(mockAuthNoPhone, authRepo);
    let noPhoneRejected = false;
    try {
      await phoneServiceNoPhone.verifyPhoneToken(validTokenStr, user1.userId);
    } catch (e: any) {
      noPhoneRejected = e instanceof UnauthorizedException && e.message === 'Firebase token does not contain a phone number';
    }
    assert(noPhoneRejected, 'Rejects token without phone_number claim with 401');

    // 4d. Empty or whitespace token -> 400
    let emptyTokenRejected = false;
    try {
      await phoneService.verifyPhoneToken('   ', user1.userId);
    } catch (e: any) {
      emptyTokenRejected = e instanceof BadRequestException;
    }
    assert(emptyTokenRejected, 'Rejects empty or whitespace-only token with 400 Bad Request');

    // 4e. Duplicate Firebase UID linking (prevent account hijacking) -> 409 Conflict
    const mockAuthDuplicateUid: any = {
      verifyIdToken: async () => ({
        uid: `fb_uid_user1_${ts}`, // Already bound to User 1
        phone_number: '+84901234567',
        firebase: { sign_in_provider: 'phone', project_id: testProjectId },
        aud: testProjectId,
      }),
    };
    const phoneServiceDup = new FirebasePhoneService(mockAuthDuplicateUid, authRepo);
    let dupRejected = false;
    try {
      await phoneServiceDup.verifyPhoneToken(validTokenStr, user2.userId);
    } catch (e: any) {
      dupRejected = e instanceof ConflictException;
    }
    assert(dupRejected, 'Rejects linking Firebase UID already bound to another user with 409 Conflict');

    // 4f. Concurrent race condition: P2002 unique constraint violation in database -> 409 Conflict
    const mockRepoP2002: any = {
      findByFirebaseUid: async () => null, // passes initial check
      updatePhoneVerification: async () => {
        const p2002Err: any = new Error('Unique constraint failed on the fields: (firebase_uid)');
        p2002Err.code = 'P2002';
        throw p2002Err;
      },
    };
    const phoneServiceRace = new FirebasePhoneService(mockAuthDuplicateUid, mockRepoP2002);
    let raceConflictCaught = false;
    try {
      await phoneServiceRace.verifyPhoneToken(validTokenStr, user2.userId);
    } catch (e: any) {
      raceConflictCaught = e instanceof ConflictException;
    }
    assert(raceConflictCaught, 'Catches Prisma P2002 race-condition unique constraint violation and converts to 409 Conflict');

    // 4g. Project ID mismatch -> 401 Unauthorized
    const mockAuthWrongProject: any = {
      verifyIdToken: async () => ({
        uid: `fb_uid_wrong_proj_${ts}`,
        phone_number: '+84901234567',
        firebase: { sign_in_provider: 'phone', project_id: 'malicious-or-wrong-project' },
        aud: 'malicious-or-wrong-project',
      }),
    };
    const phoneServiceWrongProj = new FirebasePhoneService(mockAuthWrongProject, authRepo);
    let wrongProjectRejected = false;
    try {
      await phoneServiceWrongProj.verifyPhoneToken(validTokenStr, user1.userId);
    } catch (e: any) {
      wrongProjectRejected = e instanceof UnauthorizedException && e.message === 'Firebase token project mismatch';
    }
    assert(wrongProjectRejected, 'Rejects token with mismatched Project ID with 401 Unauthorized');

    // -------------------------------------------------------------------------
    // 5. PHONE NUMBER CHANGE RE-VERIFICATION
    // -------------------------------------------------------------------------
    console.log('\n[Phase 5: Changing Phone Number with New Verified Token]');

    const mockAuthNewPhone: any = {
      verifyIdToken: async () => ({
        uid: `fb_uid_user1_new_${ts}`,
        phone_number: '+84988889999',
        firebase: { sign_in_provider: 'phone', project_id: testProjectId },
        aud: testProjectId,
      }),
    };
    const phoneServiceNewPhone = new FirebasePhoneService(mockAuthNewPhone, authRepo);
    const resultNewPhone = await phoneServiceNewPhone.verifyPhoneToken(validTokenStr, user1.userId);

    assert(resultNewPhone.phoneNumber === '+84988889999', 'Successfully updates to new phone number with new valid token');
    const reCheckedUser1 = await prisma.user.findUnique({ where: { userId: user1.userId } });
    assert(reCheckedUser1?.phone === '+84988889999', 'Database reflect updated phone number');
    assert(reCheckedUser1?.firebaseUid === `fb_uid_user1_new_${ts}`, 'Database reflects updated firebaseUid');

    // -------------------------------------------------------------------------
    // 6. CONTROLLER UNIFORM RESPONSE SHAPE
    // -------------------------------------------------------------------------
    console.log('\n[Phase 6: AuthController Integration & Envelope Shape]');

    const mockAuthUser2: any = {
      verifyIdToken: async () => ({
        uid: `fb_uid_user2_${ts}`,
        phone_number: '+84933334444',
        firebase: { sign_in_provider: 'phone', project_id: testProjectId },
        aud: testProjectId,
      }),
    };
    const phoneServiceUser2 = new FirebasePhoneService(mockAuthUser2, authRepo);
    const controllerWithUser2 = new AuthController({} as any, phoneServiceUser2);

    const controllerReq = {
      user: {
        id: user2.userId.toString(),
        userId: user2.userId.toString(),
      },
    };

    const controllerRes = await controllerWithUser2.verifyPhone(controllerReq, {
      firebaseIdToken: validTokenStr,
    });

    assert(controllerRes.success === true, 'Controller response contains success: true');
    assert(controllerRes.data?.phoneNumber === '+84933334444', 'Controller response envelopes phoneNumber in data');
    assert((controllerRes as any).phoneNumber === undefined, 'Controller response does not duplicate phoneNumber at top-level');
    assert(controllerRes.data?.firebaseUid === `fb_uid_user2_${ts}`, 'Controller response contains firebaseUid in data');

  } catch (err: any) {
    console.error('Unhandled exception in test suite:', err);
    failed++;
  } finally {
    // Cleanup test users
    console.log('\n[Phase 7: Cleanup]');
    if (user1) {
      await prisma.user.delete({ where: { userId: user1.userId } }).catch(() => {});
    }
    if (user2) {
      await prisma.user.delete({ where: { userId: user2.userId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log('\n================================================================================');
  console.log(`Firebase Phone Auth Test Results: ${passed} Passed, ${failed} Failed`);
  console.log('================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runFirebasePhoneAuthTestSuite();
