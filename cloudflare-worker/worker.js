/**
 * Cloudflare Worker: Multi-Cloud Intelligent Traffic Director & Failover
 * Project: Smart Order Button Backend (Sem 9 FPTu)
 *
 * Routing Policy:
 * 1. Third-Party Integrations (PayOS, Didit eKYC, Bank Verification):
 *    -> 100% routed to Node 1 (Render Primary)
 * 2. Core Business APIs (Orders, Devices, Products, Auth):
 *    -> 50% to Node 1 (Render Primary - Fast latency, keep-alive active)
 *    -> 35% to Node 2 (Render Secondary - High-throughput, keep-alive active)
 *    -> 15% to Node 3 (AWS EC2 Sydney - Fallback workhorse, avoiding cross-ocean RTT penalty)
 * 3. 3-Way Cascading Failover across all 3 nodes on 502/503/504 or network drops
 * 4. Background Keep-Alive: Both Render Nodes pinged every 5-10 minutes via ctx.waitUntil & Cron
 */

const NODE1_RENDER = 'https://backend-fae8.onrender.com';
const NODE2_RENDER = 'https://backend-node2-ukib.onrender.com';
const NODE3_AWS    = 'http://ec2-3-25-136-6.ap-southeast-2.compute.amazonaws.com';

// Dedicated paths for third-party integrations (PayOS, Didit eKYC, Bank Verification)
const THIRD_PARTY_ROUTES = [
  '/api/v1/webhooks',
  '/api/v1/payments',
  '/api/v1/banks',
  '/api/v1/stores/bank-accounts',
  '/api/v1/identity-verifications',
];

// Public read-only endpoints suitable for Cloudflare Edge Caching (60s TTL)
const CACHEABLE_ROUTES = [
  '/api/v1/stores',
  '/api/v1/categories',
  '/api/v1/subscription-plans',
  '/healthz',
];

let lastNode2PingTimestamp = 0;
const NODE2_PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle CORS Preflight (OPTIONS) at Edge for ultra-fast response (<10ms)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
          'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-device-id, x-timestamp, x-nonce, x-signature',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 2. Background Keep-Alive for Both Render Nodes (Node 1 & Node 2)
    // Ensures both stay awake 24/7 without adding ANY latency to user requests
    const now = Date.now();
    if (now - lastNode2PingTimestamp > NODE2_PING_INTERVAL_MS) {
      lastNode2PingTimestamp = now;
      ctx.waitUntil(
        Promise.allSettled([
          fetch(`${NODE1_RENDER}/healthz`, {
            headers: { 'User-Agent': 'Cloudflare-Worker-AutoPing/1.0' },
            signal: AbortSignal.timeout(10000),
          }),
          fetch(`${NODE2_RENDER}/healthz`, {
            headers: { 'User-Agent': 'Cloudflare-Worker-AutoPing/1.0' },
            signal: AbortSignal.timeout(10000),
          }),
        ]).catch((err) => console.warn('[AutoKeepAlive] Ping notice:', err.message))
      );
    }

    // 3. Intelligent Path-Based & Weighted Origin Selection
    const isThirdParty = THIRD_PARTY_ROUTES.some((p) => url.pathname.startsWith(p));
    let candidateOrigins;

    if (isThirdParty) {
      // 100% Third-party traffic (PayOS, Didit, Banks) to Node 1
      candidateOrigins = [
        { url: NODE1_RENDER, node: 'node-1', role: 'third-party-primary (100%)' },
        { url: NODE3_AWS,    node: 'node-3', role: 'third-party-fallback' },
        { url: NODE2_RENDER, node: 'node-2', role: 'emergency-standby' },
      ];
    } else {
      // Core Business APIs: 50% Render Node 1, 35% Render Node 2, 15% AWS EC2
      // Render nodes connect significantly faster to Supabase Tokyo (~500ms vs ~1300ms Sydney RTT)
      const rand = Math.random() * 100;
      if (rand < 50) {
        // 50% to Node 1 (Render Primary - Fast & low latency)
        candidateOrigins = [
          { url: NODE1_RENDER, node: 'node-1', role: 'render-primary-50pct' },
          { url: NODE2_RENDER, node: 'node-2', role: 'render-secondary-fallback' },
          { url: NODE3_AWS,    node: 'node-3', role: 'aws-fallback' },
        ];
      } else if (rand < 85) {
        // 35% to Node 2 (Render Secondary - High-throughput & low latency)
        candidateOrigins = [
          { url: NODE2_RENDER, node: 'node-2', role: 'render-secondary-35pct' },
          { url: NODE1_RENDER, node: 'node-1', role: 'render-primary-fallback' },
          { url: NODE3_AWS,    node: 'node-3', role: 'aws-fallback' },
        ];
      } else {
        // 15% to Node 3 (AWS EC2 Sydney - Failover & backup)
        candidateOrigins = [
          { url: NODE3_AWS,    node: 'node-3', role: 'aws-backup-15pct' },
          { url: NODE1_RENDER, node: 'node-1', role: 'render-primary-fallback' },
          { url: NODE2_RENDER, node: 'node-2', role: 'render-secondary-fallback' },
        ];
      }
    }

    // 4. Clone Request Headers & Forward Client Identity
    const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || '';
    const forwardHeaders = new Headers(request.headers);
    if (clientIp) {
      forwardHeaders.set('X-Forwarded-For', clientIp);
      forwardHeaders.set('X-Real-IP', clientIp);
    }

    // 5. Request Body Buffer Cloning (safe replay across origins on failover)
    let bodyBuffer = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      bodyBuffer = await request.arrayBuffer();
    }

    // 6. Multi-Origin Dispatch with 3-Way Cascading Failover
    let lastError = null;
    for (let attempt = 0; attempt < candidateOrigins.length; attempt++) {
      const candidate = candidateOrigins[attempt];
      const currentOrigin = candidate.url;
      const targetUrl = new URL(url.pathname + url.search, currentOrigin);

      const requestInit = {
        method: request.method,
        headers: forwardHeaders,
        redirect: 'follow',
      };

      if (bodyBuffer) {
        requestInit.body = bodyBuffer.slice(0);
      }

      const isCacheable = request.method === 'GET' && CACHEABLE_ROUTES.some((r) => url.pathname.startsWith(r));
      if (isCacheable) {
        requestInit.cf = {
          cacheTtl: 60,
          cacheEverything: true,
        };
      }

      try {
        const response = await fetch(targetUrl.toString(), requestInit);

        // If server returns gateway error (502, 503, 504) and we have fallback candidates, try next
        if ((response.status === 502 || response.status === 503 || response.status === 504) && attempt < candidateOrigins.length - 1) {
          console.warn(`[Director LB] ${currentOrigin} returned ${response.status}. Retrying fallback...`);
          lastError = new Error(`HTTP ${response.status} from ${currentOrigin}`);
          continue;
        }

        // Success or standard HTTP response
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('X-Cluster-Node', candidate.node);
        responseHeaders.set('X-Cluster-Origin', currentOrigin);
        responseHeaders.set('X-Cluster-Role', candidate.role);
        responseHeaders.set('X-Cluster-Attempt', String(attempt + 1));
        responseHeaders.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '*');
        responseHeaders.set('Access-Control-Allow-Credentials', 'true');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      } catch (networkErr) {
        console.warn(`[Director LB] Network failure on ${currentOrigin}: ${networkErr.message}.`);
        lastError = networkErr;
        // Continue loop to try next fallback origin
      }
    }

    // If all origins fail
    return new Response(
      JSON.stringify({
        success: false,
        message: 'Toàn bộ cụm multi-cloud (Render + AWS) đang bảo trì hoặc khởi động. Vui lòng thử lại sau giây lát.',
        errorCode: 'CLUSTER_UNAVAILABLE',
        error: lastError ? lastError.message : 'All origins failed',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  },

  // Cloudflare Cron Trigger (Runs every 5m configured in Cloudflare Dashboard)
  async scheduled(controller, env, ctx) {
    console.log('[CronKeepAlive] Scheduled ping to keep Node 1 and Node 2 awake 24/7...');
    ctx.waitUntil(
      Promise.allSettled([
        fetch(`${NODE1_RENDER}/healthz`, {
          headers: { 'User-Agent': 'Cloudflare-Worker-Cron/1.0' },
        }),
        fetch(`${NODE2_RENDER}/healthz`, {
          headers: { 'User-Agent': 'Cloudflare-Worker-Cron/1.0' },
        }),
      ]).catch((e) => console.warn('[CronKeepAlive] Failed:', e.message))
    );
  },
};
