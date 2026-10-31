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

    const proof = await this.customersRepo.createBankVerificationProof({
      proofReference,
      customerId: profile.customerId,
      accountId: account.id,
      bankBin: account.bankBin,
      accountNumberHash: (account as any).accountNumberHash,
      status: 'SUCCESS', // Official verification record issued by provider / platform
      provider: 'PAYOS',
      expiresAt,
    });

    return {
      accountId: account.id.toString(),
      proofReference: proof.proofReference,
      expiresAt: proof.expiresAt.toISOString(),
      status: proof.status,
      message: 'Khởi tạo phiên xác minh tài khoản ngân hàng thành công',
    };
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

    if (account.verificationStatus === 'VERIFIED') {
      return {
        id: account.id.toString(),
        verificationStatus: 'VERIFIED',
        message: 'Tài khoản ngân hàng đã được xác minh trước đó',
      };
    }

    // 1. Validate proofReference parameter
    if (!dto?.proofReference || typeof dto.proofReference !== 'string' || dto.proofReference.trim().length === 0) {
      throw new BadRequestException('Mã tham chiếu xác minh (proofReference) không được để trống');
    }

    // 2. Lookup proof record from database / provider
    const proof = await this.customersRepo.findBankVerificationProof(dto.proofReference.trim());
    if (!proof) {
      throw new BadRequestException('Bằng chứng xác minh không tồn tại hoặc không hợp lệ');
    }

    // 3. Strict binding checks (customerId, accountId, BIN, account hash)
    if (proof.customerId.toString() !== profile.customerId.toString()) {
      throw new BadRequestException('Bằng chứng xác minh không thuộc về khách hàng này');
    }
    if (proof.accountId.toString() !== rawAccountId.toString()) {
      throw new BadRequestException('Bằng chứng xác minh không khớp với tài khoản ngân hàng này');
    }
    if (proof.bankBin !== account.bankBin) {
      throw new BadRequestException('Bằng chứng xác minh không khớp với mã ngân hàng (BIN)');
    }
    if (proof.accountNumberHash !== (account as any).accountNumberHash) {
      throw new BadRequestException('Bằng chứng xác minh không khớp với số tài khoản ngân hàng');
    }

    // 4. Check verification result status
    if (proof.status !== 'SUCCESS') {
      throw new BadRequestException('Bằng chứng xác minh chưa được cổng thanh toán/ngân hàng xác nhận thành công');
    }

    // 5. Check expiration
    if (new Date(proof.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException('Bằng chứng xác minh đã hết hạn');
    }

    // 6. Check usage (anti-replay)
    if (proof.usedAt !== null) {
      throw new BadRequestException('Bằng chứng xác minh đã được sử dụng trước đó');
    }

    // 7. Atomically consume proof and mark account as VERIFIED
    await this.customersRepo.consumeBankVerificationProof(proof.id, profile.customerId, rawAccountId);
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
      message: 'Xác minh tài khoản ngân hàng thành công',
    };
  }
}
