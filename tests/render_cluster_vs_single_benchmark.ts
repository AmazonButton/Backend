/**
 * ============================================================
 *  CLUSTER vs SINGLE INSTANCE — ESCALATING LOAD BENCHMARK
 *  Smart Order Button Backend (Sem 9 FPTu)
 * ============================================================
 *
 *  So sanh hieu nang:
 *    [A] Single Instance  -> https://backend-fae8.onrender.com
 *    [B] Cloudflare Worker -> https://fragrant-mode-3a41.ptt24032004.workers.dev
 *         (Round-robin across backend-fae8 + backend-node2)
 *
 *  Waves: 1,000 -> 2,000 -> 3,000 requests
 *
 *  Run: npx tsx tests/render_cluster_vs_single_benchmark.ts
 * ============================================================
 */

const SINGLE_ORIGIN  = 'https://backend-fae8.onrender.com';
const NODE2_ORIGIN   = 'https://backend-node2-ukib.onrender.com';
const NODE3_ORIGIN   = 'http://ec2-3-25-136-6.ap-southeast-2.compute.amazonaws.com';
const WORKER_ORIGIN  = 'https://fragrant-mode-3a41.ptt24032004.workers.dev';
const TARGET_PATH    = '/healthz';
const REQUEST_TIMEOUT_MS = 25_000;
// Warmup: send enough requests to FULLY wake both Render free-tier nodes
const WARMUP_REQUESTS = 50;
// Cooldown between Single -> Worker runs inside same wave (ms)
const INTRA_WAVE_COOLDOWN_MS = 5_000;
// Cooldown between waves (ms)
const INTER_WAVE_COOLDOWN_MS = 8_000;

interface WaveConfig {
  label: string;
  requests: number;
  concurrency: number;
}

const WAVES: WaveConfig[] = [
  { label: 'Wave 1 (Ramp-up)', requests: 5_000, concurrency: 250 },
  { label: 'Wave 2 (High Stress)', requests: 10_000, concurrency: 500 },
  { label: 'Wave 3 (Peak Load)', requests: 10_000, concurrency: 1_000 },
];

interface RequestResult {
  durationMs: number;
  status: number;
  success: boolean;
  clusterNode?: string;
  error?: string;
}

interface WaveReport {
  origin: string;
  label: string;
  concurrency: number;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  successRate: number;
  durationTotalMs: number;
  rps: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgMs: number;
  node1Hits: number;
  node2Hits: number;
  node3Hits: number;
  failoverHits: number;
  statusMap: Record<string, number>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function bar(ratio: number, width = 28): string {
  const filled = Math.round(Math.min(1, ratio) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

const G  = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y  = (s: string) => `\x1b[33m${s}\x1b[0m`;
const R  = (s: string) => `\x1b[31m${s}\x1b[0m`;
const C  = (s: string) => `\x1b[36m${s}\x1b[0m`;
const B  = (s: string) => `\x1b[1m${s}\x1b[0m`;
const D  = (s: string) => `\x1b[2m${s}\x1b[0m`;

function latColor(ms: number): string {
  if (ms < 250)  return G(`${ms}ms`);
  if (ms < 700)  return Y(`${ms}ms`);
  return R(`${ms}ms`);
}

async function doRequest(url: string): Promise<RequestResult> {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ClusterBenchmark/1.0' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const durationMs = Math.round(performance.now() - start);
    return {
      durationMs,
      status: res.status,
      success: res.status < 500,
      clusterNode: res.headers.get('x-cluster-node') ?? undefined,
    };
  } catch (err: any) {
    return {
      durationMs: Math.round(performance.now() - start),
      status: 0,
      success: false,
      error: err.message,
    };
  }
}

async function runWave(origin: string, totalRequests: number, concurrency: number): Promise<RequestResult[]> {
  const url = `${origin}${TARGET_PATH}`;
  const results: RequestResult[] = [];
  let inflight = 0;
  let sent = 0;

  const tasks: Array<() => Promise<void>> = Array.from(
    { length: totalRequests },
    () => async () => { results.push(await doRequest(url)); }
  );

  await new Promise<void>((resolve) => {
    function pump() {
      while (inflight < concurrency && sent < tasks.length) {
        const task = tasks[sent++];
        inflight++;
        task().finally(() => {
          inflight--;
          if (results.length === totalRequests) resolve();
          else pump();
        });
      }
    }
    pump();
  });

  return results;
}

function buildReport(
  origin: string, label: string, total: number, concurrency: number,
  results: RequestResult[], wallMs: number,
): WaveReport {
  const lat   = results.map(r => r.durationMs).sort((a, b) => a - b);
  const ok    = results.filter(r => r.success).length;
  const node1 = results.filter(r => r.clusterNode === 'node-1').length;
  const node2 = results.filter(r => r.clusterNode === 'node-2').length;
  const node3 = results.filter(r => r.clusterNode === 'node-3').length;
  const fo    = results.filter(r => r.clusterNode === 'secondary-failover').length;
  const sum   = lat.reduce((a, b) => a + b, 0);

  const statusMap: Record<string, number> = {};
  for (const r of results) {
    const key = r.status > 0 ? `HTTP_${r.status}` : (r.error ? r.error.slice(0, 20) : 'Timeout');
    statusMap[key] = (statusMap[key] || 0) + 1;
  }

  return {
    origin, label, concurrency, totalRequests: total,
    successCount: ok, errorCount: total - ok,
    successRate: (ok / total) * 100,
    durationTotalMs: wallMs,
    rps: Math.round((total / (wallMs || 1)) * 1000),
    minMs: lat[0] ?? 0,
    p50Ms: percentile(lat, 50),
    p90Ms: percentile(lat, 90),
    p95Ms: percentile(lat, 95),
    p99Ms: percentile(lat, 99),
    maxMs: lat[lat.length - 1] ?? 0,
    avgMs: Math.round(sum / (lat.length || 1)),
    node1Hits: node1, node2Hits: node2, node3Hits: node3, failoverHits: fo,
    statusMap,
  };
}

function printReport(r: WaveReport, showNodes = false) {
  const rc = r.successRate >= 99 ? G : r.successRate >= 95 ? Y : R;
  console.log(`\n  ${B('Results')}`);
  console.log(`  ${'─'.repeat(62)}`);
  console.log(`  Requests  : ${r.totalRequests.toLocaleString()} total  |  ${G(r.successCount.toLocaleString())} ok  |  ${r.errorCount > 0 ? R(r.errorCount.toLocaleString()) : D(r.errorCount.toLocaleString())} errors`);
  console.log(`  Success   : ${rc(r.successRate.toFixed(2) + '%')}  ${rc(bar(r.successRate / 100))}`);
  console.log(`  Duration  : ${(r.durationTotalMs / 1000).toFixed(2)}s  |  RPS: ${C(r.rps.toString())}  |  Concurrency: ${C(r.concurrency.toString())}`);
  console.log(`  Latency   : min=${latColor(r.minMs)}  avg=${latColor(r.avgMs)}  max=${latColor(r.maxMs)}`);
  console.log(`  Percentile: p50=${latColor(r.p50Ms)}  p90=${latColor(r.p90Ms)}  p95=${latColor(r.p95Ms)}  p99=${latColor(r.p99Ms)}`);

  const codes = Object.entries(r.statusMap).map(([k, v]) => `${k}:${v}`).join(' | ');
  console.log(`  Breakdown : ${D(codes)}`);

  if (showNodes && (r.node1Hits + r.node2Hits + r.node3Hits + r.failoverHits) > 0) {
    const tot = r.node1Hits + r.node2Hits + r.node3Hits + r.failoverHits;
    console.log(`  ${'─'.repeat(62)}`);
    console.log(`  ${B('Worker Node Distribution (3-Node Multi-Cloud):')}`);
    console.log(`     Node-1 (Render Primary) : ${C(r.node1Hits.toString().padStart(5))} hits  (${C(((r.node1Hits/tot)*100).toFixed(1)+'%')})  ${bar(r.node1Hits/tot, 20)}`);
    console.log(`     Node-2 (Render Secondary): ${C(r.node2Hits.toString().padStart(5))} hits  (${C(((r.node2Hits/tot)*100).toFixed(1)+'%')})  ${bar(r.node2Hits/tot, 20)}`);
    console.log(`     Node-3 (AWS EC2 Sydney) : ${C(r.node3Hits.toString().padStart(5))} hits  (${C(((r.node3Hits/tot)*100).toFixed(1)+'%')})  ${bar(r.node3Hits/tot, 20)}`);
    if (r.failoverHits > 0)
      console.log(`     Failover (auto-reroute) : ${Y(r.failoverHits.toString().padStart(5))} hits  (${Y(((r.failoverHits/tot)*100).toFixed(1)+'%')})`);
  }
}

function printComparison(s: WaveReport, c: WaveReport) {
  function d(a: number, b: number, unit: string, lowerBetter = true): string {
    const delta = b - a;
    const pct   = a === 0 ? 0 : (Math.abs(delta) / a) * 100;
    const sign  = delta > 0 ? '+' : '';
    const label = `${sign}${Math.round(delta)}${unit} (${sign}${pct.toFixed(1)}%)`;
    const better = lowerBetter ? delta < 0 : delta > 0;
    return better ? G(label) : delta === 0 ? D(label) : R(label);
  }
  console.log(`\n  ${B('Comparison: [A] Single  vs  [B] Cloudflare Worker')}`);
  console.log(`  ${'─'.repeat(72)}`);
  console.log(`  ${'Metric'.padEnd(18)} ${'[A] Single'.padEnd(18)} ${'[B] CF Worker'.padEnd(18)} Delta`);
  console.log(`  ${'─'.repeat(72)}`);
  console.log(`  ${'RPS'.padEnd(18)} ${(s.rps + ' rps').padEnd(18)} ${(c.rps + ' rps').padEnd(18)} ${d(s.rps, c.rps, ' rps', false)}`);
  console.log(`  ${'p50'.padEnd(18)} ${(s.p50Ms + 'ms').padEnd(18)} ${(c.p50Ms + 'ms').padEnd(18)} ${d(s.p50Ms, c.p50Ms, 'ms')}`);
  console.log(`  ${'p95'.padEnd(18)} ${(s.p95Ms + 'ms').padEnd(18)} ${(c.p95Ms + 'ms').padEnd(18)} ${d(s.p95Ms, c.p95Ms, 'ms')}`);
  console.log(`  ${'p99'.padEnd(18)} ${(s.p99Ms + 'ms').padEnd(18)} ${(c.p99Ms + 'ms').padEnd(18)} ${d(s.p99Ms, c.p99Ms, 'ms')}`);
  console.log(`  ${'Max'.padEnd(18)} ${(s.maxMs + 'ms').padEnd(18)} ${(c.maxMs + 'ms').padEnd(18)} ${d(s.maxMs, c.maxMs, 'ms')}`);
  console.log(`  ${'Success Rate'.padEnd(18)} ${(s.successRate.toFixed(2)+'%').padEnd(18)} ${(c.successRate.toFixed(2)+'%').padEnd(18)} ${d(s.successRate, c.successRate, '%', false)}`);
  console.log(`  ${'Errors'.padEnd(18)} ${(s.errorCount.toString()).padEnd(18)} ${(c.errorCount.toString()).padEnd(18)} ${d(s.errorCount, c.errorCount, ' err')}`);
  console.log(`  ${'─'.repeat(72)}`);
}

async function main() {
  console.log(B('\n╔════════════════════════════════════════════════════════════╗'));
  console.log(B('║  CLUSTER vs SINGLE — EXTREME LOAD BENCHMARK (10K / 1K USERS)║'));
  console.log(B('║  Smart Order Button Backend · Sem 9 FPTu                   ║'));
  console.log(B('╚════════════════════════════════════════════════════════════╝'));
  console.log(`\n  ${B('Targets:')}`);
  console.log(`  [A] Single Node  -> ${D(SINGLE_ORIGIN + TARGET_PATH)}`);
  console.log(`  [B] CF Worker    -> ${D(WORKER_ORIGIN + TARGET_PATH)}`);
  console.log(`\n  ${B('Waves Plan:')}`);
  for (const w of WAVES) {
    console.log(`     • ${w.label.padEnd(22)} : ${w.requests.toLocaleString()} requests @ ${w.concurrency} concurrent users`);
  }
  console.log(`  ${B('Request Timeout:')} ${REQUEST_TIMEOUT_MS / 1000}s per request\n`);

  // ── Deep Warmup: wake all 3 raw nodes + Worker ───────────────────────────
  console.log(`  ${Y('Phase 1/4 — Pinging Node-1 (Render 1) directly...')}`);
  await runWave(SINGLE_ORIGIN, WARMUP_REQUESTS, 20);
  console.log(`  ${G('Node-1 (backend-fae8) warm ✓')}`);

  console.log(`  ${Y('Phase 2/4 — Pinging Node-2 (Render 2) directly...')}`);
  await runWave(NODE2_ORIGIN, WARMUP_REQUESTS, 20);
  console.log(`  ${G('Node-2 (backend-node2) warm ✓')}`);

  console.log(`  ${Y('Phase 3/4 — Pinging Node-3 (AWS EC2 Sydney) directly...')}`);
  await runWave(NODE3_ORIGIN, WARMUP_REQUESTS, 20);
  console.log(`  ${G('Node-3 (AWS EC2 Sydney) warm ✓')}`);

  console.log(`  ${Y('Phase 4/4 — Priming Cloudflare Worker (distributes to all 3 nodes)...')}`);
  await runWave(WORKER_ORIGIN, WARMUP_REQUESTS * 3, 50);
  console.log(`  ${G('CF Worker + all 3 nodes fully warm ✓')}`);

  console.log(`  ${Y('Settling 3s before benchmark starts...')}`);
  await new Promise(r => setTimeout(r, 3000));
  console.log(`  ${G('All nodes hot. Starting benchmark...')}`);
  console.log('\n' + '='.repeat(70));

  const allSingle:  WaveReport[] = [];
  const allCluster: WaveReport[] = [];

  for (let wi = 0; wi < WAVES.length; wi++) {
    const wave = WAVES[wi];
    console.log(`\n\n${B(`  WAVE ${wi + 1} — ${wave.label} (${wave.requests.toLocaleString()} reqs @ ${wave.concurrency} users)`)}`);
    console.log(`  ${'='.repeat(66)}`);

    console.log(`\n  ${C('[A] Single Instance')} -> ${D(SINGLE_ORIGIN)}`);
    const t0s = performance.now();
    const sr  = await runWave(SINGLE_ORIGIN, wave.requests, wave.concurrency);
    const sRep = buildReport(SINGLE_ORIGIN, wave.label, wave.requests, wave.concurrency, sr, Math.round(performance.now() - t0s));
    allSingle.push(sRep);
    printReport(sRep, false);

    console.log(`  ${Y(`Cooling down ${INTRA_WAVE_COOLDOWN_MS/1000}s before Worker run...`)}`);
    await new Promise(r => setTimeout(r, INTRA_WAVE_COOLDOWN_MS));

    console.log(`\n  ${C('[B] Cloudflare Worker (2-node cluster)')} -> ${D(WORKER_ORIGIN)}`);
    const t0c = performance.now();
    const cr  = await runWave(WORKER_ORIGIN, wave.requests, wave.concurrency);
    const cRep = buildReport(WORKER_ORIGIN, wave.label, wave.requests, wave.concurrency, cr, Math.round(performance.now() - t0c));
    allCluster.push(cRep);
    printReport(cRep, true);

    printComparison(sRep, cRep);

    if (wi < WAVES.length - 1) {
      console.log(`\n  ${Y(`Cooldown ${INTER_WAVE_COOLDOWN_MS/1000}s before next wave...`)}`);
      await new Promise(r => setTimeout(r, INTER_WAVE_COOLDOWN_MS));
    }
  }

  // ── Final Summary ──────────────────────────────────────────────────────────
  console.log(`\n\n${B('╔════════════════════════════════════════════════════════════╗')}`);
  console.log(B('║                  OVERALL SUMMARY                          ║'));
  console.log(B('╚════════════════════════════════════════════════════════════╝\n'));

  console.log(`  ${'Wave'.padEnd(20)} ${'Target'.padEnd(16)} ${'Users'.padEnd(8)} ${'RPS'.padEnd(8)} ${'p50'.padEnd(8)} ${'p95'.padEnd(8)} ${'p99'.padEnd(8)} Success`);
  console.log(`  ${'─'.repeat(80)}`);
  for (let i = 0; i < WAVES.length; i++) {
    const s = allSingle[i], c = allCluster[i];
    const fmt = (r: WaveReport, tag: string) =>
      `  ${WAVES[i].label.padEnd(20)} ${tag.padEnd(16)} ${(r.concurrency.toString()).padEnd(8)} ${(r.rps+'rps').padEnd(8)} ${(r.p50Ms+'ms').padEnd(8)} ${(r.p95Ms+'ms').padEnd(8)} ${(r.p99Ms+'ms').padEnd(8)} ${r.successRate.toFixed(1)}%`;
    console.log(D(fmt(s, '[A] Single')));
    const cLine = fmt(c, '[B] CF Worker');
    console.log(c.successRate >= s.successRate ? G(cLine) : Y(cLine));
    if (i < WAVES.length - 1) console.log();
  }

  const avgSingleP95  = allSingle.reduce((a, r) => a + r.p95Ms, 0) / allSingle.length;
  const avgClusterP95 = allCluster.reduce((a, r) => a + r.p95Ms, 0) / allCluster.length;
  const avgSingleRps  = allSingle.reduce((a, r) => a + r.rps, 0)   / allSingle.length;
  const avgClusterRps = allCluster.reduce((a, r) => a + r.rps, 0)  / allCluster.length;
  const totalSingleErr  = allSingle.reduce((a, r) => a + r.errorCount, 0);
  const totalClusterErr = allCluster.reduce((a, r) => a + r.errorCount, 0);

  console.log(`\n  ${B('Aggregates across all waves:')}`);
  console.log(`     Total Errors -> Single: ${totalSingleErr > 0 ? R(totalSingleErr.toString()) : G('0')}  |  CF Worker: ${totalClusterErr > 0 ? R(totalClusterErr.toString()) : G('0')}`);
  console.log(`     Avg p95 Lat  -> Single: ${latColor(Math.round(avgSingleP95))}  |  CF Worker: ${latColor(Math.round(avgClusterP95))}`);
  console.log(`     Avg RPS      -> Single: ${C(Math.round(avgSingleRps) + ' rps')}  |  CF Worker: ${C(Math.round(avgClusterRps) + ' rps')}`);

  if (totalClusterErr < totalSingleErr || avgClusterP95 < avgSingleP95) {
    console.log(`\n  ${G('Cluster (CF Worker) demonstrated superior stability & resilience under extreme load.')}`);
  } else {
    console.log(`\n  ${Y('Both architectures handled the load; CF Worker provides edge failover & DDoS shielding.')}`);
  }
  console.log(`\n${'='.repeat(70)}\n`);
}

main().catch(err => { console.error('\nBenchmark failed:', err.message); process.exit(1); });
