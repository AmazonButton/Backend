import { Injectable, Inject, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
import { runWithTransactionRetry } from '../common/utils/transaction-retry.util';

@Injectable()
export class RentalsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listAvailablePackages() {
    return this.prisma.rentalPackage.findMany({
      where: { isActive: true },
      orderBy: { monthlyPrice: 'asc' },
    });
  }

  async findPackageById(packageId: bigint) {
    return this.prisma.rentalPackage.findUnique({
      where: { packageId },
    });
  }

  async createRental(data: any) {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.buttonRental.create({
        data,
        include: {
          package: true,
          customer: {
            select: {
              customerId: true,
              userId: true,
            },
          },
        },
      });

      // Tạo khoản thu BillingCharge tương ứng ngay trong cùng transaction
      const chargeCode = `CHG-RENTAL_INITIAL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const rentAmount = Number(data.totalRentAmount) - Number(data.depositAmount || 0);
      const depositAmount = Number(data.depositAmount || 0);

      await tx.billingCharge.create({
        data: {
          chargeCode,
          purpose: 'RENTAL_INITIAL',
          targetType: 'RENTAL',
          targetId: created.rentalId,
          currency: 'VND',
          totalAmount: data.totalRentAmount,
          status: 'PENDING',
          paymentMethod: 'PAYOS',
          lines: {
            create: [
              {
                lineType: 'RENT',
                amount: rentAmount,
                description: `Phí thuê nút thông minh (${data.monthsRented || 1} tháng)`,
                durationUnit: 'MONTH',
                durationCount: data.monthsRented || 1,
                quantity: data.buttonQuantity || 1,
                unitPrice: data.rentPerButton ? Number(data.rentPerButton) : rentAmount,
              },
              {
                lineType: 'DEPOSIT',
                amount: depositAmount,
                description: 'Tiền cọc thiết bị nút bấm thông minh (hoàn lại khi trả nút)',
                quantity: data.buttonQuantity || 1,
                unitPrice: data.depositPerButton ? Number(data.depositPerButton) : depositAmount,
              },
            ],
          },
        },
      });

      return created;
    });
  }

  async listCustomerRentals(customerId: bigint) {
    return this.prisma.buttonRental.findMany({
      where: { customerId },
      include: {
        package: true,
        buttons: true,
        payments: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findRentalById(rentalId: bigint) {
    return this.prisma.buttonRental.findUnique({
      where: { rentalId },
      include: {
        package: true,
        buttons: true,
        customer: {
          include: { user: true },
        },
        payments: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  async updateRentalStatus(rentalId: bigint, status: string) {
    return this.prisma.buttonRental.update({
      where: { rentalId },
      data: { status },
      include: {
        package: true,
        buttons: true,
        customer: {
          include: { user: true },
        },
        payments: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  async createRentalPaymentTransaction(data: {
    rentalId: bigint;
    amount: number;
    provider: string;
    paymentMethod: string;
    transactionCode: string;
    status: string;
    paymentLinkId?: string;
    checkoutUrl?: string;
    qrCode?: string;
  }) {
    return this.prisma.paymentTransaction.create({
      data: {
        rentalId: data.rentalId,
        amount: new Decimal(data.amount),
        provider: data.provider,
        paymentMethod: data.paymentMethod,
        transactionCode: data.transactionCode,
        status: data.status,
        paymentLinkId: data.paymentLinkId,
        checkoutUrl: data.checkoutUrl,
        qrCode: data.qrCode,
      },
    });
  }

  async extendRentalAtomicTx(params: {
    rentalId: bigint;
    additionalMonths: number;
    additionalAmount: number;
    createPaymentTx?: boolean;
  }) {
    return runWithTransactionRetry(async () => {
      return this.prisma.$transaction(async (tx) => {
      // 1. Lock the rental row with SELECT FOR UPDATE to prevent race conditions
      const [lockedRental] = await tx.$queryRaw<Array<{
        rental_id: bigint;
        rental_code: string;
        status: string;
        end_date: Date;
        months_rented: number;
        total_rent_amount: any;
      }>>`
        SELECT rental_id, rental_code, status, end_date, months_rented, total_rent_amount
        FROM button_rentals
        WHERE rental_id = ${params.rentalId}
        FOR UPDATE
      `;

      if (!lockedRental) {
        throw new NotFoundException('Hợp đồng thuê không tồn tại');
      }

      if (['TERMINATED', 'CANCELLED'].includes(lockedRental.status)) {
        throw new BadRequestException('Không thể gia hạn hợp đồng thuê đã kết thúc hoặc hủy');
      }

      // 2. Calculate new expiration and amount on freshly locked state
      const currentEnd = new Date(lockedRental.end_date);
      const newEndDate = new Date(currentEnd.getTime() + params.additionalMonths * 30 * 24 * 60 * 60 * 1000);
      const newMonthsRented = Number(lockedRental.months_rented) + params.additionalMonths;
      const newTotalAmount = Number(lockedRental.total_rent_amount) + params.additionalAmount;

      // 3. Atomically update button_rental
      const updatedRental = await tx.buttonRental.update({
        where: { rentalId: params.rentalId },
        data: {
          endDate: newEndDate,
          monthsRented: newMonthsRented,
          totalRentAmount: new Decimal(newTotalAmount),
          updatedAt: new Date(),
        },
        include: {
          package: true,
          buttons: true,
          customer: {
            include: { user: true },
          },
          payments: { orderBy: { createdAt: 'desc' } },
        },
      });

      // 4. Optionally generate payment transaction in same transaction
      if (params.createPaymentTx) {
        // Cancel prior pending payment for this rental to satisfy uq_payment_active_per_rental
        await tx.paymentTransaction.updateMany({
          where: { rentalId: params.rentalId, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });

        const txCode = `EXT-RNT-${lockedRental.rental_code}-${Date.now().toString().slice(-4)}`;
        const paymentLinkId = `pl_ext_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        await tx.paymentTransaction.create({
          data: {
            rentalId: params.rentalId,
            amount: new Decimal(params.additionalAmount),
            provider: 'PAYOS',
            paymentMethod: 'QR',
            transactionCode: txCode,
            status: 'PENDING',
            paymentLinkId,
            checkoutUrl: `https://pay.payos.vn/web/${paymentLinkId}`,
            qrCode: `vietqr://pay?bin=970422&acc=1029384756&amount=${params.additionalAmount}&desc=${txCode}`,
          },
        });
      }

      return updatedRental;
    });
    });
  }

  async extendRental(
    rentalId: bigint,
    newEndDate: Date,
    additionalMonths: number,
    additionalAmount: number,
  ) {
    return this.extendRentalAtomicTx({
      rentalId,
      additionalMonths,
      additionalAmount,
      createPaymentTx: false,
    });
  }

  async listAllRentalsAdmin(options: {
    skip: number;
    take: number;
    status?: string;
  }) {
    const where: any = {};
    if (options.status) {
      where.status = options.status;
    }

    const [total, items] = await Promise.all([
      this.prisma.buttonRental.count({ where }),
      this.prisma.buttonRental.findMany({
        where,
        skip: options.skip,
        take: options.take,
        include: {
          package: true,
          buttons: true,
          customer: {
            include: { user: true },
          },
          payments: { orderBy: { createdAt: 'desc' } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { total, items };
  }

  async createReturnRequestTx(rentalId: bigint, buttonId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Kiểm tra và khóa bi quan thiết bị
      const lockedButtons = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM iot_button WHERE button_id = $1 FOR UPDATE',
        buttonId,
      );
      if (!lockedButtons || lockedButtons.length === 0) {
        throw new NotFoundException(`Thiết bị #${buttonId} không tồn tại`);
      }
      const button = lockedButtons[0];

      if (button.rental_id !== rentalId) {
        throw new BadRequestException('Nút bấm không thuộc hợp đồng thuê này');
      }
      if (button.inventory_state === 'RETURN_IN_TRANSIT') {
        throw new BadRequestException('Nút bấm đang trong quá trình yêu cầu trả hàng');
      }

      // 2. Chặn duplicate return request đang PENDING_RECEIPT dưới khóa
      const existingPending = await tx.rentalReturn.findFirst({
        where: {
          buttonId,
          rentalId,
          status: 'PENDING_RECEIPT',
        },
      });
      if (existingPending) {
        throw new BadRequestException('Nút bấm đã có yêu cầu trả hàng đang chờ tiếp nhận');
      }

      // 3. Cập nhật nút: RETURN_IN_TRANSIT và canOrder = false
      await tx.ioTButton.update({
        where: { buttonId },
        data: {
          inventoryState: 'RETURN_IN_TRANSIT',
          canOrder: false,
        },
      });

      // 4. Tạo yêu cầu trả nút
      const returnCode = `RET-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
      const createdReturn = await tx.rentalReturn.create({
        data: {
          returnCode,
          rentalId,
          buttonId,
          status: 'PENDING_RECEIPT',
        },
        include: {
          rental: true,
          button: true,
        },
      });

      // 5. Phát Outbox Event RENTAL_RETURN_REQUESTED cho cửa hàng nhận trả và khách hàng
      // P1 Invariant: Ưu tiên Store nhận fulfillment đã lưu trên hợp đồng thuê; chỉ dùng custody_store_id nếu có, tuyệt đối không dùng button.store_id
      const targetStoreId = createdReturn.rental?.fulfillmentStoreId || button.custody_store_id || null;
      await tx.outboxEvent.create({
        data: {
          eventType: 'RENTAL_RETURN_REQUESTED',
          payload: {
            returnId: createdReturn.returnId.toString(),
            returnCode: createdReturn.returnCode,
            rentalId: rentalId.toString(),
            buttonId: buttonId.toString(),
            customerId: createdReturn.rental?.customerId?.toString(),
            storeId: targetStoreId ? targetStoreId.toString() : null,
          },
          status: 'PENDING',
        },
      });

      return createdReturn;
    });
  }

  async confirmReturnReceiptTx(returnId: bigint, storeStaffUser: any, inspectionNote?: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Khóa và kiểm tra return request dưới row lock
      const lockedReturns = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM rental_returns WHERE return_id = $1 FOR UPDATE',
        returnId,
      );
      if (!lockedReturns || lockedReturns.length === 0) {
        throw new NotFoundException(`Yêu cầu trả nút #${returnId} không tồn tại`);
      }
      const rawReturn = lockedReturns[0];

      if (rawReturn.status !== 'PENDING_RECEIPT') {
        throw new BadRequestException(`Yêu cầu trả nút đã được xử lý (trạng thái: ${rawReturn.status})`);
      }

      // Khóa nút bấm tương ứng
      const lockedButtons = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM iot_button WHERE button_id = $1 FOR UPDATE',
        rawReturn.button_id,
      );
      if (!lockedButtons || lockedButtons.length === 0) {
        throw new NotFoundException(`Nút bấm #${rawReturn.button_id} không tồn tại`);
      }
      const rawButton = lockedButtons[0];

      // Đọc hợp đồng thuê cùng thông tin gói
      const rental = await tx.buttonRental.findUnique({
        where: { rentalId: rawReturn.rental_id },
        include: { package: true },
      });
      if (!rental) {
        throw new NotFoundException(`Hợp đồng thuê #${rawReturn.rental_id} không tồn tại`);
      }

      // Khóa sổ cọc tương ứng
      const lockedLedgers = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM rental_deposits WHERE rental_id = $1 FOR UPDATE',
        rawReturn.rental_id,
      );
      const lockedLedger = lockedLedgers && lockedLedgers.length > 0 ? lockedLedgers[0] : null;

      // Kiểm tra fulfillmentStoreId
      const targetStoreId = rental.fulfillmentStoreId || rawButton.store_id;
      const staffStoreId = storeStaffUser.storeId ? BigInt(storeStaffUser.storeId) : null;
      const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(storeStaffUser.role || storeStaffUser.roleCode);

      if (!isAdmin && (!staffStoreId || staffStoreId.toString() !== targetStoreId.toString())) {
        throw new ForbiddenException('Bạn không thuộc cửa hàng chịu trách nhiệm nhận trả thiết bị cho hợp đồng này');
      }

      const receiptStoreId = staffStoreId || targetStoreId;
      const staffUserId = storeStaffUser.userId ? BigInt(storeStaffUser.userId) : null;

      // 2. Update RentalReturn sang RECEIVED
      const updatedReturn = await tx.rentalReturn.update({
        where: { returnId },
        data: {
          status: 'RECEIVED',
          receivedByUserId: staffUserId,
          inspectedByUserId: staffUserId,
          inspectionNote: inspectionNote || 'Thiết bị hoạt động tốt, nhận trả hoàn tất',
          receivedAt: new Date(),
          inspectedAt: new Date(),
        },
      });

      // 3. Khôi phục quyền sở hữu nút về kho Store tiếp nhận
      const updatedButton = await tx.ioTButton.update({
        where: { buttonId: rawReturn.button_id },
        data: {
          customerId: null,
          rentalId: null,
          addressId: null,
          custodyStoreId: receiptStoreId,
          inventoryState: 'ALLOCATED_TO_STORE',
          status: 'INACTIVE',
          canOrder: true,
        },
      });

      // 4. Ghi nhận DeviceMovement với nguồn thực tế từ CUSTOMER
      await tx.deviceMovement.create({
        data: {
          buttonId: rawReturn.button_id,
          sourceType: 'CUSTOMER',
          destType: 'STORE',
          destStoreId: receiptStoreId,
          rentalId: rawReturn.rental_id,
          actorUserId: staffUserId,
          reason: 'Khách hàng trả nút thuê về kho cửa hàng tiếp nhận',
        },
      });

      // 5. Tính khoản cọc theo snapshot nghiệp vụ và bảo toàn chính xác:
      // R05: Không fallback sang rental.depositAmount; bắt buộc có sổ cọc hợp lệ
      if (!lockedLedger || Number(lockedLedger.collected_amount) <= 0) {
        throw new BadRequestException('Hợp đồng thuê không có bằng chứng cọc đã thu hợp lệ để hoàn trả (chuyển sang đối soát manual)');
      }

      const totalDepositCollected = Number(lockedLedger.collected_amount);
      const snapshotQuantity = rental.buttonQuantity || rental.package?.buttonQuantity || 1;
      const snapshotPerButton = rental.depositPerButton
        ? Number(rental.depositPerButton)
        : Math.floor(totalDepositCollected / snapshotQuantity);

      const fixedPerButtonDeposit = snapshotPerButton;

      if (fixedPerButtonDeposit <= 0) {
        throw new BadRequestException('Khoản cọc phân bổ cho thiết bị này bằng 0 hoặc không hợp lệ');
      }

      if (Number(lockedLedger.held_amount) < fixedPerButtonDeposit) {
        throw new BadRequestException('Số dư tiền cọc đang giữ không đủ để hoàn trả cho thiết bị này');
      }

      // Kiểm tra xem đã có refund claim cho return này chưa
      let depositRefund = await tx.depositRefund.findFirst({
        where: { returnId },
      });

      if (!depositRefund) {
        const refundCode = `REF-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
        depositRefund = await tx.depositRefund.create({
          data: {
            refundCode,
            returnId,
            rentalId: rawReturn.rental_id,
            customerId: rental.customerId,
            amount: fixedPerButtonDeposit,
            status: 'PENDING_APPROVAL',
          },
        });
      }

      // 6. Đếm số nút còn lại để đánh dấu RETURNED khi toàn bộ nút của hợp đồng đã được trả hết
      const remainingRentedButtons = await tx.ioTButton.count({
        where: {
          rentalId: rawReturn.rental_id,
        },
      });

      if (remainingRentedButtons === 0) {
        await tx.buttonRental.update({
          where: { rentalId: rawReturn.rental_id },
          data: {
            status: 'RETURNED',
            returnedAt: new Date(),
          },
        });
      }

      // R08: Audit Log
      if ((tx as any).rentalAuditLog) {
        await (tx as any).rentalAuditLog.create({
          data: {
            actorType: storeStaffUser?.role ? (['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(storeStaffUser.role) ? 'ADMIN' : 'STAFF') : 'STAFF',
            actorUserId: staffUserId,
            action: 'CONFIRM_RETURN_RECEIPT',
            targetType: 'RENTAL_RETURN',
            targetId: returnId,
            beforeState: rawReturn.status,
            afterState: 'RECEIVED',
            amount: new Decimal(fixedPerButtonDeposit),
            correlationId: rawReturn.return_code,
            metadata: {
              buttonId: rawReturn.button_id.toString(),
              rentalId: rawReturn.rental_id.toString(),
              remainingButtons: remainingRentedButtons,
              refundAmount: fixedPerButtonDeposit,
            },
          },
        });
      }

      return {
        returnId,
        status: updatedReturn.status,
        button: updatedButton,
        movementLogged: true,
        depositRefund,
        rentalCompleted: remainingRentedButtons === 0,
      };
    });
  }

  async approveDepositRefundTx(refundId: bigint, adminUser: any) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Khóa bi-quan bản ghi deposit_refunds
      const lockedRefunds = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM deposit_refunds WHERE refund_id = $1 FOR UPDATE',
        refundId,
      );
      if (!lockedRefunds || lockedRefunds.length === 0) {
        throw new NotFoundException(`Yêu cầu hoàn cọc #${refundId} không tồn tại`);
      }
      const refund = lockedRefunds[0];

      if (refund.status === 'REFUNDED' || refund.status === 'PENDING_PAYOUT') {
        return {
          alreadyProcessed: true,
          status: refund.status,
          refund,
          storeWalletDebited: false,
        };
      }

      if (refund.status !== 'PENDING_APPROVAL') {
        throw new BadRequestException(`Yêu cầu hoàn cọc ở trạng thái không thể phê duyệt: ${refund.status}`);
      }

      // 2. Khóa bi-quan sổ cọc cha (rental_deposits)
      const lockedLedgers = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM rental_deposits WHERE rental_id = $1 FOR UPDATE',
        refund.rental_id,
      );
      if (!lockedLedgers || lockedLedgers.length === 0) {
        throw new BadRequestException('Không tìm thấy sổ tiền cọc cho hợp đồng thuê này');
      }
      const ledger = lockedLedgers[0];

      const adminUserId = adminUser.userId ? BigInt(adminUser.userId) : null;
      const refundAmount = Number(refund.amount);

      if (Number(ledger.held_amount) < refundAmount) {
        throw new BadRequestException('Số dư tiền cọc đang giữ không đủ để thực hiện yêu cầu hoàn cọc');
      }

      // 3. Atomic CAS update chuyển tiền từ held_amount sang refund_reserved_amount
      const ledgerRowsUpdated = await tx.$executeRawUnsafe(
        `UPDATE rental_deposits
         SET held_amount = held_amount - $1,
             refund_reserved_amount = refund_reserved_amount + $1,
             updated_at = NOW()
         WHERE rental_id = $2 AND held_amount >= $1`,
        refundAmount,
        refund.rental_id,
      );
      if (ledgerRowsUpdated === 0) {
        throw new BadRequestException('Không thể khóa số dư hoàn cọc do tranh chấp hoặc số dư không đủ');
      }

      // 4. Lock & snapshot verified recipient bank account
      let bankAcc: any = null;
      if (refund.bank_account_id) {
        // P1 Invariant: Bắt buộc tài khoản ngân hàng chỉ định phải thuộc đúng khách hàng của hợp đồng hoàn cọc
        const lockedBankAccounts = await tx.$queryRawUnsafe<any[]>(
          'SELECT * FROM customer_bank_accounts WHERE id = $1 AND customer_id = $2 FOR UPDATE',
          refund.bank_account_id,
          refund.customer_id,
        );
        if (!lockedBankAccounts || lockedBankAccounts.length === 0) {
          throw new BadRequestException('Tài khoản ngân hàng chỉ định không tồn tại hoặc không thuộc quyền sở hữu của khách hàng');
        }
        bankAcc = lockedBankAccounts[0];
      } else {
        // Chỉ khi refund chưa gắn bank_account_id cụ thể mới tra cứu tài khoản mặc định
        const defaultAccounts = await tx.$queryRawUnsafe<any[]>(
          `SELECT * FROM customer_bank_accounts
           WHERE customer_id = $1 AND verification_status = 'VERIFIED'
           ORDER BY is_default DESC, id DESC LIMIT 1 FOR UPDATE`,
          refund.customer_id,
        );
        bankAcc = defaultAccounts && defaultAccounts.length > 0 ? defaultAccounts[0] : null;
      }

      if (!bankAcc || bankAcc.verification_status !== 'VERIFIED') {
        throw new BadRequestException('Khách hàng chưa có tài khoản ngân hàng đã xác thực (VERIFIED) để nhận hoàn cọc');
      }

      // Update DepositRefund status -> PENDING_PAYOUT with immutable recipient snapshot
      const refundRowsUpdated = await tx.$executeRawUnsafe(
        `UPDATE deposit_refunds
         SET status = 'PENDING_PAYOUT',
             approved_by_user_id = $1,
             bank_account_id = $2,
             recipient_bin = $3,
             recipient_account_number_encrypted = $4,
             recipient_account_number_hash = $5,
             recipient_account_holder_name = $6,
             recipient_account_number_masked = $7,
             updated_at = NOW()
         WHERE refund_id = $8 AND status = 'PENDING_APPROVAL'`,
        adminUserId,
        bankAcc.id,
        bankAcc.bank_bin,
        bankAcc.account_number_encrypted,
        bankAcc.account_number_hash,
        bankAcc.account_name,
        bankAcc.account_number_masked,
        refundId,
      );
      if (refundRowsUpdated === 0) {
        throw new BadRequestException('Trạng thái yêu cầu hoàn cọc đã bị thay đổi bởi giao dịch khác');
      }

      // Đọc lại ledger mới cập nhật
      const updatedLedger = await tx.rentalDeposit.findUnique({
        where: { rentalId: refund.rental_id },
      });

      // 5. Outbox Event phát lệnh chi trả Payout
      const refundIdStr = (refund.refund_id ?? refund.refundId ?? refundId).toString();
      const rentalIdStr = (refund.rental_id ?? refund.rentalId ?? '').toString();
      const customerIdStr = (refund.customer_id ?? refund.customerId ?? '').toString();

      await tx.outboxEvent.create({
        data: {
          eventType: 'DEPOSIT_REFUND_APPROVED',
          payload: {
            refundId: refundIdStr,
            rentalId: rentalIdStr,
            customerId: customerIdStr,
            amount: refundAmount,
          },
          status: 'PENDING',
        },
      });

      // R08: Audit Log
      if ((tx as any).rentalAuditLog) {
        await (tx as any).rentalAuditLog.create({
          data: {
            actorType: adminUser?.role ? (['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(adminUser.role) ? 'ADMIN' : 'STAFF') : 'ADMIN',
            actorUserId: adminUserId,
            action: 'APPROVE_DEPOSIT_REFUND',
            targetType: 'DEPOSIT_REFUND',
            targetId: refundId,
            beforeState: 'PENDING_APPROVAL',
            afterState: 'PENDING_PAYOUT',
            amount: new Decimal(refundAmount),
            correlationId: refund.refund_code,
            metadata: {
              rentalId: refund.rental_id.toString(),
              customerId: refund.customer_id.toString(),
              amount: refundAmount,
            },
          },
        });
      }

      return {
        refundId,
        status: 'PENDING_PAYOUT',
        amount: refundAmount,
        depositLedger: {
          rentalId: updatedLedger?.rentalId,
          collectedAmount: Number(updatedLedger?.collectedAmount),
          heldAmount: Number(updatedLedger?.heldAmount),
          refundReservedAmount: Number(updatedLedger?.refundReservedAmount),
          refundedAmount: Number(updatedLedger?.refundedAmount),
        },
        storeWalletDebited: false, // Invariant: StoreWallet is NEVER debited!
      };
    });
  }

  /**
   * Bước 2 của Hoàn Cọc: Xác nhận Payout đã chuyển tiền thành công tới ngân hàng khách
   */
  async confirmDepositRefundPayoutTx(refundId: bigint, providerReferenceId: string, actor?: any) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Khóa bi-quan bản ghi deposit_refunds
      const lockedRefunds = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM deposit_refunds WHERE refund_id = $1 FOR UPDATE',
        refundId,
      );
      if (!lockedRefunds || lockedRefunds.length === 0) {
        throw new NotFoundException(`Yêu cầu hoàn cọc #${refundId} không tồn tại`);
      }
      const refund = lockedRefunds[0];

      if (refund.status === 'REFUNDED') {
        return { alreadyConfirmed: true, refund };
      }
      if (refund.status !== 'PENDING_PAYOUT') {
        throw new BadRequestException(`Yêu cầu hoàn cọc không ở trạng thái PENDING_PAYOUT (hiện tại: ${refund.status})`);
      }

      // 2. Khóa bi-quan sổ cọc
      const lockedLedgers = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM rental_deposits WHERE rental_id = $1 FOR UPDATE',
        refund.rental_id,
      );
      if (!lockedLedgers || lockedLedgers.length === 0) {
        throw new BadRequestException('Không tìm thấy sổ tiền cọc cho hợp đồng');
      }
      const ledger = lockedLedgers[0];

      const refundAmount = Number(refund.amount);
      if (Number(ledger.refund_reserved_amount) < refundAmount) {
        throw new BadRequestException('Số dư cọc dự phòng không đủ để hoàn tất payout');
      }

      // 3. Chuyển tiền từ refund_reserved_amount sang refunded_amount
      const ledgerRowsUpdated = await tx.$executeRawUnsafe(
        `UPDATE rental_deposits
         SET refund_reserved_amount = refund_reserved_amount - $1,
             refunded_amount = refunded_amount + $1,
             updated_at = NOW()
         WHERE rental_id = $2 AND refund_reserved_amount >= $1`,
        refundAmount,
        refund.rental_id,
      );
      if (ledgerRowsUpdated === 0) {
        throw new BadRequestException('Không thể chuyển đổi trạng thái số dư cọc do tranh chấp hoặc số dư không đủ');
      }

      // 4. Cập nhật trạng thái REFUNDED
      const refundRowsUpdated = await tx.$executeRawUnsafe(
        `UPDATE deposit_refunds
         SET status = 'REFUNDED',
             provider_reference_id = $1,
             refunded_at = NOW(),
             updated_at = NOW()
         WHERE refund_id = $2 AND status = 'PENDING_PAYOUT'`,
        providerReferenceId,
        refundId,
      );
      if (refundRowsUpdated === 0) {
        throw new BadRequestException('Lệnh hoàn cọc đã bị thay đổi trạng thái');
      }

      const updatedLedger = await tx.rentalDeposit.findUnique({
        where: { rentalId: refund.rental_id },
      });

      // 5. Phát sự kiện DEPOSIT_REFUND_COMPLETED
      const refundIdStr = (refund.refund_id ?? refund.refundId ?? refundId).toString();
      const rentalIdStr = (refund.rental_id ?? refund.rentalId ?? '').toString();
      const customerIdStr = (refund.customer_id ?? refund.customerId ?? '').toString();

      await tx.outboxEvent.create({
        data: {
          eventType: 'DEPOSIT_REFUND_COMPLETED',
          payload: {
            refundId: refundIdStr,
            rentalId: rentalIdStr,
            customerId: customerIdStr,
            amount: refundAmount,
            providerReferenceId,
          },
          status: 'PENDING',
        },
      });

      // R08: Audit Log
      if ((tx as any).rentalAuditLog) {
        const actorType = actor?.role
          ? (['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(actor.role) ? 'ADMIN' : 'STAFF')
          : (actor ? 'ADMIN' : 'SYSTEM');
        const actorUserId = actor?.userId ? BigInt(actor.userId) : null;

        await (tx as any).rentalAuditLog.create({
          data: {
            actorType,
            actorUserId,
            action: 'CONFIRM_DEPOSIT_REFUND_PAYOUT',
            targetType: 'DEPOSIT_REFUND',
            targetId: refundId,
            beforeState: 'PENDING_PAYOUT',
            afterState: 'REFUNDED',
            amount: new Decimal(refundAmount),
            correlationId: refund.refund_code,
            idempotencyKey: providerReferenceId,
            metadata: {
              rentalId: refund.rental_id.toString(),
              providerReferenceId,
              previousProviderReferenceId: refund.provider_reference_id || null,
              isReferenceOverridden: Boolean(
                refund.provider_reference_id && refund.provider_reference_id !== providerReferenceId,
              ),
            },
          },
        });
      }

      return {
        refundId,
        status: 'REFUNDED',
        amount: refundAmount,
        depositLedger: {
          rentalId: updatedLedger?.rentalId,
          collectedAmount: Number(updatedLedger?.collectedAmount),
          heldAmount: Number(updatedLedger?.heldAmount),
          refundReservedAmount: Number(updatedLedger?.refundReservedAmount),
          refundedAmount: Number(updatedLedger?.refundedAmount),
        },
      };
    });
  }

  /**
   * Bàn giao thiết bị cho khách hàng và kích hoạt đếm lùi thời hạn thuê
   * R04: Thống nhất lock order (iot_button FOR UPDATE trước, rồi button_rentals FOR UPDATE)
   * Kiểm tra đủ số lượng serial, đúng custody kho, không bàn giao khi thiết bị = 0
   */
  async handoverRentalButtonsTx(rentalId: bigint, staffUser: any, handoverDate?: Date) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Khóa bi-quan các nút được gán cho hợp đồng theo thứ tự button_id ASC (tránh deadlock)
      const lockedButtons = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM iot_button WHERE rental_id = $1 ORDER BY button_id ASC FOR UPDATE',
        rentalId,
      );

      // 2. Khóa bi-quan hợp đồng thuê sau khi đã khóa thiết bị
      const lockedRentals = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM button_rentals WHERE rental_id = $1 FOR UPDATE',
        rentalId,
      );
      if (!lockedRentals || lockedRentals.length === 0) {
        throw new NotFoundException(`Hợp đồng thuê #${rentalId} không tồn tại`);
      }
      const rental = lockedRentals[0];

      if (rental.status !== 'PENDING_HANDOVER') {
        throw new BadRequestException(`Chỉ có thể bàn giao nút cho hợp đồng ở trạng thái PENDING_HANDOVER (hiện tại: ${rental.status})`);
      }

      // R04: Kiểm tra nghiêm ngặt danh sách thiết bị
      if (!lockedButtons || lockedButtons.length === 0) {
        throw new BadRequestException('Hợp đồng thuê không có thiết bị nút bấm nào được gán để bàn giao');
      }

      const expectedQuantity = rental.button_quantity || 1;
      if (lockedButtons.length !== expectedQuantity) {
        throw new BadRequestException(`Số lượng thiết bị được giữ chỗ (${lockedButtons.length}) không khớp với gói thuê (${expectedQuantity})`);
      }

      if (!rental.fulfillment_store_id) {
        throw new BadRequestException('Hợp đồng thuê chưa được phân bổ cửa hàng phụ trách bàn giao');
      }

      for (const btn of lockedButtons) {
        if (btn.rental_id !== rentalId) {
          throw new BadRequestException(`Thiết bị ${btn.device_serial_number || btn.button_id} thuộc hợp đồng thuê khác`);
        }
        if (!btn.custody_store_id) {
          throw new BadRequestException(`Thiết bị ${btn.device_serial_number || btn.button_id} thiếu thông tin kho cửa hàng tạm giữ`);
        }
        if (BigInt(btn.custody_store_id) !== BigInt(rental.fulfillment_store_id)) {
          throw new BadRequestException(`Thiết bị ${btn.device_serial_number || btn.button_id} không thuộc kho của cửa hàng phụ trách bàn giao`);
        }
        if (btn.inventory_state !== 'ALLOCATED_TO_STORE') {
          throw new BadRequestException(`Thiết bị ${btn.device_serial_number || btn.button_id} không ở trạng thái ALLOCATED_TO_STORE (hiện tại: ${btn.inventory_state})`);
        }
      }

      // R03: Bàn giao tính theo số kỳ ĐÃ THANH TOÁN, không dùng bộ đếm yêu cầu gia hạn chưa trả tiền
      const paidCharges = await tx.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(SUM(bcl.duration_count), 0) as paid_months
         FROM billing_charges bc
         JOIN billing_charge_lines bcl ON bc.charge_id = bcl.charge_id
         WHERE bc.target_type = 'RENTAL' AND bc.target_id = $1
           AND bc.status = 'PAID' AND bcl.line_type = 'RENT'`,
        rentalId,
      );
      const rawPaidMonths = Number(paidCharges?.[0]?.paid_months || 0);
      if (rawPaidMonths <= 0) {
        throw new BadRequestException('Hợp đồng thuê chưa có kỳ hạn nào được thanh toán để bàn giao');
      }
      const paidMonths = rawPaidMonths;

      const effectiveStart = handoverDate || new Date();
      const effectiveExpiry = new Date(effectiveStart.getTime() + paidMonths * 30 * 24 * 60 * 60 * 1000);

      // Kích hoạt hợp đồng
      const updatedRental = await tx.buttonRental.update({
        where: { rentalId },
        data: {
          status: 'ACTIVE',
          startDate: effectiveStart,
          endDate: effectiveExpiry,
          paidThrough: effectiveExpiry,
          effectiveExpiresAt: effectiveExpiry,
          monthsRented: paidMonths,
        },
      });

      // Cập nhật từng nút sang IN_CUSTOMER_CUSTODY, canOrder = true, và ghi nhận DeviceMovement
      const staffUserId = staffUser?.userId ? BigInt(staffUser.userId) : null;
      for (const btn of lockedButtons) {
        await tx.ioTButton.update({
          where: { buttonId: btn.button_id },
          data: {
            custodyStoreId: null,
            inventoryState: 'IN_CUSTOMER_CUSTODY',
            status: 'ACTIVE',
            canOrder: true,
            installedAt: effectiveStart,
          },
        });

        await tx.deviceMovement.create({
          data: {
            buttonId: btn.button_id,
            sourceType: 'STORE',
            sourceStoreId: btn.custody_store_id ? BigInt(btn.custody_store_id) : (rental.fulfillment_store_id ? BigInt(rental.fulfillment_store_id) : null),
            destType: 'CUSTOMER',
            rentalId,
            actorUserId: staffUserId,
            reason: 'Bàn giao nút thông minh cho khách hàng kích hoạt dịch vụ',
          },
        });
      }

      // R08: Audit Log
      if ((tx as any).rentalAuditLog) {
        await (tx as any).rentalAuditLog.create({
          data: {
            actorType: staffUser?.role ? (['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(staffUser.role) ? 'ADMIN' : 'STAFF') : 'STAFF',
            actorUserId: staffUserId,
            action: 'HANDOVER_RENTAL',
            targetType: 'RENTAL',
            targetId: rentalId,
            beforeState: rental.status,
            afterState: 'ACTIVE',
            correlationId: rental.rental_code,
            metadata: {
              handoverDate: effectiveStart,
              effectiveExpiry,
              paidMonths,
              buttonCount: lockedButtons.length,
              buttonIds: lockedButtons.map((b) => b.button_id.toString()),
            },
          },
        });
      }

      return {
        rentalId,
        status: 'ACTIVE',
        effectiveExpiresAt: effectiveExpiry,
        handoverDate: effectiveStart,
        paidMonths,
        buttonCount: lockedButtons.length,
      };
    });
  }

  async findDepositRefundById(refundId: bigint) {
    return this.prisma.depositRefund.findUnique({
      where: { refundId },
      include: {
        bankAccount: true,
        customer: {
          include: {
            customerBankAccounts: true,
          },
        },
      },
    });
  }

  async createRentalExtensionCharge(
    rentalId: bigint,
    months: number,
    additionalAmount: number,
    monthlyPrice: number,
    buttonQuantity: number,
  ) {
    const chargeCode = `CHG-RENTAL_EXTENSION-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    return this.prisma.billingCharge.create({
      data: {
        chargeCode,
        purpose: 'RENTAL_EXTENSION',
        targetType: 'RENTAL',
        targetId: rentalId,
        currency: 'VND',
        totalAmount: additionalAmount,
        status: 'PENDING',
        paymentMethod: 'PAYOS',
        lines: {
          create: [
            {
              lineType: 'RENT',
              amount: additionalAmount,
              description: `Gia hạn thuê nút thông minh (${months} tháng)`,
              durationUnit: 'MONTH',
              durationCount: months,
              quantity: buttonQuantity,
              unitPrice: monthlyPrice,
            },
          ],
        },
      },
      include: { lines: true },
    });
  }

  async adjustRentalDurationAdminTx(
    rentalId: bigint,
    additionalDays: number,
    reason: string,
    adminUser: any,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM button_rentals WHERE rental_id = $1 FOR UPDATE',
        rentalId,
      );
      if (!locked || locked.length === 0) throw new NotFoundException('Hợp đồng không tồn tại');
      const r = locked[0];

      const currentExpiry = r.effective_expires_at
        ? new Date(r.effective_expires_at)
        : (r.end_date ? new Date(r.end_date) : new Date());
      const newExpiry = new Date(currentExpiry.getTime() + additionalDays * 24 * 60 * 60 * 1000);

      // R08: Chỉ cập nhật effectiveExpiresAt và endDate cho quyền sử dụng, KHÔNG chạm vào paidThrough (đã trả tiền đến ngày nào)
      await tx.buttonRental.update({
        where: { rentalId },
        data: {
          effectiveExpiresAt: newExpiry,
          endDate: newExpiry,
        },
      });

      const adminUserId = adminUser?.userId ? BigInt(adminUser.userId) : null;
      await tx.accessAdjustment.create({
        data: {
          targetType: 'RENTAL',
          targetId: rentalId,
          operation: 'EXTEND_DAYS',
          additionalDays,
          previousExpiresAt: currentExpiry,
          newExpiresAt: newExpiry,
          reason,
          actorUserId: adminUserId || BigInt(1),
        },
      });

      if ((tx as any).rentalAuditLog) {
        await (tx as any).rentalAuditLog.create({
          data: {
            actorType: adminUser?.role
              ? (['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(adminUser.role) ? 'ADMIN' : 'STAFF')
              : 'ADMIN',
            actorUserId: adminUserId,
            action: 'ADJUST_RENTAL_DURATION',
            targetType: 'RENTAL',
            targetId: rentalId,
            beforeState: r.status,
            afterState: r.status,
            reason,
            metadata: {
              additionalDays,
              previousExpiry: currentExpiry,
              newExpiry,
            },
          },
        });
      }

      return {
        rentalId: rentalId.toString(),
        previousExpiresAt: currentExpiry,
        newExpiresAt: newExpiry,
        additionalDays,
        reason,
      };
    });
  }

  async assignFulfillmentAndDevicesAdminTx(
    rentalId: bigint,
    fulfillmentStoreId: bigint,
    buttonIds: bigint[],
    actor?: any,
  ) {
    return runWithTransactionRetry(async () => {
      return this.prisma.$transaction(async (tx) => {
        // 1. Lock rental row with SELECT FOR UPDATE
        const [lockedRental] = await tx.$queryRaw<Array<{
          rental_id: bigint;
          rental_code: string;
          status: string;
          button_quantity: number;
          fulfillment_store_id: bigint | null;
        }>>`
          SELECT rental_id, rental_code, status, button_quantity, fulfillment_store_id
          FROM button_rentals
          WHERE rental_id = ${rentalId}
          FOR UPDATE
        `;

        if (!lockedRental) {
          throw new NotFoundException('Không tìm thấy hợp đồng thuê');
        }

        if (lockedRental.status !== 'PENDING_HANDOVER') {
          throw new BadRequestException('Hợp đồng phải ở trạng thái PENDING_HANDOVER để gán cửa hàng và thiết bị');
        }

        // 2. Lock store
        const [store] = await tx.$queryRaw<Array<{ store_id: bigint; status: string }>>`
          SELECT store_id, status FROM store WHERE store_id = ${fulfillmentStoreId}
        `;
        if (!store || store.status !== 'ACTIVE') {
          throw new BadRequestException('Cửa hàng xử lý đơn không tồn tại hoặc không hoạt động');
        }

        // 3. Verify quantity
        const requiredCount = lockedRental.button_quantity || 1;
        if (buttonIds.length !== requiredCount) {
          throw new BadRequestException(
            `Số lượng nút bấm (${buttonIds.length}) không khớp với số lượng yêu cầu của gói thuê (${requiredCount})`
          );
        }

        // 4. Lock and verify each button
        for (const btnId of buttonIds) {
          const [btn] = await tx.$queryRaw<Array<{
            button_id: bigint;
            custody_store_id: bigint | null;
            inventory_state: string;
            rental_id: bigint | null;
          }>>`
            SELECT button_id, custody_store_id, inventory_state, rental_id
            FROM iot_button
            WHERE button_id = ${btnId}
            FOR UPDATE
          `;

          if (!btn) {
            throw new NotFoundException(`Không tìm thấy nút bấm #${btnId}`);
          }

          if (btn.custody_store_id?.toString() !== fulfillmentStoreId.toString()) {
            throw new BadRequestException(
              `Nút bấm #${btnId} không thuộc quyền lưu kho (custody) của Store #${fulfillmentStoreId}`
            );
          }

          if (btn.inventory_state !== 'ALLOCATED_TO_STORE') {
            throw new BadRequestException(
              `Nút bấm #${btnId} đang ở trạng thái kho '${btn.inventory_state}', không thể gán cho hợp đồng`
            );
          }

          if (btn.rental_id && btn.rental_id.toString() !== rentalId.toString()) {
            throw new BadRequestException(`Nút bấm #${btnId} đã được gán cho hợp đồng thuê khác`);
          }
        }

        // 5. Update rental fulfillmentStoreId
        await tx.$executeRaw`
          UPDATE button_rentals
          SET fulfillment_store_id = ${fulfillmentStoreId}, updated_at = NOW()
          WHERE rental_id = ${rentalId}
        `;

        // 6. Update buttons and record device movements
        const actorUserId = actor?.userId ? BigInt(actor.userId) : null;
        for (const btnId of buttonIds) {
          await tx.$executeRaw`
            UPDATE iot_button
            SET rental_id = ${rentalId}, inventory_state = 'ASSIGNED_TO_RENTAL', updated_at = NOW()
            WHERE button_id = ${btnId}
          `;

          await tx.deviceMovement.create({
            data: {
              buttonId: btnId,
              sourceType: 'STORE',
              sourceStoreId: fulfillmentStoreId,
              destType: 'RENTAL',
              destStoreId: fulfillmentStoreId,
              rentalId,
              actorUserId,
              reason: 'ASSIGN_TO_RENTAL',
            },
          });
        }

        // 7. Audit Log
        if ((tx as any).rentalAuditLog) {
          await (tx as any).rentalAuditLog.create({
            data: {
              actorType: actor?.role ? (['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(actor.role) ? 'ADMIN' : 'STAFF') : 'ADMIN',
              actorUserId,
              action: 'ASSIGN_FULFILLMENT_AND_DEVICES',
              targetType: 'RENTAL',
              targetId: rentalId,
              beforeState: lockedRental.status,
              afterState: lockedRental.status,
              correlationId: lockedRental.rental_code,
              metadata: {
                fulfillmentStoreId: fulfillmentStoreId.toString(),
                buttonIds: buttonIds.map((b) => b.toString()),
              },
            },
          });
        }

        return this.prisma.buttonRental.findUnique({
          where: { rentalId },
          include: {
            package: true,
            buttons: true,
            customer: { include: { user: true } },
          },
        });
      });
    });
  }

  async findInitialChargeByRentalId(rentalId: bigint) {
    return (this.prisma as any).billingCharge.findFirst({
      where: {
        targetType: 'RENTAL',
        targetId: rentalId,
        purpose: 'RENTAL_INITIAL',
      },
      include: {
        lines: true,
      },
    });
  }
}
