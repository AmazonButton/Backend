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

// Base origin configurations (Overridable via Worker environment variables)
const NODE1_RENDER = 'https://backend-fae8.onrender.com';
const NODE2_RENDER = 'https://backend-node2-ukib.onrender.com';
const NODE3_AWS_DEFAULT = 'http://ec2-3-25-136-6.ap-southeast-2.compute.amazonaws.com';

// Dedicated routes requiring static whitelisted IP on AWS Node-3 (PayOS Payout / Refunds / Withdrawals)
const PAYOUT_STATIC_IP_ROUTES = [
  '/api/v1/webhooks/payos/payout',
  '/api/v1/admin/payment-refunds',
  '/api/v1/admin/rentals',
  '/api/v1/admin/refunds',
  '/api/v1/admin/withdrawals',
  '/api/v1/admin/payos',
  '/api/v1/store/wallet/withdrawals/',
];

function resolveAllowedCorsOrigin(requestOrigin, env) {
  if (!requestOrigin) return null;
  const rawAllowed = env?.CORS_ORIGIN || '';
  const allowlist = rawAllowed
    ? rawAllowed.split(',').map((o) => o.trim()).filter(Boolean)
    : [
        'https://buttontdash.vercel.app',
        'http://localhost:5173',
        'http://localhost:3000',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:3000',
      ];
  if (allowlist.includes('*') || allowlist.includes(requestOrigin)) {
    return requestOrigin;
  }
  return null;
}

// Dedicated paths for third-party integrations (PayOS Payment Links, Didit eKYC, Bank Verification)
const THIRD_PARTY_ROUTES = [
  '/api/v1/webhooks',
  '/api/v1/payments',
  '/api/v1/banks',
  '/api/v1/stores/bank-accounts',
  '/api/v1/identity-verifications',
  '/api/v1/store/wallet',
];

// Public read-only endpoints suitable for Cloudflare Edge Caching (60s TTL)
// Strictly whitelist purely public routes; never cache authenticated tenant sub-paths (e.g. /stores/me, /stores/:id/customers)
const EXACT_CACHEABLE_ROUTES = [
  '/healthz',
  '/api/v1/stores',
  '/api/v1/categories',
  '/api/v1/subscription-plans',
];

let lastNode2PingTimestamp = 0;
const NODE2_PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const UNHEALTHY_COOLDOWN_MS = 30 * 1000; // 30s isolate cooldown for hibernating/failing nodes
const unhealthyOriginUntil = new Map();

function extractOriginatingClientIp(request) {
  const candidates = [
    request.headers.get('x-vercel-forwarded-for'),
    request.headers.get('x-forwarded-for'),
    request.headers.get('CF-Connecting-IP'),
  ];
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    for (const part of raw.split(',')) {
      const token = part.trim().replace(/^::ffff:/i, '');
      if (/^[0-9a-fA-F:.]{3,45}$/.test(token)) {
        return token;
      }
    }
  }
  return '';
}

function prioritizeHealthyOrigins(origins, now) {
  const healthy = [];
  const cooling = [];
  for (const origin of origins) {
    const until = unhealthyOriginUntil.get(origin.url) || 0;
    if (until > now) {
      cooling.push(origin);
    } else {
      if (until) unhealthyOriginUntil.delete(origin.url);
      healthy.push(origin);
    }
  }
  return [...healthy, ...cooling];
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle CORS Preflight (OPTIONS) at Edge for ultra-fast response (<10ms)
    const requestOrigin = request.headers.get('Origin');
    const allowedOrigin = resolveAllowedCorsOrigin(requestOrigin, env);
    if (request.method === 'OPTIONS') {
      const preflightHeaders = {
        'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-device-id, x-timestamp, x-nonce, x-signature, x-idempotency-key, idempotency-key, X-Idempotency-Key, Idempotency-Key, x-request-id',
        'Access-Control-Max-Age': '86400',
      };
      if (allowedOrigin) {
        preflightHeaders['Access-Control-Allow-Origin'] = allowedOrigin;
        preflightHeaders['Access-Control-Allow-Credentials'] = 'true';
        preflightHeaders['Vary'] = 'Origin';
      }
      return new Response(null, {
        status: 204,
        headers: preflightHeaders,
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
    const node3Origin = env?.NODE3_AWS || NODE3_AWS_DEFAULT;
    const isPayoutStaticIp = PAYOUT_STATIC_IP_ROUTES.some((p) => url.pathname.startsWith(p));
    const isThirdParty = THIRD_PARTY_ROUTES.some((p) => url.pathname.startsWith(p));
    let candidateOrigins;

    if (isPayoutStaticIp) {
      // 100% PayOS Payout / Refund / Withdrawal admin traffic to Static-IP AWS Node-3 first,
      // falling back to Render nodes (which delegate via outbox if needed)
      candidateOrigins = [
        { url: node3Origin,   node: 'node-3', role: 'payout-static-ip-primary (100%)' },
        { url: NODE1_RENDER, node: 'node-1', role: 'payout-delegation-fallback' },
        { url: NODE2_RENDER, node: 'node-2', role: 'payout-delegation-standby' },
      ];
    } else if (isThirdParty) {
      // 100% Third-party traffic (PayOS, Didit, Banks) to Node 1
      candidateOrigins = [
        { url: NODE1_RENDER, node: 'node-1', role: 'third-party-primary (100%)' },
        { url: node3Origin,   node: 'node-3', role: 'third-party-fallback' },
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
          { url: node3Origin,   node: 'node-3', role: 'aws-fallback' },
        ];
      } else if (rand < 85) {
        // 35% to Node 2 (Render Secondary - High-throughput & low latency)
        candidateOrigins = [
          { url: NODE2_RENDER, node: 'node-2', role: 'render-secondary-35pct' },
          { url: NODE1_RENDER, node: 'node-1', role: 'render-primary-fallback' },
          { url: node3Origin,   node: 'node-3', role: 'aws-fallback' },
        ];
      } else {
        // 15% to Node 3 (AWS EC2 Sydney - Failover & backup)
        candidateOrigins = [
          { url: node3Origin,   node: 'node-3', role: 'aws-backup-15pct' },
          { url: NODE1_RENDER, node: 'node-1', role: 'render-primary-fallback' },
          { url: NODE2_RENDER, node: 'node-2', role: 'render-secondary-fallback' },
        ];
      }
    }

    // 4. Clone Request Headers & Forward Client Identity
    const clientIp = extractOriginatingClientIp(request);
    const forwardHeaders = new Headers(request.headers);
    if (clientIp) {
      forwardHeaders.set('X-Edge-Client-IP', clientIp);
      forwardHeaders.set('X-Forwarded-For', clientIp);
      forwardHeaders.set('X-Real-IP', clientIp);
    }

    const orderedCandidates = prioritizeHealthyOrigins(candidateOrigins, now);

    // 5. Request Body Buffer Cloning (safe replay across origins on failover)
    let bodyBuffer = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      bodyBuffer = await request.arrayBuffer();
    }

    // 6. Multi-Origin Dispatch with 3-Way Cascading Failover
    let lastError = null;
    for (let attempt = 0; attempt < orderedCandidates.length; attempt++) {
      const candidate = orderedCandidates[attempt];
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

      // Edge Caching Invariant: NEVER cache authenticated requests or private user data
      const hasAuth = Boolean(request.headers.get('Authorization') || request.headers.get('Cookie'));
      const cacheControl = request.headers.get('Cache-Control') || '';
      const noStoreRequested = cacheControl.includes('no-store') || cacheControl.includes('no-cache');

      const isPathCacheable = EXACT_CACHEABLE_ROUTES.some((route) => {
        return url.pathname === route || url.pathname === `${route}/`;
      });

      const isCacheable = request.method === 'GET' && !hasAuth && !noStoreRequested && isPathCacheable;
      if (isCacheable) {
        requestInit.cf = {
          cacheTtl: 60,
          cacheEverything: true,
        };
      }

      try {
        const response = await fetch(targetUrl.toString(), {
          ...requestInit,
          signal: AbortSignal.timeout(12000),
        });

        const cfMitigated = (response.headers.get('cf-mitigated') || '').toLowerCase();
        const renderRouting = (response.headers.get('x-render-routing') || '').toLowerCase();
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        const isEdgeChallenge = response.status === 429 && cfMitigated.includes('challenge');
        const isRenderHibernate429 =
          response.status === 429 &&
          (renderRouting.includes('hibernate') || renderRouting.includes('rate-limited'));
        const isNonJsonInfra429 = response.status === 429 && !contentType.includes('application/json');
        const isUpstreamGatewayFailure = response.status >= 502 && response.status <= 599;

        // Fail over on upstream gateway errors (502-599), Render hibernate/edge-gateway 429s,
        // or Render-edge Cloudflare WAF bot challenges (never mask genuine API JSON 429s)
        if (isUpstreamGatewayFailure || isEdgeChallenge || isRenderHibernate429 || isNonJsonInfra429) {
          unhealthyOriginUntil.set(currentOrigin, Date.now() + UNHEALTHY_COOLDOWN_MS);
          if (attempt < orderedCandidates.length - 1) {
            console.warn(
              `[Director LB] ${currentOrigin} returned ${response.status}${isEdgeChallenge ? ' (cf-mitigated challenge)' : ''}${isRenderHibernate429 ? ' (render hibernate)' : ''}. Retrying fallback...`,
            );
            lastError = new Error(`HTTP ${response.status} from ${currentOrigin}`);
            continue;
          }
        } else {
          unhealthyOriginUntil.delete(currentOrigin);
        }

        // Success or standard HTTP response
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('X-Cluster-Node', candidate.node);
        responseHeaders.set('X-Cluster-Role', candidate.role);
        responseHeaders.set('X-Cluster-Attempt', String(attempt + 1));
        if (allowedOrigin) {
          responseHeaders.set('Access-Control-Allow-Origin', allowedOrigin);
          responseHeaders.set('Access-Control-Allow-Credentials', 'true');
          responseHeaders.set(
            'Access-Control-Expose-Headers',
            'X-Idempotency-Status, X-Request-Id, X-Cluster-Node, X-Cluster-Role, X-Cluster-Attempt, Retry-After, RateLimit-Reset',
          );
          responseHeaders.set('Vary', 'Origin');
        } else {
          responseHeaders.delete('Access-Control-Allow-Origin');
          responseHeaders.delete('Access-Control-Allow-Credentials');
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      } catch (networkErr) {
        console.warn(`[Director LB] Network failure on ${currentOrigin}: ${networkErr.message}.`);
        unhealthyOriginUntil.set(currentOrigin, Date.now() + UNHEALTHY_COOLDOWN_MS);
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
