import assert from 'node:assert/strict';
import { resolveStoreBankReturnUrls } from '../src/bank-verification/store-bank-return-url';
const env = { FRONTEND_URL: 'https://example.test' } as NodeJS.ProcessEnv;
assert.equal(new URL(resolveStoreBankReturnUrls({}, env).returnUrl).pathname, '/store/wallet');
assert.equal(new URL(resolveStoreBankReturnUrls({ returnUrl: 'http://localhost:5173/store/wallet' }, env).returnUrl).origin, 'http://localhost:5173');
for (const returnUrl of ['https://evil.test/store/wallet', 'https://example.test/login', 'https://example.test.evil.test/store/wallet', 'https://user:pass@example.test/store/wallet', 'javascript:alert(1)']) {
  assert.throws(() => resolveStoreBankReturnUrls({ returnUrl }, env));
}
console.log('PASS: Store verification redirect origins and paths.');
