import { Controller, Get } from '@nestjs/common';
import { BankVerificationService } from './bank-verification.service';

@Controller('banks')
export class BanksController {
  constructor(private readonly service: BankVerificationService) {}

  @Get()
  getBanks() {
    const banks = this.service.getVietnamBanks();
    return {
      success: true,
      message: 'Lấy danh sách ngân hàng thành công',
      data: banks,
    };
  }
}
