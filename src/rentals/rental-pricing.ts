import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface RentalPricingInput {
  buttonQuantity: number;
  months: number;
  monthlyPackagePrice: number | string | Prisma.Decimal;
  packageDepositFee: number | string | Prisma.Decimal;
}

export interface RentalPricingResult {
  buttonQuantity: number;
  months: number;
  monthlyPackagePrice: Prisma.Decimal;
  packageDepositFee: Prisma.Decimal;
  rentTotal: Prisma.Decimal;
  depositTotal: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  depositPerButton: Prisma.Decimal;
  monthlyRentPerButton: Prisma.Decimal;
  rentPerButton: Prisma.Decimal;
  lines: {
    rent: {
      lineType: 'RENT';
      amount: Prisma.Decimal;
      durationCount: number;
      durationUnit: 'MONTH';
      quantity: number;
      unitPrice: Prisma.Decimal;
      description: string;
    };
    deposit: {
      lineType: 'DEPOSIT';
      amount: Prisma.Decimal;
      durationCount: null;
      durationUnit: null;
      quantity: number;
      unitPrice: Prisma.Decimal;
      description: string;
    };
  };
}

/** Pure domain function to calculate rental contract and billing charge pricing without Math.floor loss. */
export function calculateRentalPricing(input: RentalPricingInput): RentalPricingResult {
  const qty = input.buttonQuantity;
  const months = input.months;

  if (!Number.isInteger(qty) || qty <= 0 || qty > 100) {
    throw new BadRequestException('Số lượng nút phải là số nguyên dương từ 1 đến 100');
  }
  if (!Number.isInteger(months) || months <= 0 || months > 120) {
    throw new BadRequestException('Số tháng thuê phải là số nguyên dương từ 1 đến 120');
  }

  const monthlyPrice = new Prisma.Decimal(input.monthlyPackagePrice);
  const depositFee = new Prisma.Decimal(input.packageDepositFee);

  if (!monthlyPrice.isFinite() || !monthlyPrice.gt(0) || !monthlyPrice.isInteger()) {
    throw new BadRequestException('Giá thuê tháng của gói phải là số nguyên dương');
  }
  if (depositFee.lt(0) || !depositFee.isInteger()) {
    throw new BadRequestException('Tiền cọc của gói phải là số nguyên không âm');
  }

  // Kit price semantics: package prices represent total for the whole kit
  const rentTotal = monthlyPrice.mul(months);
  const depositTotal = depositFee;
  const totalAmount = rentTotal.add(depositTotal);
  if (totalAmount.gt('9999999999999')) throw new BadRequestException('Tổng khoản thu vượt giới hạn lưu trữ VND');

  // Exact division verification (no Math.floor residue loss)
  const depositRemainder = depositTotal.mod(qty);
  if (!depositRemainder.isZero()) {
    throw new BadRequestException(`Tiền cọc của gói (${depositTotal}) không thể chia đều cho ${qty} nút`);
  }
  const depositPerButton = depositTotal.div(qty);

  const monthlyRentRemainder = monthlyPrice.mod(qty);
  if (!monthlyRentRemainder.isZero()) {
    throw new BadRequestException(`Giá thuê tháng của gói (${monthlyPrice}) không thể chia đều cho ${qty} nút`);
  }
  const monthlyRentPerButton = monthlyPrice.div(qty);
  const rentPerButton = monthlyRentPerButton.mul(months);

  return {
    buttonQuantity: qty,
    months,
    monthlyPackagePrice: monthlyPrice,
    packageDepositFee: depositFee,
    rentTotal,
    depositTotal,
    totalAmount,
    depositPerButton,
    monthlyRentPerButton,
    rentPerButton,
    lines: {
      rent: {
        lineType: 'RENT',
        amount: rentTotal,
        durationCount: months,
        durationUnit: 'MONTH',
        quantity: qty,
        unitPrice: rentPerButton,
        description: `Phí thuê nút thông minh (${qty} nút, ${months} tháng)`,
      },
      deposit: {
        lineType: 'DEPOSIT',
        amount: depositTotal,
        durationCount: null,
        durationUnit: null,
        quantity: qty,
        unitPrice: depositPerButton,
        description: `Tiền cọc thiết bị nút bấm thông minh (${qty} nút)`,
      },
    },
  };
}

