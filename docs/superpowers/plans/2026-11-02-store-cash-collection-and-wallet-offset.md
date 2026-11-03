# Store Cash Collection & Wallet Offset — v1 Implementation Plan

Updated: 2026-11-03. Scope follows the user's final decision; no further business-design approval is required.
Status: **PARTIAL — Task 1 foundations implemented; runtime Tasks 2–5 remain.**
This is not a production-readiness or concurrency certification.

## 1. Locked scope

- Store collects physical cash; Platform offsets the same amount against the Store's available wallet balance.
- Rental fee and deposit belong to Platform. No credit to StoreWallet; frozen withdrawal funds are not spendable.
- Example: one button, three paid months = 90,000 rent + 200,000 deposit = 290,000 VND.
- Customer authorizes a specific collecting Store via a 32-byte random QR token; persist SHA-256 only.
- No PIN in v1. Collecting Store is independent of fulfillment Store.
- Immediate handover must satisfy the complete existing device/rental lifecycle; deferred payment does not start rental time.
- Overpayments create liabilities pending source-of-funds reconciliation. A customer's VERIFIED account is not automatic proof of the payer's refund destination.
- Existing rental-deposit return/payout lifecycle remains separate from billing-overpayment liabilities and penny-deposit verification.

## 2. Database contract

| Resource | Required constraint |
| --- | --- |
| StoreCashReceipt | UNIQUE(charge_id), UNIQUE(voucher_id), UNIQUE(wallet_transaction_id) |
| BillingPaymentReceipt | UNIQUE(provider, channel, provider_transaction_ref); charge_id NOT unique |
| BillingOverpaymentObligation | UNIQUE(receipt_id) |
| BillingCharge settlement | Conditional UPDATE WHERE status = 'PENDING', affected rows must equal 1 |
| StoreCashVoucher | UNIQUE(token_hash), partial UNIQUE(rental_id) WHERE status = 'ACTIVE' |

Additional foundations:
- Composite rental/customer FK prevents a voucher being issued against another customer's rental.
- Composite charge/target/rental/amount FK binds voucher to the authoritative charge.
- Composite receipt/voucher FK binds charge, collecting Store and amount.
- Obligation amount and classification are bound to its OVERPAYMENT_RECEIPT.
- Financial FKs use RESTRICT. Money is positive integer VND; no plaintext account data or raw provider payloads in new tables.
- V1 obligation state is only PENDING_RECONCILIATION; recipient approval and actual payout require a later explicit migration/implementation.
- A migration alone does NOT implement CAS, authorization, atomic consumption, append-only behavior or wallet accounting.

## 3. API contracts to wire in Task 4

- POST /api/v1/rentals/:rentalId/cash-vouchers (customer only)
  - Body: chargeId, collectingStoreId.
  - Customer derived from authenticated user; amount and expiry derived by server.
  - Return token once, no-store response; never log it or cache its response in api_idempotency_keys.
  - Reissue revokes all prior ACTIVE vouchers for this rental atomically, including expired ones.
- POST /api/v1/stores/:storeId/cash-receipts (owner/manager/STAFF_BUTTON)
  - Body: rentalId plus collectCashSchema fields: chargeId, voucherToken, handover.
  - DEFERRED accepts no buttonIds. IMMEDIATE requires unique buttonIds, 1–100.
  - IDs are canonical positive bigint strings. Unknown fields rejected; no client amount accepted.
  - Required scoped Idempotency-Key; mismatched payload rejected.
  - Authorize current active user and current DB ownership/staff membership, not JWT storeId alone.
  - Service must enforce allowlist even if SUPER_ADMIN bypasses RolesGuard.
- GET /api/v1/stores/:storeId/cash-receipts/:receiptId (same tenant authorization)
  - Return mapped receipt only; never token/hash, encrypted account or provider payload.
- GET /api/v1/admin/billing-overpayments (authorized read roles, page/pageSize capped at 100)
  - Operational manual reconciliation queue only; no manual-transfer/payout shortcut.

Response envelopes and errors follow existing project rules. Paths above are planned, not live endpoints.

## 4. Transaction design and lock review

Proposed explicit acquisition order:
store_wallets → billing_charges → store_cash_vouchers → iot_button (ascending IDs) → button_rentals → rental_deposits.

This is a working order, NOT proof that deadlocks are impossible.
Review real calls, FK checks, triggers and mutations in payment, voucher reissue, assignment, handover,
return, extension, expiry and wallet withdrawal paths before finalizing.
Never hold DB locks while calling PayOS/Redis/FCM.
Use bounded whole-transaction retry only for retryable DB conflicts; never retry an external money transfer blindly.

Cash transaction:
1. Validate authority inside transaction with appropriate membership/owner synchronization.
2. Lock wallet and charge. Read authoritative charge purpose, target, amount and status.
3. Existing receipt may return idempotently only after caller, tenant, request fingerprint and voucher binding checks.
4. If already paid online: no debit, no successful cash receipt; return CHARGE_ALREADY_PAID_ONLINE with POS instruction to return any cash received.
5. Lock voucher by hash; require ACTIVE, DB-clock expiry not reached, exact customer/rental/charge/store/amount.
6. Lock/validate devices and rental; immediate handover requires snapshot buttonQuantity and exact fulfillment/custody rules.
7. Conditional debit available balance; leave frozenBalance unchanged.
8. Insert wallet ledger debit, consume voucher, CAS settle charge, insert unique cash receipt.
9. Apply shared settlement effects exactly once: additive/correct initial deposit ledger, no reset-upsert of existing refunds.
10. Immediate handover uses same transaction client, not a nested transaction; derive duration from paid RENT lines.
11. Insert audit/outbox in transaction; invalidate caches after commit (cache outage must not undo successful business result).

## 5. Payment race matrix

| Ordering | Required result |
| --- | --- |
| Cash first, PayOS later | Persist distinct provider receipt + one overpayment obligation; no second deposit/duration |
| PayOS first, Cash later | No wallet debit/cash receipt; POS warning to return physical cash |
| Same PayOS transaction replay | Existing receipt; compare charge/amount/currency identity; no duplicate liability |
| Two cash submissions | One debit/receipt; second idempotent or explicit conflict |
| Same provider reference, different charge | Conflict; never rebind an existing receipt |

Integrate the actual PaymentsService webhook: its current early return on PAID must not discard late money.
Server fixes provider/channel; require genuine transaction identity, not orderCode fallback.
Review mismatch/missing-reference handling before enabling: do not silently acknowledge and lose real money.
Existing legacy providerTransactionCode rows need an explicit compatibility/backfill strategy so historical
settlements are not reclassified as overpayment on webhook replay.
All provider receipts and settlement effects must commit atomically.

## 6. Tasks and acceptance gates

### Task 1 — Foundations
- [x] Add strict Zod input contracts and cryptographic QR token helper.
- [x] Add four Prisma models and additive SQL migration with unique/FK/CHECK/partial-index constraints.
- [x] Add offline unit/contract test; observed RED before implementing models, then GREEN.
- [ ] Apply and verify migration against isolated PostgreSQL, including deliberate invalid inserts.
- No HTTP routes or financial behavior enabled at this stage.

### Task 2 — Repository transaction and shared settlement
- [ ] Implement voucher issuance/revocation and concurrency-safe collecting-store changes.
- [ ] Implement cash offset, ledger, receipt, voucher consumption, deposit and outbox atomically.
- [ ] Extract existing settlement/handover helpers accepting a transaction client.
- [ ] Add provider receipt/overpayment recording to actual webhook and reconciliation paths.
- [ ] Handle historical settlement compatibility; prove no double classification.
- [ ] Enforce append-only receipt/immutable voucher binding behavior and financial conservation.
- [ ] Audit lock graph across intersecting paths, add bounded DB retry as appropriate.

### Task 3 — Service authority, mapping and cache
- [ ] DB-backed owner/active-manager/active-STAFF_BUTTON authorization and customer consent.
- [ ] Strict charge/rental purpose/state/tenant checks before exposing payment details.
- [ ] DTO mappers and stable POS error codes; never expose token hash/provider payload.
- [ ] Post-commit targeted store/customer/admin/staff invalidation.
- [ ] Disabled-by-default feature flag until webhook and cash paths are both ready.

### Task 4 — HTTP and operations
- [ ] Register controllers/module with JWT/RBAC, Zod/class validation, scoped idempotency and rate limits.
- [ ] Protect raw voucher issuance from logs and idempotency response persistence; send Cache-Control: no-store.
- [ ] Wire exact REST routes above, Swagger contracts and admin reconciliation list.
- [ ] Verify HTTP BOLA, leakage and unknown-field behavior with actual Nest request pipeline.

### Task 5 — Real PostgreSQL and release evidence
- [ ] Guard explicit TEST_DATABASE_URL; no production fault-injection or money calls.
- [ ] Two independent Prisma connections: cash/cash, cash/PayOS in both orderings, webhook replay.
- [ ] Different charges sharing one insufficient wallet: no negative balance.
- [ ] Voucher revoke/reissue/consume race, expiry boundary, changed Store, foreign customer/charge.
- [ ] Rollback after each financial write: wallet/ledger/receipt/voucher/deposit/outbox all revert.
- [ ] Multi-button handover, partial assignment, foreign custody, correct duration, deferred fulfillment preserved.
- [ ] Withdrawal race: frozen funds unchanged; active-role revocation race.
- [ ] DB uniqueness and FK rejection, exact balances and one obligation per real excess receipt.
- [ ] Regression suites, typecheck/build, migration dry run, final handoff with actual logs.
- [ ] Enable only after these gates pass; deployment/commit/push require user instruction.

## 7. Current implementation evidence and limits

The offline suite is registered as Suite 66 (existing runner had 65), not Suite 59.
Run: node node_modules/tsx/dist/cli.mjs tests/store-cash-contract.spec.ts.
This suite checks strict input/token contracts and schema/migration declarations, not PostgreSQL behavior.
No claim of production completion, deadlock elimination or live payment verification is made.
