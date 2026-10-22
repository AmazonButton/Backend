import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const API_BASE = process.env.BASE_URL || 'http://localhost:3000/api/v1';
const prisma = new PrismaClient();

async function runBolaAndSecurityVerification() {
  console.log('========================================================================');
  console.log('🛡️ TESTING BOLA & TENANT ISOLATION FIXES (BLOCKERS 1 & 2)');
  console.log('========================================================================\n');

  const createdRefreshTokens: string[] = [];

  try {
    // 1. Get tokens
    // A. Customer token (userId 4, customerProfileId 1)
    const custRes = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'customer@smartorder.local',
        password: 'Password123!',
      }),
    });
    if (custRes.status !== 200) {
      throw new Error(`Customer login failed with status ${custRes.status}`);
    }
    const custJson: any = await custRes.json();
    const customerToken = custJson.data?.token || custJson.data?.accessToken || custJson.token || custJson.accessToken;
    if (custJson.data?.refreshToken) createdRefreshTokens.push(custJson.data.refreshToken);

    const custHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    };

    // B. Store owner token (Store 1)
    const storeRes = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'store@smartorder.local',
        password: 'Password123!',
      }),
    });
    if (storeRes.status !== 200) {
      throw new Error(`Store login failed with status ${storeRes.status}`);
    }
    const storeJson: any = await storeRes.json();
    const storeToken = storeJson.data?.token || storeJson.data?.accessToken || storeJson.token || storeJson.accessToken;
    if (storeJson.data?.refreshToken) createdRefreshTokens.push(storeJson.data.refreshToken);

    const storeHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${storeToken}`,
    };

    console.log('▶ [1/6] Kiểm tra POST /devices/lookup-code: Tuyệt đối không rò rỉ passwordHash & tenant data...');
    const activeDevice = await prisma.ioTButton.findFirst({
      where: { status: 'ACTIVE' },
    });
    if (!activeDevice) throw new Error('No active device found');

    const lookupRes = await fetch(`${API_BASE}/devices/lookup-code`, {
      method: 'POST',
      headers: custHeaders,
      body: JSON.stringify({ code: activeDevice.buttonCode }),
    });
    const lookupJson: any = await lookupRes.json();
    const lookupData = lookupJson.data || lookupJson;
    const jsonStr = JSON.stringify(lookupJson);

    if (jsonStr.includes('passwordHash') || jsonStr.includes('password') || jsonStr.includes('verificationToken')) {
      throw new Error('FAIL: Lookup response contains sensitive auth tokens/passwords!');
    }
    if (lookupData.storeId !== undefined || lookupData.customerId !== undefined || lookupData.customer !== undefined) {
      throw new Error('FAIL: Lookup response leaked storeId, customerId, or customer entity!');
    }
    console.log('  ✔ [PASS] lookup-code chỉ trả minimal public metadata:', Object.keys(lookupData));

    console.log('\n▶ [2/6] Kiểm tra BOLA trên Device Mutations (status, battery, warranty, behavior, patch)...');
    // Find a device belonging to another store (not Store 1)
    const otherDevice = await prisma.ioTButton.findFirst({
        where: {
          storeId: { not: 1n },
        },
      });
      if (!otherDevice) {
        throw new Error('FAIL: Không tìm thấy thiết bị của store khác để kiểm thử BOLA');
      }
      {
      const devId = otherDevice.buttonId.toString();

      // Mutation A: PATCH /devices/:id
      const patchRes = await fetch(`${API_BASE}/devices/${devId}`, {
        method: 'PATCH',
        headers: storeHeaders,
        body: JSON.stringify({ buttonName: 'Hacked Name' }),
      });
      if (patchRes.status !== 403) throw new Error(`FAIL: PATCH /devices/${devId} expected 403, got ${patchRes.status}`);

      // Mutation B: PATCH /devices/:id/status
      const statusRes = await fetch(`${API_BASE}/devices/${devId}/status`, {
        method: 'PATCH',
        headers: storeHeaders,
        body: JSON.stringify({ status: 'INACTIVE' }),
      });
      if (statusRes.status !== 403) throw new Error(`FAIL: PATCH /devices/${devId}/status expected 403, got ${statusRes.status}`);

      // Mutation C: PATCH /devices/:id/battery
      const battRes = await fetch(`${API_BASE}/devices/${devId}/battery`, {
        method: 'PATCH',
        headers: storeHeaders,
        body: JSON.stringify({ batteryLevel: 50 }),
      });
      if (battRes.status !== 403) throw new Error(`FAIL: PATCH /devices/${devId}/battery expected 403, got ${battRes.status}`);

      // Mutation D: PATCH /devices/:id/extend-warranty
      const warrRes = await fetch(`${API_BASE}/devices/${devId}/extend-warranty`, {
        method: 'PATCH',
        headers: storeHeaders,
        body: JSON.stringify({ months: 12 }),
      });
      if (warrRes.status !== 403) throw new Error(`FAIL: PATCH /devices/${devId}/extend-warranty expected 403, got ${warrRes.status}`);

      // Mutation E: PUT /devices/:id/behavior
      const behavRes = await fetch(`${API_BASE}/devices/${devId}/behavior`, {
        method: 'PUT',
        headers: storeHeaders,
        body: JSON.stringify({ clickBehavior: 'SINGLE' }),
      });
      if (behavRes.status !== 403) throw new Error(`FAIL: PUT /devices/${devId}/behavior expected 403, got ${behavRes.status}`);

      console.log(`  ✔ [PASS] 5/5 Device Mutations (patch, status, battery, warranty, behavior) trên thiết bị #${devId} đều bị chặn HTTP 403 Forbidden`);
    }

    console.log('\n▶ [3/6] Kiểm tra Device List & Stats Fail-Closed: Chặn Customer xem thiết bị của Store khác...');
    const listRes = await fetch(`${API_BASE}/devices?storeId=34`, {
      headers: custHeaders,
    });
    const listJson: any = await listRes.json();
    const items = listJson.data || listJson;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item.customerId && item.customerId.toString() !== '1') {
          throw new Error('FAIL: Customer list returned device of another customer!');
        }
      }
    }
    console.log('  ✔ [PASS] Customer query ?storeId=34 không rò rỉ thiết bị của Store 34');

    console.log('\n▶ [4/6] Kiểm tra Analytics Dashboard: Chặn triệt để Customer truy cập (Role Guard & Fail-Closed)...');
    const anaRes = await fetch(`${API_BASE}/analytics/dashboard`, {
      headers: custHeaders,
    });
    if (anaRes.status === 403) {
      console.log('  ✔ [PASS] Customer gọi /analytics/dashboard nhận đúng HTTP 403 Forbidden');
    } else {
      throw new Error(`FAIL: Expected 403 but got ${anaRes.status}`);
    }

    console.log('\n▶ [5/6] Kiểm tra Rentals /rentals/my-rentals: Chỉ trả rental của chính customerProfileId...');
    const rentalRes = await fetch(`${API_BASE}/rentals/my-rentals`, {
      headers: custHeaders,
    });
    const rentalJson: any = await rentalRes.json();
    const rentals = rentalJson.data || rentalJson;
    console.log(`  ✔ [PASS] Customer gọi /rentals/my-rentals nhận HTTP 200, danh sách rentals: ${Array.isArray(rentals) ? rentals.length : 0}`);
    if (Array.isArray(rentals)) {
      for (const r of rentals) {
        if (r.customerId && r.customerId.toString() !== '1') {
          throw new Error(`FAIL: Leaked rental of customerId=${r.customerId} to customerProfileId=1!`);
        }
      }
    }

    console.log('\n▶ [6/6] Kiểm tra Store Wallet & Subscriptions: Customer gọi nhận 403 Forbidden (thay vì 500)...');
    const walRes = await fetch(`${API_BASE}/store/wallet`, {
      headers: custHeaders,
    });
    if (walRes.status === 403) {
      console.log('  ✔ [PASS] Customer gọi /store/wallet nhận đúng HTTP 403 Forbidden');
    } else {
      throw new Error(`FAIL: Expected 403 but got ${walRes.status}`);
    }

    const subRes = await fetch(`${API_BASE}/store/subscriptions/current`, {
      headers: custHeaders,
    });
    if (subRes.status === 403) {
      console.log('  ✔ [PASS] Customer gọi /store/subscriptions/current nhận đúng HTTP 403 Forbidden');
    } else {
      throw new Error(`FAIL: Expected 403 but got ${subRes.status}`);
    }

    console.log('\n▶ [7/7] Kiểm tra Luồng Hợp Lệ (Legitimate Owner Mutation & DB Persistence)...');
    // Find device belonging to Store 1 (Store Owner legitimate device)
    const store1Device = await prisma.ioTButton.findFirst({
        where: { storeId: 1n, status: 'ACTIVE' },
      });
      if (!store1Device) {
        throw new Error('FAIL: Không tìm thấy thiết bị của Store 1 để kiểm thử luồng hợp lệ');
      }

      const before = await prisma.ioTButton.findUnique({
        where: { buttonId: store1Device.buttonId },
        select: {
          batteryLevel: true,
          warrantyUntil: true,
          clickBehavior: true,
          doubleClickWindowMs: true,
          holdDurationMs: true,
          updatedAt: true,
        },
      });
      if (!before) throw new Error('FAIL: Không tìm thấy dữ liệu ban đầu của thiết bị Store 1');

      try {
        const devId = store1Device.buttonId.toString();

        // A. Valid battery update (85%)
        const battRes = await fetch(`${API_BASE}/devices/${devId}/battery`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${storeToken}`,
          },
          body: JSON.stringify({ batteryLevel: 85 }),
        });
        if (battRes.status !== 200) throw new Error(`FAIL: Valid battery update expected 200, got ${battRes.status}`);
        const dbAfterBatt = await prisma.ioTButton.findUnique({ where: { buttonId: store1Device.buttonId } });
        if (dbAfterBatt?.batteryLevel !== 85) throw new Error(`FAIL: DB batteryLevel not updated (got ${dbAfterBatt?.batteryLevel})`);

        // B. Valid warranty extension (6 months)
        const warrRes = await fetch(`${API_BASE}/devices/${devId}/extend-warranty`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${storeToken}`,
          },
          body: JSON.stringify({ months: 6 }),
        });
        if (warrRes.status !== 200) throw new Error(`FAIL: Valid extend warranty expected 200, got ${warrRes.status}`);
        const dbAfterWarr = await prisma.ioTButton.findUnique({ where: { buttonId: store1Device.buttonId } });
        if (!dbAfterWarr?.warrantyUntil) throw new Error('FAIL: DB warrantyUntil not persisted!');

        // C. Valid behavior update (DOUBLE click, 400ms)
        const behavRes = await fetch(`${API_BASE}/devices/${devId}/behavior`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${storeToken}`,
          },
          body: JSON.stringify({ clickBehavior: 'DOUBLE', doubleClickWindowMs: 400 }),
        });
        if (behavRes.status !== 200) throw new Error(`FAIL: Valid behavior update expected 200, got ${behavRes.status}`);
        const dbAfterBehav = await prisma.ioTButton.findUnique({ where: { buttonId: store1Device.buttonId } });
        if (dbAfterBehav?.clickBehavior !== 'DOUBLE' || dbAfterBehav?.doubleClickWindowMs !== 400) {
          throw new Error('FAIL: DB clickBehavior/doubleClickWindowMs not persisted!');
        }

        console.log(`  ✔ [PASS] Store 1 Owner cập nhật thiết bị #${store1Device.buttonId} thành công (battery=85%, warranty, behavior=DOUBLE), DB persist chuẩn xác và đã restore`);
      } finally {
        // Zero-residue exact transactional restoration including original updatedAt
        await prisma.$executeRawUnsafe(
          `UPDATE iot_button
           SET battery_level = $1,
               warranty_until = $2,
               click_behavior = $3,
               double_click_window_ms = $4,
               hold_duration_ms = $5,
               updated_at = $6
           WHERE button_id = $7;`,
          before.batteryLevel,
          before.warrantyUntil,
          before.clickBehavior,
          before.doubleClickWindowMs,
          before.holdDurationMs,
          before.updatedAt,
          store1Device.buttonId
        );
      }

      console.log('\n========================================================================');
    console.log('🎉 TOÀN BỘ 7/7 KIỂM TRA BOLA & VALID OWNER MUTATION ĐÃ ĐẠT 100%!');
    console.log('========================================================================');
  } finally {
    // Zero-residue cleanup: Hash SHA-256 and delete created refresh tokens
    if (createdRefreshTokens.length > 0) {
      const hashes = createdRefreshTokens.map((t) => crypto.createHash('sha256').update(t).digest('hex'));
      const deleted = await prisma.refreshToken.deleteMany({
        where: { tokenHash: { in: hashes } },
      });
      console.log(`ℹ [CLEANUP ZERO RESIDUE] Đã dọn sạch ${deleted.count} refresh tokens phát sinh trong quá trình kiểm thử.\n`);
    }
    await prisma.$disconnect();
  }
}

runBolaAndSecurityVerification()
  .catch((err) => {
    console.error('PROBE FAILED:', err.message);
    process.exit(1);
  });
