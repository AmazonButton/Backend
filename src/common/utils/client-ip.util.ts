const IP_LITERAL_REGEX = /^[0-9a-fA-F:.]{3,45}$/;
const CLOUDFLARE_WORKER_EGRESS_IP = '2a06:98c0:3600::103';

export function isValidIpLiteral(ip: string): boolean {
  return Boolean(ip && IP_LITERAL_REGEX.test(ip));
}

export function firstValidForwardedIp(headerVal: unknown): string {
  const candidates = Array.isArray(headerVal)
    ? headerVal.flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
    : typeof headerVal === 'string'
      ? headerVal.split(',')
      : [];

  for (const part of candidates) {
    const token = part.trim().replace(/^::ffff:/i, '');
    if (isValidIpLiteral(token)) {
      return token;
    }
  }
  return '';
}

/**
 * Resolve originating client IP safely across Vercel -> Cloudflare Worker -> Render/AWS.
 * Trusts forwarded edge client headers only when arriving via Cloudflare Worker or without
 * a direct non-Worker Cloudflare connecting IP so external clients cannot spoof headers.
 */
export function extractTrustedClientIp(req: any): string {
  const headers = req?.headers || {};
  const cfIp = firstValidForwardedIp(headers['cf-connecting-ip']);
  const hasCfWorker = Boolean(headers['cf-worker']);

  if (hasCfWorker || cfIp === CLOUDFLARE_WORKER_EGRESS_IP || !cfIp) {
    return (
      firstValidForwardedIp(headers['x-edge-client-ip']) ||
      firstValidForwardedIp(headers['x-vercel-forwarded-for']) ||
      firstValidForwardedIp(headers['x-forwarded-for']) ||
      cfIp ||
      firstValidForwardedIp(req?.ip) ||
      firstValidForwardedIp(req?.socket?.remoteAddress) ||
      '127.0.0.1'
    );
  }

  return cfIp;
}
