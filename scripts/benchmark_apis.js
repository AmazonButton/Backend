const { execSync } = require('child_process');
const path = require('path');

const RENDER_NODES = [
  { name: 'Render Node-1 (Primary)', baseUrl: 'https://backend-fae8.onrender.com' },
  { name: 'Render Node-2 (Secondary)', baseUrl: 'https://backend-node2-ukib.onrender.com' },
];

const BENCHMARK_APIS = [
  { method: 'GET', path: '/healthz', desc: 'Liveness Probe (Process UP)' },
  { method: 'GET', path: '/readyz', desc: 'Readiness Probe (Postgres + Redis Cache)' },
  { method: 'GET', path: '/api/v1/banks', desc: 'Vietnam Banks Directory (In-Memory Service)' },
  { method: 'GET', path: '/api/v1/subscription-plans', desc: 'Store Subscription Plans (Postgres Query)' },
  { method: 'GET', path: '/api/v1/rentals/packages', desc: 'Button Rental Packages (Postgres Query)' },
  { method: 'GET', path: '/api/v1/stores', desc: 'Active Stores Directory (Postgres + Filters)' },
  { method: 'GET', path: '/api/v1/products/storefront/catalog', desc: 'Storefront Product Catalog (Postgres Join)' },
  { 
    method: 'POST', 
    path: '/api/v1/auth/login', 
    body: JSON.stringify({ email: 'probe_test@invalid.com', password: 'WrongPassword123!' }),
    headers: { 'Content-Type': 'application/json' },
    desc: 'Auth Login & Argon2 Password Verify (Negative / Guard)' 
  },
];

async function measureHttp(baseUrl, api, runsCount = 3) {
  const durations = [];
  let lastStatus = 0;
  let lastData = null;

  for (let i = 0; i < runsCount; i++) {
    const start = performance.now();
    try {
      const res = await fetch(`${baseUrl}${api.path}`, {
        method: api.method,
        headers: api.headers || {},
        body: api.body || undefined,
        signal: AbortSignal.timeout(10000),
      });
      const duration = Math.round(performance.now() - start);
      durations.push(duration);
      lastStatus = res.status;
      try {
        lastData = await res.json();
      } catch {
        lastData = null;
      }
    } catch (err) {
      durations.push(Math.round(performance.now() - start));
      lastStatus = 'ERR';
      lastData = { message: err.message };
    }
  }

  const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const min = Math.min(...durations);
  const max = Math.max(...durations);

  return {
    status: lastStatus,
    avg,
    min,
    max,
    sample: lastData ? JSON.stringify(lastData).slice(0, 70) : '',
  };
}

async function runRenderBenchmarks() {
  console.log('================================================================================');
  console.log('⚡ SPEED & API LATENCY BENCHMARK: RENDER CLUSTER (NODES 1 & 2)');
  console.log('================================================================================\n');

  for (const node of RENDER_NODES) {
    console.log(`\n📦 --- ${node.name} (${node.baseUrl}) ---`);
    console.log('--------------------------------------------------------------------------------');
    console.log(
      'METHOD'.padEnd(7) +
      'ENDPOINT'.padEnd(36) +
      'STATUS'.padEnd(10) +
      'LATENCY (AVG/MIN)'.padEnd(20) +
      'DESCRIPTION'
    );
    console.log('--------------------------------------------------------------------------------');

    for (const api of BENCHMARK_APIS) {
      const res = await measureHttp(node.baseUrl, api, 3);
      const isOk = res.status === 200 || res.status === 401;
      const statusIcon = isOk ? '✔' : '✖';
      const latStr = `${res.avg}ms (min: ${res.min}ms)`;
      console.log(
        `${api.method.padEnd(7)}` +
        `${api.path.padEnd(36)}` +
        `${String(res.status).padEnd(10)}` +
        `${latStr.padEnd(20)}` +
        `${statusIcon} ${api.desc}`
      );
    }
  }
}

function runNode3Benchmark() {
  console.log('\n================================================================================');
  console.log('⚡ SPEED & API LATENCY BENCHMARK: AWS EC2 NODE-3 (SYDNEY WORKER)');
  console.log('================================================================================\n');

  const keyPath = path.join(process.env.USERPROFILE, '.ssh', 'id_aws_node3');
  const host = 'ubuntu@3.25.136.6';
  const sshBinary = 'C:\\Users\\ttphatt_2403\\git\\usr\\bin\\ssh.exe';

  // Remote bash script to execute on Node 3 directly
  const remoteCmd = `
    echo "METHOD ENDPOINT                            STATUS    LATENCY (s)  DESCRIPTION"
    echo "--------------------------------------------------------------------------------"
    curl -o /dev/null -s -w "GET    /healthz                            %{http_code}       %{time_total}s    ✔ Liveness Probe\\n" http://localhost:3000/healthz
    curl -o /dev/null -s -w "GET    /readyz                             %{http_code}       %{time_total}s    ✔ Readiness Probe (Postgres + Redis)\\n" http://localhost:3000/readyz
    curl -o /dev/null -s -w "GET    /api/v1/banks                       %{http_code}       %{time_total}s    ✔ Vietnam Banks Directory\\n" http://localhost:3000/api/v1/banks
    curl -o /dev/null -s -w "GET    /api/v1/subscription-plans          %{http_code}       %{time_total}s    ✔ Store Subscription Plans\\n" http://localhost:3000/api/v1/subscription-plans
    curl -o /dev/null -s -w "GET    /api/v1/rentals/packages            %{http_code}       %{time_total}s    ✔ Button Rental Packages\\n" http://localhost:3000/api/v1/rentals/packages
    curl -o /dev/null -s -w "GET    /api/v1/stores                      %{http_code}       %{time_total}s    ✔ Active Stores Directory\\n" http://localhost:3000/api/v1/stores
    curl -o /dev/null -s -w "GET    /api/v1/products/storefront/catalog %{http_code}       %{time_total}s    ✔ Storefront Product Catalog\\n" http://localhost:3000/api/v1/products/storefront/catalog
    curl -o /dev/null -s -X POST -H "Content-Type: application/json" -d '{"email":"test@invalid.com","password":"123"}' -w "POST   /api/v1/auth/login                 %{http_code}       %{time_total}s    ✔ Auth Login Flow (Argon2 Verify)\\n" http://localhost:3000/api/v1/auth/login
  `;

  try {
    const output = execSync(`"${sshBinary}" -i "${keyPath}" -o StrictHostKeyChecking=no ${host} "${remoteCmd}"`, {
      encoding: 'utf8',
    });
    console.log(output);
  } catch (err) {
    console.error(`Failed to benchmark Node 3: ${err.message}`);
  }
}

async function main() {
  await runRenderBenchmarks();
  runNode3Benchmark();
}

main().catch(console.error);
