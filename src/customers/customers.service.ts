import { Injectable, Inject, Optional, NotFoundException, BadRequestException } from '@nestjs/common';
import { CustomersRepository } from './customers.repository';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';
import { buildAnalyticsDateRange } from '../analytics/utils/analytics-date-range.util';
import { CreateCustomerBankAccountDto } from './dto/create-customer-bank-account.dto';
import { VerifyCustomerBankAccountDto } from './dto/verify-customer-bank-account.dto';
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

  async getBankAccountVerificationStatus(user: any, accountId: string | number | bigint) {
    const userId = BigInt(user.userId || user.id);
    const profile = await this.customersRepo.getCustomerProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException('Hồ sơ khách hàng không tồn tại');
    }

    const rawAccountId = BigInt(accountId);
    const account = await this.customersRepo.findCustomerBankAccountById(profile.customerId, rawAccountId);
    if (!account) {
      throw new NotFoundException('Tài khoản ngân hàng không tồn tại hoặc không thuộc sở hữu của bạn');
    }

    return {
      id: account.id.toString(),
      customerId: account.customerId.toString(),
      bankBin: account.bankBin,
      bankCode: account.bankCode,
      bankName: account.bankName,
      accountNumberMasked: account.accountNumberMasked,
      accountName: account.accountName,
      verificationStatus: account.verificationStatus,
      isDefault: account.isDefault,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  async initiateBankAccountVerification(
    user: any,
    accountId: string | number | bigint,
  ) {
    const userId = BigInt(user.userId || user.id);
    const profile = await this.customersRepo.getCustomerProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException('Hồ sơ khách hàng không tồn tại');
    }

    const rawAccountId = BigInt(accountId);
    const account = await this.customersRepo.findCustomerBankAccountById(profile.customerId, rawAccountId);
    if (!account) {
      throw new NotFoundException('Tài khoản ngân hàng không tồn tại hoặc không thuộc sở hữu của bạn');
    }

    if (account.verificationStatus === 'VERIFIED') {
      return {
        accountId: account.id.toString(),
        verificationStatus: 'VERIFIED',
        message: 'Tài khoản ngân hàng đã được xác minh trước đó',
      };
    }

    // Generate cryptographically unique proof reference bound to this specific account
    const proofReference = `CUST_VRF_${account.bankBin}_${CryptoVaultUtil.generateReferenceCode('')}`.slice(0, 64);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes TTL

    // CRITICAL: Initiation MUST always set PENDING. SUCCESS is ONLY granted upon independent confirmation from bank/provider!
    const proof = await this.customersRepo.createBankVerificationProof({
      proofReference,
      customerId: profile.customerId,
      accountId: account.id,
      bankBin: account.bankBin,
      accountNumberHash: (account as any).accountNumberHash,
      status: 'PENDING',
      provider: 'PAYOS',
      expiresAt,
    });

    return {
      accountId: account.id.toString(),
      proofReference: proof.proofReference,
      expiresAt: proof.expiresAt.toISOString(),
      status: proof.status,
      message: 'Khởi tạo phiên xác minh tài khoản ngân hàng thành công. Phiên đang ở trạng thái PENDING, vui lòng chờ đối tác xác thực.',
    };
  }

  async confirmProviderBankVerification(params: {
    proofReference: string;
    customerId: bigint;
    accountId: bigint;
    bankBin: string;
    accountNumberHash: string;
    providerStatus: 'SUCCESS' | 'FAILED';
  }) {
    return this.customersRepo.confirmBankVerificationProof({
      proofReference: params.proofReference,
      customerId: params.customerId,
      accountId: params.accountId,
      bankBin: params.bankBin,
      accountNumberHash: params.accountNumberHash,
      status: params.providerStatus,
    });
  }

  async verifyBankAccount(
    user: any,
    accountId: string | number | bigint,
    dto: VerifyCustomerBankAccountDto,
  ) {
    const userId = BigInt(user.userId || user.id);
    const profile = await this.customersRepo.getCustomerProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException('Hồ sơ khách hàng không tồn tại');
    }

    const rawAccountId = BigInt(accountId);
    const account = await this.customersRepo.findCustomerBankAccountById(profile.customerId, rawAccountId);
    if (!account) {
      throw new NotFoundException('Tài khoản ngân hàng không tồn tại hoặc không thuộc sở hữu của bạn');
    }

    // Idempotent early return if already verified
    if (account.verificationStatus === 'VERIFIED') {
      return {
        id: account.id.toString(),
        customerId: account.customerId.toString(),
        bankBin: account.bankBin,
        bankCode: account.bankCode,
        bankName: account.bankName,
        accountNumberMasked: account.accountNumberMasked,
        accountName: account.accountName,
        verificationStatus: 'VERIFIED',
        isDefault: account.isDefault,
        message: 'Tài khoản ngân hàng đã được xác minh trước đó',
      };
    }

    // Validate DTO parameter
    if (!dto?.proofReference || typeof dto.proofReference !== 'string' || dto.proofReference.trim().length === 0) {
      throw new BadRequestException('Mã tham chiếu xác minh (proofReference) không được để trống');
    }

    // Execute atomic row-locked CAS transaction in repository
    const result = await this.customersRepo.consumeBankVerificationProofTx({
      proofReference: dto.proofReference.trim(),
      customerId: profile.customerId,
      accountId: rawAccountId,
    });

    const updated = await this.customersRepo.findCustomerBankAccountById(profile.customerId, rawAccountId);
    return {
      id: updated!.id.toString(),
      customerId: updated!.customerId.toString(),
      bankBin: updated!.bankBin,
      bankCode: updated!.bankCode,
      bankName: updated!.bankName,
      accountNumberMasked: updated!.accountNumberMasked,
      accountName: updated!.accountName,
      verificationStatus: updated!.verificationStatus,
      isDefault: updated!.isDefault,
      message: result.alreadyVerified
        ? 'Tài khoản ngân hàng đã được xác minh trước đó'
        : 'Xác minh tài khoản ngân hàng thành công',
    };
  }
}
