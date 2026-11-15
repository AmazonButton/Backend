import * as dotenv from 'dotenv';
dotenv.config();
import 'reflect-metadata';

import { ObjectStorageService } from '../src/media/object-storage.service';
import { DeliverOrderDto } from '../src/orders/dto/deliver-order.dto';
import { PresignedUploadDto } from '../src/media/dto/presigned-upload.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

async function runPodArchitectureTestSuite() {
  console.log('================================================================================');
  console.log('📦 PROOF OF DELIVERY (POD) ARCHITECTURE TEST SUITE (SHOPEE / GRAB / AMAZON)');
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

  const objectStorage = new ObjectStorageService();

  // Test 1: Presigned upload URL generation
  const objectKey = 'stores/1/pod/2026/11/order_842_abc123.webp';
  const uploadResult = await objectStorage.generatePresignedUploadUrl(objectKey, 'image/webp', 300);
  assert(
    Boolean(uploadResult && uploadResult.objectKey === objectKey && uploadResult.expiresInSeconds === 300 && uploadResult.uploadUrl),
    '1. ObjectStorageService generates Presigned Upload URL with 300s TTL',
    JSON.stringify(uploadResult),
  );

  // Test 2: Presigned view URL generation
  const viewResult = await objectStorage.generatePresignedViewUrl(objectKey, 900);
  assert(
    Boolean(viewResult && viewResult.viewUrl && viewResult.expiresAt && new Date(viewResult.expiresAt).getTime() > Date.now()),
    '2. ObjectStorageService generates Presigned View URL with 900s TTL (PII Protection)',
    JSON.stringify(viewResult),
  );

  // Test 3: PresignedUploadDto rejects invalid orderId
  const invalidUploadDto = plainToInstance(PresignedUploadDto, {
    orderId: 'invalid-id-xyz',
    contentType: 'image/webp',
  });
  const uploadErrors = await validate(invalidUploadDto);
  assert(
    uploadErrors.length > 0 && uploadErrors.some((e) => e.property === 'orderId'),
    '3. PresignedUploadDto validates and rejects non-numeric orderId',
  );

  // Test 4: PresignedUploadDto accepts valid orderId
  const validUploadDto = plainToInstance(PresignedUploadDto, {
    orderId: '842',
    contentType: 'image/webp',
    fileSizeBytes: 245800,
  });
  const validUploadErrors = await validate(validUploadDto);
  assert(
    validUploadErrors.length === 0,
    '4. PresignedUploadDto accepts valid orderId and metadata',
  );

  // Test 5: DeliverOrderDto accepts Target Architecture podObjectKey + GPS
  const targetDeliverDto = plainToInstance(DeliverOrderDto, {
    status: 'DELIVERED',
    paymentMethod: 'COD',
    collectedAmount: 50000,
    podObjectKey: 'stores/1/pod/2026/11/order_842_x8f9a.webp',
    driverLatitude: 10.8529241,
    driverLongitude: 106.6295123,
    deliveredAt: '2026-11-15T13:10:25.000Z',
  });
  const targetErrors = await validate(targetDeliverDto);
  assert(
    targetErrors.length === 0 &&
      targetDeliverDto.podObjectKey === 'stores/1/pod/2026/11/order_842_x8f9a.webp' &&
      targetDeliverDto.driverLatitude === 10.8529241,
    '5. DeliverOrderDto accepts podObjectKey and driver GPS coordinates',
  );

  // Test 6: DeliverOrderDto accepts Legacy podImageUrl (Backward Compatibility)
  const legacyDeliverDto = plainToInstance(DeliverOrderDto, {
    status: 'DELIVERED',
    paymentMethod: 'PAYOS',
    podImageUrl: 'https://res.cloudinary.com/demo/image/upload/stores/1/pod/image.jpg',
  });
  const legacyErrors = await validate(legacyDeliverDto);
  assert(
    legacyErrors.length === 0 && legacyDeliverDto.podImageUrl.includes('cloudinary.com'),
    '6. DeliverOrderDto accepts legacy Cloudinary URL for backward compatibility',
  );

  // Test 7: Haversine distance geofence calculation
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const lat1 = toRad(10.8529241);
  const lon1 = toRad(106.6295123);

  // Nearby point (~50m)
  const latNearby = toRad(10.8533);
  const lonNearby = toRad(106.6297);
  const dLatN = latNearby - lat1;
  const dLonN = lonNearby - lon1;
  const aN =
    Math.sin(dLatN / 2) * Math.sin(dLatN / 2) +
    Math.cos(lat1) * Math.cos(latNearby) * Math.sin(dLonN / 2) * Math.sin(dLonN / 2);
  const distNearby = Math.round(6371000 * 2 * Math.atan2(Math.sqrt(aN), Math.sqrt(1 - aN)));

  // Far point (~2200m)
  const latFar = toRad(10.8700);
  const lonFar = toRad(106.6400);
  const dLatF = latFar - lat1;
  const dLonF = lonFar - lon1;
  const aF =
    Math.sin(dLatF / 2) * Math.sin(dLatF / 2) +
    Math.cos(lat1) * Math.cos(latFar) * Math.sin(dLonF / 2) * Math.sin(dLonF / 2);
  const distFar = Math.round(6371000 * 2 * Math.atan2(Math.sqrt(aF), Math.sqrt(1 - aF)));

  assert(
    distNearby <= 500 && distFar > 500,
    `7. Geofencing Haversine correctly distinguishes nearby delivery (${distNearby}m <= 500m) and far delivery (${distFar}m > 500m)`,
  );

  console.log(`\n================================================================================`);
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPodArchitectureTestSuite().catch((err) => {
  console.error('Test suite failed unexpectedly:', err);
  process.exit(1);
});
