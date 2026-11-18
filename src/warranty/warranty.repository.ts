import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
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

  async findAvailableReplacementButton(deviceId?: string, excludeButtonId?: bigint) {
    const activeTicketExclusion = {
      replacementWarrantyTickets: {
        none: {
          status: { in: ['PENDING', 'APPROVED_SWAP', 'RESOLVED'] },
        },
      },
    };
    if (deviceId) {
      return this.prisma.ioTButton.findFirst({
        where: {
          deviceId,
          ...(excludeButtonId ? { buttonId: { not: excludeButtonId } } : {}),
          status: { in: ['ACTIVE', 'INACTIVE'] },
          inventoryState: { in: ['IN_PLATFORM_WAREHOUSE', 'IN_STORE', 'ALLOCATED_TO_STORE'] },
          customerId: null,
          rentalId: null,
          ...activeTicketExclusion,
        },
      });
    }
    // Lấy nút sẵn sàng trong kho tổng, chưa gán khách hàng/hợp đồng/phiếu bảo hành khác
    return this.prisma.ioTButton.findFirst({
      where: {
        ...(excludeButtonId ? { buttonId: { not: excludeButtonId } } : {}),
        status: { in: ['ACTIVE', 'INACTIVE'] },
        inventoryState: 'IN_PLATFORM_WAREHOUSE',
        customerId: null,
        rentalId: null,
        ...activeTicketExclusion,
      },
    });
  }

  private normalizeComparableId(value: any): bigint | null {
    return value == null ? null : BigInt(value);
  }

  /**
   * Đối chiếu thiết bị gốc sau khi đã giữ row lock với toàn bộ snapshot tại thời điểm lập phiếu:
   * - Chưa bị đổi/khóa trước đó
   * - Còn đúng customerId, storeId (nếu có) và ĐÚNG rentalId snapshot (không tự backfill từ hợp đồng hiện tại)
   */
  private assertSourceDeviceMatchesTicketSnapshot(ticket: any, currentButton: any): void {
    if (currentButton.inventoryState === 'DEFECTIVE_RETURN' || currentButton.status === 'DISABLED') {
      throw new ConflictException(
        'SOURCE_DEVICE_ALREADY_SWAPPED_OR_LOCKED: Thiết bị gốc đã được khóa hoặc đổi bảo hành trước đó',
      );
    }

    const ticketCustomerId = this.normalizeComparableId(ticket.customerId);
    const currentCustomerId = this.normalizeComparableId(currentButton.customerId);
    if (ticketCustomerId != null && currentCustomerId !== ticketCustomerId) {
      throw new ConflictException(
        'SOURCE_DEVICE_OWNERSHIP_CHANGED: Thiết bị gốc không còn gắn với khách hàng của phiếu bảo hành này',
      );
    }

    const ticketStoreId = this.normalizeComparableId(ticket.storeId);
    const currentStoreId = this.normalizeComparableId(currentButton.storeId);
    if (ticketStoreId != null && currentStoreId !== ticketStoreId) {
      throw new ConflictException(
        'SOURCE_DEVICE_STORE_MISMATCH: Thiết bị gốc không còn thuộc cửa hàng của phiếu bảo hành này',
      );
    }

    const snapshotRentalId = this.normalizeComparableId(ticket.rentalId);
    const currentRentalId = this.normalizeComparableId(currentButton.rentalId);
    if (snapshotRentalId !== currentRentalId) {
      throw new ConflictException(
        'SOURCE_DEVICE_RENTAL_MISMATCH: Hợp đồng thuê hiện tại của thiết bị không khớp với snapshot lúc tạo phiếu bảo hành (hoặc phiếu cũ thiếu snapshot hợp đồng) — yêu cầu đối soát thủ công trước khi xử lý',
      );
    }
  }

  async createTicket(data: {
    ticketCode: string;
    buttonId: bigint;
    storeId?: bigint | null;
    customerId?: bigint | null;
    rentalId?: bigint | null;
    reportedByUserId: bigint;
    faultGroup: string;
    faultCode: string;
    depositAmount: number;
    deductionPercent: number;
    deductionAmount: number;
    refundAmount: number;
    inspectionNote?: string;
  }) {
    const existingPending = await this.prisma.warrantyTicket.findFirst({
      where: { buttonId: data.buttonId, status: 'PENDING' },
      select: { ticketId: true, ticketCode: true },
    });
    if (existingPending) {
      throw new ConflictException(
        `DUPLICATE_PENDING_WARRANTY_TICKET: Thiết bị này đang có phiếu bảo hành #${existingPending.ticketCode} ở trạng thái PENDING`,
      );
    }

    try {
      return await this.prisma.warrantyTicket.create({
        data: {
          ticketCode: data.ticketCode,
          buttonId: data.buttonId,
          storeId: data.storeId || null,
          customerId: data.customerId || null,
          rentalId: data.rentalId ?? null,
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
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException(
          'DUPLICATE_PENDING_WARRANTY_TICKET: Thiết bị đang có phiếu bảo hành PENDING khác đang chờ xử lý',
        );
      }
      throw err;
    }
  }

  async approveSwapAtomicTx(
    ticketId: bigint,
    replacementButtonId: bigint,
    adminUserId: bigint,
    adminNote?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock và kiểm tra ticket
      await tx.$queryRaw`
        SELECT ticket_id FROM warranty_tickets WHERE ticket_id = ${ticketId} FOR UPDATE
      `;
      const ticket = await tx.warrantyTicket.findUnique({
        where: { ticketId },
        include: { button: { include: { rental: true } } },
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
      if (replacementButtonId === ticket.buttonId) {
        throw new BadRequestException('DUPLICATE_DEVICE_SWAP: Không thể đổi trùng với chính thiết bị đang lỗi');
      }

      // 1.1. Khóa cả 2 thiết bị theo thứ tự ID tăng dần để chống deadlock và chống đổi trùng đồng thời
      const [firstBtnId, secondBtnId] =
        ticket.buttonId < replacementButtonId
          ? [ticket.buttonId, replacementButtonId]
          : [replacementButtonId, ticket.buttonId];
      await tx.$queryRaw`
        SELECT button_id FROM iot_button
        WHERE button_id IN (${firstBtnId}, ${secondBtnId})
        ORDER BY button_id ASC
        FOR UPDATE
      `;

      const oldButton = await tx.ioTButton.findUnique({
        where: { buttonId: ticket.buttonId },
        include: { rental: true },
      });
      const newButton = await tx.ioTButton.findUnique({
        where: { buttonId: replacementButtonId },
      });
      if (!oldButton) throw new NotFoundException('Không tìm thấy thiết bị đang bảo hành');
      if (!newButton) throw new NotFoundException('Không tìm thấy thiết bị thay thế');

      // 1.05. Xác thực nút gốc chưa bị đổi/khóa và vẫn khớp toàn bộ snapshot (customer, store, rental) của phiếu
      this.assertSourceDeviceMatchesTicketSnapshot(ticket, oldButton);

      if (
        newButton.customerId != null ||
        newButton.rentalId != null ||
        newButton.status === 'DISABLED' ||
        ['IN_CUSTOMER_CUSTODY', 'DEFECTIVE_RETURN', 'RETURN_IN_TRANSIT', 'LOCKED'].includes(newButton.inventoryState)
      ) {
        throw new ConflictException('DEVICE_ALREADY_IN_USE: Thiết bị thay thế đang thuộc khách hàng/hợp đồng khác hoặc không sẵn sàng trong kho');
      }

      const duplicateTicket = await tx.warrantyTicket.findFirst({
        where: {
          replacementButtonId,
          ticketId: { not: ticketId },
          status: { in: ['PENDING', 'APPROVED_SWAP', 'RESOLVED'] },
        },
        select: { ticketId: true, ticketCode: true },
      });
      if (duplicateTicket) {
        throw new ConflictException(
          `DUPLICATE_REPLACEMENT_DEVICE: Thiết bị thay thế đã được gán cho phiếu #${duplicateTicket.ticketCode}`,
        );
      }

      // 1.2. Khóa hợp đồng thuê (nếu có) và xác thực hạn sử dụng để kế thừa chính xác
      let rentalRecord = oldButton.rental;
      if (oldButton.rentalId) {
        await tx.$queryRaw`
          SELECT rental_id FROM button_rentals WHERE rental_id = ${oldButton.rentalId} FOR UPDATE
        `;
        rentalRecord = await tx.buttonRental.findUnique({
          where: { rentalId: oldButton.rentalId },
        });
      }

      const expiryBoundary =
        rentalRecord?.effectiveExpiresAt || rentalRecord?.paidThrough || rentalRecord?.endDate || null;
      const isRentalActiveAndValid = Boolean(
        rentalRecord &&
          rentalRecord.status === 'ACTIVE' &&
          (!expiryBoundary || new Date(expiryBoundary) > new Date()),
      );
      const inheritedCanOrder = oldButton.rentalId
        ? isRentalActiveAndValid && oldButton.canOrder !== false
        : Boolean(oldButton.canOrder);

      const targetStoreId = ticket.storeId || oldButton.storeId;
      const targetCustomerId = ticket.customerId || oldButton.customerId;
      const targetCustodyStoreId = oldButton.custodyStoreId ?? targetStoreId;

      // 2. Chuyển nút cũ sang DEFECTIVE_RETURN và gỡ liên kết hợp đồng/khách hàng/cấu hình triển khai
      await tx.ioTButton.update({
        where: { buttonId: oldButton.buttonId },
        data: {
          inventoryState: 'DEFECTIVE_RETURN',
          status: 'INACTIVE',
          canOrder: false,
          customerId: null,
          rentalId: null,
          addressId: null,
          deployedTemplateId: null,
        },
      });

      // 3. Gán nút mới kế thừa đầy đủ Store, Customer, Rental (hạn sử dụng), Address và cấu hình phần cứng
      await tx.ioTButton.update({
        where: { buttonId: newButton.buttonId },
        data: {
          storeId: targetStoreId,
          custodyStoreId: targetCustodyStoreId,
          customerId: targetCustomerId,
          rentalId: oldButton.rentalId,
          addressId: oldButton.addressId,
          warrantyUntil: oldButton.warrantyUntil,
          clickBehavior: oldButton.clickBehavior,
          doubleClickWindowMs: oldButton.doubleClickWindowMs,
          holdDurationMs: oldButton.holdDurationMs,
          singlePressAction: oldButton.singlePressAction,
          doublePressAction: oldButton.doublePressAction,
          longPressAction: oldButton.longPressAction,
          cancelWindowSeconds: oldButton.cancelWindowSeconds,
          deployedTemplateId: oldButton.deployedTemplateId,
          installedAt: oldButton.installedAt ?? new Date(),
          inventoryState: targetCustomerId || oldButton.rentalId ? 'IN_CUSTOMER_CUSTODY' : 'IN_STORE',
          status: 'ACTIVE',
          canOrder: inheritedCanOrder,
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

      // 4. Ghi nhận lịch sử điều chuyển thiết bị (kèm rentalId để truy vết hợp đồng)
      await tx.deviceMovement.create({
        data: {
          buttonId: oldButton.buttonId,
          sourceType: 'CUSTOMER',
          sourceStoreId: targetStoreId,
          destType: 'WAREHOUSE',
          destStoreId: null,
          rentalId: oldButton.rentalId,
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
          destStoreId: targetStoreId,
          rentalId: oldButton.rentalId,
          actorUserId: adminUserId,
          reason: `Cấp đổi 1-1 cho phiếu #${ticket.ticketCode}`,
        },
      });

      // 5. Cập nhật trạng thái phiếu bảo hành & tự động đóng các phiếu PENDING trùng nút gốc (tuyệt đối không tự xác nhận hoàn tiền/payout)
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

      if (typeof tx.warrantyTicket.updateMany === 'function') {
        await tx.warrantyTicket.updateMany({
          where: {
            buttonId: oldButton.buttonId,
            ticketId: { not: ticketId },
            status: 'PENDING',
          },
          data: {
            status: 'REJECTED',
            adminNote: `Tự động đóng vì thiết bị đã được cấp đổi qua phiếu #${ticket.ticketCode}`,
          },
        });
      }

      return updatedTicket;
    });
  }

  async lockDeviceAtomicTx(
    ticketId: bigint,
    adminUserId: bigint,
    adminNote?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT ticket_id FROM warranty_tickets WHERE ticket_id = ${ticketId} FOR UPDATE
      `;
      const ticket = await tx.warrantyTicket.findUnique({
        where: { ticketId },
        include: { button: true },
      });
      if (!ticket) throw new NotFoundException('Không tìm thấy phiếu bảo hành');
      if (ticket.status !== 'PENDING') {
        throw new BadRequestException(`Phiếu bảo hành đang ở trạng thái ${ticket.status}, không thể khóa thiết bị lại`);
      }

      await tx.$queryRaw`
        SELECT button_id FROM iot_button WHERE button_id = ${ticket.buttonId} FOR UPDATE
      `;
      const lockedButton =
        typeof tx.ioTButton.findUnique === 'function'
          ? await tx.ioTButton.findUnique({ where: { buttonId: ticket.buttonId } })
          : ticket.button;

      if (!lockedButton) throw new NotFoundException('Không tìm thấy thiết bị cần khóa');
      this.assertSourceDeviceMatchesTicketSnapshot(ticket, lockedButton);

      const oldRentalId = ticket.rentalId != null ? BigInt(ticket.rentalId) : null;
      const oldCustomerId = ticket.customerId ?? lockedButton.customerId ?? ticket.button?.customerId ?? null;

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

      // 2. Tạo đề nghị hoàn/khấu trừ cọc PENDING_APPROVAL (KHÔNG trừ held_amount / cộng refund_reserved_amount trước khi Admin duyệt tài chính)
      if (oldRentalId) {
        const lockedLedgers = await tx.$queryRawUnsafe<any[]>(
          'SELECT * FROM rental_deposits WHERE rental_id = $1 FOR UPDATE',
          oldRentalId,
        );
        const ledger = lockedLedgers && lockedLedgers.length > 0 ? lockedLedgers[0] : null;
        if (ledger) {
          const heldAmount = Number(ledger.held_amount || 0);
          let reservedPendingCollateral = 0;
          if (typeof tx.$queryRawUnsafe === 'function') {
            const pendingRows = await tx.$queryRawUnsafe<any[]>(
              `SELECT COALESCE(SUM(amount + COALESCE(deduction_amount, 0)), 0) AS reserved_pending
               FROM deposit_refunds
               WHERE rental_id = $1 AND status = 'PENDING_APPROVAL'`,
              oldRentalId,
            );
            reservedPendingCollateral = Number(pendingRows?.[0]?.reserved_pending || 0);
          }
          const uncommittedHeld = Math.max(0, heldAmount - reservedPendingCollateral);
          const deductionAmt = Math.max(0, Number(ticket.deductionAmount || 0));
          const requestedRefundAmt = Math.max(0, Number(ticket.refundAmount || 0));
          const collateralToSettle = Math.min(uncommittedHeld, deductionAmt + requestedRefundAmt);
          const appliedDeduction = Math.min(collateralToSettle, deductionAmt);
          const appliedRefund = Math.max(0, collateralToSettle - appliedDeduction);

          if (collateralToSettle > 0 && oldCustomerId) {
            const refundCode = `REF-WRT-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
            await tx.depositRefund.create({
              data: {
                refundCode,
                warrantyTicketId: ticket.ticketId,
                rentalId: oldRentalId,
                customerId: oldCustomerId,
                amount: appliedRefund,
                deductionAmount: appliedDeduction,
                // Sổ cọc rental_deposits chỉ cập nhật MỘT LẦN khi Admin phê duyệt tài chính
                status: 'PENDING_APPROVAL',
                approvedByUserId: null,
                refundedAt: null,
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

      // 4. Cập nhật phiếu sang RESOLVED và đóng các phiếu PENDING trùng thiết bị nếu có
      const resolvedTicket = await tx.warrantyTicket.update({
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

      if (typeof tx.warrantyTicket.updateMany === 'function') {
        await tx.warrantyTicket.updateMany({
          where: {
            buttonId: ticket.buttonId,
            ticketId: { not: ticketId },
            status: 'PENDING',
          },
          data: {
            status: 'REJECTED',
            adminNote: `Tự động đóng vì thiết bị đã bị khóa qua phiếu #${ticket.ticketCode}`,
          },
        });
      }

      return resolvedTicket;
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
