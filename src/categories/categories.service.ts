import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { CategoriesRepository } from './categories.repository';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CategoryResponseDto } from './dto/category-response.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly repo: CategoriesRepository) {}

  async validateStoreAccess(user: any, storeId: bigint): Promise<void> {
    if (!user) {
      throw new ForbiddenException('Yêu cầu xác thực người dùng');
    }

    if (user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN') {
      return;
    }

    const userId = BigInt(user.userId || user.id);
    const hasAccess = await this.repo.isUserStoreManagerOrOwner(userId, storeId);
    if (!hasAccess) {
      throw new ForbiddenException('Bạn không có quyền quản lý danh mục của cửa hàng này');
    }
  }

  async assertNoCycle(
    storeId: bigint,
    categoryId: bigint,
    candidateParentId: bigint,
  ): Promise<void> {
    if (categoryId === candidateParentId) {
      throw new BadRequestException('Một danh mục không thể làm cha của chính nó');
    }

    let currentParentId: bigint | null = candidateParentId;
    const visited = new Set<string>();
    visited.add(categoryId.toString());

    while (currentParentId) {
      const parentStr = currentParentId.toString();
      if (visited.has(parentStr)) {
        throw new BadRequestException('Phát hiện vòng lặp phân cấp danh mục (cycle detected)');
      }
      visited.add(parentStr);

      const parentNode = await this.repo.findByStoreAndId(storeId, currentParentId);
      if (!parentNode) {
        throw new BadRequestException('Danh mục cha không tồn tại trong cửa hàng này');
      }
      currentParentId = parentNode.parentCategoryId;
    }
  }

  async listStoreCategories(
    storeIdStr: string,
    mode: 'flat' | 'tree' = 'tree',
  ): Promise<CategoryResponseDto[]> {
    let storeId: bigint;
    try {
      storeId = BigInt(storeIdStr);
    } catch {
      throw new BadRequestException('Mã cửa hàng không hợp lệ');
    }

    const categories = await this.repo.findByStoreId(storeId);
    if (mode === 'flat') {
      return categories.map((c) => CategoryResponseDto.fromEntity(c));
    }
    return CategoryResponseDto.buildTree(categories);
  }

  async getCategoryById(idStr: string): Promise<CategoryResponseDto> {
    let categoryId: bigint;
    try {
      categoryId = BigInt(idStr);
    } catch {
      throw new BadRequestException('Mã danh mục không hợp lệ');
    }

    const category = await this.repo.findById(categoryId);
    if (!category) {
      throw new NotFoundException('Không tìm thấy danh mục');
    }

    return CategoryResponseDto.fromEntity(category);
  }

  async createCategory(
    user: any,
    storeIdStr: string,
    dto: CreateCategoryDto,
  ): Promise<CategoryResponseDto> {
    let storeId: bigint;
    try {
      storeId = BigInt(storeIdStr);
    } catch {
      throw new BadRequestException('Mã cửa hàng không hợp lệ');
    }

    await this.validateStoreAccess(user, storeId);

    let parentId: bigint | null = null;
    if (dto.parentCategoryId) {
      try {
        parentId = BigInt(dto.parentCategoryId);
      } catch {
        throw new BadRequestException('Mã danh mục cha không hợp lệ');
      }

      const parentCategory = await this.repo.findByStoreAndId(storeId, parentId);
      if (!parentCategory) {
        throw new BadRequestException('Danh mục cha không tồn tại trong cửa hàng này');
      }
    }

    const created = await this.repo.create({
      storeId,
      categoryName: dto.categoryName,
      parentCategoryId: parentId,
      status: dto.status || 'ACTIVE',
    });

    return CategoryResponseDto.fromEntity(created);
  }

  async updateCategory(
    user: any,
    categoryIdStr: string,
    dto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    let categoryId: bigint;
    try {
      categoryId = BigInt(categoryIdStr);
    } catch {
      throw new BadRequestException('Mã danh mục không hợp lệ');
    }

    const existing = await this.repo.findById(categoryId);
    if (!existing) {
      throw new NotFoundException('Không tìm thấy danh mục');
    }

    await this.validateStoreAccess(user, existing.storeId);

    let parentId: bigint | null | undefined = undefined;
    if (dto.parentCategoryId !== undefined) {
      if (dto.parentCategoryId === null || dto.parentCategoryId === '') {
        parentId = null;
      } else {
        try {
          parentId = BigInt(dto.parentCategoryId);
        } catch {
          throw new BadRequestException('Mã danh mục cha không hợp lệ');
        }

        await this.assertNoCycle(existing.storeId, categoryId, parentId);
      }
    }

    const updated = await this.repo.update(categoryId, {
      categoryName: dto.categoryName,
      parentCategoryId: parentId,
      status: dto.status,
    });

    return CategoryResponseDto.fromEntity(updated);
  }

  async deleteCategory(user: any, categoryIdStr: string): Promise<void> {
    let categoryId: bigint;
    try {
      categoryId = BigInt(categoryIdStr);
    } catch {
      throw new BadRequestException('Mã danh mục không hợp lệ');
    }

    const existing = await this.repo.findById(categoryId);
    if (!existing) {
      throw new NotFoundException('Không tìm thấy danh mục');
    }

    await this.validateStoreAccess(user, existing.storeId);

    // Soft-delete to INACTIVE preserving product associations
    await this.repo.update(categoryId, { status: 'INACTIVE' });
  }
}
