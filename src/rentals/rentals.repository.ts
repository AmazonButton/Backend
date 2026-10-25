import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

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
    return this.prisma.buttonRental.create({
      data,
      include: {
        package: true,
      },
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

  async extendRental(
    rentalId: bigint,
    newEndDate: Date,
    additionalMonths: number,
    additionalAmount: number,
  ) {
    const current = await this.prisma.buttonRental.findUnique({
      where: { rentalId },
    });
    if (!current) throw new Error('Hợp đồng thuê không tồn tại');

    return this.prisma.buttonRental.update({
      where: { rentalId },
      data: {
        endDate: newEndDate,
        monthsRented: current.monthsRented + additionalMonths,
        totalRentAmount: new Decimal(Number(current.totalRentAmount) + additionalAmount),
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
}
