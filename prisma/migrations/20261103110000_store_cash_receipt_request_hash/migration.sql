BEGIN;
-- Nullable for compatibility with any previously persisted receipt; never invent
-- a request fingerprint for a historical financial operation.
ALTER TABLE "store_cash_receipts" ADD COLUMN "request_hash" VARCHAR(64);
ALTER TABLE "store_cash_receipts" ADD CONSTRAINT "ck_cash_receipt_request_hash"
    CHECK ("request_hash" IS NULL OR "request_hash" ~ '^[a-f0-9]{64}$');
COMMIT;
