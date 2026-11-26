-- Fix payment_transaction_status_check constraint to allow 'REFUNDED' status
-- Required by PaymentRefundsRepository.settleRefundSuccessAtomicTx() when an order payment refund obligation settles to REFUNDED.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payment_transaction_status_check'
      AND conrelid = 'public.payment_transaction'::regclass
  ) THEN
    ALTER TABLE "public"."payment_transaction"
      DROP CONSTRAINT "payment_transaction_status_check";
  END IF;

  ALTER TABLE "public"."payment_transaction"
    ADD CONSTRAINT "payment_transaction_status_check"
    CHECK (status = ANY (ARRAY[
      'PENDING'::text,
      'CREATING'::text,
      'SUCCESS'::text,
      'PAID'::text,
      'FAILED'::text,
      'CANCELLED'::text,
      'EXPIRED'::text,
      'REFUND_PENDING'::text,
      'REFUNDED'::text
    ]));
END $$;
