import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WarrantyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findTickets(where: any, skip: number, take: number) {
    return this.prisma.warrantyTicket.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        button: true,
        replacementButton: true,
        store: true,
        reportedByUser: true,
        customer: true,
      },
    });
  }

  async countTickets(where: any): Promise<number> {
    return this.prisma.warrantyTicket.count({ where });
  }

  async findTicketById(ticketId: bigint) {
    return this.prisma.warrantyTicket.findUnique({
      where: { ticketId },
      include: {
        button: true,
        replacementButton: true,
        store: true,
        reportedByUser: true,
        customer: true,
      },
    });
  }

  async findButtonByDeviceId(deviceId: string) {
    return this.prisma.ioTButton.findUnique({
      where: { deviceId },
      include: { store: true, customer: true },
    });
  }

  async findButtonById(buttonId: bigint) {
    return this.prisma.ioTButton.findUnique({
      where: { buttonId },
      include: { store: true, customer: true },
    });
  }

  async findAvailableReplacementButton(deviceId?: string) {
    if (deviceId) {
      return this.prisma.ioTButton.findFirst({
        where: {
          deviceId,
          status: { in: ['ACTIVE', 'INACTIVE'] },
          inventoryState: { in: ['IN_PLATFORM_WAREHOUSE', 'IN_STORE'] },
        },
      });
    }
    // Lấy nút sẵn sàng trong kho
    return this.prisma.ioTButton.findFirst({
      where: {
        status: { in: ['ACTIVE', 'INACTIVE'] },
        inventoryState: 'IN_PLATFORM_WAREHOUSE',
        customerId: null,
      },
    });
  }

  async createTicket(data: {
    ticketCode: string;
    buttonId: bigint;
    storeId?: bigint | null;
    customerId?: bigint | null;
    reportedByUserId: bigint;
    faultGroup: string;
    faultCode: string;
    depositAmount: number;
    deductionPercent: number;
    deductionAmount: number;
    refundAmount: number;
    inspectionNote?: string;
  }) {
    return this.prisma.warrantyTicket.create({
      data: {
        ticketCode: data.ticketCode,
        buttonId: data.buttonId,
        storeId: data.storeId || null,
        customerId: data.customerId || null,
        reportedByUserId: data.reportedByUserId,
        faultGroup: data.faultGroup,
        faultCode: data.faultCode,
        depositAmount: data.depositAmount,
        deductionPercent: data.deductionPercent,
        deductionAmount: data.deductionAmount,
        refundAmount: data.refundAmount,
        inspectionNote: data.inspectionNote,
        status: 'PENDING',
      },
      include: {
        button: true,
        store: true,
        reportedByUser: true,
      },
    });
  }

  async approveSwapAtomicTx(
    ticketId: bigint,
    replacementButtonId: bigint,
    adminUserId: bigint,
    adminNote?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock và kiểm tra ticket
      const ticket = await tx.warrantyTicket.findUnique({
        where: { ticketId },
        include: { button: true },
      });
      if (!ticket) throw new NotFoundException('Không tìm thấy phiếu bảo hành');
      if (ticket.status !== 'PENDING') {
        throw new BadRequestException(`Phiếu bảo hành đang ở trạng thái ${ticket.status}, không thể duyệt đổi`);
      }

      const oldButton = ticket.button;
      const newButton = await tx.ioTButton.findUnique({
        where: { buttonId: replacementButtonId },
      });
      if (!newButton) throw new NotFoundException('Không tìm thấy thiết bị thay thế');

      // 2. Chuyển nút cũ sang DEFECTIVE_RETURN
      await tx.ioTButton.update({
        where: { buttonId: oldButton.buttonId },
        data: {
          inventoryState: 'DEFECTIVE_RETURN',
          status: 'INACTIVE',
          canOrder: false,
          customerId: null,
        },
      });

      // 3. Gán nút mới cho Store/Customer
      await tx.ioTButton.update({
        where: { buttonId: newButton.buttonId },
        data: {
          storeId: ticket.storeId || oldButton.storeId,
          customerId: ticket.customerId || oldButton.customerId,
          inventoryState: 'WITH_CUSTOMER',
          status: 'ACTIVE',
          canOrder: true,
        },
      });

      // 4. Ghi nhận lịch sử điều chuyển thiết bị
      await tx.deviceMovement.create({
        data: {
          buttonId: oldButton.buttonId,
          sourceType: 'CUSTOMER',
          sourceStoreId: ticket.storeId,
          destType: 'WAREHOUSE',
          destStoreId: null,
          actorUserId: adminUserId,
          reason: `Thu hồi bảo hành phiếu #${ticket.ticketCode} (${ticket.faultCode})`,
        },
      });

      await tx.deviceMovement.create({
        data: {
          buttonId: newButton.buttonId,
          sourceType: 'WAREHOUSE',
          sourceStoreId: null,
          destType: 'CUSTOMER',
          destStoreId: ticket.storeId,
          actorUserId: adminUserId,
          reason: `Cấp đổi 1-1 cho phiếu #${ticket.ticketCode}`,
        },
      });

      // 5. Cập nhật trạng thái phiếu bảo hành
      const updatedTicket = await tx.warrantyTicket.update({
        where: { ticketId },
        data: {
          status: 'APPROVED_SWAP',
          replacementButtonId,
          adminNote: adminNote || ticket.adminNote,
          updatedAt: new Date(),
        },
        include: {
          button: true,
          replacementButton: true,
          store: true,
          reportedByUser: true,
        },
      });

      return updatedTicket;
    });
  }

  async lockDeviceAtomicTx(
    ticketId: bigint,
    adminUserId: bigint,
    adminNote?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.warrantyTicket.findUnique({
        where: { ticketId },
        include: { button: true },
      });
      if (!ticket) throw new NotFoundException('Không tìm thấy phiếu bảo hành');

      // Khóa nút cũ
      await tx.ioTButton.update({
        where: { buttonId: ticket.buttonId },
        data: {
          status: 'DISABLED',
          inventoryState: 'DEFECTIVE_RETURN',
          canOrder: false,
        },
      });

      // Ghi log luân chuyển
      await tx.deviceMovement.create({
        data: {
          buttonId: ticket.buttonId,
          sourceType: 'CUSTOMER',
          sourceStoreId: ticket.storeId,
          destType: 'LOCKED',
          destStoreId: null,
          actorUserId: adminUserId,
          reason: `Khóa nút hư hỏng nặng (Nhóm D) theo phiếu #${ticket.ticketCode}`,
        },
      });

      // Cập nhật phiếu sang RESOLVED
      return tx.warrantyTicket.update({
        where: { ticketId },
        data: {
          status: 'RESOLVED',
          adminNote: adminNote || ticket.adminNote,
          updatedAt: new Date(),
        },
        include: {
          button: true,
          store: true,
          reportedByUser: true,
        },
      });
    });
  }

  async updateTicketStatus(
    ticketId: bigint,
    status: 'RESOLVED' | 'REJECTED',
    adminNote?: string,
  ) {
    return this.prisma.warrantyTicket.update({
      where: { ticketId },
      data: {
        status,
        ...(adminNote ? { adminNote } : {}),
        updatedAt: new Date(),
      },
      include: {
        button: true,
        replacementButton: true,
        store: true,
        reportedByUser: true,
      },
    });
  }
}
