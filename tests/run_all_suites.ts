import { spawnSync } from 'child_process';
import path from 'path';

interface TestSuite {
  name: string;
  command: string;
  args: string[];
}

const suites: TestSuite[] = [
  {
    name: '1. Firebase Phone Authentication Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'firebase-phone-auth.spec.ts')],
  },
  {
    name: '2. Firebase Cloud Messaging (FCM) & Notifications Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'notifications-fcm.spec.ts')],
  },
  {
    name: '3. Order Lifecycle, Window Cancel & Inventory Safety',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'order-lifecycle.spec.ts')],
  },
  {
    name: '4. IoT Device Config & Product Mapping Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'device-config-product-mapping.test.ts')],
  },
  {
    name: '5. Zero-Touch Provisioning & Security Incidents Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'zero-touch-provisioning.test.ts')],
  },
  {
    name: '6. End-to-End Zero-Touch Device Lifecycle v4.0',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'e2e-zero-touch-lifecycle.test.ts')],
  },
  {
    name: '7. Multi-Vendor Marketplace, Rental & Escrow Wallet E2E',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'e2e-marketplace-ecosystem.spec.ts')],
  },
  {
    name: '8. Security Audit 8 Criteria & Zero Residue Verifier',
    command: 'node',
    args: [path.join(__dirname, 'verify_all_8_audit_fixes.js')],
  },
  {
    name: '9. Smart Order Button API Integration Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'api.test.ts')],
  },
  {
    name: '10. User Avatar URL & Profile Management Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'user-avatar-profile.spec.ts')],
  },
  {
    name: '11. Order Minimum Value (>= 2,000 VND) Constraint Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'order-minimum-value.spec.ts')],
  },
  {
    name: '12. Didit eKYC Identity Verification Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'identity-verification-didit.spec.ts')],
  },
  {
    name: '13. Penny-Deposit Bank Account Verification (2.000 VND) Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'bank-account-verification.spec.ts')],
  },
  {
    name: '14. Device Templates, Bulk Deploy, Allocation & Order Alias Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'device-templates-bulk-deploy.spec.ts')],
  },
  {
    name: '15. Frontend Contract Gap & Notifications Integration Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'frontend-contract-and-notifications.spec.ts')],
  },
  {
    name: '16. Withdrawal Concurrency, Idempotency & Payout Engine Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'withdrawal-concurrency-idempotency.spec.ts')],
  },
];

async function main() {
  console.log('\n========================================================================');
  console.log('🚀 RUNNING ALL SMART ORDER BACKEND INTEGRATION & VERIFICATION SUITES');
  console.log('========================================================================\n');

  const startTime = Date.now();
  let passedSuites = 0;
  let failedSuites = 0;
  const results: { name: string; success: boolean; durationMs: number }[] = [];

  for (const suite of suites) {
    console.log(`\n▶ Starting [${suite.name}]...`);
    const suiteStart = Date.now();
    const result = spawnSync(suite.command, suite.args, {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env },
    });
    const duration = Date.now() - suiteStart;

    if (result.status === 0) {
      console.log(`\x1b[32m✔ [SUITE PASSED]\x1b[0m ${suite.name} (${(duration / 1000).toFixed(1)}s)`);
      passedSuites++;
      results.push({ name: suite.name, success: true, durationMs: duration });
    } else {
      console.log(`\x1b[31m✖ [SUITE FAILED]\x1b[0m ${suite.name} (exit code: ${result.status})`);
      failedSuites++;
      results.push({ name: suite.name, success: false, durationMs: duration });
    }
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n========================================================================');
  console.log(`🏁 MASTER TEST SUMMARY (${totalDuration}s total)`);
  console.log('========================================================================');
  for (const r of results) {
    const icon = r.success ? '\x1b[32m✔ PASS\x1b[0m' : '\x1b[31m✖ FAIL\x1b[0m';
    console.log(`  ${icon} ${r.name} - ${(r.durationMs / 1000).toFixed(1)}s`);
  }
  console.log('------------------------------------------------------------------------');
  console.log(`TOTAL SUITES: ${suites.length} | PASSED: ${passedSuites} | FAILED: ${failedSuites}`);
  console.log('========================================================================\n');

  if (failedSuites > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
