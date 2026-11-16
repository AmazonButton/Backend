const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('--- Upserting Standard Store Subscription Plans ---');
  const storePlans = [
    {
      planCode: 'TRIAL_7D',
      planName: 'Gói Dùng Thử 7 Ngày Miễn Phí',
      description: 'Dành riêng cho gian hàng mới trải nghiệm đầy đủ tính năng trong 7 ngày (Một tài khoản chỉ sử dụng 1 lần duy nhất)',
      price: 0,
      durationDays: 7,
      maxProducts: 999999,
      isActive: true,
    },
    {
      planCode: 'STORE_1M',
      planName: 'Gói Thuê Sàn 1 Tháng',
      description: 'Gói duy trì gian hàng tiêu chuẩn 30 ngày, không giới hạn số lượng sản phẩm đăng bán',
      price: 60000,
      durationDays: 30,
      maxProducts: 999999,
      isActive: true,
    },
    {
      planCode: 'STORE_6M',
      planName: 'Gói Thuê Sàn 6 Tháng',
      description: 'Gói duy trì gian hàng 180 ngày (tiết kiệm hơn), không giới hạn sản phẩm đăng bán',
      price: 320000,
      durationDays: 180,
      maxProducts: 999999,
      isActive: true,
    },
    {
      planCode: 'STORE_12M',
      planName: 'Gói Thuê Sàn 12 Tháng',
      description: 'Gói duy trì gian hàng trọn năm 365 ngày, tiết kiệm tối đa, không giới hạn sản phẩm đăng bán',
      price: 600000,
      durationDays: 365,
      maxProducts: 999999,
      isActive: true,
    },
  ];

  for (const p of storePlans) {
    const upserted = await prisma.subscriptionPlan.upsert({
      where: { planCode: p.planCode },
      update: {
        planName: p.planName,
        description: p.description,
        price: p.price,
        durationDays: p.durationDays,
        maxProducts: p.maxProducts,
        isActive: p.isActive,
      },
      create: p,
    });
    console.log(`Plan: ${upserted.planCode} (#${upserted.planId}) -> ${upserted.planName} (${upserted.price}đ / ${upserted.durationDays}d)`);
  }

  console.log('\n--- Upserting Standard Button Rental Packages (Cọc chuẩn 200.000đ / nút) ---');
  const rentalPackages = [
    {
      packageCode: 'KIT1_STANDARD',
      packageName: 'Bộ 1 Nút Bấm IoT Thông Minh',
      description: 'Dành cho khách hàng cá nhân. Tháng đầu thuê tặng 7 ngày dùng thử (37 ngày). Cọc 200.000đ/nút hoàn trả 100% khi thanh lý hợp đồng.',
      buttonQuantity: 1,
      monthlyPrice: 40000,
      depositFee: 200000,
      isActive: true,
    },
    {
      packageCode: 'KIT3_STANDARD',
      packageName: 'Bộ Kit 3 Nút Bấm IoT Thông Minh',
      description: 'Combo 3 nút đặt hàng nhanh tiện lợi. Tháng đầu thuê tặng 7 ngày dùng thử (37 ngày). Cọc 600.000đ (200.000đ/nút) hoàn trả 100% khi thanh lý.',
      buttonQuantity: 3,
      monthlyPrice: 90000,
      depositFee: 600000,
      isActive: true,
    },
    {
      packageCode: 'KIT5_STANDARD',
      packageName: 'Bộ Kit 5 Nút Bấm IoT Gia Đình & Doanh Nghiệp',
      description: 'Combo 5 nút đa năng cho nhiều vị trí. Tháng đầu thuê tặng 7 ngày dùng thử (37 ngày). Cọc 1.000.000đ (200.000đ/nút) hoàn trả 100% khi thanh lý.',
      buttonQuantity: 5,
      monthlyPrice: 140000,
      depositFee: 1000000,
      isActive: true,
    },
  ];

  for (const r of rentalPackages) {
    const upserted = await prisma.rentalPackage.upsert({
      where: { packageCode: r.packageCode },
      update: {
        packageName: r.packageName,
        description: r.description,
        buttonQuantity: r.buttonQuantity,
        monthlyPrice: r.monthlyPrice,
        depositFee: r.depositFee,
        isActive: r.isActive,
      },
      create: r,
    });
    console.log(`Rental Package: ${upserted.packageCode} (#${upserted.packageId}) -> ${upserted.packageName} (Giá: ${upserted.monthlyPrice}đ/tháng, Cọc: ${upserted.depositFee}đ)`);
  }
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
