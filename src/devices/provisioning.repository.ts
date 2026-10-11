import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProvisioningRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
         AND expires_at > NOW()
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
       ON CONFLICT (device_id, nonce) DO NOTHING
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
       WHERE session_id = $1 AND expires_at > NOW() AND status = 'ACTIVE';`,
      sessionId
    );
    return rows && rows.length > 0 ? rows[0] : null;
  }

  async lockAndConsumeProvisioningSession(sessionId: string, claimedBy?: bigint): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      const rows: any[] = await tx.$queryRawUnsafe(
        `SELECT * FROM provisioning_sessions
         WHERE session_id = $1 AND expires_at > NOW() AND status = 'ACTIVE'
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

}
