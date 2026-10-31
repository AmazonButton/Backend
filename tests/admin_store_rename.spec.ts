import assert from 'node:assert';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AdminService } from '../src/admin/admin.service';
import { UpdateAdminStoreDto } from '../src/admin/dto/update-admin-store.dto';

async function run() {
  console.log('🧪 Testing Task 7: Admin Store Rename & Update API...');

  let updateCalledWith: any = null;
  const mockAdminRepo = {
    findStoreById: async (id: bigint) => {
      if (id === BigInt(999)) return null;
      return {
        storeId: id,
        name: 'Old Store Name',
        phone: '0900000000',
        address: 'Old Address',
        status: 'ACTIVE',
      };
    },
    updateStoreById: async (id: bigint, data: any) => {
      updateCalledWith = { id, ...data };
      return { storeId: id, ...data };
    },
  };

  const adminService = new AdminService(mockAdminRepo as any);
  (adminService as any).invalidateAdminAndStoreCaches = async () => {};

  // Test 1: Store rename & update success
  const updated = await adminService.updateStoreById(
    '1',
    { name: 'New Brand Store Name', address: '456 New Road' },
    { role: 'SUPER_ADMIN' },
  );

  assert.strictEqual(updated.name, 'New Brand Store Name');
  assert.strictEqual(updateCalledWith.name, 'New Brand Store Name');
  assert.strictEqual(updateCalledWith.address, '456 New Road');

  // Test 2: Non-existent store throws NotFoundException
  try {
    await adminService.updateStoreById('999', { name: 'Ghost Store' });
    assert.fail('Should throw NotFoundException for non-existent store');
  } catch (err: any) {
    assert.strictEqual(
      err.message.includes('Không tìm thấy cửa hàng') || err.status === 404,
      true,
    );
  }

  // Test 3: UpdateAdminStoreDto validation rules
  const invalidDto = plainToInstance(UpdateAdminStoreDto, {
    name: '   ',
    phone: '123',
    status: 'UNKNOWN_STATUS',
  });
  const validationErrors = await validate(invalidDto);
  assert.strictEqual(validationErrors.length >= 3, true, 'Expected validation errors for name, phone, and status');

  const validDto = plainToInstance(UpdateAdminStoreDto, {
    name: 'Valid Store',
    phone: '0987654321',
    status: 'ACTIVE',
  });
  const validErrors = await validate(validDto);
  assert.strictEqual(validErrors.length, 0, 'Expected no validation errors for valid DTO');

  console.log('✅ Task 7 Admin Store Rename & Update API tests PASSED!');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err.message);
  process.exit(1);
});
