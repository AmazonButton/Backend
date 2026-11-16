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
      include: { store: true, customer: true, rental: true },
    });
  }

  async findButtonById(buttonId: bigint) {
    return this.prisma.ioTButton.findUnique({
      where: { buttonId },
      include: { store: true, customer: true, rental: true },
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
      if (ticket.faultGroup !== 'GROUP_A') {
        throw new BadRequestException(
          'Chỉ hỗ trợ duyệt đổi 1-1 miễn phí cho thiết bị thuộc Nhóm A (Lỗi kỹ thuật tự nhiên 0% khấu trừ).',
        );
      }

      const oldButton = ticket.button;
      const newButton = await tx.ioTButton.findUnique({
        where: { buttonId: replacementButtonId },
      });
      if (!newButton) throw new NotFoundException('Không tìm thấy thiết bị thay thế');

      // 2. Chuyển nút cũ sang DEFECTIVE_RETURN và gỡ liên kết hợp đồng/khách hàng
      await tx.ioTButton.update({
        where: { buttonId: oldButton.buttonId },
        data: {
          inventoryState: 'DEFECTIVE_RETURN',
          status: 'INACTIVE',
          canOrder: false,
          customerId: null,
          rentalId: null,
          addressId: null,
        },
      });

      // 3. Gán nút mới kế thừa đầy đủ Store, Customer, Rental, Address và trạng thái IN_CUSTOMER_CUSTODY
      await tx.ioTButton.update({
        where: { buttonId: newButton.buttonId },
        data: {
          storeId: ticket.storeId || oldButton.storeId,
          customerId: ticket.customerId || oldButton.customerId,
          rentalId: oldButton.rentalId,
          addressId: oldButton.addressId,
          inventoryState: 'IN_CUSTOMER_CUSTODY',
          status: 'ACTIVE',
          canOrder: true,
        },
      });

      // 3.1. Chuyển cấu hình sản phẩm đặt hàng (buttonProducts) từ nút cũ sang nút mới
      await tx.buttonProduct.deleteMany({
        where: { buttonId: newButton.buttonId },
      });
      await tx.buttonProduct.updateMany({
        where: { buttonId: oldButton.buttonId },
        data: { buttonId: newButton.buttonId },
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

      const oldRentalId = ticket.button?.rentalId || null;
      const oldCustomerId = ticket.customerId || ticket.button?.customerId || null;

      // 1. Khóa nút hỏng và gỡ khỏi hợp đồng thuê / khách hàng
      await tx.ioTButton.update({
        where: { buttonId: ticket.buttonId },
        data: {
          status: 'DISABLED',
          inventoryState: 'DEFECTIVE_RETURN',
          canOrder: false,
          rentalId: null,
          customerId: null,
          addressId: null,
        },
      });

      // 2. Khấu trừ tiền phạt vào sổ cái tiền cọc (rental_deposits) và tạo lệnh hoàn phần cọc dư nếu có
      if (oldRentalId) {
        const lockedLedgers = await tx.$queryRawUnsafe<any[]>(
          'SELECT * FROM rental_deposits WHERE rental_id = $1 FOR UPDATE',
          oldRentalId,
        );
        const ledger = lockedLedgers && lockedLedgers.length > 0 ? lockedLedgers[0] : null;
        if (ledger) {
          const heldBefore = Number(ledger.held_amount || 0);
          const deductionAmt = Math.max(0, Number(ticket.deductionAmount || 0));
          const requestedRefundAmt = Math.max(0, Number(ticket.refundAmount || 0));
          const buttonCollateral = Math.min(heldBefore, deductionAmt + requestedRefundAmt);
          const actualRefundReserved = Math.max(0, buttonCollateral - deductionAmt);

          if (buttonCollateral > 0) {
            await tx.$executeRawUnsafe(
              `UPDATE rental_deposits
               SET held_amount = GREATEST(0, held_amount - $1),
                   refund_reserved_amount = refund_reserved_amount + $2,
                   updated_at = NOW()
               WHERE rental_id = $3`,
              buttonCollateral,
              actualRefundReserved,
              oldRentalId,
            );
          }

          if (actualRefundReserved > 0 && oldCustomerId) {
            const refundCode = `REF-WRT-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
            await tx.depositRefund.create({
              data: {
                refundCode,
                rentalId: oldRentalId,
                customerId: oldCustomerId,
                amount: actualRefundReserved,
                status: 'PENDING_APPROVAL',
              },
            });
          }
        }

        const remainingButtons = await tx.ioTButton.count({
          where: { rentalId: oldRentalId },
        });
        if (remainingButtons === 0) {
          await tx.buttonRental.update({
            where: { rentalId: oldRentalId },
            data: {
              status: 'RETURNED',
              returnedAt: new Date(),
            },
          });
        }
      }

      // 3. Ghi log luân chuyển
      await tx.deviceMovement.create({
        data: {
          buttonId: ticket.buttonId,
          sourceType: 'CUSTOMER',
          sourceStoreId: ticket.storeId,
          destType: 'LOCKED',
          destStoreId: null,
          rentalId: oldRentalId,
          actorUserId: adminUserId,
          reason: `Khóa nút hư hỏng/bồi thường (${ticket.faultGroup}) theo phiếu #${ticket.ticketCode}`,
        },
      });

      // 4. Cập nhật phiếu sang RESOLVED
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
