export const ACTIVE_PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'SYSTEM_ADMIN',
  'ADMIN',
  'SYSTEM_STAFF',
] as const;

export const ADMIN_GOVERNANCE_ROLES = [
  'SUPER_ADMIN',
  'SYSTEM_ADMIN',
  'ADMIN',
] as const;

/**
 * Legacy store staff and store shipper roles deprecated in the
 * Customer -> Store Owner -> SYSTEM_STAFF -> Admin architecture.
 */
export const DEPRECATED_STORE_ROLES = [
  'STORE_MANAGER',
  'STORE_STAFF',
  'STAFF_ORDER',
  'STAFF_INVENTORY',
  'STAFF_BUTTON',
  'STAFF_DELIVERY',
  'DRIVER',
  'TECHNICIAN',
  'STAFF',
] as const;

export type PlatformRoleCode = (typeof ACTIVE_PLATFORM_ROLES)[number];

export interface RoleCapabilities {
  managePlatformDevices: boolean;
  manageWarrantyTickets: boolean;
  approveFinancialRefunds: boolean;
  managePayoutsAndWithdrawals: boolean;
  manageUsersAndRoles: boolean;
  manageOwnStoreSalesAndDelivery: boolean;
  manageOwnStoreWallet: boolean;
}

export interface AuthorityResolution {
  role: string;
  storeId: string | null;
  platformRole: string | null;
  capabilities: RoleCapabilities;
}

export const PLATFORM_ROLE_PRIORITY: Record<string, number> = {
  SUPER_ADMIN: 4,
  SYSTEM_ADMIN: 3,
  ADMIN: 2,
  SYSTEM_STAFF: 1,
};

/**
 * Returns explicit server-authoritative capability flags for the resolved role
 * so clients never have to infer permissions from membership internals.
 */
export function getRoleCapabilities(role: string): RoleCapabilities {
  const isSuper = role === 'SUPER_ADMIN';
  const isAdmin = role === 'SUPER_ADMIN' || role === 'SYSTEM_ADMIN' || role === 'ADMIN';
  const isSystemStaff = role === 'SYSTEM_STAFF';
  const isStoreOwner = role === 'STORE_OWNER';

  return {
    managePlatformDevices: isAdmin || isSystemStaff,
    manageWarrantyTickets: isAdmin || isSystemStaff,
    approveFinancialRefunds: isAdmin,
    managePayoutsAndWithdrawals: isSuper,
    manageUsersAndRoles: isSuper,
    manageOwnStoreSalesAndDelivery: isStoreOwner,
    manageOwnStoreWallet: isStoreOwner,
  };
}

export function isPlatformRoleCode(role?: string | null): role is PlatformRoleCode {
  return Boolean(role && (ACTIVE_PLATFORM_ROLES as readonly string[]).includes(role));
}

export function isDeprecatedStoreRole(role?: string | null): boolean {
  return Boolean(role && (DEPRECATED_STORE_ROLES as readonly string[]).includes(role));
}

/**
 * Checks whether an access/WS token issued at `iatSeconds` has been invalidated by
 * password change or multi-node session/role revocation timestamps (`<=` boundary match).
 */
export function isTokenInvalidatedByTimestamps(
  iatSeconds: number | undefined,
  ...timestamps: Array<Date | string | null | undefined>
): boolean {
  if (!iatSeconds) return false;
  for (const ts of timestamps) {
    if (!ts) continue;
    const ms = new Date(ts).getTime();
    if (!Number.isFinite(ms)) continue;
    const cutoffSec = Math.floor(ms / 1000);
    if (iatSeconds <= cutoffSec) {
      return true;
    }
  }
  return false;
}

export interface ResolveAuthorityOptions {
  payloadRole?: string | null;
  payloadStoreId?: string | null;
  allowTestPayloadFallback?: boolean;
}

/**
 * Identifies explicit bootstrap SUPER_ADMIN identities configured by env/seed.
 * Protected against revocation via generic admin membership endpoints.
 */
export function isBootstrapSuperAdmin(user: any): boolean {
  if (!user) return false;
  const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || 'admin@smartorder.local')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return (
    superAdminEmails.includes((user?.email || '').toLowerCase()) ||
    user?.username === 'admin'
  );
}

/**
 * Single shared authority resolver for Password/Google/Phone login, Refresh Token,
 * /auth/me, JwtStrategy, Admin listing, and WebSocket EventsGateway.
 */
export function resolveAuthority(user: any, options?: ResolveAuthorityOptions): AuthorityResolution {
  let role = 'CUSTOMER';
  let storeId: string | null = null;
  let platformRole: string | null = null;

  const isExplicitSuperAdmin = isBootstrapSuperAdmin(user);

  // 1. Highest priority: explicit platform superadmin identity
  if (isExplicitSuperAdmin) {
    role = 'SUPER_ADMIN';
    platformRole = 'SUPER_ADMIN';
    return {
      role,
      storeId: null,
      platformRole,
      capabilities: getRoleCapabilities(role),
    };
  }

  // 2. Active independent platform_memberships (SYSTEM_STAFF / ADMIN / SYSTEM_ADMIN / SUPER_ADMIN)
  const activePlatformMemberships = (user?.platformMemberships || [])
    .filter((m: any) => m.status === 'ACTIVE' && isPlatformRoleCode(m.role?.roleCode))
    .sort(
      (a: any, b: any) =>
        (PLATFORM_ROLE_PRIORITY[b.role?.roleCode] || 0) -
        (PLATFORM_ROLE_PRIORITY[a.role?.roleCode] || 0),
    );

  if (activePlatformMemberships.length > 0) {
    role = activePlatformMemberships[0].role.roleCode;
    platformRole = role;
    return {
      role,
      storeId: null, // Platform roles never inherit storeId
      platformRole,
      capabilities: getRoleCapabilities(role),
    };
  }

  // 3. Transition compatibility ONLY for pre-backfill admin rows in store_staff
  // (Legacy store-level staff/shipper roles in store_staff no longer grant authority!)
  const legacyPlatformAdmin = (user?.storeStaffs || [])
    .filter(
      (s: any) =>
        s.status === 'ACTIVE' &&
        (ADMIN_GOVERNANCE_ROLES as readonly string[]).includes(s.role?.roleCode),
    )
    .sort(
      (a: any, b: any) =>
        (PLATFORM_ROLE_PRIORITY[b.role?.roleCode] || 0) -
        (PLATFORM_ROLE_PRIORITY[a.role?.roleCode] || 0),
    )[0];

  if (legacyPlatformAdmin) {
    role = legacyPlatformAdmin.role.roleCode;
    platformRole = role;
    return {
      role,
      storeId: null,
      platformRole,
      capabilities: getRoleCapabilities(role),
    };
  }

  // 4. Store Owner authority
  const ownedStores: any[] = user?.ownedStores || [];
  if (ownedStores.length > 0) {
    const preferredStore =
      ownedStores.find((s: any) => s.status === 'ACTIVE') || ownedStores[0];
    role = 'STORE_OWNER';
    storeId = preferredStore?.storeId != null ? preferredStore.storeId.toString() : null;
    return {
      role,
      storeId,
      platformRole: null,
      capabilities: getRoleCapabilities(role),
    };
  }

  // 5. Optional isolated unit-test fallback ONLY when DB relations were not mocked/present
  const hasMembershipRecords =
    (user?.platformMemberships?.length || 0) > 0 ||
    (user?.storeStaffs?.length || 0) > 0;
  if (
    options?.allowTestPayloadFallback &&
    process.env.NODE_ENV === 'test' &&
    !hasMembershipRecords &&
    options.payloadRole &&
    !isDeprecatedStoreRole(options.payloadRole)
  ) {
    role = options.payloadRole;
    storeId = role === 'STORE_OWNER' ? options.payloadStoreId || null : null;
    return {
      role,
      storeId,
      platformRole: isPlatformRoleCode(role) ? role : null,
      capabilities: getRoleCapabilities(role),
    };
  }

  return {
    role,
    storeId: null,
    platformRole: null,
    capabilities: getRoleCapabilities(role),
  };
}

/**
 * Computes a non-decreasing revocation watermark timestamp so concurrent
 * transactions never overwrite a newer `tokens_invalid_before` with an older one.
 */
export function computeMonotonicWatermark(
  existingWatermark?: Date | string | null,
  candidateTimestamp?: Date,
): Date {
  const existingMs = existingWatermark ? new Date(existingWatermark).getTime() : 0;
  const safeExistingMs = Number.isFinite(existingMs) ? existingMs : 0;
  const candidateMs = candidateTimestamp ? candidateTimestamp.getTime() : Date.now();
  return new Date(Math.max(safeExistingMs, candidateMs));
}

/**
 * Canonical lock acquisition helper (`users` ALWAYS locked before memberships).
 * Returns the currently committed `tokens_invalid_before` watermark under row lock.
 */
export async function lockUserForWatermark(tx: any, userId: bigint): Promise<Date | null> {
  const rows: Array<{ user_id: bigint; tokens_invalid_before?: Date | string | null }> =
    (await tx.$queryRaw`
      SELECT user_id, tokens_invalid_before
      FROM users
      WHERE user_id = ${userId}
      FOR UPDATE
    `) || [];
  const raw = rows?.[0]?.tokens_invalid_before ?? null;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Advances `users.tokens_invalid_before` monotonically inside an active transaction
 * after `lockUserForWatermark`, enforcing SQL GREATEST when raw execution is available.
 */
export async function advanceMonotonicTokensInvalidBefore(
  tx: any,
  userId: bigint,
  existingWatermark?: Date | null,
  candidateTimestamp?: Date,
): Promise<Date> {
  const monotonic = computeMonotonicWatermark(existingWatermark, candidateTimestamp);
  if (typeof tx.$executeRaw === 'function') {
    await tx.$executeRaw`
      UPDATE users
      SET tokens_invalid_before = GREATEST(
        COALESCE(tokens_invalid_before, to_timestamp(0)),
        ${monotonic}
      )
      WHERE user_id = ${userId}
    `;
  } else if (tx.user?.update) {
    await tx.user.update({
      where: { userId },
      data: { tokensInvalidBefore: monotonic },
    });
  }
  return monotonic;
}
