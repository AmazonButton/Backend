import * as dotenv from 'dotenv';
dotenv.config();
import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { FirebasePhoneService } from '../src/auth/firebase-phone.service';
import { AuthRepository } from '../src/auth/auth.repository';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { VerifyFirebasePhoneDto } from '../src/auth/dto/verify-firebase-phone.dto';
import { RegisterByPhoneDto } from '../src/auth/dto/register-by-phone.dto';
import { LoginByPhoneDto } from '../src/auth/dto/login-by-phone.dto';
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
  let phoneRegisteredUser: any = null;
  const createdUserIds: bigint[] = [];

  const testProjectId = process.env.FIREBASE_PROJECT_ID || 'iot-button-e59d7';
  const validTokenStr = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMzQ1In0.' + 'b'.repeat(120) + '.' + 'c'.repeat(60);

  try {
    // -------------------------------------------------------------------------
    // 1. DTO VALIDATION TESTS
    // -------------------------------------------------------------------------
    console.log('[Phase 1: DTO Validation Testing]');

    // 1a. VerifyFirebasePhoneDto
    const emptyDto = plainToInstance(VerifyFirebasePhoneDto, { firebaseIdToken: '' });
    const emptyErrors = await validate(emptyDto);
    assert(emptyErrors.length > 0, 'VerifyFirebasePhoneDto rejects empty string firebaseIdToken');

    const shortDto = plainToInstance(VerifyFirebasePhoneDto, { firebaseIdToken: 'too-short-token' });
    const shortErrors = await validate(shortDto);
    assert(shortErrors.length > 0, 'VerifyFirebasePhoneDto rejects token < 100 characters');

    // 1b. RegisterByPhoneDto
    const regEmptyToken = plainToInstance(RegisterByPhoneDto, {
      firebaseIdToken: '',
      fullName: 'Nguyen Van A',
    });
    const regEmptyTokenErrors = await validate(regEmptyToken);
    assert(regEmptyTokenErrors.length > 0, 'RegisterByPhoneDto rejects empty firebaseIdToken');

    const regEmptyName = plainToInstance(RegisterByPhoneDto, {
      firebaseIdToken: validTokenStr,
      fullName: '',
    });
    const regEmptyNameErrors = await validate(regEmptyName);
    assert(regEmptyNameErrors.length > 0, 'RegisterByPhoneDto rejects empty fullName');

    const regInvalidEmail = plainToInstance(RegisterByPhoneDto, {
      firebaseIdToken: validTokenStr,
      fullName: 'Nguyen Van A',
      email: 'not-an-email',
    });
    const regInvalidEmailErrors = await validate(regInvalidEmail);
    assert(regInvalidEmailErrors.length > 0, 'RegisterByPhoneDto rejects invalid email format');

    const regAdminRole = plainToInstance(RegisterByPhoneDto, {
      firebaseIdToken: validTokenStr,
      fullName: 'Attacker Admin',
      role: 'ADMIN',
    });
    const regAdminRoleErrors = await validate(regAdminRole);
    assert(regAdminRoleErrors.length > 0, 'RegisterByPhoneDto rejects unauthorized role registration (ADMIN)');

    const regStoreOwnerRole = plainToInstance(RegisterByPhoneDto, {
      firebaseIdToken: validTokenStr,
      fullName: 'Store Owner',
      role: 'STORE_OWNER',
    });
    const regStoreOwnerRoleErrors = await validate(regStoreOwnerRole);
    assert(regStoreOwnerRoleErrors.length > 0, 'RegisterByPhoneDto rejects unauthorized role registration (STORE_OWNER)');

    const regValidDto = plainToInstance(RegisterByPhoneDto, {
      firebaseIdToken: validTokenStr,
      fullName: 'Nguyen Van Valid',
      role: 'CUSTOMER',
    });
    const regValidDtoErrors = await validate(regValidDto);
    assert(regValidDtoErrors.length === 0, 'RegisterByPhoneDto accepts valid payload with role CUSTOMER and no email/password');

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
    createdUserIds.push(user1.userId);

    user2 = await prisma.user.create({
      data: {
        username: `phone_test_user_2_${ts}`,
        email: `phone_test_2_${ts}@example.com`,
        fullName: 'Le Thi Phone Two',
        passwordHash,
        status: 'ACTIVE',
      },
    });
    createdUserIds.push(user2.userId);
    console.log(`Created test users: User1 (ID: ${user1.userId}), User2 (ID: ${user2.userId})`);

    const authRepo = new AuthRepository(prisma as any);
    const jwtService = new JwtService({ secret: process.env.JWT_SECRET || 'sob_jwt_secret_dev_2026' });
    const mockMailService: any = {
      sendVerificationEmail: async () => {},
      sendPasswordResetEmail: async () => {},
      sendOtpEmail: async () => true,
    };

    // -------------------------------------------------------------------------
    // 3. SERVICE LOGIC: VALID TOKEN VERIFICATION & DATABASE PERSISTENCE FOR EXISTING USER
    // -------------------------------------------------------------------------
    console.log('\n[Phase 3: Existing User Phone Verification (/auth/phone/verify)]');

    const mockAuthSuccess: any = {
      verifyIdToken: async (token: string, checkRevoked?: boolean) => {
        if (!checkRevoked) throw new Error('checkRevoked must be true');
        return {
          uid: `fb_uid_user1_${ts}`,
          phone_number: '+84901234567',
          firebase: {
            sign_in_provider: 'phone',
            project_id: testProjectId,
          },
          aud: testProjectId,
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
    // 4. PHONE-FIRST REGISTRATION (POST /api/v1/auth/register-by-phone)
    // -------------------------------------------------------------------------
    console.log('\n[Phase 4: Phone-First Registration (/auth/register-by-phone)]');

    const newPhoneUid = `fb_uid_new_phone_${ts}`;
    const newPhoneNumber = '+84977112233';

    const mockAuthNewRegistration: any = {
      verifyIdToken: async () => ({
        uid: newPhoneUid,
        phone_number: newPhoneNumber,
        firebase: {
          sign_in_provider: 'phone',
          project_id: testProjectId,
        },
        aud: testProjectId,
      }),
    };

    const phoneServiceNewReg = new FirebasePhoneService(mockAuthNewRegistration, authRepo);
    const authServiceNewReg = new AuthService(mockMailService, authRepo, jwtService, phoneServiceNewReg);

    // 4a. Register with valid token, no password, null email
    const regResult = await authServiceNewReg.registerByPhone({
      firebaseIdToken: validTokenStr,
      fullName: 'Vo Thi Phone Customer',
      role: 'CUSTOMER',
    });

    assert(regResult.success === true, 'registerByPhone returns success: true');
    assert(typeof regResult.data.accessToken === 'string', 'registerByPhone returns valid JWT accessToken');
    assert(typeof regResult.data.refreshToken === 'string', 'registerByPhone returns valid refreshToken');
    assert(regResult.data.user.role === 'CUSTOMER', 'Registered user has role CUSTOMER');
    assert(regResult.data.user.phone === newPhoneNumber, 'Registered user returned phone matches token');
    assert(regResult.data.user.phoneVerified === true, 'Registered user phoneVerified is true');

    // Check zero sensitive leaks in response envelope
    assert((regResult.data as any).passwordHash === undefined, 'Zero leak: passwordHash not in response data');
    assert((regResult.data as any).refreshTokenHash === undefined, 'Zero leak: refreshTokenHash not in response data');
    assert((regResult.data as any).firebaseIdToken === undefined, 'Zero leak: raw firebaseIdToken not in response data');

    const createdUserIdBigInt = BigInt(regResult.data.user.userId);
    createdUserIds.push(createdUserIdBigInt);
    phoneRegisteredUser = await prisma.user.findUnique({
      where: { userId: createdUserIdBigInt },
      include: { customerProfile: true, refreshTokens: true },
    });

    assert(phoneRegisteredUser !== null, 'Database User record exists for phone registered user');
    assert(phoneRegisteredUser?.email === null, 'User created without email has email = null (nullable column verified)');
    assert(phoneRegisteredUser?.passwordHash === null, 'User created without password has password_hash = null');
    assert(phoneRegisteredUser?.phone === newPhoneNumber, 'Database user.phone stored correctly');
    assert(phoneRegisteredUser?.firebaseUid === newPhoneUid, 'Database user.firebase_uid stored correctly');
    assert(phoneRegisteredUser?.phoneVerifiedAt !== null, 'Database user.phone_verified_at set upon registration');
    assert(phoneRegisteredUser?.customerProfile !== null, 'CustomerProfile created in transaction for new user');
    assert(phoneRegisteredUser?.refreshTokens?.length > 0, 'RefreshToken record created in transaction for new user');

    // -------------------------------------------------------------------------
    // 5. SECURITY INVARIANTS & REJECTIONS FOR REGISTER-BY-PHONE
    // -------------------------------------------------------------------------
    console.log('\n[Phase 5: Security Invariants & Rejection Tests]');

    // 5a. Expired / tampered / revoked token -> 401
    const mockAuthExpired: any = {
      verifyIdToken: async () => {
        throw new Error('Firebase ID token has expired or signature is invalid');
      },
    };
    const phoneServiceExpired = new FirebasePhoneService(mockAuthExpired, authRepo);
    const authServiceExpired = new AuthService(mockMailService, authRepo, jwtService, phoneServiceExpired);
    let expiredRejected = false;
    try {
      await authServiceExpired.registerByPhone({
        firebaseIdToken: validTokenStr,
        fullName: 'Test User',
      });
    } catch (e: any) {
      expiredRejected = e instanceof UnauthorizedException && e.message === 'Invalid Firebase ID token';
    }
    assert(expiredRejected, 'Rejects expired/tampered Firebase token with 401 Unauthorized');

    // 5b. Non-phone provider token (e.g. google.com or password) -> 401
    const mockAuthNonPhoneProvider: any = {
      verifyIdToken: async () => ({
        uid: `fb_uid_google_${ts}`,
        email: 'user@gmail.com',
        firebase: { sign_in_provider: 'google.com', project_id: testProjectId },
        aud: testProjectId,
      }),
    };
    const phoneServiceNonPhone = new FirebasePhoneService(mockAuthNonPhoneProvider, authRepo);
    const authServiceNonPhone = new AuthService(mockMailService, authRepo, jwtService, phoneServiceNonPhone);
    let nonPhoneRejected = false;
    try {
      await authServiceNonPhone.registerByPhone({
        firebaseIdToken: validTokenStr,
        fullName: 'Test User',
      });
    } catch (e: any) {
      nonPhoneRejected = e instanceof UnauthorizedException && e.message === 'Token is not from Firebase phone authentication';
    }
    assert(nonPhoneRejected, 'Rejects non-phone sign_in_provider with 401 Unauthorized');

    // 5c. Wrong Firebase Project ID -> 401
    const mockAuthWrongProject: any = {
      verifyIdToken: async () => ({
        uid: `fb_uid_wrong_proj_${ts}`,
        phone_number: '+84911223344',
        firebase: { sign_in_provider: 'phone', project_id: 'malicious-or-wrong-project' },
        aud: 'malicious-or-wrong-project',
      }),
    };
    const phoneServiceWrongProject = new FirebasePhoneService(mockAuthWrongProject, authRepo);
    const authServiceWrongProject = new AuthService(mockMailService, authRepo, jwtService, phoneServiceWrongProject);
    let wrongProjectRejected = false;
    try {
      await authServiceWrongProject.registerByPhone({
        firebaseIdToken: validTokenStr,
        fullName: 'Test User',
      });
    } catch (e: any) {
      wrongProjectRejected = e instanceof UnauthorizedException && e.message === 'Firebase token project mismatch';
    }
    assert(wrongProjectRejected, 'Rejects token with mismatched Project ID with 401 Unauthorized');

    // 5d. Missing phone_number claim in token -> 401
    const mockAuthNoPhone: any = {
      verifyIdToken: async () => ({
        uid: `fb_uid_nophone_${ts}`,
        firebase: { sign_in_provider: 'phone', project_id: testProjectId },
        aud: testProjectId,
      }),
    };
    const phoneServiceNoPhone = new FirebasePhoneService(mockAuthNoPhone, authRepo);
    const authServiceNoPhone = new AuthService(mockMailService, authRepo, jwtService, phoneServiceNoPhone);
    let noPhoneRejected = false;
    try {
      await authServiceNoPhone.registerByPhone({
        firebaseIdToken: validTokenStr,
        fullName: 'Test User',
      });
    } catch (e: any) {
      noPhoneRejected = e instanceof UnauthorizedException && e.message === 'Firebase token does not contain a phone number';
    }
    assert(noPhoneRejected, 'Rejects token without phone_number claim with 401 Unauthorized');

    // 5e. Duplicate Firebase UID registration -> 409 Conflict
    let dupUidRejected = false;
    try {
      await authServiceNewReg.registerByPhone({
        firebaseIdToken: validTokenStr,
        fullName: 'Duplicate UID User',
      });
    } catch (e: any) {
      dupUidRejected = e instanceof ConflictException && e.message === 'Số điện thoại này đã được đăng ký tài khoản';
    }
    assert(dupUidRejected, 'Rejects registration with already existing Firebase UID with 409 Conflict');

    // 5f. Duplicate Phone number registration (different UID but same phone) -> 409 Conflict
    const mockAuthDupPhoneDifferentUid: any = {
      verifyIdToken: async () => ({
        uid: `fb_uid_different_${ts}`,
        phone_number: newPhoneNumber, // Already registered
        firebase: { sign_in_provider: 'phone', project_id: testProjectId },
        aud: testProjectId,
      }),
    };
    const phoneServiceDupPhone = new FirebasePhoneService(mockAuthDupPhoneDifferentUid, authRepo);
    const authServiceDupPhone = new AuthService(mockMailService, authRepo, jwtService, phoneServiceDupPhone);
    let dupPhoneRejected = false;
    try {
      await authServiceDupPhone.registerByPhone({
        firebaseIdToken: validTokenStr,
        fullName: 'Duplicate Phone User',
      });
    } catch (e: any) {
      dupPhoneRejected = e instanceof ConflictException && e.message === 'Số điện thoại này đã được đăng ký tài khoản';
    }
    assert(dupPhoneRejected, 'Rejects registration with already existing phone number with 409 Conflict');

    // 5g. Concurrency / Race Condition test: 2 parallel requests with same Firebase UID -> only 1 user created
    console.log('\n[Phase 5g: Concurrency / Race-Condition Testing]');
    const racePhoneUid = `fb_uid_race_${ts}`;
    const racePhoneNumber = '+84999000111';

    const mockAuthRace: any = {
      verifyIdToken: async () => ({
        uid: racePhoneUid,
        phone_number: racePhoneNumber,
        firebase: { sign_in_provider: 'phone', project_id: testProjectId },
        aud: testProjectId,
      }),
    };
    const phoneServiceRaceInstance = new FirebasePhoneService(mockAuthRace, authRepo);
    const authServiceRace = new AuthService(mockMailService, authRepo, jwtService, phoneServiceRaceInstance);

    const [raceRes1, raceRes2] = await Promise.allSettled([
      authServiceRace.registerByPhone({
        firebaseIdToken: validTokenStr,
        fullName: 'Race User 1',
      }),
      authServiceRace.registerByPhone({
        firebaseIdToken: validTokenStr,
        fullName: 'Race User 2',
      }),
    ]);

    const oneFulfilled = (raceRes1.status === 'fulfilled' && raceRes2.status === 'rejected') ||
                         (raceRes2.status === 'fulfilled' && raceRes1.status === 'rejected');
    const oneConflict = (raceRes1.status === 'rejected' && (raceRes1 as any).reason instanceof ConflictException) ||
                        (raceRes2.status === 'rejected' && (raceRes2 as any).reason instanceof ConflictException);

    assert(oneFulfilled && oneConflict, 'Concurrent duplicate registrations: exactly 1 succeeds and 1 gets 409 Conflict');

    if (raceRes1.status === 'fulfilled') {
      createdUserIds.push(BigInt((raceRes1.value as any).data.user.userId));
    }
    if (raceRes2.status === 'fulfilled') {
      createdUserIds.push(BigInt((raceRes2.value as any).data.user.userId));
    }

    // -------------------------------------------------------------------------
    // 6. LOGIN WITH REGISTERED FIREBASE PHONE (POST /api/v1/auth/login-by-phone)
    // -------------------------------------------------------------------------
    console.log('\n[Phase 6: Login By Firebase Phone (/auth/login-by-phone)]');

    const loginResult = await authServiceNewReg.loginByPhone({
      firebaseIdToken: validTokenStr,
    });

    assert(loginResult.success === true, 'loginByPhone returns success: true');
    assert(typeof loginResult.data.accessToken === 'string', 'loginByPhone returns accessToken');
    assert(typeof loginResult.data.refreshToken === 'string', 'loginByPhone returns rotated refreshToken');
    assert(loginResult.data.user.userId === createdUserIdBigInt.toString(), 'loginByPhone returns correct userId');
    assert(loginResult.data.user.phoneVerified === true, 'loginByPhone returns phoneVerified = true');

    // Login with un-registered Firebase UID -> 401 Unauthorized
    const mockAuthUnregistered: any = {
      verifyIdToken: async () => ({
        uid: `fb_uid_unregistered_${ts}`,
        phone_number: '+84912345999',
        firebase: { sign_in_provider: 'phone', project_id: testProjectId },
        aud: testProjectId,
      }),
    };
    const phoneServiceUnregistered = new FirebasePhoneService(mockAuthUnregistered, authRepo);
    const authServiceUnregistered = new AuthService(mockMailService, authRepo, jwtService, phoneServiceUnregistered);
    let unregisteredRejected = false;
    try {
      await authServiceUnregistered.loginByPhone({
        firebaseIdToken: validTokenStr,
      });
    } catch (e: any) {
      unregisteredRejected = e instanceof UnauthorizedException;
    }
    assert(unregisteredRejected, 'loginByPhone with un-registered token returns 401 Unauthorized');

    // -------------------------------------------------------------------------
    // 7. CONTROLLER INTEGRATION & ROUTE RESPONSE ENVELOPE
    // -------------------------------------------------------------------------
    console.log('\n[Phase 7: AuthController Integration & Envelope Shape]');

    const authController = new AuthController(authServiceNewReg, phoneServiceNewReg);
    const controllerRegResponse = await authController.registerByPhone({
      firebaseIdToken: validTokenStr,
      fullName: 'Controller Reg User',
    }).catch(e => e);

    // Because newPhoneUid is already registered, controller correctly returns ConflictException
    assert(controllerRegResponse instanceof ConflictException, 'Controller delegates to service and propagates ConflictException');

  } catch (err: any) {
    console.error('Unhandled exception in test suite:', err);
    failed++;
  } finally {
    // -------------------------------------------------------------------------
    // 8. SCOPED CLEANUP
    // -------------------------------------------------------------------------
    console.log('\n[Phase 8: Scoped Cleanup]');
    for (const uid of createdUserIds) {
      try {
        await prisma.refreshToken.deleteMany({ where: { userId: uid } });
        await prisma.customerProfile.deleteMany({ where: { userId: uid } });
        await prisma.user.delete({ where: { userId: uid } });
        console.log(`Cleaned up user ID: ${uid}`);
      } catch (e: any) {
        // ignore cleanup error
      }
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
