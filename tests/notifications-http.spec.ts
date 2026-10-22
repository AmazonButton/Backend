import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaClient } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function runNotificationsHttpTestSuite() {
  console.log('================================================================================');
  console.log('⚡ NOTIFICATIONS HTTP INTEGRATION TEST SUITE (ROUTE -> JWT -> DTO -> DB)');
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

  let app: any = null;
  let baseUrl = '';
  let userA: any = null;
  let userB: any = null;
  const createdTokens: string[] = [];
  const ts = Date.now();

  try {
    // -------------------------------------------------------------------------
    // 1. BOOTSTRAP REAL NESTJS HTTP SERVER ON EPHEMERAL PORT
    // -------------------------------------------------------------------------
    app = await NestFactory.create(AppModule, { logger: ['error'] });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );
    await app.listen(0);

    const address = app.getHttpServer().address();
    const port = typeof address === 'string' ? address : address?.port;
    baseUrl = `http://localhost:${port}/api/v1`;
    console.log(`[INFO] NestJS Server listening at: ${baseUrl}\n`);

    // -------------------------------------------------------------------------
    // 2. CREATE FIXTURE USERS & SIGN REAL JWT TOKENS
    // -------------------------------------------------------------------------
    const hash = await bcrypt.hash('Secret123!', 10);
    userA = await prisma.user.create({
      data: {
        username: `http_user_a_${ts}`,
        email: `http_user_a_${ts}@example.com`,
        fullName: 'Nguyen Van User A',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });

    userB = await prisma.user.create({
      data: {
        username: `http_user_b_${ts}`,
        email: `http_user_b_${ts}@example.com`,
        fullName: 'Tran Thi User B',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });

    const jwtSecret = process.env.JWT_SECRET || 'sob_jwt_secret_dev_2026';
    const jwtA = jwt.sign(
      { userId: userA.userId.toString(), email: userA.email, username: userA.username, role: 'CUSTOMER' },
      jwtSecret,
      { expiresIn: '1h' },
    );
    const jwtB = jwt.sign(
      { userId: userB.userId.toString(), email: userB.email, username: userB.username, role: 'CUSTOMER' },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // -------------------------------------------------------------------------
    // TEST 1: THIẾU JWT → 401 UNAUTHORIZED
    // -------------------------------------------------------------------------
    console.log('[SECTION 1] KIỂM THỬ XÁC THỰC BẢO VỆ ROUTE (JWT AUTH GUARD)');
    const resNoAuth = await fetch(`${baseUrl}/notifications/fcm-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test_token_no_auth' }),
    });
    assert(resNoAuth.status === 401, 'POST /api/v1/notifications/fcm-token thiếu JWT trả 401 Unauthorized');

    const resDeleteNoAuth = await fetch(`${baseUrl}/notifications/fcm-token`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test_token_no_auth' }),
    });
    assert(resDeleteNoAuth.status === 401, 'DELETE /api/v1/notifications/fcm-token thiếu JWT trả 401 Unauthorized');

    // -------------------------------------------------------------------------
    // TEST 2: DEVICETYPE SAI → 400 BAD REQUEST
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 2] KIỂM THỬ DTO VALIDATION QUA HTTP (VALIDATION PIPE)');
    const resBadDevice = await fetch(`${baseUrl}/notifications/fcm-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtA}`,
      },
      body: JSON.stringify({
        token: 'test_token_bad_device',
        deviceType: 'RANDOM_VALUE',
      }),
    });
    const badDeviceBody = await resBadDevice.json();
    assert(
      resBadDevice.status === 400,
      'Gửi deviceType="RANDOM_VALUE" trả 400 Bad Request từ ValidationPipe',
    );
    assert(
      JSON.stringify(badDeviceBody).includes('deviceType'),
      'Nội dung lỗi 400 chỉ rõ vi phạm thuộc tính deviceType',
    );

    // -------------------------------------------------------------------------
    // TEST 3: ĐĂNG KÝ TOKEN HỢP LỆ (CHUẨN HÓA DTO & LƯU DB)
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 3] ĐĂNG KÝ TOKEN HỢP LỆ & LƯU TRỮ DATABASE');
    const tokenA = `http_token_a_${ts}`;
    const tokenB = `http_token_b_${ts}`;
    createdTokens.push(tokenA, tokenB);

    const resRegisterA = await fetch(`${baseUrl}/notifications/fcm-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtA}`,
      },
      body: JSON.stringify({
        token: tokenA,
        deviceType: 'android', // test lowercase normalization
      }),
    });
    const registerABody = await resRegisterA.json();
    assert(
      resRegisterA.status === 200 || resRegisterA.status === 201,
      'User A đăng ký token thành công (HTTP 200/201 OK)',
    );
    assert(registerABody.success === true, 'Response body trả về success=true');

    const dbTokenA = await prisma.userFcmToken.findUnique({ where: { token: tokenA } });
    assert(
      !!dbTokenA && dbTokenA.userId.toString() === userA.userId.toString() && dbTokenA.deviceType === 'ANDROID' && dbTokenA.isActive === true,
      'Database lưu đúng userId A, is_active=true và deviceType được chuẩn hóa chữ hoa "ANDROID"',
    );

    // User B đăng ký token B
    const resRegisterB = await fetch(`${baseUrl}/notifications/fcm-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtB}`,
      },
      body: JSON.stringify({
        token: tokenB,
        deviceType: 'IOS',
      }),
    });
    assert(resRegisterB.status === 200 || resRegisterB.status === 201, 'User B đăng ký token B thành công');

    // -------------------------------------------------------------------------
    // TEST 4: CHỐNG IDOR QUA HTTP (USER A HỦY TOKEN CỦA USER B)
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 4] KIỂM THỬ CHỐNG TẤN CÔNG IDOR QUA GIAO THỨC HTTP');
    const resIdor = await fetch(`${baseUrl}/notifications/fcm-token`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtA}`,
      },
      body: JSON.stringify({
        token: tokenB, // User A tấn công gửi token của User B
      }),
    });
    const idorBody = await resIdor.json();
    assert(resIdor.status === 200, 'Endpoint DELETE phản hồi HTTP 200 an toàn');
    assert(idorBody.deactivatedCount === 0, 'Chặn IDOR: deactivatedCount = 0 (User A không thể hủy token của User B)');

    const dbTokenBAfterIdor = await prisma.userFcmToken.findUnique({ where: { token: tokenB } });
    assert(dbTokenBAfterIdor?.isActive === true, 'Token của User B vẫn bảo toàn an toàn với is_active=true');

    // -------------------------------------------------------------------------
    // TEST 5: USER B TỰ HỦY TOKEN CỦA MÌNH THÀNH CÔNG
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 5] USER TỰ HỦY TOKEN CHÍNH CHỦ');
    const resLegitDelete = await fetch(`${baseUrl}/notifications/fcm-token`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtB}`,
      },
      body: JSON.stringify({
        token: tokenB,
      }),
    });
    const legitDeleteBody = await resLegitDelete.json();
    assert(resLegitDelete.status === 200, 'User B gọi DELETE token của mình trả HTTP 200');
    assert(legitDeleteBody.deactivatedCount === 1, 'deactivatedCount = 1 xác nhận token đã được vô hiệu hóa');

    const dbTokenBAfterLegit = await prisma.userFcmToken.findUnique({ where: { token: tokenB } });
    assert(dbTokenBAfterLegit?.isActive === false, 'Database cập nhật is_active=false chính xác');

    console.log('--------------------------------------------------------------------------------');
    console.log(`⚡ NOTIFICATIONS HTTP SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`);
    console.log('--------------------------------------------------------------------------------\n');
  } catch (err: any) {
    console.error('Fatal error during Notifications HTTP test suite:', err);
    failed++;
  } finally {
    // Clean up test fixtures strictly by ID
    try {
      if (createdTokens.length > 0) {
        await prisma.userFcmToken.deleteMany({ where: { token: { in: createdTokens } } });
      }
      if (userA?.userId) {
        await prisma.userFcmToken.deleteMany({ where: { userId: userA.userId } });
        await prisma.user.delete({ where: { userId: userA.userId } });
      }
      if (userB?.userId) {
        await prisma.userFcmToken.deleteMany({ where: { userId: userB.userId } });
        await prisma.user.delete({ where: { userId: userB.userId } });
      }
    } catch (cleanupErr: any) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }

    if (app) {
      await app.close();
    }
    await prisma.$disconnect();
  }

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runNotificationsHttpTestSuite();
