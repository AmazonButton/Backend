import { Injectable, Inject, ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  POSTGRES_BIGINT_MAX,
  parsePositivePostgresBigInt,
} from '../common/utils/validation.util';
import { runWithTransactionRetry } from '../common/utils/transaction-retry.util';

@Injectable()
export class ProvisioningRepository {
  constructor(@Inject(PrismaService) public readonly prisma: PrismaService) { }

  async findButtonByIdentifier(identifier: string) {
    const trimmed = identifier.trim().toUpperCase();
    return this.prisma.ioTButton.findFirst({
      where: {
        OR: [{ deviceId: trimmed }, { buttonCode: trimmed }],
      },
      include: {
        store: true,
        buttonProducts: { include: { product: true } },
      },
    });
  }

  async findButtonById(buttonId: bigint) {
    return this.prisma.ioTButton.findUnique({
      where: { buttonId },
      include: {
        store: true,
        buttonProducts: { include: { product: true } },
      },
    });
  }

  async updateButton(buttonId: bigint, data: any) {
    return this.prisma.ioTButton.update({
      where: { buttonId },
      data,
    });
  }

  async upsertStoreCustomer(storeId: bigint, customerId: bigint) {
    return this.prisma.storeCustomer.upsert({
      where: {
        uq_store_customer: {
          storeId,
          customerId,
        },
      },
      update: { status: 'ACTIVE' },
      create: {
        storeId,
        customerId,
        status: 'ACTIVE',
      },
    });
  }

  async upsertButtonProduct(buttonId: bigint, productId: bigint, quantity: number = 1) {
    return this.prisma.buttonProduct.upsert({
      where: {
        uq_button_product: {
          buttonId,
          productId,
        },
      },
      update: { quantity },
      create: {
        buttonId,
        productId,
        quantity,
      },
    });
  }

  async savePairingToken(deviceId: string, tokenHash: string, expiresAt: Date) {
    return this.prisma.pairingToken.create({
      data: {
        deviceId: deviceId.toUpperCase(),
        tokenHash,
        expiresAt,
        status: 'ACTIVE',
      },
    });
  }

  async findActivePairingToken(deviceId: string, tokenHash: string) {
    return this.prisma.pairingToken.findFirst({
      where: {
        deviceId: deviceId.toUpperCase(),
        tokenHash,
        status: 'ACTIVE',
        expiresAt: { gt: new Date() },
      },
    });
  }

  async consumeActivePairingToken(deviceId: string, tokenHash: string): Promise<any> {
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `UPDATE public.pairing_tokens
       SET status = 'USED'
       WHERE token_hash = $1
         AND device_id = $2
         AND status = 'ACTIVE'
         AND expires_at > CURRENT_TIMESTAMP
       RETURNING id, device_id, token_hash, status, expires_at;`,
      tokenHash,
      deviceId.toUpperCase()
    );
    return rows && rows.length > 0 ? rows[0] : null;
  }

  async markPairingTokenUsed(tokenHash: string) {
    return this.prisma.pairingToken.updateMany({
      where: { tokenHash },
      data: { status: 'USED' },
    });
  }

  async consumeDeviceNonce(deviceId: string, nonce: string): Promise<boolean> {
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `INSERT INTO device_nonces (device_id, nonce, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes')
       ON CONFLICT (device_id, nonce)
       DO UPDATE SET
         expires_at = EXCLUDED.expires_at,
         created_at = NOW()
       WHERE device_nonces.expires_at <= NOW()
       RETURNING nonce;`,
      deviceId,
      nonce
    );
    return rows && rows.length > 0;
  }

  async createProvisioningSession(
    sessionId: string,
    sessionHash: string,
    deviceId: bigint,
    sessionData: any,
    tokenHash: string | null,
    expiresAt: Date,
  ) {
    return this.prisma.$executeRawUnsafe(
      `INSERT INTO provisioning_sessions (session_id, session_hash, device_id, session_data, token_hash, status, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'ACTIVE', $6)
       ON CONFLICT (session_id) DO UPDATE
       SET session_data = EXCLUDED.session_data, expires_at = EXCLUDED.expires_at, status = 'ACTIVE';`,
      sessionId,
      sessionHash,
      deviceId,
      JSON.stringify(sessionData),
      tokenHash,
      expiresAt
    );
  }

  async findProvisioningSession(sessionId: string): Promise<any> {
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT * FROM provisioning_sessions
       WHERE session_id = $1 AND expires_at > CURRENT_TIMESTAMP AND status = 'ACTIVE';`,
      sessionId
    );
    return rows && rows.length > 0 ? rows[0] : null;
  }

  async lockAndConsumeProvisioningSession(sessionId: string, claimedBy?: bigint): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      const rows: any[] = await tx.$queryRawUnsafe(
        `SELECT * FROM provisioning_sessions
         WHERE session_id = $1 AND expires_at > CURRENT_TIMESTAMP AND status = 'ACTIVE'
         FOR UPDATE;`,
        sessionId
      );
      if (!rows || rows.length === 0) return null;
      await tx.$executeRawUnsafe(
        `UPDATE provisioning_sessions
         SET status = 'CLAIMED', claimed_by = $2, updated_at = NOW()
         WHERE session_id = $1;`,
        sessionId,
        claimedBy || null
      );
      return rows[0];
    });
  }

  async deleteProvisioningSession(sessionId: string) {
    return this.prisma.$executeRawUnsafe(
      `DELETE FROM provisioning_sessions WHERE session_id = $1;`,
      sessionId
    );
  }

  async createSessionAtomicTx(
    deviceId: string,
    tokenHash: string,
    sessionId: string,
    sessionHash: string,
    devicePk: bigint,
    sessionData: any,
    expiresAt: Date,
  ): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      const tokenRows: any[] = await tx.$queryRawUnsafe(
        `UPDATE public.pairing_tokens
         SET status = 'USED'
         WHERE token_hash = $1
           AND device_id = $2
           AND status = 'ACTIVE'
           AND expires_at > CURRENT_TIMESTAMP
         RETURNING id, device_id, token_hash, status, expires_at;`,
        tokenHash,
        deviceId.toUpperCase(),
      );
      if (!tokenRows || tokenRows.length === 0) {
        throw new Error('Mã ghép nối (pairing token) không hợp lệ hoặc đã được sử dụng');
      }

      await tx.$executeRawUnsafe(
        `INSERT INTO provisioning_sessions (session_id, session_hash, device_id, session_data, token_hash, status, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, 'ACTIVE', $6)
         ON CONFLICT (session_id) DO UPDATE
         SET session_data = EXCLUDED.session_data, expires_at = EXCLUDED.expires_at, status = 'ACTIVE';`,
        sessionId,
        sessionHash,
        devicePk,
        JSON.stringify(sessionData),
        tokenHash,
        expiresAt,
      );

      return tokenRows[0];
    });
  }

  async confirmPairingAtomicTx(
    sessionId: string,
    customerId: bigint,
    dto: {
      deviceId?: string;
      buttonName?: string;
      productId: string | number | bigint;
      addressId?: string | number | bigint;
    },
  ): Promise<any> {
    return runWithTransactionRetry(
      () => this.prisma.$transaction(async (tx: any) => {
      // 1. Lock session row
      const sessionRows: any[] = await tx.$queryRawUnsafe(
        `SELECT * FROM provisioning_sessions
         WHERE session_id = $1
         FOR UPDATE;`,
        sessionId,
      );

      if (!sessionRows || sessionRows.length === 0) {
        throw new Error('NOT_FOUND: Phiên ghép nối không tồn tại');
      }

      const session = sessionRows[0];
      if (session.status !== 'ACTIVE') {
        throw new Error('BAD_REQUEST: Phiên ghép nối đã được sử dụng hoặc bị vô hiệu hóa');
      }
      if (new Date(session.expires_at) < new Date()) {
        throw new Error('BAD_REQUEST: Phiên ghép nối đã hết hạn');
      }
      if (session.claimed_by && session.claimed_by.toString() !== customerId.toString()) {
        throw new Error('CONFLICT: Phiên ghép nối đã được gán cho một tài khoản khác');
      }

      // 2. Lock device row using session.device_id (which is button_id)
      const sessionButtonId = BigInt(session.device_id);
      const deviceRows: any[] = await tx.$queryRawUnsafe(
        `SELECT * FROM iot_button
         WHERE button_id = $1
         FOR UPDATE;`,
        sessionButtonId,
      );

      if (!deviceRows || deviceRows.length === 0) {
        throw new Error('NOT_FOUND: Thiết bị liên kết với phiên ghép nối không tồn tại');
      }

      const device = deviceRows[0];

      // CRITICAL SECURITY ENFORCEMENT:
      // If dto.deviceId is provided, assert it strictly matches the session device!
      if (dto.deviceId && dto.deviceId.trim().toUpperCase() !== device.device_id.trim().toUpperCase()) {
        throw new Error('BAD_REQUEST: Mã thiết bị không khớp với phiên ghép nối');
      }

      // #1 Enforcement: Check locked/return/warranty/ownership/rental/deposit under lock before rebinding
      await this.assertDeviceEligibleForCustodyMutationInTx(tx, device, {
        mode: 'PAIR_CONFIRM',
        targetCustomerId: customerId,
      });

      const targetStoreId = device.store_id;

      // 3. Verify product belongs to device store
      const rawProductId = parsePositivePostgresBigInt(dto.productId);
      if (rawProductId === null) {
        throw new Error(
          `BAD_REQUEST: Mã sản phẩm (productId) không hợp lệ (chỉ chấp nhận 1..${POSTGRES_BIGINT_MAX.toString()})`,
        );
      }
      const productRows: any[] = await tx.$queryRawUnsafe(
        `SELECT * FROM product
         WHERE product_id = $1 AND store_id = $2;`,
        rawProductId,
        targetStoreId,
      );

      if (!productRows || productRows.length === 0) {
        throw new Error(
          `BAD_REQUEST: Sản phẩm #${dto.productId} không tồn tại hoặc không thuộc cửa hàng sở hữu thiết bị`,
        );
      }

      // 4. Resolve customer address to satisfy composite foreign key (customer_id, address_id)
      let resolvedAddressId: bigint | null = null;
      if (dto.addressId) {
        const addrRows: any[] = await tx.$queryRawUnsafe(
          `SELECT address_id FROM customer_address WHERE address_id = $1 AND customer_id = $2;`,
          BigInt(dto.addressId),
          customerId,
        );
        if (addrRows && addrRows.length > 0) {
          resolvedAddressId = addrRows[0].address_id;
        }
      }

      if (!resolvedAddressId) {
        const defaultAddrRows: any[] = await tx.$queryRawUnsafe(
          `SELECT address_id FROM customer_address WHERE customer_id = $1 ORDER BY is_default DESC, address_id ASC LIMIT 1;`,
          customerId,
        );
        if (defaultAddrRows && defaultAddrRows.length > 0) {
          resolvedAddressId = defaultAddrRows[0].address_id;
        }
      }

      // Update device owner, address, and status (Keep flashed hardware hmacSecret intact so ESP32 firmware can sign events)
      const buttonName = dto.buttonName?.trim() || device.button_name;
      await tx.$executeRawUnsafe(
        `UPDATE iot_button
         SET customer_id = $1,
             address_id = $2,
             button_name = $3,
             status = 'ACTIVE',
             inventory_state = 'IN_CUSTOMER_CUSTODY',
             can_order = true,
             custody_store_id = NULL,
             installed_at = NOW(),
             updated_at = NOW()
         WHERE button_id = $4;`,
        customerId,
        resolvedAddressId,
        buttonName,
        device.button_id,
      );

      // 5. Upsert store_customer
      await tx.$executeRawUnsafe(
        `INSERT INTO store_customer (store_id, customer_id, status, joined_at)
         VALUES ($1, $2, 'ACTIVE', NOW())
         ON CONFLICT (store_id, customer_id)
         DO UPDATE SET status = 'ACTIVE', updated_at = NOW();`,
        targetStoreId,
        customerId,
      );

      // 6. Upsert button_product
      await tx.$executeRawUnsafe(
        `INSERT INTO button_product (button_id, product_id, quantity, created_at, updated_at)
         VALUES ($1, $2, 1, NOW(), NOW())
         ON CONFLICT (button_id, product_id)
         DO UPDATE SET quantity = 1, updated_at = NOW();`,
        device.button_id,
        rawProductId,
      );

      // 7. Mark session CLAIMED
      await tx.$executeRawUnsafe(
        `UPDATE provisioning_sessions
         SET status = 'CLAIMED',
             claimed_by = $1,
             updated_at = NOW()
         WHERE session_id = $2;`,
        customerId,
        sessionId,
      );

      return {
        deviceId: device.device_id,
        buttonId: device.button_id.toString(),
        buttonName,
        status: 'ACTIVE',
        customerId: customerId.toString(),
        storeId: targetStoreId.toString(),
        productId: rawProductId.toString(),
      };
    }),
      { operationName: 'ConfirmPairingAtomicTx' },
    );
  }

  private static readonly TERMINAL_RENTAL_STATUSES = ['COMPLETED', 'TERMINATED', 'CANCELLED'];
  private static readonly BLOCKED_DEVICE_STATUSES = ['LOCKED', 'DISABLED', 'MAINTENANCE', 'RETIRED', 'LOST', 'DAMAGED', 'SUSPENDED'];
  private static readonly BLOCKED_INVENTORY_STATES = ['LOCKED', 'RETURN_IN_TRANSIT', 'DEFECTIVE_RETURN', 'WRITTEN_OFF', 'MAINTENANCE'];
  private static readonly ALLOWED_PAIRING_INVENTORY_STATES = ['IN_PLATFORM_WAREHOUSE', 'ALLOCATED_TO_STORE', 'IN_CUSTOMER_CUSTODY'];

  private async hasOpenRentalOrUnsettledDepositInTx(tx: any, rentalId: bigint | null | undefined) {
    if (rentalId == null) return { hasObligation: false, rental: null as any };

    const rentals: any[] = await tx.$queryRawUnsafe(
      `SELECT * FROM button_rentals WHERE rental_id = $1 FOR UPDATE;`,
      BigInt(rentalId),
    );
    const rental = rentals?.[0] ?? null;
    if (!rental) return { hasObligation: false, rental: null as any };

    const deposits: any[] = await tx.$queryRawUnsafe(
      `SELECT held_amount, refund_reserved_amount FROM rental_deposits WHERE rental_id = $1 FOR UPDATE;`,
      BigInt(rentalId),
    );
    const deposit = deposits?.[0] ?? null;
    const heldAmount = deposit ? Number(deposit.held_amount || 0) : 0;
    const refundReservedAmount = deposit ? Number(deposit.refund_reserved_amount || 0) : 0;

    const pendingRefundRows: any[] = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS cnt FROM deposit_refunds WHERE rental_id = $1 AND status IN ('PENDING_APPROVAL', 'PENDING_PAYOUT', 'PROCESSING');`,
      BigInt(rentalId),
    );
    const pendingRefunds = Number(pendingRefundRows?.[0]?.cnt || 0);

    const isNonTerminalRental = !ProvisioningRepository.TERMINAL_RENTAL_STATUSES.includes(String(rental.status || '').toUpperCase());
    const hasUnsettledDeposit = heldAmount > 0 || refundReservedAmount > 0 || pendingRefunds > 0;

    return {
      hasObligation: isNonTerminalRental || hasUnsettledDeposit,
      isNonTerminalRental,
      hasUnsettledDeposit,
      rental,
    };
  }

  private async assertDeviceEligibleForCustodyMutationInTx(
    tx: any,
    device: any,
    options: { mode: 'PAIR_CONFIRM' | 'TRANSFER' | 'UNCLAIM' | 'FACTORY_RESET'; targetCustomerId?: bigint },
  ) {
    const deviceStatus = String(device.status || '').toUpperCase();
    const inventoryState = String(device.inventory_state || '').toUpperCase();

    if (deviceStatus === 'LOCKED' || inventoryState === 'LOCKED' || deviceStatus === 'DISABLED') {
      throw new ConflictException('Thiết bị đang bị khóa hoặc vô hiệu hóa, không thể thực hiện thao tác ghép nối hoặc chuyển chủ');
    }
    if (inventoryState === 'RETURN_IN_TRANSIT') {
      throw new ConflictException('Thiết bị đang trong quá trình hoàn trả (RETURN_IN_TRANSIT), không thể ghép nối hoặc chuyển chủ');
    }
    if (inventoryState === 'DEFECTIVE_RETURN') {
      throw new ConflictException('Thiết bị đang thuộc diện thu hồi lỗi/bảo hành (DEFECTIVE_RETURN), không thể ghép nối hoặc chuyển chủ');
    }
    if (ProvisioningRepository.BLOCKED_DEVICE_STATUSES.includes(deviceStatus) ||
      ProvisioningRepository.BLOCKED_INVENTORY_STATES.includes(inventoryState)) {
      throw new ConflictException(`Trạng thái thiết bị (${deviceStatus}/${inventoryState}) hiện không cho phép thay đổi quyền sở hữu`);
    }
    if (options.mode === 'PAIR_CONFIRM' && inventoryState && !ProvisioningRepository.ALLOWED_PAIRING_INVENTORY_STATES.includes(inventoryState)) {
      throw new ConflictException(`Trạng thái kho thiết bị (${inventoryState}) không hợp lệ để ghép nối`);
    }

    // Check active return obligations only:
    // - PENDING_RECEIPT always blocks regardless of rental_id.
    // - Historical RECEIVED returns (kept after confirmReturnReceiptTX resets button to warehouse & clears rental_id)
    //   must NOT block clean re-allocated devices unless still bound to device.rental_id.
    const pendingReturnRows: any[] = await tx.$queryRawUnsafe(
      `SELECT return_id, status FROM rental_returns
       WHERE button_id = $1 AND status = 'PENDING_RECEIPT'
       ORDER BY return_id ASC
       LIMIT 1 FOR UPDATE;`,
      device.button_id,
    );
    if (pendingReturnRows && pendingReturnRows.length > 0) {
      throw new ConflictException(`Thiết bị đang có yêu cầu hoàn trả (${pendingReturnRows[0].status}) chưa hoàn tất, không thể ghép nối hoặc chuyển chủ`);
    }
    if (device.rental_id != null) {
      const boundReturnRows: any[] = await tx.$queryRawUnsafe(
        `SELECT return_id, status FROM rental_returns
         WHERE button_id = $1 AND rental_id = $2 AND status = 'RECEIVED'
         ORDER BY return_id ASC
         LIMIT 1 FOR UPDATE;`,
        device.button_id,
        BigInt(device.rental_id),
      );
      if (boundReturnRows && boundReturnRows.length > 0) {
        throw new ConflictException(`Thiết bị đang gắn với giao dịch hoàn trả (${boundReturnRows[0].status}) của hợp đồng thuê hiện tại`);
      }
    }

    // Lock order unified with WarrantyRepository: iot_button -> warranty_tickets (ORDER BY ticket_id ASC)
    const openWarrantyRows: any[] = await tx.$queryRawUnsafe(
      `SELECT ticket_id, ticket_code, status FROM warranty_tickets
       WHERE button_id = $1 AND status IN ('PENDING', 'PENDING_APPROVAL', 'IN_PROGRESS', 'APPROVED_SWAP')
       ORDER BY ticket_id ASC
       LIMIT 1 FOR UPDATE;`,
      device.button_id,
    );
    if (openWarrantyRows && openWarrantyRows.length > 0) {
      throw new ConflictException(`Thiết bị đang trong quá trình xử lý bảo hành (${openWarrantyRows[0].ticket_code || openWarrantyRows[0].status}), không thể ghép nối hoặc chuyển chủ`);
    }

    const rentalState = await this.hasOpenRentalOrUnsettledDepositInTx(tx, device.rental_id);
    const existingCustomerId = device.customer_id != null ? device.customer_id.toString() : null;

    if (options.mode === 'TRANSFER' || options.mode === 'UNCLAIM' || options.mode === 'FACTORY_RESET') {
      if (rentalState.hasObligation) {
        throw new ConflictException('Thiết bị đang gắn với hợp đồng thuê hoặc nghĩa vụ tiền cọc chưa tất toán, không thể giải phóng hay chuyển chủ');
      }
      return;
    }

    // PAIR_CONFIRM branch: distinguish first-time pairing vs same-customer re-pair vs transfer
    const incomingCustomerId = options.targetCustomerId?.toString();
    if (!existingCustomerId && device.rental_id == null) {
      // Clean first-time pairing
      return;
    }

    const isSameCustomer = Boolean(existingCustomerId && incomingCustomerId && existingCustomerId === incomingCustomerId);
    if (isSameCustomer) {
      if (device.rental_id != null && rentalState.rental) {
        const rentalCustomerId = rentalState.rental.customer_id != null ? rentalState.rental.customer_id.toString() : null;
        if (rentalCustomerId !== incomingCustomerId) {
          throw new ConflictException('Hợp đồng thuê của thiết bị không thuộc về tài khoản đang ghép nối');
        }
        const expiryRaw = rentalState.rental.effective_expires_at || rentalState.rental.paid_through || rentalState.rental.end_date;
        const isExpired = expiryRaw ? new Date(expiryRaw) <= new Date() : false;
        if (String(rentalState.rental.status || '').toUpperCase() !== 'ACTIVE' || isExpired) {
          throw new ConflictException('Hợp đồng thuê thiết bị phải ở trạng thái ACTIVE và còn hiệu lực để ghép nối lại');
        }
      }
      return;
    }

    // Ownership change / overwrite attempted (existingCustomerId != incomingCustomerId or unbound device still attached to a rental)
    if (rentalState.hasObligation) {
      throw new ConflictException('Không thể ghi đè hoặc chuyển chủ thiết bị khi hợp đồng thuê hoặc nghĩa vụ cọc chưa tất toán');
    }

    if (existingCustomerId && deviceStatus !== 'TRANSFER_PENDING') {
      throw new ConflictException('Thiết bị đang thuộc quyền sở hữu của khách hàng khác và chưa được chủ sở hữu mở chuyển giao');
    }
  }

  async initiateTransferAtomicTx(
    buttonId: bigint,
    tokenHash: string,
    expiresAt: Date,
    expectedCustomerId?: bigint | null,
  ): Promise<{ deviceId: string; buttonId: string; status: string }> {
    return runWithTransactionRetry(
      () => this.prisma.$transaction(async (tx: any) => {
      const deviceRows: any[] = await tx.$queryRawUnsafe(
        `SELECT * FROM iot_button WHERE button_id = $1 FOR UPDATE;`,
        buttonId,
      );
      if (!deviceRows || deviceRows.length === 0) {
        throw new NotFoundException('Không tìm thấy thiết bị');
      }
      const device = deviceRows[0];

      if (expectedCustomerId != null && device.customer_id?.toString() !== expectedCustomerId.toString()) {
        throw new ConflictException('Chỉ chủ sở hữu hiện tại của thiết bị mới được tạo yêu cầu chuyển giao');
      }

      await this.assertDeviceEligibleForCustodyMutationInTx(tx, device, { mode: 'TRANSFER' });

      await tx.$executeRawUnsafe(
        `UPDATE iot_button
         SET status = 'TRANSFER_PENDING',
             updated_at = NOW()
         WHERE button_id = $1;`,
        buttonId,
      );

      await tx.$executeRawUnsafe(
        `UPDATE public.pairing_tokens
         SET status = 'USED'
         WHERE device_id = $1 AND status = 'ACTIVE';`,
        device.device_id.toUpperCase(),
      );

      await tx.$executeRawUnsafe(
        `INSERT INTO public.pairing_tokens (device_id, token_hash, expires_at, status)
         VALUES ($1, $2, $3, 'ACTIVE');`,
        device.device_id.toUpperCase(),
        tokenHash,
        expiresAt,
      );

      return {
        deviceId: device.device_id,
        buttonId: device.button_id.toString(),
        status: 'TRANSFER_PENDING',
      };
    }),
      { operationName: 'InitiateTransferAtomicTx' },
    );
  }

  async unclaimDeviceAtomicTx(buttonId: bigint, expectedCustomerId?: bigint | null): Promise<any> {
    return runWithTransactionRetry(
      () => this.prisma.$transaction(async (tx: any) => {
      const deviceRows: any[] = await tx.$queryRawUnsafe(
        `SELECT * FROM iot_button WHERE button_id = $1 FOR UPDATE;`,
        buttonId,
      );
      if (!deviceRows || deviceRows.length === 0) {
        throw new NotFoundException('Không tìm thấy thiết bị');
      }
      const device = deviceRows[0];

      if (expectedCustomerId != null && device.customer_id?.toString() !== expectedCustomerId.toString()) {
        throw new ConflictException('Quyền sở hữu thiết bị đã thay đổi hoặc không còn thuộc tài khoản đang yêu cầu hủy liên kết');
      }

      await this.assertDeviceEligibleForCustodyMutationInTx(tx, device, { mode: 'UNCLAIM' });

      await tx.ioTButton.update({
        where: { buttonId },
        data: {
          customerId: null,
          addressId: null,
          status: 'UNASSIGNED',
          installedAt: null,
        },
      });

      await tx.buttonProduct.deleteMany({
        where: { buttonId },
      });
    }),
      { operationName: 'UnclaimDeviceAtomicTx' },
    );
  }

  async factoryResetAtomicTx(buttonId: bigint): Promise<any> {
    return runWithTransactionRetry(
      () => this.prisma.$transaction(async (tx: any) => {
      const deviceRows: any[] = await tx.$queryRawUnsafe(
        `SELECT * FROM iot_button WHERE button_id = $1 FOR UPDATE;`,
        buttonId,
      );
      if (!deviceRows || deviceRows.length === 0) {
        throw new NotFoundException('Không tìm thấy thiết bị');
      }
      const device = deviceRows[0];

      await this.assertDeviceEligibleForCustodyMutationInTx(tx, device, { mode: 'FACTORY_RESET' });

      await tx.ioTButton.update({
        where: { buttonId },
        data: {
          customerId: null,
          addressId: null,
          status: 'INACTIVE',
          installedAt: null,
        },
      });

      await tx.buttonProduct.deleteMany({
        where: { buttonId },
      });
    }),
      { operationName: 'FactoryResetAtomicTx' },
    );
  }
}
