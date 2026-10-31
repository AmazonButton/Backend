import { Injectable, Inject, Optional, NotFoundException, BadRequestException } from '@nestjs/common';
import { CustomersRepository } from './customers.repository';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';
import { buildAnalyticsDateRange } from '../analytics/utils/analytics-date-range.util';
import { CreateCustomerBankAccountDto } from './dto/create-customer-bank-account.dto';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';

@Injectable()
export class CustomersService {
  constructor(
    @Inject(CustomersRepository)
    private readonly customersRepo: CustomersRepository,
    @Optional()
    private readonly cacheService?: DashboardCacheService,
  ) {}

  async getDashboard(user: any) {
    const userId = BigInt(user.userId || user.id);
    const cacheKey = `customer:dashboard:${userId.toString()}`;

    const fetcher = async () => this.customersRepo.getCustomerDashboard(userId);

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }

  async getOrdersAnalytics(user: any, fromDate?: string, toDate?: string) {
    const userId = BigInt(user.userId || user.id);
    const cacheKey = `customer:orders:${userId.toString()}:${fromDate || 'all'}:${toDate || 'all'}`;

    const fetcher = async () => {
      const dateRange = fromDate || toDate ? buildAnalyticsDateRange(fromDate, toDate, 'day') : {};
      return this.customersRepo.getCustomerOrdersAnalytics(userId, dateRange);
    };

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }

  async getDevicesAnalytics(user: any) {
    const userId = BigInt(user.userId || user.id);
    const cacheKey = `customer:devices:${userId.toString()}`;

    const fetcher = async () => this.customersRepo.getCustomerDevicesAnalytics(userId);

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }

  async getRentalsAnalytics(user: any) {
    const userId = BigInt(user.userId || user.id);
    const cacheKey = `customer:rentals:${userId.toString()}`;

    const fetcher = async () => this.customersRepo.getCustomerRentalsAnalytics(userId);

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }

  async addBankAccount(user: any, dto: CreateCustomerBankAccountDto) {
    const userId = BigInt(user.userId || user.id);
    const profile = await this.customersRepo.getCustomerProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException('Hồ sơ khách hàng không tồn tại');
    }

    const cleanBin = (dto.bankBin || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleanBin)) {
      throw new BadRequestException('Mã BIN ngân hàng phải gồm đúng 6 chữ số');
    }

    const cleanAcc = (dto.accountNumber || '').replace(/\s+/g, '').toUpperCase();
    if (!/^\d{6,20}$/.test(cleanAcc)) {
      throw new BadRequestException('Số tài khoản ngân hàng phải gồm từ 6 đến 20 chữ số');
    }

    const accountNumberHash = CryptoVaultUtil.computeDeterministicAccountHash(cleanAcc);
    const accountNumberEncrypted = CryptoVaultUtil.encryptAccountNumber(cleanAcc);
    const accountNumberMasked = CryptoVaultUtil.maskAccountNumber(cleanAcc);

    const created = await this.customersRepo.createCustomerBankAccount({
      customerId: profile.customerId,
      bankBin: cleanBin,
      bankCode: dto.bankCode,
      bankName: dto.bankName.trim(),
      accountNumberEncrypted,
      accountNumberHash,
      accountNumberMasked,
      accountName: dto.accountName.trim(),
      isDefault: dto.isDefault ?? true,
    });

    return {
      id: created.id.toString(),
      customerId: created.customerId.toString(),
      bankBin: created.bankBin,
      bankCode: created.bankCode,
      bankName: created.bankName,
      accountNumberMasked: created.accountNumberMasked,
      accountName: created.accountName,
      verificationStatus: created.verificationStatus,
      isDefault: created.isDefault,
      createdAt: created.createdAt,
    };
  }

  async getBankAccounts(user: any) {
    const userId = BigInt(user.userId || user.id);
    const profile = await this.customersRepo.getCustomerProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException('Hồ sơ khách hàng không tồn tại');
    }

    const accounts = await this.customersRepo.findCustomerBankAccounts(profile.customerId);
    return accounts.map((acc) => ({
      id: acc.id.toString(),
      customerId: acc.customerId.toString(),
      bankBin: acc.bankBin,
      bankCode: acc.bankCode,
      bankName: acc.bankName,
      accountNumberMasked: acc.accountNumberMasked,
      accountName: acc.accountName,
      verificationStatus: acc.verificationStatus,
      isDefault: acc.isDefault,
      createdAt: acc.createdAt,
    }));
  }
}
