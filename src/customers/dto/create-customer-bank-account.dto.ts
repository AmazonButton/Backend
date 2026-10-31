import { IsNotEmpty, IsString, IsBoolean, IsOptional, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCustomerBankAccountDto {
  @ApiProperty({ description: 'Mã BIN ngân hàng (6 số)', example: '970422' })
  @IsNotEmpty({ message: 'Mã BIN ngân hàng không được để trống' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Mã BIN ngân hàng phải gồm đúng 6 chữ số' })
  bankBin: string;

  @ApiPropertyOptional({ description: 'Mã viết tắt ngân hàng (ví dụ: MB, VCB)', example: 'MB' })
  @IsOptional()
  @IsString()
  bankCode?: string;

  @ApiProperty({ description: 'Tên ngân hàng thụ hưởng', example: 'Ngân hàng Quân Đội' })
  @IsNotEmpty({ message: 'Tên ngân hàng không được để trống' })
  @IsString()
  bankName: string;

  @ApiProperty({ description: 'Số tài khoản ngân hàng', example: '090123456789' })
  @IsNotEmpty({ message: 'Số tài khoản ngân hàng không được để trống' })
  @IsString()
  @Matches(/^\d{6,20}$/, { message: 'Số tài khoản ngân hàng phải gồm từ 6 đến 20 chữ số' })
  accountNumber: string;

  @ApiProperty({ description: 'Tên chủ tài khoản ngân hàng (viết hoa không dấu)', example: 'NGUYEN VAN A' })
  @IsNotEmpty({ message: 'Tên chủ tài khoản không được để trống' })
  @IsString()
  accountName: string;

  @ApiPropertyOptional({ description: 'Đặt làm tài khoản hoàn tiền/giao dịch mặc định', default: true })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
