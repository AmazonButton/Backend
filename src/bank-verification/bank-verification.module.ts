import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentsModule } from '../payments/payments.module';
import { BanksController } from './banks.controller';
import { StoreBankAccountsController } from './store-bank-accounts.controller';
import { BankVerificationWebhookController } from './bank-verification-webhook.controller';
import { BankVerificationService } from './bank-verification.service';
import { BankVerificationRepository } from './bank-verification.repository';
import { BankVerificationWebhookGuard } from './guards/bank-verification-webhook.guard';
import { BankLookupRateLimitGuard } from './guards/bank-lookup-rate-limit.guard';
import { PayOSBankVerificationProvider } from './providers/payos-bank-verification.provider';
import { BANK_VERIFICATION_PROVIDER_TOKEN } from './providers/bank-verification.provider.interface';

@Module({
  imports: [PrismaModule, PaymentsModule],
  controllers: [
    BanksController,
    StoreBankAccountsController,
    BankVerificationWebhookController,
  ],
  providers: [
    BankVerificationService,
    BankVerificationRepository,
    BankVerificationWebhookGuard,
    BankLookupRateLimitGuard,
    PayOSBankVerificationProvider,
    {
      provide: BANK_VERIFICATION_PROVIDER_TOKEN,
      useClass: PayOSBankVerificationProvider,
    },
  ],
  exports: [
    BankVerificationService,
    BankVerificationRepository,
    BankLookupRateLimitGuard,
    BANK_VERIFICATION_PROVIDER_TOKEN,
  ],
})
export class BankVerificationModule {}
