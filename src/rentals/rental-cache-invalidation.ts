import { DashboardCacheService } from '../common/cache/dashboard-cache.service';

/** Post-commit only; cache failure must not change a committed financial result. */
export async function invalidateRentalMutationCaches(
  cache: DashboardCacheService | undefined, customerUserId?: string | number | bigint | null,
  storeIds: Array<string | number | bigint | null | undefined> = [],
) {
  if (!cache) return;
  const operations: Promise<unknown>[] = [];
  if (customerUserId != null) for (const resource of ['dashboard', 'rentals', 'devices']) {
    operations.push(Promise.resolve().then(() => cache.invalidateKey(`customer:${resource}:${customerUserId}`)));
  }
  for (const id of new Set(storeIds.filter(id => id != null).map(String))) {
    operations.push(Promise.resolve().then(() => cache.invalidatePrefix(`dash:store:${id}:`)));
    operations.push(Promise.resolve().then(() => cache.invalidatePrefix(`staff:dashboard:store:${id}:`)));
  }
  for (const prefix of ['admin:dashboard:', 'admin:operations', 'admin:revenue:', 'admin:stores-leaderboard:', 'admin:growth:']) {
    operations.push(Promise.resolve().then(() => cache.invalidatePrefix(prefix)));
  }
  await Promise.allSettled(operations);
}
