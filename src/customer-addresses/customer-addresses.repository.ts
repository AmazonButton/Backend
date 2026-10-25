import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CustomerAddressesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProfileByUserId(userId: bigint) {
    return this.prisma.customerProfile.findUnique({
      where: { userId },
    });
  }

  async findProfileById(customerId: bigint) {
    return this.prisma.customerProfile.findUnique({
      where: { customerId },
    });
  }

  async createProfileForUser(userId: bigint, phone?: string | null) {
    return this.prisma.customerProfile.create({
      data: {
        userId,
        phone: phone || null,
      },
    });
  }

  async findAllByCustomerId(customerId: bigint) {
    return this.prisma.customerAddress.findMany({
      where: { customerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findByCustomerAndId(customerId: bigint, addressId: bigint) {
    return this.prisma.customerAddress.findUnique({
      where: {
        uq_customer_address_pair: {
          customerId,
          addressId,
        },
      },
    });
  }

  async countIoTButtonsByAddress(customerId: bigint, addressId: bigint): Promise<number> {
    return this.prisma.ioTButton.count({
      where: {
        customerId,
        addressId,
      },
    });
  }

  async createAddressTx(
    customerId: bigint,
    data: {
      recipientName: string;
      phone: string;
      addressDetail: string;
      ward?: string;
      district?: string;
      province?: string;
      latitude?: number;
      longitude?: number;
      isDefault?: boolean;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Lock customer profile row to serialize concurrent default address modifications
      await tx.$executeRaw`SELECT customer_id FROM customer_profile WHERE customer_id = ${customerId} FOR UPDATE`;

      const existingCount = await tx.customerAddress.count({
        where: { customerId },
      });

      const shouldBeDefault = data.isDefault ?? (existingCount === 0);

      if (shouldBeDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.customerAddress.create({
        data: {
          customerId,
          recipientName: data.recipientName,
          phone: data.phone,
          addressDetail: data.addressDetail,
          ward: data.ward || null,
          district: data.district || null,
          province: data.province || null,
          latitude: data.latitude != null ? data.latitude : null,
          longitude: data.longitude != null ? data.longitude : null,
          isDefault: shouldBeDefault,
        },
      });
    });
  }

  async updateAddressTx(
    customerId: bigint,
    addressId: bigint,
    data: {
      recipientName?: string;
      phone?: string;
      addressDetail?: string;
      ward?: string;
      district?: string;
      province?: string;
      latitude?: number;
      longitude?: number;
      isDefault?: boolean;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (data.isDefault === true) {
        // Lock customer profile row to serialize concurrent default address modifications
        await tx.$executeRaw`SELECT customer_id FROM customer_profile WHERE customer_id = ${customerId} FOR UPDATE`;

        await tx.customerAddress.updateMany({
          where: { customerId, isDefault: true, addressId: { not: addressId } },
          data: { isDefault: false },
        });
      }

      const updatePayload: any = {};
      if (data.recipientName !== undefined) updatePayload.recipientName = data.recipientName;
      if (data.phone !== undefined) updatePayload.phone = data.phone;
      if (data.addressDetail !== undefined) updatePayload.addressDetail = data.addressDetail;
      if (data.ward !== undefined) updatePayload.ward = data.ward;
      if (data.district !== undefined) updatePayload.district = data.district;
      if (data.province !== undefined) updatePayload.province = data.province;
      if (data.latitude !== undefined) updatePayload.latitude = data.latitude;
      if (data.longitude !== undefined) updatePayload.longitude = data.longitude;
      if (data.isDefault !== undefined) updatePayload.isDefault = data.isDefault;

      return tx.customerAddress.update({
        where: {
          uq_customer_address_pair: {
            customerId,
            addressId,
          },
        },
        data: updatePayload,
      });
    });
  }

  async deleteAddress(customerId: bigint, addressId: bigint) {
    return this.prisma.customerAddress.delete({
      where: {
        uq_customer_address_pair: {
          customerId,
          addressId,
        },
      },
    });
  }
}
