import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { RentalsRepository } from './rentals.repository';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRentalOrderDto } from './dto/rentals.dto';

@Injectable()
export class RentalsService {
  private readonly rentalsRepo: RentalsRepository;

  constructor(@Inject(RentalsRepository) repoOrPrisma: RentalsRepository | PrismaService) {
    if (repoOrPrisma && 'listAvailablePackages' in repoOrPrisma) {
      this.rentalsRepo = repoOrPrisma as RentalsRepository;
    } else {
      this.rentalsRepo = new RentalsRepository(repoOrPrisma as PrismaService);
    }
  }

  async listAvailablePackages() {
    return this.rentalsRepo.listAvailablePackages();
  }

  async createRentalContract(customerId: string | number | bigint, dto: CreateRentalOrderDto) {
    const rawCustomerId = BigInt(customerId);
    const rawPackageId = BigInt(dto.packageId);

    const pkg = await this.rentalsRepo.findPackageById(rawPackageId);
    if (!pkg || !pkg.isActive) {
      throw new NotFoundException('Gói thuê nút không tồn tại hoặc đã tạm dừng cung cấp');
    }

    const months = Number(dto.monthsRented) || 1;
    const monthlyPrice = Number(pkg.monthlyPrice);
    const depositFee = Number(pkg.depositFee || 0);
    const totalRentAmount = monthlyPrice * months + depositFee;

    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + months * 30 * 24 * 60 * 60 * 1000);
    const rentalCode = `RNT-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    return this.rentalsRepo.createRental({
      rentalCode,
      customerId: rawCustomerId,
      packageId: rawPackageId,
      monthsRented: months,
      totalRentAmount,
      depositAmount: depositFee,
      startDate,
      endDate,
      status: 'PENDING_PAYMENT',
    });
  }

  async listCustomerRentals(customerId: string | number | bigint) {
    const rawCustomerId = BigInt(customerId);
    return this.rentalsRepo.listCustomerRentals(rawCustomerId);
  }

  async activateRental(rentalId: string | number | bigint) {
    const rawRentalId = BigInt(rentalId);
    const rental = await this.rentalsRepo.findRentalById(rawRentalId);
    if (!rental) throw new NotFoundException('Không tìm thấy hợp đồng thuê');

    if (rental.status !== 'PAID' && rental.status !== 'ACTIVE') {
      throw new BadRequestException('Hợp đồng thuê chưa hoàn tất thanh toán (PENDING_PAYMENT), không thể kích hoạt');
    }

    return this.rentalsRepo.updateRentalStatus(rawRentalId, 'ACTIVE');
  }
}
