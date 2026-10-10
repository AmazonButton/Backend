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
}
