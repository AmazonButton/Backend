import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProvisioningRepository {
  constructor(@Inject(PrismaService) public readonly prisma: PrismaService) {}

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
    },
  ): Promise<any> {
    return this.prisma.$transaction(async (tx: any) => {
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

      const targetStoreId = device.store_id;

      // 3. Verify product belongs to device store
      const rawProductId = BigInt(dto.productId);
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

      // 4. Update device owner and status
      const buttonName = dto.buttonName?.trim() || device.button_name;
      await tx.$executeRawUnsafe(
        `UPDATE iot_button
         SET customer_id = $1,
             button_name = $2,
             status = 'ACTIVE',
             installed_at = NOW(),
             updated_at = NOW()
         WHERE button_id = $3;`,
        customerId,
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
    });
  }

  async unclaimDeviceAtomicTx(buttonId: bigint): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
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
    });
  }

  async factoryResetAtomicTx(buttonId: bigint): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
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
    });
  }
}
