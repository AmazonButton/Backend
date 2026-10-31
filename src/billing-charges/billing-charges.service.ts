import { Injectable, Inject, NotFoundException, BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { BillingChargesRepository, CreateChargeInput } from './billing-charges.repository';

@Injectable()
export class BillingChargesService {
  constructor(
    @Inject(BillingChargesRepository) private readonly repository: BillingChargesRepository,
  ) {}

  async createInitialRentalCharge(params: {
    rentalId: bigint;
    customerId: bigint;
    rentAmount: number;
    depositAmount: number;
    months?: number;
    paymentMethod?: string;
  }) {
    const rent = params.rentAmount || 30000;
    const deposit = params.depositAmount || 200000;
    const totalAmount = rent + deposit;

    const chargeInput: CreateChargeInput = {
      rentalId: params.rentalId,
      customerId: params.customerId,
      purpose: 'RENTAL_INITIAL',
      targetType: 'RENTAL',
      targetId: params.rentalId,
      totalAmount,
      lines: [
        {
          lineType: 'RENT',
          amount: rent,
          description: `Phí thuê nút thông minh (${params.months || 1} tháng)`,
          durationUnit: 'MONTH',
          durationCount: params.months || 1,
          quantity: 1,
          unitPrice: rent,
        },
        {
          lineType: 'DEPOSIT',
          amount: deposit,
          description: 'Tiền cọc thiết bị nút bấm thông minh (hoàn lại khi trả nút)',
          quantity: 1,
          unitPrice: deposit,
        },
      ],
      paymentMethod: params.paymentMethod || 'PAYOS',
    };

    return this.repository.createChargeWithLines(chargeInput);
  }

  async createRenewalRentalCharge(params: {
    rentalId: bigint;
    customerId: bigint;
    rentAmount?: number;
    months?: number;
  }) {
    const rent = params.rentAmount || 30000;

    const chargeInput: CreateChargeInput = {
      rentalId: params.rentalId,
      customerId: params.customerId,
      purpose: 'RENTAL_EXTENSION',
      targetType: 'RENTAL',
      targetId: params.rentalId,
      totalAmount: rent,
      lines: [
        {
          lineType: 'RENT',
          amount: rent,
          description: `Gia hạn thuê nút thông minh (${params.months || 1} tháng)`,
          durationUnit: 'MONTH',
          durationCount: params.months || 1,
          quantity: 1,
          unitPrice: rent,
        },
      ],
      paymentMethod: 'PAYOS',
    };

    return this.repository.createChargeWithLines(chargeInput);
  }

  async createStoreSubscriptionCharge(params: {
    storeId: bigint;
    amount?: number;
    durationDays?: number;
    paymentMethod?: string;
  }) {
    const amount = params.amount || 60000;

    const chargeInput: CreateChargeInput = {
      storeId: params.storeId,
      purpose: 'STORE_SUBSCRIPTION',
      targetType: 'STORE',
      targetId: params.storeId,
      totalAmount: amount,
      lines: [
        {
          lineType: 'STORE_SUBSCRIPTION',
          amount,
          description: `Phí duy trì gian hàng (${params.durationDays || 30} ngày)`,
          durationUnit: 'DAY',
          durationCount: params.durationDays || 30,
          quantity: 1,
          unitPrice: amount,
        },
      ],
      paymentMethod: params.paymentMethod || 'PAYOS',
    };

    return this.repository.createChargeWithLines(chargeInput);
  }

  async settleCharge(chargeId: bigint, receipt: any, actor?: any) {
    if (typeof receipt === 'string') {
      throw new BadRequestException('Chỉ chấp nhận biên lai thanh toán đã được xác minh từ cổng thanh toán (verified: true)');
    }

    if (!receipt || typeof receipt !== 'object' || receipt.verified !== true) {
      throw new BadRequestException('Chỉ chấp nhận biên lai thanh toán đã được xác minh từ cổng thanh toán (verified: true)');
    }

    const charge = await this.repository.findChargeById(chargeId);
    if (!charge) {
      throw new NotFoundException(`Khoản thu #${chargeId} không tồn tại`);
    }

    if (charge.status === 'PAID') {
      return {
        alreadySettled: true,
        status: 'PAID',
        charge,
        storeWalletCredited: false,
      };
    }

    return this.repository.settleChargeAtomicTx(chargeId, receipt, actor);
  }

  async reconcileAndSettleCharge(chargeId: bigint, providerTransactionCode: string, actor: any) {
    if (!providerTransactionCode || typeof providerTransactionCode !== 'string' || providerTransactionCode.trim().length === 0) {
      throw new BadRequestException('Mã giao dịch đối soát của cổng thanh toán (providerTransactionCode) là bắt buộc');
    }

    const charge = await this.repository.findChargeById(chargeId);
    if (!charge) {
      throw new NotFoundException(`Khoản thu #${chargeId} không tồn tại`);
    }

    if (charge.status === 'PAID') {
      return {
        alreadySettled: true,
        status: 'PAID',
        charge,
        storeWalletCredited: false,
      };
    }

    // Verify against provider or sandbox/mock
    const clientId = process.env.PAYOS_CLIENT_ID?.trim();
    const isMock = process.env.PAYOS_MOCK_PAYMENT === 'true' || clientId === 'mock_client_id';
    const isAllowedMockEnv = ['test', 'development', 'local'].includes(process.env.NODE_ENV || '');

    if (isMock && !isAllowedMockEnv) {
      throw new BadRequestException('Chế độ giả lập thanh toán (Mock payment) bị cấm tuyệt đối trên môi trường Staging và Production');
    }

    let actualProviderTxCode = providerTransactionCode.trim();
    let paidAmount = Number(charge.totalAmount);
    let paidAt = new Date();

    if (!isMock) {
      // In production: server-to-server query to verify transaction
      const apiKey = process.env.PAYOS_API_KEY?.trim();
      if (!clientId || !apiKey) {
        throw new BadRequestException('Cổng thanh toán PayOS chưa được cấu hình đầy đủ để đối soát server-to-server');
      }
      try {
        const orderCodeOrId = charge.paymentLinkId || charge.chargeCode;
        const response = await fetch(`https://api-merchant.payos.vn/v2/payment-requests/${orderCodeOrId}`, {
          method: 'GET',
          headers: {
            'x-client-id': clientId,
            'x-api-key': apiKey,
          },
        });
        const result = await response.json();
        if (result.code !== '00' || result.data?.status !== 'PAID') {
          throw new BadRequestException(`Giao dịch trên PayOS chưa hoàn tất thanh toán (trạng thái: ${result.data?.status || result.desc})`);
        }

        const providerTx = result.data.transactions?.[0];
        const reportedTxCode = (providerTx?.reference || result.data.id?.toString() || '').trim();
        if (providerTransactionCode && reportedTxCode && providerTransactionCode !== reportedTxCode) {
          throw new BadRequestException(
            `Mã giao dịch cung cấp (${providerTransactionCode}) không khớp với mã giao dịch thực tế từ PayOS (${reportedTxCode})`
          );
        }
        actualProviderTxCode = reportedTxCode || providerTransactionCode.trim();

        const reportedAmount = Number(providerTx?.amount ?? result.data.amount);
        if (!Number.isFinite(reportedAmount) || reportedAmount <= 0) {
          throw new BadRequestException('Số tiền thanh toán từ cổng thanh toán không hợp lệ');
        }
        if (reportedAmount !== Number(charge.totalAmount)) {
          throw new BadRequestException(`Số tiền thanh toán trên PayOS (${reportedAmount}) không khớp với khoản thu (${charge.totalAmount})`);
        }
        paidAmount = reportedAmount;

        if (providerTx?.transactionDateTime) {
          paidAt = new Date(providerTx.transactionDateTime);
        }
      } catch (err: any) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException(`Không thể đối soát giao dịch từ PayOS: ${err.message}`);
      }
    }

    const verifiedReceipt: any = {
      provider: 'PAYOS',
      providerTransactionCode: actualProviderTxCode,
      amount: paidAmount,
      currency: charge.currency || 'VND',
      paidAt,
      verified: true,
      metadata: { reconciledBy: actor?.userId?.toString() || 'SYSTEM' },
    };

    return this.repository.settleChargeAtomicTx(chargeId, verifiedReceipt, actor);
  }

  async getChargeById(chargeId: bigint, user: any) {
    if (!user) {
      throw new UnauthorizedException('Yêu cầu xác thực tài khoản để truy cập khoản thu');
    }

    const charge = await this.repository.findChargeById(chargeId);
    if (!charge) {
      throw new NotFoundException(`Khoản thu #${chargeId} không tồn tại`);
    }

    const role = user.role || user.roleCode;
    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(role);
    if (!isAdmin) {
      if (charge.targetType === 'RENTAL') {
        const rental = await this.repository.findRentalWithCustomer(charge.targetId);
        const customerProfileId = user.customerProfileId?.toString();
        const userId = (user.userId || user.id || user.sub)?.toString();

        const isMatch =
          rental &&
          (rental.customerId?.toString() === customerProfileId ||
            rental.customer?.userId?.toString() === userId);

        if (!isMatch) {
          throw new ForbiddenException('Bạn không có quyền truy cập vào khoản thu này');
        }
      } else if (charge.targetType === 'STORE' || charge.targetType === 'STORE_SUBSCRIPTION') {
        const userStoreId = user.storeId?.toString();
        if (!userStoreId || charge.targetId.toString() !== userStoreId) {
          throw new ForbiddenException('Bạn không có quyền truy cập vào khoản thu của cửa hàng khác');
        }
      } else {
        throw new ForbiddenException('Bạn không có quyền truy cập vào khoản thu này');
      }
    }

    return charge;
  }

  async findChargeByOrderCode(orderCode: string, paymentLinkId?: string) {
    return this.repository.findChargeByOrderCode(orderCode, paymentLinkId);
  }

  async createPayosPaymentRequestForCharge(
    chargeId: bigint,
    user: any,
    customReturnUrl?: string,
    customCancelUrl?: string,
  ) {
    const charge = await this.getChargeById(chargeId, user);
    if (!charge) {
      throw new NotFoundException(`Khoản thu #${chargeId} không tồn tại`);
    }

    if (charge.status === 'PAID') {
      throw new BadRequestException('Khoản thu đã được thanh toán hoàn tất');
    }

    // Idempotent return: if charge is already PENDING and has active payment link, return it
    if (charge.paymentLinkId && charge.checkoutUrl && charge.providerTransactionCode) {
      return {
        paymentTransactionId: charge.chargeId.toString(),
        chargeCode: charge.chargeCode,
        orderCode: Number(charge.providerTransactionCode),
        amount: Number(charge.totalAmount),
        checkoutUrl: charge.checkoutUrl,
        qrCode: charge.qrCode,
        paymentLinkId: charge.paymentLinkId,
        currency: 'VND',
        status: 'PENDING',
      };
    }

    const orderAmount = Number(charge.totalAmount);
    if (!orderAmount || orderAmount < 1000) {
      throw new BadRequestException('Số tiền thanh toán phải từ 1.000 VND trở lên');
    }

    // Unique integer orderCode for PayOS (integer <= 9007199254740991)
    const orderCode = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
    const description = (charge.chargeCode || `CHG${charge.chargeId}`).slice(0, 25);
    const returnUrl = customReturnUrl || process.env.PAYOS_RETURN_URL || 'http://localhost:3000/payment/success';
    const cancelUrl = customCancelUrl || process.env.PAYOS_CANCEL_URL || 'http://localhost:3000/payment/cancel';

    const clientId = process.env.PAYOS_CLIENT_ID?.trim();
    const apiKey = process.env.PAYOS_API_KEY?.trim();
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim() || 'mock_checksum_key_dev';
    const isMock = process.env.PAYOS_MOCK_PAYMENT === 'true' || clientId === 'mock_client_id' || !clientId;
    const isAllowedMockEnv = ['test', 'development', 'local'].includes(process.env.NODE_ENV || '');

    if (isMock && !isAllowedMockEnv) {
      throw new BadRequestException('Chế độ giả lập thanh toán (Mock payment) bị cấm tuyệt đối trên môi trường Staging và Production');
    }

    if (isMock) {
      const mockPaymentLinkId = `pl_${orderCode}`;
      const mockCheckoutUrl = `https://pay.payos.vn/web/${mockPaymentLinkId}`;
      const mockQrCode = `vietqr://pay?bin=970422&acc=1029384756&amount=${orderAmount}&desc=${orderCode}`;

      await this.repository.updatePaymentLinkDetails(charge.chargeId, {
        paymentLinkId: mockPaymentLinkId,
        checkoutUrl: mockCheckoutUrl,
        qrCode: mockQrCode,
        providerTransactionCode: orderCode.toString(),
      });

      return {
        paymentTransactionId: charge.chargeId.toString(),
        chargeCode: charge.chargeCode,
        orderCode,
        amount: orderAmount,
        checkoutUrl: mockCheckoutUrl,
        qrCode: mockQrCode,
        paymentLinkId: mockPaymentLinkId,
        currency: 'VND',
        status: 'PENDING',
      };
    }

    const { signPaymentRequest } = await import('../payments/payos.helper');
    const signature = signPaymentRequest(
      {
        amount: orderAmount,
        cancelUrl,
        description,
        orderCode,
        returnUrl,
      },
      checksumKey,
    );

    const response = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': clientId!,
        'x-api-key': apiKey!,
      },
      body: JSON.stringify({
        orderCode,
        amount: orderAmount,
        description,
        cancelUrl,
        returnUrl,
        signature,
      }),
    });

    const result = await response.json();
    if (result.code !== '00') {
      throw new BadRequestException(`PayOS trả về lỗi: ${result.desc || 'Không thể tạo liên kết thanh toán'}`);
    }

    const paymentLinkId = result.data.paymentLinkId;
    const checkoutUrl = result.data.checkoutUrl;
    const qrCode = result.data.qrCode;

    await this.repository.updatePaymentLinkDetails(charge.chargeId, {
      paymentLinkId,
      checkoutUrl,
      qrCode,
      providerTransactionCode: orderCode.toString(),
    });

    return {
      paymentTransactionId: charge.chargeId.toString(),
      chargeCode: charge.chargeCode,
      orderCode,
      amount: orderAmount,
      checkoutUrl,
      qrCode,
      paymentLinkId,
      currency: 'VND',
      status: 'PENDING',
    };
  }
}
