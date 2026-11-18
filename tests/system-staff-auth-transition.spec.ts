import assert from 'node:assert';
import { ForbiddenException, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import {
  resolveAuthority,
  getRoleCapabilities,
  isTokenInvalidatedByTimestamps,
} from '../src/auth/authority.policy';
import { AuthService } from '../src/auth/auth.service';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { AdminService } from '../src/admin/admin.service';
import { AdminRepository } from '../src/admin/admin.repository';
import { StoreStaffService } from '../src/store-staff/store-staff.service';
import { StoreStaffRepository } from '../src/store-staff/store-staff.repository';
import { EventsGateway, WsRevocationPubSubTransport } from '../src/websocket/events.gateway';
import * as jwt from 'jsonwebtoken';

async function run() {
  console.log('🧪 Running System Staff Transition Steps 1-3 Verification Suite...');
  let passed = 0;

  // 1. Authority Policy Matrix & Capabilities
  {
    const staffCaps = getRoleCapabilities('SYSTEM_STAFF');
    assert.strictEqual(staffCaps.managePlatformDevices, true);
    assert.strictEqual(staffCaps.manageWarrantyTickets, true);
    assert.strictEqual(staffCaps.approveFinancialRefunds, false);
    assert.strictEqual(staffCaps.managePayoutsAndWithdrawals, false);
    assert.strictEqual(staffCaps.manageUsersAndRoles, false);
    assert.strictEqual(staffCaps.manageOwnStoreSalesAndDelivery, false);
    assert.strictEqual(staffCaps.manageOwnStoreWallet, false);

    const ownerCaps = getRoleCapabilities('STORE_OWNER');
    assert.strictEqual(ownerCaps.manageOwnStoreSalesAndDelivery, true);
    assert.strictEqual(ownerCaps.manageOwnStoreWallet, true);
    assert.strictEqual(ownerCaps.managePlatformDevices, false);
    assert.strictEqual(ownerCaps.approveFinancialRefunds, false);

    const adminCaps = getRoleCapabilities('ADMIN');
    assert.strictEqual(adminCaps.approveFinancialRefunds, true);
    assert.strictEqual(adminCaps.managePayoutsAndWithdrawals, false);

    const superCaps = getRoleCapabilities('SUPER_ADMIN');
    assert.strictEqual(superCaps.managePayoutsAndWithdrawals, true);
    assert.strictEqual(superCaps.manageUsersAndRoles, true);
    passed++;
    console.log('  ✔ [PASS] Role capability matrix enforces strict privilege separation');
  }

  // 2. Authority Resolution: platform_memberships, ownedStores, legacy admin compat & deprecated store roles
  {
    const sysStaffUser = {
      userId: BigInt(10),
      email: 'tech@smartorder.local',
      username: 'sys_tech',
      platformMemberships: [{ status: 'ACTIVE', role: { roleCode: 'SYSTEM_STAFF' } }],
      ownedStores: [{ storeId: BigInt(77), status: 'ACTIVE' }], // Even if present, platform role never leaks storeId
      storeStaffs: [{ status: 'ACTIVE', storeId: BigInt(77), role: { roleCode: 'STAFF_ORDER' } }],
    };
    const rStaff = resolveAuthority(sysStaffUser);
    assert.strictEqual(rStaff.role, 'SYSTEM_STAFF');
    assert.strictEqual(rStaff.storeId, null);
    assert.strictEqual(rStaff.platformRole, 'SYSTEM_STAFF');

    // Legacy store staff and store shipper roles in store_staff must NOT grant authority anymore
    for (const legacyRole of ['STORE_MANAGER', 'STORE_STAFF', 'STAFF_ORDER', 'STAFF_INVENTORY', 'STAFF_BUTTON', 'STAFF_DELIVERY', 'DRIVER']) {
      const legacyUser = {
        userId: BigInt(20),
        email: `${legacyRole.toLowerCase()}@store.local`,
        username: legacyRole.toLowerCase(),
        platformMemberships: [],
        ownedStores: [],
        storeStaffs: [{ status: 'ACTIVE', storeId: BigInt(5), role: { roleCode: legacyRole } }],
      };
      const rLegacy = resolveAuthority(legacyUser);
      assert.strictEqual(rLegacy.role, 'CUSTOMER', `Deprecated ${legacyRole} should resolve to CUSTOMER, got ${rLegacy.role}`);
      assert.strictEqual(rLegacy.storeId, null);
    }

    // Store Owner without platform role resolves cleanly to STORE_OWNER with storeId
    const ownerUser = {
      userId: BigInt(30),
      email: 'owner@store.local',
      username: 'owner30',
      platformMemberships: [],
      ownedStores: [{ storeId: BigInt(55), status: 'ACTIVE' }],
      storeStaffs: [],
    };
    const rOwner = resolveAuthority(ownerUser);
    assert.strictEqual(rOwner.role, 'STORE_OWNER');
    assert.strictEqual(rOwner.storeId, '55');
    passed++;
    console.log('  ✔ [PASS] Authority resolver supports SYSTEM_STAFF, drops store staff/shipper authority, isolates storeId');
  }

  // 3. Timestamp boundary validation (<= boundary parity)
  {
    const tSec = 1700000000;
    assert.strictEqual(isTokenInvalidatedByTimestamps(tSec, new Date(tSec * 1000)), true);
    assert.strictEqual(isTokenInvalidatedByTimestamps(tSec - 1, new Date(tSec * 1000)), true);
    assert.strictEqual(isTokenInvalidatedByTimestamps(tSec + 1, new Date(tSec * 1000)), false);
    passed++;
    console.log('  ✔ [PASS] Token revocation timestamp cutoff uses consistent <= comparison');
  }

  // 4. AuthService: register restricts roles, refresh rejects tokens created before tokensInvalidBefore
  {
    const mockAuthRepo: any = {
      findById: async () => ({
        userId: BigInt(10),
        status: 'ACTIVE',
        tokensInvalidBefore: new Date(2000000 * 1000),
        passwordChangedAt: null,
      }),
      findRefreshToken: async () => ({
        userId: BigInt(10),
        isRevoked: false,
        expiresAt: new Date(Date.now() + 60000),
        createdAt: new Date(1999999 * 1000),
      }),
    };
    const authService = new AuthService({} as any, mockAuthRepo, {} as any, {} as any);

    await assert.rejects(
      () =>
        authService.register({
          email: 'hacker@test.local',
          username: 'hacker1',
          password: 'Password123!',
          fullName: 'Hacker',
          role: 'SYSTEM_STAFF',
        } as any),
      (err: any) => err instanceof ForbiddenException,
    );

    await assert.rejects(
      () => authService.refresh('some-valid-refresh-token'),
      (err: any) => err instanceof UnauthorizedException,
    );
    passed++;
    console.log('  ✔ [PASS] Public registration blocks non-customer/store roles & refresh respects tokensInvalidBefore');
  }

  // 5. JwtStrategy: checks tokensInvalidBefore and resolves SYSTEM_STAFF with storeId = null
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const mockPrisma: any = {
      revokedToken: { findUnique: async () => null },
      user: {
        findUnique: async () => ({
          userId: BigInt(42),
          email: 'staff42@smartorder.local',
          username: 'staff42',
          fullName: 'Staff 42',
          status: 'ACTIVE',
          passwordChangedAt: null,
          tokensInvalidBefore: new Date((nowSec - 10) * 1000),
          customerProfile: null,
          ownedStores: [],
          storeStaffs: [],
          platformMemberships: [{ status: 'ACTIVE', role: { roleCode: 'SYSTEM_STAFF' } }],
        }),
      },
    };
    const strategy = new JwtStrategy(mockPrisma);

    // Token issued BEFORE tokensInvalidBefore must be rejected
    await assert.rejects(
      () => strategy.validate({ headers: {} }, { userId: '42', iat: nowSec - 10 }),
      (err: any) => err instanceof UnauthorizedException,
    );

    // Token issued AFTER tokensInvalidBefore resolves SYSTEM_STAFF cleanly
    const validated = await strategy.validate({ headers: {} }, { userId: '42', iat: nowSec, role: 'CUSTOMER' });
    assert.strictEqual(validated.role, 'SYSTEM_STAFF');
    assert.strictEqual(validated.storeId, null);
    assert.strictEqual(validated.capabilities.managePlatformDevices, true);
    assert.strictEqual(validated.capabilities.manageUsersAndRoles, false);
    passed++;
    console.log('  ✔ [PASS] JwtStrategy enforces tokensInvalidBefore & resolves SYSTEM_STAFF with capabilities');
  }

  // 6. AdminService: grantPlatformRole, revokePlatformRole, WS disconnect, Store Owner conflict & legacy role rejection
  {
    const disconnected: string[] = [];
    const mockGateway: any = {
      disconnectUserSockets: (uid: string) => disconnected.push(uid),
    };
    const mockAdminRepo: any = {
      findUserById: async (id: bigint) => ({ userId: id, status: 'ACTIVE' }),
      grantPlatformMembershipTx: async ({ userId, roleCode }: any) => {
        if (userId === BigInt(999)) {
          throw new ConflictException({ code: 'ROLE_CONFLICT_STORE_OWNER', message: 'Store owner conflict' });
        }
        return {
          membershipId: BigInt(1),
          userId,
          role: { roleCode },
          status: 'ACTIVE',
          grantedAt: new Date(),
          reason: 'Granted in test',
        };
      },
      revokePlatformMembershipTx: async () => ({ revokedCount: 1 }),
    };

    const adminService = new AdminService(mockAdminRepo, undefined, undefined, mockGateway);

    // Grant SYSTEM_STAFF succeeds & disconnects active sockets
    const granted = await adminService.grantPlatformRole('42', 'SYSTEM_STAFF', { userId: '1' }, 'Tech onboarding');
    assert.strictEqual(granted.roleCode, 'SYSTEM_STAFF');
    assert.deepStrictEqual(disconnected, ['42']);

    // Conflict when granting SYSTEM_STAFF to Store Owner
    await assert.rejects(
      () => adminService.grantPlatformRole('999', 'SYSTEM_STAFF', { userId: '1' }),
      (err: any) => err instanceof ConflictException,
    );

    // Revoke disconnects active sockets again
    const revoked = await adminService.revokePlatformRole('42', { userId: '1' }, 'Offboarding');
    assert.strictEqual(revoked.newEffectiveRole, 'CUSTOMER');
    assert.deepStrictEqual(disconnected, ['42', '42']);

    // Deprecated store staff role rejected cleanly on updateUserRole
    await assert.rejects(
      () => adminService.updateUserRole('42', 'STAFF_DELIVERY', { userId: '1' }),
      (err: any) => err instanceof BadRequestException,
    );
    passed++;
    console.log('  ✔ [PASS] AdminService platform membership grant/revoke, WS kick, conflict guard & deprecated role rejection');
  }

  // 7. StoreStaffService: adding or accepting store staff / shipper invites returns STORE_STAFF_ROLE_DEPRECATED
  {
    const storeStaffService = new StoreStaffService({} as any);
    assert.deepStrictEqual(await storeStaffService.listAssignableRoles(), []);
    await assert.rejects(
      () => storeStaffService.addStaff('1', { userId: '2', roleCode: 'STAFF_ORDER' } as any, { userId: '10', role: 'STORE_OWNER' }),
      (err: any) => err instanceof ForbiddenException,
    );
    await assert.rejects(
      () => storeStaffService.acceptInvitation('5', { userId: '2' }),
      (err: any) => err instanceof ForbiddenException,
    );
    passed++;
    console.log('  ✔ [PASS] StoreStaffService blocks new store staff & shipper assignments/acceptances');
  }

  // 8. WebSocket EventsGateway: separates SYSTEM_STAFF rooms from admin & disconnects revoked tokens
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const secret = process.env.JWT_SECRET || 'ci_test_jwt_secret_key_minimum_32_characters_long_for_security!';
    const validToken = jwt.sign({ userId: '50', role: 'CUSTOMER', iat: nowSec }, secret, { expiresIn: '15m' });
    const mockWsPrisma: any = {
      revokedToken: { findUnique: async () => null },
      user: {
        findUnique: async () => ({
          userId: BigInt(50),
          email: 'wsstaff@smartorder.local',
          username: 'wsstaff',
          status: 'ACTIVE',
          passwordChangedAt: null,
          tokensInvalidBefore: null,
          customerProfile: null,
          ownedStores: [],
          storeStaffs: [],
          platformMemberships: [{ status: 'ACTIVE', role: { roleCode: 'SYSTEM_STAFF' } }],
        }),
      },
    };
    const gw = new EventsGateway(mockWsPrisma);
    const joined: string[] = [];
    let wasDisconnected = false;
    const mockClient: any = {
      id: 'sock-test-1',
      handshake: { headers: {}, auth: { token: validToken } },
      data: {},
      join: (room: string) => joined.push(room),
      emit: () => {},
      disconnect: () => {
        wasDisconnected = true;
      },
    };
    await gw.handleConnection(mockClient);
    assert.strictEqual(wasDisconnected, false);
    assert.strictEqual(mockClient.data.user.role, 'SYSTEM_STAFF');
    assert.ok(joined.includes('system_staff'));
    assert.ok(joined.includes('devices:ops'));
    assert.ok(!joined.includes('admin'), 'SYSTEM_STAFF must NEVER join admin room');
    if (mockClient.data?.disconnectTimer) clearTimeout(mockClient.data.disconnectTimer);
    passed++;
    console.log('  ✔ [PASS] EventsGateway resolves DB authority and places SYSTEM_STAFF in isolated hardware rooms');
  }

  // 9. Point 1 Regression: Locking user account revokes refresh tokens & updates tokensInvalidBefore in TX (survives unlock)
  {
    const userState = {
      userId: BigInt(90),
      username: 'lockeduser',
      email: 'locked@smartorder.local',
      fullName: 'Locked User',
      phone: '0900000090',
      status: 'ACTIVE',
      passwordChangedAt: null as Date | null,
      tokensInvalidBefore: null as Date | null,
      customerProfile: null,
      ownedStores: [],
      platformMemberships: [],
      storeStaffs: [],
    };
    let activeRefreshTokensCount = 2;
    const mockTxPrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $queryRaw: async () => [{ user_id: userState.userId }],
          user: {
            update: async ({ data }: any) => {
              if (data.status !== undefined) userState.status = data.status;
              if (data.tokensInvalidBefore !== undefined) userState.tokensInvalidBefore = data.tokensInvalidBefore;
              return { ...userState };
            },
          },
          refreshToken: {
            updateMany: async ({ data }: any) => {
              if (data.isRevoked) activeRefreshTokensCount = 0;
              return { count: 2 };
            },
          },
        }),
    };
    const adminRepo = new AdminRepository(mockTxPrisma);
    const adminSvc = new AdminService(adminRepo as any);
    // Provide findUserById for toggleUserStatus lookup
    (adminRepo as any).findUserById = async () => ({ ...userState });

    const preLockIat = Math.floor(Date.now() / 1000) - 5;
    await adminSvc.toggleUserStatus('90', 'INACTIVE', { userId: '1' });
    assert.strictEqual(userState.status, 'INACTIVE');
    assert.ok(userState.tokensInvalidBefore instanceof Date, 'Locking must set tokensInvalidBefore');
    assert.strictEqual(activeRefreshTokensCount, 0, 'Locking must revoke active refresh tokens');

    // Unlock user back to ACTIVE; pre-lock token MUST STILL FAIL validation
    await adminSvc.toggleUserStatus('90', 'ACTIVE', { userId: '1' });
    assert.strictEqual(userState.status, 'ACTIVE');
    assert.ok(userState.tokensInvalidBefore instanceof Date, 'Unlocking must NOT wipe tokensInvalidBefore');

    const strategy = new JwtStrategy({
      revokedToken: { findUnique: async () => null },
      user: { findUnique: async () => ({ ...userState }) },
    } as any);
    await assert.rejects(
      () => strategy.validate({ headers: {} }, { userId: '90', role: 'CUSTOMER', iat: preLockIat } as any),
      (err: any) => err instanceof UnauthorizedException,
    );
    passed++;
    console.log('  ✔ [PASS] Account lock sets tokensInvalidBefore + revokes refresh tokens; pre-lock JWT stays rejected after unlock');
  }

  // 10. Point 2 Regression: Cross-node WS revocation (Node A -> Node B) + open-socket DB watermark sweep
  {
    const secret = process.env.JWT_SECRET || 'ci_test_jwt_secret_key_minimum_32_characters_long_for_security!';
    const listeners = new Map<string, Array<(msg: string) => void>>();
    const createBrokerTransport = (): WsRevocationPubSubTransport => ({
      publish: (channel, payload) => {
        for (const fn of listeners.get(channel) || []) {
          fn(payload);
        }
      },
      subscribe: (channel, onMessage) => {
        const list = listeners.get(channel) || [];
        list.push(onMessage);
        listeners.set(channel, list);
      },
    });

    const nodeAPrisma: any = {
      revokedToken: { findUnique: async () => null },
      user: { findUnique: async () => null },
    };
    const nowSec = Math.floor(Date.now() / 1000);
    let nodeBUserInvalidBefore: Date | null = null;
    const nodeBPrisma: any = {
      revokedToken: { findUnique: async () => null },
      user: {
        findUnique: async () => ({
          userId: BigInt(55),
          email: 'ws55@smartorder.local',
          username: 'ws55',
          status: 'ACTIVE',
          passwordChangedAt: null,
          tokensInvalidBefore: nodeBUserInvalidBefore,
          customerProfile: null,
          ownedStores: [],
          storeStaffs: [],
          platformMemberships: [{ status: 'ACTIVE', role: { roleCode: 'SYSTEM_STAFF' } }],
        }),
        findMany: async () => [
          {
            userId: BigInt(55),
            status: 'ACTIVE',
            passwordChangedAt: null,
            tokensInvalidBefore: nodeBUserInvalidBefore,
          },
        ],
      },
    };

    const gwNodeA = new EventsGateway(nodeAPrisma);
    const gwNodeB = new EventsGateway(nodeBPrisma);
    await gwNodeA.attachPubSubTransport(createBrokerTransport());
    await gwNodeB.attachPubSubTransport(createBrokerTransport());

    const token55 = jwt.sign({ userId: '55', role: 'SYSTEM_STAFF', iat: nowSec }, secret, { expiresIn: '15m' });
    const eventsOnNodeB: string[] = [];
    let sockBDisconnected = false;
    const sockB: any = {
      id: 'sock-node-b-55',
      handshake: { headers: {}, auth: { token: token55 } },
      data: {},
      join: () => {},
      emit: (evt: string) => eventsOnNodeB.push(evt),
      disconnect: () => {
        sockBDisconnected = true;
      },
    };

    await gwNodeB.handleConnection(sockB);
    assert.strictEqual(sockBDisconnected, false);

    // Trigger revocation on Node A -> must broadcast and disconnect sockB on Node B
    await gwNodeA.disconnectUserSockets('55', 'Cross-node revocation');
    assert.strictEqual(sockBDisconnected, true, 'Socket open on Node B must disconnect when Node A revokes user');
    assert.ok(eventsOnNodeB.includes('auth:revoked'), 'Socket on Node B must receive auth:revoked event');
    if (sockB.data?.disconnectTimer) clearTimeout(sockB.data.disconnectTimer);

    // Also test DB watermark sweep for long-lived open sockets
    const eventsSweep: string[] = [];
    let sweepDisconnected = false;
    const sockSweep: any = {
      id: 'sock-sweep-55',
      handshake: { headers: {}, auth: { token: token55 } },
      data: {},
      join: () => {},
      emit: (evt: string) => eventsSweep.push(evt),
      disconnect: () => {
        sweepDisconnected = true;
      },
    };
    await gwNodeB.handleConnection(sockSweep);
    assert.strictEqual(sweepDisconnected, false);
    nodeBUserInvalidBefore = new Date((nowSec + 10) * 1000);
    const kickedCount = await gwNodeB.enforceActiveSocketsWatermark();
    assert.strictEqual(kickedCount, 1);
    assert.strictEqual(sweepDisconnected, true);
    assert.ok(eventsSweep.includes('auth:revoked'));
    if (sockSweep.data?.disconnectTimer) clearTimeout(sockSweep.data.disconnectTimer);
    await gwNodeA.onModuleDestroy();
    await gwNodeB.onModuleDestroy();
    passed++;
    console.log('  ✔ [PASS] Cross-node WS pub/sub disconnects Node B socket from Node A & enforces DB watermark on open sockets');
  }

  // 11. Point 3 Regression: revokePlatformRole re-resolves real authority (STORE_OWNER / CUSTOMER) & blocks bootstrap SUPER_ADMIN
  {
    const snapshots = new Map<string, any>([
      [
        '1',
        {
          userId: BigInt(1),
          email: 'admin@smartorder.local',
          username: 'admin',
          status: 'ACTIVE',
          ownedStores: [],
          platformMemberships: [],
          storeStaffs: [],
        },
      ],
      [
        '20',
        {
          userId: BigInt(20),
          email: 'owner20@smartorder.local',
          username: 'owner20',
          status: 'ACTIVE',
          ownedStores: [{ storeId: BigInt(77), status: 'ACTIVE' }],
          platformMemberships: [{ status: 'ACTIVE', role: { roleCode: 'ADMIN' } }],
          storeStaffs: [],
        },
      ],
      [
        '21',
        {
          userId: BigInt(21),
          email: 'plain21@smartorder.local',
          username: 'plain21',
          status: 'ACTIVE',
          ownedStores: [],
          platformMemberships: [{ status: 'ACTIVE', role: { roleCode: 'SYSTEM_STAFF' } }],
          storeStaffs: [],
        },
      ],
    ]);

    const adminSvc = new AdminService({
      findUserAuthoritySnapshot: async (id: bigint) => snapshots.get(id.toString()) || null,
      revokePlatformMembershipTx: async ({ userId }: any) => {
        const snap = snapshots.get(userId.toString());
        if (snap) snap.platformMemberships = [];
        return { revokedCount: 1 };
      },
      grantPlatformMembershipTx: async () => ({
        membershipId: BigInt(1),
        userId: BigInt(1),
        status: 'ACTIVE',
        grantedAt: new Date(),
        role: { roleCode: 'SYSTEM_STAFF' },
      }),
    } as any);

    await assert.rejects(
      () => adminSvc.revokePlatformRole('1', { userId: '999' }),
      (err: any) => err instanceof ForbiddenException && (err.getResponse() as any)?.code === 'BOOTSTRAP_SUPER_ADMIN_PROTECTED',
    );
    await assert.rejects(
      () => adminSvc.grantPlatformRole('1', 'SYSTEM_STAFF', { userId: '999' }),
      (err: any) => err instanceof ForbiddenException && (err.getResponse() as any)?.code === 'BOOTSTRAP_SUPER_ADMIN_PROTECTED',
    );

    const ownerRevoke = await adminSvc.revokePlatformRole('20', { userId: '1' });
    assert.strictEqual(ownerRevoke.newEffectiveRole, 'STORE_OWNER');
    assert.strictEqual(ownerRevoke.storeId, '77');

    const plainRevoke = await adminSvc.revokePlatformRole('21', { userId: '1' });
    assert.strictEqual(plainRevoke.newEffectiveRole, 'CUSTOMER');
    assert.strictEqual(plainRevoke.storeId, null);
    passed++;
    console.log('  ✔ [PASS] revokePlatformRole protects bootstrap SUPER_ADMIN & reports real re-resolved authority (STORE_OWNER/CUSTOMER)');
  }

  // 12. Point 4 Regression: StoreStaffService/Repository.deleteStaff preserves history as TERMINATED + audit log (no physical delete)
  {
    const staffRow = {
      storeStaffId: BigInt(901),
      storeId: BigInt(40),
      userId: BigInt(300),
      roleId: BigInt(4),
      status: 'ACTIVE',
      joinedAt: new Date(Date.now() - 86400000),
      leftAt: null as Date | null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { userId: BigInt(300), fullName: 'Legacy Staff', username: 'legacystaff', email: 'legacy@test.local', phone: '0901234567', avatarUrl: null },
      role: { roleId: BigInt(4), roleCode: 'STAFF_ORDER', roleName: 'Staff Order', description: null },
      store: { storeId: BigInt(40), ownerUserId: BigInt(10) },
    };
    let physicalDeleteCalled = false;
    let auditCreated: any = null;
    let revokedTokensForStaff = false;
    let staffWatermarkUpdated = false;

    const mockStaffPrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $queryRaw: async () => [{ user_id: BigInt(300), tokens_invalid_before: null }],
          storeStaff: {
            findUnique: async () => ({ ...staffRow }),
            update: async ({ data }: any) => {
              staffRow.status = data.status;
              staffRow.leftAt = data.leftAt;
              return { ...staffRow };
            },
            delete: async () => {
              physicalDeleteCalled = true;
              throw new Error('PHYSICAL_DELETE_FORBIDDEN');
            },
          },
          rentalAuditLog: {
            create: async ({ data }: any) => {
              auditCreated = data;
              return data;
            },
          },
          refreshToken: {
            updateMany: async () => {
              revokedTokensForStaff = true;
              return { count: 1 };
            },
          },
          user: {
            update: async () => {
              staffWatermarkUpdated = true;
              return {};
            },
          },
        }),
      storeStaff: {
        findUnique: async () => ({ ...staffRow }),
        delete: async () => {
          physicalDeleteCalled = true;
          throw new Error('PHYSICAL_DELETE_FORBIDDEN');
        },
      },
      store: {
        findUnique: async () => ({ storeId: BigInt(40), ownerUserId: BigInt(10) }),
      },
    };

    const staffRepo = new StoreStaffRepository(mockStaffPrisma);
    const staffSvc = new StoreStaffService(staffRepo);
    const termRes = await staffSvc.deleteStaff('901', { userId: '10', role: 'STORE_OWNER' });

    assert.strictEqual(physicalDeleteCalled, false, 'deleteStaff must NOT physically delete store_staff row');
    assert.strictEqual(staffRow.status, 'TERMINATED');
    assert.ok(staffRow.leftAt instanceof Date);
    assert.strictEqual(termRes.success, true);
    assert.strictEqual(termRes.data?.status, 'TERMINATED');
    assert.ok(auditCreated && auditCreated.action === 'TERMINATE_STORE_STAFF' && auditCreated.actorUserId === BigInt(10));
    assert.strictEqual(revokedTokensForStaff, true);
    assert.strictEqual(staffWatermarkUpdated, true);
    passed++;
    console.log('  ✔ [PASS] StoreStaff deleteStaff soft-terminates to TERMINATED with leftAt & audit log (zero physical delete)');
  }

  // 13. Concurrent Watermark Monotonicity + Canonical Lock Order (users -> membership)
  {
    const operations: string[] = [];
    let userRowLock: Promise<void> = Promise.resolve();
    const t1 = new Date(Date.now() - 60_000); // older start timestamp T1
    let dbWatermark: Date | null = null;
    let dbStatus = 'ACTIVE';
    const staffRecord: any = {
      storeStaffId: BigInt(902),
      storeId: BigInt(41),
      userId: BigInt(301),
      roleId: BigInt(4),
      status: 'ACTIVE',
      joinedAt: new Date(Date.now() - 120_000),
      leftAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { userId: BigInt(301), fullName: 'Race Staff', username: 'racestaff', email: 'race@test.local', phone: '0901112223', avatarUrl: null },
      role: { roleId: BigInt(4), roleCode: 'STAFF_ORDER', roleName: 'Staff Order', description: null },
    };

    const makeConcurrentTx = () => {
      let releaseLock: (() => void) | null = null;
      return async (cb: any) => {
        const tx = {
          $queryRaw: async () => {
            const prev = userRowLock;
            userRowLock = new Promise<void>((res) => {
              releaseLock = res;
            });
            await prev;
            operations.push('lock:users_for_update');
            return [{ user_id: BigInt(301), tokens_invalid_before: dbWatermark }];
          },
          $executeRaw: async (...args: any[]) => {
            // Simulate PostgreSQL GREATEST(COALESCE(tokens_invalid_before, to_timestamp(0)), candidate)
            const candidate = args.find((a) => a instanceof Date) as Date | undefined;
            if (candidate) {
              dbWatermark =
                dbWatermark && dbWatermark.getTime() > candidate.getTime() ? dbWatermark : candidate;
            }
            return 1;
          },
          storeStaff: {
            findUnique: async () => ({ ...staffRecord }),
            update: async ({ data }: any) => {
              operations.push('write:store_staff');
              staffRecord.status = data.status;
              staffRecord.leftAt = data.leftAt;
              return { ...staffRecord };
            },
          },
          rentalAuditLog: { create: async ({ data }: any) => data },
          refreshToken: { updateMany: async () => ({ count: 1 }) },
          user: {
            update: async ({ data }: any) => {
              if (data.status !== undefined) dbStatus = data.status;
              if (data.tokensInvalidBefore !== undefined) {
                const candidate: Date = data.tokensInvalidBefore;
                dbWatermark =
                  dbWatermark && dbWatermark.getTime() > candidate.getTime() ? dbWatermark : candidate;
              }
              return { userId: BigInt(301), status: dbStatus };
            },
          },
        };
        try {
          return await cb(tx);
        } finally {
          releaseLock?.();
        }
      };
    };

    const sharedPrisma: any = {
      $transaction: makeConcurrentTx(),
      storeStaff: {
        findUnique: async () => ({ storeStaffId: BigInt(902), userId: BigInt(301) }),
      },
    };
    const staffRepoRace = new StoreStaffRepository(sharedPrisma);
    const adminRepoRace = new AdminRepository(sharedPrisma);

    // Admin lock commits T2 first, then delayed deleteStaff carrying older T1 executes afterwards
    await adminRepoRace.updateUserStatus(BigInt(301), 'INACTIVE');
    const watermarkAfterLock = dbWatermark!;
    assert.ok(watermarkAfterLock.getTime() > t1.getTime());

    await staffRepoRace.deleteStaff(BigInt(902), BigInt(10), t1);
    assert.ok(
      dbWatermark!.getTime() >= watermarkAfterLock.getTime(),
      'Concurrent deleteStaff(T1) MUST NEVER regress tokensInvalidBefore backward from T2',
    );
    assert.strictEqual(
      operations.indexOf('lock:users_for_update') < operations.indexOf('write:store_staff'),
      true,
      'users row MUST be locked BEFORE store_staff updates',
    );

    // Unlock back to ACTIVE; a token issued between T1 and T2 remains rejected
    await adminRepoRace.updateUserStatus(BigInt(301), 'ACTIVE');
    const tokenBetweenT1AndT2 = Math.floor(watermarkAfterLock.getTime() / 1000) - 5;
    assert.strictEqual(
      isTokenInvalidatedByTimestamps(tokenBetweenT1AndT2, null, dbWatermark),
      true,
      'Token minted between T1 and T2 must still be rejected after unlock',
    );
    passed++;
    console.log('  ✔ [PASS] Concurrent deleteStaff(T1) vs lock(T2) respects users->membership lock order & monotonic watermark');
  }

  // 14. Fail-Closed WebSocket verifySocketNotRevoked when DB query throws
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const secret = process.env.JWT_SECRET || 'ci_test_jwt_secret_key_minimum_32_characters_long_for_security!';
    const adminToken = jwt.sign({ userId: '77', role: 'ADMIN', iat: nowSec }, secret, { expiresIn: '15m' });
    let shouldFailDb = false;
    const mockFailWsPrisma: any = {
      revokedToken: { findUnique: async () => null },
      user: {
        findUnique: async () => {
          if (shouldFailDb) {
            throw new Error('ECONNREFUSED bearer=leak_should_be_redacted');
          }
          return {
            userId: BigInt(77),
            email: 'admin77@smartorder.local',
            username: 'admin77',
            status: 'ACTIVE',
            passwordChangedAt: null,
            tokensInvalidBefore: null,
            customerProfile: null,
            ownedStores: [],
            storeStaffs: [],
            platformMemberships: [{ status: 'ACTIVE', role: { roleCode: 'ADMIN' } }],
          };
        },
      },
    };
    const gwFailClosed = new EventsGateway(mockFailWsPrisma);
    const joinedRooms: string[] = [];
    const emittedErrors: any[] = [];
    let sockDisconnected = false;
    const adminSock: any = {
      id: 'sock-admin-77',
      handshake: { headers: {}, auth: { token: adminToken } },
      data: {},
      join: (room: string) => joinedRooms.push(room),
      emit: (evt: string, payload: any) => emittedErrors.push({ evt, payload }),
      disconnect: () => {
        sockDisconnected = true;
      },
    };

    await gwFailClosed.handleConnection(adminSock);
    assert.strictEqual(sockDisconnected, false);
    joinedRooms.length = 0;

    // Now DB fails during subscribe:store -> MUST deny subscribe & disconnect fail-closed
    shouldFailDb = true;
    await gwFailClosed.handleSubscribeStore(adminSock, '99');
    assert.strictEqual(joinedRooms.length, 0, 'Socket MUST NOT join store room when DB session check fails');
    assert.strictEqual(sockDisconnected, true, 'Socket MUST disconnect fail-closed on session check failure');
    assert.ok(
      emittedErrors.some((e) => e.evt === 'error' && e.payload?.code === 'SESSION_VALIDATION_UNAVAILABLE'),
      'Client must receive SESSION_VALIDATION_UNAVAILABLE retryable error',
    );
    if (adminSock.data?.disconnectTimer) clearTimeout(adminSock.data.disconnectTimer);
    await gwFailClosed.onModuleDestroy();
    passed++;
    console.log('  ✔ [PASS] WebSocket subscribe fails closed & disconnects when DB revocation check throws');
  }

  console.log(`\n🎉 ALL ${passed}/14 VERIFICATION GROUPS PASSED!\n`);
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
