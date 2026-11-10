import assert from 'node:assert/strict';
import { ServiceUnavailableException } from '@nestjs/common';
import { PayOSBankVerificationProvider } from '../src/bank-verification/providers/payos-bank-verification.provider';

async function run(): Promise<void> {
  const envKeys = [
    'NODE_ENV',
    'BANK_VERIFICATION_MOCK',
    'VIETQR_CLIENT_ID',
    'VIETQR_API_KEY',
    'PAYOS_CLIENT_ID',
    'PAYOS_API_KEY',
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = global.fetch;

  try {
    process.env.NODE_ENV = 'test';
    process.env.BANK_VERIFICATION_MOCK = 'false';

    const provider = new PayOSBankVerificationProvider();
    let fetchCalls = 0;
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers['x-client-id'], 'vietqr-client');
      assert.equal(headers['x-api-key'], 'vietqr-api-key');
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: '00', data: { accountName: 'TEST ACCOUNT' } }),
      } as Response;
    }) as typeof fetch;

    process.env.VIETQR_CLIENT_ID = '  vietqr-client  ';
    process.env.VIETQR_API_KEY = '  vietqr-api-key  ';
    process.env.PAYOS_CLIENT_ID = 'payos-client-must-not-be-used';
    process.env.PAYOS_API_KEY = 'payos-key-must-not-be-used';

    const result = await provider.lookupAccount('970422', '0123456789');
    assert.equal(result.accountName, 'TEST ACCOUNT');
    assert.equal(fetchCalls, 1, 'configured VietQR credentials call provider once');

    // PayOS credentials must never be used as a fallback for VietQR.
    delete process.env.VIETQR_CLIENT_ID;
    delete process.env.VIETQR_API_KEY;
    fetchCalls = 0;
    await assert.rejects(
      () => provider.lookupAccount('970422', '0123456789'),
      (error: unknown) => error instanceof ServiceUnavailableException,
    );
    assert.equal(fetchCalls, 0, 'missing VietQR credentials fail closed before network call');

    // A partial VietQR pair is also invalid; do not combine or fall back credentials.
    process.env.VIETQR_CLIENT_ID = 'vietqr-client-only';
    await assert.rejects(
      () => provider.lookupAccount('970422', '0123456789'),
      (error: unknown) => error instanceof ServiceUnavailableException,
    );
    assert.equal(fetchCalls, 0, 'partial VietQR credentials (client id only) fail closed before network call');

    // Inverse partial pair: only API key configured, missing client ID.
    delete process.env.VIETQR_CLIENT_ID;
    process.env.VIETQR_API_KEY = 'vietqr-api-key-only';
    await assert.rejects(
      () => provider.lookupAccount('970422', '0123456789'),
      (error: unknown) => error instanceof ServiceUnavailableException,
    );
    assert.equal(fetchCalls, 0, 'partial VietQR credentials (api key only) fail closed before network call');

    console.log('PASS: VietQR credential isolation and trimming (4 scenarios)');
  } finally {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
