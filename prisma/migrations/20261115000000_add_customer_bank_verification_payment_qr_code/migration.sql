-- AlterTable
ALTER TABLE "customer_bank_verification_proofs" ADD COLUMN IF NOT EXISTS "payment_qr_code" TEXT;
