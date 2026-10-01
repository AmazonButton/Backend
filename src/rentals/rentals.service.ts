import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRentalOrderDto } from './dto/rentals.dto';

@Injectable()
export class RentalsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listAvailablePackages() {
    return this.prisma.rentalPackage.findMany({
      where: { isActive: true },
      orderBy: { monthlyPrice: 'asc' },
    });
  }

  async createRentalContract(customerId: string | number | bigint, dto: CreateRentalOrderDto) {
    const rawCustomerId = BigInt(customerId);
    const rawPackageId = BigInt(dto.packageId);

    const pkg = await this.prisma.rentalPackage.findUnique({
      where: { packageId: rawPackageId },
    });
    if (!pkg || !pkg.isActive) {
      throw new NotFoundException('Gói thuê nút không tồn tại hoặc đã tạm dừng cung cấp');
    }

    const months = Number(dto.monthsRented) || 1;
    const monthlyPrice = Number(pkg.monthlyPrice);
    const depositFee = Number(pkg.depositFee || 0);
    const totalRentAmount = monthlyPrice * months;

    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + months * 30 * 24 * 60 * 60 * 1000);
    const rentalCode = `RNT-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    return this.prisma.buttonRental.create({
      data: {
        rentalCode,
        customerId: rawCustomerId,
        packageId: rawPackageId,
        monthsRented: months,
        totalRentAmount,
        depositAmount: depositFee,
        startDate,
        endDate,
        status: 'PENDING_PAYMENT',
      },
      include: {
        package: true,
      },
    });
  }

  async listCustomerRentals(customerId: string | number | bigint) {
    const rawCustomerId = BigInt(customerId);
    return this.prisma.buttonRental.findMany({
      where: { customerId: rawCustomerId },
      include: {
        package: true,
        buttons: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async activateRental(rentalId: string | number | bigint) {
    const rawRentalId = BigInt(rentalId);
    const rental = await this.prisma.buttonRental.findUnique({ where: { rentalId: rawRentalId } });
    if (!rental) throw new NotFoundException('Không tìm thấy hợp đồng thuê');

    return this.prisma.buttonRental.update({
      where: { rentalId: rawRentalId },
      data: { status: 'ACTIVE' },
    });
  }
}
