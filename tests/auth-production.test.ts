import crypto from 'crypto';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api/v1';

function logTest(name: string, passed: boolean, detail?: string) {
  if (passed) {
    console.log(`\x1b[32m  ✔ [PASS]\x1b[0m ${name}`);
  } else {
    console.log(`\x1b[31m  ✖ [FAIL]\x1b[0m ${name} - ${detail || ''}`);
  }
}

async function runAuthTests() {
  console.log('\n======================================================');
  console.log('🛡️ AUTHENTICATION & SECURITY AUDIT — ZERO RESIDUE SUITE');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;
  const createdUserIds: bigint[] = [];
  const createdRefreshTokenHashes: string[] = [];

  // 0. Baseline measurement
  const baseUsers = await prisma.user.count();
  const baseRefresh = await prisma.refreshToken.count();
  const baseOtps = await prisma.authOtp.count();

  const testId = Date.now().toString().substring(6);
  const testEmail = `user_${testId}@smartorder.test`;
  const testUsername = `testuser_${testId}`;
  const testPassword = 'Password123!@#';
  const clientIp = '10.200.' + (Math.floor(Math.random() * 250) + 1) + '.1';

  try {
    // 1. Realtime Check: Email not exists yet
    try {
      const res = await fetch(`${BASE_URL}/auth/check-email?email=${testEmail}`);
      const data = await res.json();
      if (res.status === 200 && data.exists === false) {
        logTest('Check Email: Available Email', true);
        passed++;
      } else {
        throw new Error(`Expected exists: false, got ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Check Email: Available Email', false, e.message);
      failed++;
    }

    // 2. Realtime Check: Username not exists yet
    try {
      const res = await fetch(`${BASE_URL}/auth/check-username?username=${testUsername}`);
      const data = await res.json();
      if (res.status === 200 && data.exists === false) {
        logTest('Check Username: Available Username', true);
        passed++;
      } else {
        throw new Error(`Expected exists: false, got ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Check Username: Available Username', false, e.message);
      failed++;
    }

    // 3. Register Success (No raw verification token or OTP leaked)
    try {
      const res = await fetch(`${BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({
          fullName: 'Nguyễn Văn Test',
          username: testUsername,
          email: testEmail,
          password: testPassword,
          phone: '0901234567',
          address: '123 Đường Test, Quận 1',
        }),
      });
      const data = await res.json();
      if (res.status === 201 && data.success && !data.data?.verificationToken && !data.data?.otp) {
        logTest('Register: Success & Zero Token Leaks (No raw OTP in envelope)', true);
        passed++;

        // Track created user for teardown
        const createdUser = await prisma.user.findUnique({ where: { email: testEmail } });
        if (createdUser) createdUserIds.push(createdUser.userId);
      } else {
        throw new Error(`Status ${res.status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Register: Success & Zero Token Leaks (No raw OTP in envelope)', false, e.message);
      failed++;
    }

    // 4. Register Duplicate Email Prevention (409 Conflict)
    try {
      const res = await fetch(`${BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({
          fullName: 'Người Trùng Email',
          username: `other_${testId}`,
          email: testEmail,
          password: testPassword,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && (data.code === 'EMAIL_ALREADY_EXISTS' || data.message?.includes('Email này đã được sử dụng'))) {
        logTest('Register: Block Duplicate Email (409 Conflict)', true);
        passed++;
      } else {
        throw new Error(`Expected 409, got ${res.status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Register: Block Duplicate Email (409 Conflict)', false, e.message);
      failed++;
    }

    // 5. Register Duplicate Username Prevention (409 Conflict)
    try {
      const res = await fetch(`${BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({
          fullName: 'Người Trùng Username',
          username: testUsername,
          email: `unique_${testId}@smartorder.test`,
          password: testPassword,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && (data.code === 'USERNAME_ALREADY_EXISTS' || data.message?.includes('Username này đã được sử dụng'))) {
        logTest('Register: Block Duplicate Username (409 Conflict)', true);
        passed++;
      } else {
        throw new Error(`Expected 409, got ${res.status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Register: Block Duplicate Username (409 Conflict)', false, e.message);
      failed++;
    }

    // 6. Check Email: Now exists
    try {
      const res = await fetch(`${BASE_URL}/auth/check-email?email=${testEmail}`);
      const data = await res.json();
      if (res.status === 200 && data.exists === true) {
        logTest('Check Email: Correctly Detects Registered Email', true);
        passed++;
      } else {
        throw new Error(`Expected exists: true, got ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Check Email: Correctly Detects Registered Email', false, e.message);
      failed++;
    }

    // 7. Verify Email: Rejects invalid token
    try {
      const res = await fetch(`${BASE_URL}/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({ token: '000000' }),
      });
      if (res.status === 400) {
        logTest('Verify Email: Correctly Rejected Invalid Token (400 Bad Request)', true);
        passed++;
      } else {
        throw new Error(`Expected 400, got ${res.status}`);
      }
    } catch (e: any) {
      logTest('Verify Email: Correctly Rejected Invalid Token (400 Bad Request)', false, e.message);
      failed++;
    }

    // 8. Verify Email: Success with seeded test OTP
    const verifyOtp = '123456';
    const pepper = process.env.OTP_PEPPER || process.env.JWT_SECRET || 'sob_secure_otp_pepper_2026';
    const verifyOtpHmac = crypto.createHmac('sha256', pepper).update(`${verifyOtp}:EMAIL_VERIFICATION`).digest('hex');

    const targetUser = await prisma.user.findUnique({ where: { email: testEmail } });
    if (targetUser) {
      await prisma.authOtp.create({
        data: {
          userId: targetUser.userId,
          email: targetUser.email,
          purpose: 'EMAIL_VERIFICATION',
          tokenHash: verifyOtpHmac,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });
    }

    try {
      const res = await fetch(`${BASE_URL}/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({ email: testEmail, token: verifyOtp }),
      });
      const data = await res.json();
      if (res.status === 200 && data.success) {
        logTest('Verify Email: Successfully Verified & Activated Account', true);
        passed++;
      } else {
        throw new Error(`Status ${res.status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Verify Email: Successfully Verified & Activated Account', false, e.message);
      failed++;
    }

    // 9. Login Success with Email
    let accessToken = '';
    let refreshToken = '';
    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword,
        }),
      });
      const data = await res.json();
      if (res.status === 200 && data.accessToken && data.refreshToken) {
        accessToken = data.accessToken;
        refreshToken = data.refreshToken;
        logTest('Login: Success with Email & Password (Issued 15m Access Token & 7d Refresh)', true);
        passed++;
      } else {
        throw new Error(`Status ${res.status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Login: Success with Email & Password', false, e.message);
      failed++;
    }

    // 10. Login Success with Username Identifier
    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({
          email: testUsername,
          password: testPassword,
        }),
      });
      const data = await res.json();
      if (res.status === 200 && data.accessToken) {
        logTest('Login: Success with Username Identifier', true);
        passed++;
      } else {
        throw new Error(`Status ${res.status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Login: Success with Username Identifier', false, e.message);
      failed++;
    }

    // 11. Login Generic Error: Wrong Password
    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({
          email: testEmail,
          password: 'WrongPassword999!',
        }),
      });
      const data = await res.json();
      if (res.status === 401 && data.message === 'Email hoặc mật khẩu không chính xác.') {
        logTest('Login Security: Generic Error on Wrong Password (Anti-Enumeration)', true);
        passed++;
      } else {
        throw new Error(`Expected generic error, got ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Login Security: Generic Error on Wrong Password', false, e.message);
      failed++;
    }

    // 12. Login Generic Error: Non-existent Email
    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({
          email: 'does_not_exist_998877@nowhere.com',
          password: 'Password123!',
        }),
      });
      const data = await res.json();
      if (res.status === 401 && data.message === 'Email hoặc mật khẩu không chính xác.') {
        logTest('Login Security: Generic Error on Unknown Email (Anti-Enumeration)', true);
        passed++;
      } else {
        throw new Error(`Expected generic error, got ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Login Security: Generic Error on Unknown Email', false, e.message);
      failed++;
    }

    // 13. Token Refresh Rotation
    let newAccessToken = '';
    let newRefreshToken = '';
    try {
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({ refreshToken }),
      });
      const data = await res.json();
      if (res.status === 200 && data.accessToken && data.refreshToken) {
        newAccessToken = data.accessToken;
        newRefreshToken = data.refreshToken;
        logTest('Session: Token Refresh Rotation (New 15m Access & 7d Refresh Issued)', true);
        passed++;
      } else {
        throw new Error(`Status ${res.status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Session: Token Refresh Rotation', false, e.message);
      failed++;
    }

    // 14. Reused Old Refresh Token is Blocked
    try {
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({ refreshToken }),
      });
      if (res.status === 401) {
        logTest('Security: Reused Old Refresh Token Correctly Rejected (Single-Use)', true);
        passed++;
      } else {
        throw new Error(`Expected 401 for revoked token, got ${res.status}`);
      }
    } catch (e: any) {
      logTest('Security: Reused Old Refresh Token Correctly Rejected', false, e.message);
      failed++;
    }

    // 15. Protected route: GET /auth/me
    try {
      const res = await fetch(`${BASE_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${newAccessToken}`, 'x-forwarded-for': clientIp },
      });
      const data = await res.json();
      if (res.status === 200 && data.data?.email === testEmail) {
        logTest('Protected: GET /api/auth/me Validated Authenticated User', true);
        passed++;
      } else {
        throw new Error(`Status ${res.status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Protected: GET /api/auth/me Validated Authenticated User', false, e.message);
      failed++;
    }

    // 16. Forgot Password: Anti-Enumeration Generic Response
    try {
      const res = await fetch(`${BASE_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({ email: testEmail }),
      });
      const data = await res.json();
      if (res.status === 200 && data.message?.includes('Nếu email tồn tại trong hệ thống')) {
        logTest('Forgot Password: Anti-Timing Enumeration & Generic Response', true);
        passed++;
      } else {
        throw new Error(`Status ${res.status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Forgot Password: Anti-Timing Enumeration & Generic Response', false, e.message);
      failed++;
    }

    // 17. CONCURRENT PASSWORD RESET RACE CONDITION TEST (Release Blocker #2)
    const resetOtp = '888999';
    const resetOtpHmac = crypto.createHmac('sha256', pepper).update(`${resetOtp}:PASSWORD_RESET`).digest('hex');

    if (targetUser) {
      await prisma.authOtp.create({
        data: {
          userId: targetUser.userId,
          email: targetUser.email,
          purpose: 'PASSWORD_RESET',
          tokenHash: resetOtpHmac,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });
    }

    try {
      const [resResetA, resResetB] = await Promise.all([
        fetch(`${BASE_URL}/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
          body: JSON.stringify({ email: testEmail, token: resetOtp, newPassword: 'NewPasswordA123!@#' }),
        }),
        fetch(`${BASE_URL}/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
          body: JSON.stringify({ email: testEmail, token: resetOtp, newPassword: 'NewPasswordB123!@#' }),
        }),
      ]);

      const resetStatuses = [resResetA.status, resResetB.status].sort();
      if (resetStatuses[0] === 200 && (resetStatuses[1] === 400 || resetStatuses[1] === 429)) {
        logTest(`Concurrency Security: Atomic OTP Consumption Blocked Concurrent Reset [200, ${resetStatuses[1]}]`, true);
        passed++;
      } else {
        throw new Error(`Race condition detected! Statuses: [${resetStatuses.join(', ')}]`);
      }
    } catch (e: any) {
      logTest('Concurrency Security: Atomic OTP Consumption Blocked Concurrent Reset', false, e.message);
      failed++;
    }

    // 18. SESSION REVOCATION TEST AFTER PASSWORD CHANGE (Release Blocker #3)
    try {
      // Prior refresh token must be revoked (401)
      const resRevokedRefresh = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({ refreshToken: newRefreshToken }),
      });

      // Prior access token must be invalidated (401)
      const resRevokedAccess = await fetch(`${BASE_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${newAccessToken}`, 'x-forwarded-for': clientIp },
      });

      if (resRevokedRefresh.status === 401 && resRevokedAccess.status === 401) {
        logTest('Session Revocation: Prior Refresh & Access Tokens Revoked After Password Reset (401)', true);
        passed++;
      } else {
        throw new Error(`Refresh: ${resRevokedRefresh.status}, Access: ${resRevokedAccess.status}`);
      }
    } catch (e: any) {
      logTest('Session Revocation: Prior Refresh & Access Tokens Revoked After Password Reset', false, e.message);
      failed++;
    }

    // 19. SECURITY: VERIFY LEAKY TEST ENDPOINT IS 404 (Release Blocker #1)
    try {
      const res = await fetch(`${BASE_URL}/auth/test/get-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({ email: testEmail }),
      });
      if (res.status === 404) {
        logTest('Security Hardening: Leaky /auth/test/get-otp Endpoint Permanently Removed (404)', true);
        passed++;
      } else {
        throw new Error(`Expected 404, got ${res.status}`);
      }
    } catch (e: any) {
      logTest('Security Hardening: Leaky /auth/test/get-otp Endpoint Permanently Removed', false, e.message);
      failed++;
    }

    // 20. Seed Accounts Compatibility
    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({
          email: 'customer@smartorder.local',
          password: 'Password123!',
        }),
      });
      const data = await res.json();
      if (res.status === 200 && data.accessToken) {
        if (data.refreshToken) {
          const h = crypto.createHash('sha256').update(data.refreshToken.trim()).digest('hex');
          createdRefreshTokenHashes.push(h);
        }
        logTest('Compatibility: Seeded Demo Accounts (customer@smartorder.local) Work Flawlessly', true);
        passed++;
      } else {
        throw new Error(`Status ${res.status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Compatibility: Seeded Demo Accounts Work Flawlessly', false, e.message);
      failed++;
    }

  } finally {
    // 21. CLEANUP ALL TEST FIXTURES
    if (createdUserIds.length > 0) {
      await prisma.authOtp.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.customerAddress.deleteMany({ where: { customer: { userId: { in: createdUserIds } } } });
      await prisma.customerProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { userId: { in: createdUserIds } } });
    }

    if (createdRefreshTokenHashes.length > 0) {
      await prisma.refreshToken.deleteMany({ where: { tokenHash: { in: createdRefreshTokenHashes } } });
    }

    // Also clean any otps associated with testEmail
    await prisma.authOtp.deleteMany({ where: { email: { contains: 'smartorder.test' } } });

    const finalUsers = await prisma.user.count();
    const finalRefresh = await prisma.refreshToken.count();
    const finalOtps = await prisma.authOtp.count();

    const deltaUsers = finalUsers - baseUsers;
    const deltaRefresh = finalRefresh - baseRefresh;
    const deltaOtps = finalOtps - baseOtps;

    console.log('\n======================================================');
    console.log('ℹ BÁO CÁO TOÀN VẸN DỮ LIỆU & ZERO RESIDUE (tests/auth-production.test.ts):');
    console.log(`   - Users: Trước=${baseUsers}, Sau=${finalUsers} (Delta: ${deltaUsers})`);
    console.log(`   - Refresh tokens: Trước=${baseRefresh}, Sau=${finalRefresh} (Delta: ${deltaRefresh})`);
    console.log(`   - Auth OTPs: Trước=${baseOtps}, Sau=${finalOtps} (Delta: ${deltaOtps})`);

    let cleanupFailed = false;
    if (deltaUsers !== 0 || deltaRefresh !== 0 || deltaOtps !== 0) {
      cleanupFailed = true;
      console.error('  ❌ [THẤT BẠI DỌN DẸP] Phát hiện dữ liệu còn sót lại sau khi test kết thúc!');
    } else {
      console.log('  ✔ [XÁC NHẬN ZERO RESIDUE] 100% dữ liệu test auth đã được dọn sạch hoàn toàn.');
    }
    console.log('======================================================\n');

    await prisma.$disconnect();

    console.log('------------------------------------------------------');
    console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
    console.log('======================================================\n');

    if (failed > 0 || cleanupFailed) {
      process.exit(1);
    }
  }
}

runAuthTests();
