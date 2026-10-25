export class CategoryResponseDto {
  categoryId: string;
  storeId: string;
  parentCategoryId: string | null;
  categoryName: string;
  status: string;
  subCategories?: CategoryResponseDto[];
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(entity: any): CategoryResponseDto {
    return {
      categoryId: entity.categoryId.toString(),
      storeId: entity.storeId.toString(),
      parentCategoryId: entity.parentCategoryId ? entity.parentCategoryId.toString() : null,
      categoryName: entity.categoryName,
      status: entity.status,
      subCategories: entity.subCategories?.map((child: any) => CategoryResponseDto.fromEntity(child)),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }

  static buildTree(categories: any[]): CategoryResponseDto[] {
    const map = new Map<string, any>();
    const roots: CategoryResponseDto[] = [];

    // First pass: create node objects
    for (const cat of categories) {
      const node = CategoryResponseDto.fromEntity(cat);
      node.subCategories = [];
      map.set(node.categoryId, node);
    }

    // Second pass: attach children to parents
    for (const cat of categories) {
      const id = cat.categoryId.toString();
      const node = map.get(id);
      if (cat.parentCategoryId) {
        const parentId = cat.parentCategoryId.toString();
        const parent = map.get(parentId);
        if (parent) {
          parent.subCategories.push(node);
        } else {
          roots.push(node);
        }
      } else {
        roots.push(node);
      }
    }

    return roots;
  }
}
