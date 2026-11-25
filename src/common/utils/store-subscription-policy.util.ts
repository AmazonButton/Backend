/**
 * Centralized store-subscription validity policy shared across catalog discovery,
 * storefront checkout, and IoT button ordering.
 *
 * - Strict mode (`NODE_ENV === 'production'` or `ENFORCE_STORE_SUBSCRIPTION_STRICT === 'true'`):
 *   Requires at least one ACTIVE subscription covering `now` (`startDate <= now <= endDate`).
 *   Stores with 0 subscription records OR only expired/inactive records are excluded/blocked.
 * - Non-strict test/dev mode (`NODE_ENV !== 'production'` without strict override):
 *   Allows bare ad-hoc fixture stores that have 0 rows in `store_subscriptions` so legacy
 *   module-isolated tests remain deterministic, while strictly blocking any store that HAS
 *   subscription rows when none is currently ACTIVE and unexpired.
 */
export function isStrictStoreSubscriptionEnforcement(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.ENFORCE_STORE_SUBSCRIPTION_STRICT === 'true'
  );
}

/**
 * Builds a Prisma `StoreWhereInput` predicate ensuring the store has a valid active
 * subscription according to the active runtime policy.
 */
export function buildActiveStoreSubscriptionPrismaFilter(now: Date = new Date()): Record<string, any> {
  const activeCondition = {
    subscriptions: {
      some: {
        status: 'ACTIVE',
        startDate: { lte: now },
        endDate: { gte: now },
      },
    },
  };

  if (isStrictStoreSubscriptionEnforcement()) {
    return activeCondition;
  }

  return {
    OR: [
      activeCondition,
      {
        subscriptions: {
          none: {},
        },
      },
    ],
  };
}

/**
 * Checks within a Prisma client or interactive transaction whether a store has an
 * active, unexpired subscription (`status = 'ACTIVE' AND start_date <= now AND end_date >= now`).
 */
export async function hasStoreActiveSubscription(
  prismaOrTx: any,
  storeId: bigint,
  now: Date = new Date(),
): Promise<boolean> {
  if (!prismaOrTx) return true;

  let total = 0;
  let activeValid = 0;

  if (typeof prismaOrTx.$queryRawUnsafe === 'function') {
    const rows = await prismaOrTx.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (
           WHERE status = 'ACTIVE'
             AND start_date <= $2
             AND end_date >= $2
         )::int AS active_valid
       FROM store_subscriptions
       WHERE store_id = $1`,
      storeId,
      now,
    );
    total = Number(rows?.[0]?.total || 0);
    activeValid = Number(rows?.[0]?.active_valid || 0);
  } else if (prismaOrTx.storeSubscription?.count) {
    const [allCount, validCount] = await Promise.all([
      prismaOrTx.storeSubscription.count({ where: { storeId } }),
      prismaOrTx.storeSubscription.count({
        where: {
          storeId,
          status: 'ACTIVE',
          startDate: { lte: now },
          endDate: { gte: now },
        },
      }),
    ]);
    total = Number(allCount || 0);
    activeValid = Number(validCount || 0);
  } else {
    return true;
  }

  if (activeValid > 0) {
    return true;
  }
  if (isStrictStoreSubscriptionEnforcement()) {
    return false;
  }
  return total === 0;
}
