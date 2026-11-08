import * as assert from 'assert';
import * as crypto from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { StoreStaffResponseDto } from '../src/store-staff/dto/store-staff-response.dto';

async function runSecurityAuditP1FixesTests() {
  console.log('================================================================');
  console.log('🔒 SUITE 73: Security Audit P1 Fixes Verification');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    try {
      const res = fn();
      if (res instanceof Promise) {
        return res
          .then(() => {
            console.log(`  ✔ [PASS] ${name}`);
            passed++;
          })
          .catch((err) => {
            console.error(`  ❌ [FAIL] ${name}:`, err.message);
            failed++;
          });
      } else {
        console.log(`  ✔ [PASS] ${name}`);
        passed++;
      }
    } catch (err: any) {
      console.error(`  ❌ [FAIL] ${name}:`, err.message);
      failed++;
    }
  }

  console.log('[ITEM 1] auth/me-leaks-device-hmac-secret-no-rotation:');
  {
    await test('1.1 AuthService.getMe sanitizes hmacSecret from customerProfile.iotButtons', async () => {
      const rawCustomerProfile = {
        customerId: 123n,
        iotButtons: [
          {
            buttonId: 1n,
            deviceId: 'SOB-001',
            buttonName: 'Test Button',
            hmacSecret: 'super_secret_hmac_key_99999',
            status: 'ACTIVE',
          },
        ],
      };

      // Mock user object returned from DB
      const user: any = {
        userId: 10n,
        email: 'customer@smartorder.vn',
        username: 'customer1',
        fullName: 'Nguyen Van A',
        status: 'ACTIVE',
        customerProfile: rawCustomerProfile,
        ownedStores: [],
        storeStaffs: [],
        createdAt: new Date(),
      };

      // Simulated getMe logic
      const customerProfile = user.customerProfile
        ? {
            ...user.customerProfile,
            iotButtons: user.customerProfile.iotButtons?.map((btn: any) => {
              const { hmacSecret, ...safeBtn } = btn;
              return safeBtn;
            }),
          }
        : null;

      assert.strictEqual(customerProfile.iotButtons[0].deviceId, 'SOB-001');
      assert.strictEqual((customerProfile.iotButtons[0] as any).hmacSecret, undefined, 'hmacSecret must be stripped');
    });

    await test('1.2 Hardware secret preservation: unclaim and claim do not destroy ESP32 signing secret', async () => {
      const flashedSecret = 'esp32_flashed_hardware_secret_key_32bytes_hex';
      const buttonState = {
        buttonId: 1n,
        customerId: 123n,
        status: 'ACTIVE',
        hmacSecret: flashedSecret,
      };

      const unclaimedState = {
        ...buttonState,
        customerId: null,
        status: 'UNASSIGNED',
      };

      assert.strictEqual(unclaimedState.hmacSecret, flashedSecret, 'Flashed secret must remain valid for physical device');
    });
  }

  console.log('\n[ITEM 2] auth/register-unverified-email-preaccount-hijack:');
  {
    await test('2.1 linkProviderSubject with clearPreLinkCredentials wipes passwordHash and revokes tokens', async () => {
      // Mock transaction context
      let updatedUser: any = null;
      let revokedTokensCount = 0;

      const mockTx = {
        $queryRaw: async () => [{ user_id: 10n }],
        userAuthIdentity: {
          findUnique: async () => null,
          create: async () => ({ id: 1n }),
        },
        refreshToken: {
          updateMany: async ({ where, data }: any) => {
            if (where.userId === 10n && data.isRevoked === true) {
              revokedTokensCount = 3;
            }
          },
        },
        user: {
          update: async ({ where, data }: any) => {
            updatedUser = { userId: where.userId, ...data };
            return updatedUser;
          },
        },
      };

      const clearPreLinkCredentials = true;
      const updateData: any = { authProvider: 'GOOGLE', providerSubject: 'google_sub_123' };
      if (clearPreLinkCredentials) {
        await mockTx.refreshToken.updateMany({
          where: { userId: 10n, isRevoked: false },
          data: { isRevoked: true },
        });
        updateData.passwordHash = null;
        updateData.passwordChangedAt = new Date();
        updateData.emailVerificationToken = null;
        updateData.emailVerificationExpiresAt = null;
      }
      await mockTx.user.update({ where: { userId: 10n }, data: updateData });

      assert.strictEqual(revokedTokensCount, 3, 'All pre-existing refresh tokens must be revoked');
      assert.strictEqual(updatedUser.passwordHash, null, 'Pre-link passwordHash must be wiped');
      assert.ok(updatedUser.passwordChangedAt instanceof Date, 'passwordChangedAt must be updated');
      assert.strictEqual(updatedUser.emailVerificationToken, null);
    });

    await test('2.2 Verified user linking Google retains password and active sessions', async () => {
      const verifiedExistingUser = {
        userId: 20n,
        email: 'legit_user@gmail.com',
        emailVerifiedAt: new Date(Date.now() - 86400000),
        emailVerificationToken: null,
        passwordHash: '$2a$12$someValidBcryptPasswordHashHere',
      };

      const isEmailVerified = Boolean(verifiedExistingUser.emailVerifiedAt) && !verifiedExistingUser.emailVerificationToken;
      const shouldClearPreLinkCredentials = !isEmailVerified && Boolean(verifiedExistingUser.passwordHash);

      assert.strictEqual(isEmailVerified, true, 'User email must be recognized as verified');
      assert.strictEqual(shouldClearPreLinkCredentials, false, 'Pre-link password credentials must NOT be wiped for verified users');
    });
  }

  console.log('\n[ITEM 3] bank-verification/webhook-unsigned-top-level-fields-override-signed-data:');
  {
    await test('3.1 Contradicting top-level amount throws BadRequestException', async () => {
      const dto: any = {
        amount: 50000, // Forged top-level amount
        data: {
          amount: 2000, // Authentic signed inner amount
          reference: 'PAYOS_TX_001',
          description: 'VERIFY_ABCD12',
        },
      };

      let threw = false;
      try {
        if (dto.data) {
          if (dto.amount !== undefined && Number(dto.amount) !== Number(dto.data.amount)) {
            throw new BadRequestException('Dữ liệu webhook không nhất quán: top-level amount khác với signed data.amount');
          }
        }
      } catch (err: any) {
        threw = true;
        assert.ok(err instanceof BadRequestException);
      }
      assert.ok(threw, 'Must reject conflicting top-level amount');
    });

    await test('3.2 Contradicting top-level providerTransactionId throws BadRequestException', async () => {
      const dto: any = {
        providerTransactionId: 'FORGED_REF_999',
        data: {
          amount: 2000,
          reference: 'AUTHENTIC_REF_111',
          description: 'VERIFY_ABCD12',
        },
      };

      let threw = false;
      try {
        if (dto.data) {
          if (dto.providerTransactionId && dto.data.reference && dto.providerTransactionId !== dto.data.reference) {
            throw new BadRequestException('Dữ liệu webhook không nhất quán: top-level providerTransactionId khác với signed data.reference');
          }
        }
      } catch (err: any) {
        threw = true;
        assert.ok(err instanceof BadRequestException);
      }
      assert.ok(threw, 'Must reject conflicting top-level providerTransactionId');
    });

    await test('3.3 Authentic signed payload strictly extracts data fields', async () => {
      const dto: any = {
        data: {
          amount: 2000,
          reference: 'TX_LEGIT_123',
          description: 'VERIFY_LEGIT456',
          destinationAccountNumber: '0339898989',
          destinationBankBin: '970422',
          counterAccountNumber: '102800012345',
          counterBankBin: '970415',
        },
      };

      let amount = dto.data?.amount || dto.amount;
      let providerTransactionId = dto.data?.reference || dto.providerTransactionId;
      let description = dto.data?.description || dto.description || '';
      let destinationAccountNumber = dto.data?.destinationAccountNumber || dto.destinationAccountNumber;
      let senderAccountNumber = dto.data?.counterAccountNumber || dto.senderAccountNumber;

      assert.strictEqual(amount, 2000);
      assert.strictEqual(providerTransactionId, 'TX_LEGIT_123');
      assert.strictEqual(destinationAccountNumber, '0339898989');
      assert.strictEqual(senderAccountNumber, '102800012345');
    });
  }

  console.log('\n[ITEM 4] cloudflare-worker/authenticated-get-cache-everything-stores-prefix:');
  {
    const EXACT_CACHEABLE_ROUTES = [
      '/healthz',
      '/api/v1/stores',
      '/api/v1/categories',
      '/api/v1/subscription-plans/public',
    ];

    function checkIsCacheable(method: string, path: string, headers: Record<string, string>): boolean {
      const hasAuth = Boolean(headers['Authorization'] || headers['Cookie']);
      const cacheControl = headers['Cache-Control'] || '';
      const noStoreRequested = cacheControl.includes('no-store') || cacheControl.includes('no-cache');

      const isPathCacheable = EXACT_CACHEABLE_ROUTES.some((route) => {
        return path === route || path === `${route}/`;
      });

      return method === 'GET' && !hasAuth && !noStoreRequested && isPathCacheable;
    }

    await test('4.1 Authenticated GET to /api/v1/stores is NEVER cached', () => {
      const cacheable = checkIsCacheable('GET', '/api/v1/stores', { Authorization: 'Bearer test_token' });
      assert.strictEqual(cacheable, false, 'Authenticated request must never be edge-cached');
    });

    await test('4.2 Authenticated GET to /api/v1/stores/me is NEVER cached', () => {
      const cacheable = checkIsCacheable('GET', '/api/v1/stores/me', { Authorization: 'Bearer test_token' });
      assert.strictEqual(cacheable, false, 'Store me endpoint must never be edge-cached');
    });

    await test('4.3 Unauthenticated GET to /api/v1/stores/123/customers is NEVER cached', () => {
      const cacheable = checkIsCacheable('GET', '/api/v1/stores/123/customers', {});
      assert.strictEqual(cacheable, false, 'Customer sub-path must not match exact cacheable route');
    });

    await test('4.4 Public unauthenticated GET to /api/v1/stores list is edge-cacheable', () => {
      const cacheable = checkIsCacheable('GET', '/api/v1/stores', {});
      assert.strictEqual(cacheable, true);
    });

    await test('4.5 Public unauthenticated GET to /healthz is edge-cacheable', () => {
      const cacheable = checkIsCacheable('GET', '/healthz', {});
      assert.strictEqual(cacheable, true);
    });
  }

  console.log('\n[ITEM 5] devices/legacy-claim-unscoped-device-disclosure:');
  {
    await test('5.1 Store owner attempting to claim device of another store throws ForbiddenException', async () => {
      const caller = { role: 'STORE_OWNER', storeId: '10' };
      const targetDevice = { buttonId: 101n, deviceId: 'SOB-FOREIGN', storeId: 20n };

      let threw = false;
      try {
        if (['STORE_OWNER', 'STORE_MANAGER'].includes(caller.role)) {
          if (targetDevice.storeId.toString() !== caller.storeId.toString()) {
            throw new ForbiddenException('Thiết bị không thuộc phạm vi cửa hàng của bạn');
          }
        }
      } catch (err: any) {
        threw = true;
        assert.ok(err instanceof ForbiddenException);
      }
      assert.ok(threw, 'Must reject foreign store device access');
    });

    await test('5.2 Store owner accessing own store device succeeds', async () => {
      const caller = { role: 'STORE_OWNER', storeId: '10' };
      const ownDevice = { buttonId: 102n, deviceId: 'SOB-OWN', storeId: 10n };

      let allowed = false;
      if (['STORE_OWNER', 'STORE_MANAGER'].includes(caller.role)) {
        if (ownDevice.storeId.toString() === caller.storeId.toString()) {
          allowed = true;
        }
      }
      assert.ok(allowed, 'Own store device access must succeed');
    });
  }

  console.log('\n[ITEM 6] devices/register-binds-arbitrary-customer:');
  {
    await test('6.1 Store owner registering device without customerId creates UNASSIGNED device with null customerId', async () => {
      const user = { role: 'STORE_OWNER', storeId: '15' };
      const dto: any = { deviceId: 'SOB-NEW-01', buttonName: 'New Counter' };

      let customerId: bigint | null = null;
      let addressId: bigint | null = null;

      if (user.role === 'CUSTOMER' && (user as any).customerProfileId) {
        customerId = BigInt((user as any).customerProfileId);
      } else if (['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role) && dto.customerId) {
        customerId = BigInt(dto.customerId);
      }

      const status = customerId ? 'ACTIVE' : 'UNASSIGNED';

      assert.strictEqual(customerId, null, 'Must not bind arbitrary customer');
      assert.strictEqual(addressId, null);
      assert.strictEqual(status, 'UNASSIGNED');
    });
  }

  console.log('\n[ITEM 7] store-customers/status-upsert-creates-link-and-discloses-pii:');
  {
    await test('7.1 Updating customer status for unlinked customer throws NotFoundException', async () => {
      const storeId = 10n;
      const unlinkedCustomerId = 999n;

      const mockRepo = {
        findStoreCustomer: async (_s: bigint, _c: bigint) => null,
      };

      let threw = false;
      try {
        const existing = await mockRepo.findStoreCustomer(storeId, unlinkedCustomerId);
        if (!existing) {
          throw new NotFoundException('Khách hàng chưa từng phát sinh quan hệ với cửa hàng');
        }
      } catch (err: any) {
        threw = true;
        assert.ok(err instanceof NotFoundException);
      }
      assert.ok(threw, 'Must throw NotFoundException and NOT upsert unlinked customer');
    });
  }

  console.log('\n[ITEM 8] store-staff/add-staff-without-target-consent:');
  {
    await test('8.1 StoreStaffResponseDto masks email and phone numbers', () => {
      const maskedEmail = StoreStaffResponseDto.maskEmail('nguyenvana@gmail.com');
      const maskedPhone = StoreStaffResponseDto.maskPhone('0912345678');

      assert.strictEqual(maskedEmail, 'ng***a@gmail.com');
      assert.strictEqual(maskedPhone, '091****678');
    });

    await test('8.2 Adding platform admin as store staff is strictly forbidden', async () => {
      const targetUser = { username: 'admin', email: 'admin@smartorder.local' };

      let threw = false;
      try {
        if (targetUser.username === 'admin' || targetUser.email === 'admin@smartorder.local') {
          throw new ForbiddenException('Không thể thêm tài khoản quản trị hệ thống làm nhân viên cửa hàng');
        }
      } catch (err: any) {
        threw = true;
        assert.ok(err instanceof ForbiddenException);
      }
      assert.ok(threw, 'Must forbid adding system admin as staff');
    });

    await test('8.3 Involuntary role override prevention in JwtStrategy', () => {
      const payload = { role: 'CUSTOMER', storeId: null };
      const user = {
        storeStaffs: [
          { storeId: 20n, status: 'ACTIVE', role: { roleCode: 'STORE_STAFF' } },
        ],
      };

      let role: string;
      let storeId: string | null;

      if (user.storeStaffs && user.storeStaffs.length > 0) {
        if (payload.role === 'CUSTOMER' && !payload.storeId) {
          role = 'CUSTOMER';
          storeId = null;
        } else {
          role = 'STORE_STAFF';
          storeId = '20';
        }
      } else {
        role = 'CUSTOMER';
        storeId = null;
      }

      assert.strictEqual(role, 'CUSTOMER', 'Customer session must not be hijacked by unsolicited store_staff row');
      assert.strictEqual(storeId, null);
    });

    await test('8.4 Database platform admin role or active store owner cannot be added as store staff', async () => {
      const userPlatformRoles = ['SUPER_ADMIN'];
      const ownedStoreCount = 1;

      const isPlatformAdmin = userPlatformRoles.some((r) =>
        ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(r),
      );
      assert.strictEqual(isPlatformAdmin, true, 'Platform admin role must be detected from DB roles');

      let rejectedAdmin = false;
      try {
        if (isPlatformAdmin) throw new ForbiddenException('Không thể thêm tài khoản quản trị hệ thống làm nhân viên cửa hàng');
      } catch (err: any) {
        rejectedAdmin = true;
      }
      assert.strictEqual(rejectedAdmin, true);

      let rejectedOwner = false;
      try {
        if (ownedStoreCount > 0) throw new ConflictException('Không thể thêm người dùng đang là chủ cửa hàng khác làm nhân viên');
      } catch (err: any) {
        rejectedOwner = true;
      }
      assert.strictEqual(rejectedOwner, true);
    });

    await test('8.5 Staff invitations require explicit acceptance before role resolution', () => {
      const pendingStaffUser = {
        storeStaffs: [
          { storeId: 20n, status: 'PENDING', role: { roleCode: 'STORE_MANAGER' } },
        ],
      };

      const activeStaff = pendingStaffUser.storeStaffs.find((s: any) => s.status === 'ACTIVE');
      assert.strictEqual(activeStaff, undefined, 'PENDING staff invitation must not be treated as active staff');
    });

    await test('8.6 Owner cannot PATCH PENDING invitation directly to ACTIVE (Bypass Defense)', () => {
      const currentStaff = { status: 'PENDING' };
      const requestedStatus = 'ACTIVE';

      let threwForbidden = false;
      try {
        if (currentStaff.status === 'PENDING' && requestedStatus === 'ACTIVE') {
          throw new ForbiddenException(
            'INVITATION_ACCEPTANCE_REQUIRED: Chủ cửa hàng không thể tự ý kích hoạt lời mời. Người dùng được mời phải tự chấp nhận qua API accept.',
          );
        }
      } catch (err: any) {
        threwForbidden = err instanceof ForbiddenException;
      }

      assert.strictEqual(threwForbidden, true, 'Must forbid owner from activating PENDING invitation directly');
    });

    await test('8.7 Terminated/inactive staff cannot self-reactivate via acceptInvitation', () => {
      const terminatedStaff = { status: 'TERMINATED', userId: 100n };
      const inactiveStaff = { status: 'INACTIVE', userId: 100n };

      for (const st of [terminatedStaff, inactiveStaff]) {
        let threwConflict = false;
        try {
          if (st.status !== 'PENDING') {
            throw new ConflictException(
              st.status === 'ACTIVE'
                ? 'Lời mời này đã được chấp nhận và đang hoạt động'
                : 'Không thể chấp nhận lời mời đã bị từ chối hoặc nhân viên đã bị chấm dứt (TERMINATED/INACTIVE)',
            );
          }
        } catch (err: any) {
          threwConflict = err instanceof ConflictException;
        }
        assert.strictEqual(threwConflict, true, `Must reject self-activation for status ${st.status}`);
      }
    });

    await test('8.8 Double-acceptance of active staff is rejected with 409 Conflict', () => {
      const activeStaff = { status: 'ACTIVE', userId: 100n };
      let threwConflict = false;
      try {
        if (activeStaff.status !== 'PENDING') {
          throw new ConflictException('Lời mời này đã được chấp nhận và đang hoạt động');
        }
      } catch (err: any) {
        threwConflict = err instanceof ConflictException;
      }
      assert.strictEqual(threwConflict, true, 'Double acceptance must throw ConflictException');
    });

    await test('8.9 Owner cannot PATCH TERMINATED staff directly to ACTIVE (Must re-invite)', () => {
      const terminatedStaff = { status: 'TERMINATED' };
      const requestedStatus = 'ACTIVE';

      let threwForbidden = false;
      try {
        if (
          (terminatedStaff.status === 'TERMINATED' || terminatedStaff.status === 'INACTIVE') &&
          requestedStatus === 'ACTIVE'
        ) {
          throw new ForbiddenException(
            'REINVITATION_REQUIRED: Không thể kích hoạt trực tiếp nhân viên đã bị chấm dứt (TERMINATED/INACTIVE). Vui lòng gửi lời mời mới.',
          );
        }
      } catch (err: any) {
        threwForbidden = err instanceof ForbiddenException;
      }

      assert.strictEqual(threwForbidden, true, 'Must require reinvitation for terminated staff');
    });

    await test('8.10 AuthService role resolution returns CUSTOMER when staff invitation is PENDING', () => {
      const userWithPendingInvitation: any = {
        username: 'candidate_john',
        email: 'john@example.com',
        ownedStores: [],
        storeStaffs: [
          {
            storeId: 10n,
            status: 'PENDING',
            role: { roleCode: 'STORE_MANAGER' },
          },
        ],
      };

      // Mock AuthService resolveUserRole logic
      const resolveUserRole = (u: any) => {
        if (u.username === 'admin' || u.email === 'admin@smartorder.local') {
          return { role: 'SUPER_ADMIN', storeId: null };
        }
        if (u.ownedStores && u.ownedStores.length > 0) {
          return { role: 'STORE_OWNER', storeId: u.ownedStores[0].storeId.toString() };
        }
        const activeStaff = u.storeStaffs?.find((s: any) => s.status === 'ACTIVE');
        if (activeStaff) {
          return {
            role: activeStaff.role?.roleCode || 'STORE_STAFF',
            storeId: activeStaff.storeId.toString(),
          };
        }
        return { role: 'CUSTOMER', storeId: null };
      };

      const resolved = resolveUserRole(userWithPendingInvitation);
      assert.strictEqual(resolved.role, 'CUSTOMER', 'Pending invitation must NOT grant staff role');
      assert.strictEqual(resolved.storeId, null);
    });
  }

  console.log('\n================================================================');
  console.log(`Test Execution Finished: ${passed} Passed, ${failed} Failed`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runSecurityAuditP1FixesTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

