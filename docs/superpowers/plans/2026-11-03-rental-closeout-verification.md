# Rental closeout verification — 2026-11-03

## Scope and outcome

Implementation of the agreed rental closeout fixes, not an assertion that the entire backend is production-certified.
Five focused regressions were observed failing before source changes; their corrected cases plus two additional cases now pass.
Existing user changes outside rental/billing/cache/test scope were preserved. No commit, push, production migration or live payment was performed.

## Executed offline suites

Invocation for each row: `node node_modules/tsx/dist/cli.mjs tests/<filename>`.
Final batch used process-local NODE_ENV=test, PAYOS_MOCK_PAYMENT=true and PAYOS_CLIENT_ID=mock_client_id.
These values were not written to configuration files.
The provider integration suite explicitly uses mocked payment-link generation and synthetic HMAC payloads.

| File | Exit code | Evidence type |
| --- | --- | --- |
| store-cash-contract.spec.ts | 0 | Offline / mock / unit |
| store-cash-settlement.spec.ts | 0 | Offline / mock / unit |
| store-cash-collection-and-wallet-offset.spec.ts | 0 | Offline / mock / unit |
| rental-renewal-receipt.spec.ts | 0 | Offline / mock / unit |
| rental-closeout-regression.spec.ts | 0 | Offline / mock / unit |
| platform-button-rental-task1-billing-charge.spec.ts | 0 | Offline / mock / unit |
| platform-button-rental-task4-return-and-deposit-refund.spec.ts | 0 | Offline / mock / unit |
| platform-button-rental-phase2-store-device-assignment.spec.ts | 0 | Offline / mock / unit |
| platform-button-rental-phase3-store-subscription.spec.ts | 0 | Offline / mock / unit |
| platform-button-rental-phase5-return-and-deposit-payout.spec.ts | 0 | Offline / mock / unit |
| platform-button-rental-phase6-outbox-and-notifications.spec.ts | 0 | Offline / mock / unit |
| platform-button-rental-phase7-api-validation-and-audit.spec.ts | 0 | Offline / mock / unit |
| platform-button-rental-phase1-payos-integration.spec.ts | 0 | Offline / mock / unit |
| platform-button-rental-phase4-expiry-and-order-lock.spec.ts | 0 | Offline / mock / unit |
| superpower-security-unit.spec.ts | 0 | Offline / mock / unit |
| rental-closeout-http.spec.ts | 0 | Nest HTTP loopback, fixture auth/DB, real RolesGuard/validation/interceptor/filter |
| rental-closeout-postgres.spec.ts | 0 | PASS: Real PostgreSQL guarded acceptance on isolated Neon test database `smart_order_test` (Exit code 0). Tested 7 scenarios with observed lock wait (`wait_event_type = 'Lock'`), full 3-button handover -> return -> locked approve -> verifier check -> payout, late PayOS overpayment obligation, fault injection rollback, and immutable snapshot trigger verification. |

## Compilation and schema

- `node node_modules/prisma/build/index.js generate`: exit 0.
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`: exit 0.
- `npm run build`: exit 0.
- `node node_modules/prisma/build/index.js validate`: exit 0.
- `git diff --check`: exit 0; existing LF/CRLF warnings only.

## What the implementation changes

- Monthly price snapshot is saved at creation, nullable for historical ambiguity, protected against subsequent mutation.
  The new additive migration only backfills a unique, consistent initial charge with exact positive monthly unit pricing.
  Unresolved rows remain marked pricingReviewRequired; admin rental listing can filter them.
- Renewal quotation locks its device/rental context, reads immutable pricing, excludes returned/returning devices,
  and revalidates quantity/state/structured lines at settlement. It does not divide by a mutable monthsRented counter.
- Rental receipt processing supports initial and extension charges independently of new-cash intake.
  Unapplied verified money becomes a durable OVERPAYMENT_RECEIPT plus PENDING_RECONCILIATION obligation.
- Expiry preserves operational device status. Renewal cannot unlock manual/legacy INACTIVE devices.
  Explicit manual enable still checks rental entitlement; admin duration adjustments do not falsify paidThrough.
- Pending/unpaid DTOs no longer fabricate entitlement using endDate.
- Customer cache uses exact-key eviction, including post-commit processing and worker/cron paths.
- Preview includes reserved and free devices, paginates listing separately from eligibility count, and remains readable for paid handover with intake disabled.
- Return/refund responses whitelist fields, including idempotent replay paths, without encrypted/hash/provider-payload leakage.

## Remaining acceptance gates — not certified by these passes

1. Migrations `20261103100000`, `20261103110000`, and `20261103120000` have been deployed to isolated test DB `smart_order_test` on Neon. Deployment to production DB remains pending user rollout approval.
2. Suite 71 has been verified against `smart_order_test` on Neon across 7 core scenarios (cash/cash overlap, late PayOS replay, Cash vs PayOS in-tx barrier race, PayOS vs Cash in-tx barrier race, repository return/refund lifecycle + verifier integration with AES-256-GCM ciphertext, fault injection rollback, and immutable snapshot trigger verification). Synthetic financial fixtures are retained for audit.
3. HTTP suite (Suite 70) was verified on Nest HTTP pipeline loopback with fixture auth/DB. Real production JWT/session/multi-tenant cluster load testing remains a live staging gate.
4. Live PayOS Payout gateway verification: No live money payout, live bank webhook, or production payment was attempted. Live payout credentials/permissions/IP/balance must be verified under controlled conditions during actual deployment.
5. Production rollout gate: The backend maintains `STORE_CASH_COLLECTION_ENABLED = false` by default in environment. Production migrations and flag activation are strictly deferred until deployment approval.

## Rollout conditions

Deploy additive migrations before code which reads the snapshot/receipt fields. Do not edit already-applied migrations.
Preserve ambiguous historical INACTIVE device status; it cannot safely be bulk reactivated as expiry-only.
Keep unresolved historical provider identities in explicit reconciliation rather than guessing they are new excess money.
Disabling cash intake is not a rollback of money already received: keep receipt/refund processing available.
No DROP/reset of financial history is part of rollback.
