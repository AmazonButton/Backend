import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateStoreMeDto } from './dto/update-store-me.dto';

@Injectable()
export class StoresRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findStoreForMe(storeId: bigint) {
    return this.prisma.store.findUnique({
      where: { storeId },
      include: {
        owner: true,
        wallet: true,
        subscriptions: {
          where: { status: 'ACTIVE' },
          include: { plan: true },
          orderBy: { endDate: 'desc' },
          take: 1,
        },
        bankAccounts: {
          orderBy: [{ isDefault: 'desc' }, { verifiedAt: 'desc' }],
        },
        _count: {
          select: { products: true },
        },
      },
    });
  }

  async findStoreByOwnerUserId(ownerUserId: bigint) {
    return this.prisma.store.findFirst({
      where: { ownerUserId },
    });
  }

  async updateStore(storeId: bigint, data: UpdateStoreMeDto) {
    const payload: any = {};
    if (data.name !== undefined) payload.name = data.name;
    if (data.email !== undefined) payload.email = data.email;
    if (data.phone !== undefined) payload.phone = data.phone;
    if (data.address !== undefined) payload.address = data.address;

    return this.prisma.store.update({
      where: { storeId },
      data: payload,
    });
  }
}
