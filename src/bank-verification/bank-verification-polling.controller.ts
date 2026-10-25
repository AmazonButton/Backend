import {
  Controller,
  Get,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { BankVerificationService } from './bank-verification.service';

@UseGuards(JwtAuthGuard)
@Controller('bank-account-verifications')
export class BankVerificationPollingController {
  constructor(private readonly service: BankVerificationService) {}

  @Get(':id')
  async getVerificationDetail(@Param('id') id: string, @Request() req: any) {
    const userId = BigInt(req.user.userId);
    const role = req.user?.role;
    const data = await this.service.getVerificationTransactionById(id, userId, role);

    return {
      success: true,
      message: 'Lấy trạng thái xác minh tài khoản thành công',
      data,
    };
  }
}
