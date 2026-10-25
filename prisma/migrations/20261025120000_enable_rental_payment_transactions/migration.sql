-- AlterTable
ALTER TABLE "payment_transaction" ALTER COLUMN "order_id" DROP NOT NULL;

-- AddColumn
ALTER TABLE "payment_transaction" ADD COLUMN "rental_id" BIGINT;

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "button_rentals"("rental_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "payment_transaction" ADD CONSTRAINT "chk_payment_order_or_rental" CHECK (order_id IS NOT NULL OR rental_id IS NOT NULL);
