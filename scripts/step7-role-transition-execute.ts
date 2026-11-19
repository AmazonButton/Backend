/**
 * Step 7 Role Transition Execution & Rollback Script (SAFE DRY-RUN BY DEFAULT)
 *
 * Hardening invariants:
 *   1. Single-active-membership planning: picks at most ONE highest-priority platform role
 *      (`SUPER_ADMIN > SYSTEM_ADMIN > ADMIN`) per user and validates against existing ACTIVE
 *      `platform_memberships` identically in both dry-run and execute (prevents P2002 failures).
 *   2. Durable rollback batch persistence (`role_transition_batches`) committed inside the SAME
 *      transaction as the role transition, with `--export-batch` recovery if file write fails.
 *   3. Strict target DB / `current_database()` / `batchId` / `manifestHash` and per-row identity
 *      (`userId`, `storeId`, `roleCode`) binding checks on BOTH rollback dry-run and execution.
 *   4. Post-cutover CAS & drift detection: records exact before & expected-after row versions and
 *      aborts (`ROLLBACK_DRIFT_CONFLICT`) in both dry-run and execution if rows changed post-cutover.
 *
 * Usage:
 *   npx tsx scripts/step7-role-transition-execute.ts --manifest path/to/manifest.json
 *   npx tsx scripts/step7-role-transition-execute.ts --manifest path/to/manifest.json --execute --confirm-db=smart_order_test --rollback-out tmp/rollback.json
 *   npx tsx scripts/step7-role-transition-execute.ts --export-batch <batchId> --rollback-out tmp/rollback.json
 *   npx tsx scripts/step7-role-transition-execute.ts --rollback tmp/rollback.json --execute --confirm-db=smart_order_test
 */
import * as dotenv from 'dotenv';
dotenv.config();
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  ADMIN_GOVERNANCE_ROLES,
  PLATFORM_ROLE_PRIORITY,
  advanceMonotonicTokensInvalidBefore,
  isBootstrapSuperAdmin,
  lockUserForWatermark,
} from '../src/auth/authority.policy';
import {
  resolveLegacyAdminBackfillDecisions,
  runStep7InventoryReport,
} from './step7-role-transition-dry-run';

export interface Step7TransitionManifest {
  manifestVersion?: string;
  description?: string;
  actorUserId: string;
  backfillLegacyAdmins?: boolean;
  grantSystemStaffUserIds: string[];
  terminateStoreStaffIds: string[];
  allowStoreOwnerDualRole?: boolean;
  allowUnsettledLegacyDelivery?: boolean;
  expectedBefore?: {
    activeStoresCount?: number;
    deprecatedStoreStaffCount?: number;
    storeOwnerMembershipCount?: number;
    legacyAdminsNeedingPlatformMembershipCount?: number;
  };
}

export interface Step7PlatformMembershipRollbackItem {
  membershipId: string;
  userId: string;
  roleId: string;
  roleCode: string;
  existedBefore: boolean;
  previousStatus: string | null;
  previousGrantedByUserId: string | null;
  previousGrantedAt: string | null;
  previousRevokedAt: string | null;
  previousRevokedByUserId: string | null;
  expectedAfterStatus: string;
  expectedAfterGrantedAt: string;
  expectedAfterRevokedAt: string | null;
  expectedAfterUpdatedAt: string;
}

export interface Step7StoreStaffRollbackItem {
  storeStaffId: string;
  userId: string;
  storeId: string;
  roleCode: string;
  previousStatus: string;
  previousLeftAt: string | null;
  expectedAfterStatus: string;
  expectedAfterLeftAt: string | null;
  expectedAfterUpdatedAt: string;
}

export interface Step7RollbackArtifact {
  batchId: string;
  generatedAt: string;
  targetDatabase: string;
  databaseName: string;
  manifestVersion: string;
  manifestHash: string;
  actorUserId: string;
  executedAt: string;
  platformMemberships: Step7PlatformMembershipRollbackItem[];
  storeStaffs: Step7StoreStaffRollbackItem[];
}

export interface Step7ExecutionResult {
  batchId: string | null;
  dryRun: boolean;
  idempotentNoOp: boolean;
  targetDatabase: string;
  databaseName: string;
  manifestHash: string;
  preconditionsPassed: boolean;
  actions: {
    backfilledAdmins: Array<{
      userId: string;
      roleCode: string;
      replacedActiveRoleCode?: string | null;
      outcome:
      | 'GRANTED'
      | 'REACTIVATED'
      | 'UPGRADED'
      | 'ALREADY_ACTIVE'
      | 'WOULD_GRANT'
      | 'WOULD_REACTIVATE'
      | 'WOULD_UPGRADE';
    }>;
    grantedSystemStaff: Array<{
      userId: string;
      outcome: 'GRANTED' | 'REACTIVATED' | 'ALREADY_ACTIVE' | 'WOULD_GRANT' | 'WOULD_REACTIVATE';
    }>;
    terminatedStoreStaff: Array<{
      storeStaffId: string;
      userId: string;
      roleCode: string;
      outcome: 'TERMINATED' | 'ALREADY_TERMINATED' | 'WOULD_TERMINATE';
    }>;
    revokedSessionUserIds: string[];
  };
  rollbackArtifact: Step7RollbackArtifact | null;
}

function uniqueBigInts(values: Array<string | bigint>): bigint[] {
  const seen = new Set<string>();
  const out: bigint[] = [];
  for (const val of values) {
    const b = BigInt(val);
    const key = b.toString();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(b);
    }
  }
  return out;
}

function computeManifestHash(manifest: {
  actorUserId: string;
  backfillLegacyAdmins: boolean;
  grantUserIds: bigint[];
  terminateStaffIds: bigint[];
}): string {
  const canonical = JSON.stringify({
    actorUserId: manifest.actorUserId,
    backfillLegacyAdmins: manifest.backfillLegacyAdmins,
    grantUserIds: manifest.grantUserIds.map((x) => x.toString()).sort(),
    terminateStaffIds: manifest.terminateStaffIds.map((x) => x.toString()).sort(),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function resolveLiveDatabaseContext(tx: any): Promise<{ targetDatabase: string; databaseName: string }> {
  const dbUrl = new URL(process.env.DATABASE_URL || 'postgresql://localhost/unknown');
  const targetDatabase = `${dbUrl.hostname}${dbUrl.pathname}`;
  let databaseName = dbUrl.pathname.replace(/^\//, '') || 'unknown';
  if (typeof tx?.$queryRaw === 'function') {
    const rows: any[] = await tx.$queryRaw`SELECT current_database() AS db_name`;
    if (rows?.[0]?.db_name) {
      databaseName = String(rows[0].db_name);
    }
  }
  return { targetDatabase, databaseName };
}

function sameInstant(a: Date | string | null | undefined, b: Date | string | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

function normalizeIsoOrNull(val: Date | string | null | undefined): string | null {
  if (val == null) return null;
  return new Date(val).toISOString();
}

function computeRollbackPayloadDigest(artifact: Step7RollbackArtifact): string {
  const canonical = {
    batchId: String(artifact.batchId),
    generatedAt: normalizeIsoOrNull(artifact.generatedAt),
    targetDatabase: String(artifact.targetDatabase),
    databaseName: String(artifact.databaseName),
    manifestVersion: String(artifact.manifestVersion),
    manifestHash: String(artifact.manifestHash),
    actorUserId: String(artifact.actorUserId),
    executedAt: normalizeIsoOrNull(artifact.executedAt),
    platformMemberships: [...(artifact.platformMemberships || [])]
      .map((pm) => ({
        membershipId: String(pm.membershipId),
        userId: String(pm.userId),
        roleId: String(pm.roleId),
        roleCode: String(pm.roleCode),
        existedBefore: Boolean(pm.existedBefore),
        previousStatus: pm.previousStatus ?? null,
        previousGrantedByUserId: pm.previousGrantedByUserId ?? null,
        previousGrantedAt: normalizeIsoOrNull(pm.previousGrantedAt),
        previousRevokedAt: normalizeIsoOrNull(pm.previousRevokedAt),
        previousRevokedByUserId: pm.previousRevokedByUserId ?? null,
        expectedAfterStatus: String(pm.expectedAfterStatus),
        expectedAfterGrantedAt: normalizeIsoOrNull(pm.expectedAfterGrantedAt),
        expectedAfterRevokedAt: normalizeIsoOrNull(pm.expectedAfterRevokedAt),
        expectedAfterUpdatedAt: normalizeIsoOrNull(pm.expectedAfterUpdatedAt),
      }))
      .sort((a, b) =>
        BigInt(a.membershipId) < BigInt(b.membershipId) ? -1 : BigInt(a.membershipId) > BigInt(b.membershipId) ? 1 : 0,
      ),
    storeStaffs: [...(artifact.storeStaffs || [])]
      .map((ss) => ({
        storeStaffId: String(ss.storeStaffId),
        userId: String(ss.userId),
        storeId: String(ss.storeId),
        roleCode: String(ss.roleCode),
        previousStatus: String(ss.previousStatus),
        previousLeftAt: normalizeIsoOrNull(ss.previousLeftAt),
        expectedAfterStatus: String(ss.expectedAfterStatus),
        expectedAfterLeftAt: normalizeIsoOrNull(ss.expectedAfterLeftAt),
        expectedAfterUpdatedAt: normalizeIsoOrNull(ss.expectedAfterUpdatedAt),
      }))
      .sort((a, b) =>
        BigInt(a.storeStaffId) < BigInt(b.storeStaffId) ? -1 : BigInt(a.storeStaffId) > BigInt(b.storeStaffId) ? 1 : 0,
      ),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export async function executeStep7Transition(
  prisma: PrismaClient,
  manifest: Step7TransitionManifest,
  options?: { dryRun?: boolean },
): Promise<Step7ExecutionResult> {
  const dryRun = options?.dryRun !== false;
  const actorUserId = BigInt(manifest.actorUserId);
  const backfillLegacyAdmins = manifest.backfillLegacyAdmins !== false;
  const grantUserIds = uniqueBigInts(manifest.grantSystemStaffUserIds || []);
  const terminateStaffIds = uniqueBigInts(manifest.terminateStoreStaffIds || []);
  const manifestHash = computeManifestHash({
    actorUserId: actorUserId.toString(),
    backfillLegacyAdmins,
    grantUserIds,
    terminateStaffIds,
  });

  // Pre-read consistent snapshot first for global operational blockers & expectedBefore validation
  const beforeReport = await runStep7InventoryReport(prisma);

  if (!manifest.allowUnsettledLegacyDelivery) {
    if (beforeReport.summary.legacyShippingOrdersNeedingTakeoverCount > 0) {
      throw new Error(
        `PRECONDITION_FAILED: ${beforeReport.summary.legacyShippingOrdersNeedingTakeoverCount} in-flight SHIPPING orders still assigned to non-owner drivers. Settle or pass allowUnsettledLegacyDelivery=true.`,
      );
    }
    if (beforeReport.summary.unsettledLegacyDriverShiftsCount > 0) {
      throw new Error(
        `PRECONDITION_FAILED: ${beforeReport.summary.unsettledLegacyDriverShiftsCount} driver shifts (OPEN/CLOSED) are not handed over yet. Settle or pass allowUnsettledLegacyDelivery=true.`,
      );
    }
  }

  return prisma.$transaction(
    async (tx) => {
      if (dryRun && typeof (tx as any).$executeRawUnsafe === 'function') {
        await (tx as any).$executeRawUnsafe('SET TRANSACTION READ ONLY');
      }

      const { targetDatabase, databaseName } = await resolveLiveDatabaseContext(tx);

      const systemStaffRole = await tx.role.findUnique({ where: { roleCode: 'SYSTEM_STAFF' } });
      if (!systemStaffRole) {
        throw new Error('PRECONDITION_FAILED: SYSTEM_STAFF role missing from roles table');
      }

      // Phase 1 (Discovery ONLY): Collect candidate userIds before acquiring row locks
      const discoveryStaffRows = terminateStaffIds.length
        ? await tx.storeStaff.findMany({
          where: { storeStaffId: { in: terminateStaffIds } },
          select: { storeStaffId: true, userId: true },
        })
        : [];
      const discoveryLegacyAdmins = backfillLegacyAdmins
        ? await tx.storeStaff.findMany({
          where: {
            status: 'ACTIVE',
            role: { roleCode: { in: [...ADMIN_GOVERNANCE_ROLES] } },
          },
          select: { userId: true, user: { select: { status: true } } },
        })
        : [];
      const discoveryLegacyAdminUserStatus = new Map<string, string>();
      for (const row of discoveryLegacyAdmins) {
        if (row.user?.status) {
          discoveryLegacyAdminUserStatus.set(row.userId.toString(), row.user.status);
        }
      }

      const allAffectedUserIds = uniqueBigInts([
        actorUserId,
        ...grantUserIds,
        ...discoveryStaffRows.map((r) => r.userId),
        ...discoveryLegacyAdmins.map((r) => r.userId),
      ]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      // Phase 2: Acquire ascending user locks BEFORE reading authoritative state/memberships for decisions
      const watermarks = new Map<string, Date | null>();
      const lockedUserIdSet = new Set<string>();
      if (!dryRun) {
        for (const uid of allAffectedUserIds) {
          watermarks.set(uid.toString(), await lockUserForWatermark(tx, uid));
          lockedUserIdSet.add(uid.toString());
        }
      }

      // Phase 3: Re-read ALL users, memberships & staff rows AFTER locks are held and derive all decisions from post-lock state
      const grantUsers = grantUserIds.length
        ? await tx.user.findMany({
          where: { userId: { in: grantUserIds } },
          select: {
            userId: true,
            email: true,
            username: true,
            status: true,
            ownedStores: { where: { status: 'ACTIVE' }, select: { storeId: true } },
            platformMemberships: { where: { status: 'ACTIVE' }, include: { role: true } },
          },
        })
        : [];
      const grantUsersMap = new Map(grantUsers.map((u) => [u.userId.toString(), u]));

      for (const uid of grantUserIds) {
        const u = grantUsersMap.get(uid.toString());
        if (!u) {
          throw new Error(`PRECONDITION_FAILED: SYSTEM_STAFF candidate userId=${uid} does not exist`);
        }
        if (u.status !== 'ACTIVE') {
          throw new Error(`PRECONDITION_FAILED: SYSTEM_STAFF candidate userId=${uid} has status=${u.status} (expected ACTIVE)`);
        }
        if (
          isBootstrapSuperAdmin(u) ||
          u.platformMemberships.some((m) => (ADMIN_GOVERNANCE_ROLES as readonly string[]).includes(m.role.roleCode))
        ) {
          throw new Error(
            `PRECONDITION_FAILED: Refusing to assign SYSTEM_STAFF to active ADMIN/SUPER_ADMIN userId=${uid}`,
          );
        }
        if (!manifest.allowStoreOwnerDualRole && u.ownedStores.length > 0) {
          throw new Error(
            `PRECONDITION_FAILED: Candidate userId=${uid} owns active store(s); assigning SYSTEM_STAFF would override STORE_OWNER authority unless allowStoreOwnerDualRole=true`,
          );
        }
      }

      const targetStaffRows = terminateStaffIds.length
        ? await tx.storeStaff.findMany({
          where: { storeStaffId: { in: terminateStaffIds } },
          include: { role: true, user: { select: { userId: true, status: true, email: true, username: true } } },
        })
        : [];
      const targetStaffMap = new Map(targetStaffRows.map((r) => [r.storeStaffId.toString(), r]));

      for (const sid of terminateStaffIds) {
        const row = targetStaffMap.get(sid.toString());
        if (!row) {
          throw new Error(`PRECONDITION_FAILED: terminateStoreStaffIds contains non-existent storeStaffId=${sid}`);
        }
        if (!dryRun && !lockedUserIdSet.has(row.userId.toString())) {
          throw new Error(
            `CONCURRENCY_CONFLICT: storeStaffId=${sid} points to unlocked userId=${row.userId}; retry transition`,
          );
        }
        if (row.role.roleCode === 'STORE_OWNER') {
          throw new Error(
            `PRECONDITION_FAILED: Forbidden termination of STORE_OWNER membership storeStaffId=${sid} (userId=${row.userId})`,
          );
        }
        if (
          row.status === 'ACTIVE' &&
          (ADMIN_GOVERNANCE_ROLES as readonly string[]).includes(row.role.roleCode) &&
          !backfillLegacyAdmins
        ) {
          throw new Error(
            `PRECONDITION_FAILED: Cannot terminate active legacy admin storeStaffId=${sid} without backfillLegacyAdmins=true`,
          );
        }
      }

      const postLockLegacyAdminRows = backfillLegacyAdmins
        ? await tx.storeStaff.findMany({
          where: {
            status: 'ACTIVE',
            role: { roleCode: { in: [...ADMIN_GOVERNANCE_ROLES] } },
          },
          include: { role: true, user: { select: { userId: true, status: true } } },
          orderBy: [{ userId: 'asc' }, { storeStaffId: 'asc' }],
        })
        : [];

      const eligibleLegacyAdmins = [];
      for (const row of postLockLegacyAdminRows) {
        const uidStr = row.userId.toString();
        if (!dryRun && !lockedUserIdSet.has(uidStr)) {
          throw new Error(
            `CONCURRENCY_CONFLICT: Active legacy admin userId=${uidStr} appeared after lock acquisition; retry transition`,
          );
        }
        const postUserStatus = row.user?.status || 'ACTIVE';
        if (postUserStatus !== 'ACTIVE') {
          if (discoveryLegacyAdminUserStatus.get(uidStr) === 'ACTIVE') {
            throw new Error(
              `CONCURRENCY_CONFLICT: Legacy admin userId=${uidStr} changed account status to ${postUserStatus} concurrently`,
            );
          }
          continue;
        }
        eligibleLegacyAdmins.push(row);
      }

      const legacyAdminUserIds = uniqueBigInts(eligibleLegacyAdmins.map((r) => r.userId));
      const affectedCandidateUserIds = uniqueBigInts([...legacyAdminUserIds, ...grantUserIds]);
      const existingActiveMemberships = affectedCandidateUserIds.length
        ? await tx.platformMembership.findMany({
          where: { userId: { in: affectedCandidateUserIds }, status: 'ACTIVE' },
          include: { role: true },
          orderBy: { membershipId: 'desc' },
        })
        : [];

      const adminDecisions = resolveLegacyAdminBackfillDecisions(
        eligibleLegacyAdmins.map((r) => ({
          storeStaffId: r.storeStaffId.toString(),
          userId: r.userId.toString(),
          storeId: r.storeId.toString(),
          roleId: r.roleId.toString(),
          roleCode: r.role.roleCode,
        })),
        existingActiveMemberships.map((pm) => ({
          membershipId: pm.membershipId.toString(),
          userId: pm.userId.toString(),
          roleId: pm.roleId.toString(),
          roleCode: pm.role.roleCode,
        })),
      );

      // Guard: refuse granting SYSTEM_STAFF to a user whose legacy admin row is simultaneously backfilled (uq_platform_memberships_active_user)
      const adminDecisionUsersSet = new Set(adminDecisions.map((d) => d.userId));
      for (const uid of grantUserIds) {
        if (adminDecisionUsersSet.has(uid.toString())) {
          throw new Error(
            `PRECONDITION_FAILED: User userId=${uid} has active legacy ADMIN role in store_staff; cannot simultaneously assign SYSTEM_STAFF due to single active platform_membership invariant`,
          );
        }
      }

      const batchId = crypto.randomUUID();
      const now = new Date();
      const adminResults: Step7ExecutionResult['actions']['backfilledAdmins'] = [];
      const grantResults: Step7ExecutionResult['actions']['grantedSystemStaff'] = [];
      const staffResults: Step7ExecutionResult['actions']['terminatedStoreStaff'] = [];

      const rollbackArtifact: Step7RollbackArtifact = {
        batchId,
        generatedAt: now.toISOString(),
        targetDatabase,
        databaseName,
        manifestVersion: manifest.manifestVersion || '2026-11-18.1',
        manifestHash,
        actorUserId: actorUserId.toString(),
        executedAt: now.toISOString(),
        platformMemberships: [],
        storeStaffs: [],
      };

      const sessionInvalidatedUserIds = new Set<string>();
      let hasAnyPendingChange = false;

      const findRevokedReusableMembership = async (userId: bigint, roleId: bigint) => {
        return tx.platformMembership.findFirst({
          where: { userId, roleId, status: { not: 'ACTIVE' } },
          orderBy: { membershipId: 'desc' },
        });
      };

      const activateSinglePlatformMembership = async (
        userId: bigint,
        targetRoleId: bigint,
        targetRoleCode: string,
        auditAction: 'STEP7_MIGRATE_ADMIN_MEMBERSHIP' | 'STEP7_GRANT_SYSTEM_STAFF',
        auditReason: string,
      ) => {
        const reusable = await findRevokedReusableMembership(userId, targetRoleId);
        const savedPm = reusable
          ? await tx.platformMembership.update({
            where: { membershipId: reusable.membershipId },
            data: {
              status: 'ACTIVE',
              grantedByUserId: actorUserId,
              grantedAt: now,
              revokedAt: null,
              revokedByUserId: null,
            },
          })
          : await tx.platformMembership.create({
            data: {
              userId,
              roleId: targetRoleId,
              status: 'ACTIVE',
              grantedByUserId: actorUserId,
              grantedAt: now,
            },
          });

        rollbackArtifact.platformMemberships.push({
          membershipId: savedPm.membershipId.toString(),
          userId: userId.toString(),
          roleId: targetRoleId.toString(),
          roleCode: targetRoleCode,
          existedBefore: Boolean(reusable),
          previousStatus: reusable?.status || null,
          previousGrantedByUserId: reusable?.grantedByUserId?.toString() || null,
          previousGrantedAt: reusable?.grantedAt?.toISOString() || null,
          previousRevokedAt: reusable?.revokedAt?.toISOString() || null,
          previousRevokedByUserId: reusable?.revokedByUserId?.toString() || null,
          expectedAfterStatus: savedPm.status,
          expectedAfterGrantedAt: savedPm.grantedAt.toISOString(),
          expectedAfterRevokedAt: savedPm.revokedAt ? savedPm.revokedAt.toISOString() : null,
          expectedAfterUpdatedAt: savedPm.updatedAt.toISOString(),
        });

        await tx.rentalAuditLog.create({
          data: {
            actorType: 'ADMIN',
            actorUserId,
            action: auditAction,
            targetType: 'PLATFORM_MEMBERSHIP',
            targetId: savedPm.membershipId,
            beforeState: reusable?.status || 'NONE',
            afterState: 'ACTIVE',
            reason: auditReason,
            metadata: { batchId, userId: userId.toString(), roleCode: targetRoleCode },
          },
        });

        sessionInvalidatedUserIds.add(userId.toString());
        return { savedPm, reactivated: Boolean(reusable) };
      };

      // 1) Process unified single-membership-per-user Admin backfill plan
      for (const d of adminDecisions) {
        const uid = BigInt(d.userId);
        const targetRoleId = BigInt(d.targetRoleId);

        if (d.decision === 'ALREADY_SATISFIED') {
          adminResults.push({
            userId: d.userId,
            roleCode: d.existingActiveRoleCode || d.targetRoleCode,
            outcome: 'ALREADY_ACTIVE',
          });
          continue;
        }

        hasAnyPendingChange = true;
        if (dryRun) {
          if (d.decision === 'UPGRADE_ACTIVE') {
            adminResults.push({
              userId: d.userId,
              roleCode: d.targetRoleCode,
              replacedActiveRoleCode: d.existingActiveRoleCode,
              outcome: 'WOULD_UPGRADE',
            });
          } else {
            const reusable = await findRevokedReusableMembership(uid, targetRoleId);
            adminResults.push({
              userId: d.userId,
              roleCode: d.targetRoleCode,
              outcome: reusable ? 'WOULD_REACTIVATE' : 'WOULD_GRANT',
            });
          }
          continue;
        }

        if (d.decision === 'UPGRADE_ACTIVE' && d.existingActiveMembershipId) {
          const prevActive = await tx.platformMembership.findUnique({
            where: { membershipId: BigInt(d.existingActiveMembershipId) },
            include: { role: true },
          });
          if (prevActive && prevActive.status === 'ACTIVE') {
            const revokedPrev = await tx.platformMembership.update({
              where: { membershipId: prevActive.membershipId },
              data: {
                status: 'REVOKED',
                revokedByUserId: actorUserId,
                revokedAt: now,
              },
            });
            rollbackArtifact.platformMemberships.push({
              membershipId: revokedPrev.membershipId.toString(),
              userId: d.userId,
              roleId: prevActive.roleId.toString(),
              roleCode: prevActive.role.roleCode,
              existedBefore: true,
              previousStatus: prevActive.status,
              previousGrantedByUserId: prevActive.grantedByUserId?.toString() || null,
              previousGrantedAt: prevActive.grantedAt.toISOString(),
              previousRevokedAt: prevActive.revokedAt ? prevActive.revokedAt.toISOString() : null,
              previousRevokedByUserId: prevActive.revokedByUserId?.toString() || null,
              expectedAfterStatus: revokedPrev.status,
              expectedAfterGrantedAt: revokedPrev.grantedAt.toISOString(),
              expectedAfterRevokedAt: revokedPrev.revokedAt ? revokedPrev.revokedAt.toISOString() : null,
              expectedAfterUpdatedAt: revokedPrev.updatedAt.toISOString(),
            });
          }
        }

        const { reactivated } = await activateSinglePlatformMembership(
          uid,
          targetRoleId,
          d.targetRoleCode,
          'STEP7_MIGRATE_ADMIN_MEMBERSHIP',
          'Bước 7: Đồng bộ quyền quản trị cao nhất từ store_staff sang platform_memberships',
        );

        adminResults.push({
          userId: d.userId,
          roleCode: d.targetRoleCode,
          ...(d.decision === 'UPGRADE_ACTIVE' ? { replacedActiveRoleCode: d.existingActiveRoleCode } : {}),
          outcome: d.decision === 'UPGRADE_ACTIVE' ? 'UPGRADED' : reactivated ? 'REACTIVATED' : 'GRANTED',
        });
      }

      // 2) Process SYSTEM_STAFF grants (checked against ALL ACTIVE memberships for the user)
      for (const uid of grantUserIds) {
        const activeForUser = existingActiveMemberships.find((pm) => pm.userId === uid);
        if (activeForUser) {
          if (activeForUser.role.roleCode === 'SYSTEM_STAFF') {
            grantResults.push({ userId: uid.toString(), outcome: 'ALREADY_ACTIVE' });
            continue;
          }
          throw new Error(
            `PRECONDITION_FAILED: User userId=${uid} already holds ACTIVE platform membership (${activeForUser.role.roleCode})`,
          );
        }

        hasAnyPendingChange = true;
        if (dryRun) {
          const reusable = await findRevokedReusableMembership(uid, systemStaffRole.roleId);
          grantResults.push({
            userId: uid.toString(),
            outcome: reusable ? 'WOULD_REACTIVATE' : 'WOULD_GRANT',
          });
          continue;
        }

        const { reactivated } = await activateSinglePlatformMembership(
          uid,
          systemStaffRole.roleId,
          'SYSTEM_STAFF',
          'STEP7_GRANT_SYSTEM_STAFF',
          'Bước 7: Cấp role SYSTEM_STAFF theo danh sách chuyển quyền được duyệt',
        );
        grantResults.push({
          userId: uid.toString(),
          outcome: reactivated ? 'REACTIVATED' : 'GRANTED',
        });
      }

      // 3) Process store_staff terminations
      for (const sid of terminateStaffIds) {
        const latestRow = await tx.storeStaff.findUnique({
          where: { storeStaffId: sid },
          include: { role: true },
        });
        if (!latestRow) {
          throw new Error(`PRECONDITION_FAILED: storeStaffId=${sid} vanished during execution`);
        }
        if (latestRow.status === 'TERMINATED') {
          staffResults.push({
            storeStaffId: sid.toString(),
            userId: latestRow.userId.toString(),
            roleCode: latestRow.role.roleCode,
            outcome: 'ALREADY_TERMINATED',
          });
          continue;
        }
        hasAnyPendingChange = true;
        if (dryRun) {
          staffResults.push({
            storeStaffId: sid.toString(),
            userId: latestRow.userId.toString(),
            roleCode: latestRow.role.roleCode,
            outcome: 'WOULD_TERMINATE',
          });
          continue;
        }

        const updatedRow = await tx.storeStaff.update({
          where: { storeStaffId: latestRow.storeStaffId },
          data: {
            status: 'TERMINATED',
            leftAt: latestRow.leftAt ?? now,
          },
        });

        rollbackArtifact.storeStaffs.push({
          storeStaffId: updatedRow.storeStaffId.toString(),
          userId: updatedRow.userId.toString(),
          storeId: updatedRow.storeId.toString(),
          roleCode: latestRow.role.roleCode,
          previousStatus: latestRow.status,
          previousLeftAt: latestRow.leftAt ? latestRow.leftAt.toISOString() : null,
          expectedAfterStatus: updatedRow.status,
          expectedAfterLeftAt: updatedRow.leftAt ? updatedRow.leftAt.toISOString() : null,
          expectedAfterUpdatedAt: updatedRow.updatedAt.toISOString(),
        });

        await tx.rentalAuditLog.create({
          data: {
            actorType: 'ADMIN',
            actorUserId,
            action: 'STEP7_TERMINATE_STORE_STAFF',
            targetType: 'STORE_STAFF',
            targetId: latestRow.storeStaffId,
            beforeState: latestRow.status,
            afterState: 'TERMINATED',
            reason: 'Bước 7: Ngừng membership store_staff/shipper cũ (giữ toàn vẹn lịch sử & FK)',
            metadata: {
              batchId,
              storeId: latestRow.storeId.toString(),
              userId: latestRow.userId.toString(),
              roleCode: latestRow.role.roleCode,
            },
          },
        });

        if (latestRow.status === 'ACTIVE') {
          sessionInvalidatedUserIds.add(latestRow.userId.toString());
        }

        staffResults.push({
          storeStaffId: sid.toString(),
          userId: latestRow.userId.toString(),
          roleCode: latestRow.role.roleCode,
          outcome: 'TERMINATED',
        });
      }

      // Check manifest expectedBefore ONLY when pending mutations remain (idempotent replays stay NO-OP cleanly)
      if (hasAnyPendingChange && manifest.expectedBefore) {
        const exp = manifest.expectedBefore;
        if (
          exp.activeStoresCount !== undefined &&
          exp.activeStoresCount !== beforeReport.summary.activeStoresCount
        ) {
          throw new Error(
            `PRECONDITION_FAILED: activeStoresCount mismatch (expected=${exp.activeStoresCount}, actual=${beforeReport.summary.activeStoresCount})`,
          );
        }
        if (
          exp.deprecatedStoreStaffCount !== undefined &&
          exp.deprecatedStoreStaffCount !== beforeReport.summary.deprecatedStoreStaffCount
        ) {
          throw new Error(
            `PRECONDITION_FAILED: deprecatedStoreStaffCount mismatch (expected=${exp.deprecatedStoreStaffCount}, actual=${beforeReport.summary.deprecatedStoreStaffCount})`,
          );
        }
        if (
          exp.storeOwnerMembershipCount !== undefined &&
          exp.storeOwnerMembershipCount !== beforeReport.summary.storeOwnerMembershipCount
        ) {
          throw new Error(
            `PRECONDITION_FAILED: storeOwnerMembershipCount mismatch (expected=${exp.storeOwnerMembershipCount}, actual=${beforeReport.summary.storeOwnerMembershipCount})`,
          );
        }
        if (exp.legacyAdminsNeedingPlatformMembershipCount !== undefined) {
          const postLockNeedingCount = adminDecisions.filter((d) => d.decision !== 'ALREADY_SATISFIED').length;
          if (
            exp.legacyAdminsNeedingPlatformMembershipCount !==
              beforeReport.summary.legacyAdminsNeedingPlatformMembershipCount ||
            exp.legacyAdminsNeedingPlatformMembershipCount !== postLockNeedingCount
          ) {
            throw new Error(
              `PRECONDITION_FAILED: legacyAdminsNeedingPlatformMembershipCount mismatch (expected=${exp.legacyAdminsNeedingPlatformMembershipCount}, preLock=${beforeReport.summary.legacyAdminsNeedingPlatformMembershipCount}, postLock=${postLockNeedingCount})`,
            );
          }
        }
      }

      const invalidatedList = [...sessionInvalidatedUserIds].sort((a, b) =>
        BigInt(a) < BigInt(b) ? -1 : 1,
      );

      if (!dryRun && hasAnyPendingChange) {
        for (const uidStr of invalidatedList) {
          const uid = BigInt(uidStr);
          await tx.refreshToken.updateMany({
            where: { userId: uid, isRevoked: false },
            data: { isRevoked: true },
          });
          await advanceMonotonicTokensInvalidBefore(tx, uid, watermarks.get(uidStr) ?? null, now);
        }

        // Persist durable batch & rollback payload inside the SAME database transaction (MANDATORY; no silent skip)
        await tx.roleTransitionBatch.create({
          data: {
            batchId,
            targetDatabase,
            databaseName,
            manifestVersion: rollbackArtifact.manifestVersion,
            manifestHash,
            actorUserId,
            status: 'EXECUTED',
            rollbackPayload: rollbackArtifact as unknown as Prisma.InputJsonValue,
            executedAt: now,
          },
        });
      }

      return {
        batchId: !dryRun && hasAnyPendingChange ? batchId : null,
        dryRun,
        idempotentNoOp: !hasAnyPendingChange,
        targetDatabase,
        databaseName,
        manifestHash,
        preconditionsPassed: true,
        actions: {
          backfilledAdmins: adminResults,
          grantedSystemStaff: grantResults,
          terminatedStoreStaff: staffResults,
          revokedSessionUserIds: invalidatedList,
        },
        rollbackArtifact: !dryRun && hasAnyPendingChange ? rollbackArtifact : null,
      };
    },
    dryRun
      ? { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      : { timeout: 30_000 },
  );
}

export async function exportStep7BatchRollback(
  prisma: PrismaClient,
  batchId: string,
): Promise<Step7RollbackArtifact> {
  const batch = await prisma.roleTransitionBatch.findUnique({
    where: { batchId },
  });
  if (!batch) {
    throw new Error(`ROLLBACK_BATCH_NOT_FOUND: No Step 7 batch found for batchId=${batchId}`);
  }
  return batch.rollbackPayload as unknown as Step7RollbackArtifact;
}

export async function rollbackStep7Transition(
  prisma: PrismaClient,
  artifactOrBatchId: Step7RollbackArtifact | { batchId: string },
  options?: { dryRun?: boolean; actorUserId?: string },
) {
  const dryRun = options?.dryRun !== false;
  const fileArtifact = 'platformMemberships' in artifactOrBatchId ? artifactOrBatchId : null;
  const batchId = fileArtifact ? fileArtifact.batchId : artifactOrBatchId.batchId;

  if (!batchId) {
    throw new Error('ROLLBACK_TARGET_MISMATCH: Rollback input missing mandatory batchId');
  }
  if (
    fileArtifact &&
    (!fileArtifact.targetDatabase || !fileArtifact.databaseName || !fileArtifact.manifestHash)
  ) {
    throw new Error(
      'ROLLBACK_TARGET_MISMATCH: Rollback artifact missing mandatory batchId/targetDatabase/databaseName/manifestHash bindings',
    );
  }

  const now = new Date();

  return prisma.$transaction(
    async (tx) => {
      if (dryRun && typeof (tx as any).$executeRawUnsafe === 'function') {
        await (tx as any).$executeRawUnsafe('SET TRANSACTION READ ONLY');
      }

      // 1. Validate database & load mandatory persisted batch dossier FIRST (in both dry-run and execute)
      const { targetDatabase, databaseName } = await resolveLiveDatabaseContext(tx);
      if (
        fileArtifact &&
        (targetDatabase !== fileArtifact.targetDatabase || databaseName !== fileArtifact.databaseName)
      ) {
        throw new Error(
          `ROLLBACK_TARGET_MISMATCH: Rollback artifact belongs to ${fileArtifact.targetDatabase} (db=${fileArtifact.databaseName}), refusing execution on ${targetDatabase} (db=${databaseName})`,
        );
      }

      const batchRecord = await tx.roleTransitionBatch.findUnique({
        where: { batchId },
      });
      if (!batchRecord) {
        throw new Error(
          `ROLLBACK_BATCH_NOT_FOUND: Batch ${batchId} does not exist on target database ${targetDatabase}`,
        );
      }
      if (batchRecord.status !== 'EXECUTED') {
        throw new Error(
          `ROLLBACK_BATCH_ALREADY_REVERTED: Batch ${batchId} has status=${batchRecord.status}`,
        );
      }
      if (batchRecord.targetDatabase !== targetDatabase || batchRecord.databaseName !== databaseName) {
        throw new Error(
          `ROLLBACK_TARGET_MISMATCH: Batch ${batchId} belongs to ${batchRecord.targetDatabase} (db=${batchRecord.databaseName}), refusing execution on ${targetDatabase} (db=${databaseName})`,
        );
      }

      const persistedArtifact = batchRecord.rollbackPayload as unknown as Step7RollbackArtifact | null;
      if (
        !persistedArtifact ||
        typeof persistedArtifact !== 'object' ||
        !Array.isArray(persistedArtifact.platformMemberships) ||
        !Array.isArray(persistedArtifact.storeStaffs) ||
        persistedArtifact.batchId !== batchRecord.batchId ||
        persistedArtifact.targetDatabase !== batchRecord.targetDatabase ||
        persistedArtifact.databaseName !== batchRecord.databaseName ||
        persistedArtifact.manifestHash !== batchRecord.manifestHash
      ) {
        throw new Error(
          `ROLLBACK_PAYLOAD_MISMATCH: Persisted batch dossier for ${batchId} is missing or corrupted`,
        );
      }

      if (fileArtifact) {
        if (
          batchRecord.targetDatabase !== fileArtifact.targetDatabase ||
          batchRecord.databaseName !== fileArtifact.databaseName ||
          batchRecord.manifestHash !== fileArtifact.manifestHash
        ) {
          throw new Error(
            `ROLLBACK_TARGET_MISMATCH: Batch ${batchId} metadata mismatch against persisted batch dossier`,
          );
        }
        if (computeRollbackPayloadDigest(fileArtifact) !== computeRollbackPayloadDigest(persistedArtifact)) {
          throw new Error(
            `ROLLBACK_PAYLOAD_MISMATCH: Rollback file content does not match persisted batch dossier for batch ${batchId}`,
          );
        }
      }

      // Execute exclusively from DB `rollbackPayload` (authoritative source of truth)
      const artifact = persistedArtifact;
      const actorUserId = BigInt(options?.actorUserId || artifact.actorUserId);
      const userIds = uniqueBigInts([
        actorUserId,
        ...artifact.platformMemberships.map((p) => p.userId),
        ...artifact.storeStaffs.map((s) => s.userId),
      ]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      const watermarks = new Map<string, Date | null>();
      if (!dryRun) {
        for (const uid of userIds) {
          watermarks.set(uid.toString(), await lockUserForWatermark(tx, uid));
        }
      }

      // 2. Verify row identities AND post-cutover CAS expectations in BOTH dryRun and execute!
      const identityErrors: string[] = [];
      const driftConflicts: string[] = [];

      for (const ss of artifact.storeStaffs) {
        const sid = BigInt(ss.storeStaffId);
        const cur = await tx.storeStaff.findUnique({
          where: { storeStaffId: sid },
          include: { role: true },
        });
        if (!cur) {
          identityErrors.push(`store_staff#${ss.storeStaffId}: missing`);
          continue;
        }
        if (
          cur.userId.toString() !== ss.userId ||
          cur.storeId.toString() !== ss.storeId ||
          cur.role.roleCode !== ss.roleCode
        ) {
          identityErrors.push(
            `store_staff#${ss.storeStaffId}: identity mismatch (expected user=${ss.userId}/store=${ss.storeId}/role=${ss.roleCode}, found user=${cur.userId}/store=${cur.storeId}/role=${cur.role.roleCode})`,
          );
          continue;
        }

        if (
          cur.status !== ss.expectedAfterStatus ||
          !sameInstant(cur.leftAt, ss.expectedAfterLeftAt) ||
          !sameInstant(cur.updatedAt, ss.expectedAfterUpdatedAt)
        ) {
          driftConflicts.push(
            `store_staff#${ss.storeStaffId}: modified post-cutover (expected status=${ss.expectedAfterStatus}/updatedAt=${ss.expectedAfterUpdatedAt}, found status=${cur.status}/updatedAt=${cur.updatedAt.toISOString()})`,
          );
        }
      }

      // Track memberships belonging to this batch per user so we can verify no unrelated ACTIVE row blocks rollback
      const batchActiveAfterIdsByUser = new Map<string, Set<string>>();
      for (const pm of artifact.platformMemberships) {
        if (pm.expectedAfterStatus === 'ACTIVE') {
          const s = batchActiveAfterIdsByUser.get(pm.userId) || new Set<string>();
          s.add(pm.membershipId);
          batchActiveAfterIdsByUser.set(pm.userId, s);
        }
      }

      for (const pm of artifact.platformMemberships) {
        const mid = BigInt(pm.membershipId);
        const cur = await tx.platformMembership.findUnique({
          where: { membershipId: mid },
          include: { role: true },
        });
        if (!cur) {
          identityErrors.push(`platform_membership#${pm.membershipId}: missing`);
          continue;
        }
        if (cur.userId.toString() !== pm.userId || cur.role.roleCode !== pm.roleCode) {
          identityErrors.push(
            `platform_membership#${pm.membershipId}: identity mismatch (expected user=${pm.userId}/role=${pm.roleCode}, found user=${cur.userId}/role=${cur.role.roleCode})`,
          );
          continue;
        }

        if (
          cur.status !== pm.expectedAfterStatus ||
          !sameInstant(cur.grantedAt, pm.expectedAfterGrantedAt) ||
          !sameInstant(cur.revokedAt, pm.expectedAfterRevokedAt) ||
          !sameInstant(cur.updatedAt, pm.expectedAfterUpdatedAt)
        ) {
          driftConflicts.push(
            `platform_membership#${pm.membershipId}: modified post-cutover (expected status=${pm.expectedAfterStatus}/updatedAt=${pm.expectedAfterUpdatedAt}, found status=${cur.status}/updatedAt=${cur.updatedAt.toISOString()})`,
          );
        }

        const targetStatus = pm.existedBefore && pm.previousStatus ? pm.previousStatus : 'REVOKED';
        if (targetStatus === 'ACTIVE') {
          const conflictingActive = await tx.platformMembership.findMany({
            where: { userId: BigInt(pm.userId), status: 'ACTIVE' },
            select: { membershipId: true },
          });
          const batchSet = batchActiveAfterIdsByUser.get(pm.userId) || new Set<string>();
          const unrelated = conflictingActive.filter(
            (x) => x.membershipId.toString() !== pm.membershipId && !batchSet.has(x.membershipId.toString()),
          );
          if (unrelated.length > 0) {
            driftConflicts.push(
              `platform_membership#${pm.membershipId}: userId=${pm.userId} acquired unrelated ACTIVE membership #${unrelated[0].membershipId} post-cutover`,
            );
          }
        }
      }

      if (identityErrors.length > 0) {
        throw new Error(`ROLLBACK_IDENTITY_MISMATCH: ${identityErrors.join('; ')}`);
      }
      if (driftConflicts.length > 0) {
        throw new Error(`ROLLBACK_DRIFT_CONFLICT: ${driftConflicts.join('; ')}`);
      }

      if (dryRun) {
        return {
          dryRun: true,
          readyToRollback: true,
          batchId: artifact.batchId,
          targetDatabase,
          databaseName,
          wouldRestoreStoreStaffCount: artifact.storeStaffs.length,
          wouldRevertPlatformMembershipCount: artifact.platformMemberships.length,
        };
      }

      // 3. Execute atomic CAS rollback: revoke post-cutover ACTIVE memberships FIRST before reactivating any pre-cutover ACTIVE ones!
      let restoredStaffCount = 0;
      let revertedMembershipCount = 0;
      const revokedSessionUserIds = new Set<string>();

      for (const ss of artifact.storeStaffs) {
        const sid = BigInt(ss.storeStaffId);
        const cas = await tx.storeStaff.updateMany({
          where: {
            storeStaffId: sid,
            userId: BigInt(ss.userId),
            storeId: BigInt(ss.storeId),
            status: ss.expectedAfterStatus,
            updatedAt: new Date(ss.expectedAfterUpdatedAt),
          },
          data: {
            status: ss.previousStatus,
            leftAt: ss.previousLeftAt ? new Date(ss.previousLeftAt) : null,
          },
        });
        if (cas.count !== 1) {
          throw new Error(
            `ROLLBACK_DRIFT_CONFLICT: CAS failed on store_staff#${ss.storeStaffId} during rollback execution`,
          );
        }
        await tx.rentalAuditLog.create({
          data: {
            actorType: 'ADMIN',
            actorUserId,
            action: 'STEP7_ROLLBACK_STORE_STAFF',
            targetType: 'STORE_STAFF',
            targetId: sid,
            beforeState: ss.expectedAfterStatus,
            afterState: ss.previousStatus,
            reason: 'Rollback Bước 7 (CAS): Khôi phục trạng thái store_staff trước cắt quyền',
            metadata: { batchId: artifact.batchId, userId: ss.userId, roleCode: ss.roleCode },
          },
        });
        restoredStaffCount++;
        revokedSessionUserIds.add(ss.userId);
      }

      const orderedPlatformRollbacks = [...artifact.platformMemberships].sort((a, b) => {
        const aTarget = a.existedBefore && a.previousStatus ? a.previousStatus : 'REVOKED';
        const bTarget = b.existedBefore && b.previousStatus ? b.previousStatus : 'REVOKED';
        if (aTarget === bTarget) return 0;
        return aTarget === 'REVOKED' ? -1 : 1;
      });

      for (const pm of orderedPlatformRollbacks) {
        const mid = BigInt(pm.membershipId);
        const targetStatus = pm.existedBefore && pm.previousStatus ? pm.previousStatus : 'REVOKED';

        const cas = await tx.platformMembership.updateMany({
          where: {
            membershipId: mid,
            userId: BigInt(pm.userId),
            status: pm.expectedAfterStatus,
            updatedAt: new Date(pm.expectedAfterUpdatedAt),
          },
          data: {
            status: targetStatus,
            grantedByUserId: pm.previousGrantedByUserId ? BigInt(pm.previousGrantedByUserId) : null,
            grantedAt: pm.previousGrantedAt ? new Date(pm.previousGrantedAt) : new Date(pm.expectedAfterGrantedAt),
            revokedAt:
              targetStatus === 'REVOKED'
                ? pm.previousRevokedAt
                  ? new Date(pm.previousRevokedAt)
                  : now
                : null,
            revokedByUserId:
              targetStatus === 'REVOKED'
                ? pm.previousRevokedByUserId
                  ? BigInt(pm.previousRevokedByUserId)
                  : actorUserId
                : null,
          },
        });
        if (cas.count !== 1) {
          throw new Error(
            `ROLLBACK_DRIFT_CONFLICT: CAS failed on platform_membership#${pm.membershipId} during rollback execution`,
          );
        }

        await tx.rentalAuditLog.create({
          data: {
            actorType: 'ADMIN',
            actorUserId,
            action: 'STEP7_ROLLBACK_PLATFORM_MEMBERSHIP',
            targetType: 'PLATFORM_MEMBERSHIP',
            targetId: mid,
            beforeState: pm.expectedAfterStatus,
            afterState: targetStatus,
            reason: 'Rollback Bước 7 (CAS): Hoàn tác thay đổi platform_memberships',
            metadata: {
              batchId: artifact.batchId,
              userId: pm.userId,
              roleCode: pm.roleCode,
              existedBefore: pm.existedBefore,
            },
          },
        });
        revertedMembershipCount++;
        revokedSessionUserIds.add(pm.userId);
      }

      const batchCas = await tx.roleTransitionBatch.updateMany({
        where: { batchId: artifact.batchId, status: 'EXECUTED' },
        data: {
          status: 'ROLLED_BACK',
          rolledBackAt: now,
          rolledBackByUserId: actorUserId,
        },
      });
      if (batchCas.count !== 1) {
        throw new Error(
          `ROLLBACK_BATCH_ALREADY_REVERTED: Concurrent rollback detected for batch ${artifact.batchId}`,
        );
      }

      for (const uidStr of [...revokedSessionUserIds].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))) {
        const uid = BigInt(uidStr);
        await tx.refreshToken.updateMany({
          where: { userId: uid, isRevoked: false },
          data: { isRevoked: true },
        });
        await advanceMonotonicTokensInvalidBefore(tx, uid, watermarks.get(uidStr) ?? null, now);
      }

      return {
        dryRun: false,
        batchId: artifact.batchId,
        targetDatabase,
        databaseName,
        restoredStaffCount,
        revertedMembershipCount,
        revokedSessionUserIds: [...revokedSessionUserIds],
      };
    },
    dryRun
      ? { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      : { timeout: 30_000 },
  );
}

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  const eqPrefix = `${flag}=`;
  const eqArg = process.argv.find((a) => a.startsWith(eqPrefix));
  return eqArg ? eqArg.slice(eqPrefix.length) : null;
}

async function main() {
  const executeFlag = process.argv.includes('--execute');
  const manifestPath = getArgValue('--manifest');
  const rollbackPath = getArgValue('--rollback');
  const rollbackBatchId = getArgValue('--rollback-batch');
  const exportBatchId = getArgValue('--export-batch');
  const rollbackOutPath = getArgValue('--rollback-out');
  const confirmDb = getArgValue('--confirm-db');

  if (!manifestPath && !rollbackPath && !rollbackBatchId && !exportBatchId) {
    throw new Error(
      'Missing --manifest <file.json>, --rollback <rollback.json>, --rollback-batch <batchId>, or --export-batch <batchId>',
    );
  }

  const dbUrl = new URL(process.env.DATABASE_URL || '');
  const actualDbName = dbUrl.pathname.replace(/^\//, '');
  const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(dbUrl.hostname);

  if (executeFlag && !isLocalHost && confirmDb !== actualDbName) {
    throw new Error(
      `SAFETY_ABORT: Executing writes against remote DB "${actualDbName}" requires --confirm-db=${actualDbName}`,
    );
  }

  const prisma = new PrismaClient();
  try {
    if (exportBatchId) {
      const artifact = await exportStep7BatchRollback(prisma, exportBatchId);
      if (rollbackOutPath) {
        fs.mkdirSync(path.dirname(path.resolve(rollbackOutPath)), { recursive: true });
        fs.writeFileSync(path.resolve(rollbackOutPath), JSON.stringify(artifact, null, 2), 'utf8');
      }
      console.log(JSON.stringify(artifact, null, 2));
      return;
    }

    if (rollbackPath || rollbackBatchId) {
      const input: Step7RollbackArtifact | { batchId: string } = rollbackPath
        ? (JSON.parse(fs.readFileSync(path.resolve(rollbackPath), 'utf8')) as Step7RollbackArtifact)
        : { batchId: rollbackBatchId! };
      const result = await rollbackStep7Transition(prisma, input, { dryRun: !executeFlag });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath!), 'utf8')) as Step7TransitionManifest;
    const result = await executeStep7Transition(prisma, manifest, { dryRun: !executeFlag });
    if (rollbackOutPath && result.rollbackArtifact) {
      fs.mkdirSync(path.dirname(path.resolve(rollbackOutPath)), { recursive: true });
      fs.writeFileSync(path.resolve(rollbackOutPath), JSON.stringify(result.rollbackArtifact, null, 2), 'utf8');
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Step 7 transition script failed:', err?.message || err);
    process.exit(1);
  });
}
