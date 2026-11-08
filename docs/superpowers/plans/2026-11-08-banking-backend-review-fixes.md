# Implementation Plan: Banking Review & Verification Hardening

Date: 2026-11-08
Target: Resolution of Frontend Banking Review 2026-11-08 (`F:\Learning\SEM9-FPTu\update-required\8-11-2026\BANKING_BACKEND_REVIEW_2026-11-08.md`)

## 1. Objectives & Scope
1. **Store Verification Restoration & Formatter Fixes (Point 1 & Point 2)**:
   - In `BankVerificationService.formatVerificationTransaction()`, return:
     * `recipientBankBin`, `recipientBankName`, `recipientAccountNumber`, `recipientAccountHolder`
     * `qrCodeUrl`, `instructions`
     * `actualAmount` and `receivedAmount` mapped from `tx.receivedAmount ?? tx.actualAmount`
     * `failureReason`
2. **Bank Lookup Error Classification & Upstream Differentiation (Point 8)**:
   - In `PayOSBankVerificationProvider.lookupAccount()`:
     * Separate missing/invalid VietQR credentials (503 Service Unavailable) from bad user inputs (400 Bad Request).
     * Parse VietQR response codes (`42` account not found, `41` bank unsupported, `45` system busy).
   - In `BankVerificationService.lookupBankAccount()`:
     * Allow 503 and specific 400 exceptions to pass through with meaningful error codes instead of blanketing all errors into generic 400 `BANK_LOOKUP_UNAVAILABLE`.
3. **Store Withdrawal Default Bank Account Prioritization & Legacy Sync (Point 3)**:
   - In `StoreWalletService.createStoreWithdrawal()`:
     * Prioritize verified bank accounts by `[{ isDefault: 'desc' }, { updatedAt: 'desc' }]`.
   - In `BankVerificationRepository.setDefaultBankAccount()`:
     * Keep `store_wallets.bankName` and `bankAccountHolder` aligned with zero plaintext storage.
4. **Customer Bank Account CRUD & History Enrichment (Point 6)**:
   - In `CustomersController` and `CustomersService`:
     * Add `PATCH /customers/me/bank-accounts/:id/default` (set default account).
     * Add `DELETE /customers/me/bank-accounts/:id` (delete bank account with active refund safety check).
   - In `CustomerBankPennyVerificationService`:
     * Include `accountId`, `bankBin`, `bankName`, `accountNumberMasked`, `accountName`, `checkoutUrl` in `getVerificationHistory()`.
     * Include `checkoutUrl` in `getVerificationStatus()`.
5. **Swagger / OpenAPI Contract Declarations (Point 7)**:
   - Decorate `LookupBankAccountDto`, `CreateVerificationRequestDto`, and `StoreBankAccountsController` with `@ApiTags`, `@ApiOperation`, and `@ApiProperty`.
6. **Frontend Default Return/Cancel URLs (Point 5)**:
   - Default `PAYOS_RETURN_URL` and `PAYOS_CANCEL_URL` to `https://buttontdash.vercel.app/customer/banking` instead of dead URLs.
7. **Automated Verification & CI/CD Deployment**:
   - Write comprehensive test suite `tests/banking-review-2026-11-08-fixes.spec.ts`.
   - Run existing suites, verify `tsc --noEmit` and `npm run build`.
   - Deploy to AWS Node-3 and Render cluster.

---

## 2. Implementation Tasks Breakdown

### Task 1: Store Verification Transaction Formatter
- **File**: `src/bank-verification/bank-verification.service.ts`
- **File**: `src/bank-verification/bank-verification.repository.ts`

### Task 2: Provider Lookup Error Mapping & Service Error Differentiation
- **File**: `src/bank-verification/providers/payos-bank-verification.provider.ts`
- **File**: `src/bank-verification/bank-verification.service.ts`

### Task 3: Store Withdrawal Bank Resolution
- **File**: `src/store-wallet/store-wallet.service.ts`
- **File**: `src/bank-verification/bank-verification.repository.ts`

### Task 4: Customer Bank Default & Delete Endpoints, History & Status Enrichment
- **File**: `src/customers/customers.controller.ts`
- **File**: `src/customers/customers.service.ts`
- **File**: `src/customers/customers.repository.ts`
- **File**: `src/customers/customer-bank-penny-verification.service.ts`
- **File**: `src/customers/dto/customer-bank-verification-response.dto.ts`

### Task 5: Swagger / OpenAPI Annotations
- **File**: `src/bank-verification/dto/lookup-bank-account.dto.ts`
- **File**: `src/bank-verification/dto/create-verification-request.dto.ts`
- **File**: `src/bank-verification/store-bank-accounts.controller.ts`

### Task 6: Test Suite & Deployment
- **File**: `tests/banking-review-2026-11-08-fixes.spec.ts`
