import crypto from 'crypto';
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

async function runTests() {
  console.log('\n======================================================');
  console.log('🧪 IOT DEVICE CONFIGURATION & PRODUCT MAPPING TESTS');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;
  let autoDevice: any = null;
  let bulkDeviceId: string | null = null;
  let createdTemplateId: string | null = null;

  try {
    // 1. Auth Login as Store Owner
    let storeToken = '';
    let storeId = '';
    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'store@smartorder.local',
          password: 'Password123!',
        }),
      });
      const data = await res.json();
      if (res.status === 200 && data.data?.token) {
        storeToken = data.data.token;
        storeId = data.data.user.storeId;
        logTest('1. Auth: Store Owner Login', true);
        passed++;
      } else {
        throw new Error(data.message);
      }
    } catch (e: any) {
      logTest('1. Auth: Store Owner Login', false, e.message);
      failed++;
    }

    // 2. Fetch Store Products (for SKU mapping)
    let waterProduct: any = null;
    let gasProduct: any = null;
    try {
      const res = await fetch(`${BASE_URL}/products`, {
        headers: { Authorization: `Bearer ${storeToken}` },
      });
      const data = await res.json();
      if (res.status === 200 && data.data?.length > 0) {
        waterProduct = data.data.find((p: any) =>
          p.category?.categoryName?.includes('Nước') ||
          p.category === 'Nước uống' ||
          p.productName?.includes('La Vie') ||
          p.productCode?.includes('WTR')
        ) || data.data[0];

        gasProduct = data.data.find((p: any) =>
          (p.category?.categoryName?.includes('Gas') ||
           p.category === 'Gas' ||
           p.productName?.includes('Gas') ||
           p.productCode?.includes('GAS')) &&
          (p.productId || p.id) !== (waterProduct.productId || waterProduct.id)
        ) || data.data.find((p: any) => (p.productId || p.id) !== (waterProduct.productId || waterProduct.id)) || data.data[1] || data.data[0];

        logTest('2. Products Catalog Lookup (SKU Mapping)', true, `Water: ${waterProduct.sku || waterProduct.productCode}, Gas: ${gasProduct.sku || gasProduct.productCode}`);
        passed++;
      } else {
        throw new Error('No products found');
      }
    } catch (e: any) {
      logTest('2. Products Catalog Lookup (SKU Mapping)', false, e.message);
      failed++;
    }

  // 3. Register New Physical Device with auto-generated SOB ID
  const uniqueMac = `24:6F:28:${crypto.randomBytes(1).toString('hex').toUpperCase()}:${crypto.randomBytes(1).toString('hex').toUpperCase()}:01`;
  try {
    const res = await fetch(`${BASE_URL}/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeToken}`,
      },
      body: JSON.stringify({
        customName: 'Nút Thử Nghiệm Tự Động',
        macAddress: uniqueMac,
        location: 'Khu Vực Test A',
      }),
    });
    const data = await res.json();
    if (res.status === 201 || res.status === 200) {
      autoDevice = data.data;
      if (autoDevice.deviceId.startsWith('SOB-')) {
        logTest('3. Register Device (Auto-generated SOB-XXXXXX ID)', true, `ID: ${autoDevice.deviceId}`);
        passed++;
      } else {
        throw new Error(`Invalid generated deviceId: ${autoDevice.deviceId}`);
      }
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('3. Register Device (Auto-generated SOB-XXXXXX ID)', false, e.message);
    failed++;
  }

  // 4. Verify QR Payload and Zero HMAC Secret Leak
  try {
    const res = await fetch(`${BASE_URL}/devices/${autoDevice.id}`, {
      headers: { Authorization: `Bearer ${storeToken}` },
    });
    const data = await res.json();
    const dev = data.data;
    const hasSecret = 'deviceSecret' in dev;
    const qrPayloadMatches = dev.qrPayload && dev.qrPayload.startsWith('SOBPAIR://device/');

    if (!hasSecret && qrPayloadMatches) {
      logTest('4. Security: Zero HMAC Secret Leak & SOBPAIR:// QR Token', true, dev.qrPayload);
      passed++;
    } else {
      throw new Error(`Secret leaked: ${hasSecret}, QR payload: ${dev.qrPayload}`);
    }
  } catch (e: any) {
    logTest('4. Security: Zero HMAC Secret Leak & SOBPAIR:// QR Token', false, e.message);
    failed++;
  }

  // 5. Test Duplicate Device ID Rejection
  try {
    const res = await fetch(`${BASE_URL}/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeToken}`,
      },
      body: JSON.stringify({
        deviceId: autoDevice.deviceId, // Duplicate ID
        customName: 'Duplicate Test',
      }),
    });
    const data = await res.json();
    if (res.status === 400 && data.message.includes('đã tồn tại')) {
      logTest('5. Validation: Reject Duplicate Device ID', true, data.message);
      passed++;
    } else {
      throw new Error(`Expected 400, got ${res.status}`);
    }
  } catch (e: any) {
    logTest('5. Validation: Reject Duplicate Device ID', false, e.message);
    failed++;
  }

  // 6. Test Duplicate MAC Address Rejection
  try {
    const res = await fetch(`${BASE_URL}/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeToken}`,
      },
      body: JSON.stringify({
        macAddress: autoDevice.macAddress, // Duplicate MAC
        customName: 'Duplicate MAC Test',
      }),
    });
    const data = await res.json();
    if (res.status === 400 && data.message.includes('MAC')) {
      logTest('6. Validation: Reject Duplicate MAC Address', true, data.message);
      passed++;
    } else {
      throw new Error(`Expected 400, got ${res.status}`);
    }
  } catch (e: any) {
    logTest('6. Validation: Reject Duplicate MAC Address', false, e.message);
    failed++;
  }

  // 7. Assign Product (Water SKU) to Device
  try {
    const res = await fetch(`${BASE_URL}/devices/${autoDevice.deviceId}/assign-product`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeToken}`,
      },
      body: JSON.stringify({
        productId: Number(waterProduct.productId || waterProduct.id),
        customName: 'Nút Đặt Nước Bếp',
      }),
    });
    const data = await res.json();
    if (res.status === 200 || res.status === 201) {
      logTest('7. Dynamic Product Mapping: Assign Water SKU', true, `Assigned: ${waterProduct.sku || waterProduct.productCode}`);
      passed++;
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('7. Dynamic Product Mapping: Assign Water SKU', false, e.message);
    failed++;
  }

  // 8. Reassign to a Different Product (Gas SKU) WITHOUT touching firmware
  try {
    const res = await fetch(`${BASE_URL}/devices/${autoDevice.deviceId}/assign-product`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeToken}`,
      },
      body: JSON.stringify({
        productId: Number(gasProduct.productId || gasProduct.id),
        customName: 'Nút Đặt Gas Nhà Bếp',
      }),
    });
    const data = await res.json();
    if (res.status === 200 || res.status === 201) {
      logTest('8. Dynamic Product Mapping: Reassign to Gas SKU without firmware reflash', true, `Reassigned: ${gasProduct.sku || gasProduct.productCode}`);
      passed++;
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('8. Dynamic Product Mapping: Reassign to Gas SKU without firmware reflash', false, e.message);
    failed++;
  }

  // 9. Verify Device Audit Logs (recorded old vs new values)
  try {
    const res = await fetch(`${BASE_URL}/devices/${autoDevice.deviceId}/audit-logs`, {
      headers: { Authorization: `Bearer ${storeToken}` },
    });
    const data = await res.json();
    if (res.status === 200 && data.data?.length >= 2) {
      const latestAudit = data.data[0];
      logTest('9. Device Configuration Audit Logs Tracked', true, `${latestAudit.action} by ${latestAudit.user?.fullName || 'User'}`);
      passed++;
    } else {
      throw new Error(`Audit logs count: ${data.data?.length}`);
    }
  } catch (e: any) {
    logTest('9. Device Configuration Audit Logs Tracked', false, e.message);
    failed++;
  }

  // 10. Fleet Stats API Verification
  try {
    const res = await fetch(`${BASE_URL}/devices/fleet/stats`, {
      headers: { Authorization: `Bearer ${storeToken}` },
    });
    const data = await res.json();
    if (res.status === 200 && data.data && typeof data.data.total === 'number') {
      logTest('10. Fleet Stats Breakdown', true, `Total: ${data.data.total}, Online: ${data.data.online}, Offline: ${data.data.offline}`);
      passed++;
    } else {
      throw new Error('Invalid fleet stats structure');
    }
  } catch (e: any) {
    logTest('10. Fleet Stats Breakdown', false, e.message);
    failed++;
  }

  // 11. Bulk Import CSV Validation
  try {
    bulkDeviceId = `SOB-BLK-${Date.now().toString(36).toUpperCase()}-${Math.floor(10 + Math.random() * 89)}`;
    const bulkMac = `24:6F:28:90:${crypto.randomBytes(1).toString('hex').toUpperCase()}:99`;
    const bulkRows = [
      {
        deviceId: bulkDeviceId,
        serialNumber: `SN-BLK-${Date.now()}`,
        macAddress: bulkMac,
        customName: 'Bulk Button 01',
        productSku: waterProduct.sku || waterProduct.productCode,
      },
    ];

    const res = await fetch(`${BASE_URL}/devices/bulk-import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeToken}`,
      },
      body: JSON.stringify({ rows: bulkRows }),
    });
    const data = await res.json();
    if (res.status === 200 || res.status === 201) {
      logTest('11. Bulk Import Devices via CSV with SKU resolution', true, `Imported: ${data.count} devices`);
      passed++;
    } else {
      throw new Error(data.message || JSON.stringify(data.errors));
    }
  } catch (e: any) {
    logTest('11. Bulk Import Devices via CSV with SKU resolution', false, e.message);
    failed++;
  }

  // 12. Device Templates: Create and Deploy
  try {
    // Create Template
    const createRes = await fetch(`${BASE_URL}/device-templates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeToken}`,
      },
      body: JSON.stringify({
        name: `WATER PROFILE ${Date.now()}`,
        category: 'Nước uống',
        singlePressAction: 'CREATE_ORDER',
        doublePressAction: 'CANCEL_ORDER',
        defaultQuantity: 1,
        cancelWindowSeconds: 60,
      }),
    });
    const createData = await createRes.json();
    if (!createData.data) {
      throw new Error(`Failed to create template: ${createData.message || JSON.stringify(createData)}`);
    }
    createdTemplateId = createData.data.id;

    // Deploy Template to autoDevice
    const deployRes = await fetch(`${BASE_URL}/device-templates/${createdTemplateId}/deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeToken}`,
      },
      body: JSON.stringify({
        deviceId: autoDevice.deviceId,
      }),
    });
    const deployData = await deployRes.json();

    if (deployRes.status === 200 || deployRes.status === 201) {
      logTest('12. Device Templates: Create & Deploy Profile', true, deployData.message);
      passed++;
    } else {
      throw new Error(deployData.message);
    }
  } catch (e: any) {
    logTest('12. Device Templates: Create & Deploy Profile', false, e.message);
    failed++;
  }
  } finally {
    // Zero residue cleanup
    try {
      const cleanupDeviceIds: string[] = [];
      if (autoDevice?.deviceId) cleanupDeviceIds.push(autoDevice.deviceId);
      if (bulkDeviceId) cleanupDeviceIds.push(bulkDeviceId);

      for (const dId of cleanupDeviceIds) {
        const btn = await prisma.ioTButton.findFirst({ where: { deviceId: dId } });
        if (btn) {
          await prisma.buttonProduct.deleteMany({ where: { buttonId: btn.buttonId } });
          await prisma.ioTButton.delete({ where: { buttonId: btn.buttonId } });
        }
      }

      if (createdTemplateId) {
        await prisma.deviceTemplate.deleteMany({ where: { templateId: BigInt(createdTemplateId) } });
      }
      console.log('  ✔ [CLEANUP] Successfully cleaned up test devices and templates');
    } catch (cleanupErr: any) {
      console.warn('  ⚠️ [CLEANUP WARNING]', cleanupErr.message);
    } finally {
      await prisma.$disconnect();
    }
  }

  console.log('\n------------------------------------------------------');
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('Fatal error in tests:', e);
  process.exit(1);
});
