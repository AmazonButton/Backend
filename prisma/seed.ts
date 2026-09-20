import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding SmartSupply V2 data into fresh SQLite database...');
  const passwordHash = await bcrypt.hash('Password123!', 10);

  console.log('🏪 Creating Stores...');
  const store1 = await prisma.store.create({
    data: {
      name: 'Đại lý Nước & Gas Gia Định',
      code: 'STORE-GD01',
      ownerName: 'Nguyễn Văn Định',
      phone: '0908112233',
      email: 'store@smartorder.local',
      address: '142 Nguyễn Thị Minh Khai, P. Bến Nghé, Quận 1, TP. Hồ Chí Minh',
      status: 'ACTIVE',
      approvedAt: new Date(),
    },
  });

  const store2 = await prisma.store.create({
    data: {
      name: 'Minh Khôi Mart Nhu Yếu Phẩm',
      code: 'STORE-MK02',
      ownerName: 'Lê Minh Khôi',
      phone: '0912445566',
      email: 'minhkhoi@smartorder.local',
      address: '88 Song Hành, Phường An Phú, TP. Thủ Đức, TP. Hồ Chí Minh',
      status: 'ACTIVE',
      approvedAt: new Date(),
    },
  });

  console.log('👤 Creating Users...');
  // Super Admin
  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@smartorder.local',
      username: 'admin',
      passwordHash,
      fullName: 'Võ Minh Quân (Super Admin)',
      phone: '0901000999',
      role: 'SUPER_ADMIN',
      emailVerified: true,
    },
  });

  // Store Owner
  const storeOwnerUser = await prisma.user.create({
    data: {
      email: 'store@smartorder.local',
      username: 'store_owner',
      passwordHash,
      fullName: 'Nguyễn Văn Định (Chủ Cửa Hàng)',
      phone: '0908112233',
      role: 'STORE_OWNER',
      storeId: store1.id,
      emailVerified: true,
    },
  });

  // Technician
  const techUser = await prisma.user.create({
    data: {
      email: 'tech@smartorder.local',
      username: 'technician',
      passwordHash,
      fullName: 'Hoàng Long (Kỹ Thuật Viên IoT)',
      phone: '0909334455',
      role: 'TECHNICIAN',
      emailVerified: true,
    },
  });

  // Primary Customer: Nguyễn Văn An (Household Owner)
  const customer1User = await prisma.user.create({
    data: {
      email: 'customer@smartorder.local',
      username: 'customer',
      passwordHash,
      fullName: 'Nguyễn Văn An',
      phone: '0988776655',
      role: 'CUSTOMER',
      storeId: store1.id,
      emailVerified: true,
    },
  });

  // Family Member 1: Lê Thu Thảo (Household Admin / Wife)
  const memberWifeUser = await prisma.user.create({
    data: {
      email: 'thao.le@smartorder.local',
      username: 'thao_le',
      passwordHash,
      fullName: 'Lê Thu Thảo',
      phone: '0988776688',
      role: 'CUSTOMER',
      storeId: store1.id,
      emailVerified: true,
    },
  });

  // Family Member 2: Nguyễn Tuấn Anh (Household Member / Son)
  const memberSonUser = await prisma.user.create({
    data: {
      email: 'tuananh@smartorder.local',
      username: 'tuananh',
      passwordHash,
      fullName: 'Nguyễn Tuấn Anh',
      phone: '0988776699',
      role: 'CUSTOMER',
      storeId: store1.id,
      emailVerified: true,
    },
  });

  const customer1Profile = await prisma.customerProfile.create({
    data: {
      userId: customer1User.id,
      storeId: store1.id,
      apartment: 'Phòng 1204',
      building: 'Tháp Sapphire',
      floor: 'Tầng 12',
      room: '1204',
      deliveryAddress: 'Căn hộ 1204, Tháp Sapphire, Sunwah Pearl, 90 Nguyễn Hữu Cảnh, P. 22, Bình Thạnh',
      phone: '0988776655',
    },
  });

  console.log('🏡 Creating Households & RBAC...');
  const household1 = await prisma.household.create({
    data: {
      name: 'Căn hộ 1204 Sunwah Pearl',
      address: 'Căn hộ 1204, Tháp Sapphire, Sunwah Pearl, 90 Nguyễn Hữu Cảnh, P. 22, Bình Thạnh',
      building: 'Tháp Sapphire',
      apartment: '1204',
      members: {
        create: [
          {
            userId: customer1User.id,
            role: 'OWNER',
            nickname: 'Nguyễn Văn An (Chủ hộ)',
          },
          {
            userId: memberWifeUser.id,
            role: 'ADMIN',
            nickname: 'Lê Thu Thảo (Vợ)',
          },
          {
            userId: memberSonUser.id,
            role: 'MEMBER',
            nickname: 'Nguyễn Tuấn Anh (Con trai)',
          },
        ],
      },
    },
  });

  console.log('📦 Creating Products...');
  const prodLavie20L = await prisma.product.create({
    data: {
      storeId: store1.id,
      name: 'Nước khoáng thiên nhiên La Vie 20L',
      brand: 'La Vie (Nestlé Waters)',
      sku: 'WTR-LAV-20L',
      category: 'Nước uống',
      unit: 'Bình 20L',
      price: 68000,
      stock: 150,
      reservedStock: 2,
      minStockAlert: 20,
      imageUrl: 'https://images.unsplash.com/photo-1548839140-29a749e1bc4e?auto=format&fit=crop&w=600&q=80',
    },
  });

  const prodVinhHao20L = await prisma.product.create({
    data: {
      storeId: store1.id,
      name: 'Nước khoáng Vĩnh Hảo 20L có vòi',
      brand: 'Vĩnh Hảo (Masan)',
      sku: 'WTR-VINH-20L',
      category: 'Nước uống',
      unit: 'Bình 20L',
      price: 72000,
      stock: 95,
      reservedStock: 0,
      minStockAlert: 15,
      imageUrl: 'https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&w=600&q=80',
    },
  });

  const prodPetrolimex12kg = await prisma.product.create({
    data: {
      storeId: store1.id,
      name: 'Bình gas Petrolimex 12kg Van Ngang',
      brand: 'Petrolimex',
      sku: 'GAS-PET-12KG',
      category: 'Gas',
      unit: 'Bình 12kg',
      price: 435000,
      stock: 45,
      reservedStock: 1,
      minStockAlert: 10,
      imageUrl: 'https://images.unsplash.com/photo-1585776245991-cf89dd7fc73a?auto=format&fit=crop&w=600&q=80',
    },
  });

  const prodGaoST25 = await prisma.product.create({
    data: {
      storeId: store1.id,
      name: 'Gạo đặc sản ST25 Ông Cua Túi 5kg',
      brand: 'ST25 Ông Cua',
      sku: 'RIC-ST25-5KG',
      category: 'Gạo',
      unit: 'Túi 5kg',
      price: 195000,
      stock: 80,
      reservedStock: 1,
      minStockAlert: 15,
      imageUrl: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?auto=format&fit=crop&w=600&q=80',
    },
  });

  const prodSimplyOil5L = await prisma.product.create({
    data: {
      storeId: store1.id,
      name: 'Dầu đậu nành nguyên chất Simply Can 5L',
      brand: 'Simply',
      sku: 'OIL-SMP-5L',
      category: 'Nhu yếu phẩm',
      unit: 'Can 5L',
      price: 275000,
      stock: 40,
      reservedStock: 0,
      minStockAlert: 10,
      imageUrl: 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&w=600&q=80',
    },
  });

  const prodKhaiHoan520ml = await prisma.product.create({
    data: {
      storeId: store1.id,
      name: 'Nước Mắm Khải Hoàn Phú Quốc 40 Độ Đạm',
      brand: 'Khải Hoàn Phú Quốc',
      sku: 'NM-KHAIHOAN-40N-520ML',
      category: 'Nước mắm',
      unit: 'Chai 520ml',
      price: 135000,
      stock: 120,
      reservedStock: 0,
      minStockAlert: 15,
      imageUrl: 'https://images.unsplash.com/photo-1615485290382-441e4d049cb5?auto=format&fit=crop&w=600&q=80',
    },
  });

  const prodChinsuCahoi = await prisma.product.create({
    data: {
      storeId: store1.id,
      name: 'Nước Mắm Chinsu Cá Hồi Đậm Đà',
      brand: 'Chinsu (Masan)',
      sku: 'NM-CHINSU-CAHOI-500ML',
      category: 'Nước mắm',
      unit: 'Chai 500ml',
      price: 49000,
      stock: 250,
      reservedStock: 2,
      minStockAlert: 30,
      imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=600&q=80',
    },
  });

  const prodNamNgu900ml = await prisma.product.create({
    data: {
      storeId: store1.id,
      name: 'Nước Mắm Nam Ngư Đệ Nhị 900ml',
      brand: 'Nam Ngư (Masan)',
      sku: 'NM-NAMNGU-DENHY-900ML',
      category: 'Nước mắm',
      unit: 'Chai 900ml',
      price: 36000,
      stock: 310,
      reservedStock: 1,
      minStockAlert: 40,
      imageUrl: 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?auto=format&fit=crop&w=600&q=80',
    },
  });

  console.log('🔘 Creating SmartSupply IoT Devices with Behavior Designer...');
  // Device 1: Smart Water Button
  const dev1 = await prisma.device.create({
    data: {
      deviceId: 'BTN-8829-WTR',
      deviceCode: 'WTR-KITCHEN',
      deviceType: 'REPLENISHMENT_BUTTON',
      serialNumber: 'SN-ESP32-882901',
      deviceSecret: 'sec_smart_button_8829_wtr_key_99',
      claimCode: 'CLAIM-749201',
      qrPayload: 'https://smartorder.local/claim?d=BTN-8829-WTR&c=CLAIM-749201',
      firmwareVersion: '2.1.0',
      hardwareModel: 'ESP32-WROOM-32E',
      status: 'ACTIVE',
      storeId: store1.id,
      customerId: customer1Profile.id,
      householdId: household1.id,
      batteryLevel: 94,
      wifiRSSI: -56,
      healthScore: 96,
      healthStatus: 'OPTIMAL',
      pressCount: 18,
      lastSeenAt: new Date(),
    },
  });

  await prisma.deviceConfiguration.create({
    data: {
      deviceId: dev1.id,
      customName: 'Nút Nước La Vie Bếp',
      productId: prodLavie20L.id,
      defaultQuantity: 1,
      allowCustomerQuantity: true,
      allowCustomerProduct: false,
      quickOrderDirect: true,
      cancelWindowSeconds: 60,
      soundEnabled: true,
      ledEnabled: true,
      singlePressAction: 'ORDER_PRODUCT',
      doublePressAction: 'ADD_TO_SHOPPING_LIST',
      hold3sAction: 'REQUEST_SERVICE',
      hold5sAction: 'CANCEL_ACTIVE_REQUEST',
      version: 2,
    },
  });

  // Device 2: Smart Gas & Safety Button
  const dev2 = await prisma.device.create({
    data: {
      deviceId: 'BTN-8830-GAS',
      deviceCode: 'GAS-SAFETY-01',
      deviceType: 'MULTI_FUNCTION_BUTTON',
      serialNumber: 'SN-ESP32-883002',
      deviceSecret: 'sec_smart_button_8830_gas_key_88',
      claimCode: 'CLAIM-749202',
      qrPayload: 'https://smartorder.local/claim?d=BTN-8830-GAS&c=CLAIM-749202',
      firmwareVersion: '2.1.0',
      hardwareModel: 'ESP32-WROOM-32E',
      status: 'ACTIVE',
      storeId: store1.id,
      customerId: customer1Profile.id,
      householdId: household1.id,
      batteryLevel: 82,
      wifiRSSI: -64,
      healthScore: 88,
      healthStatus: 'GOOD',
      pressCount: 9,
      lastSeenAt: new Date(Date.now() - 3600 * 1000 * 2),
    },
  });

  await prisma.deviceConfiguration.create({
    data: {
      deviceId: dev2.id,
      customName: 'Nút Gas & An Toàn Bếp',
      productId: prodPetrolimex12kg.id,
      defaultQuantity: 1,
      allowCustomerQuantity: false,
      allowCustomerProduct: false,
      quickOrderDirect: true,
      cancelWindowSeconds: 120,
      soundEnabled: true,
      ledEnabled: true,
      singlePressAction: 'ORDER_PRODUCT',
      doublePressAction: 'ADD_TO_SHOPPING_LIST',
      hold3sAction: 'REQUEST_SERVICE',
      hold5sAction: 'TRIGGER_EMERGENCY',
      version: 2,
    },
  });

  // Device 3: Smart Pantry Button
  const dev3 = await prisma.device.create({
    data: {
      deviceId: 'BTN-8831-RIC',
      deviceCode: 'PANTRY-RICE',
      deviceType: 'REPLENISHMENT_BUTTON',
      serialNumber: 'SN-ESP32-883103',
      deviceSecret: 'sec_smart_button_8831_ric_key_77',
      claimCode: 'CLAIM-749203',
      qrPayload: 'https://smartorder.local/claim?d=BTN-8831-RIC&c=CLAIM-749203',
      firmwareVersion: '2.1.0',
      hardwareModel: 'ESP32-C3-MINI',
      status: 'ACTIVE',
      storeId: store1.id,
      customerId: customer1Profile.id,
      householdId: household1.id,
      batteryLevel: 71,
      wifiRSSI: -72,
      healthScore: 78,
      healthStatus: 'ATTENTION',
      pressCount: 14,
      lastSeenAt: new Date(Date.now() - 3600 * 1000 * 12),
    },
  });

  await prisma.deviceConfiguration.create({
    data: {
      deviceId: dev3.id,
      customName: 'Nút Gạo ST25 Tủ Kho',
      productId: prodGaoST25.id,
      defaultQuantity: 1,
      allowCustomerQuantity: true,
      allowCustomerProduct: false,
      quickOrderDirect: false,
      cancelWindowSeconds: 60,
      soundEnabled: true,
      ledEnabled: true,
      singlePressAction: 'ADD_TO_SHOPPING_LIST',
      doublePressAction: 'ORDER_PRODUCT',
      hold3sAction: 'SEND_NOTIFICATION',
      hold5sAction: 'CANCEL_ACTIVE_REQUEST',
      version: 2,
    },
  });

  console.log('📈 Seeding Realistic Consumption History for Statistical Prediction...');
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const waterIntervals = [35, 28, 21, 14, 7];
  for (const daysAgo of waterIntervals) {
    await prisma.consumptionRecord.create({
      data: {
        householdId: household1.id,
        productId: prodLavie20L.id,
        deviceId: dev1.id,
        quantity: 1,
        recordedAt: new Date(now - daysAgo * dayMs),
      },
    });
  }

  // Gas: last recorded 38 days ago
  await prisma.consumptionRecord.create({
    data: {
      householdId: household1.id,
      productId: prodPetrolimex12kg.id,
      deviceId: dev2.id,
      quantity: 1,
      recordedAt: new Date(now - 38 * dayMs),
    },
  });

  console.log('🔔 Creating Smart Reminders & Explanations...');
  await prisma.smartReminder.create({
    data: {
      householdId: household1.id,
      productId: prodLavie20L.id,
      expectedDate: new Date(now + 2 * dayMs),
      confidence: 93,
      reason: 'Dựa trên chu kỳ tiêu dùng trung bình 7.0 ngày qua 5 lần gần nhất. Dự kiến hết nước trong 2 ngày.',
      status: 'PENDING',
    },
  });

  console.log('🛒 Creating Smart Shared Household Shopping List...');
  await prisma.shoppingList.create({
    data: {
      householdId: household1.id,
      items: {
        create: [
          {
            productId: prodLavie20L.id,
            quantity: 1,
            addedByUserId: customer1User.id,
            addedFromDeviceId: dev1.id,
            isChecked: false,
          },
          {
            productId: prodSimplyOil5L.id,
            quantity: 1,
            addedByUserId: memberWifeUser.id,
            isChecked: false,
          },
        ],
      },
    },
  });

  console.log('🛠️ Creating Service Requests & Emergency Alerts...');
  await prisma.serviceRequest.create({
    data: {
      householdId: household1.id,
      storeId: store1.id,
      deviceId: dev2.id,
      type: 'MAINTENANCE',
      category: 'Kiểm tra van gas',
      description: 'Yêu cầu kiểm tra van gas và đường ống định kỳ (kích hoạt qua nút bấm bếp).',
      priority: 'NORMAL',
      status: 'PENDING',
    },
  });

  console.log('📦 Creating Initial Orders...');
  const ord1 = await prisma.order.create({
    data: {
      orderNumber: `SS-${Date.now().toString().slice(-6)}-01`,
      storeId: store1.id,
      customerId: customer1Profile.id,
      deviceId: dev1.id,
      status: 'DELIVERED',
      totalAmount: 68000,
      deliveryAddress: customer1Profile.deliveryAddress,
      customerPhone: customer1Profile.phone,
      customerName: customer1User.fullName,
      createdAt: new Date(now - 7 * dayMs),
      cancelExpiresAt: new Date(now - 7 * dayMs + 60000),
      items: {
        create: [
          {
            productId: prodLavie20L.id,
            productName: prodLavie20L.name,
            quantity: 1,
            unitPrice: 68000,
            totalPrice: 68000,
          },
        ],
      },
    },
  });

  console.log('📝 Creating Initial Audit Logs...');
  await prisma.auditLog.create({
    data: {
      userId: storeOwnerUser.id,
      action: 'DEVICE_CONFIGURED',
      entity: 'Device',
      entityId: dev1.id,
      newValues: JSON.stringify({ customName: 'Nút Nước La Vie Bếp', productId: prodLavie20L.id }),
    },
  });

  console.log('🎉 SmartSupply V2 Seed successfully finished!');
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
