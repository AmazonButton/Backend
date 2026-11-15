import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { WarrantyRepository } from './warranty.repository';
import { CreateWarrantyTicketDto, WarrantyFaultGroupEnum } from './dto/create-warranty-ticket.dto';
import { QueryWarrantyTicketDto } from './dto/query-warranty-ticket.dto';
import { ApproveSwapTicketDto } from './dto/approve-swap-ticket.dto';
import { ResolveRejectTicketDto } from './dto/resolve-reject-ticket.dto';
import { WarrantyTicketResponseDto } from './dto/warranty-ticket-response.dto';
import { EventsGateway } from '../websocket/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import * as crypto from 'crypto';

@Injectable()
export class WarrantyService {
  private readonly logger = new Logger(WarrantyService.name);

  constructor(
    private readonly warrantyRepo: WarrantyRepository,
    @Optional() private readonly eventsGateway?: EventsGateway,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  /**
   * Tính toán số tiền khấu trừ và tiền cọc hoàn lại chuẩn xác phía Server
   * Chống gian lận Client cố tình gửi số tiền sai lệch.
   */
  calculateWarrantyDeduction(
    depositAmount: number,
    group: string,
    customPercent?: number,
  ): { percent: number; deductionAmount: number; refundAmount: number } {
    const safeDeposit = Math.max(0, Number(depositAmount) || 100000);
    let min = 0;
    let max = 0;
    let defaultPct = 0;

    switch (group) {
      case WarrantyFaultGroupEnum.GROUP_A:
      case WarrantyFaultGroupEnum.GROUP_B:
        min = 0;
        max = 0;
        defaultPct = 0;
        break;
      case WarrantyFaultGroupEnum.GROUP_C:
        min = 30;
        max = 30;
        defaultPct = 30;
        break;
      case WarrantyFaultGroupEnum.GROUP_D:
        min = 70;
        max = 100;
        defaultPct = 100;
        break;
      default:
        min = 0;
        max = 0;
        defaultPct = 0;
    }

    const raw = customPercent !== undefined ? Number(customPercent) : defaultPct;
    const percent = Math.min(max, Math.max(min, Number.isFinite(raw) ? raw : defaultPct));
    const deductionAmount = Math.round((safeDeposit * percent) / 100);
    const refundAmount = Math.max(0, safeDeposit - deductionAmount);

    return { percent, deductionAmount, refundAmount };
  }

  async createTicket(dto: CreateWarrantyTicketDto, user: any) {
    const button = await this.warrantyRepo.findButtonByDeviceId(dto.deviceId.trim());
    if (!button) {
      throw new NotFoundException(`Không tìm thấy nút bấm với mã ${dto.deviceId}`);
    }

    // BOLA Check: Nếu user là Store/Staff, chỉ được tạo phiếu cho nút của quán mình
    const isStoreRole = ['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF'].includes(user.role);
    if (isStoreRole) {
      if (user.storeId && button.storeId && button.storeId.toString() !== user.storeId.toString()) {
        throw new ForbiddenException('Bạn không có quyền báo bảo hành cho thiết bị thuộc cửa hàng khác');
      }
    }

    const effectiveStoreId = button.storeId || (dto.storeId ? BigInt(dto.storeId) : (user.storeId ? BigInt(user.storeId) : null));
    const effectiveCustomerId = button.customerId || null;

    // Tính toán cọc và khấu trừ chuẩn
    const baseDeposit = dto.depositAmount !== undefined ? dto.depositAmount : 100000;
    const { percent, deductionAmount, refundAmount } = this.calculateWarrantyDeduction(
      baseDeposit,
      dto.faultGroup,
      dto.deductionPercent,
    );

    // Sinh mã phiếu bảo hành WRT-YYMMDD-XXXX
    const now = new Date();
    const yymmdd = now.toISOString().slice(2, 10).replace(/-/g, '');
    const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
    const ticketCode = `WRT-${yymmdd}-${randomHex}`;

    const ticket = await this.warrantyRepo.createTicket({
      ticketCode,
      buttonId: button.buttonId,
      storeId: effectiveStoreId,
      customerId: effectiveCustomerId,
      reportedByUserId: BigInt(user.userId || user.id),
      faultGroup: dto.faultGroup,
      faultCode: dto.faultCode.trim(),
      depositAmount: baseDeposit,
      deductionPercent: percent,
      deductionAmount,
      refundAmount,
      inspectionNote: dto.inspectionNote?.trim(),
    });

    this.logger.log(`Created warranty ticket #${ticketCode} for device ${dto.deviceId} (Group: ${dto.faultGroup})`);
    const resultDto = WarrantyTicketResponseDto.fromEntity(ticket);
    try {
      this.eventsGateway?.emitToAdmin('WARRANTY_TICKET_CREATED', resultDto);
      if (effectiveStoreId) {
        this.eventsGateway?.emitToStore(effectiveStoreId.toString(), 'WARRANTY_TICKET_CREATED', resultDto);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to broadcast WARRANTY_TICKET_CREATED: ${err.message}`);
    }
    return resultDto;
  }

  async getTickets(query: QueryWarrantyTicketDto, user: any) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const where: any = {};

    // BOLA Tenant Isolation
    const isStoreRole = ['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF'].includes(user.role);
    if (isStoreRole) {
      if (!user.storeId) {
        throw new ForbiddenException('Tài khoản thiếu thông tin cửa hàng để truy vấn');
      }
      if (query.storeId && String(query.storeId) !== String(user.storeId)) {
        throw new ForbiddenException('Bạn không có quyền xem phiếu bảo hành của cửa hàng khác');
      }
      where.storeId = BigInt(user.storeId);
    } else if (query.storeId) {
      where.storeId = BigInt(query.storeId);
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.faultGroup) {
      where.faultGroup = query.faultGroup;
    }

    if (query.deviceId) {
      where.button = { deviceId: { contains: query.deviceId.trim(), mode: 'insensitive' } };
    }

    const [tickets, total] = await Promise.all([
      this.warrantyRepo.findTickets(where, skip, pageSize),
      this.warrantyRepo.countTickets(where),
    ]);

    const totalPages = Math.ceil(total / pageSize) || 1;

    return {
      items: tickets.map(WarrantyTicketResponseDto.fromEntity),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    };
  }

  async getTicketById(ticketIdStr: string, user: any) {
    const ticketId = BigInt(ticketIdStr);
    const ticket = await this.warrantyRepo.findTicketById(ticketId);
    if (!ticket) {
      throw new NotFoundException('Không tìm thấy phiếu bảo hành');
    }

    // BOLA Tenant check
    const isStoreRole = ['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF'].includes(user.role);
    if (isStoreRole && user.storeId) {
      if (ticket.storeId && ticket.storeId.toString() !== user.storeId.toString()) {
        throw new ForbiddenException('Bạn không có quyền truy cập phiếu bảo hành của cửa hàng khác');
      }
    }

    return WarrantyTicketResponseDto.fromEntity(ticket);
  }

  async approveSwap(ticketIdStr: string, dto: ApproveSwapTicketDto, adminUser: any) {
    const ticketId = BigInt(ticketIdStr);
    const ticket = await this.warrantyRepo.findTicketById(ticketId);
    if (!ticket) {
      throw new NotFoundException('Không tìm thấy phiếu bảo hành');
    }

    // Tìm nút thay thế
    const replacement = await this.warrantyRepo.findAvailableReplacementButton(dto.replacementDeviceId?.trim());
    if (!replacement) {
      throw new BadRequestException('Không tìm thấy thiết bị thay thế sẵn sàng trong kho để đổi');
    }

    const updated = await this.warrantyRepo.approveSwapAtomicTx(
      ticketId,
      replacement.buttonId,
      BigInt(adminUser.userId || adminUser.id),
      dto.adminNote?.trim(),
    );

    this.logger.log(`Approved swap for ticket #${ticket.ticketCode}: replaced button ${ticket.buttonId} with ${replacement.buttonId}`);
    const resultDto = WarrantyTicketResponseDto.fromEntity(updated);
    try {
      this.eventsGateway?.emitToAdmin('WARRANTY_TICKET_UPDATED', resultDto);
      if (updated.storeId) {
        this.eventsGateway?.emitToStore(updated.storeId.toString(), 'WARRANTY_TICKET_UPDATED', resultDto);
      }
      if (updated.reportedByUserId) {
        this.notificationsService?.createAndDispatchNotification({
          userId: updated.reportedByUserId,
          type: 'WARRANTY_TICKET_UPDATED',
          title: `Phiếu bảo hành #${updated.ticketCode} đã được duyệt đổi 1-1`,
          body: `Thiết bị ${ticket.button?.deviceId} đã được duyệt cấp đổi sang nút ${replacement.deviceId}.`,
          idempotencyKey: `notif:warranty:${updated.ticketId}:approved`,
          data: {
            ticketId: updated.ticketId.toString(),
            status: 'APPROVED_SWAP',
            deviceId: ticket.button?.deviceId,
            replacementDeviceId: replacement.deviceId,
          },
        });
      }
    } catch (err: any) {
      this.logger.warn(`Failed to broadcast WARRANTY_TICKET_UPDATED: ${err.message}`);
    }
    return resultDto;
  }

  async lockDevice(ticketIdStr: string, adminUser: any, adminNote?: string) {
    const ticketId = BigInt(ticketIdStr);
    const updated = await this.warrantyRepo.lockDeviceAtomicTx(
      ticketId,
      BigInt(adminUser.userId || adminUser.id),
      adminNote?.trim(),
    );
    this.logger.log(`Locked device for ticket #${ticketIdStr}`);
    const resultDto = WarrantyTicketResponseDto.fromEntity(updated);
    try {
      this.eventsGateway?.emitToAdmin('WARRANTY_TICKET_UPDATED', resultDto);
      if (updated.storeId) {
        this.eventsGateway?.emitToStore(updated.storeId.toString(), 'WARRANTY_TICKET_UPDATED', resultDto);
      }
    } catch {}
    return resultDto;
  }

  async resolveTicket(ticketIdStr: string, adminUser: any, dto: ResolveRejectTicketDto) {
    const ticketId = BigInt(ticketIdStr);
    const ticket = await this.warrantyRepo.findTicketById(ticketId);
    if (!ticket) {
      throw new NotFoundException('Không tìm thấy phiếu bảo hành');
    }
    const updated = await this.warrantyRepo.updateTicketStatus(ticketId, 'RESOLVED', dto.adminNote?.trim());
    const resultDto = WarrantyTicketResponseDto.fromEntity(updated);
    try {
      this.eventsGateway?.emitToAdmin('WARRANTY_TICKET_UPDATED', resultDto);
      if (updated.storeId) {
        this.eventsGateway?.emitToStore(updated.storeId.toString(), 'WARRANTY_TICKET_UPDATED', resultDto);
      }
    } catch {}
    return resultDto;
  }

  async rejectTicket(ticketIdStr: string, adminUser: any, dto: ResolveRejectTicketDto) {
    const ticketId = BigInt(ticketIdStr);
    const ticket = await this.warrantyRepo.findTicketById(ticketId);
    if (!ticket) {
      throw new NotFoundException('Không tìm thấy phiếu bảo hành');
    }
    const updated = await this.warrantyRepo.updateTicketStatus(ticketId, 'REJECTED', dto.adminNote?.trim());
    const resultDto = WarrantyTicketResponseDto.fromEntity(updated);
    try {
      this.eventsGateway?.emitToAdmin('WARRANTY_TICKET_UPDATED', resultDto);
      if (updated.storeId) {
        this.eventsGateway?.emitToStore(updated.storeId.toString(), 'WARRANTY_TICKET_UPDATED', resultDto);
      }
    } catch {}
    return resultDto;
  }
}
