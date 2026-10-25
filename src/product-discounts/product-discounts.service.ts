import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ProductDiscountsRepository } from './product-discounts.repository';
import { CreateProductDiscountDto } from './dto/create-product-discount.dto';
import { UpdateProductDiscountDto } from './dto/update-product-discount.dto';
import { ProductDiscountResponseDto } from './dto/product-discount-response.dto';

@Injectable()
export class ProductDiscountsService {
  constructor(private readonly repo: ProductDiscountsRepository) {}

  async validateProductAndStoreAccess(user: any, productId: bigint) {
    if (!user) {
      throw new ForbiddenException('Yêu cầu xác thực người dùng');
    }

    const product = await this.repo.findProductById(productId);
    if (!product) {
      throw new NotFoundException('Không tìm thấy sản phẩm');
    }

    if (user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN') {
      return product;
    }

    const userId = BigInt(user.userId || user.id);
    const hasAccess = await this.repo.isUserStoreManagerOrOwner(userId, product.storeId);
    if (!hasAccess) {
      throw new ForbiddenException('Bạn không có quyền quản lý chương trình giảm giá của sản phẩm này');
    }

    return product;
  }

  async listProductDiscounts(productIdStr: string): Promise<ProductDiscountResponseDto[]> {
    let productId: bigint;
    try {
      productId = BigInt(productIdStr);
    } catch {
      throw new BadRequestException('Mã sản phẩm không hợp lệ');
    }

    const discounts = await this.repo.findByProductId(productId);
    return discounts.map((d) => ProductDiscountResponseDto.fromEntity(d));
  }

  async getDiscountById(discountIdStr: string): Promise<ProductDiscountResponseDto> {
    let discountId: bigint;
    try {
      discountId = BigInt(discountIdStr);
    } catch {
      throw new BadRequestException('Mã chương trình giảm giá không hợp lệ');
    }

    const discount = await this.repo.findById(discountId);
    if (!discount) {
      throw new NotFoundException('Không tìm thấy chương trình giảm giá');
    }

    return ProductDiscountResponseDto.fromEntity(discount);
  }

  async createDiscount(
    user: any,
    productIdStr: string,
    dto: CreateProductDiscountDto,
  ): Promise<ProductDiscountResponseDto> {
    let productId: bigint;
    try {
      productId = BigInt(productIdStr);
    } catch {
      throw new BadRequestException('Mã sản phẩm không hợp lệ');
    }

    const product = await this.validateProductAndStoreAccess(user, productId);

    // 1. Exclusivity check
    const hasPercent = dto.discountPercent !== undefined && dto.discountPercent !== null;
    const hasAmount = dto.discountAmount !== undefined && dto.discountAmount !== null;
    if ((hasPercent && hasAmount) || (!hasPercent && !hasAmount)) {
      throw new BadRequestException('Phải cung cấp chính xác một trong hai giá trị: discountPercent hoặc discountAmount');
    }

    // 2. Time validity check
    const start = new Date(dto.startAt);
    const end = new Date(dto.endAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('Thời gian bắt đầu hoặc kết thúc không hợp lệ');
    }
    if (start >= end) {
      throw new BadRequestException('Thời gian bắt đầu (startAt) phải trước thời gian kết thúc (endAt)');
    }

    // 3. Amount vs Base price
    if (hasAmount && dto.discountAmount! > Number(product.basePrice)) {
      throw new BadRequestException('Số tiền giảm giá không được vượt quá giá gốc của sản phẩm');
    }

    // 4. Overlap check for ACTIVE status
    const status = dto.status || 'ACTIVE';
    if (status === 'ACTIVE') {
      const overlapCount = await this.repo.countActiveOverlapping(productId, start, end);
      if (overlapCount > 0) {
        throw new BadRequestException('Khoảng thời gian giảm giá bị trùng lặp với một chương trình giảm giá đang hoạt động khác của sản phẩm này');
      }
    }

    const created = await this.repo.create({
      productId,
      discountPercent: hasPercent ? dto.discountPercent : null,
      discountAmount: hasAmount ? dto.discountAmount : null,
      startAt: start,
      endAt: end,
      status,
    });

    return ProductDiscountResponseDto.fromEntity(created);
  }

  async updateDiscount(
    user: any,
    discountIdStr: string,
    dto: UpdateProductDiscountDto,
  ): Promise<ProductDiscountResponseDto> {
    let discountId: bigint;
    try {
      discountId = BigInt(discountIdStr);
    } catch {
      throw new BadRequestException('Mã chương trình giảm giá không hợp lệ');
    }

    const existing = await this.repo.findById(discountId);
    if (!existing) {
      throw new NotFoundException('Không tìm thấy chương trình giảm giá');
    }

    await this.validateProductAndStoreAccess(user, existing.productId);

    // Resolve target values
    const targetPercent =
      dto.discountPercent !== undefined ? dto.discountPercent : (existing.discountPercent ? Number(existing.discountPercent) : null);
    const targetAmount =
      dto.discountAmount !== undefined ? dto.discountAmount : (existing.discountAmount ? Number(existing.discountAmount) : null);

    const hasPercent = targetPercent !== null;
    const hasAmount = targetAmount !== null;

    if ((hasPercent && hasAmount) || (!hasPercent && !hasAmount)) {
      throw new BadRequestException('Phải cung cấp chính xác một trong hai giá trị: discountPercent hoặc discountAmount');
    }

    const start = dto.startAt ? new Date(dto.startAt) : existing.startAt;
    const end = dto.endAt ? new Date(dto.endAt) : existing.endAt;

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('Thời gian bắt đầu hoặc kết thúc không hợp lệ');
    }
    if (start >= end) {
      throw new BadRequestException('Thời gian bắt đầu (startAt) phải trước thời gian kết thúc (endAt)');
    }

    if (hasAmount && targetAmount! > Number(existing.product.basePrice)) {
      throw new BadRequestException('Số tiền giảm giá không được vượt quá giá gốc của sản phẩm');
    }

    const targetStatus = dto.status || existing.status;
    if (targetStatus === 'ACTIVE') {
      const overlapCount = await this.repo.countActiveOverlapping(existing.productId, start, end, discountId);
      if (overlapCount > 0) {
        throw new BadRequestException('Khoảng thời gian giảm giá bị trùng lặp với một chương trình giảm giá đang hoạt động khác của sản phẩm này');
      }
    }

    const updated = await this.repo.update(discountId, {
      discountPercent: targetPercent,
      discountAmount: targetAmount,
      startAt: start,
      endAt: end,
      status: targetStatus,
    });

    return ProductDiscountResponseDto.fromEntity(updated);
  }

  async deleteDiscount(user: any, discountIdStr: string): Promise<void> {
    let discountId: bigint;
    try {
      discountId = BigInt(discountIdStr);
    } catch {
      throw new BadRequestException('Mã chương trình giảm giá không hợp lệ');
    }

    const existing = await this.repo.findById(discountId);
    if (!existing) {
      throw new NotFoundException('Không tìm thấy chương trình giảm giá');
    }

    await this.validateProductAndStoreAccess(user, existing.productId);

    await this.repo.delete(discountId);
  }
}
