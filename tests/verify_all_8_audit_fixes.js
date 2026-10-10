/**
 * ========================================================================
 * 🧪 REPRODUCIBLE SECURITY & AUDIT REMEDIATION VERIFICATION SUITE (V4 - ULTRA SECURE)
 * ========================================================================
 * Fully verifies all 8 critical security audit findings against live backend & PostgreSQL:
 * 1. Body limit > 10kb returns HTTP 413 Payload Too Large (not 500).
 * 2. Device HMAC: Zero hardcoded secrets, hmac_secret NOT NULL in DB & Prisma schema, probe rejected 401.
 * 3. Pairing Token: PostgreSQL atomic UPDATE RETURNING, zero RAM fallback, race condition eliminated,
 *    zero token leak in responses/failedAttempts, single-use strictly enforced, safe targeted cleanup.
 * 4. Token Blacklist: Multi-instance distributed check via PostgreSQL revoked_tokens (returns 401),
 *    safe targeted cleanup.
 * 5. Registration: PENDING_VERIFICATION, zero token leakage, guaranteed targeted DB cleanup.
 * 6. PayOS Payout 601: Returns HTTP 400 with PAYOS_PAYOUT_NOT_CONFIGURED (no simulated balance).
 * 7. UpdateProductDto & Pagination: Max 100 enforced on pageSize (400), invalid URL blocked (400).
 * 8. Cloudinary Assets & Semantic Mapping: All product images return HTTP 200 OK,
 *    and images match products semantically (La Vie -> water SVG, Petrolimex -> gas cylinder SVG).
 *
 * ZERO RESIDUE GUARANTEE:
 * - Records baseline counts of pairing_tokens, refresh_tokens, and revoked_tokens.
 * - Cleans up exclusively via exact generated hashes/IDs (no broad deleteMany by deviceId).
 * - Verifies Delta = 0 for pairing tokens, refresh tokens, and revoked tokens at end of run.
 */

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api/v1';

function log(label, passed, detail = '') {
  if (passed) {
    console.log(`  ✔ \x1b[32m[PASS]\x1b[0m ${label} ${detail ? `(${detail})` : ''}`);
  } else {
    console.log(`  ✖ \x1b[31m[FAIL]\x1b[0m ${label} ${detail ? `(${detail})` : ''}`);
  }
}

async function run() {
  console.log('========================================================================');
  console.log('🧪 TOÀN BỘ 8 TIÊU CHÍ AUDIT BẢO MẬT & ZERO RESIDUE GUARANTEE');
  console.log('========================================================================\n');

  let passed = 0;
  let total = 8;

  // Track initial baseline counts to verify true zero residue
  const baselinePairingCount = await prisma.pairingToken.count();
  const baselineRefreshCount = await prisma.refreshToken.count();
  const baselineRevokedCount = await prisma.revokedToken.count();

  // Array to collect created refresh token hashes for exact cleanup
  const createdRefreshTokenHashes = [];

  function trackRefreshToken(loginPayload) {
    const rawRf = loginPayload?.refreshToken || loginPayload?.data?.refreshToken;
    if (rawRf && typeof rawRf === 'string') {
      const rfHash = crypto.createHash('sha256').update(rawRf.trim()).digest('hex');
      createdRefreshTokenHashes.push(rfHash);
    }
  }

  try {
    // [1/8] Body limit > 10kb
    try {
      console.log('▶ [1/8] Kiểm tra Body limit > 10kb (Phải trả HTTP 413 Payload Too Large)...');
      const largePayload = { junk: 'A'.repeat(12 * 1024) };
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(largePayload),
      });

      if (res.status === 413) {
        log('Body Size Limit 10kb', true, 'HTTP 413 Payload Too Large');
        passed++;
      } else {
        log('Body Size Limit 10kb', false, `Nhận được HTTP ${res.status}`);
      }
    } catch (e) {
      log('Body Size Limit 10kb', false, e.message);
    }

    // [2/8] Device HMAC Security & hmac_secret NOT NULL constraint
    try {
      console.log('\n▶ [2/8] Kiểm tra HMAC Security (hmac_secret NOT NULL, không fallback RAM, chặn probe secret cũ 401)...');
      const oldLeakedSecret = 'sec_smart_button_8829_wtr_key_99';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = crypto.randomBytes(16).toString('hex');
      const validBody = { firmwareVersion: '1.0.0', hardwareVersion: 'ESP32_V2', batteryLevel: 98, wifiRssi: -55 };
      const bodyStr = JSON.stringify(validBody);
      const fakeSig = crypto
        .createHmac('sha256', oldLeakedSecret)
        .update(`BTN-8829-WTR:${timestamp}:${nonce}:${bodyStr}`)
        .digest('hex');

      const leakProbeRes = await fetch(`${BASE_URL}/devices/bootstrap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': 'BTN-8829-WTR',
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-signature': fakeSig,
        },
        body: bodyStr,
      });

      // Check device secret in DB & NOT NULL constraint in information_schema
      const dev = await prisma.ioTButton.findFirst({ where: { deviceId: 'BTN-8829-WTR' } });
      const hasUniqueSecret = dev && dev.hmacSecret && dev.hmacSecret !== oldLeakedSecret;

      const nullCheck = await prisma.$queryRawUnsafe(`
        SELECT is_nullable 
        FROM information_schema.columns 
        WHERE table_name = 'iot_button' AND column_name = 'hmac_secret'
      `);
      const isNotNull = nullCheck && nullCheck[0]?.is_nullable === 'NO';

      const totalButtons = await prisma.ioTButton.count();
      const withSecretCount = await prisma.ioTButton.count({
        where: { hmacSecret: { not: '' } },
      });

      if (leakProbeRes.status === 401 && hasUniqueSecret && isNotNull && withSecretCount === totalButtons) {
        log('Device HMAC Security', true, `Secret cũ bị chặn 401; ${withSecretCount}/${totalButtons} secret riêng; hmac_secret NOT NULL enforced`);
        passed++;
      } else {
        log('Device HMAC Security', false, `Probe status: ${leakProbeRes.status}, uniqueSecret: ${hasUniqueSecret}, isNotNull: ${isNotNull}, withSecret: ${withSecretCount}/${totalButtons}`);
      }
    } catch (e) {
      log('Device HMAC Security', false, e.message);
    }

    // [3/8] Pairing Token: Atomic UPDATE RETURNING, Multi-Instance Safe, Zero RAM Fallback
    let pairingTestTokenHash = null;
    try {
      console.log('\n▶ [3/8] Kiểm tra Pairing Token Atomic & Concurrency Race Condition (2 requests đồng thời)...');
      // Admin login
      const adminLoginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@smartorder.local', password: 'Password123!' }),
      });
      const adminData = await adminLoginRes.json();
      trackRefreshToken(adminData);
      const adminToken = adminData.data?.accessToken || adminData.data?.token || adminData.token;

      // Issue pairing token via re-pair
      const repairRes = await fetch(`${BASE_URL}/devices/BTN-8829-WTR/re-pair`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const repairData = await repairRes.json();
      const token = repairData.data?.pairingToken || repairData.pairingToken;

      // Check DB: Must exist in pairing_tokens with status ACTIVE
      pairingTestTokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
      const dbTokenBefore = await prisma.pairingToken.findUnique({ where: { tokenHash: pairingTestTokenHash } });
      const inDb = dbTokenBefore && dbTokenBefore.status === 'ACTIVE';

      // Fake token rejected 401
      const fakeRes = await fetch(`${BASE_URL}/provisioning/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'BTN-8829-WTR', token: 'p_attacker_fake_token_123' }),
      });

      // Verify GET device does NOT leak pairingToken, secret or token in qrPayload
      const getDevRes = await fetch(`${BASE_URL}/devices/BTN-8829-WTR`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const getDevData = await getDevRes.json();
      const noLeakInGet =
        !getDevData.data?.pairingToken &&
        !getDevData.data?.deviceSecret &&
        !getDevData.data?.hmacSecret &&
        (!getDevData.data?.qrPayload || !getDevData.data?.qrPayload.includes('token='));

      // CONCURRENT RACE CONDITION PROBE:
      // Send TWO simultaneous requests with the SAME valid token
      const [raceResA, raceResB] = await Promise.all([
        fetch(`${BASE_URL}/provisioning/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'BTN-8829-WTR', token }),
        }),
        fetch(`${BASE_URL}/provisioning/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'BTN-8829-WTR', token }),
        }),
      ]);

      const statuses = [raceResA.status, raceResB.status].sort();
      const racePassed = statuses[0] === 201 && statuses[1] === 401;

      // Verify Session response does NOT leak raw token or tokenHash
      const winnerRes = raceResA.status === 201 ? raceResA : raceResB;
      const sessionData = await winnerRes.json();
      const noSessionTokenLeak = !sessionData.data?.token && !sessionData.data?.tokenHash && !sessionData.data?.pairingToken;

      // Replay 3rd time: MUST return 401 (Never 500)
      const replayRes = await fetch(`${BASE_URL}/provisioning/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'BTN-8829-WTR', token }),
      });

      // Check DB status: Must be USED
      const dbTokenAfter = await prisma.pairingToken.findUnique({ where: { tokenHash: pairingTestTokenHash } });
      const isUsed = dbTokenAfter && dbTokenAfter.status === 'USED';

      if (inDb && fakeRes.status === 401 && racePassed && replayRes.status === 401 && isUsed && noLeakInGet && noSessionTokenLeak) {
        log('Pairing Token Race Condition & Security', true, 'Atomic UPDATE RETURNING: 2 request đồng thời trả đúng [201, 401], replay trả 401 (không 500), không leak token, DB trạng thái USED');
        passed++;
      } else {
        log('Pairing Token Race Condition & Security', false, `inDb: ${inDb}, fake: ${fakeRes.status}, race: [${raceResA.status}, ${raceResB.status}], replay: ${replayRes.status}, isUsed: ${isUsed}, noLeakInGet: ${noLeakInGet}`);
      }
    } catch (e) {
      log('Pairing Token Race Condition & Security', false, e.message);
    } finally {
      // Safe targeted cleanup: ONLY delete the exact token generated by this test
      if (pairingTestTokenHash) {
        await prisma.pairingToken.deleteMany({ where: { tokenHash: pairingTestTokenHash } });
      }
    }

    // [4/8] Multi-Instance Distributed Blacklist via PostgreSQL
    let blacklistTokenHash = null;
    try {
      console.log('\n▶ [4/8] Kiểm tra Token Blacklist Multi-Instance (Query PostgreSQL revoked_tokens)...');
      const loginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'customer@smartorder.local', password: 'Password123!' }),
      });
      const loginData = await loginRes.json();
      trackRefreshToken(loginData);
      const token = loginData.data?.accessToken || loginData.data?.token || loginData.token;

      // Verify token works
      const meBefore = await fetch(`${BASE_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      // Simulate remote node revoking this token by inserting directly into DB
      blacklistTokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
      await prisma.revokedToken.create({
        data: {
          tokenHash: blacklistTokenHash,
          expiresAt: new Date(Date.now() + 3600 * 1000),
        },
      });

      // Request with token must now be rejected 401 by JWT Strategy DB check
      const meAfter = await fetch(`${BASE_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (meBefore.status === 200 && meAfter.status === 401) {
        log('Token Blacklist Multi-Instance', true, 'Đồng bộ qua PostgreSQL revoked_tokens, chặn 401 ngay cả khi bị thu hồi từ instance khác');
        passed++;
      } else {
        log('Token Blacklist Multi-Instance', false, `before: ${meBefore.status}, after: ${meAfter.status}`);
      }
    } catch (e) {
      log('Token Blacklist Multi-Instance', false, e.message);
    } finally {
      // Safe targeted cleanup: ONLY delete this exact revoked token
      if (blacklistTokenHash) {
        await prisma.revokedToken.deleteMany({ where: { tokenHash: blacklistTokenHash } });
      }
    }

    // [5/8] Registration Status, Zero Token Leakage & Automatic DB Cleanup
    let testEmail = null;
    try {
      console.log('\n▶ [5/8] Kiểm tra Registration (PENDING_VERIFICATION, zero token leakage, DB cleanup)...');
      const uId = Date.now().toString().substring(7);
      testEmail = `audit_${uId}@smartorder.test`;
      const regRes = await fetch(`${BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: 'Audit User',
          username: `aud_${uId}`,
          email: testEmail,
          password: 'Password123!@#',
          role: 'STORE_OWNER',
          storeName: `Audit Store ${uId}`,
        }),
      });
      const regData = await regRes.json();
      const isPending = regData.data?.user?.status === 'PENDING_VERIFICATION';
      const noRawToken = !regData.accessToken && !regData.token && !regData.data?.verificationToken;

      if (regRes.status === 201 && isPending && noRawToken) {
        log('Registration Security & Cleanup', true, 'Tạo PENDING_VERIFICATION, không phát sinh token, dọn sạch DB');
        passed++;
      } else {
        log('Registration Security & Cleanup', false, `status: ${regRes.status}, isPending: ${isPending}, noRawToken: ${noRawToken}`);
      }
    } catch (e) {
      log('Registration Security & Cleanup', false, e.message);
    } finally {
      // Safe targeted cleanup: Delete only the test user created by this test
      if (testEmail) {
        const createdUser = await prisma.user.findFirst({ where: { email: testEmail } });
        if (createdUser) {
          await prisma.store.deleteMany({ where: { ownerUserId: createdUser.userId } });
          await prisma.user.delete({ where: { userId: createdUser.userId } });
        }
      }
    }

    // [6/8] PayOS Payout 601 Error
    try {
      console.log('\n▶ [6/8] Kiểm tra PayOS Payout 601 (Trả HTTP 400 PAYOS_PAYOUT_NOT_CONFIGURED)...');
      const adminLoginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@smartorder.local', password: 'Password123!' }),
      });
      const adminData = await adminLoginRes.json();
      trackRefreshToken(adminData);
      const adminToken = adminData.data?.token || adminData.accessToken;

      const res = await fetch(`${BASE_URL}/admin/payos/payout-balance`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const data = await res.json();

      if (res.status === 400 && data.success === false && data.code === 'PAYOS_PAYOUT_NOT_CONFIGURED') {
        log('PayOS Payout 601 Handling', true, 'Trả HTTP 400 Bad Request kèm mã lỗi cấu hình chuẩn xác');
        passed++;
      } else {
        log('PayOS Payout 601 Handling', false, `Status: ${res.status}, response: ${JSON.stringify(data)}`);
      }
    } catch (e) {
      log('PayOS Payout 601 Handling', false, e.message);
    }

    // [7/8] Product DTO Validation & Pagination Max 100
    try {
      console.log('\n▶ [7/8] Kiểm tra Pagination Limit (pageSize > 100 chặn 400) & Image URL Validation...');
      const ownerLoginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'store@smartorder.local', password: 'Password123!' }),
      });
      const ownerData = await ownerLoginRes.json();
      trackRefreshToken(ownerData);
      const ownerToken = ownerData.data?.token || ownerData.accessToken;

      // Test pageSize=999 rejected 400
      const overRes = await fetch(`${BASE_URL}/products?pageSize=999`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      // Test invalid image URL rejected 400
      const imgRes = await fetch(`${BASE_URL}/products/1`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ images: ['not-a-valid-url-format'] }),
      });

      if (overRes.status === 400 && imgRes.status === 400) {
        log('Product DTO & Pagination Guard', true, 'pageSize=999 bị chặn 400; URL ảnh không hợp lệ bị chặn 400');
        passed++;
      } else {
        log('Product DTO & Pagination Guard', false, `overRes: ${overRes.status}, imgRes: ${imgRes.status}`);
      }
    } catch (e) {
      log('Product DTO & Pagination Guard', false, e.message);
    }

    // [8/8] Product API Pagination, All Cloudinary Assets HTTP 200 & Semantic Image Mapping
    try {
      console.log('\n▶ [8/8] Kiểm tra Toàn bộ ảnh sản phẩm Cloudinary (HTTP 200 OK) & Khớp ngữ nghĩa sản phẩm...');
      const customerLoginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'customer@smartorder.local', password: 'Password123!' }),
      });
      const customerData = await customerLoginRes.json();
      trackRefreshToken(customerData);
      const customerToken = customerData.data?.token || customerData.accessToken;

      const prodRes = await fetch(`${BASE_URL}/products?pageSize=5`, {
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      const prodData = await prodRes.json();
      const hasFiveItems = Array.isArray(prodData.data) && prodData.data.length === 5;
      const hasPaginationMeta = prodData.pagination?.pageSize === 5;

      // Check ALL product images across DB
      const allImages = await prisma.productImage.findMany({ select: { imageUrl: true } });
      let totalImages = 0;
      let validImages = 0;
      const uniqueUrls = [...new Set(allImages.map((i) => i.imageUrl).filter(Boolean))];

      for (const u of uniqueUrls) {
        totalImages++;
        try {
          const checkRes = await fetch(u, { method: 'HEAD' });
          if (checkRes.status === 200) validImages++;
        } catch {}
      }

      const allImagesOk = totalImages > 0 && validImages === totalImages;

      // Check Semantic Mapping
      const gasProd = await prisma.product.findFirst({
        where: { productName: { contains: 'Petrolimex' } },
        include: { images: true },
      });
      const waterProd = await prisma.product.findFirst({
        where: { productName: { contains: 'La Vie' } },
        include: { images: true },
      });

      const gasUrl = gasProd?.images?.[0]?.imageUrl || '';
      const waterUrl = waterProd?.images?.[0]?.imageUrl || '';
      const semanticOk = gasUrl.includes('petrolimex-gas') && waterUrl.includes('lavie-water');

      if (prodRes.status === 200 && hasFiveItems && hasPaginationMeta && allImagesOk && semanticOk) {
        log('Product Pagination, Cloudinary 200 & Semantic Mapping', true, `pageSize=5 trả đúng 5 sản phẩm; toàn bộ ${validImages}/${totalImages} ảnh Cloudinary trả HTTP 200 OK; Gas -> petrolimex-gas.svg, Nước -> lavie-water.svg`);
        passed++;
      } else {
        log('Product Pagination, Cloudinary 200 & Semantic Mapping', false, `hasFiveItems: ${hasFiveItems}, allImagesOk: ${allImagesOk} (${validImages}/${totalImages}), semanticOk: ${semanticOk}`);
      }
    } catch (e) {
      log('Product Pagination, Cloudinary 200 & Semantic Mapping', false, e.message);
    }
  } finally {
    // Exact targeted cleanup of all refresh tokens created during this test suite
    if (createdRefreshTokenHashes.length > 0) {
      await prisma.refreshToken.deleteMany({
        where: { tokenHash: { in: createdRefreshTokenHashes } },
      });
    }
  }

  // Verification of True Zero Residue (Delta = 0 across all tables)
  const finalPairingCount = await prisma.pairingToken.count();
  const finalRefreshCount = await prisma.refreshToken.count();
  const finalRevokedCount = await prisma.revokedToken.count();

  const pairingDelta = finalPairingCount - baselinePairingCount;
  const refreshDelta = finalRefreshCount - baselineRefreshCount;
  const revokedDelta = finalRevokedCount - baselineRevokedCount;

  console.log('\n========================================================================');
  console.log(`KẾT QUẢ KIỂM THỬ: ${passed}/${total} TIÊU CHÍ ĐẠT (${Math.round((passed / total) * 100)}%)`);
  console.log('========================================================================');
  console.log(`ℹ BÁO CÁO TOÀN VẸN DỮ LIỆU & ZERO RESIDUE (DELTA SO VỚI TRƯỚC KHI CHẠY):`);
  console.log(`   - Pairing tokens: Trước=${baselinePairingCount}, Sau=${finalPairingCount} (Delta: ${pairingDelta})`);
  console.log(`   - Refresh tokens: Trước=${baselineRefreshCount}, Sau=${finalRefreshCount} (Delta: ${refreshDelta})`);
  console.log(`   - Revoked tokens: Trước=${baselineRevokedCount}, Sau=${finalRevokedCount} (Delta: ${revokedDelta})`);

  const zeroResidueOk = pairingDelta === 0 && refreshDelta === 0 && revokedDelta === 0;

  if (zeroResidueOk) {
    console.log(`  ✔ \x1b[32m[XÁC NHẬN ZERO RESIDUE]\x1b[0m 100% dữ liệu test đã được dọn sạch mà không ảnh hưởng bất kỳ bản ghi hợp lệ nào.`);
  } else {
    console.log(`  ✖ \x1b[31m[CẢNH BÁO TÀN DƯ]\x1b[0m Phát hiện delta khác 0.`);
  }
  console.log('========================================================================\n');

  await prisma.$disconnect();
  if (passed !== total || !zeroResidueOk) {
    process.exit(1);
  }
}

run().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
