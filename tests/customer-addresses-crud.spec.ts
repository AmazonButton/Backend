import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api/v1';

function logTest(name: string, passed: boolean, detail?: string) {
  if (passed) {
    console.log(`\x1b[32m  ✔ [PASS]\x1b[0m ${name}`);
  } else {
    console.log(`\x1b[31m  ✖ [FAIL]\x1b[0m ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function runCustomerAddressesCrudSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: CUSTOMER ADDRESSES CRUD & CONSTRAINTS TEST');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let userA: any = null;
  let profileA: any = null;
  let tokenA = '';

  let userB: any = null;
  let profileB: any = null;
  let tokenB = '';

  let store: any = null;
  let iotButton: any = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'test_super_secret_jwt_key_32_bytes_len_safe!';

    // Setup User A & Customer Profile A
    userA = await prisma.user.create({
      data: {
        username: `cust_addr_a_${Date.now()}`,
        email: `cust_addr_a_${Date.now()}@test.com`,
        phone: `0961${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Customer Address Test User A',
        status: 'ACTIVE',
      },
    });

    profileA = await prisma.customerProfile.create({
      data: {
        userId: userA.userId,
        phone: userA.phone,
      },
    });

    tokenA = jwt.sign(
      {
        userId: userA.userId.toString(),
        sub: userA.userId.toString(),
        email: userA.email,
        role: 'CUSTOMER',
        customerProfileId: profileA.customerId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // Setup User B & Customer Profile B
    userB = await prisma.user.create({
      data: {
        username: `cust_addr_b_${Date.now()}`,
        email: `cust_addr_b_${Date.now()}@test.com`,
        phone: `0962${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Customer Address Test User B',
        status: 'ACTIVE',
      },
    });

    profileB = await prisma.customerProfile.create({
      data: {
        userId: userB.userId,
        phone: userB.phone,
      },
    });

    tokenB = jwt.sign(
      {
        userId: userB.userId.toString(),
        sub: userB.userId.toString(),
        email: userB.email,
        role: 'CUSTOMER',
        customerProfileId: profileB.customerId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // -------------------------------------------------------------------------
    // Test 1: POST /customer-addresses creates first address as default
    // -------------------------------------------------------------------------
    const createRes1 = await fetch(`${BASE_URL}/customer-addresses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        recipientName: 'Nguyen Van A',
        phone: '0901234567',
        addressDetail: '123 Nguyen Trai',
        ward: 'Phuong 2',
        district: 'Quan 5',
        province: 'TP Ho Chi Minh',
        latitude: 10.755,
        longitude: 106.665,
      }),
    });

    const createBody1 = (await createRes1.json()) as any;
    const addr1 = createBody1.data;

    if (createRes1.status === 201 && addr1?.addressId && addr1.isDefault === true) {
      logTest('Test 1: POST /customer-addresses creates first address and sets as default', true);
      passed++;
    } else {
      logTest(
        'Test 1: POST /customer-addresses creates first address and sets as default',
        false,
        `Status: ${createRes1.status}, body: ${JSON.stringify(createBody1)}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 2: POST /customer-addresses with isDefault: true unsets prior default
    // -------------------------------------------------------------------------
    const createRes2 = await fetch(`${BASE_URL}/customer-addresses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        recipientName: 'Nguyen Van A Second Address',
        phone: '0901234568',
        addressDetail: '456 Le Loi',
        district: 'Quan 1',
        province: 'TP Ho Chi Minh',
        isDefault: true,
      }),
    });

    const createBody2 = (await createRes2.json()) as any;
    const addr2 = createBody2.data;

    // Verify in DB that addr1 is now isDefault = false, and addr2 is isDefault = true
    const dbAddr1 = await prisma.customerAddress.findUnique({
      where: { addressId: BigInt(addr1.addressId) },
    });
    const dbAddr2 = await prisma.customerAddress.findUnique({
      where: { addressId: BigInt(addr2.addressId) },
    });

    if (
      createRes2.status === 201 &&
      addr2?.isDefault === true &&
      dbAddr1?.isDefault === false &&
      dbAddr2?.isDefault === true
    ) {
      logTest('Test 2: POST /customer-addresses with isDefault: true atomically unsets prior default', true);
      passed++;
    } else {
      logTest(
        'Test 2: POST /customer-addresses with isDefault: true atomically unsets prior default',
        false,
        `Status: ${createRes2.status}, addr1.isDefault: ${dbAddr1?.isDefault}, addr2.isDefault: ${dbAddr2?.isDefault}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 3: GET /customer-addresses lists customer's own addresses in order
    // -------------------------------------------------------------------------
    const listRes = await fetch(`${BASE_URL}/customer-addresses`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const listBody = (await listRes.json()) as any;

    if (listRes.status === 200 && Array.isArray(listBody.data) && listBody.data.length === 2) {
      logTest('Test 3: GET /customer-addresses lists authenticated customer addresses', true);
      passed++;
    } else {
      logTest(
        'Test 3: GET /customer-addresses lists authenticated customer addresses',
        false,
        `Status: ${listRes.status}, count: ${listBody.data?.length}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 4: BOLA / IDOR Isolation - User B cannot view or mutate User A's address
    // -------------------------------------------------------------------------
    const idorGetRes = await fetch(`${BASE_URL}/customer-addresses/${addr1.addressId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const idorPatchRes = await fetch(`${BASE_URL}/customer-addresses/${addr1.addressId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ recipientName: 'Hacked Recipient' }),
    });
    const idorDeleteRes = await fetch(`${BASE_URL}/customer-addresses/${addr1.addressId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    if (
      idorGetRes.status === 404 &&
      idorPatchRes.status === 404 &&
      idorDeleteRes.status === 404
    ) {
      logTest('Test 4: BOLA/IDOR protection prevents cross-customer access/mutation (404)', true);
      passed++;
    } else {
      logTest(
        'Test 4: BOLA/IDOR protection prevents cross-customer access/mutation',
        false,
        `Get: ${idorGetRes.status}, Patch: ${idorPatchRes.status}, Delete: ${idorDeleteRes.status}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 5: Guard against deleting address bound to IoTButton
    // -------------------------------------------------------------------------
    store = await prisma.store.findFirst({ where: { status: 'ACTIVE' } });
    if (!store) {
      store = await (prisma.store as any).create({
        data: {
          name: 'IoT Test Store',
          code: `STORE-IOT-${Date.now()}`,
          phone: '0901234567',
          address: '123 IoT St',
          ownerId: 1n,
          status: 'ACTIVE',
        },
      });
    }

    iotButton = await prisma.ioTButton.create({
      data: {
        storeId: store.storeId,
        customerId: profileA.customerId,
        addressId: BigInt(addr1.addressId),
        deviceId: `DEV-ADDR-${Date.now()}`,
        buttonCode: `BTN-ADDR-${Date.now()}`,
        buttonName: 'Smart Button Test',
        hmacSecret: 'test_hmac_secret_32_chars_long_1234',
        status: 'ACTIVE',
      },
    });

    const deleteBoundRes = await fetch(`${BASE_URL}/customer-addresses/${addr1.addressId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const deleteBoundBody = (await deleteBoundRes.json()) as any;

    const isBlocked =
      deleteBoundRes.status === 400 &&
      (deleteBoundBody.errorCode === 'ADDRESS_IN_USE_BY_DEVICE' ||
        deleteBoundBody.message?.includes('thiết bị IoT'));

    if (isBlocked) {
      logTest('Test 5: DELETE /customer-addresses/:id blocks deletion when address is bound to IoTButton (400 ADDRESS_IN_USE_BY_DEVICE)', true);
      passed++;
    } else {
      logTest(
        'Test 5: DELETE blocks deletion when address is bound to IoTButton',
        false,
        `Status: ${deleteBoundRes.status}, body: ${JSON.stringify(deleteBoundBody)}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 6: Concurrency Race Condition on Default Address
    // -------------------------------------------------------------------------
    // Create address 3 for User A (isDefault: false)
    const createRes3 = await fetch(`${BASE_URL}/customer-addresses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        recipientName: 'Nguyen Van A Third Address',
        phone: '0901234569',
        addressDetail: '789 Tran Hung Dao',
        district: 'Quan 5',
        province: 'TP Ho Chi Minh',
        isDefault: false,
      }),
    });
    const addr3 = ((await createRes3.json()) as any).data;

    // Both addr1 and addr3 currently have isDefault: false (addr2 is default).
    // Now simultaneously fire 2 requests to set addr1 and addr3 as default.
    const [raceRes1, raceRes2] = await Promise.all([
      fetch(`${BASE_URL}/customer-addresses/${addr1.addressId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ isDefault: true }),
      }),
      fetch(`${BASE_URL}/customer-addresses/${addr3.addressId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ isDefault: true }),
      }),
    ]);

    // Check count of addresses with isDefault = true for Customer A in DB
    const defaultAddresses = await prisma.customerAddress.findMany({
      where: { customerId: profileA.customerId, isDefault: true },
    });

    if (
      raceRes1.status === 200 &&
      raceRes2.status === 200 &&
      defaultAddresses.length === 1
    ) {
      logTest('Test 6: Concurrent requests setting isDefault: true resolve atomically with exactly 1 default', true);
      passed++;
    } else {
      logTest(
        'Test 6: Concurrent requests setting isDefault: true resolve atomically with exactly 1 default',
        false,
        `Race1: ${raceRes1.status}, Race2: ${raceRes2.status}, Default count in DB: ${defaultAddresses.length}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 7: Successful Deletion after unbinding device
    // -------------------------------------------------------------------------
    await prisma.ioTButton.delete({ where: { buttonId: iotButton.buttonId } });
    iotButton = null;

    const finalDeleteRes = await fetch(`${BASE_URL}/customer-addresses/${addr1.addressId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const finalDeleteBody = (await finalDeleteRes.json()) as any;

    const remainingAddr = await prisma.customerAddress.findUnique({
      where: { addressId: BigInt(addr1.addressId) },
    });

    if (finalDeleteRes.status === 200 && finalDeleteBody.success === true && !remainingAddr) {
      logTest('Test 7: DELETE /customer-addresses/:id successfully deletes unreferenced address', true);
      passed++;
    } else {
      logTest(
        'Test 7: DELETE /customer-addresses/:id successfully deletes unreferenced address',
        false,
        `Status: ${finalDeleteRes.status}, remaining: ${!!remainingAddr}`,
      );
      failed++;
    }
  } catch (err: any) {
    console.error('Customer Addresses test error:', err);
    failed++;
  } finally {
    // Cleanup
    try {
      if (iotButton) {
        await prisma.ioTButton.deleteMany({ where: { buttonId: iotButton.buttonId } });
      }
      if (profileA) {
        await prisma.storeCustomer.deleteMany({ where: { customerId: profileA.customerId } });
        await prisma.customerAddress.deleteMany({ where: { customerId: profileA.customerId } });
        await prisma.customerProfile.deleteMany({ where: { customerId: profileA.customerId } });
      }
      if (userA) {
        await prisma.user.deleteMany({ where: { userId: userA.userId } });
      }
      if (profileB) {
        await prisma.storeCustomer.deleteMany({ where: { customerId: profileB.customerId } });
        await prisma.customerAddress.deleteMany({ where: { customerId: profileB.customerId } });
        await prisma.customerProfile.deleteMany({ where: { customerId: profileB.customerId } });
      }
      if (userB) {
        await prisma.user.deleteMany({ where: { userId: userB.userId } });
      }
      await prisma.$disconnect();
    } catch (cleanupErr) {
      console.error('Cleanup error:', cleanupErr);
    }
  }

  console.log('\n------------------------------------------------------------------------');
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log('------------------------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runCustomerAddressesCrudSuite();
