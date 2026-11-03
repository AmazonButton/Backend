/**
 * Cloudflare Worker: Multi-Cloud Intelligent Traffic Director & Failover
 * Project: Smart Order Button Backend (Sem 9 FPTu)
 *
 * Routing Policy:
 * 1. Third-Party Integrations (PayOS, Didit eKYC, Bank Verification):
 *    -> 100% routed to Node 1 (Render Primary)
 * 2. Core Business APIs (Orders, Devices, Products, Auth):
 *    -> 70% to Node 3 (AWS EC2 Sydney - High-Performance Workhorse)
 *    -> 20% to Node 1 (Render Primary - Continuous Keep-Alive & Light Sharing)
 *    -> 10% to Node 2 (Render Secondary - Active Keep-Alive, never stays idle > 15-30m)
 * 3. 3-Way Cascading Failover across all 3 nodes on 502/503/504 or network drops
 * 4. Background Keep-Alive: Node 2 pinged every 10-12 minutes via ctx.waitUntil & Cron
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

    // 2. Background Keep-Alive for Node 2 (Render Secondary)
    // Ensures Node 2 stays awake 24/7 without adding ANY latency to user requests
    const now = Date.now();
    if (now - lastNode2PingTimestamp > NODE2_PING_INTERVAL_MS) {
      lastNode2PingTimestamp = now;
      ctx.waitUntil(
        fetch(`${NODE2_RENDER}/healthz`, {
          headers: { 'User-Agent': 'Cloudflare-Worker-AutoPing/1.0' },
          signal: AbortSignal.timeout(10000),
        }).catch((err) => console.warn('[AutoKeepAlive] Node 2 ping notice:', err.message)),
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
      // Core Business APIs: 70% AWS EC2, 20% Render Node 1, 10% Render Node 2
      const rand = Math.random() * 100;
      if (rand < 20) {
        // 20% to Node 1 (Render Primary - Continuous Keep-Alive)
        candidateOrigins = [
          { url: NODE1_RENDER, node: 'node-1', role: 'render-shared-20pct' },
          { url: NODE3_AWS,    node: 'node-3', role: 'aws-primary-fallback' },
          { url: NODE2_RENDER, node: 'node-2', role: 'render-secondary-fallback' },
        ];
      } else if (rand < 30) {
        // 10% to Node 2 (Render Secondary Active Keep-Alive - never stays off > 15-30m)
        candidateOrigins = [
          { url: NODE2_RENDER, node: 'node-2', role: 'render-warm-10pct' },
          { url: NODE3_AWS,    node: 'node-3', role: 'aws-primary-fallback' },
          { url: NODE1_RENDER, node: 'node-1', role: 'render-primary-fallback' },
        ];
      } else {
        // 70% to Node 3 (AWS EC2 Sydney Workhorse)
        candidateOrigins = [
          { url: NODE3_AWS,    node: 'node-3', role: 'aws-core-70pct' },
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

  // Cloudflare Cron Trigger (Runs every 10-15m if configured in Cloudflare Dashboard)
  async scheduled(controller, env, ctx) {
    console.log('[CronKeepAlive] Scheduled ping to keep Node 2 awake...');
    ctx.waitUntil(
      fetch(`${NODE2_RENDER}/healthz`, {
        headers: { 'User-Agent': 'Cloudflare-Worker-Cron/1.0' },
      }).catch((e) => console.warn('[CronKeepAlive] Failed:', e.message)),
    );
  },
};
