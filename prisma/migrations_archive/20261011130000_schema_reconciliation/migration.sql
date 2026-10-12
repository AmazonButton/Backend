-- DropForeignKey
ALTER TABLE "auth_otps" DROP CONSTRAINT "auth_otps_user_id_fkey";

-- DropForeignKey
ALTER TABLE "pairing_tokens" DROP CONSTRAINT "fk_pairing_tokens_device";

-- DropForeignKey
ALTER TABLE "product_image" DROP CONSTRAINT "product_image_product_id_fkey";

-- DropIndex
DROP INDEX "idx_product_image_product";

-- AlterTable
ALTER TABLE "auth_otps" ALTER COLUMN "email" SET DATA TYPE TEXT,
ALTER COLUMN "purpose" SET DATA TYPE TEXT,
ALTER COLUMN "token_hash" SET DATA TYPE TEXT,
ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "consumed_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "device_nonces" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "iot_button" ALTER COLUMN "warranty_until" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "click_behavior" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "iot_idempotency_keys" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "locked_until" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "order_code" SET DATA TYPE TEXT,
ALTER COLUMN "order_status" SET DATA TYPE TEXT,
ALTER COLUMN "payment_status" SET DATA TYPE TEXT,
ALTER COLUMN "payment_method" SET DATA TYPE TEXT,
ALTER COLUMN "shipping_recipient_name" SET DATA TYPE TEXT,
ALTER COLUMN "shipping_phone" SET DATA TYPE TEXT,
ALTER COLUMN "shipping_address" SET DATA TYPE TEXT,
ALTER COLUMN "order_date" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "completed_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "commission_rate" SET NOT NULL,
ALTER COLUMN "commission_amount" SET NOT NULL,
ALTER COLUMN "net_amount" SET NOT NULL;

-- AlterTable
ALTER TABLE "pairing_tokens" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payment_transaction" ALTER COLUMN "provider" SET DATA TYPE TEXT,
ALTER COLUMN "transaction_code" SET DATA TYPE TEXT,
ALTER COLUMN "payment_method" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "paid_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "payment_link_id" SET DATA TYPE TEXT,
ALTER COLUMN "checkout_url" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "product" ALTER COLUMN "product_code" SET DATA TYPE TEXT,
ALTER COLUMN "product_name" SET DATA TYPE TEXT,
ALTER COLUMN "brand" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "product_discount" ALTER COLUMN "start_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "end_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "product_image" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "cloudinary_public_id" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "product_price_history" ALTER COLUMN "changed_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "provisioning_sessions" ALTER COLUMN "status" SET NOT NULL,
ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "refresh_tokens" ALTER COLUMN "token_hash" SET DATA TYPE TEXT,
ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "rental_packages" ALTER COLUMN "package_code" SET DATA TYPE TEXT,
ALTER COLUMN "package_name" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "revoked_tokens" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "roles" ALTER COLUMN "role_code" SET DATA TYPE TEXT,
ALTER COLUMN "role_name" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "store" ALTER COLUMN "name" SET DATA TYPE TEXT,
ALTER COLUMN "code" SET DATA TYPE TEXT,
ALTER COLUMN "email" SET DATA TYPE TEXT,
ALTER COLUMN "phone" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "store_customer" ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "joined_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "store_staff" ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "joined_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "left_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "store_subscriptions" ALTER COLUMN "start_date" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "end_date" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "payment_method" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "store_wallets" ALTER COLUMN "bank_name" SET DATA TYPE TEXT,
ALTER COLUMN "bank_account_number" SET DATA TYPE TEXT,
ALTER COLUMN "bank_account_holder" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "store_withdrawals" ALTER COLUMN "withdrawal_code" SET DATA TYPE TEXT,
ALTER COLUMN "bank_name" SET DATA TYPE TEXT,
ALTER COLUMN "bank_account_number" SET DATA TYPE TEXT,
ALTER COLUMN "bank_account_holder" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "requested_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "processed_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "bank_code" SET DATA TYPE TEXT,
ALTER COLUMN "fee" SET NOT NULL,
ALTER COLUMN "provider" SET NOT NULL,
ALTER COLUMN "provider" SET DATA TYPE TEXT,
ALTER COLUMN "provider_payout_id" SET DATA TYPE TEXT,
ALTER COLUMN "provider_reference_id" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "subscription_plans" ALTER COLUMN "plan_code" SET DATA TYPE TEXT,
ALTER COLUMN "plan_name" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "username" SET DATA TYPE TEXT,
ALTER COLUMN "email" SET DATA TYPE TEXT,
ALTER COLUMN "password_hash" SET DATA TYPE TEXT,
ALTER COLUMN "full_name" SET DATA TYPE TEXT,
ALTER COLUMN "phone" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "password_reset_token" SET DATA TYPE TEXT,
ALTER COLUMN "password_reset_expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "email_verification_token" SET DATA TYPE TEXT,
ALTER COLUMN "email_verification_expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "password_changed_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "wallet_transactions" ALTER COLUMN "type" SET DATA TYPE TEXT,
ALTER COLUMN "reference_id" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "store_withdrawals_provider_reference_id_key" ON "store_withdrawals"("provider_reference_id");

-- AddForeignKey
ALTER TABLE "store" ADD CONSTRAINT "store_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_staff" ADD CONSTRAINT "store_staff_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_staff" ADD CONSTRAINT "store_staff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_staff" ADD CONSTRAINT "store_staff_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("role_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_customer" ADD CONSTRAINT "store_customer_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_customer" ADD CONSTRAINT "store_customer_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_store_id_parent_category_id_fkey" FOREIGN KEY ("store_id", "parent_category_id") REFERENCES "category"("store_id", "category_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_store_id_category_id_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "category"("store_id", "category_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_discount" ADD CONSTRAINT "product_discount_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_customer_id_address_id_fkey" FOREIGN KEY ("customer_id", "address_id") REFERENCES "customer_address"("customer_id", "address_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "button_rentals"("rental_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_product" ADD CONSTRAINT "button_product_button_id_fkey" FOREIGN KEY ("button_id") REFERENCES "iot_button"("button_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_product" ADD CONSTRAINT "button_product_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_button_id_customer_id_store_id_fkey" FOREIGN KEY ("button_id", "customer_id", "store_id") REFERENCES "iot_button"("button_id", "customer_id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_templates" ADD CONSTRAINT "device_templates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_rentals" ADD CONSTRAINT "button_rentals_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_rentals" ADD CONSTRAINT "button_rentals_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "rental_packages"("package_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_wallets" ADD CONSTRAINT "store_wallets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "store_wallets"("wallet_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_withdrawals" ADD CONSTRAINT "store_withdrawals_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "store_wallets"("wallet_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_withdrawals" ADD CONSTRAINT "store_withdrawals_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_image" ADD CONSTRAINT "product_image_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_otps" ADD CONSTRAINT "auth_otps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "idx_auth_otps_email" RENAME TO "auth_otps_email_purpose_idx";

-- RenameIndex
ALTER INDEX "idx_auth_otps_hash" RENAME TO "auth_otps_token_hash_purpose_idx";

-- RenameIndex
ALTER INDEX "idx_auth_otps_user" RENAME TO "auth_otps_user_id_purpose_idx";

-- RenameIndex
ALTER INDEX "uq_button_product" RENAME TO "button_product_button_id_product_id_key";

-- RenameIndex
ALTER INDEX "uq_category_store_pair" RENAME TO "category_store_id_category_id_key";

-- RenameIndex
ALTER INDEX "uq_customer_address_pair" RENAME TO "customer_address_customer_id_address_id_key";

-- RenameIndex
ALTER INDEX "idx_device_nonces_expires_at" RENAME TO "device_nonces_expires_at_idx";

-- RenameIndex
ALTER INDEX "uq_button_cust_store_triplet" RENAME TO "iot_button_button_id_customer_id_store_id_key";

-- RenameIndex
ALTER INDEX "idx_pairing_tokens_device_status" RENAME TO "pairing_tokens_device_id_status_idx";

-- RenameIndex
ALTER INDEX "uq_product_store_code" RENAME TO "product_store_id_product_code_key";

-- RenameIndex
ALTER INDEX "uq_product_store_pair" RENAME TO "product_store_id_product_id_key";

-- RenameIndex
ALTER INDEX "idx_provisioning_sessions_session_id" RENAME TO "provisioning_sessions_session_id_idx";

-- RenameIndex
ALTER INDEX "idx_revoked_tokens_hash" RENAME TO "revoked_tokens_token_hash_idx";

-- RenameIndex
ALTER INDEX "uq_store_customer" RENAME TO "store_customer_store_id_customer_id_key";

-- RenameIndex
ALTER INDEX "uq_store_staff_store_user" RENAME TO "store_staff_store_id_user_id_key";

-- RenameIndex
ALTER INDEX "uq_wallet_tx_idempotency" RENAME TO "wallet_transactions_wallet_id_type_reference_id_key";

