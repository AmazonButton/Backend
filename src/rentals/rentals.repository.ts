import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findRentalById(rentalId: bigint) {
    return this.prisma.buttonRental.findUnique({
      where: { rentalId },
      include: { package: true },
    });
  }

  async updateRentalStatus(rentalId: bigint, status: string) {
    return this.prisma.buttonRental.update({
      where: { rentalId },
      data: { status },
    });
  }
}
