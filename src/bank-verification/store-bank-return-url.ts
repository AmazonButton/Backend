import { BadRequestException } from '@nestjs/common';

export function resolveStoreBankReturnUrls(input: { returnUrl?: string; cancelUrl?: string }, env = process.env) {
  const origin = new URL(env.FRONTEND_URL || 'https://buttontdash.vercel.app').origin;
  // Explicit frontend origins only; checkout redirects never carry login credentials.
  const allowed = new Set([origin, 'http://localhost:5173', 'http://127.0.0.1:5173']);
  for (const entry of (env.PAYOS_STORE_BANK_ALLOWED_RETURN_ORIGINS || '').split(',').filter(Boolean)) {
    allowed.add(new URL(entry.trim()).origin);
  }
  const validate = (value: string) => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          !allowed.has(url.origin) || url.pathname !== '/store/wallet') throw new Error();
      return url.toString();
    } catch {
      throw new BadRequestException('URL quay về phải là trang ví của frontend được cho phép');
    }
  };
  return {
    returnUrl: validate(input.returnUrl || `${origin}/store/wallet?bank_verification=return`),
    cancelUrl: validate(input.cancelUrl || `${origin}/store/wallet?bank_verification=cancel`),
  };
}
