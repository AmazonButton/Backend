import { PrismaClient } from '@prisma/client';
import { ProductsService } from '../src/products/products.service';
import { ProductsRepository } from '../src/products/products.repository';
import * as http from 'https';

const prisma = new PrismaClient();

async function checkUrlReachable(url: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, (res) => {
        resolve(res.statusCode || 0);
      });
      req.on('error', () => resolve(0));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(0);
      });
    } catch {
      resolve(0);
    }
  });
}

async function runProductsImagesTestSuite() {
  console.log('================================================================================');
  console.log('⚡ PRODUCTS & PRODUCT-IMAGE ARCHITECTURE TEST SUITE');
  console.log('================================================================================\n');

  const productsRepo = new ProductsRepository(prisma as any);
  const mediaServiceMock = {
    deleteAsset: async (publicId: string) => true,
  };
  const subscriptionsServiceMock = {
    validateStoreCanListProducts: async () => true,
  };

  const productsService = new ProductsService(
    productsRepo,
    subscriptionsServiceMock as any,
    mediaServiceMock as any,
  );

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const ts = Date.now();
  const createdProductIds: bigint[] = [];

  try {
    // -------------------------------------------------------------------------
    // 1. Tạo Product có 1 ảnh
    // -------------------------------------------------------------------------
    console.log('[SECTION 1] TẠO PRODUCT CÓ 1 ẢNH & KIỂM TRA MAPPING CONTRACT');
    const storeUser1 = { userId: 9999, storeId: '1', role: 'STORE_OWNER' };
    const sampleSeedUrl = 'https://res.cloudinary.com/daiqbvy5y/image/upload/v1791547378/smart-order/lavie-water-19l.svg';

    const p1 = await productsService.create(storeUser1, {
      productName: `Test Water ${ts}`,
      productCode: `P-WTR-${ts}`,
      basePrice: 50000,
      imageUrl: sampleSeedUrl,
    });
    createdProductIds.push(BigInt(p1.productId));

    assert(p1.imageUrl === sampleSeedUrl, 'Response trả đúng imageUrl cấp gốc');
    assert(p1.thumbnailUrl === sampleSeedUrl, 'Response trả đúng thumbnailUrl');
    assert(p1.images.length === 1 && p1.images[0].isThumbnail === true, 'Bảng ProductImage lưu 1 ảnh với isThumbnail=true');

    // -------------------------------------------------------------------------
    // 2 & 3. Tạo Product có nhiều ảnh & Chọn đúng thumbnail
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 2 & 3] TẠO PRODUCT CÓ NHIỀU ẢNH & CHỌN ĐÚNG THUMBNAIL');
    const multiImageProduct = await productsService.create(storeUser1, {
      productName: `Test Multi-Img ${ts}`,
      productCode: `P-MULTI-${ts}`,
      basePrice: 120000,
      imageDetails: [
        { imageUrl: 'https://example.com/gallery1.jpg', isThumbnail: false, displayOrder: 1 },
        { imageUrl: 'https://example.com/thumb-selected.jpg', isThumbnail: true, displayOrder: 0 },
        { imageUrl: 'https://example.com/gallery2.jpg', isThumbnail: false, displayOrder: 2 },
      ],
    });
    createdProductIds.push(BigInt(multiImageProduct.productId));

    assert(multiImageProduct.images.length === 3, 'Tạo sản phẩm có nhiều ảnh (3 ảnh) thành công');
    assert(
      multiImageProduct.imageUrl === 'https://example.com/thumb-selected.jpg',
      'imageUrl cấp gốc chọn chính xác ảnh được chỉ định isThumbnail=true',
    );
    assert(
      multiImageProduct.thumbnailUrl === 'https://example.com/thumb-selected.jpg',
      'thumbnailUrl cấp gốc chọn chính xác ảnh thumbnail',
    );

    // -------------------------------------------------------------------------
    // 4. GET /products trả imageUrl
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 4] GET /products (LIST) CONTRACT');
    const listRes = await productsService.list(1, { page: 1, pageSize: 5 });
    assert(listRes.data.length > 0, 'Lấy danh sách sản phẩm thành công');
    const firstListed = listRes.data[0];
    assert(
      firstListed.imageUrl !== undefined && firstListed.thumbnailUrl !== undefined,
      'Mỗi phần tử trong GET /products có đầy đủ trường imageUrl và thumbnailUrl',
    );

    // -------------------------------------------------------------------------
    // 5. GET /products/:id trả images đầy đủ
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 5] GET /products/:id (DETAIL) CONTRACT');
    const detail = await productsService.getById(multiImageProduct.productId);
    assert(detail.productId === multiImageProduct.productId, 'Lấy chi tiết sản phẩm thành công');
    assert(Array.isArray(detail.images) && detail.images.length === 3, 'Chi tiết sản phẩm trả đầy đủ mảng images[]');
    assert(
      detail.images[0].imageId && detail.images[0].imageUrl && detail.images[0].displayOrder !== undefined,
      'Cấu trúc phần tử image có đầy đủ imageId, imageUrl, isThumbnail, displayOrder',
    );

    // -------------------------------------------------------------------------
    // 6. Product không có ảnh trả null/[], không lỗi 500
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 6] PRODUCT KHÔNG CÓ ẢNH TRẢ NULL/[], ZERO CRASH');
    const noImgProduct = await productsService.create(storeUser1, {
      productName: `No Image Prod ${ts}`,
      productCode: `P-NOIMG-${ts}`,
      basePrice: 99000,
      imageDetails: [],
    });
    createdProductIds.push(BigInt(noImgProduct.productId));

    const noImgDetail = await productsService.getById(noImgProduct.productId);
    assert(
      noImgDetail.imageUrl === null && noImgDetail.thumbnailUrl === null && Array.isArray(noImgDetail.images) && noImgDetail.images.length === 0,
      'Product không có ảnh trả imageUrl=null, thumbnailUrl=null, images=[] và không lỗi 500',
    );

    // -------------------------------------------------------------------------
    // 7. Cập nhật ảnh không làm mất ảnh mới
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 7] CẬP NHẬT ẢNH SẢN PHẨM');
    const updated = await productsService.update(
      multiImageProduct.productId,
      {
        imageDetails: [
          { imageUrl: 'https://example.com/brand-new-image.jpg', isThumbnail: true, displayOrder: 0 },
        ],
      },
      storeUser1,
    );
    assert(
      updated.images.length === 1 && updated.imageUrl === 'https://example.com/brand-new-image.jpg',
      'Cập nhật ảnh thay thế danh sách ảnh cũ bằng ảnh mới chính xác',
    );

    // -------------------------------------------------------------------------
    // 8. Ảnh cũ không bị xóa khi còn Product khác tham chiếu & bảo vệ smart-order/...
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 8] BẢO VỆ ASSET CLOUDINARY KHI CÒN THAM CHIẾU & CATALOG SEED');
    let deleteAttemptedOnSeed = false;
    const testMediaTracking = {
      deleteAsset: async (pubId: string) => {
        if (pubId.startsWith('smart-order/')) {
          deleteAttemptedOnSeed = true;
        }
        return true;
      },
    };
    const testSvcProtection = new ProductsService(
      productsRepo,
      subscriptionsServiceMock as any,
      testMediaTracking as any,
    );

    // Update p1 (đang dùng smart-order/lavie-water-19l) sang ảnh khác
    await testSvcProtection.update(
      p1.productId,
      {
        imageUrl: 'https://example.com/replacement.jpg',
      },
      storeUser1,
    );
    assert(!deleteAttemptedOnSeed, 'Ảnh seed catalog "smart-order/..." được bảo vệ tuyệt đối không bao giờ bị xóa');

    // -------------------------------------------------------------------------
    // 9. Phân quyền: Cửa hàng khác không được cập nhật/xóa sản phẩm của Store này
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 9] PHÂN QUYỀN TRUY CẬP (ACCESS CONTROL / IDOR PROTECTION)');
    const attackerUser = { userId: 8888, storeId: '99', role: 'STORE_OWNER' };
    let crossStoreBlocked = false;
    try {
      await productsService.update(p1.productId, { productName: 'Hacked Name' }, attackerUser);
    } catch (err: any) {
      crossStoreBlocked = err.status === 403 || err.message.includes('quyền');
    }
    assert(crossStoreBlocked, 'Chặn STORE_OWNER cửa hàng khác sửa/thay ảnh sản phẩm của Store 1');

    // -------------------------------------------------------------------------
    // 10. URL Cloudinary thật trả HTTP 200
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 10] KIỂM TRA HTTP HEALTH CỦA URL CLOUDINARY SEED');
    const cloudStatus = await checkUrlReachable(sampleSeedUrl);
    assert(cloudStatus === 200, `URL Cloudinary seed trả về HTTP status 200 OK (${cloudStatus})`);

    console.log('--------------------------------------------------------------------------------');
    console.log(`⚡ PRODUCTS & IMAGES TEST SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`);
    console.log('--------------------------------------------------------------------------------\n');
  } catch (err: any) {
    console.error('Fatal test error:', err);
    failed++;
  } finally {
    // Clean up created test products and images by exact ID
    try {
      for (const pid of createdProductIds) {
        await prisma.productImage.deleteMany({ where: { productId: pid } });
        await prisma.inventory.deleteMany({ where: { productId: pid } });
        await prisma.productPriceHistory.deleteMany({ where: { productId: pid } });
        await prisma.product.deleteMany({ where: { productId: pid } });
      }
    } catch (cleanupErr: any) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }
    await prisma.$disconnect();
  }

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runProductsImagesTestSuite();
