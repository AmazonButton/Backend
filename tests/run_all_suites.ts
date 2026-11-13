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
  {
    name: '17. Storefront Checkout 6-Layer Architecture Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'storefront-checkout-refactor.spec.ts')],
  },
  {
    name: '18. Inventory Concurrency & Row-Level Locking Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'inventory-concurrency-race.spec.ts')],
  },
  {
    name: '19. Product DTO & Category Ownership Boundary Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'product-contract-validation.spec.ts')],
  },
  {
    name: '20. Canonical Pagination Envelope & Limit Caps Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'canonical-pagination-envelope.spec.ts')],
  },
  {
    name: '21. Customer Addresses CRUD & Default Management Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'customer-addresses-crud.spec.ts')],
  },
  {
    name: '22. Category Hierarchy & Graph Cycle Detection Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'categories-management.spec.ts')],
  },
  {
    name: '23. Product Discounts CRUD & Time Window Exclusivity Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'product-discounts-crud.spec.ts')],
  },
  {
    name: '24. Order Filter, Date Range & Status Timeline Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'order-filter-and-timeline.spec.ts')],
  },
  {
    name: '25. Store Self-Management & Profile Update Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'store-self-management.spec.ts')],
  },
  {
    name: '26. Store Staff Management & Anti-Role-Escalation Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'store-staff-management.spec.ts')],
  },
  {
    name: '27. Store Subscription Public Catalog & History Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'subscription-catalog-history.spec.ts')],
  },
  {
    name: '28. Bank Account Verification Polling Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'bank-verification-polling.spec.ts')],
  },
  {
    name: '29. Button Rental Payment Linking & Lifecycle Expansion Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'rentals-lifecycle-e2e.spec.ts')],
  },
  {
    name: '30. Product Price History & Inventory Read Views Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'price-history-and-inventory.spec.ts')],
  },
  {
    name: '31. Store Wallet & Withdrawal Pagination, Filter & Detail Views Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'wallet-pagination-detail.spec.ts')],
  },
  {
    name: '32. Driver Shifts Monitoring & Delivery Summary Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'driver-shifts-monitoring.spec.ts')],
  },
  {
    name: '33. Store-Customer Relationship CRM Module Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'store-customers-management.spec.ts')],
  },
  {
    name: '34. Analytics Date Range & Grouping Filters Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'analytics-window-filters.spec.ts')],
  },
  {
    name: '35. P0 Security, Payout Refund & Concurrency Invariants Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'p0-security-and-concurrency.spec.ts')],
  },
  {
    name: '36. Phase 1 Database Transactions & Concurrency Invariants Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'phase1-transactions-concurrency.spec.ts')],
  },
  {
    name: '37. Phase 2 Universal Idempotency Platform Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'phase2-idempotency-platform.spec.ts')],
  },
  {
    name: '38. Phase 3 Asynchronous Queues, Backoff Retry & DLQ Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'phase3-queues-retry-dlq.spec.ts')],
  },
  {
    name: '39. Phase 4 Database Index & Query Optimization Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'phase4-index-query-optimization.spec.ts')],
  },
  {
    name: '40. Phase 5 Health Probes & Graceful Shutdown Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'phase5-graceful-shutdown-health.spec.ts')],
  },
  {
    name: '41. Superpowers Security Unit & Isolation Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'superpower-security-unit.spec.ts')],
  },
  {
    name: '42. Superpowers Security Verification & Hardening Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'superpower-security-verification.spec.ts')],
  },
  {
    name: '43. Analytics Financial Matrix & Database Aggregation Unit Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'analytics-foundation-unit.spec.ts')],
  },
  {
    name: '44. Multi-Role Analytics & Dashboard End-to-End Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'analytics-dashboard-e2e.spec.ts')],
  },
  {
    name: '45. Platform Expansion: Billing Charges & Settlement Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'platform-button-rental-task1-billing-charge.spec.ts')],
  },
  {
    name: '46. Platform Expansion: Store Shelf Fee & Device Inventory Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'platform-button-rental-task2-store-shelf-and-inventory.spec.ts')],
  },
  {
    name: '47. Platform Expansion: Rental Lifecycle & Expiry Lock Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'platform-button-rental-task3-lifecycle-and-expiry.spec.ts')],
  },
  {
    name: '48. Platform Expansion: Return Custody & Deposit Refund Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'platform-button-rental-task4-return-and-deposit-refund.spec.ts')],
  },
  {
    name: '49. Platform Expansion: Notification Center & Wallet Separation Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'platform-button-rental-task5-notifications-and-outbox.spec.ts')],
  },
  {
    name: '50. Platform Expansion: Deep Architectural, Concurrency & Invariants Verification Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'platform-button-rental-deep-fixes-verification.spec.ts')],
  },
  {
    name: '51. Platform Expansion: Real HTTP BOLA & Tenant Isolation E2E Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'platform-button-rental-http-bola.spec.ts')],
  },
  {
    name: '52. Platform Expansion Phase 1: PayOS Payment Request & Webhook Settlement Suite',
    command: 'npx',
    args: ['ts-node', path.join(__dirname, 'platform-button-rental-phase1-payos-integration.spec.ts')],
  },
  {
    name: '53. Platform Expansion Phase 2: Fulfillment Store & Device Assignment Engine Suite',
    command: 'npx',
    args: ['ts-node', path.join(__dirname, 'platform-button-rental-phase2-store-device-assignment.spec.ts')],
  },
  {
    name: '54. Platform Expansion Phase 3: Store Shelf Maintenance Fee & Catalog Protection Suite',
    command: 'npx',
    args: ['ts-node', path.join(__dirname, 'platform-button-rental-phase3-store-subscription.spec.ts')],
  },
  {
    name: '55. Platform Expansion Phase 4: Rental Expiry Cron & Dual-Layer Order Locking Suite',
    command: 'npx',
    args: ['ts-node', path.join(__dirname, 'platform-button-rental-phase4-expiry-and-order-lock.spec.ts')],
  },
  {
    name: '56. Platform Expansion Phase 5: Return Flow & Fail-Closed Payout Reconciliation Suite',
    command: 'npx',
    args: ['ts-node', path.join(__dirname, 'platform-button-rental-phase5-return-and-deposit-payout.spec.ts')],
  },
  {
    name: '57. Platform Expansion Phase 6: Outbox Producers & Notification Center Invariants Suite',
    command: 'npx',
    args: ['ts-node', path.join(__dirname, 'platform-button-rental-phase6-outbox-and-notifications.spec.ts')],
  },
  {
    name: '58. Platform Expansion Phase 7: API Validation DTOs, Strict BOLA & Audit Immutability Suite',
    command: 'npx',
    args: ['ts-node', path.join(__dirname, 'platform-button-rental-phase7-api-validation-and-audit.spec.ts')],
  },
  {
    name: '59. Security Hardening: Authority Resolution & Non-Escalation Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'auth_authority_hardening.spec.ts')],
  },
  {
    name: '60. Security Hardening: Admin Payout & Reconciliation Invariants Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'admin_payout_invariants.spec.ts')],
  },
  {
    name: '61. Security Hardening: BOLA Tenant & Data Isolation Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'data_isolation_bola.spec.ts')],
  },
  {
    name: '62. Security Hardening: Order Delivery Transition Invariants Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'order_delivery_transition.spec.ts')],
  },
  {
    name: '63. Security Hardening: Rental FSM & Bank Onboarding Invariants Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'rental_fsm_and_bank_onboarding.spec.ts')],
  },
  {
    name: '64. Security Hardening: CORS Protection & Notification SQL Invariants Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'cors_and_notification.spec.ts')],
  },
  {
    name: '65. Security Hardening: Admin Store Rename & DTO Validation Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'admin_store_rename.spec.ts')],
  },
  {
    name: '66. Store Cash v1: Offline DTO, Token & Schema Contract (not DB concurrency)',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'store-cash-contract.spec.ts')],
  },
  {
    name: '67. Store Cash v1: Collection, Wallet Offset & Double-Payment Race Invariants Suite',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'store-cash-collection-and-wallet-offset.spec.ts')],
  },
  {
    name: '68. Rental Closeout Regression (Offline)', command: 'npx',
    args: ['tsx', path.join(__dirname, 'rental-closeout-regression.spec.ts')],
  },
  {
    name: '69. Rental Renewal & Receipt Invariants (Offline)', command: 'npx',
    args: ['tsx', path.join(__dirname, 'rental-renewal-receipt.spec.ts')],
  },
  {
    name: '70. Rental Closeout Nest HTTP Pipeline (Build Required; Fixture Auth/DB)', command: 'npx',
    args: ['tsx', path.join(__dirname, 'rental-closeout-http.spec.ts')],
  },
  {
    name: '71. Rental Closeout Real PostgreSQL (Explicit Disposable Test DB Required)', command: 'npx',
    args: ['tsx', path.join(__dirname, 'rental-closeout-postgres.spec.ts')],
  },
  {
    name: '72. VietQR Credential Isolation & Trimming (Offline Provider Unit)',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'vietqr-credential-isolation.spec.ts')],
  },
  {
    name: '73. Security Audit P1 Fixes (8 Critical Findings Regression)',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'security-audit-p1-fixes.spec.ts')],
  },
  {
    name: '74. Security Audit Waves 1-4 Fixes (30 Findings Regression)',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'security-audit-waves-fixes.spec.ts')],
  },
  {
    name: '75. HTTP Contract Validation & DTO Regression Tests',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'http-contract-validation.spec.ts')],
  },
  {
    name: '76. Database Scaling & In-Memory Caching Verification',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'verify_db_scaling_and_caching.spec.ts')],
  },
  {
    name: '77. Financial Payout, Penny Verification & Refund Hardening (TC-01..TC-10)',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'financial-payout-verification-hardening.spec.ts')],
  },
  {
    name: '78. Bank Identifier Normalization (Offline Customer/Store Regression)',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'bank-identifier-normalization.spec.ts')],
  },
  {
    name: '79. Wallet Bank Contract (Offline Validation and Persistence)',
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'wallet-bank-contract.spec.ts')],
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
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
