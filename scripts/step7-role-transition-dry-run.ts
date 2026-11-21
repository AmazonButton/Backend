/**
 * Step 7 Dry-Run Inventory Script (STRICTLY READ-ONLY, REPEATABLE READ SNAPSHOT)
 *
 * Inventories all legacy & active role-transition records inside a consistent
 * PostgreSQL `REPEATABLE READ READ ONLY` transaction snapshot and supports
 * exporting structured JSON (`--out`) plus comparing before/after snapshots (`--compare`).
 *
 * Usage:
 *   npx tsx scripts/step7-role-transition-dry-run.ts
 *   npx tsx scripts/step7-role-transition-dry-run.ts --json --out tmp/step7-before.json
 *   npx tsx scripts/step7-role-transition-dry-run.ts --compare tmp/step7-before.json
 */
import * as dotenv from 'dotenv';
dotenv.config();
import * as fs from 'fs';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PLATFORM_ROLE_PRIORITY } from '../src/auth/authority.policy';

export interface LegacyAdminStoreStaffRow {
  storeStaffId: string;
  userId: string;
  storeId: string;
  roleId: string;
  roleCode: string;
}

export interface ActivePlatformMembershipSummary {
  membershipId: string;
  userId: string;
  roleId: string;
  roleCode: string;
}

export interface LegacyAdminBackfillDecision {
  userId: string;
  targetRoleCode: string;
  targetRoleId: string;
  sourceStoreStaffId: string;
  sourceStoreId: string;
  existingActiveMembershipId: string | null;
  existingActiveRoleCode: string | null;
  decision: 'ALREADY_SATISFIED' | 'UPGRADE_ACTIVE' | 'NEEDS_ACTIVATION';
}

/**
 * Resolves AT MOST ONE target platform admin role per userId, honoring partial unique index
 * `uq_platform_memberships_active_user` (`platform_memberships(user_id) WHERE status = 'ACTIVE'`).
 * Picks the single highest-priority admin role (`SUPER_ADMIN > SYSTEM_ADMIN > ADMIN`) and checks
 * against any existing ACTIVE platform_memberships row. Shared identically by dry-run & execution.
 */
export function resolveLegacyAdminBackfillDecisions(
  legacyAdminRows: LegacyAdminStoreStaffRow[],
  activePlatformMemberships: ActivePlatformMembershipSummary[],
): LegacyAdminBackfillDecision[] {
  const bestLegacyByUser = new Map<string, LegacyAdminStoreStaffRow>();
  for (const row of legacyAdminRows) {
    const existing = bestLegacyByUser.get(row.userId);
    if (!existing) {
      bestLegacyByUser.set(row.userId, row);
      continue;
    }
    const curPrio = PLATFORM_ROLE_PRIORITY[row.roleCode] || 0;
    const prevPrio = PLATFORM_ROLE_PRIORITY[existing.roleCode] || 0;
    if (
      curPrio > prevPrio ||
      (curPrio === prevPrio && BigInt(row.storeStaffId) < BigInt(existing.storeStaffId))
    ) {
      bestLegacyByUser.set(row.userId, row);
    }
  }

  const activeByUser = new Map<string, ActivePlatformMembershipSummary>();
  for (const pm of activePlatformMemberships) {
    const prev = activeByUser.get(pm.userId);
    if (!prev || (PLATFORM_ROLE_PRIORITY[pm.roleCode] || 0) > (PLATFORM_ROLE_PRIORITY[prev.roleCode] || 0)) {
      activeByUser.set(pm.userId, pm);
    }
  }

  const sortedUserIds = [...bestLegacyByUser.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return sortedUserIds.map((uid) => {
    const chosen = bestLegacyByUser.get(uid)!;
    const existingActive = activeByUser.get(uid) || null;
    const targetPrio = PLATFORM_ROLE_PRIORITY[chosen.roleCode] || 0;
    const existingPrio = existingActive ? PLATFORM_ROLE_PRIORITY[existingActive.roleCode] || 0 : 0;

    let decision: LegacyAdminBackfillDecision['decision'] = 'NEEDS_ACTIVATION';
    if (existingActive) {
      decision = existingPrio >= targetPrio ? 'ALREADY_SATISFIED' : 'UPGRADE_ACTIVE';
    }

    return {
      userId: uid,
      targetRoleCode: chosen.roleCode,
      targetRoleId: chosen.roleId,
      sourceStoreStaffId: chosen.storeStaffId,
      sourceStoreId: chosen.storeId,
      existingActiveMembershipId: existingActive?.membershipId || null,
      existingActiveRoleCode: existingActive?.roleCode || null,
      decision,
    };
  });
}

export interface Step7InventoryReport {
  generatedAt: string;
  targetDatabase: string;
  isolationLevel: 'REPEATABLE_READ_READ_ONLY';
  readOnly: true;
  summary: {
    activeStoresCount: number;
    activeOrPendingStoreStaffGroups: Array<{ roleCode: string; status: string; count: number }>;
    deprecatedStoreStaffCount: number;
    storeOwnerMembershipCount: number;
    platformMembershipsByRole: Array<{ roleCode: string; status: string; count: number }>;
    legacyAdminsNeedingPlatformMembershipCount: number;
    legacyShippingOrdersNeedingTakeoverCount: number;
    unsettledLegacyDriverShiftsCount: number;
    onlineLegacyDriverDutiesCount: number;
    warrantyTicketsNeedingManualReconciliationCount: number;
  };
  details: {
    activeOrPendingStoreStaffRows: Array<{
      storeStaffId: string;
      storeId: string;
      userId: string;
      roleCode: string;
      status: string;
      storeOwnerUserId: string;
    }>;
    platformMemberships: Array<{
      membershipId: string;
      userId: string;
      roleCode: string;
      status: string;
    }>;
    legacyAdminsWithoutPlatformMembership: Array<{
      storeStaffId: string;
      userId: string;
      storeId: string;
      roleCode: string;
    }>;
    legacyShippingOrders: Array<{
      orderId: string;
      orderCode: string;
      storeId: string;
      assignedDriverId: string | null;
      ownerUserId: string;
    }>;
    unsettledDriverShifts: Array<{
      shiftId: string;
      storeId: string;
      driverId: string;
      status: string;
    }>;
    onlineLegacyDuties: Array<{
      driverDutyId: string;
      storeId: string;
      driverId: string;
    }>;
    warrantyTicketsRequiringReconciliation: Array<{
      ticketId: string;
      ticketCode: string;
      buttonId: string;
      ticketRentalId: string | null;
      buttonRentalId: string | null;
      reason: string;
    }>;
  };
}

export async function runStep7InventoryReport(prisma: PrismaClient): Promise<Step7InventoryReport> {
  const dbUrl = new URL(process.env.DATABASE_URL || 'postgresql://localhost/unknown');
  const dbLabel = `${dbUrl.hostname}${dbUrl.pathname}`;

  return prisma.$transaction(
    async (tx) => {
      // Enforce PostgreSQL read-only snapshot semantics alongside RepeatableRead isolation
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');

      const activeStoresRows = await tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(*)::bigint AS total
        FROM store
        WHERE status = 'ACTIVE'
      `;

      const activeOrPendingStoreStaffRows = await tx.$queryRaw<
        Array<{
          store_staff_id: bigint;
          store_id: bigint;
          user_id: bigint;
          role_code: string;
          status: string;
          owner_user_id: bigint;
        }>
      >`
        SELECT
          ss.store_staff_id,
          ss.store_id,
          ss.user_id,
          r.role_code,
          ss.status,
          s.owner_user_id
        FROM store_staff ss
        JOIN roles r ON r.role_id = ss.role_id
        JOIN store s ON s.store_id = ss.store_id
        WHERE ss.status IN ('ACTIVE', 'PENDING', 'INVITED')
        ORDER BY ss.store_staff_id ASC
      `;

      const legacyStoreStaffByRole = await tx.$queryRaw<
        Array<{ role_code: string; status: string; total: bigint }>
      >`
        SELECT r.role_code, ss.status, COUNT(*)::bigint AS total
        FROM store_staff ss
        JOIN roles r ON r.role_id = ss.role_id
        WHERE ss.status IN ('ACTIVE', 'PENDING', 'INVITED')
        GROUP BY r.role_code, ss.status
        ORDER BY r.role_code ASC, ss.status ASC
      `;

      const platformMemberships = await tx.$queryRaw<
        Array<{
          membership_id: bigint;
          user_id: bigint;
          role_id: bigint;
          role_code: string;
          status: string;
        }>
      >`
        SELECT pm.membership_id, pm.user_id, pm.role_id, r.role_code, pm.status
        FROM platform_memberships pm
        JOIN roles r ON r.role_id = pm.role_id
        ORDER BY pm.membership_id ASC
      `;

      const existingPlatformMemberships = await tx.$queryRaw<
        Array<{ role_code: string; status: string; total: bigint }>
      >`
        SELECT r.role_code, pm.status, COUNT(*)::bigint AS total
        FROM platform_memberships pm
        JOIN roles r ON r.role_id = pm.role_id
        GROUP BY r.role_code, pm.status
        ORDER BY r.role_code ASC, pm.status ASC
      `;

      const legacyAdminStoreStaffRows = await tx.$queryRaw<
        Array<{ store_staff_id: bigint; user_id: bigint; store_id: bigint; role_id: bigint; role_code: string }>
      >`
        SELECT ss.store_staff_id, ss.user_id, ss.store_id, ss.role_id, r.role_code
        FROM store_staff ss
        JOIN roles r ON r.role_id = ss.role_id
        JOIN users u ON u.user_id = ss.user_id
        WHERE ss.status = 'ACTIVE'
          AND u.status = 'ACTIVE'
          AND r.role_code IN ('ADMIN', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
        ORDER BY ss.user_id ASC, ss.store_staff_id ASC
      `;

      const adminBackfillDecisions = resolveLegacyAdminBackfillDecisions(
        legacyAdminStoreStaffRows.map((r) => ({
          storeStaffId: r.store_staff_id.toString(),
          userId: r.user_id.toString(),
          storeId: r.store_id.toString(),
          roleId: r.role_id.toString(),
          roleCode: r.role_code,
        })),
        platformMemberships
          .filter((pm) => pm.status === 'ACTIVE')
          .map((pm) => ({
            membershipId: pm.membership_id.toString(),
            userId: pm.user_id.toString(),
            roleId: pm.role_id.toString(),
            roleCode: pm.role_code,
          })),
      );

      const legacyAdminsWithoutPlatformMembership = adminBackfillDecisions
        .filter((d) => d.decision !== 'ALREADY_SATISFIED')
        .map((d) => ({
          store_staff_id: BigInt(d.sourceStoreStaffId),
          user_id: BigInt(d.userId),
          store_id: BigInt(d.sourceStoreId),
          role_code: d.targetRoleCode,
        }));

      const legacyShippingOrders = await tx.$queryRaw<
        Array<{
          order_id: bigint;
          order_code: string;
          store_id: bigint;
          assigned_driver_id: bigint | null;
          owner_user_id: bigint;
        }>
      >`
        SELECT o.order_id, o.order_code, o.store_id, o.assigned_driver_id, s.owner_user_id
        FROM orders o
        JOIN store s ON s.store_id = o.store_id
        WHERE o.order_status = 'SHIPPING'
          AND o.assigned_driver_id IS NOT NULL
          AND o.assigned_driver_id <> s.owner_user_id
        ORDER BY o.order_id ASC
      `;

      const unsettledDriverShifts = await tx.$queryRaw<
        Array<{ shift_id: bigint; store_id: bigint; driver_id: bigint; status: string }>
      >`
        SELECT ds.shift_id, ds.store_id, ds.driver_id, ds.status
        FROM driver_shifts ds
        JOIN store s ON s.store_id = ds.store_id
        WHERE ds.status IN ('OPEN', 'CLOSED')
          AND ds.driver_id <> s.owner_user_id
        ORDER BY ds.shift_id ASC
      `;

      const onlineLegacyDuties = await tx.$queryRaw<
        Array<{ driver_duty_id: bigint; store_id: bigint; driver_id: bigint }>
      >`
        SELECT dd.driver_duty_id, dd.store_id, dd.driver_id
        FROM driver_duties dd
        JOIN store s ON s.store_id = dd.store_id
        WHERE dd.status = 'ONLINE'
          AND dd.driver_id <> s.owner_user_id
        ORDER BY dd.driver_duty_id ASC
      `;

      const warrantyTicketsRequiringReconciliation = await tx.$queryRaw<
        Array<{
          ticket_id: bigint;
          ticket_code: string;
          button_id: bigint;
          ticket_rental_id: bigint | null;
          button_rental_id: bigint | null;
          mismatch_reason: string;
        }>
      >`
        SELECT
          wt.ticket_id,
          wt.ticket_code,
          wt.button_id,
          wt.rental_id AS ticket_rental_id,
          b.rental_id AS button_rental_id,
          CASE
            WHEN wt.rental_id IS NULL AND b.rental_id IS NOT NULL THEN 'MISSING_SNAPSHOT_ON_RENTED_BUTTON'
            WHEN wt.rental_id IS NOT NULL AND b.rental_id IS NULL THEN 'RENTAL_DETACHED_SINCE_TICKET_CREATED'
            WHEN wt.rental_id IS DISTINCT FROM b.rental_id THEN 'CROSS_RENTAL_DRIFT'
            ELSE 'UNKNOWN'
          END AS mismatch_reason
        FROM warranty_tickets wt
        JOIN iot_button b ON b.button_id = wt.button_id
        WHERE wt.status = 'PENDING'
          AND wt.rental_id IS DISTINCT FROM b.rental_id
        ORDER BY wt.ticket_id ASC
      `;

      const deprecatedRolesSet = new Set([
        'STORE_MANAGER',
        'STORE_STAFF',
        'STAFF_ORDER',
        'STAFF_INVENTORY',
        'STAFF_BUTTON',
        'STAFF_DELIVERY',
        'DRIVER',
        'TECHNICIAN',
        'STAFF',
      ]);

      const deprecatedStoreStaffCount = activeOrPendingStoreStaffRows.filter((r) =>
        deprecatedRolesSet.has(r.role_code),
      ).length;
      const storeOwnerMembershipCount = activeOrPendingStoreStaffRows.filter(
        (r) => r.role_code === 'STORE_OWNER',
      ).length;

      return {
        generatedAt: new Date().toISOString(),
        targetDatabase: dbLabel,
        isolationLevel: 'REPEATABLE_READ_READ_ONLY',
        readOnly: true,
        summary: {
          activeStoresCount: Number(activeStoresRows?.[0]?.total || 0),
          activeOrPendingStoreStaffGroups: legacyStoreStaffByRole.map((r) => ({
            roleCode: r.role_code,
            status: r.status,
            count: Number(r.total),
          })),
          deprecatedStoreStaffCount,
          storeOwnerMembershipCount,
          platformMembershipsByRole: existingPlatformMemberships.map((r) => ({
            roleCode: r.role_code,
            status: r.status,
            count: Number(r.total),
          })),
          legacyAdminsNeedingPlatformMembershipCount: legacyAdminsWithoutPlatformMembership.length,
          legacyShippingOrdersNeedingTakeoverCount: legacyShippingOrders.length,
          unsettledLegacyDriverShiftsCount: unsettledDriverShifts.length,
          onlineLegacyDriverDutiesCount: onlineLegacyDuties.length,
          warrantyTicketsNeedingManualReconciliationCount: warrantyTicketsRequiringReconciliation.length,
        },
        details: {
          activeOrPendingStoreStaffRows: activeOrPendingStoreStaffRows.map((r) => ({
            storeStaffId: r.store_staff_id.toString(),
            storeId: r.store_id.toString(),
            userId: r.user_id.toString(),
            roleCode: r.role_code,
            status: r.status,
            storeOwnerUserId: r.owner_user_id.toString(),
          })),
          platformMemberships: platformMemberships.map((r) => ({
            membershipId: r.membership_id.toString(),
            userId: r.user_id.toString(),
            roleCode: r.role_code,
            status: r.status,
          })),
          legacyAdminsWithoutPlatformMembership: legacyAdminsWithoutPlatformMembership.map((r) => ({
            storeStaffId: r.store_staff_id.toString(),
            userId: r.user_id.toString(),
            storeId: r.store_id.toString(),
            roleCode: r.role_code,
          })),
          legacyShippingOrders: legacyShippingOrders.map((r) => ({
            orderId: r.order_id.toString(),
            orderCode: r.order_code,
            storeId: r.store_id.toString(),
            assignedDriverId: r.assigned_driver_id?.toString() || null,
            ownerUserId: r.owner_user_id.toString(),
          })),
          unsettledDriverShifts: unsettledDriverShifts.map((r) => ({
            shiftId: r.shift_id.toString(),
            storeId: r.store_id.toString(),
            driverId: r.driver_id.toString(),
            status: r.status,
          })),
          onlineLegacyDuties: onlineLegacyDuties.map((r) => ({
            driverDutyId: r.driver_duty_id.toString(),
            storeId: r.store_id.toString(),
            driverId: r.driver_id.toString(),
          })),
          warrantyTicketsRequiringReconciliation: warrantyTicketsRequiringReconciliation.map((r) => ({
            ticketId: r.ticket_id.toString(),
            ticketCode: r.ticket_code,
            buttonId: r.button_id.toString(),
            ticketRentalId: r.ticket_rental_id?.toString() || null,
            buttonRentalId: r.button_rental_id?.toString() || null,
            reason: r.mismatch_reason,
          })),
        },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export function diffStep7Snapshots(before: Step7InventoryReport, after: Step7InventoryReport) {
  const beforePlatformActive = new Set(
    before.details.platformMemberships
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => `${m.userId}:${m.roleCode}`),
  );
  const afterPlatformActive = new Set(
    after.details.platformMemberships
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => `${m.userId}:${m.roleCode}`),
  );

  const beforeStaffIds = new Set(before.details.activeOrPendingStoreStaffRows.map((s) => s.storeStaffId));
  const afterStaffIds = new Set(after.details.activeOrPendingStoreStaffRows.map((s) => s.storeStaffId));

  return {
    beforeGeneratedAt: before.generatedAt,
    afterGeneratedAt: after.generatedAt,
    targetDatabase: after.targetDatabase,
    grantedOrActivatedPlatformMemberships: [...afterPlatformActive].filter((k) => !beforePlatformActive.has(k)),
    revokedPlatformMemberships: [...beforePlatformActive].filter((k) => !afterPlatformActive.has(k)),
    terminatedStoreStaffIds: [...beforeStaffIds].filter((id) => !afterStaffIds.has(id)),
    reactivatedOrAddedStoreStaffIds: [...afterStaffIds].filter((id) => !beforeStaffIds.has(id)),
    deltaCounts: {
      deprecatedStoreStaffDelta:
        after.summary.deprecatedStoreStaffCount - before.summary.deprecatedStoreStaffCount,
      storeOwnerMembershipDelta:
        after.summary.storeOwnerMembershipCount - before.summary.storeOwnerMembershipCount,
      activeStoresDelta: after.summary.activeStoresCount - before.summary.activeStoresCount,
      legacyAdminsMissingPlatformDelta:
        after.summary.legacyAdminsNeedingPlatformMembershipCount -
        before.summary.legacyAdminsNeedingPlatformMembershipCount,
    },
  };
}

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return null;
}

async function main() {
  const jsonMode = process.argv.includes('--json');
  const outPath = getArgValue('--out');
  const comparePath = getArgValue('--compare');
  const prisma = new PrismaClient();

  try {
    const report = await runStep7InventoryReport(prisma);
    if (outPath) {
      fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outPath), JSON.stringify(report, null, 2), 'utf8');
    }

    const diff = comparePath
      ? diffStep7Snapshots(
        JSON.parse(fs.readFileSync(path.resolve(comparePath), 'utf8')) as Step7InventoryReport,
        report,
      )
      : null;

    if (jsonMode) {
      console.log(JSON.stringify(diff ? { report, diff } : report, null, 2));
    } else {
      console.log('========================================================================');
      console.log('📋 STEP 7 ROLE TRANSITION DRY-RUN AUDIT REPORT (REPEATABLE READ READ ONLY)');
      console.log(`🎯 Target Database: ${report.targetDatabase}`);
      console.log(`🕒 Timestamp: ${report.generatedAt}`);
      console.log('========================================================================');
      console.log('\n[1] Existing platform_memberships:');
      console.table(report.summary.platformMembershipsByRole);
      console.log('\n[2] Active/Pending store_staff rows:');
      console.table(report.summary.activeOrPendingStoreStaffGroups);
      console.log(
        `\n[3] Summary counts -> Active Stores: ${report.summary.activeStoresCount} | StoreOwner Rows: ${report.summary.storeOwnerMembershipCount} | Deprecated StoreStaff Rows: ${report.summary.deprecatedStoreStaffCount}`,
      );
      console.log(
        `[4] Legacy Admins missing ACTIVE platform_memberships: ${report.summary.legacyAdminsNeedingPlatformMembershipCount}`,
      );
      if (report.details.legacyAdminsWithoutPlatformMembership.length > 0) {
        console.table(report.details.legacyAdminsWithoutPlatformMembership);
      }
      console.log(
        `[5] In-flight SHIPPING orders needing Store Owner takeover: ${report.summary.legacyShippingOrdersNeedingTakeoverCount}`,
      );
      console.log(
        `[6] Unsettled driver_shifts (OPEN/CLOSED, non-owner): ${report.summary.unsettledLegacyDriverShiftsCount} | Online duties: ${report.summary.onlineLegacyDriverDutiesCount}`,
      );
      console.log(
        `[7] PENDING warranty tickets requiring rental reconciliation: ${report.summary.warrantyTicketsNeedingManualReconciliationCount}`,
      );
      if (outPath) {
        console.log(`\n💾 Snapshot written to ${outPath}`);
      }
      if (diff) {
        console.log('\n🔍 Before/After Snapshot Diff:');
        console.log(JSON.stringify(diff, null, 2));
      }
      console.log('\n✅ Consistent REPEATABLE READ READ ONLY snapshot completed with ZERO writes.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Dry-run audit failed:', err?.message || err);
    process.exit(1);
  });
}
