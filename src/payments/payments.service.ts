import { EventsGateway } from '../websocket/events.gateway';
import {
  Injectable,
  HttpException,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PaymentsRepository } from './payments.repository';
import { CreatePaymentLinkDto, PayosWebhookDto } from './dto/payment.dto';
import { signPaymentRequest, verifyWebhookSignature } from './payos.helper';
import { Optional, Inject } from '@nestjs/common';

import { NotificationsService } from '../notifications/notifications.service';
import { ChangePaymentMethodDto } from './dto/change-payment-method.dto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly paymentsRepo: PaymentsRepository,
    @Optional() @Inject(EventsGateway) private readonly eventsGateway?: EventsGateway,
    @Optional() @Inject(NotificationsService) private readonly notificationsService?: NotificationsService,
  ) {}

  async createPayosPaymentLink(dto: CreatePaymentLinkDto, userOrUserId?: any) {
    const rawOrderId = BigInt(dto.orderId);
    const order = await this.paymentsRepo.findOrderById(rawOrderId);

    if (!order) {
      throw new NotFoundException({
        success: false,
        code: 'ORDER_NOT_FOUND',
        message: `Không tìm thấy đơn hàng với mã #${dto.orderId}`,
      });
    }

    const userId = typeof userOrUserId === 'object' && userOrUserId?.userId ? BigInt(userOrUserId.userId) : (typeof userOrUserId === 'bigint' ? userOrUserId : undefined);
    const userRole = typeof userOrUserId === 'object' ? userOrUserId?.role : undefined;
    const userStoreId = typeof userOrUserId === 'object' ? userOrUserId?.storeId : undefined;

    // Ownership verification (Anti-BOLA/IDOR)
    if (userId) {
      const isCustomerOwner = (order as any).customer && (order as any).customer.userId === userId;
      const isStoreOwner = (order as any).store && (order as any).store.ownerUserId === userId;
      const isStoreStaff = userStoreId && order.storeId.toString() === userStoreId.toString();
      const isAssignedDriver = userRole === 'STAFF_DELIVERY' && isStoreStaff && (order as any).assignedDriverId != null && (order as any).assignedDriverId.toString() === userId.toString();
      const isAdmin = userRole === 'SUPER_ADMIN' || userRole === 'SYSTEM_ADMIN';

      if (userRole === 'STAFF_DELIVERY') {
        if (!isAssignedDriver) {
          throw new ForbiddenException({
            success: false,
            code: 'ORDER_ACCESS_DENIED',
            message: 'Tài xế chỉ có thể tạo liên kết thanh toán cho đơn hàng được chỉ định thuộc cửa hàng của mình',
          });
        }
        if (order.orderStatus !== 'SHIPPING') {
          throw new BadRequestException({
            success: false,
            code: 'ORDER_NOT_SHIPPING',
            message: 'Tài xế chỉ có thể tạo liên kết thanh toán khi đơn hàng đang trong quá trình giao (SHIPPING)',
          });
        }
      } else if (!isCustomerOwner && !isStoreOwner && !isStoreStaff && !isAdmin) {
        throw new ForbiddenException({
          success: false,
          code: 'ORDER_ACCESS_DENIED',
          message: 'Bạn không có quyền tạo liên kết thanh toán cho đơn hàng này',
        });
      }
    }

    // State machine check: Chặn tạo link cho đơn đã PAID, CANCELLED, REJECTED, COMPLETED
    if (['CANCELLED', 'REJECTED', 'COMPLETED'].includes(order.orderStatus)) {
      throw new BadRequestException({
        success: false,
        code: 'ORDER_NOT_PAYABLE',
        message: `Đơn hàng ở trạng thái ${order.orderStatus} không thể tạo liên kết thanh toán`,
      });
    }

    if (order.paymentStatus === 'PAID') {
      throw new BadRequestException({
        success: false,
        code: 'ORDER_ALREADY_PAID',
        message: 'Đơn hàng này đã được thanh toán thành công',
      });
    }

    // Trả lại link PENDING hiện tại nếu đã có link đang hoạt động (chống tạo nhiều link trùng lặp)
    const existingTransactions = await this.paymentsRepo.findTransactionsByOrderId(rawOrderId);
    const existingActive = existingTransactions?.find(
      (tx: any) => tx.status === 'PENDING' && tx.paymentLinkId
    );
    if (existingActive) {
      return {
        success: true,
        message: 'Đơn hàng đã có liên kết thanh toán đang chờ xử lý',
        data: {
          paymentTransactionId: existingActive.paymentTransactionId.toString(),
          orderCode: Number(existingActive.transactionCode),
          checkoutUrl: `https://pay.payos.vn/web/${existingActive.paymentLinkId}`,
          paymentLinkId: existingActive.paymentLinkId,
          amount: Number(existingActive.amount),
          status: 'PENDING',
        },
      };
    }

    const clientId = process.env.PAYOS_CLIENT_ID?.trim();
    const apiKey = process.env.PAYOS_API_KEY?.trim();
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim();

    if (!clientId || !apiKey || !checksumKey) {
      throw new InternalServerErrorException({
        success: false,
        code: 'PAYOS_CONFIG_MISSING',
        message: 'Chưa cấu hình đầy đủ PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY trong server .env',
      });
    }

    // Strict security: Enforce official order totalAmount from DB (ignore client dto.amount to prevent tampering)
    const orderAmount = Number(order.totalAmount);
    if (!orderAmount || orderAmount < 1000) {
      throw new BadRequestException('S? ti?n thanh to�n ph?i t? 1,000 VND tr? l�n');
    }

    // Sinh orderCode ng?u nhi�n duy nh?t d?ng s? nguy�n duong cho PayOS (PayOS y�u c?u orderCode l� int <= 9007199254740991)
    const orderCode = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
    const description = (dto.description || `DH${order.orderCode || order.orderId}`).slice(0, 25);
    const returnUrl = dto.returnUrl || process.env.PAYOS_RETURN_URL || 'http://localhost:3000/payment/success';
    const cancelUrl = dto.cancelUrl || process.env.PAYOS_CANCEL_URL || 'http://localhost:3000/payment/cancel';

    // T?o b?n ghi PaymentTransaction ? tr?ng th�i PENDING tru?c
    let transaction;
    try {
      transaction = await this.paymentsRepo.createTransaction({
        orderId: rawOrderId,
        provider: 'PAYOS',
        transactionCode: orderCode.toString(),
        amount: orderAmount,
        paymentMethod: 'QR',
        status: 'PENDING',
      });
        } catch (createErr: any) {
      if (createErr.code === 'P2002' || createErr.message?.includes('uq_payment_active_per_order')) {
        // Bounded retry loop (wait up to 2 seconds for winner to finish calling PayOS and persisting link)
        for (let attempt = 0; attempt < 8; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const recheck = await this.paymentsRepo.findTransactionsByOrderId(rawOrderId);
          const activeTx = recheck?.find((tx: any) => tx.status === 'PENDING' && tx.paymentLinkId);
          if (activeTx) {
            return {
              success: true,
              message: 'Đơn hàng đã có liên kết thanh toán đang chờ xử lý',
              data: {
                paymentTransactionId: activeTx.paymentTransactionId.toString(),
                orderCode: Number(activeTx.transactionCode),
                checkoutUrl: (activeTx as any).checkoutUrl || `https://pay.payos.vn/web/${activeTx.paymentLinkId}`,
                paymentLinkId: activeTx.paymentLinkId,
                amount: Number(activeTx.amount),
                status: 'PENDING',
              },
            };
          }
        }
        throw new HttpException(
          {
            success: true,
            statusCode: 202,
            code: 'PAYMENT_LINK_CREATING',
            message: 'Liên kết thanh toán đang được khởi tạo, vui lòng thử lại sau giây lát',
          },
          HttpStatus.ACCEPTED,
        );
      }
      throw createErr;
    }

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

        // Support local test mock
    if (process.env.PAYOS_MOCK_PAYMENT === 'true' || clientId === 'mock_client_id') {
      const mockPaymentLinkId = `mock_link_${orderCode}`;
      const mockCheckoutUrl = `https://pay.payos.vn/web/mock-${orderCode}`;
      const mockQrCode = `00020101021238540010A000000727012600069704220112${orderCode}`;
      await this.paymentsRepo.updatePaymentLinkDetails(
        transaction.paymentTransactionId,
        mockPaymentLinkId,
        mockCheckoutUrl,
        mockQrCode,
      );
      return {
        success: true,
        message: 'Tạo link thanh toán PayOS thành công (mock)',
        data: {
          paymentTransactionId: transaction.paymentTransactionId.toString(),
          orderCode,
          amount: orderAmount,
          description,
          checkoutUrl: mockCheckoutUrl,
          qrCode: mockQrCode,
          paymentLinkId: mockPaymentLinkId,
          currency: 'VND',
          status: 'PENDING',
        },
      };
    }

    try {
      const response = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': clientId,
          'x-api-key': apiKey,
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
        this.logger.error(`PayOS API error: ${result.desc || JSON.stringify(result)}`);
        await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_CREATION_FAILED',
          message: result.desc || 'Không thể tạo link thanh toán PayOS',
        });
      }

      if (!result.data?.paymentLinkId) {
        this.logger.error(`PayOS API response missing paymentLinkId: ${JSON.stringify(result)}`);
        await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_CREATION_FAILED',
          message: 'PayOS không trả về paymentLinkId hợp lệ để đối soát webhook',
        });
      }

      // Point 6: Verify all PayOS response fields against internal data
      if (Number(result.data?.orderCode) !== orderCode) {
        this.logger.error(`PayOS orderCode mismatch: expected ${orderCode}, got ${result.data?.orderCode}`);
        await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_RESPONSE_MISMATCH',
          message: 'Mã orderCode trong phản hồi từ PayOS không khớp với đơn hàng nội bộ',
        });
      }

      if (Number(result.data?.amount) !== orderAmount) {
        this.logger.error(`PayOS amount mismatch: expected ${orderAmount}, got ${result.data?.amount}`);
        await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_RESPONSE_MISMATCH',
          message: 'Số tiền trong phản hồi từ PayOS không khớp với đơn hàng nội bộ',
        });
      }

      if (!result.data?.currency || typeof result.data.currency !== 'string' || result.data.currency !== 'VND') {
        this.logger.error(`PayOS currency invalid or missing: expected VND, got ${result.data?.currency}`);
        await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_RESPONSE_MISMATCH',
          message: 'Đơn vị tiền tệ trong phản hồi từ PayOS không hợp lệ hoặc không phải VND',
        });
      }

      if (typeof result.data?.paymentLinkId !== 'string' || typeof result.data?.checkoutUrl !== 'string') {
        this.logger.error(`PayOS response types invalid: ${JSON.stringify(result.data)}`);
        await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_RESPONSE_INVALID',
          message: 'Dữ liệu liên kết thanh toán từ PayOS không hợp lệ',
        });
      }

      await this.paymentsRepo.updatePaymentLinkDetails(
        transaction.paymentTransactionId,
        result.data.paymentLinkId,
        result.data.checkoutUrl,
        result.data.qrCode,
      );

      return {
        success: true,
        message: 'Tạo link thanh toán PayOS thành công',
        data: {
          paymentTransactionId: transaction.paymentTransactionId.toString(),
          orderCode,
          amount: orderAmount,
          description,
          checkoutUrl: result.data.checkoutUrl,
          qrCode: result.data.qrCode,
          paymentLinkId: result.data.paymentLinkId,
          status: 'PENDING',
        },
      };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`PayOS request failed: ${err.message}`);
      await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
      throw new InternalServerErrorException('L?i k?t n?i t?i c?ng thanh to�n PayOS');
    }
  }

  async handlePayosWebhook(body: PayosWebhookDto) {
    if (body?.success !== true) {
      this.logger.warn(`[PayOS Webhook] Rejected: body.success must be true, received: ${body?.success}`);
      return { success: false, message: 'Invalid webhook: success must be true' };
    }

    const { code, data, signature } = body || {};
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim() || '';

    if (!verifyWebhookSignature(data, signature, checksumKey)) {
      this.logger.warn(`[PayOS Webhook] Invalid signature for orderCode: ${data?.orderCode}`);
      return { success: false, message: 'Invalid signature' };
    }

    const orderCodeStr = data?.orderCode?.toString();
    const transaction = await this.paymentsRepo.findTransactionByCode(orderCodeStr);

    if (!transaction) {
      this.logger.warn(`[PayOS Webhook] Transaction not found for orderCode: ${orderCodeStr}`);
      return { success: false, message: 'Transaction not found' };
    }

    // N?u d� ho�n th�nh tru?c d�, tr? v? idempotency OK (Section 13)
    if (transaction.status === 'PAID') {
      return { success: true, message: 'Already processed' };
    }

    if (code === '00' && data?.code === '00') {
      // MANDATORY PAYOS PAYLOAD FIELD ENFORCEMENT
      if (!data?.orderCode) {
        this.logger.warn('[PayOS Webhook] Missing mandatory field orderCode');
        return { success: false, message: 'Missing orderCode' };
      }

      if (data.amount === undefined || data.amount === null || isNaN(Number(data.amount))) {
        this.logger.warn('[PayOS Webhook] Missing or invalid mandatory field amount');
        return { success: false, message: 'Missing amount' };
      }

      if (!data.currency) {
        this.logger.warn('[PayOS Webhook] Missing mandatory field currency');
        return { success: false, message: 'Missing currency' };
      }

      if (!data.paymentLinkId) {
        this.logger.warn('[PayOS Webhook] Missing mandatory field paymentLinkId');
        return { success: false, message: 'Missing paymentLinkId' };
      }

      // Validate currency: Must be VND
      if (data.currency.toUpperCase() !== 'VND') {
        this.logger.warn(`[PayOS Webhook] Invalid currency: ${data.currency} for orderCode: ${orderCodeStr}`);
        return { success: false, message: 'Invalid currency' };
      }

      // Validate amount: Webhook amount must strictly equal transaction amount
      if (Number(data.amount) !== Number(transaction.amount)) {
        this.logger.warn(`[PayOS Webhook] Amount mismatch: webhook amount=${data.amount}, tx amount=${transaction.amount} for orderCode: ${orderCodeStr}`);
        return { success: false, message: 'Amount mismatch' };
      }

      // Validate paymentLinkId: FAIL-CLOSED strict equality
      const recordedLinkId = (transaction as any).paymentLinkId;
      if (!recordedLinkId || recordedLinkId !== data.paymentLinkId) {
        this.logger.warn(`[PayOS Webhook] Payment link ID mismatch for orderCode ${orderCodeStr}: recorded="${recordedLinkId}", received="${data.paymentLinkId}"`);
        return { success: false, message: 'Payment link ID mismatch' };
      }

      // Atomic update transaction to PAID and order to CONFIRMED (Escrow hold - no wallet credit yet)
      await this.paymentsRepo.confirmPaymentAtomicTx(
        transaction.paymentTransactionId,
      );
      this.logger.log(`[PayOS Webhook] Payment confirmed and marked as PAID (Escrow hold) for Order #${transaction.orderId} (Transaction #${transaction.paymentTransactionId})`);

      if (transaction.order) {
        const storeId = transaction.order.storeId ? transaction.order.storeId.toString() : '';
        const orderId = transaction.orderId ? transaction.orderId.toString() : '';
        const eventPayload = {
          orderId,
          orderCode: orderCodeStr,
          amount: Number(transaction.amount),
          paymentTransactionId: transaction.paymentTransactionId.toString(),
        };

        if (this.eventsGateway) {
          this.eventsGateway.emitToStore(storeId, 'ORDER_PAYMENT_CONFIRMED', eventPayload);
          const assignedDriverId = (transaction.order as any)?.assignedDriverId;
          if (assignedDriverId) {
            this.eventsGateway.emitToDriver(
              assignedDriverId.toString(),
              'ORDER_PAYMENT_CONFIRMED',
              eventPayload,
            );
          }
        }

        // Post-commit: send FCM push notification to customer & emit customer websocket
        const fullOrder = await this.paymentsRepo.findOrderById(transaction.orderId);
        if (fullOrder && fullOrder.customer) {
          const customerUserId = fullOrder.customer.userId;
          const customerId = fullOrder.customer.customerId?.toString();

          if (this.eventsGateway && customerId) {
            this.eventsGateway.emitToCustomer(customerId, 'ORDER_PAYMENT_CONFIRMED', eventPayload);
          }

          if (this.notificationsService && customerUserId) {
            const notifTitle = 'Thanh toán đơn hàng thành công';
            const notifBody = `Đơn hàng #${orderCodeStr} đã thanh toán thành công qua PayOS với số tiền ${Number(transaction.amount).toLocaleString('vi-VN')} VND.`;
            this.notificationsService
              .sendPushToUser(customerUserId, {
                title: notifTitle,
                body: notifBody,
                data: {
                  orderId,
                  orderCode: orderCodeStr,
                  type: 'PAYMENT_SUCCESS',
                },
              })
              .catch((err) => {
                this.logger.error(`[PayOS Webhook] Failed to dispatch FCM push: ${err.message}`);
              });
          }
        }
      }
      return { success: true, message: 'Payment confirmed successfully' };
    } else {
      await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
      this.logger.log(`[PayOS Webhook] Payment failed for Order #${transaction.orderId}`);
      return { success: true, message: 'Payment failed recorded' };
    }
  }

  /**
   * Đổi phương thức thanh toán cho đơn hàng
   * - BOLA: Kiểm tra order thuộc quyền sở hữu của user
   * - Chỉ cho đổi khi order còn PENDING và paymentStatus UNPAID
   * - Hủy các transaction PENDING cũ và hủy link PayOS tương ứng nếu có
   */
  async changeOrderPaymentMethod(orderIdParam: string, dto: ChangePaymentMethodDto, user: any) {
    if (!orderIdParam || !/^\d+$/.test(orderIdParam)) {
      throw new BadRequestException('Mã đơn hàng không hợp lệ');
    }
    const orderId = BigInt(orderIdParam);

    const existingOrder = await this.paymentsRepo.findOrderById(orderId);
    if (!existingOrder) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    // Ownership check (Anti-BOLA/IDOR)
    const isSuperAdmin = user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN' || user.role === 'ADMIN';
    const customerUserId = existingOrder.customer?.userId?.toString();
    const requestUserId = (user.id || user.userId)?.toString();

    if (!isSuperAdmin && (!customerUserId || customerUserId !== requestUserId)) {
      throw new ForbiddenException('Bạn không có quyền thay đổi phương thức thanh toán của đơn hàng này');
    }

    if (existingOrder.paymentStatus === 'PAID') {
      throw new BadRequestException('Không thể đổi phương thức thanh toán cho đơn hàng đã thanh toán');
    }

    const terminalStatuses = ['CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED'];
    if (terminalStatuses.includes(existingOrder.orderStatus) || existingOrder.orderStatus !== 'PENDING') {
      throw new BadRequestException(`Không thể đổi phương thức thanh toán khi đơn hàng đang ở trạng thái ${existingOrder.orderStatus}`);
    }

    // Hủy các pending payment transaction cũ nếu có
    const pendingTransactions = await this.paymentsRepo.findTransactionsByOrderId(orderId);
    for (const tx of pendingTransactions) {
      if (tx.status === 'PENDING' && tx.paymentLinkId) {
        try {
          await this.cancelPaymentLink(tx.paymentLinkId, 'Người dùng thay đổi phương thức thanh toán');
        } catch (err: any) {
          this.logger.warn(`Failed to cancel remote PayOS link ${tx.paymentLinkId}: ${err.message}`);
        }
      }
    }

    const updated = await this.paymentsRepo.changePaymentMethodTx(orderId, dto.paymentMethod);

    return {
      success: true,
      message: 'Cập nhật phương thức thanh toán thành công',
      data: {
        orderId: updated.orderId.toString(),
        orderCode: updated.orderCode,
        paymentMethod: updated.paymentMethod,
        orderStatus: updated.orderStatus,
        paymentStatus: updated.paymentStatus,
      },
    };
  }

  async getTransaction(id: string, user?: any) {
    if (!id || !/^\d+$/.test(id)) {
      throw new NotFoundException('Không tìm thấy thông tin giao dịch');
    }
    const transaction = await this.paymentsRepo.findTransactionById(BigInt(id));
    if (!transaction) {
      throw new NotFoundException('Không tìm thấy thông tin giao dịch');
    }

    // BOLA / IDOR Protection
    if (user) {
      const isSuperAdmin = user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN';
      const isStoreStaff = user.storeId && transaction.order?.storeId && user.storeId.toString() === transaction.order.storeId.toString();
      const isCustomerOwner = user.customerProfileId && transaction.order?.customerId && user.customerProfileId.toString() === transaction.order.customerId.toString();

      if (!isSuperAdmin && !isStoreStaff && !isCustomerOwner) {
        throw new ForbiddenException('Bạn không có quyền truy cập thông tin giao dịch thanh toán này');
      }
    }

    return {
      success: true,
      data: {
        paymentTransactionId: transaction.paymentTransactionId.toString(),
        orderId: transaction.orderId.toString(),
        provider: transaction.provider,
        transactionCode: transaction.transactionCode,
        amount: Number(transaction.amount),
        paymentMethod: transaction.paymentMethod,
        status: transaction.status,
        paidAt: transaction.paidAt,
        createdAt: transaction.createdAt,
      },
    };
  }

  async getPaymentLinkInformation(orderCodeOrId: number | string) {
    const clientId = process.env.PAYOS_CLIENT_ID?.trim();
    const apiKey = process.env.PAYOS_API_KEY?.trim();
    if (!clientId || !apiKey) {
      throw new InternalServerErrorException('PAYOS_CLIENT_ID or PAYOS_API_KEY missing');
    }

    if (process.env.PAYOS_MOCK_PAYMENT === 'true' || clientId === 'mock_client_id') {
      return {
        code: '00',
        desc: 'success',
        data: {
          id: `link_${orderCodeOrId}`,
          orderCode: isNaN(Number(orderCodeOrId)) ? orderCodeOrId : Number(orderCodeOrId),
          amount: 200000,
          amountPaid: 200000,
          amountRemaining: 0,
          status: 'PAID',
          createdAt: new Date().toISOString(),
          transactions: [],
        },
      };
    }

    try {
      const response = await fetch(`https://api-merchant.payos.vn/v2/payment-requests/${orderCodeOrId}`, {
        method: 'GET',
        headers: {
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
      });
      return await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS getPaymentLinkInformation error: ${err.message}`);
      throw new InternalServerErrorException(`Không thể lấy thông tin link thanh toán: ${err.message}`);
    }
  }

  async cancelPaymentLink(orderCodeOrId: number | string, cancellationReason?: string) {
    const clientId = process.env.PAYOS_CLIENT_ID?.trim();
    const apiKey = process.env.PAYOS_API_KEY?.trim();
    if (!clientId || !apiKey) {
      throw new InternalServerErrorException('PAYOS_CLIENT_ID or PAYOS_API_KEY missing');
    }

    if (process.env.PAYOS_MOCK_PAYMENT === 'true' || clientId === 'mock_client_id') {
      return {
        code: '00',
        desc: 'success',
        data: {
          id: `link_${orderCodeOrId}`,
          orderCode: isNaN(Number(orderCodeOrId)) ? orderCodeOrId : Number(orderCodeOrId),
          status: 'CANCELLED',
          cancellationReason: cancellationReason || 'User requested cancel',
        },
      };
    }

    try {
      const response = await fetch(`https://api-merchant.payos.vn/v2/payment-requests/${orderCodeOrId}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ cancellationReason: cancellationReason || 'Cancelled by store/customer' }),
      });
      return await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS cancelPaymentLink error: ${err.message}`);
      throw new InternalServerErrorException(`Không thể hủy link thanh toán: ${err.message}`);
    }
  }
}
