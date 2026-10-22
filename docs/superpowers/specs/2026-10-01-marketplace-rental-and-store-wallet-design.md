# Multi-vendor Marketplace, Button Rental & Store Wallet Design Specification

## 1. Overview & Business Context
This specification outlines the business model transformation for the IoT Amazon Button Platform:
1. **Store Listing Subscription (Mô hình thuê gian hàng cho chủ shop)**: Stores pay a recurring subscription fee (monthly/quarterly/yearly) to list and sell products on the platform.
2. **Customer IoT Button Rental (Mô hình thuê nút bấm IoT cho người tiêu dùng)**: End-customers rent IoT buttons directly from the platform on a periodic basis (e.g., 50,000 VND/month for single button or bundled kit of 3 buttons) configured dynamically by Admins.
3. **Marketplace Escrow & Store Wallet Balance Management (Luồng tiền thanh toán & Quản lý số dư Shop - Option 1)**: Customer online payments flow through the platform's PayOS merchant account. Upon successful order completion (`COMPLETED`), order revenue is credited to the store's in-app wallet (`StoreWallet`). Store owners can track their balance, view transaction history, and submit withdrawal requests to their actual bank accounts for Admin approval.

---

## 2. Core Architectural Pillars

### Pillar 1: Store Subscription Engine
- **Admin Configuration**: Admins configure listing plans (`SubscriptionPlan`) with code, name, duration (days), price, and limits (e.g., max active products).
- **Store Contract (`StoreSubscription`)**: Stores subscribe to a plan using either their available wallet balance or direct PayOS payment.
- **Access Control**: When a store's subscription expires, store products cannot be created and warning alerts are displayed to renew.

### Pillar 2: Customer Button Rental System
- **Admin Configuration**: Admins configure rental packages (`RentalPackage`) specifying button quantity (e.g., 1 button vs 3-button kit), monthly price, and refundable deposit fee.
- **Customer Rental Flow (`ButtonRental`)**: Customers choose a package and rental duration (months), complete PayOS checkout, and receive activated button device(s) linked to their rental contract.
- **Hardware Association**: `IoTButton` links to `rentalId` as a nullable foreign key, allowing multiple physical buttons to belong to a single kit rental contract.

### Pillar 3: Marketplace Escrow & Store Wallet Management
- **In-app Store Wallet (`StoreWallet`)**: Each store has a dedicated wallet record tracking:
  - `balance`: Available funds that can be withdrawn or used to pay listing subscriptions.
  - `frozenBalance`: Funds pending order settlement or pending withdrawal.
  - Bank Account details: `bankName`, `bankAccountNumber`, `bankAccountHolder`.
- **Order Revenue Settlement**:
  - When an order transitions to `COMPLETED`, if paid online via PayOS (`paymentStatus == 'PAID'`), the order's `totalAmount` is added to `StoreWallet.balance`.
  - An immutable `WalletTransaction` audit record is created with type `ORDER_REVENUE`.
- **Store Withdrawal Flow (`StoreWithdrawal`)**:
  - Store owners submit a withdrawal request (`POST /api/v1/store/wallet/withdrawals`).
  - The requested amount is immediately deducted from `balance` to prevent double withdrawal.
  - Status starts at `PENDING`.
  - Admin reviews via `AdminWithdrawalController`:
    - **Approve/Transfer**: Admin marks as `TRANSFERRED` with transfer reference or proof receipt.
    - **Reject**: Admin provides a rejection reason; the amount is automatically refunded back to the store's `balance` with a `REFUND` transaction.

---

## 3. Database Schema Extensions (Prisma Models)

```prisma
// 1. Subscription Plan for Stores
model SubscriptionPlan {
  planId        BigInt              @id @default(autoincrement()) @map("plan_id")
  planCode      String              @unique @map("plan_code")
  planName      String              @map("plan_name")
  description   String?
  price         Decimal             @db.Decimal(15, 2)
  durationDays  Int                 @map("duration_days") // e.g. 30, 90, 365
  maxProducts   Int                 @default(50) @map("max_products")
  isActive      Boolean             @default(true) @map("is_active")
  createdAt     DateTime            @default(now()) @map("created_at")
  updatedAt     DateTime            @default(now()) @updatedAt @map("updated_at")

  subscriptions StoreSubscription[]

  @@map("subscription_plans")
}

// 2. Store Subscription Contract
model StoreSubscription {
  subscriptionId BigInt           @id @default(autoincrement()) @map("subscription_id")
  storeId        BigInt           @map("store_id")
  store          Store            @relation(fields: [storeId], references: [storeId], onDelete: Restrict)
  planId         BigInt           @map("plan_id")
  plan           SubscriptionPlan @relation(fields: [planId], references: [planId], onDelete: Restrict)
  startDate      DateTime         @map("start_date")
  endDate        DateTime         @map("end_date")
  status         String           @default("ACTIVE") @map("status") // ACTIVE, EXPIRED, CANCELLED
  paymentMethod  String           @default("PAYOS") @map("payment_method") // PAYOS, WALLET
  createdAt      DateTime         @default(now()) @map("created_at")
  updatedAt      DateTime         @default(now()) @updatedAt @map("updated_at")

  @@map("store_subscriptions")
}

// 3. Rental Package for IoT Buttons
model RentalPackage {
  packageId      BigInt         @id @default(autoincrement()) @map("package_id")
  packageCode    String         @unique @map("package_code") // e.g. SINGLE_1M, KIT3_1M
  packageName    String         @map("package_name")
  description    String?
  buttonQuantity Int            @default(1) @map("button_quantity") // 1 or 3 buttons
  monthlyPrice   Decimal        @map("monthly_price") @db.Decimal(15, 2) // e.g. 50000.00
  depositFee     Decimal        @default(0) @map("deposit_fee") @db.Decimal(15, 2)
  isActive       Boolean        @default(true) @map("is_active")
  createdAt      DateTime       @default(now()) @map("created_at")
  updatedAt      DateTime       @default(now()) @updatedAt @map("updated_at")

  rentals        ButtonRental[]

  @@map("rental_packages")
}

// 4. Button Rental Contract for Customers
model ButtonRental {
  rentalId        BigInt          @id @default(autoincrement()) @map("rental_id")
  rentalCode      String          @unique @map("rental_code")
  customerId      BigInt          @map("customer_id")
  customer        CustomerProfile @relation(fields: [customerId], references: [customerId], onDelete: Restrict)
  packageId       BigInt          @map("package_id")
  package         RentalPackage   @relation(fields: [packageId], references: [packageId], onDelete: Restrict)
  monthsRented    Int             @default(1) @map("months_rented")
  totalRentAmount Decimal         @map("total_rent_amount") @db.Decimal(15, 2)
  depositAmount   Decimal         @default(0) @map("deposit_amount") @db.Decimal(15, 2)
  startDate       DateTime        @map("start_date")
  endDate         DateTime        @map("end_date")
  status          String          @default("PENDING_PAYMENT") @map("status") // PENDING_PAYMENT, ACTIVE, EXPIRED, TERMINATED
  createdAt       DateTime        @default(now()) @map("created_at")
  updatedAt       DateTime        @default(now()) @updatedAt @map("updated_at")

  buttons         IoTButton[]

  @@map("button_rentals")
}

// 5. Store Wallet
model StoreWallet {
  walletId          BigInt              @id @default(autoincrement()) @map("wallet_id")
  storeId           BigInt              @unique @map("store_id")
  store             Store               @relation(fields: [storeId], references: [storeId], onDelete: Cascade)
  balance           Decimal             @default(0) @map("balance") @db.Decimal(15, 2)
  frozenBalance     Decimal             @default(0) @map("frozen_balance") @db.Decimal(15, 2)
  bankName          String?             @map("bank_name")
  bankAccountNumber String?             @map("bank_account_number")
  bankAccountHolder String?             @map("bank_account_holder")
  createdAt         DateTime            @default(now()) @map("created_at")
  updatedAt         DateTime            @default(now()) @updatedAt @map("updated_at")

  transactions      WalletTransaction[]
  withdrawals       StoreWithdrawal[]

  @@map("store_wallets")
}

// 6. Wallet Transactions (Ledger)
model WalletTransaction {
  transactionId BigInt      @id @default(autoincrement()) @map("transaction_id")
  walletId      BigInt      @map("wallet_id")
  wallet        StoreWallet @relation(fields: [walletId], references: [walletId], onDelete: Cascade)
  amount        Decimal     @map("amount") @db.Decimal(15, 2) // positive for credit, negative for debit
  type          String      @map("type") // ORDER_REVENUE, WITHDRAWAL, SUBSCRIPTION_PAYMENT, REFUND
  balanceBefore Decimal     @map("balance_before") @db.Decimal(15, 2)
  balanceAfter  Decimal     @map("balance_after") @db.Decimal(15, 2)
  referenceId   String?     @map("reference_id") // e.g. order_code or withdrawal_code
  description   String?     @map("description")
  createdAt     DateTime    @default(now()) @map("created_at")

  @@map("wallet_transactions")
}

// 7. Store Withdrawal Requests
model StoreWithdrawal {
  withdrawalId        BigInt      @id @default(autoincrement()) @map("withdrawal_id")
  withdrawalCode      String      @unique @map("withdrawal_code")
  walletId            BigInt      @map("wallet_id")
  wallet              StoreWallet @relation(fields: [walletId], references: [walletId], onDelete: Cascade)
  amount              Decimal     @map("amount") @db.Decimal(15, 2)
  bankName            String      @map("bank_name")
  bankAccountNumber   String      @map("bank_account_number")
  bankAccountHolder   String      @map("bank_account_holder")
  status              String      @default("PENDING") @map("status") // PENDING, APPROVED, TRANSFERRED, REJECTED
  approvedByUserId    BigInt?     @map("approved_by_user_id")
  rejectionReason     String?     @map("rejection_reason")
  transferEvidenceUrl String?     @map("transfer_evidence_url")
  requestedAt         DateTime    @default(now()) @map("requested_at")
  processedAt         DateTime?   @map("processed_at")
  createdAt           DateTime    @default(now()) @map("created_at")
  updatedAt           DateTime    @default(now()) @updatedAt @map("updated_at")

  @@map("store_withdrawals")
}
```

---

## 4. API Endpoints Map

### 4.1 Admin APIs (`SUPER_ADMIN`)
- `POST /api/v1/admin/plans`: Create store subscription plan.
- `GET /api/v1/admin/plans`: List all subscription plans.
- `PUT /api/v1/admin/plans/:id`: Update subscription plan.
- `POST /api/v1/admin/rentals/packages`: Create button rental package.
- `GET /api/v1/admin/rentals/packages`: List all rental packages.
- `PUT /api/v1/admin/rentals/packages/:id`: Update rental package.
- `GET /api/v1/admin/withdrawals`: List all store withdrawal requests with filter by status.
- `POST /api/v1/admin/withdrawals/:id/transfer`: Confirm transfer & mark as `TRANSFERRED`.
- `POST /api/v1/admin/withdrawals/:id/reject`: Reject request & auto refund balance.

### 4.2 Store Owner APIs (`STORE_OWNER` / Store Context)
- `GET /api/v1/store/wallet`: Get current store wallet balance, frozen balance, and bank info.
- `PUT /api/v1/store/wallet/bank-account`: Set/update bank account (bankName, bankAccountNumber, bankAccountHolder).
- `GET /api/v1/store/wallet/transactions`: List paginated wallet transaction history.
- `POST /api/v1/store/wallet/withdrawals`: Request money withdrawal.
- `GET /api/v1/store/wallet/withdrawals`: List store's withdrawal requests.
- `GET /api/v1/store/subscriptions/current`: Get active store subscription status & days remaining.
- `POST /api/v1/store/subscriptions/subscribe`: Subscribe/renew plan using wallet balance or PayOS.

### 4.3 Customer APIs (`CUSTOMER`)
- `GET /api/v1/rentals/packages`: View available IoT button rental packages.
- `POST /api/v1/rentals/order`: Create rental contract & generate PayOS payment link.
- `GET /api/v1/rentals/my-rentals`: View active and past button rental contracts.
