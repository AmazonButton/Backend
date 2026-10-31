/**
 * ============================================================================
 *  MULTI-CLOUD LOAD CAPACITY & SCALABILITY STRESS BENCHMARK
 *  Smart Order Button Platform (Sem 9 FPTu)
 * ============================================================================
 *
 *  Evaluates:
 *   - Real-world throughput (RPS) and latency curve across escalating concurrency
 *   - Traffic routing adherence: 85% AWS (Node 3) + 15% Render (Node 1) + 100% Webhook pinning
 *   - Saturation ceiling & bottleneck identification (CPU, Memory, Rate-limits)
 *   - AWS EC2 Node 3 host resource telemetry (Swap, PM2, RAM)
 *
 *  Run: npx tsx tests/multicloud_load_stress_benchmark.ts
 * ============================================================================
 */

import { execSync } from 'child_process';
import path from 'path';

const WORKER_ORIGIN = 'https://fragrant-mode-3a41.ptt24032004.workers.dev';
const REQUEST_TIMEOUT_MS = 20_000;

interface WaveConfig {
  label: string;
  requests: number;
  concurrency: number;
  description: string;
}

const WAVES: WaveConfig[] = [
  { label: 'Wave 1 (Baseline / Medium)', requests: 1_000, concurrency: 50,  description: 'Standard multi-user traffic (steady state)' },
  { label: 'Wave 2 (High Traffic Rush)',  requests: 2_500, concurrency: 150, description: 'Flash sale / concurrent checkout rush' },
  { label: 'Wave 3 (Peak Saturation)',    requests: 5_000, concurrency: 300, description: 'Near-capacity saturation test' },
  { label: 'Wave 4 (Extreme Ceiling)',    requests: 5_000, concurrency: 600, description: 'Stress to find absolute breaking/throttling point' },
];

interface RequestResult {
  durationMs: number;
  status: number;
  success: boolean;
  clusterNode?: string;
  clusterRole?: string;
  routeType: 'core' | 'third-party';
  error?: string;
}

interface WaveSummary {
  label: string;
  concurrency: number;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  rateLimitCount: number;
  successRate: number;
  wallClockMs: number;
  rps: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  node1Hits: number;
  node2Hits: number;
  node3Hits: number;
  failoverHits: number;
  statusMap: Record<string, number>;
}

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const C = (s: string) => `\x1b[36m${s}\x1b[0m`;
const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function bar(ratio: number, width = 24): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function getRemoteHostMetrics() {
  try {
    const keyPath = path.join(process.env.USERPROFILE || '', '.ssh', 'id_aws_node3');
    const sshBin = 'C:\\Users\\ttphatt_2403\\git\\usr\\bin\\ssh.exe';
    const out = execSync(`"${sshBin}" -i "${keyPath}" -o StrictHostKeyChecking=no ubuntu@3.25.136.6 "free -m && pm2 jlist"`, {
      encoding: 'utf8',
      timeout: 10000,
    });
    const lines = out.trim().split('\n');
    const memLine = lines.find(l => l.startsWith('Mem:')) || '';
    const swapLine = lines.find(l => l.startsWith('Swap:')) || '';
    const jsonStr = out.substring(out.indexOf('['));
    const pm2List = JSON.parse(jsonStr);
    const node3App = pm2List.find((p: any) => p.name === 'backend-node3');
    return {
      status: node3App?.pm2_env?.status || 'unknown',
      memoryMb: Math.round((node3App?.monit?.memory || 0) / 1024 / 1024),
      cpuPct: node3App?.monit?.cpu || 0,
      restarts: node3App?.pm2_env?.restart_time || 0,
      uptimeMins: Math.round((Date.now() - (node3App?.pm2_env?.pm_uptime || Date.now())) / 60000),
      memSummary: memLine.replace(/\s+/g, ' ').trim(),
      swapSummary: swapLine.replace(/\s+/g, ' ').trim(),
    };
  } catch (err: any) {
    return { error: err.message };
  }
}

async function doRequest(path: string, routeType: 'core' | 'third-party'): Promise<RequestResult> {
  const start = performance.now();
  try {
    const res = await fetch(`${WORKER_ORIGIN}${path}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MultiCloudStressBenchmark/1.0',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const durationMs = Math.round(performance.now() - start);
    return {
      durationMs,
      status: res.status,
      success: res.status >= 200 && res.status < 500,
      clusterNode: res.headers.get('x-cluster-node') ?? undefined,
      clusterRole: res.headers.get('x-cluster-role') ?? undefined,
      routeType,
    };
  } catch (err: any) {
    return {
      durationMs: Math.round(performance.now() - start),
      status: 0,
      success: false,
      routeType,
      error: err.message,
    };
  }
}

async function runWave(wave: WaveConfig): Promise<WaveSummary> {
  console.log(B(`\n──────────────────────────────────────────────────────────────────────`));
  console.log(B(`▶ ${wave.label.toUpperCase()}`));
  console.log(D(`  Target: ${wave.requests.toLocaleString()} reqs | Concurrency: ${wave.concurrency} | ${wave.description}`));
  console.log(B(`──────────────────────────────────────────────────────────────────────`));

  const results: RequestResult[] = [];
  let inflight = 0;
  let sent = 0;
  const startWall = performance.now();

  // 80% Core traffic (/healthz), 20% Third-party traffic (/api/v1/banks)
  const tasks: Array<() => Promise<void>> = Array.from({ length: wave.requests }, (_, i) => {
    const isThirdParty = i % 5 === 0;
    const path = isThirdParty ? '/api/v1/banks' : '/healthz';
    const routeType = isThirdParty ? 'third-party' : 'core';
    return async () => {
      const res = await doRequest(path, routeType);
      results.push(res);
    };
  });

  process.stdout.write(`  Progress [${wave.requests} reqs]: `);
  let lastPct = 0;

  await new Promise<void>((resolve) => {
    function pump() {
      while (inflight < wave.concurrency && sent < tasks.length) {
        const task = tasks[sent++];
        inflight++;
        task().finally(() => {
          inflight--;
          const currentPct = Math.floor((results.length / wave.requests) * 10);
          if (currentPct > lastPct) {
            lastPct = currentPct;
            process.stdout.write(`${currentPct * 10}% `);
          }
          if (results.length === wave.requests) resolve();
          else pump();
        });
      }
    }
    pump();
  });

  const wallClockMs = Math.round(performance.now() - startWall);
  process.stdout.write(G('✔ Done\n\n'));

  const lat = results.map(r => r.durationMs).sort((a, b) => a - b);
  const ok = results.filter(r => r.success).length;
  const rateLimited = results.filter(r => r.status === 429).length;
  const node1 = results.filter(r => r.clusterNode === 'node-1').length;
  const node2 = results.filter(r => r.clusterNode === 'node-2').length;
  const node3 = results.filter(r => r.clusterNode === 'node-3').length;
  const fo = results.filter(r => r.clusterRole?.includes('fallback') || r.clusterRole?.includes('standby')).length;

  const statusMap: Record<string, number> = {};
  for (const r of results) {
    const key = r.status > 0 ? `HTTP_${r.status}` : (r.error ? r.error.slice(0, 24) : 'Timeout');
    statusMap[key] = (statusMap[key] || 0) + 1;
  }

  const rps = Math.round((wave.requests / (wallClockMs || 1)) * 1000);
  const successRate = (ok / wave.requests) * 100;

  console.log(`  Metrics:`);
  console.log(`    Throughput (RPS)       : ${B(C(`${rps} req/sec`))} (Wall clock: ${(wallClockMs / 1000).toFixed(2)}s)`);
  console.log(`    Success Rate           : ${successRate >= 98 ? G(`${successRate.toFixed(2)}%`) : Y(`${successRate.toFixed(2)}%`)} (${ok}/${wave.requests})`);
  console.log(`    Latency Profile        : min ${lat[0]}ms | ${B(`p50 ${percentile(lat, 50)}ms`)} | p90 ${percentile(lat, 90)}ms | ${B(Y(`p95 ${percentile(lat, 95)}ms`))} | p99 ${percentile(lat, 99)}ms | max ${lat[lat.length - 1]}ms`);
  console.log(`    Traffic Allocation     :`);
  console.log(`      Node 3 (AWS Sydney)  : ${node3.toString().padStart(5)} hits (${((node3 / wave.requests) * 100).toFixed(1)}%) ${bar(node3 / wave.requests)}`);
  console.log(`      Node 1 (Render Main) : ${node1.toString().padStart(5)} hits (${((node1 / wave.requests) * 100).toFixed(1)}%) ${bar(node1 / wave.requests)}`);
  console.log(`      Node 2 (Render Stby) : ${node2.toString().padStart(5)} hits (${((node2 / wave.requests) * 100).toFixed(1)}%) ${bar(node2 / wave.requests)}`);
  if (fo > 0) {
    console.log(`      Failover Invocations : ${R(fo.toString())} hits`);
  }
  console.log(`    Status Code Breakdown  : ${Object.entries(statusMap).map(([k, v]) => `${k}: ${v}`).join(' | ')}`);

  return {
    label: wave.label,
    concurrency: wave.concurrency,
    totalRequests: wave.requests,
    successCount: ok,
    errorCount: wave.requests - ok,
    rateLimitCount: rateLimited,
    successRate,
    wallClockMs,
    rps,
    minMs: lat[0] ?? 0,
    p50Ms: percentile(lat, 50),
    p90Ms: percentile(lat, 90),
    p95Ms: percentile(lat, 95),
    p99Ms: percentile(lat, 99),
    maxMs: lat[lat.length - 1] ?? 0,
    node1Hits: node1,
    node2Hits: node2,
    node3Hits: node3,
    failoverHits: fo,
    statusMap,
  };
}

async function main() {
  console.log(B('\n╔════════════════════════════════════════════════════════════════════╗'));
  console.log(B('║   MULTI-CLOUD CLUSTER LOAD CAPACITY & STRESS BENCHMARK             ║'));
  console.log(B('║   Smart Order Button Platform (Sem 9 FPTu)                         ║'));
  console.log(B('╚════════════════════════════════════════════════════════════════════╝'));
  console.log(`Cluster Router   : ${C(WORKER_ORIGIN)}`);
  console.log(`Node 1 (Render)  : https://backend-fae8.onrender.com`);
  console.log(`Node 2 (Render)  : https://backend-node2-ukib.onrender.com (Hot Standby)`);
  console.log(`Node 3 (AWS EC2) : http://ec2-3-25-136-6.ap-southeast-2.compute.amazonaws.com`);
  console.log(`Local Time       : ${new Date().toISOString()}\n`);

  console.log(B('Collecting initial AWS EC2 Node 3 host health...'));
  const initialHost = getRemoteHostMetrics();
  console.log(`  Initial AWS PM2 Status : ${initialHost.status} | Mem: ${initialHost.memoryMb}MB | CPU: ${initialHost.cpuPct}% | Restarts: ${initialHost.restarts}`);
  console.log(`  Initial AWS Memory     : ${initialHost.memSummary}`);
  console.log(`  Initial AWS Swap       : ${initialHost.swapSummary}\n`);

  console.log(D('Warming up Cloudflare edge & all backend nodes (50 requests)...'));
  for (let i = 0; i < 50; i++) {
    await fetch(`${WORKER_ORIGIN}/healthz`).catch(() => {});
  }
  console.log(G('Warm-up complete!\n'));

  const summaries: WaveSummary[] = [];
  for (const wave of WAVES) {
    const summary = await runWave(wave);
    summaries.push(summary);
    // Cool down 4 seconds between waves to let connection pools drain
    console.log(D('  Cooling down 4,000ms before next wave...'));
    await new Promise(r => setTimeout(r, 4000));
  }

  console.log(B('\nCollecting post-stress AWS EC2 Node 3 host health...'));
  const postHost = getRemoteHostMetrics();
  console.log(`  Post-Stress AWS Status : ${postHost.status} | Mem: ${postHost.memoryMb}MB | CPU: ${postHost.cpuPct}% | Restarts: ${postHost.restarts}`);
  console.log(`  Post-Stress AWS Memory : ${postHost.memSummary}`);
  console.log(`  Post-Stress AWS Swap   : ${postHost.swapSummary}\n`);

  console.log(B('══════════════════════════════════════════════════════════════════════'));
  console.log(B('               OVERALL BENCHMARK COMPARISON MATRIX                    '));
  console.log(B('══════════════════════════════════════════════════════════════════════'));
  console.log(`| Wave                     | Concurrency | Reqs   | RPS     | p50 (ms) | p95 (ms) | p99 (ms) | Success Rate | AWS Share |`);
  console.log(`|--------------------------|-------------|--------|---------|----------|----------|----------|--------------|-----------|`);
  for (const s of summaries) {
    const waveName = s.label.padEnd(24);
    const conc = s.concurrency.toString().padStart(11);
    const reqs = s.totalRequests.toLocaleString().padStart(6);
    const rps = s.rps.toString().padStart(7);
    const p50 = s.p50Ms.toString().padStart(8);
    const p95 = s.p95Ms.toString().padStart(8);
    const p99 = s.p99Ms.toString().padStart(8);
    const succ = (s.successRate.toFixed(1) + '%').padStart(12);
    const awsShare = (((s.node3Hits / s.totalRequests) * 100).toFixed(1) + '%').padStart(9);
    console.log(`| ${waveName} | ${conc} | ${reqs} | ${rps} | ${p50} | ${p95} | ${p99} | ${succ} | ${awsShare} |`);
  }
  console.log(B('══════════════════════════════════════════════════════════════════════\n'));
}

main().catch(err => {
  console.error('Fatal load test failure:', err);
  process.exit(1);
});
