/**
 * Masks an email local-part while preserving domain visibility for safe operational logs and DLQ records.
 */
export function maskEmailAddress(email?: string | null): string {
  if (!email || typeof email !== 'string') return '';
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) return '***';
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  const visiblePrefix = local.slice(0, Math.min(2, local.length));
  return `${visiblePrefix}***${domain}`;
}
