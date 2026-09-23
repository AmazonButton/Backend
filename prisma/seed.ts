import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Multi-Store IoT Button Platform (BRD V2.1) data...');
  const passwordHash = await bcrypt.hash('Password123!', 12);

  console.log('🛡️ Creating System Roles...');
  const rolesData = [
    { roleCode: 'SYSTEM_ADMIN', roleName: 'System Administrator', description: 'Quản trị viên toàn hệ thống' },
    { roleCode: 'STORE_OWNER', roleName: 'Store Owner', description: 'Chủ cửa hàng, toàn quyền trên Store' },
    { roleCode: 'STAFF_ORDER', roleName: 'Order Management Staff', description: 'Nhân viên xử lý và giao đơn hàng' },
    { roleCode: 'STAFF_INVENTORY', roleName: 'Inventory Staff', description: 'Nhân viên quản lý kho và kiểm kê' },
    { roleCode: 'STAFF_BUTTON', roleName: 'Button Tech Staff', description: 'Nhân viên kỹ thuật phần cứng nút bấm' },
    { roleCode: 'CUSTOMER', roleName: 'Customer', description: 'Khách hàng toàn cầu' },
  ];

  for (const r of rolesData) {
    await prisma.role.upsert({
      where: { roleCode: r.roleCode },
      update: { roleName: r.roleName, description: r.description },
      create: r,
    });
  }

  const roleStoreOwner = await prisma.role.findUniqueOrThrow({ where: { roleCode: 'STORE_OWNER' } });

  console.log('👤 Creating Users...');
  // 1. Super Admin
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@smartorder.local' },
    update: { passwordHash, status: 'ACTIVE' },
    create: {
      username: 'admin',
      email: 'admin@smartorder.local',
      passwordHash,
      fullName: 'Võ Minh Quân (Super Admin)',
      phone: '0901000999',
      status: 'ACTIVE',
    },
  });

  // 2. Store Owner 1
  const storeOwner1 = await prisma.user.upsert({
    where: { email: 'store@smartorder.local' },
    update: { passwordHash, status: 'ACTIVE' },
    create: {
      username: 'store_owner',
      email: 'store@smartorder.local',
      passwordHash,
      fullName: 'Nguyễn Văn Định (Chủ Đại Lý Gia Định)',
      phone: '0908112233',
      status: 'ACTIVE',
    },
  });

  // 3. Store Owner 2
  const storeOwner2 = await prisma.user.upsert({
    where: { email: 'minhkhoi@smartorder.local' },
    update: { passwordHash, status: 'ACTIVE' },
    create: {
      username: 'store_owner2',
      email: 'minhkhoi@smartorder.local',
      passwordHash,
      fullName: 'Lê Minh Khôi (Chủ Siêu Thị Minh Khôi)',
      phone: '0912445566',
      status: 'ACTIVE',
    },
  });

  // 4. Global Customer: Nguyễn Văn An
  const customerUser = await prisma.user.upsert({
    where: { email: 'customer@smartorder.local' },
    update: { passwordHash, status: 'ACTIVE' },
    create: {
      username: 'customer',
      email: 'customer@smartorder.local',
      passwordHash,
      fullName: 'Nguyễn Văn An',
      phone: '0988776655',
      status: 'ACTIVE',
    },
  });

  console.log('🏪 Creating Multi-Store Outlets...');
  const store1 = await prisma.store.upsert({
    where: { code: 'STORE-GD01' },
    update: { ownerUserId: storeOwner1.userId, status: 'ACTIVE' },
    create: {
      ownerUserId: storeOwner1.userId,
      name: 'Đại lý Nước & Gas Gia Định',
      code: 'STORE-GD01',
      phone: '0908112233',
      email: 'store@smartorder.local',
      address: '142 Nguyễn Thị Minh Khai, P. Bến Nghé, Quận 1, TP. Hồ Chí Minh',
      status: 'ACTIVE',
    },
  });

  const store2 = await prisma.store.upsert({
    where: { code: 'STORE-MK02' },
    update: { ownerUserId: storeOwner2.userId, status: 'ACTIVE' },
    create: {
      ownerUserId: storeOwner2.userId,
      name: 'Minh Khôi Mart Nhu Yếu Phẩm',
      code: 'STORE-MK02',
      phone: '0912445566',
      email: 'minhkhoi@smartorder.local',
      address: '88 Song Hành, Phường An Phú, TP. Thủ Đức, TP. Hồ Chí Minh',
      status: 'ACTIVE',
    },
  });

  // Link StoreStaff
  await prisma.storeStaff.upsert({
    where: { uq_store_staff_store_user: { storeId: store1.storeId, userId: storeOwner1.userId } },
    update: { status: 'ACTIVE' },
    create: {
      storeId: store1.storeId,
      userId: storeOwner1.userId,
      roleId: roleStoreOwner.roleId,
      status: 'ACTIVE',
    },
  });

  await prisma.storeStaff.upsert({
    where: { uq_store_staff_store_user: { storeId: store2.storeId, userId: storeOwner2.userId } },
    update: { status: 'ACTIVE' },
    create: {
      storeId: store2.storeId,
      userId: storeOwner2.userId,
      roleId: roleStoreOwner.roleId,
      status: 'ACTIVE',
    },
  });

  console.log('📦 Creating Customer Profile & Addresses (Global Customer)...');
  const customerProfile = await prisma.customerProfile.upsert({
    where: { userId: customerUser.userId },
    update: { phone: customerUser.phone },
    create: {
      userId: customerUser.userId,
      phone: customerUser.phone,
    },
  });

  let customerAddress = await prisma.customerAddress.findFirst({
    where: { customerId: customerProfile.customerId },
  });

  if (!customerAddress) {
    customerAddress = await prisma.customerAddress.create({
      data: {
        customerId: customerProfile.customerId,
        recipientName: 'Nguyễn Văn An',
        phone: '0988776655',
        addressDetail: 'Căn hộ 12.04, Tháp A, Chung cư Masteri Thảo Điền',
        ward: 'Phường Thảo Điền',
        district: 'Thành phố Thủ Đức',
        province: 'TP. Hồ Chí Minh',
        isDefault: true,
      },
    });
  }

  console.log('🗂️ Creating Store Categories & Products...');
  const catWater = await prisma.category.upsert({
    where: { uq_category_store_pair: { storeId: store1.storeId, categoryId: BigInt(1) } },
    update: { categoryName: 'Nước uống đóng bình' },
    create: {
      storeId: store1.storeId,
      categoryName: 'Nước uống đóng bình',
      status: 'ACTIVE',
    },
  });

  const catGas = await prisma.category.upsert({
    where: { uq_category_store_pair: { storeId: store1.storeId, categoryId: BigInt(2) } },
    update: { categoryName: 'Khí đốt & Gas gia đình' },
    create: {
      storeId: store1.storeId,
      categoryName: 'Khí đốt & Gas gia đình',
      status: 'ACTIVE',
    },
  });

  // Products for Store 1
  const prodWater = await prisma.product.upsert({
    where: { uq_product_store_code: { storeId: store1.storeId, productCode: 'PROD-WTR-01' } },
    update: { basePrice: 65000, status: 'ACTIVE' },
    create: {
      storeId: store1.storeId,
      categoryId: catWater.categoryId,
      productCode: 'PROD-WTR-01',
      productName: 'Nước khoáng thiên nhiên La Vie 19L',
      brand: 'La Vie (Nestlé)',
      description: 'Bình úp dùng cho máy nóng lạnh hoặc bình sứ',
      basePrice: 65000,
      status: 'ACTIVE',
    },
  });

  const prodGas = await prisma.product.upsert({
    where: { uq_product_store_code: { storeId: store1.storeId, productCode: 'PROD-GAS-01' } },
    update: { basePrice: 420000, status: 'ACTIVE' },
    create: {
      storeId: store1.storeId,
      categoryId: catGas.categoryId,
      productCode: 'PROD-GAS-01',
      productName: 'Bình Gas Petrolimex 12kg Van Ngang',
      brand: 'Petrolimex Gas',
      description: 'Bình gas 12kg đạt chuẩn an toàn PCCC, tem chống hàng giả',
      basePrice: 420000,
      status: 'ACTIVE',
    },
  });

  // Inventory for Products
  await prisma.inventory.upsert({
    where: { productId: prodWater.productId },
    update: { quantityOnHand: 150, reservedQuantity: 0 },
    create: {
      storeId: store1.storeId,
      productId: prodWater.productId,
      quantityOnHand: 150,
      reservedQuantity: 0,
      minStockAlert: 10,
    },
  });

  await prisma.inventory.upsert({
    where: { productId: prodGas.productId },
    update: { quantityOnHand: 80, reservedQuantity: 0 },
    create: {
      storeId: store1.storeId,
      productId: prodGas.productId,
      quantityOnHand: 80,
      reservedQuantity: 0,
      minStockAlert: 5,
    },
  });

  console.log('🔘 Creating IoT Buttons (Fixed Store & Multi-Product Configuration)...');
  // Button 1: BTN-8829-WTR (used in automated test suite)
  const button1 = await prisma.ioTButton.upsert({
    where: { deviceId: 'BTN-8829-WTR' },
    update: {
      storeId: store1.storeId,
      customerId: customerProfile.customerId,
      addressId: customerAddress.addressId,
      buttonName: 'Nút Nước Lavie Bếp',
      status: 'ACTIVE',
    },
    create: {
      storeId: store1.storeId,
      customerId: customerProfile.customerId,
      addressId: customerAddress.addressId,
      deviceId: 'BTN-8829-WTR',
      buttonCode: 'BTN-8829-WTR',
      buttonName: 'Nút Nước Lavie Bếp',
      status: 'ACTIVE',
      installedAt: new Date(),
    },
  });

  // Assign product to Button 1
  await prisma.buttonProduct.upsert({
    where: { uq_button_product: { buttonId: button1.buttonId, productId: prodWater.productId } },
    update: { quantity: 2 },
    create: {
      buttonId: button1.buttonId,
      productId: prodWater.productId,
      quantity: 2,
    },
  });

  // Button 2: BTN-7711-GAS
  const button2 = await prisma.ioTButton.upsert({
    where: { deviceId: 'BTN-7711-GAS' },
    update: {
      storeId: store1.storeId,
      customerId: customerProfile.customerId,
      addressId: customerAddress.addressId,
      buttonName: 'Nút Đổi Bình Gas Nhà Bếp',
      status: 'ACTIVE',
    },
    create: {
      storeId: store1.storeId,
      customerId: customerProfile.customerId,
      addressId: customerAddress.addressId,
      deviceId: 'BTN-7711-GAS',
      buttonCode: 'BTN-7711-GAS',
      buttonName: 'Nút Đổi Bình Gas Nhà Bếp',
      status: 'ACTIVE',
      installedAt: new Date(),
    },
  });

  await prisma.buttonProduct.upsert({
    where: { uq_button_product: { buttonId: button2.buttonId, productId: prodGas.productId } },
    update: { quantity: 1 },
    create: {
      buttonId: button2.buttonId,
      productId: prodGas.productId,
      quantity: 1,
    },
  });

  // Automatic StoreCustomer relation (BRD-CUSTOMER-05)
  await prisma.storeCustomer.upsert({
    where: { uq_store_customer: { storeId: store1.storeId, customerId: customerProfile.customerId } },
    update: { status: 'ACTIVE' },
    create: {
      storeId: store1.storeId,
      customerId: customerProfile.customerId,
      status: 'ACTIVE',
    },
  });

  console.log('\n======================================================');
  console.log('✅ DATABASE SEED COMPLETED SUCCESSFULLY!');
  console.log('======================================================');
  console.log('🔑 Credentials:');
  console.log('   - Super Admin: admin@smartorder.local / Password123!');
  console.log('   - Store Owner: store@smartorder.local / Password123!');
  console.log('   - Customer:    customer@smartorder.local / Password123!');
  console.log('🔘 IoT Test Buttons:');
  console.log('   - BTN-8829-WTR (Store 1: La Vie 19L x 2)');
  console.log('   - BTN-7711-GAS (Store 1: Gas Petrolimex 12kg x 1)');
  console.log('======================================================\n');
}

main()
  .catch((e) => {
    console.error('❌ Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
