/**
 * Step 7 Full Rehearsal + Bug Regressions + Live PostgreSQL Concurrency & Two-Node Redis WS Verification
 *
 * Covers:
 *   - Group 1: Consistent REPEATABLE READ READ ONLY dry-run snapshot & precondition enforcement on `smart_order_test`
 *   - Group 1B: Mocked-DB with simulated `uq_platform_memberships_active_user` unique constraint reproducing:
 *       1) Dual legacy ADMIN + SYSTEM_ADMIN & existing lower active membership upgrade (no P2002)
 *       2) Cross-DB / batchId / row-identity (`userId`, `storeId`, `roleCode`) rejection on rollback dry-run & execute
 *       3) Post-cutover drift detection (`ROLLBACK_DRIFT_CONFLICT`) on BOTH rollback dry-run & execute CAS
 *       4) Durable in-transaction batch persistence & `exportStep7BatchRollback` recovery without disk JSON
 *   - Group 2: Live Step 7 rehearsal on `smart_order_test` + compiled Nest HTTP/WS (`dist/src/main.js`):
 *       execute -> idempotency -> dry-run diff -> durable batch export -> HTTP RBAC ->
 *       ALREADY-OPEN persistent Socket.io session disconnected immediately on revocation ->
 *       rollback dry-run + drift guard + atomic CAS rollback
 *   - Group 3: Real PostgreSQL concurrent contention (`Promise.all` on `smart_order_test`):
 *       approveSwap race, lock vs swap race, shift `HANDED_OVER` terminal lock, monotonic `tokens_invalid_before`
 *   - Group 4: Two REAL compiled `dist/src/main.js` HTTP+WS servers over real Redis Pub/Sub (`REDIS_URL`),
 *       holding an active persistent Socket.io connection on Node B while Node A revokes authority
 */
import 'dotenv/config';
import * as assert from 'assert';
import * as crypto from 'crypto';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as jwt from 'jsonwebtoken';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { WarrantyRepository } from '../src/warranty/warranty.repository';
import { DriverShiftsService } from '../src/driver-shifts/driver-shifts.service';
import { StoreStaffRepository } from '../src/store-staff/store-staff.repository';
import { AdminRepository } from '../src/admin/admin.repository';
import {
  diffStep7Snapshots,
  runStep7InventoryReport,
} from '../scripts/step7-role-transition-dry-run';
import {
  executeStep7Transition,
  exportStep7BatchRollback,
  rollbackStep7Transition,
  Step7TransitionManifest,
} from '../scripts/step7-role-transition-execute';

function getTestJwtSecret(): string {
  return (
    process.env.JWT_SECRET ||
    'ci_test_jwt_secret_key_minimum_32_characters_long_for_security!'
  );
}

function signAccessToken(userId: bigint, role: string, iatSec: number, storeId?: bigint | null): string {
  return jwt.sign(
    {
      sub: userId.toString(),
      userId: userId.toString(),
      role,
      storeId: storeId ? storeId.toString() : null,
      iat: iatSec,
      exp: iatSec + 3600,
    },
    getTestJwtSecret(),
  );
}

interface PersistentWsSession {
  sid: string;
  waitForRevocationOrDisconnect: (timeoutMs?: number) => Promise<{ disconnected: boolean; authRevoked: boolean; raw: string }>;
  close: () => Promise<void>;
}

/**
 * Opens and KEEPS OPEN a real full-duplex WebSocket (`ws://.../socket.io/?EIO=4&transport=websocket`)
 * against a live Nest `@WebSocketGateway` (`EventsGateway`). Keeps the connection open across
 * HTTP revocation and captures real-time `auth:revoked` + Socket.IO `41` / TCP close frames.
 */
async function openPersistentSocketIoSession(
  baseHttpUrl: string,
  token: string,
  options?: { settleMs?: number; connectTimeoutMs?: number },
): Promise<{ accepted: boolean; session: PersistentWsSession | null; raw: string }> {
  const WsClient = require('ws');
  const wsUrl = baseHttpUrl.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
  const settleMs = options?.settleMs ?? 1000;
  const connectTimeoutMs = options?.connectTimeoutMs ?? 5000;

  return new Promise((resolve) => {
    const ws = new WsClient(wsUrl);
    let settled = false;
    let sid = '';
    let captured = '';
    let closed = false;
    let authRevoked = false;
    const waiters = new Set<() => void>();

    const notify = () => {
      for (const w of waiters) w();
    };

    const failConnect = () => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch { }
        resolve({ accepted: false, session: null, raw: captured });
      }
    };

    const connectTimer = setTimeout(failConnect, connectTimeoutMs);

    ws.on('message', (data: Buffer | string) => {
      const msg = data.toString();
      captured += msg + '\n';

      if (msg === '2') {
        if (ws.readyState === WsClient.OPEN) ws.send('3');
        return;
      }
      if (msg.startsWith('0{')) {
        try {
          sid = JSON.parse(msg.slice(1)).sid || '';
        } catch { }
        ws.send(`40${JSON.stringify({ token })}`);
        return;
      }
      if (msg.startsWith('42') && msg.includes('auth:revoked')) {
        authRevoked = true;
        notify();
      }
      if (msg.startsWith('41') || msg.startsWith('44')) {
        closed = true;
        notify();
        if (!settled) {
          clearTimeout(connectTimer);
          settled = true;
          try {
            ws.close();
          } catch { }
          resolve({ accepted: false, session: null, raw: captured });
        }
        return;
      }
      if (msg.startsWith('40{')) {
        try {
          const connectPayload = JSON.parse(msg.slice(2));
          if (connectPayload?.sid) sid = connectPayload.sid;
        } catch { }
        // Wait for async Neon Postgres handleConnection check (~200-500ms RTT) before declaring connection accepted
        setTimeout(() => {
          if (settled) return;
          clearTimeout(connectTimer);
          if (closed || authRevoked) {
            try {
              ws.close();
            } catch { }
            settled = true;
            resolve({ accepted: false, session: null, raw: captured });
            return;
          }
          settled = true;
          const session: PersistentWsSession = {
            sid,
            waitForRevocationOrDisconnect: async (timeoutMs = 5000) => {
              if (closed) return { disconnected: true, authRevoked, raw: captured };
              return new Promise((done) => {
                const onStateChange = () => {
                  if (closed) {
                    clearTimeout(timer);
                    waiters.delete(onStateChange);
                    done({ disconnected: true, authRevoked, raw: captured });
                  }
                };
                const timer = setTimeout(() => {
                  waiters.delete(onStateChange);
                  done({ disconnected: closed, authRevoked, raw: captured });
                }, timeoutMs);
                waiters.add(onStateChange);
              });
            },
            close: async () => {
              try {
                if (ws.readyState === WsClient.OPEN) ws.close();
              } catch { }
            },
          };
          resolve({ accepted: true, session, raw: captured });
        }, settleMs);
      }
    });

    ws.on('close', () => {
      closed = true;
      notify();
      if (!settled) {
        clearTimeout(connectTimer);
        settled = true;
        resolve({ accepted: false, session: null, raw: captured });
      }
    });

    ws.on('error', () => {
      closed = true;
      failConnect();
    });
  });
}

async function httpJson(url: string, method: string, token: string, payload?: any) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch { }
  return { status: res.status, body };
}

async function spawnCompiledServer(port: string, extraEnv: Record<string, string>) {
  const mainJs = path.resolve(__dirname, '../dist/src/main.js');
  let logs = '';
  const proc = spawn(process.execPath, [mainJs], {
    env: {
      ...process.env,
      PORT: port,
      JWT_SECRET: getTestJwtSecret(),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d) => {
    logs += d.toString();
  });
  proc.stderr?.on('data', (d) => {
    logs += d.toString();
  });

  const baseOrigin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 180; i++) {
    if (proc.exitCode !== null) break;
    try {
      const r = await fetch(`${baseOrigin}/healthz`);
      if (r.ok) {
        return { proc, baseOrigin, apiBase: `${baseOrigin}/api/v1` };
      }
    } catch { }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!proc.killed) proc.kill('SIGKILL');
  throw new Error(`Compiled Nest server failed startup on ${baseOrigin} (exit=${proc.exitCode}):\n${logs.slice(-1200)}`);
}

/**
 * Group 1B helper: Builds an in-memory mocked Prisma mimicking PostgreSQL unique partial index
 * `uq_platform_memberships_active_user` (`platform_memberships(user_id) WHERE status = 'ACTIVE'`),
 * `role_transition_batches`, `store_staff`, `users`, and CAS `updateMany` to reproduce Bugs 1–4.
 */
function createMockStep7PrismaWithActiveUniqueConstraint(mockOptions?: {
  omitRoleTransitionBatchDelegate?: boolean;
  onBeforeLockUser?: (userId: bigint, state: { storeStaffs: Map<string, any>; users: Map<string, any>; platformMemberships: Map<string, any> }) => void;
}) {
  const nowBase = new Date('2026-11-18T01:00:00.000Z');
  const roles = new Map<string, { roleId: bigint; roleCode: string }>([
    ['SYSTEM_STAFF', { roleId: BigInt(10), roleCode: 'SYSTEM_STAFF' }],
    ['ADMIN', { roleId: BigInt(11), roleCode: 'ADMIN' }],
    ['SYSTEM_ADMIN', { roleId: BigInt(12), roleCode: 'SYSTEM_ADMIN' }],
    ['SUPER_ADMIN', { roleId: BigInt(13), roleCode: 'SUPER_ADMIN' }],
    ['STORE_STAFF', { roleId: BigInt(14), roleCode: 'STORE_STAFF' }],
  ]);
  const roleById = new Map([...roles.values()].map((r) => [r.roleId.toString(), r]));

  const users = new Map<string, any>([
    ['1', { userId: BigInt(1), email: 'super@smartorder.test', username: 'super_ops', status: 'ACTIVE', tokensInvalidBefore: null }],
    ['10', { userId: BigInt(10), email: 'dual_admin@smartorder.test', username: 'dual_admin', status: 'ACTIVE', tokensInvalidBefore: null }],
    ['11', { userId: BigInt(11), email: 'upgrade_admin@smartorder.test', username: 'upgrade_admin', status: 'ACTIVE', tokensInvalidBefore: null }],
    ['12', { userId: BigInt(12), email: 'tech@smartorder.test', username: 'tech_mock', status: 'ACTIVE', tokensInvalidBefore: null }],
  ]);

  const storeStaffs = new Map<string, any>([
    // User 10 has BOTH ADMIN and SYSTEM_ADMIN in store_staff!
    ['100', { storeStaffId: BigInt(100), storeId: BigInt(1), userId: BigInt(10), roleId: BigInt(11), status: 'ACTIVE', leftAt: null, updatedAt: new Date(nowBase) }],
    ['101', { storeStaffId: BigInt(101), storeId: BigInt(2), userId: BigInt(10), roleId: BigInt(12), status: 'ACTIVE', leftAt: null, updatedAt: new Date(nowBase) }],
    // User 11 already holds ACTIVE ADMIN in platform_memberships, and has higher SYSTEM_ADMIN in store_staff!
    ['102', { storeStaffId: BigInt(102), storeId: BigInt(1), userId: BigInt(11), roleId: BigInt(12), status: 'ACTIVE', leftAt: null, updatedAt: new Date(nowBase) }],
    // User 12 deprecated STORE_STAFF -> terminated
    ['103', { storeStaffId: BigInt(103), storeId: BigInt(1), userId: BigInt(12), roleId: BigInt(14), status: 'ACTIVE', leftAt: null, updatedAt: new Date(nowBase) }],
  ]);

  let nextPmId = 201;
  const platformMemberships = new Map<string, any>([
    [
      '200',
      {
        membershipId: BigInt(200),
        userId: BigInt(11),
        roleId: BigInt(11), // ADMIN currently ACTIVE for user 11
        status: 'ACTIVE',
        grantedByUserId: BigInt(1),
        grantedAt: new Date(nowBase),
        revokedAt: null,
        revokedByUserId: null,
        updatedAt: new Date(nowBase),
      },
    ],
  ]);

  const batches = new Map<string, any>();

  const enforceActiveUserUniqueIndex = (candidateUserId: bigint, excludeMembershipId?: bigint) => {
    for (const pm of platformMemberships.values()) {
      if (pm.userId === candidateUserId && pm.status === 'ACTIVE' && pm.membershipId !== excludeMembershipId) {
        const err: any = new Error('Unique constraint failed on uq_platform_memberships_active_user');
        err.code = 'P2002';
        throw err;
      }
    }
  };

  let txTick = 1;
  const makeTx = () => {
    const tx: any = {
      $executeRawUnsafe: async () => 1,
      $executeRaw: async () => 1,
      $queryRaw: async (strings: any, ...values: any[]) => {
        const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
        if (sql.includes('current_database()')) return [{ db_name: 'mock_step7_db_test' }];
        if (sql.includes('FROM users')) {
          const targetUid = values?.[0] != null ? BigInt(values[0]) : BigInt(1);
          mockOptions?.onBeforeLockUser?.(targetUid, { storeStaffs, users, platformMemberships });
          const u = users.get(targetUid.toString());
          return u ? [{ user_id: u.userId, tokens_invalid_before: u.tokensInvalidBefore }] : [];
        }
        if (sql.includes('FROM store ')) return [{ total: BigInt(1) }];
        if (sql.includes('FROM store_staff ss') && sql.includes("role_code IN ('ADMIN'")) {
          return [...storeStaffs.values()]
            .filter((s) => s.status === 'ACTIVE' && users.get(s.userId.toString())?.status === 'ACTIVE')
            .map((s) => ({ ...s, role: roleById.get(s.roleId.toString())! }))
            .filter((s) => ['ADMIN', 'SYSTEM_ADMIN', 'SUPER_ADMIN'].includes(s.role.roleCode))
            .map((s) => ({
              store_staff_id: s.storeStaffId,
              user_id: s.userId,
              store_id: s.storeId,
              role_id: s.roleId,
              role_code: s.role.roleCode,
            }));
        }
        if (sql.includes('FROM platform_memberships pm') && !sql.includes('GROUP BY')) {
          return [...platformMemberships.values()].map((pm) => ({
            membership_id: pm.membershipId,
            user_id: pm.userId,
            role_id: pm.roleId,
            role_code: roleById.get(pm.roleId.toString())!.roleCode,
            status: pm.status,
          }));
        }
        return [];
      },
      role: {
        findUnique: async ({ where }: any) => roles.get(where.roleCode) || null,
      },
      user: {
        findMany: async ({ where }: any) =>
          (where.userId?.in || [])
            .map((id: bigint) => {
              const u = users.get(id.toString());
              if (!u) return null;
              return {
                ...u,
                ownedStores: [],
                platformMemberships: [...platformMemberships.values()]
                  .filter((pm) => pm.userId === id && pm.status === 'ACTIVE')
                  .map((pm) => ({ ...pm, role: roleById.get(pm.roleId.toString()) })),
              };
            })
            .filter(Boolean),
      },
      storeStaff: {
        findMany: async ({ where }: any) => {
          let rows = [...storeStaffs.values()].map((s) => ({
            ...s,
            role: roleById.get(s.roleId.toString()),
            user: users.get(s.userId.toString()),
          }));
          if (where?.storeStaffId?.in) {
            const set = new Set(where.storeStaffId.in.map((x: bigint) => x.toString()));
            rows = rows.filter((r) => set.has(r.storeStaffId.toString()));
          }
          if (where?.status) rows = rows.filter((r) => r.status === where.status);
          if (where?.role?.roleCode?.in) rows = rows.filter((r) => where.role.roleCode.in.includes(r.role.roleCode));
          return rows;
        },
        findUnique: async ({ where }: any) => {
          const s = storeStaffs.get(where.storeStaffId.toString());
          return s ? { ...s, role: roleById.get(s.roleId.toString()) } : null;
        },
        update: async ({ where, data }: any) => {
          const cur = storeStaffs.get(where.storeStaffId.toString());
          const next = { ...cur, ...data, updatedAt: new Date(nowBase.getTime() + txTick++ * 1000) };
          storeStaffs.set(where.storeStaffId.toString(), next);
          return { ...next };
        },
        updateMany: async ({ where, data }: any) => {
          const cur = storeStaffs.get(where.storeStaffId.toString());
          if (
            !cur ||
            (where.userId !== undefined && cur.userId !== where.userId) ||
            (where.storeId !== undefined && cur.storeId !== where.storeId) ||
            (where.status !== undefined && cur.status !== where.status) ||
            (where.updatedAt !== undefined && cur.updatedAt.getTime() !== new Date(where.updatedAt).getTime())
          ) {
            return { count: 0 };
          }
          storeStaffs.set(cur.storeStaffId.toString(), {
            ...cur,
            ...data,
            updatedAt: new Date(nowBase.getTime() + txTick++ * 1000),
          });
          return { count: 1 };
        },
      },
      platformMembership: {
        findMany: async ({ where }: any) =>
          [...platformMemberships.values()]
            .filter(
              (pm) =>
                (!where?.userId?.in || where.userId.in.some((id: bigint) => id === pm.userId)) &&
                (where?.userId?.in || where?.userId === undefined || pm.userId === where.userId) &&
                (!where?.status || pm.status === where.status),
            )
            .map((pm) => ({ ...pm, role: roleById.get(pm.roleId.toString()) })),
        findFirst: async ({ where }: any) => {
          for (const pm of platformMemberships.values()) {
            if (pm.userId === where.userId && pm.roleId === where.roleId && (!where.status?.not || pm.status !== where.status.not)) {
              return { ...pm };
            }
          }
          return null;
        },
        findUnique: async ({ where }: any) => {
          const pm = platformMemberships.get(where.membershipId.toString());
          return pm ? { ...pm, role: roleById.get(pm.roleId.toString()) } : null;
        },
        create: async ({ data }: any) => {
          if (data.status === 'ACTIVE') enforceActiveUserUniqueIndex(data.userId);
          const row = {
            ...data,
            membershipId: BigInt(nextPmId++),
            revokedAt: null,
            revokedByUserId: null,
            updatedAt: new Date(nowBase.getTime() + txTick++ * 1000),
          };
          platformMemberships.set(row.membershipId.toString(), row);
          return { ...row };
        },
        update: async ({ where, data }: any) => {
          const cur = platformMemberships.get(where.membershipId.toString());
          if (data.status === 'ACTIVE') enforceActiveUserUniqueIndex(cur.userId, cur.membershipId);
          const next = { ...cur, ...data, updatedAt: new Date(nowBase.getTime() + txTick++ * 1000) };
          platformMemberships.set(cur.membershipId.toString(), next);
          return { ...next };
        },
        updateMany: async ({ where, data }: any) => {
          const cur = platformMemberships.get(where.membershipId.toString());
          if (
            !cur ||
            (where.userId !== undefined && cur.userId !== where.userId) ||
            (where.status !== undefined && cur.status !== where.status) ||
            (where.updatedAt !== undefined && cur.updatedAt.getTime() !== new Date(where.updatedAt).getTime())
          ) {
            return { count: 0 };
          }
          if (data.status === 'ACTIVE') enforceActiveUserUniqueIndex(cur.userId, cur.membershipId);
          platformMemberships.set(cur.membershipId.toString(), {
            ...cur,
            ...data,
            updatedAt: new Date(nowBase.getTime() + txTick++ * 1000),
          });
          return { count: 1 };
        },
      },
      refreshToken: { updateMany: async () => ({ count: 0 }) },
      rentalAuditLog: { create: async ({ data }: any) => data },
    };

    if (!mockOptions?.omitRoleTransitionBatchDelegate) {
      tx.roleTransitionBatch = {
        create: async ({ data }: any) => {
          batches.set(data.batchId, { ...data });
          return data;
        },
        findUnique: async ({ where }: any) => batches.get(where.batchId) || null,
        updateMany: async ({ where, data }: any) => {
          const b = batches.get(where.batchId);
          if (!b || b.status !== where.status) return { count: 0 };
          batches.set(where.batchId, { ...b, ...data });
          return { count: 1 };
        },
      };
    }

    return tx;
  };

  const prismaMock: any = {
    storeStaffs,
    users,
    platformMemberships,
    batches,
    ...(mockOptions?.omitRoleTransitionBatchDelegate
      ? {}
      : {
          roleTransitionBatch: {
            findUnique: async ({ where }: any) => batches.get(where.batchId) || null,
          },
        }),
    $transaction: async (cb: any) => cb(makeTx()),
  };
  return prismaMock;
}

async function runStep7AndConcurrencySuite() {
  const dbUrl = new URL(process.env.DATABASE_URL || '');
  if (!dbUrl.pathname.endsWith('_test')) {
    throw new Error(`SAFETY_ABORT: DATABASE_URL (${dbUrl.pathname}) must end with _test`);
  }

  console.log('\n================================================================================');
  console.log('🧪 STEP 7 FULL REHEARSAL + BUG 1-4 REGRESSIONS + LIVE POSTGRESQL CONCURRENCY & REDIS');
  console.log(`🎯 Target DB: ${dbUrl.hostname}${dbUrl.pathname}`);
  console.log('================================================================================\n');

  const prisma = new PrismaService();
  await prisma.$connect();

  const ts = Date.now();
  const createdUserIds: bigint[] = [];
  const createdStoreIds: bigint[] = [];
  const createdCustomerIds: bigint[] = [];
  const createdRentalIds: bigint[] = [];
  const createdButtonIds: bigint[] = [];
  const createdTicketIds: bigint[] = [];
  const createdShiftIds: bigint[] = [];
  const createdBatchIds: string[] = [];
  let mainServerProc: ChildProcess | null = null;
  let redisNodeAProc: ChildProcess | null = null;
  let redisNodeBProc: ChildProcess | null = null;
  let passed = 0;

  try {
    // =========================================================================
    // GROUP 1B: Mocked-DB Reproduction of All 4 Step 7 Script Bugs
    // =========================================================================
    {
      const mockPrisma = createMockStep7PrismaWithActiveUniqueConstraint();
      const mockManifest: Step7TransitionManifest = {
        manifestVersion: 'mock-repro-v1',
        actorUserId: '1',
        backfillLegacyAdmins: true,
        grantSystemStaffUserIds: ['12'],
        terminateStoreStaffIds: ['100', '101', '102', '103'],
        allowUnsettledLegacyDelivery: true,
      };

      // Bug 1 check: dry-run & execute pick ONE highest role per user & upgrade without P2002!
      const mockDry = await executeStep7Transition(mockPrisma, mockManifest, { dryRun: true });
      const u10Dry = mockDry.actions.backfilledAdmins.filter((a) => a.userId === '10');
      const u11Dry = mockDry.actions.backfilledAdmins.filter((a) => a.userId === '11');
      assert.strictEqual(u10Dry.length, 1, 'Dual legacy admin (ADMIN + SYSTEM_ADMIN) MUST collapse to 1 single decision');
      assert.strictEqual(u10Dry[0].roleCode, 'SYSTEM_ADMIN');
      assert.strictEqual(u10Dry[0].outcome, 'WOULD_GRANT');
      assert.strictEqual(u11Dry.length, 1);
      assert.strictEqual(u11Dry[0].roleCode, 'SYSTEM_ADMIN');
      assert.strictEqual(u11Dry[0].outcome, 'WOULD_UPGRADE');

      const mockExec = await executeStep7Transition(mockPrisma, mockManifest, { dryRun: false });
      assert.ok(mockExec.batchId, 'Execution must return durable batchId');
      assert.strictEqual(mockExec.actions.backfilledAdmins.find((a) => a.userId === '10')?.outcome, 'GRANTED');
      assert.strictEqual(mockExec.actions.backfilledAdmins.find((a) => a.userId === '11')?.outcome, 'UPGRADED');

      // Verify unique active per user holds across mock DB
      const activeFor10 = [...mockPrisma.platformMemberships.values()].filter((p: any) => p.userId === BigInt(10) && p.status === 'ACTIVE');
      const activeFor11 = [...mockPrisma.platformMemberships.values()].filter((p: any) => p.userId === BigInt(11) && p.status === 'ACTIVE');
      assert.strictEqual(activeFor10.length, 1);
      assert.strictEqual(activeFor11.length, 1);
      assert.strictEqual(activeFor11[0].roleId, BigInt(12), 'User 11 upgraded cleanly to SYSTEM_ADMIN');

      // Bug 4 check: Regenerate rollback dossier from DB batch without reading any disk file!
      const exportedFromDb = await exportStep7BatchRollback(mockPrisma, mockExec.batchId!);
      assert.strictEqual(exportedFromDb.batchId, mockExec.batchId);

      // Bug 2 + Review Point 1 checks:
      // a) Wrong targetDatabase rejected with ROLLBACK_TARGET_MISMATCH
      await assert.rejects(
        () => rollbackStep7Transition(mockPrisma, { ...exportedFromDb, targetDatabase: 'other-prod-host/prod_db' }, { dryRun: true }),
        /ROLLBACK_TARGET_MISMATCH/,
      );
      // b) Emptying payload operations (`platformMemberships: [], storeStaffs: []`) while keeping metadata & manifestHash MUST abort BOTH dry-run & execute and keep batch EXECUTED!
      const emptiedPayloadArtifact = {
        ...JSON.parse(JSON.stringify(exportedFromDb)),
        platformMemberships: [],
        storeStaffs: [],
      };
      await assert.rejects(
        () => rollbackStep7Transition(mockPrisma, emptiedPayloadArtifact, { dryRun: true }),
        /ROLLBACK_PAYLOAD_MISMATCH/,
      );
      await assert.rejects(
        () => rollbackStep7Transition(mockPrisma, emptiedPayloadArtifact, { dryRun: false }),
        /ROLLBACK_PAYLOAD_MISMATCH/,
      );
      assert.strictEqual(mockPrisma.batches.get(mockExec.batchId!)?.status, 'EXECUTED', 'Batch MUST stay EXECUTED after tampered file rejection');

      // c) Tampering a row field in file MUST abort with ROLLBACK_PAYLOAD_MISMATCH
      const tamperedFileIdentity = JSON.parse(JSON.stringify(exportedFromDb));
      tamperedFileIdentity.storeStaffs[0].userId = '9999';
      await assert.rejects(
        () => rollbackStep7Transition(mockPrisma, tamperedFileIdentity, { dryRun: true }),
        /ROLLBACK_PAYLOAD_MISMATCH/,
      );

      // d) Authoritative DB-row identity mismatch check still aborts with ROLLBACK_IDENTITY_MISMATCH
      const idMismatchMock = createMockStep7PrismaWithActiveUniqueConstraint();
      const idExec = await executeStep7Transition(idMismatchMock, mockManifest, { dryRun: false });
      const corruptedRow = idMismatchMock.storeStaffs.get('100');
      idMismatchMock.storeStaffs.set('100', { ...corruptedRow, userId: BigInt(9999) });
      await assert.rejects(
        () => rollbackStep7Transition(idMismatchMock, { batchId: idExec.batchId! }, { dryRun: true }),
        /ROLLBACK_IDENTITY_MISMATCH/,
      );

      // Bug 3 check: Post-cutover modification (e.g. status changed or re-edited) aborts BOTH rollback dry-run AND execute!
      const driftedMock = createMockStep7PrismaWithActiveUniqueConstraint();
      const dExec = await executeStep7Transition(driftedMock, mockManifest, { dryRun: false });
      // Simulate admin change after cutover on store_staff#103
      const s103 = driftedMock.storeStaffs.get('103');
      driftedMock.storeStaffs.set('103', { ...s103, status: 'ACTIVE', leftAt: null, updatedAt: new Date(Date.now() + 99999) });
      await assert.rejects(
        () => rollbackStep7Transition(driftedMock, { batchId: dExec.batchId! }, { dryRun: true }),
        /ROLLBACK_DRIFT_CONFLICT/,
      );
      await assert.rejects(
        () => rollbackStep7Transition(driftedMock, { batchId: dExec.batchId! }, { dryRun: false }),
        /ROLLBACK_DRIFT_CONFLICT/,
      );

      // Review Point 2A: Concurrent termination AFTER pre-lock discovery, BEFORE lock acquisition MUST NOT grant admin from stale snapshot!
      let terminatedRaceTriggered = false;
      const staleReadRaceMock = createMockStep7PrismaWithActiveUniqueConstraint({
        onBeforeLockUser: (uid, state) => {
          if (!terminatedRaceTriggered && uid === BigInt(10)) {
            terminatedRaceTriggered = true;
            const cur100 = state.storeStaffs.get('100');
            const cur101 = state.storeStaffs.get('101');
            state.storeStaffs.set('100', { ...cur100, status: 'TERMINATED', leftAt: new Date() });
            state.storeStaffs.set('101', { ...cur101, status: 'TERMINATED', leftAt: new Date() });
          }
        },
      });
      const raceRes = await executeStep7Transition(
        staleReadRaceMock,
        {
          manifestVersion: 'stale-race-v1',
          actorUserId: '1',
          backfillLegacyAdmins: true,
          grantSystemStaffUserIds: [],
          terminateStoreStaffIds: [],
          allowUnsettledLegacyDelivery: true,
        },
        { dryRun: false },
      );
      assert.strictEqual(
        raceRes.actions.backfilledAdmins.some((a) => a.userId === '10'),
        false,
        'Concurrent termination committed before user lock MUST prevent granting admin from pre-lock read',
      );
      const grantedPmFor10AfterRace = [...staleReadRaceMock.platformMemberships.values()].filter(
        (pm: any) => pm.userId === BigInt(10) && pm.status === 'ACTIVE',
      );
      assert.strictEqual(grantedPmFor10AfterRace.length, 0, 'Zero ACTIVE platform memberships may exist for concurrently terminated admin user 10');

      // Review Point 2B: Concurrent account lock AFTER pre-lock discovery MUST abort with CONCURRENCY_CONFLICT!
      let lockRaceTriggered = false;
      const lockedAccountRaceMock = createMockStep7PrismaWithActiveUniqueConstraint({
        onBeforeLockUser: (uid, state) => {
          if (!lockRaceTriggered && uid === BigInt(10)) {
            lockRaceTriggered = true;
            const u10 = state.users.get('10');
            state.users.set('10', { ...u10, status: 'LOCKED' });
          }
        },
      });
      await assert.rejects(
        () =>
          executeStep7Transition(
            lockedAccountRaceMock,
            {
              manifestVersion: 'lock-race-v1',
              actorUserId: '1',
              backfillLegacyAdmins: true,
              grantSystemStaffUserIds: [],
              terminateStoreStaffIds: [],
              allowUnsettledLegacyDelivery: true,
            },
            { dryRun: false },
          ),
        /CONCURRENCY_CONFLICT/,
      );

      // Review Point 3: Missing roleTransitionBatch delegate MUST fail transaction (never silently skip batch logging!)
      const missingBatchDelegateMock = createMockStep7PrismaWithActiveUniqueConstraint({
        omitRoleTransitionBatchDelegate: true,
      });
      await assert.rejects(
        () => executeStep7Transition(missingBatchDelegateMock, mockManifest, { dryRun: false }),
        /Cannot read properties of undefined|roleTransitionBatch/,
      );
      await assert.rejects(
        () => rollbackStep7Transition(missingBatchDelegateMock, exportedFromDb, { dryRun: true }),
        /Cannot read properties of undefined|roleTransitionBatch/,
      );

      // WS helper regression: Socket.IO session ID containing "41" MUST be accepted when no 41/44 disconnect packet occurs
      const { WebSocketServer } = require('ws');
      const mockWss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await new Promise<void>((resolve) => mockWss.once('listening', resolve));
      try {
        const port = (mockWss.address() as any).port;
        const mockWsOrigin = `http://127.0.0.1:${port}`;
        let serverConnIdx = 0;
        const serverClients: any[] = [];
        mockWss.on('connection', (socket: any) => {
          const idx = serverConnIdx++;
          serverClients.push(socket);
          const sids = ['validAbcSession', 'validAbc41Session', 'kickedWith41Session', 'kickedWith44Session'];
          const chosenSid = sids[idx] || `sid-${idx}`;
          socket.send(`0${JSON.stringify({ sid: chosenSid, upgrades: [], pingInterval: 25000, pingTimeout: 20000 })}`);
          socket.on('message', (rawMsg: Buffer | string) => {
            const txt = rawMsg.toString();
            if (txt.startsWith('40')) {
              socket.send(`40${JSON.stringify({ sid: chosenSid })}`);
              if (chosenSid === 'kickedWith41Session') {
                setTimeout(() => socket.send('41'), 15);
              } else if (chosenSid === 'kickedWith44Session') {
                setTimeout(() => socket.send('44{"message":"Unauthorized"}'), 15);
              }
            }
          });
        });

        const normalWs = await openPersistentSocketIoSession(mockWsOrigin, 'tok-1', { settleMs: 60 });
        assert.strictEqual(normalWs.accepted, true, 'validAbcSession MUST be accepted');
        await normalWs.session!.close();

        const sidWith41Ws = await openPersistentSocketIoSession(mockWsOrigin, 'tok-2', { settleMs: 60 });
        assert.strictEqual(sidWith41Ws.accepted, true, 'validAbc41Session containing "41" MUST be accepted without false disconnect');
        assert.strictEqual(sidWith41Ws.session?.sid, 'validAbc41Session');
        const sidWith41Disconnect = sidWith41Ws.session!.waitForRevocationOrDisconnect(1000);
        serverClients[1].send('42["auth:revoked",{"reason":"test"}]');
        serverClients[1].send('41');
        const sid41Outcome = await sidWith41Disconnect;
        assert.strictEqual(sid41Outcome.disconnected, true);
        assert.strictEqual(sid41Outcome.authRevoked, true);
        await sidWith41Ws.session!.close();

        const rejected41Ws = await openPersistentSocketIoSession(mockWsOrigin, 'tok-3', { settleMs: 100 });
        assert.strictEqual(rejected41Ws.accepted, false, 'Packet starting with "41" during handshake settle MUST be rejected');

        const rejected44Ws = await openPersistentSocketIoSession(mockWsOrigin, 'tok-4', { settleMs: 100 });
        assert.strictEqual(rejected44Ws.accepted, false, 'Packet starting with "44" during handshake settle MUST be rejected');
      } finally {
        await new Promise<void>((resolve) => mockWss.close(() => resolve()));
      }

      // Clean untouched rollback (including restoring upgraded user 11 back to ADMIN!) succeeds
      const dryRbOk = await rollbackStep7Transition(mockPrisma, { batchId: mockExec.batchId! }, { dryRun: true });
      assert.strictEqual(dryRbOk.readyToRollback, true);
      const execRbOk = await rollbackStep7Transition(mockPrisma, { batchId: mockExec.batchId! }, { dryRun: false });
      assert.strictEqual(execRbOk.restoredStaffCount, 4);
      const restored11 = [...mockPrisma.platformMemberships.values()].filter((p: any) => p.userId === BigInt(11) && p.status === 'ACTIVE');
      assert.strictEqual(restored11.length, 1);
      assert.strictEqual(restored11[0].roleId, BigInt(11), 'Rollback cleanly restored user 11 back to ADMIN');

      console.log('  ✔ [PASS] Group 1B: Bug 1-4 + post-lock discovery/tampered-file/mandatory-batch/WS-sid-41 regressions');
      passed++;
    }

    const ensureRole = async (code: string, name: string) => {
      let r = await prisma.role.findUnique({ where: { roleCode: code } });
      if (!r) {
        r = await prisma.role.create({ data: { roleCode: code, roleName: name } });
      }
      return r;
    };

    const [roleStoreOwner, roleAdmin, roleSysAdmin, roleStaffButton, roleStoreStaff] = await Promise.all([
      ensureRole('STORE_OWNER', 'Chủ cửa hàng'),
      ensureRole('ADMIN', 'Quản trị viên'),
      ensureRole('SYSTEM_ADMIN', 'Quản trị hệ thống'),
      ensureRole('STAFF_BUTTON', 'Nhân viên nút cũ'),
      ensureRole('STORE_STAFF', 'Nhân viên cửa hàng cũ'),
    ]);

    const mkUser = async (tag: string) => {
      const u = await prisma.user.create({
        data: {
          email: `step7_${tag}_${ts}@example.test`,
          username: `step7_${tag}_${ts}`,
          fullName: `Step7 ${tag}`,
          phone: `09${Math.floor(10000000 + Math.random() * 89999999)}`,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(u.userId);
      return u;
    };

    const [actorAdmin, legacyAdmin, storeOwner, techCandidate, terminatedOnlyStaff, ownerB] = await Promise.all([
      mkUser('actor_super'),
      mkUser('legacy_admin'),
      mkUser('owner'),
      mkUser('tech_staff'),
      mkUser('order_staff'),
      mkUser('owner_b'),
    ]);

    const roleSuperAdmin = await ensureRole('SUPER_ADMIN', 'Siêu quản trị');
    await prisma.platformMembership.create({
      data: { userId: actorAdmin.userId, roleId: roleSuperAdmin.roleId, status: 'ACTIVE' },
    });

    const store = await prisma.store.create({
      data: {
        ownerUserId: storeOwner.userId,
        name: `Rehearsal Store ${ts}`,
        code: `RHL_STORE_${ts}`,
        phone: '0901112233',
        address: '123 Test Street',
        status: 'ACTIVE',
      },
    });
    createdStoreIds.push(store.storeId);

    const storeB = await prisma.store.create({
      data: {
        ownerUserId: ownerB.userId,
        name: `Concurrency Store B ${ts}`,
        code: `RHL_STOREB_${ts}`,
        phone: '0902223344',
        address: '456 Test Street',
        status: 'ACTIVE',
      },
    });
    createdStoreIds.push(storeB.storeId);

    const ownerStaffRow = await prisma.storeStaff.create({
      data: { storeId: store.storeId, userId: storeOwner.userId, roleId: roleStoreOwner.roleId, status: 'ACTIVE' },
    });
    // Give legacyAdmin BOTH ADMIN on Store A and SYSTEM_ADMIN on Store B -> real DB test of Bug 1!
    const legacyAdminStaffRowA = await prisma.storeStaff.create({
      data: { storeId: store.storeId, userId: legacyAdmin.userId, roleId: roleAdmin.roleId, status: 'ACTIVE' },
    });
    const legacyAdminStaffRowB = await prisma.storeStaff.create({
      data: { storeId: storeB.storeId, userId: legacyAdmin.userId, roleId: roleSysAdmin.roleId, status: 'ACTIVE' },
    });
    const techStaffRow = await prisma.storeStaff.create({
      data: { storeId: store.storeId, userId: techCandidate.userId, roleId: roleStaffButton.roleId, status: 'ACTIVE' },
    });
    const orderStaffRow = await prisma.storeStaff.create({
      data: { storeId: store.storeId, userId: terminatedOnlyStaff.userId, roleId: roleStoreStaff.roleId, status: 'ACTIVE' },
    });

    const mainPort = process.env.STEP7_TEST_PORT || '3098';
    const srv = await spawnCompiledServer(mainPort, {
      DISABLE_REDIS: process.env.REDIS_URL ? 'false' : 'true',
    });
    mainServerProc = srv.proc;
    const { baseOrigin, apiBase } = srv;

    // =========================================================================
    // GROUP 1: Consistent Dry-Run Snapshot + Precondition Guards on Neon Test DB
    // =========================================================================
    const beforeSnapshot = await runStep7InventoryReport(prisma);
    assert.strictEqual(beforeSnapshot.isolationLevel, 'REPEATABLE_READ_READ_ONLY');
    assert.strictEqual(beforeSnapshot.readOnly, true);
    const legacyEntriesForUser = beforeSnapshot.details.legacyAdminsWithoutPlatformMembership.filter(
      (x) => x.userId === legacyAdmin.userId.toString(),
    );
    assert.strictEqual(legacyEntriesForUser.length, 1, 'Dry-run MUST emit 1 consolidated highest admin backfill row per user');
    assert.strictEqual(legacyEntriesForUser[0].roleCode, 'SYSTEM_ADMIN');

    await assert.rejects(
      () =>
        executeStep7Transition(
          prisma,
          {
            actorUserId: actorAdmin.userId.toString(),
            grantSystemStaffUserIds: [],
            terminateStoreStaffIds: [ownerStaffRow.storeStaffId.toString()],
            allowUnsettledLegacyDelivery: true,
          },
          { dryRun: true },
        ),
      /STORE_OWNER/,
    );
    await assert.rejects(
      () =>
        executeStep7Transition(
          prisma,
          {
            actorUserId: actorAdmin.userId.toString(),
            grantSystemStaffUserIds: [storeOwner.userId.toString()],
            terminateStoreStaffIds: [],
            allowUnsettledLegacyDelivery: true,
          },
          { dryRun: true },
        ),
      /STORE_OWNER/,
    );

    const rehearsalManifest: Step7TransitionManifest = {
      manifestVersion: `rehearsal-${ts}`,
      actorUserId: actorAdmin.userId.toString(),
      backfillLegacyAdmins: true,
      grantSystemStaffUserIds: [techCandidate.userId.toString()],
      terminateStoreStaffIds: [
        legacyAdminStaffRowA.storeStaffId.toString(),
        legacyAdminStaffRowB.storeStaffId.toString(),
        techStaffRow.storeStaffId.toString(),
        orderStaffRow.storeStaffId.toString(),
      ],
      allowStoreOwnerDualRole: false,
      allowUnsettledLegacyDelivery: true,
    };

    const dryRunRes = await executeStep7Transition(prisma, rehearsalManifest, { dryRun: true });
    assert.strictEqual(dryRunRes.dryRun, true);
    assert.strictEqual(dryRunRes.batchId, null);
    assert.strictEqual(dryRunRes.rollbackArtifact, null);
    assert.strictEqual(
      dryRunRes.actions.backfilledAdmins.filter((a) => a.userId === legacyAdmin.userId.toString()).length,
      1,
    );

    const postDryRunSnapshot = await runStep7InventoryReport(prisma);
    const noChangeDiff = diffStep7Snapshots(beforeSnapshot, postDryRunSnapshot);
    assert.strictEqual(noChangeDiff.grantedOrActivatedPlatformMemberships.length, 0);
    assert.strictEqual(noChangeDiff.terminatedStoreStaffIds.length, 0);
    console.log('  ✔ [PASS] Group 1: Live Neon REPEATABLE READ dry-run, single admin resolution & precondition guards');
    passed++;

    // =========================================================================
    // GROUP 2: Execute -> Idempotency -> Diff -> HTTP + ALREADY-OPEN Live WS Disconnect -> Rollback + Drift CAS
    // =========================================================================
    const preIatSec = Math.floor(Date.now() / 1000) - 5;
    const preTechJwt = signAccessToken(techCandidate.userId, 'STAFF_BUTTON', preIatSec, store.storeId);
    const preOrderJwt = signAccessToken(terminatedOnlyStaff.userId, 'STORE_STAFF', preIatSec, store.storeId);
    const preAdminJwt = signAccessToken(legacyAdmin.userId, 'SYSTEM_ADMIN', preIatSec, store.storeId);

    // Pre-cutover: verify legacyAdmin gets SYSTEM_ADMIN before transition
    const preAdminMe = await httpJson(`${apiBase}/auth/me`, 'GET', preAdminJwt);
    assert.strictEqual(preAdminMe.status, 200);
    assert.strictEqual(preAdminMe.body?.data?.role, 'SYSTEM_ADMIN');

    // Execute Step 7 transition atomically!
    const execRes = await executeStep7Transition(prisma, rehearsalManifest, { dryRun: false });
    assert.ok(execRes.batchId);
    createdBatchIds.push(execRes.batchId!);
    assert.strictEqual(execRes.idempotentNoOp, false);
    assert.strictEqual(
      execRes.actions.backfilledAdmins.find((a) => a.userId === legacyAdmin.userId.toString())?.outcome,
      'GRANTED',
    );
    assert.strictEqual(execRes.actions.grantedSystemStaff[0].outcome, 'GRANTED');
    assert.strictEqual(execRes.actions.terminatedStoreStaff.length, 4);

    // Export batch dossier from PostgreSQL (`role_transition_batches`) directly
    const dbBackedArtifact = await exportStep7BatchRollback(prisma, execRes.batchId!);
    assert.strictEqual(dbBackedArtifact.batchId, execRes.batchId);
    assert.strictEqual(dbBackedArtifact.databaseName, 'smart_order_test');

    // Idempotent second run -> ZERO duplicates & idempotentNoOp=true
    const replayRes = await executeStep7Transition(prisma, rehearsalManifest, { dryRun: false });
    assert.strictEqual(replayRes.idempotentNoOp, true);
    assert.strictEqual(replayRes.batchId, null);

    // Post-execution inventory diff
    const afterSnapshot = await runStep7InventoryReport(prisma);
    const execDiff = diffStep7Snapshots(beforeSnapshot, afterSnapshot);
    assert.ok(execDiff.grantedOrActivatedPlatformMemberships.includes(`${techCandidate.userId}:SYSTEM_STAFF`));
    assert.ok(execDiff.grantedOrActivatedPlatformMemberships.includes(`${legacyAdmin.userId}:SYSTEM_ADMIN`));
    assert.strictEqual(execDiff.terminatedStoreStaffIds.length, 4);
    assert.strictEqual(execDiff.terminatedStoreStaffIds.includes(ownerStaffRow.storeStaffId.toString()), false);
    assert.strictEqual(afterSnapshot.summary.legacyAdminsNeedingPlatformMembershipCount, 0);

    // Pre-cutover stale tokens invalidated on HTTP & WS handshake
    assert.strictEqual((await httpJson(`${apiBase}/auth/me`, 'GET', preTechJwt)).status, 401);
    assert.strictEqual((await httpJson(`${apiBase}/auth/me`, 'GET', preOrderJwt)).status, 401);
    const staleTechWs = await openPersistentSocketIoSession(baseOrigin, preTechJwt);
    assert.strictEqual(staleTechWs.accepted, false, 'Pre-cutover token MUST be rejected at WS connect');

    // Fresh post-cutover tokens: check HTTP boundaries + keep an ALREADY-OPEN live WS connection while revoking!
    const postIatSec = Math.floor(Date.now() / 1000) + 2;
    const postTechJwt = signAccessToken(techCandidate.userId, 'SYSTEM_STAFF', postIatSec);
    const postOrderJwt = signAccessToken(terminatedOnlyStaff.userId, 'CUSTOMER', postIatSec);
    const postOwnerJwt = signAccessToken(storeOwner.userId, 'STORE_OWNER', postIatSec, store.storeId);
    const postAdminJwt = signAccessToken(legacyAdmin.userId, 'SYSTEM_ADMIN', postIatSec);
    const superJwt = signAccessToken(actorAdmin.userId, 'SUPER_ADMIN', postIatSec);

    assert.strictEqual((await httpJson(`${apiBase}/auth/me`, 'GET', postTechJwt)).body?.data?.role, 'SYSTEM_STAFF');
    assert.strictEqual((await httpJson(`${apiBase}/warranty/tickets`, 'GET', postTechJwt)).status, 200);
    assert.strictEqual((await httpJson(`${apiBase}/orders/delivery-queue`, 'GET', postTechJwt)).status, 403);
    assert.strictEqual((await httpJson(`${apiBase}/admin/withdrawals`, 'GET', postTechJwt)).status, 403);
    assert.strictEqual((await httpJson(`${apiBase}/auth/me`, 'GET', postOrderJwt)).body?.data?.role, 'CUSTOMER');
    assert.strictEqual((await httpJson(`${apiBase}/warranty/tickets`, 'GET', postOrderJwt)).status, 403);
    assert.strictEqual((await httpJson(`${apiBase}/orders/delivery-queue`, 'GET', postOwnerJwt)).status, 200);
    assert.strictEqual((await httpJson(`${apiBase}/admin/dashboard`, 'GET', postAdminJwt)).status, 200);
    assert.strictEqual((await httpJson(`${apiBase}/admin/platform-memberships`, 'GET', postAdminJwt)).status, 403);
    assert.strictEqual((await httpJson(`${apiBase}/admin/platform-memberships`, 'GET', superJwt)).status, 200);

    // Hold OPEN persistent Socket.io connection on `postTechJwt`, then revoke via HTTP -> assert LIVE OPEN SOCKET is kicked immediately!
    const liveOpenTechWs = await openPersistentSocketIoSession(baseOrigin, postTechJwt);
    assert.strictEqual(liveOpenTechWs.accepted, true, 'Fresh SYSTEM_STAFF token must open persistent live WS connection');

    const kickWatcher = liveOpenTechWs.session!.waitForRevocationOrDisconnect(5000);
    const revokeRes = await httpJson(
      `${apiBase}/admin/users/${techCandidate.userId}/platform-role`,
      'DELETE',
      superJwt,
      { reason: 'Live open socket kick verification' },
    );
    assert.strictEqual(revokeRes.status, 200);

    const kickOutcome = await kickWatcher;
    assert.strictEqual(kickOutcome.disconnected, true, 'ALREADY-OPEN persistent WS socket MUST be disconnected upon live revocation');
    assert.strictEqual(kickOutcome.authRevoked, true, 'Open WS socket MUST receive auth:revoked before disconnect');
    await liveOpenTechWs.session!.close();

    // Since we modified techCandidate's platform_membership post-cutover above (`DELETE /platform-role`),
    // Bug 3 verification on LIVE Postgres: BOTH rollback dry-run AND rollback execute MUST detect drift (`ROLLBACK_DRIFT_CONFLICT`)!
    await assert.rejects(
      () => rollbackStep7Transition(prisma, dbBackedArtifact, { dryRun: true }),
      /ROLLBACK_DRIFT_CONFLICT/,
    );
    await assert.rejects(
      () => rollbackStep7Transition(prisma, dbBackedArtifact, { dryRun: false }),
      /ROLLBACK_DRIFT_CONFLICT/,
    );

    // Clean rollback check on a clean second batch (store_staff#orderStaffRow)
    await prisma.storeStaff.update({
      where: { storeStaffId: orderStaffRow.storeStaffId },
      data: { status: 'ACTIVE', leftAt: null },
    });
    const cleanBatchExec = await executeStep7Transition(
      prisma,
      {
        manifestVersion: `clean-rb-${ts}`,
        actorUserId: actorAdmin.userId.toString(),
        backfillLegacyAdmins: false,
        grantSystemStaffUserIds: [],
        terminateStoreStaffIds: [orderStaffRow.storeStaffId.toString()],
        allowUnsettledLegacyDelivery: true,
      },
      { dryRun: false },
    );
    createdBatchIds.push(cleanBatchExec.batchId!);
    const cleanDryRb = await rollbackStep7Transition(prisma, { batchId: cleanBatchExec.batchId! }, { dryRun: true });
    assert.strictEqual(cleanDryRb.readyToRollback, true);
    const cleanExecRb = await rollbackStep7Transition(prisma, { batchId: cleanBatchExec.batchId! }, { dryRun: false });
    assert.strictEqual(cleanExecRb.restoredStaffCount, 1);

    // Cannot rollback same batch twice
    await assert.rejects(
      () => rollbackStep7Transition(prisma, { batchId: cleanBatchExec.batchId! }, { dryRun: false }),
      /ROLLBACK_BATCH_ALREADY_REVERTED/,
    );

    console.log('  ✔ [PASS] Group 2: Live Step 7 rehearsal, open persistent WS kick, post-cutover drift CAS & DB batch rollback');
    passed++;

    // =========================================================================
    // GROUP 3: Real PostgreSQL Concurrent Transactions on `smart_order_test`
    // =========================================================================
    const customer = await prisma.customerProfile.create({
      data: { userId: terminatedOnlyStaff.userId },
    });
    createdCustomerIds.push(customer.customerId);

    const rentalPkg =
      (await prisma.rentalPackage.findFirst()) ||
      (await prisma.rentalPackage.create({
        data: {
          packageCode: `PKG_CONC_${ts}`,
          packageName: 'Pkg Concurrency',
          buttonQuantity: 2,
          monthlyPrice: 50000,
          depositFee: 200000,
          isActive: true,
        },
      }));

    const rentalA = await prisma.buttonRental.create({
      data: {
        rentalCode: `RNT-CONC-A-${ts}`,
        customerId: customer.customerId,
        packageId: rentalPkg.packageId,
        fulfillmentStoreId: store.storeId,
        buttonQuantity: 1,
        depositPerButton: 200000,
        rentPerButton: 50000,
        monthsRented: 1,
        totalRentAmount: 50000,
        depositAmount: 200000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 86400_000),
        effectiveExpiresAt: new Date(Date.now() + 30 * 86400_000),
        status: 'ACTIVE',
      },
    });
    const rentalB = await prisma.buttonRental.create({
      data: {
        rentalCode: `RNT-CONC-B-${ts}`,
        customerId: customer.customerId,
        packageId: rentalPkg.packageId,
        fulfillmentStoreId: storeB.storeId,
        buttonQuantity: 1,
        depositPerButton: 200000,
        rentPerButton: 50000,
        monthsRented: 1,
        totalRentAmount: 50000,
        depositAmount: 200000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 86400_000),
        effectiveExpiresAt: new Date(Date.now() + 30 * 86400_000),
        status: 'ACTIVE',
      },
    });
    const rentalC = await prisma.buttonRental.create({
      data: {
        rentalCode: `RNT-CONC-C-${ts}`,
        customerId: customer.customerId,
        packageId: rentalPkg.packageId,
        fulfillmentStoreId: store.storeId,
        buttonQuantity: 1,
        depositPerButton: 200000,
        rentPerButton: 50000,
        monthsRented: 1,
        totalRentAmount: 50000,
        depositAmount: 200000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 86400_000),
        effectiveExpiresAt: new Date(Date.now() + 30 * 86400_000),
        status: 'ACTIVE',
      },
    });
    createdRentalIds.push(rentalA.rentalId, rentalB.rentalId, rentalC.rentalId);

    await prisma.rentalDeposit.create({
      data: {
        rentalId: rentalC.rentalId,
        collectedAmount: 200000,
        heldAmount: 200000,
        refundReservedAmount: 0,
        refundedAmount: 0,
      },
    });

    const mkBtn = async (suffix: string, rentalId: bigint | null, storeId: bigint, custodyStoreId: bigint | null, custId: bigint | null, inv: string) => {
      const b = await prisma.ioTButton.create({
        data: {
          deviceId: `SOB-CONC-${suffix}-${ts}`,
          buttonCode: `BTN-CONC-${suffix}-${ts}`,
          buttonName: `Conc ${suffix}`,
          hmacSecret: crypto.randomBytes(16).toString('hex'),
          storeId,
          custodyStoreId,
          customerId: custId,
          rentalId,
          status: custId ? 'ACTIVE' : 'INACTIVE',
          inventoryState: inv,
          canOrder: Boolean(custId),
        },
      });
      createdButtonIds.push(b.buttonId);
      return b;
    };

    const [btnSrc1, btnSrc2, btnSharedRep, btnLockVsSwap] = await Promise.all([
      mkBtn('SRC1', rentalA.rentalId, store.storeId, store.storeId, customer.customerId, 'IN_CUSTOMER_CUSTODY'),
      mkBtn('SRC2', rentalB.rentalId, storeB.storeId, storeB.storeId, customer.customerId, 'IN_CUSTOMER_CUSTODY'),
      mkBtn('REP', null, store.storeId, null, null, 'IN_PLATFORM_WAREHOUSE'),
      mkBtn('LOCKSWAP', rentalC.rentalId, store.storeId, store.storeId, customer.customerId, 'IN_CUSTOMER_CUSTODY'),
    ]);

    const tSwap1 = await prisma.warrantyTicket.create({
      data: {
        ticketCode: `WRT-C1-${ts}`,
        buttonId: btnSrc1.buttonId,
        storeId: store.storeId,
        customerId: customer.customerId,
        rentalId: rentalA.rentalId,
        reportedByUserId: techCandidate.userId,
        faultGroup: 'GROUP_A',
        faultCode: 'DEAD_SWITCH',
        depositAmount: 200000,
        deductionPercent: 0,
        deductionAmount: 0,
        refundAmount: 200000,
        status: 'PENDING',
      },
    });
    const tSwap2 = await prisma.warrantyTicket.create({
      data: {
        ticketCode: `WRT-C2-${ts}`,
        buttonId: btnSrc2.buttonId,
        storeId: storeB.storeId,
        customerId: customer.customerId,
        rentalId: rentalB.rentalId,
        reportedByUserId: techCandidate.userId,
        faultGroup: 'GROUP_A',
        faultCode: 'DEAD_SWITCH',
        depositAmount: 200000,
        deductionPercent: 0,
        deductionAmount: 0,
        refundAmount: 200000,
        status: 'PENDING',
      },
    });
    const tLockOrSwap = await prisma.warrantyTicket.create({
      data: {
        ticketCode: `WRT-LS-${ts}`,
        buttonId: btnLockVsSwap.buttonId,
        storeId: store.storeId,
        customerId: customer.customerId,
        rentalId: rentalC.rentalId,
        reportedByUserId: techCandidate.userId,
        faultGroup: 'GROUP_A',
        faultCode: 'CRACKED_SHELL',
        depositAmount: 200000,
        deductionPercent: 0,
        deductionAmount: 0,
        refundAmount: 200000,
        status: 'PENDING',
      },
    });
    createdTicketIds.push(tSwap1.ticketId, tSwap2.ticketId, tLockOrSwap.ticketId);

    const warrantyRepo = new WarrantyRepository(prisma);
    const swapRace = await Promise.allSettled([
      warrantyRepo.approveSwapAtomicTx(tSwap1.ticketId, btnSharedRep.buttonId, actorAdmin.userId, 'Race 1'),
      warrantyRepo.approveSwapAtomicTx(tSwap2.ticketId, btnSharedRep.buttonId, actorAdmin.userId, 'Race 2'),
    ]);
    assert.strictEqual(swapRace.filter((r) => r.status === 'fulfilled').length, 1);
    assert.strictEqual(swapRace.filter((r) => r.status === 'rejected').length, 1);

    const btnSpareForLockSwap = await mkBtn('REP2', null, store.storeId, null, null, 'IN_PLATFORM_WAREHOUSE');
    const lockSwapRace = await Promise.allSettled([
      warrantyRepo.lockDeviceAtomicTx(tLockOrSwap.ticketId, actorAdmin.userId, 'Race lock'),
      warrantyRepo.approveSwapAtomicTx(tLockOrSwap.ticketId, btnSpareForLockSwap.buttonId, actorAdmin.userId, 'Race swap'),
    ]);
    assert.strictEqual(lockSwapRace.filter((r) => r.status === 'fulfilled').length, 1);
    assert.strictEqual(lockSwapRace.filter((r) => r.status === 'rejected').length, 1);

    const shift = await prisma.driverShift.create({
      data: { storeId: store.storeId, driverId: terminatedOnlyStaff.userId, status: 'OPEN' },
    });
    createdShiftIds.push(shift.shiftId);
    const driverShiftsService = new DriverShiftsService(prisma);
    const ownerActor = { userId: storeOwner.userId.toString(), role: 'STORE_OWNER', storeId: store.storeId.toString() };
    await Promise.allSettled([
      driverShiftsService.confirmHandover(shift.shiftId.toString(), ownerActor, { note: 'Concurrent handover' }),
      driverShiftsService.closeShift(shift.shiftId.toString(), ownerActor),
    ]);
    const postShift = await prisma.driverShift.findUnique({ where: { shiftId: shift.shiftId } });
    if (postShift?.status === 'CLOSED') {
      await driverShiftsService.confirmHandover(shift.shiftId.toString(), ownerActor, { note: 'Handover after close' });
    }
    await assert.rejects(
      () => driverShiftsService.closeShift(shift.shiftId.toString(), ownerActor),
      (err: any) => err instanceof ConflictException && err.message.includes('HANDED_OVER'),
    );

    const concStaffUser = await mkUser('conc_wm');
    const concStaffRow = await prisma.storeStaff.create({
      data: { storeId: store.storeId, userId: concStaffUser.userId, roleId: roleStoreStaff.roleId, status: 'ACTIVE' },
    });
    const staffRepo = new StoreStaffRepository(prisma);
    const adminRepo = new AdminRepository(prisma);
    const olderT1 = new Date(Date.now() - 120_000);
    await Promise.all([
      staffRepo.deleteStaff(concStaffRow.storeStaffId, actorAdmin.userId, olderT1),
      adminRepo.updateUserStatus(concStaffUser.userId, 'LOCKED'),
    ]);
    const finalWmUser = await prisma.user.findUnique({
      where: { userId: concStaffUser.userId },
      select: { status: true, tokensInvalidBefore: true },
    });
    assert.strictEqual(finalWmUser?.status, 'LOCKED');
    assert.ok(finalWmUser?.tokensInvalidBefore && finalWmUser.tokensInvalidBefore.getTime() > olderT1.getTime());
    console.log('  ✔ [PASS] Group 3: Real PostgreSQL concurrency (swap race, lock vs swap race, shift terminal lock, monotonic watermark)');
    passed++;

    // =========================================================================
    // GROUP 4: Two REAL Nest HTTP+WS Servers over Real Redis Pub/Sub (`REDIS_URL`)
    // =========================================================================
    if (!process.env.REDIS_URL) {
      if (process.env.REQUIRE_LIVE_REDIS === 'true' || process.env.CI === 'true') {
        throw new Error('Live 2-node Redis Pub/Sub WS verification required in CI or REQUIRE_LIVE_REDIS=true, but REDIS_URL is missing');
      }
      console.log('  ⚠ [SKIPPED_NO_LOCAL_REDIS] Group 4 skipped locally (no REDIS_URL / local Redis daemon). Spawns 2 real HTTP+WS nodes automatically in CI with REDIS_URL.');
    } else {
      const roleSysStaff = await ensureRole('SYSTEM_STAFF', 'Nhân viên hệ thống');
      const liveWsUser = await mkUser('redis_ws_user');
      await prisma.platformMembership.create({
        data: { userId: liveWsUser.userId, roleId: roleSysStaff.roleId, status: 'ACTIVE' },
      });

      const nodeA = await spawnCompiledServer('3101', { DISABLE_REDIS: 'false', REDIS_URL: process.env.REDIS_URL });
      const nodeB = await spawnCompiledServer('3102', { DISABLE_REDIS: 'false', REDIS_URL: process.env.REDIS_URL });
      redisNodeAProc = nodeA.proc;
      redisNodeBProc = nodeB.proc;

      const wsUserJwt = signAccessToken(liveWsUser.userId, 'SYSTEM_STAFF', Math.floor(Date.now() / 1000) + 1);
      const superJwtLive = signAccessToken(actorAdmin.userId, 'SUPER_ADMIN', Math.floor(Date.now() / 1000) + 1);

      // Connect real persistent Socket.io client to Node B (3102)
      const openNodeBSess = await openPersistentSocketIoSession(nodeB.baseOrigin, wsUserJwt);
      assert.strictEqual(openNodeBSess.accepted, true, 'User must hold active open Socket.io connection on Node B');

      const nodeBDisconnectPromise = openNodeBSess.session!.waitForRevocationOrDisconnect(6000);
      // Execute HTTP role revocation against Node A (3101)
      const nodeARevoke = await httpJson(
        `${nodeA.apiBase}/admin/users/${liveWsUser.userId}/platform-role`,
        'DELETE',
        superJwtLive,
        { reason: 'Cross-node live Redis Pub/Sub test' },
      );
      assert.strictEqual(nodeARevoke.status, 200);

      const nodeBOutcome = await nodeBDisconnectPromise;
      assert.strictEqual(
        nodeBOutcome.disconnected,
        true,
        'Revocation on Node A MUST disconnect active open Socket.io connection on Node B via real Redis Pub/Sub',
      );
      assert.strictEqual(nodeBOutcome.authRevoked, true);
      await openNodeBSess.session!.close();
      console.log('  ✔ [PASS] Group 4: Two real Nest HTTP+WS servers disconnected open Node B socket when Node A revoked via Redis Pub/Sub');
      passed++;
    }

    console.log(`\n🎉 STEP 7 REHEARSAL, BUG REGRESSIONS & CONCURRENCY COMPLETE (${passed} groups passed)!\n`);
  } finally {
    for (const proc of [mainServerProc, redisNodeAProc, redisNodeBProc]) {
      if (proc && !proc.killed) proc.kill('SIGKILL');
    }
    if (createdBatchIds.length) {
      await (prisma as any).roleTransitionBatch.deleteMany({ where: { batchId: { in: createdBatchIds } } }).catch(() => { });
    }
    if (createdButtonIds.length) {
      await prisma.deviceMovement.deleteMany({ where: { buttonId: { in: createdButtonIds } } }).catch(() => { });
    }
    if (createdTicketIds.length) {
      await prisma.depositRefund.deleteMany({ where: { warrantyTicketId: { in: createdTicketIds } } }).catch(() => { });
      await prisma.warrantyTicket.deleteMany({ where: { ticketId: { in: createdTicketIds } } }).catch(() => { });
    }
    if (createdShiftIds.length) {
      await prisma.driverShift.deleteMany({ where: { shiftId: { in: createdShiftIds } } }).catch(() => { });
    }
    if (createdButtonIds.length) {
      await prisma.buttonProduct.deleteMany({ where: { buttonId: { in: createdButtonIds } } }).catch(() => { });
      await prisma.ioTButton.deleteMany({ where: { buttonId: { in: createdButtonIds } } }).catch(() => { });
    }
    if (createdRentalIds.length) {
      await prisma.rentalDeposit.deleteMany({ where: { rentalId: { in: createdRentalIds } } }).catch(() => { });
      await prisma.buttonRental.deleteMany({ where: { rentalId: { in: createdRentalIds } } }).catch(() => { });
    }
    if (createdCustomerIds.length) {
      await prisma.customerProfile.deleteMany({ where: { customerId: { in: createdCustomerIds } } }).catch(() => { });
    }
    if (createdUserIds.length) {
      await prisma.rentalAuditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } }).catch(() => { });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => { });
      await prisma.platformMembership.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => { });
      await prisma.storeStaff.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => { });
    }
    if (createdStoreIds.length) {
      await prisma.storeStaff.deleteMany({ where: { storeId: { in: createdStoreIds } } }).catch(() => { });
      await prisma.store.deleteMany({ where: { storeId: { in: createdStoreIds } } }).catch(() => { });
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => { });
    }
    await prisma.$disconnect();
  }
}

runStep7AndConcurrencySuite().catch((err) => {
  console.error('❌ Step 7 rehearsal/concurrency test failed:', err);
  process.exit(1);
});
