-- Add CREATING to payment_transaction_status_check
ALTER TABLE payment_transaction DROP CONSTRAINT IF EXISTS payment_transaction_status_check;
ALTER TABLE payment_transaction ADD CONSTRAINT payment_transaction_status_check 
  CHECK (status = ANY (ARRAY['PENDING'::text, 'CREATING'::text, 'SUCCESS'::text, 'PAID'::text, 'FAILED'::text, 'CANCELLED'::text, 'EXPIRED'::text, 'REFUND_PENDING'::text]));
