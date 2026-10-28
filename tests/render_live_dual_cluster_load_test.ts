import 'dotenv/config';

const NODES = [
  'https://backend-fae8.onrender.com',
  'https://backend-node2-ukib.onrender.com',
];

interface RequestResult {
  nodeIndex: number;
  statusCode: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

async function singleRequest(nodeIndex: number, path: string): Promise<RequestResult> {
  const url = `${NODES[nodeIndex]}${path}`;
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'DualClusterStressTest/2.0',
      },
      signal: AbortSignal.timeout(15000),
    });
    const durationMs = Date.now() - start;
    return {
      nodeIndex,
      statusCode: res.status,
      durationMs,
      success: res.status === 200,
    };
  } catch (err: any) {
    return {
      nodeIndex,
      statusCode: 0,
      durationMs: Date.now() - start,
      success: false,
      error: err.message,
    };
  }
}

function calculatePercentiles(durations: number[]) {
  if (durations.length === 0) return { p50: 0, p90: 0, p95: 0, p99: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const getIndex = (p: number) => Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return {
    p50: sorted[getIndex(50)],
    p90: sorted[getIndex(90)],
    p95: sorted[getIndex(95)],
    p99: sorted[getIndex(99)],
  };
}

async function runDualClusterLoadTest(totalRequests: number, concurrency: number, path: string) {
  console.log(`\n===============================================================`);
  console.log(`🚀 DUAL-NODE CLUSTER LOAD TEST: ${totalRequests} REQUESTS`);
  console.log(`👥 Concurrency: ${concurrency} Virtual Users (Round-Robin across 2 Nodes)`);
  console.log(`📍 Endpoint:    ${path}`);
  console.log(`🌐 Node 1:      ${NODES[0]}`);
  console.log(`🌐 Node 2:      ${NODES[1]}`);
  console.log(`===============================================================`);

  const results: RequestResult[] = [];
  let completed = 0;
  const overallStart = Date.now();

  const queue = Array.from({ length: totalRequests }, (_, i) => i);

  async function worker(workerId: number) {
    while (queue.length > 0) {
      const reqIndex = queue.shift();
      if (reqIndex === undefined) break;

      // Round-robin dispatching between Node 0 and Node 1
      const nodeIndex = reqIndex % NODES.length;
      const res = await singleRequest(nodeIndex, path);
      results.push(res);
      completed++;

      if (completed % 100 === 0 || completed === totalRequests) {
        process.stdout.write(`⚡ Progress: ${completed}/${totalRequests} requests completed...\r`);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  const overallDurationMs = Date.now() - overallStart;
  const rps = (totalRequests / (overallDurationMs / 1000)).toFixed(1);

  const node1Results = results.filter((r) => r.nodeIndex === 0);
  const node2Results = results.filter((r) => r.nodeIndex === 1);

  const successCount = results.filter((r) => r.success).length;
  const error429Count = results.filter((r) => r.statusCode === 429).length;
  const failCount = totalRequests - successCount;

  const allDurations = results.map((r) => r.durationMs);
  const p = calculatePercentiles(allDurations);

  const p1 = calculatePercentiles(node1Results.map((r) => r.durationMs));
  const p2 = calculatePercentiles(node2Results.map((r) => r.durationMs));

  console.log(`\n\n📊 RESULTS SUMMARY:`);
  console.log(`---------------------------------------------------------------`);
  console.log(`⏱️ Total Duration:       ${(overallDurationMs / 1000).toFixed(2)}s`);
  console.log(`🚀 Combined Throughput:   ${rps} Requests/Second`);
  console.log(`✅ Success Rate:          ${((successCount / totalRequests) * 100).toFixed(1)}% (${successCount}/${totalRequests})`);
  console.log(`⛔ Rate Limit 429:        ${error429Count} requests`);
  console.log(`❌ Other Failures:        ${failCount - error429Count} requests`);
  console.log(`\n📈 Combined Latency Distribution:`);
  console.log(`   P50 (Median):          ${p.p50} ms`);
  console.log(`   P90:                   ${p.p90} ms`);
  console.log(`   P95:                   ${p.p95} ms`);
  console.log(`   P99:                   ${p.p99} ms`);
  console.log(`\n⚖️ Per-Node Load Distribution:`);
  console.log(`   Node-1: ${node1Results.length} reqs | Success: ${node1Results.filter((r) => r.success).length} | P50: ${p1.p50}ms | P95: ${p1.p95}ms`);
  console.log(`   Node-2: ${node2Results.length} reqs | Success: ${node2Results.filter((r) => r.success).length} | P50: ${p2.p50}ms | P95: ${p2.p95}ms`);
  console.log(`===============================================================\n`);

  return { totalRequests, successCount, rps, p };
}

async function main() {
  // Test Tier 1: 500 requests across both nodes
  await runDualClusterLoadTest(500, 30, '/api/v1/stores');

  // Short cooldown
  console.log('⏳ Pausing 3 seconds before Tier 2 (1,000 requests)...');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Test Tier 2: 1,000 requests across both nodes (500 per node, completely avoids 429 rate limit!)
  await runDualClusterLoadTest(1000, 45, '/api/v1/stores');
}

main().catch(console.error);
