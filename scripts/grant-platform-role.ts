/**
 * Audited operator script to grant a platform role (`SUPER_ADMIN`, `SYSTEM_ADMIN`,
 * `ADMIN`, or `SYSTEM_STAFF`) via `platform_memberships` (SAFE DRY-RUN BY DEFAULT).
 *
 * Usage:
 *   npx tsx scripts/grant-platform-role.ts --user-id 160 --role SYSTEM_STAFF
 *   npx tsx scripts/grant-platform-role.ts --email admin@example.com --role SUPER_ADMIN --actor-user-id 1 --reason "Primary finance approver"
 *   npx tsx scripts/grant-platform-role.ts --user-id 160 --role SUPER_ADMIN --execute --confirm-db=smart_order_test
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  PlatformRoleCode,
  advanceMonotonicTokensInvalidBefore,
  isBootstrapSuperAdmin,
  isPlatformRoleCode,
  lockUserForWatermark,
  resolveAuthority,
} from '../src/auth/authority.policy';

export interface GrantPlatformRoleArgs {
  userId?: string;
  email?: string;
  roleCode: PlatformRoleCode;
  actorUserId?: string;
  reason?: string;
  execute: boolean;
  confirmDb?: string;
  json: boolean;
}

function readFlagValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === flag && i + 1 < argv.length) {
      return argv[i + 1];
    }
    if (token.startsWith(`${flag}=`)) {
      return token.slice(flag.length + 1);
    }
  }
  return undefined;
}

export function parseGrantRoleArgs(argv: string[]): GrantPlatformRoleArgs {
  const userId = readFlagValue(argv, '--user-id')?.trim();
  const email = readFlagValue(argv, '--email')?.trim().toLowerCase();
  const rawRole = readFlagValue(argv, '--role')?.trim().toUpperCase();
  const actorUserId = readFlagValue(argv, '--actor-user-id')?.trim();
  const reason = readFlagValue(argv, '--reason')?.trim();
  const confirmDb = readFlagValue(argv, '--confirm-db')?.trim();
  const execute = argv.includes('--execute');
  const json = argv.includes('--json');

  if (!userId && !email) {
    throw new Error('Must provide either --user-id <id> or --email <email>.');
  }
  if (userId && !/^\d+$/.test(userId)) {
    throw new Error(`Invalid --user-id "${userId}": expected positive integer.`);
  }
  if (actorUserId && !/^\d+$/.test(actorUserId)) {
    throw new Error(`Invalid --actor-user-id "${actorUserId}": expected positive integer.`);
  }
  if (!rawRole || !isPlatformRoleCode(rawRole)) {
    throw new Error(
      `Invalid --role "${rawRole || ''}". Allowed: SUPER_ADMIN, SYSTEM_ADMIN, ADMIN, SYSTEM_STAFF.`,
    );
  }
  if (execute && !confirmDb) {
    throw new Error('Missing --confirm-db=<databaseName> when using --execute.');
  }

  return {
    userId,
    email,
    roleCode: rawRole,
    actorUserId,
    reason,
    execute,
    confirmDb,
    json,
  };
}

export function maskIdentifier(value?: string | null): string | null {
  if (!value) return null;
  if (value.includes('@')) {
    const [local, domain] = value.split('@');
    return `${local[0] || '*'}***@${domain}`;
  }
  return value.length <= 2 ? `${value[0] || '*'}*` : `${value[0]}***${value.slice(-1)}`;
}

export async function runGrantPlatformRole(
  prisma: PrismaClient,
  opts: GrantPlatformRoleArgs,
) {
  const user = await prisma.user.findFirst({
    where: opts.userId ? { userId: BigInt(opts.userId) } : { email: opts.email },
    include: {
      ownedStores: { select: { storeId: true, status: true } },
      storeStaffs: { where: { status: 'ACTIVE' }, include: { role: true } },
      platformMemberships: { where: { status: 'ACTIVE' }, include: { role: true } },
    },
  });

  if (!user) {
    throw new Error('Target user not found.');
  }
  if (user.status !== 'ACTIVE') {
    throw new Error(`Target user status is "${user.status}"; expected ACTIVE.`);
  }
  if (isBootstrapSuperAdmin(user) && opts.roleCode !== 'SUPER_ADMIN') {
    throw new Error('Bootstrap SUPER_ADMIN account cannot be downgraded.');
  }
  if (opts.roleCode === 'SYSTEM_STAFF' && user.ownedStores.length > 0) {
    throw new Error('Cannot grant SYSTEM_STAFF to a user that owns a store.');
  }

  const roleRow = await prisma.role.findUnique({ where: { roleCode: opts.roleCode } });
  if (!roleRow) {
    throw new Error(`Role "${opts.roleCode}" does not exist in roles table.`);
  }

  const dbRows: Array<{ db_name: string }> = await prisma.$queryRaw`
    SELECT current_database() AS db_name
  `;
  const currentDb = dbRows?.[0]?.db_name || 'unknown';

  const currentActiveRoles = user.platformMemberships.map((m) => m.role.roleCode);
  const beforeAuthority = resolveAuthority(user);
  const alreadyHasExactMembership =
    currentActiveRoles.length === 1 && currentActiveRoles[0] === opts.roleCode;

  if (!opts.execute) {
    return {
      dryRun: true,
      databaseName: currentDb,
      userId: user.userId.toString(),
      username: user.username,
      maskedEmail: maskIdentifier(user.email),
      requestedRole: opts.roleCode,
      currentEffectiveRole: beforeAuthority.role,
      currentActiveMemberships: currentActiveRoles,
      action: alreadyHasExactMembership
        ? 'NOOP_ALREADY_ACTIVE'
        : currentActiveRoles.length > 0
          ? 'WOULD_REPLACE_MEMBERSHIP'
          : 'WOULD_GRANT_MEMBERSHIP',
    };
  }

  if (opts.confirmDb !== currentDb) {
    throw new Error(
      `--confirm-db mismatch: expected "${currentDb}", got "${opts.confirmDb || ''}".`,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const existingWatermark = await lockUserForWatermark(tx, user.userId);
    const now = new Date();
    const actorBigInt = opts.actorUserId ? BigInt(opts.actorUserId) : null;

    if (!alreadyHasExactMembership) {
      await tx.platformMembership.updateMany({
        where: { userId: user.userId, status: 'ACTIVE' },
        data: {
          status: 'REVOKED',
          revokedByUserId: actorBigInt,
          revokedAt: now,
          reason: opts.reason || `CLI transition to ${opts.roleCode}`,
        },
      });

      await tx.platformMembership.create({
        data: {
          userId: user.userId,
          roleId: roleRow.roleId,
          status: 'ACTIVE',
          grantedByUserId: actorBigInt,
          grantedAt: now,
          reason: opts.reason || `CLI grant ${opts.roleCode}`,
        },
      });

      await tx.refreshToken.updateMany({
        where: { userId: user.userId, isRevoked: false },
        data: { isRevoked: true },
      });
      await advanceMonotonicTokensInvalidBefore(tx, user.userId, existingWatermark, now);
    }

    const updatedUser = await tx.user.findUniqueOrThrow({
      where: { userId: user.userId },
      include: {
        ownedStores: { select: { storeId: true, status: true } },
        storeStaffs: { where: { status: 'ACTIVE' }, include: { role: true } },
        platformMemberships: { where: { status: 'ACTIVE' }, include: { role: true } },
      },
    });
    const afterAuthority = resolveAuthority(updatedUser);

    return {
      dryRun: false,
      databaseName: currentDb,
      userId: user.userId.toString(),
      username: user.username,
      maskedEmail: maskIdentifier(user.email),
      requestedRole: opts.roleCode,
      previousEffectiveRole: beforeAuthority.role,
      newEffectiveRole: afterAuthority.role,
      capabilities: afterAuthority.capabilities,
      action: alreadyHasExactMembership ? 'NOOP_ALREADY_ACTIVE' : 'GRANTED',
    };
  });

  return result;
}

async function main() {
  const opts = parseGrantRoleArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const out = await runGrantPlatformRole(prisma, opts);
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[grant-platform-role] Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
