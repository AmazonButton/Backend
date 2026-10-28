import 'dotenv/config';

interface RenderNode {
  name: string;
  account: string;
  serviceId: string;
  apiKey: string;
  url: string;
}

const NODES: RenderNode[] = [
  {
    name: 'Node-1 (Primary)',
    account: 'Account 1',
    serviceId: 'srv-dbdom8gm7kps73ebg5fg',
    apiKey: process.env.RENDER_API_KEY_1 || '',
    url: 'https://backend-fae8.onrender.com',
  },
  {
    name: 'Node-2 (Secondary)',
    account: 'Account 2',
    serviceId: 'srv-dbgqpgugekts738lbreg',
    apiKey: process.env.RENDER_API_KEY_2 || '',
    url: 'https://backend-node2-ukib.onrender.com',
  },
];

const RENDER_API_BASE = 'https://api.render.com/v1';

async function renderFetch(apiKey: string, path: string, options: RequestInit = {}) {
  const res = await fetch(`${RENDER_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Render API HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function getClusterStatus() {
  console.log('\n===============================================================');
  console.log('🌐 RENDER MULTI-INSTANCE CLUSTER STATUS');
  console.log('===============================================================');

  for (const node of NODES) {
    if (!node.apiKey) {
      console.log(`❌ [${node.name}] Missing API key in environment variables.`);
      continue;
    }

    try {
      // 1. Fetch Render Service Details
      const service = await renderFetch(node.apiKey, `/services/${node.serviceId}`);
      const latestDeploys = await renderFetch(node.apiKey, `/services/${node.serviceId}/deploys?limit=1`);
      const deploy = latestDeploys[0]?.deploy;

      // 2. Healthz Ping
      const start = Date.now();
      let healthzStatus = 'UNKNOWN';
      let uptime = 0;
      try {
        const ping = await fetch(`${node.url}/healthz`, { signal: AbortSignal.timeout(5000) });
        const latency = Date.now() - start;
        if (ping.ok) {
          const body: any = await ping.json();
          healthzStatus = `ONLINE (${latency}ms)`;
          uptime = body.uptimeSeconds || 0;
        } else {
          healthzStatus = `HTTP ${ping.status}`;
        }
      } catch (err: any) {
        healthzStatus = `OFFLINE (${err.message})`;
      }

      console.log(`\n📦 ${node.name} [${node.account}]`);
      console.log(`   🔗 URL:          ${node.url}`);
      console.log(`   🆔 Service ID:   ${node.serviceId}`);
      console.log(`   🚀 Deploy Status:${deploy?.status === 'live' ? '🟢 LIVE' : '🟡 ' + deploy?.status} (Commit: ${deploy?.commit?.id?.slice(0, 7) || 'N/A'})`);
      console.log(`   💓 Healthz:      ${healthzStatus} (Uptime: ${uptime}s)`);
      console.log(`   🔄 Auto-Deploy:  ${service.autoDeploy} (Trigger: ${service.autoDeployTrigger})`);
    } catch (err: any) {
      console.error(`   ❌ Failed to query ${node.name}: ${err.message}`);
    }
  }
  console.log('\n===============================================================\n');
}

async function triggerClusterDeploy() {
  console.log('\n===============================================================');
  console.log('🚀 TRIGGERING CONCURRENT CLUSTER DEPLOY ON ALL INSTANCES');
  console.log('===============================================================');

  const promises = NODES.map(async (node) => {
    if (!node.apiKey) {
      console.log(`❌ [${node.name}] Missing API key.`);
      return;
    }
    try {
      console.log(`📡 [${node.name}] Sending deploy trigger...`);
      const res = await renderFetch(node.apiKey, `/services/${node.serviceId}/deploys`, {
        method: 'POST',
        body: JSON.stringify({ clearCache: 'do_not_clear' }),
      });
      console.log(`✅ [${node.name}] Deploy queued successfully! Deploy ID: ${res.id}`);
    } catch (err: any) {
      console.error(`❌ [${node.name}] Deploy trigger failed: ${err.message}`);
    }
  });

  await Promise.all(promises);
  console.log('🏁 All cluster deploys triggered.\n');
}

async function restartCluster() {
  console.log('\n===============================================================');
  console.log('🔄 RESTARTING ALL CLUSTER INSTANCES');
  console.log('===============================================================');

  const promises = NODES.map(async (node) => {
    if (!node.apiKey) {
      console.log(`❌ [${node.name}] Missing API key.`);
      return;
    }
    try {
      console.log(`📡 [${node.name}] Sending restart command...`);
      await renderFetch(node.apiKey, `/services/${node.serviceId}/restart`, {
        method: 'POST',
      });
      console.log(`✅ [${node.name}] Restart initiated successfully!`);
    } catch (err: any) {
      console.error(`❌ [${node.name}] Restart failed: ${err.message}`);
    }
  });

  await Promise.all(promises);
  console.log('🏁 Cluster restart requested.\n');
}

async function checkEnvParity() {
  console.log('\n===============================================================');
  console.log('🔍 CHECKING ENVIRONMENT VARIABLE PARITY BETWEEN INSTANCES');
  console.log('===============================================================');

  const envMaps: Record<string, string[]> = {};

  for (const node of NODES) {
    if (!node.apiKey) continue;
    try {
      const envVars = await renderFetch(node.apiKey, `/services/${node.serviceId}/env-vars?limit=100`);
      envMaps[node.name] = (envVars || []).map((e: any) => e.envVar?.key || e.key);
      console.log(`📋 ${node.name}: Found ${envMaps[node.name].length} environment variables.`);
    } catch (err: any) {
      console.error(`❌ Failed to fetch env vars for ${node.name}: ${err.message}`);
    }
  }

  const keys1 = new Set(envMaps[NODES[0].name] || []);
  const keys2 = new Set(envMaps[NODES[1].name] || []);

  const missingInNode2 = [...keys1].filter((k) => !keys2.has(k));
  const missingInNode1 = [...keys2].filter((k) => !keys1.has(k));

  if (missingInNode2.length === 0 && missingInNode1.length === 0) {
    console.log('✅ PERFECT PARITY: Both instances share the exact same environment variable keys!');
  } else {
    if (missingInNode2.length > 0) {
      console.warn('⚠️ Keys present in Node 1 but MISSING in Node 2:', missingInNode2);
    }
    if (missingInNode1.length > 0) {
      console.warn('⚠️ Keys present in Node 2 but MISSING in Node 1:', missingInNode1);
    }
  }
  console.log('===============================================================\n');
}

async function main() {
  const command = process.argv[2] || 'status';

  switch (command) {
    case 'status':
      await getClusterStatus();
      break;
    case 'deploy':
      await triggerClusterDeploy();
      break;
    case 'restart':
      await restartCluster();
      break;
    case 'env':
    case 'env-diff':
      await checkEnvParity();
      break;
    default:
      console.log(`Unknown command: ${command}`);
      console.log('Available commands: status, deploy, restart, env');
      break;
  }
}

main().catch(console.error);
