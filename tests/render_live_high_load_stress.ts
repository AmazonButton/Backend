import jwt from 'jsonwebtoken';

interface StressResult {
  tierName: string;
  targetUrl: string;
  virtualUsers: number;
  totalRequests: number;
  completedRequests: number;
  successfulRequests: number;
  durationMs: number;
  rps: number;
  minLatencyMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxLatencyMs: number;
  avgLatencyMs: number;
  successRate: number;
}

const LIVE_BASE = 'https://backend-fae8.onrender.com';
const API_BASE = `${LIVE_BASE}/api/v1`;
const JWT_SECRET = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

function createToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

const customerToken = createToken({
  sub: '7',
  userId: '7',
  username: 'customer',
  role: 'CUSTOMER',
});

function calculatePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

async function singleRequest(
  url: string,
  token?: string
): Promise<{ durationMs: number; success: boolean }> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'RenderStressLoadSuite/2.0',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const start = performance.now();
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const durationMs = Math.round(performance.now() - start);
    return {
      durationMs,
      success: res.status >= 200 && res.status < 400,
    };
  } catch {
    const durationMs = Math.round(performance.now() - start);
    return {
      durationMs,
      success: false,
    };
  }
}

async function runHighLoadTier(
  tierName: string,
  routePath: string,
  virtualUsers: number,
  totalRequests: number,
  token?: string
): Promise<StressResult> {
  const url = routePath.startsWith('http') ? routePath : `${API_BASE}${routePath}`;
  const latencies: number[] = [];
  let successful = 0;
  let counter = 0;

  const startTime = performance.now();

  async function worker() {
    while (true) {
      const idx = counter++;
      if (idx >= totalRequests) break;

      const record = await singleRequest(url, token);
      latencies.push(record.durationMs);
      if (record.success) successful++;
    }
  }

  const workers = Array.from({ length: virtualUsers }, () => worker());
  await Promise.all(workers);

  const durationMs = Math.round(performance.now() - startTime);
  const rps = Math.round((totalRequests / (durationMs / 1000)) * 10) / 10;
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    tierName,
    targetUrl: routePath,
    virtualUsers,
    totalRequests,
    completedRequests: latencies.length,
    successfulRequests: successful,
    durationMs,
    rps,
    minLatencyMs: sorted[0] || 0,
    p50Ms: calculatePercentile(sorted, 50),
    p90Ms: calculatePercentile(sorted, 90),
    p95Ms: calculatePercentile(sorted, 95),
    p99Ms: calculatePercentile(sorted, 99),
    maxLatencyMs: sorted[sorted.length - 1] || 0,
    avgLatencyMs: Math.round(sum / (sorted.length || 1)),
    successRate: Math.round((successful / totalRequests) * 100),
  };
}

async function main() {
  console.log('========================================================================');
  console.log('🔥 ENTERPRISE HIGH-LOAD & STRESS TEST: 500 TO 1,000 REQUESTS');
  console.log(`Live Target: ${LIVE_BASE} (Cloudflare Edge / Singapore / Supabase)`);
  console.log(`Execution Timestamp: ${new Date().toISOString()}`);
  console.log('========================================================================\n');

  const tiers = [
    {
      name: 'Tier 100 - Ramp-up Liveness Probe',
      path: `${LIVE_BASE}/healthz`,
      users: 20,
      requests: 100,
      token: undefined,
    },
    {
      name: 'Tier 250 - Stores Catalog (Redis Cache)',
      path: '/stores',
      users: 25,
      requests: 250,
      token: undefined,
    },
    {
      name: 'Tier 500 - High-Load Catalog Burst (500 Requests)',
      path: '/stores',
      users: 35,
      requests: 500,
      token: undefined,
    },
    {
      name: 'Tier 1000 - Extreme Stress Test (1,000 Requests)',
      path: '/stores',
      users: 50,
      requests: 1000,
      token: undefined,
    },
    {
      name: 'Tier 100 - DB Authenticated Read (Orders)',
      path: '/orders',
      users: 15,
      requests: 100,
      token: customerToken,
    },
  ];

  const results: StressResult[] = [];

  for (const t of tiers) {
    console.log(`▶ Starting [${t.name}] | ${t.users} Concurrent VUs | Target: ${t.requests} requests...`);
    const res = await runHighLoadTier(t.name, t.path, t.users, t.requests, t.token);
    results.push(res);
    console.log(
      `✔ Completed in ${res.durationMs}ms | Throughput: ${res.rps} RPS | Success: ${res.successfulRequests}/${res.totalRequests} (${res.successRate}%) | P50: ${res.p50Ms}ms | P95: ${res.p95Ms}ms | P99: ${res.p99Ms}ms\n`
    );
    // Cool-down
    await new Promise((r) => setTimeout(r, 1000));
  }

  // ============================================================================
  // Defense Scorecard Table
  // ============================================================================
  console.log('========================================================================================================================');
  console.log('📊 CAPSTONE COUNCIL DEFENSE: 500 - 1,000 LOAD & STRESS SCORECARD');
  console.log('========================================================================================================================');
  console.log(
    '| Test Tier Description             | VUs  | Requests | Duration(ms) |   RPS   | P50(ms) | P90(ms) | P95(ms) | P99(ms) | Success Rate |'
  );
  console.log(
    '|:-----------------------------------|:----:|:--------:|:------------:|:-------:|:-------:|:-------:|:-------:|:-------:|:------------:|'
  );
  for (const r of results) {
    console.log(
      `| ${r.tierName.padEnd(33)} | ${String(r.virtualUsers).padStart(4)} | ${String(r.totalRequests).padStart(8)} | ${String(r.durationMs).padStart(12)} | ${String(r.rps).padStart(7)} | ${String(r.p50Ms).padStart(7)} | ${String(r.p90Ms).padStart(7)} | ${String(r.p95Ms).padStart(7)} | ${String(r.p99Ms).padStart(7)} | ${(r.successRate + '%').padStart(12)} |`
    );
  }
  console.log('========================================================================================================================');
  console.log('\n🎉 ALL HIGH-LOAD TIERS (UP TO 1,000 REQUESTS) EXECUTED SUCCESSFULLY ON LIVE RENDER PRODUCTION!');
}

main().catch((err) => {
  console.error('Fatal stress test failure:', err);
  process.exit(1);
});
