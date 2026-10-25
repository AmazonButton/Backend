export class CustomerAddressResponseDto {
  addressId: string;
  customerId: string;
  recipientName: string;
  phone: string;
  addressDetail: string;
  ward: string | null;
  district: string | null;
  province: string | null;
  latitude: number | null;
  longitude: number | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(entity: any): CustomerAddressResponseDto {
    return {
      addressId: entity.addressId.toString(),
      customerId: entity.customerId.toString(),
      recipientName: entity.recipientName,
      phone: entity.phone,
      addressDetail: entity.addressDetail,
      ward: entity.ward ?? null,
      district: entity.district ?? null,
      province: entity.province ?? null,
      latitude: entity.latitude != null ? Number(entity.latitude) : null,
      longitude: entity.longitude != null ? Number(entity.longitude) : null,
      isDefault: Boolean(entity.isDefault),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
