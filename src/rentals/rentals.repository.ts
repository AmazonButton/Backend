import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
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
    return this.prisma.buttonRental.create({
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
}
