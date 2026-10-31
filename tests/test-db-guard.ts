import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';

export interface TestDbValidationResult {
  isValid: boolean;
  error?: string;
  normalizedTestUrl?: string;
  normalizedPrimaryUrl?: string;
  parsedDbName?: string;
  parsedHost?: string;
  parsedPort?: number;
}

/**
 * Validates a test database connection string against strict security invariants:
 * 1. Must be a valid URL with protocol postgres: or postgresql:
 * 2. Hostname must be strictly 'localhost', '127.0.0.1', '::1', or in TEST_DB_ALLOWED_HOSTS.
 * 3. Case-insensitive hostname check; explicitly blocks any supabase domain.
 * 4. Subdomains like 'localhost.attacker.com' are strictly blocked.
 * 5. Database name (pathname) must strictly end with '_test' (e.g. /smart_order_test).
 * 6. Connection target (host, port, db, schema) must not match primary DATABASE_URL.
 */
export function validateTestDatabaseUrl(
  testUrlRaw?: string,
  primaryUrlRaw?: string,
): TestDbValidationResult {
  if (!testUrlRaw || typeof testUrlRaw !== 'string' || testUrlRaw.trim().length === 0) {
    return {
      isValid: false,
      error: 'TEST_DATABASE_URL environment variable is mandatory and cannot be empty.',
    };
  }

  const trimmedTest = testUrlRaw.trim();
  let parsedTest: URL;
  try {
    parsedTest = new URL(trimmedTest);
  } catch (err: any) {
    return {
      isValid: false,
      error: `Invalid TEST_DATABASE_URL format: ${err.message}`,
    };
  }

  // 1. Protocol check
  const protocol = parsedTest.protocol.toLowerCase();
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    return {
      isValid: false,
      error: `TEST_DATABASE_URL must use postgres: or postgresql: protocol, got: '${parsedTest.protocol}'`,
    };
  }

  // 2. Hostname extraction & normalization
  let hostname = parsedTest.hostname.toLowerCase();
  // Strip IPv6 brackets if present, e.g. [::1] -> ::1
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  // 3. Supabase block (case-insensitive across hostname)
  if (hostname.includes('supabase.co') || hostname.includes('supabase.com')) {
    return {
      isValid: false,
      error: 'TEST_DATABASE_URL cannot point to Supabase production or cloud pooler infrastructure.',
    };
  }

  // 4. Strict hostname allowlist
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
  const customAllowed = process.env.TEST_DB_ALLOWED_HOSTS;
  if (customAllowed) {
    for (const h of customAllowed.split(',')) {
      const clean = h.trim().toLowerCase();
      if (clean) allowedHosts.add(clean);
    }
  }

  if (!allowedHosts.has(hostname)) {
    return {
      isValid: false,
      error: `Hostname '${hostname}' is not in the allowed test database hosts list (${Array.from(allowedHosts).join(', ')}). Remote hostnames and subdomains like 'localhost.attacker.com' are strictly blocked.`,
    };
  }

  // 5. Database name check: Must strictly end with '_test'
  const rawPath = parsedTest.pathname.replace(/^\/+/, '');
  const dbName = rawPath.split('/')[0]?.toLowerCase();
  if (!dbName || !dbName.endsWith('_test')) {
    return {
      isValid: false,
      error: `Test database name '${dbName || ''}' must strictly end with suffix '_test' (e.g. 'postgres_test', 'smart_order_test') to guarantee schema isolation.`,
    };
  }

  const testPort = parseInt(parsedTest.port || '5432', 10);
  const testSchema = (
    parsedTest.searchParams.get('schema') ||
    parsedTest.searchParams.get('search_path') ||
    'public'
  ).toLowerCase();

  // 6. Compare with primary DATABASE_URL if available
  if (primaryUrlRaw && primaryUrlRaw.trim().length > 0) {
    try {
      const parsedPrimary = new URL(primaryUrlRaw.trim());
      let primaryHost = parsedPrimary.hostname.toLowerCase();
      if (primaryHost.startsWith('[') && primaryHost.endsWith(']')) {
        primaryHost = primaryHost.slice(1, -1);
      }
      const primaryPort = parseInt(parsedPrimary.port || '5432', 10);
      const primaryDbName = parsedPrimary.pathname.replace(/^\/+/, '').split('/')[0]?.toLowerCase();
      const primarySchema = (
        parsedPrimary.searchParams.get('schema') ||
        parsedPrimary.searchParams.get('search_path') ||
        'public'
      ).toLowerCase();

      // Canonicalize loopback aliases to prevent 'localhost' vs '127.0.0.1' bypass
      const canonicalizeHost = (h: string) =>
        ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(h.toLowerCase()) ? '127.0.0.1' : h.toLowerCase();

      const canonTestHost = canonicalizeHost(hostname);
      const canonPrimaryHost = canonicalizeHost(primaryHost);

      // Check if target database is identical
      if (
        canonTestHost === canonPrimaryHost &&
        testPort === primaryPort &&
        dbName === primaryDbName &&
        testSchema === primarySchema
      ) {
        return {
          isValid: false,
          error: `TEST_DATABASE_URL connects to the exact same database target as primary DATABASE_URL (${primaryHost}:${primaryPort}/${primaryDbName}?schema=${primarySchema}).`,
        };
      }
    } catch {
      // If primary URL fails to parse, it won't cause false negatives here
    }
  }

  return {
    isValid: true,
    normalizedTestUrl: trimmedTest,
    parsedDbName: dbName,
    parsedHost: hostname,
    parsedPort: testPort,
  };
}

/**
 * Enforces test database invariants and binds environment variables:
 * - Validates candidate URL strictly (allowed host, _test suffix, non-production).
 * - NODE_ENV=test or ALLOW_TEST_DB_RUN=true does NEVER bypass URL validation.
 * - Forces process.env.DATABASE_URL and process.env.TEST_DATABASE_URL to safeUrl so Nest AppModule / PrismaService use it.
 * - Throws an Error if validation fails.
 */
export function assertSafeTestDatabaseUrl(suiteName: string = 'Test Suite'): string {
  const testUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  const primaryUrl = process.env.PRIMARY_DATABASE_URL || (process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ? process.env.DATABASE_URL : undefined);

  const validation = validateTestDatabaseUrl(testUrl, primaryUrl);
  if (!validation.isValid) {
    const errorMsg = `[SECURITY GUARD] ${suiteName} REFUSED TO EXECUTE! Reason: ${validation.error}`;
    console.error(`\n❌ ${errorMsg}`);
    console.error(
      `   To run tests safely, provide TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/<db_name>_test\n`,
    );
    throw new Error(`TEST-DB GUARD: ${errorMsg}`);
  }

  // Strict binding: Overwrite environment variables to guarantee zero unparameterized leakage
  process.env.DATABASE_URL = validation.normalizedTestUrl!;
  process.env.TEST_DATABASE_URL = validation.normalizedTestUrl!;

  return validation.normalizedTestUrl!;
}

/**
 * Creates a PrismaClient connected strictly to the verified TEST_DATABASE_URL.
 */
export function getSafeTestPrismaClient(suiteName: string): PrismaClient {
  const safeUrl = assertSafeTestDatabaseUrl(suiteName);
  return new PrismaClient({
    datasources: {
      db: {
        url: safeUrl,
      },
    },
  });
}

/**
 * Creates a PrismaService connected strictly to the verified TEST_DATABASE_URL.
 */
export function getSafeTestPrismaService(suiteName: string): PrismaService {
  const safeUrl = assertSafeTestDatabaseUrl(suiteName);
  return new PrismaService({
    datasources: {
      db: {
        url: safeUrl,
      },
    },
  });
}

/**
 * General Test Database Safety Guard
 * Prevents running integration tests or data-modifying suites against staging or production databases.
 * Guarantees zero bypass: NODE_ENV=test or ALLOW_TEST_DB_RUN=true is NEVER a bypass for an unverified/remote URL.
 */
export function assertTestDatabase(suiteName: string = 'Test Suite'): string {
  return assertSafeTestDatabaseUrl(suiteName);
}
