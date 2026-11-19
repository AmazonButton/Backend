import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WarrantyTicketResponseDto {
  @ApiProperty({ example: '1' })
  ticketId: string;

  @ApiProperty({ example: 'WRT-261115-A101' })
  ticketCode: string;

  @ApiProperty({ example: '12' })
  buttonId: string;

  @ApiProperty({ example: 'SOB-000003' })
  deviceId: string;

  @ApiPropertyOptional({ example: 'Nút Bàn 1' })
  buttonName?: string | null;

  @ApiPropertyOptional({ example: '15' })
  replacementButtonId?: string | null;

  @ApiPropertyOptional({ example: 'SOB-000088' })
  replacementDeviceId?: string | null;

  @ApiPropertyOptional({ example: '1' })
  storeId?: string | null;

  @ApiPropertyOptional({ example: 'Tiệm Trà Sữa ABC' })
  storeName?: string | null;

  @ApiPropertyOptional({ example: '5' })
  customerId?: string | null;

  @ApiPropertyOptional({ example: '501' })
  rentalId?: string | null;

  @ApiProperty({ example: '2' })
  reportedByUserId: string;

  @ApiPropertyOptional({ example: 'Nguyễn Văn Nhân Viên' })
  reportedByName?: string | null;

  @ApiProperty({ example: 'GROUP_A' })
  faultGroup: string;

  @ApiProperty({ example: 'LOW_BATTERY' })
  faultCode: string;

  @ApiProperty({ example: 100000 })
  depositAmount: number;

  @ApiProperty({ example: 0 })
  deductionPercent: number;

  @ApiProperty({ example: 0 })
  deductionAmount: number;

  @ApiProperty({ example: 100000 })
  refundAmount: number;

  @ApiPropertyOptional({ example: 'Pin yếu tụt nhanh' })
  inspectionNote?: string | null;

  @ApiPropertyOptional({ example: 'Admin đã duyệt cấp nút mới' })
  adminNote?: string | null;

  @ApiProperty({ example: 'PENDING' })
  status: string;

  @ApiProperty({ example: '2026-11-15T14:30:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-11-15T14:30:00.000Z' })
  updatedAt: string;

  static fromEntity(ticket: any): WarrantyTicketResponseDto {
    return {
      ticketId: ticket.ticketId ? ticket.ticketId.toString() : ticket.ticket_id?.toString(),
      ticketCode: ticket.ticketCode || ticket.ticket_code,
      buttonId: ticket.buttonId ? ticket.buttonId.toString() : ticket.button_id?.toString(),
      deviceId: ticket.button?.deviceId || ticket.button?.device_id || ticket.deviceId || '',
      buttonName: ticket.button?.buttonName || ticket.button?.button_name || null,
      replacementButtonId: ticket.replacementButtonId ? ticket.replacementButtonId.toString() : (ticket.replacement_button_id ? ticket.replacement_button_id.toString() : null),
      replacementDeviceId: ticket.replacementButton?.deviceId || ticket.replacementButton?.device_id || null,
      storeId: ticket.storeId ? ticket.storeId.toString() : (ticket.store_id ? ticket.store_id.toString() : null),
      storeName: ticket.store?.name || null,
      customerId: ticket.customerId ? ticket.customerId.toString() : (ticket.customer_id ? ticket.customer_id.toString() : null),
      rentalId: ticket.rentalId ? ticket.rentalId.toString() : (ticket.rental_id ? ticket.rental_id.toString() : null),
      reportedByUserId: ticket.reportedByUserId ? ticket.reportedByUserId.toString() : ticket.reported_by_user_id?.toString(),
      reportedByName: ticket.reportedByUser?.fullName || ticket.reportedByUser?.full_name || null,
      faultGroup: ticket.faultGroup || ticket.fault_group,
      faultCode: ticket.faultCode || ticket.fault_code,
      depositAmount: Number(ticket.depositAmount ?? ticket.deposit_amount ?? 100000),
      deductionPercent: Number(ticket.deductionPercent ?? ticket.deduction_percent ?? 0),
      deductionAmount: Number(ticket.deductionAmount ?? ticket.deduction_amount ?? 0),
      refundAmount: Number(ticket.refundAmount ?? ticket.refund_amount ?? 100000),
      inspectionNote: ticket.inspectionNote || ticket.inspection_note || null,
      adminNote: ticket.adminNote || ticket.admin_note || null,
      status: ticket.status,
      createdAt: ticket.createdAt ? new Date(ticket.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: ticket.updatedAt ? new Date(ticket.updatedAt).toISOString() : new Date().toISOString(),
    };
  }
}
