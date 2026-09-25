import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DevicesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async count(whereClause?: any): Promise<number> {
    return this.prisma.ioTButton.count({ where: whereClause });
  }

  async findMany(whereClause: any) {
    return this.prisma.ioTButton.findMany({
      where: whereClause,
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(buttonId: bigint) {
    return this.prisma.ioTButton.findUnique({
      where: { buttonId },
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
      },
    });
  }

  async findByDeviceId(deviceId: string) {
    return this.prisma.ioTButton.findUnique({
      where: { deviceId },
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
      },
    });
  }

  async findByIdentifier(identifier: string) {
    const isNum = !isNaN(Number(identifier));
    return this.prisma.ioTButton.findFirst({
      where: {
        OR: [
          { deviceId: identifier },
          { buttonCode: identifier },
          ...(isNum ? [{ buttonId: BigInt(identifier) }] : []),
        ],
      },
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
      },
    });
  }

  async create(data: any) {
    return this.prisma.ioTButton.create({
      data,
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
      },
    });
  }

  async update(buttonId: bigint, data: any) {
    return this.prisma.ioTButton.update({
      where: { buttonId },
      data,
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
      },
    });
  }

  async delete(buttonId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      await tx.buttonProduct.deleteMany({ where: { buttonId } });
      return tx.ioTButton.delete({ where: { buttonId } });
    });
  }

  async setButtonProducts(buttonId: bigint, products: { productId: bigint; quantity: number }[]) {
    return this.prisma.$transaction(async (tx) => {
      await tx.buttonProduct.deleteMany({ where: { buttonId } });
      if (products.length > 0) {
        await tx.buttonProduct.createMany({
          data: products.map((p) => ({
            buttonId,
            productId: p.productId,
            quantity: p.quantity,
          })),
        });
      }
      return tx.ioTButton.findUnique({
        where: { buttonId },
        include: {
          store: true,
          customer: { include: { user: true } },
          buttonProducts: { include: { product: true } },
        },
      });
    });
  }

  async findFirstActiveStore() {
    return this.prisma.store.findFirst({ where: { status: 'ACTIVE' } });
  }

  async findFirstCustomer() {
    return this.prisma.customerProfile.findFirst();
  }

  async findFirstCustomerAddress(customerId: bigint) {
    return this.prisma.customerAddress.findFirst({ where: { customerId } });
  }

  async createDefaultCustomerAddress(data: {
    customerId: bigint;
    recipientName: string;
    phone: string;
    addressDetail: string;
    isDefault: boolean;
  }) {
    return this.prisma.customerAddress.create({ data });
  }

  async linkStoreCustomer(storeId: bigint, customerId: bigint) {
    return this.prisma.storeCustomer.upsert({
      where: {
        uq_store_customer: {
          storeId,
          customerId,
        },
      },
      update: {},
      create: {
        storeId,
        customerId,
      },
    });
  }

  // --- Device Templates Repository Methods ---
  async createTemplate(data: any) {
    return this.prisma.deviceTemplate.create({ data });
  }

  async findTemplates(whereClause: any) {
    return this.prisma.deviceTemplate.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findTemplateById(templateId: bigint) {
    return this.prisma.deviceTemplate.findUnique({
      where: { templateId },
    });
  }

  async findTemplateByCode(code: string) {
    return this.prisma.deviceTemplate.findUnique({
      where: { code },
    });
  }

  async findTemplateByIdOrCode(idOrCode: string) {
    const isNum = !isNaN(Number(idOrCode));
    return this.prisma.deviceTemplate.findFirst({
      where: {
        OR: [
          { code: idOrCode },
          ...(isNum ? [{ templateId: BigInt(idOrCode) }] : []),
        ],
      },
    });
  }

  async updateTemplate(templateId: bigint, data: any) {
    return this.prisma.deviceTemplate.update({
      where: { templateId },
      data,
    });
  }

  async deleteTemplate(templateId: bigint) {
    return this.prisma.deviceTemplate.delete({
      where: { templateId },
    });
  }
}
