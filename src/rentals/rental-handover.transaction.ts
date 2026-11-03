import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Repository-only helper: caller owns the transaction and any pre-acquired locks. */
export async function handoverRentalButtonsInTx(
  tx: Prisma.TransactionClient,
  rentalId: bigint,
  staffUser: any,
  handoverDate?: Date,
  prelocked?: { buttons: any[]; rental: any },
) {
      // 1. Khóa bi-quan các nút được gán cho hợp đồng theo thứ tự button_id ASC (tránh deadlock)
      const lockedButtons = prelocked?.buttons ?? await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM iot_button WHERE rental_id = $1 ORDER BY button_id ASC FOR UPDATE',
        rentalId,
      );

      // 2. Khóa bi-quan hợp đồng thuê sau khi đã khóa thiết bị
      const lockedRentals = prelocked ? [prelocked.rental] : await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM button_rentals WHERE rental_id = $1 FOR UPDATE',
        rentalId,
      );
      if (!lockedRentals || lockedRentals.length === 0) {
        throw new NotFoundException(`Hợp đồng thuê #${rentalId} không tồn tại`);
      }
      const rental = lockedRentals[0];

      if (rental.status !== 'PENDING_HANDOVER') {
        throw new BadRequestException(`Chỉ có thể bàn giao nút cho hợp đồng ở trạng thái PENDING_HANDOVER (hiện tại: ${rental.status})`);
      }

      // R04: Kiểm tra nghiêm ngặt danh sách thiết bị
      if (!lockedButtons || lockedButtons.length === 0) {
        throw new BadRequestException('Hợp đồng thuê không có thiết bị nút bấm nào được gán để bàn giao');
      }

      const expectedQuantity = rental.button_quantity || 1;
      if (lockedButtons.length !== expectedQuantity) {
        throw new BadRequestException(`Số lượng thiết bị được giữ chỗ (${lockedButtons.length}) không khớp với gói thuê (${expectedQuantity})`);
      }

      if (!rental.fulfillment_store_id) {
        throw new BadRequestException('Hợp đồng thuê chưa được phân bổ cửa hàng phụ trách bàn giao');
      }

      for (const btn of lockedButtons) {
        if (btn.rental_id !== rentalId) {
          throw new BadRequestException(`Thiết bị ${btn.device_serial_number || btn.button_id} thuộc hợp đồng thuê khác`);
        }
        if (!btn.custody_store_id) {
          throw new BadRequestException(`Thiết bị ${btn.device_serial_number || btn.button_id} thiếu thông tin kho cửa hàng tạm giữ`);
        }
        if (BigInt(btn.custody_store_id) !== BigInt(rental.fulfillment_store_id)) {
          throw new BadRequestException(`Thiết bị ${btn.device_serial_number || btn.button_id} không thuộc kho của cửa hàng phụ trách bàn giao`);
        }
        if (!['ASSIGNED_TO_RENTAL', 'ALLOCATED_TO_STORE'].includes(btn.inventory_state)) {
          throw new BadRequestException(`Thiết bị ${btn.device_serial_number || btn.button_id} không ở trạng thái hợp lệ để bàn giao (hiện tại: ${btn.inventory_state})`);
        }
      }

      // R03: Bàn giao tính theo số kỳ ĐÃ THANH TOÁN, không dùng bộ đếm yêu cầu gia hạn chưa trả tiền
      const paidCharges = await tx.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(SUM(bcl.duration_count), 0) as paid_months
         FROM billing_charges bc
         JOIN billing_charge_lines bcl ON bc.charge_id = bcl.charge_id
         WHERE bc.target_type = 'RENTAL' AND bc.target_id = $1
           AND bc.status = 'PAID' AND bcl.line_type = 'RENT'`,
        rentalId,
      );
      const rawPaidMonths = Number(paidCharges?.[0]?.paid_months || 0);
      if (rawPaidMonths <= 0) {
        throw new BadRequestException('Hợp đồng thuê chưa có kỳ hạn nào được thanh toán để bàn giao');
      }
      const paidMonths = rawPaidMonths;

      const effectiveStart = handoverDate || new Date();
      const effectiveExpiry = new Date(effectiveStart.getTime() + paidMonths * 30 * 24 * 60 * 60 * 1000);

      // Kích hoạt hợp đồng
      const updatedRental = await tx.buttonRental.update({
        where: { rentalId },
        data: {
          status: 'ACTIVE',
          startDate: effectiveStart,
          endDate: effectiveExpiry,
          paidThrough: effectiveExpiry,
          effectiveExpiresAt: effectiveExpiry,
          monthsRented: paidMonths,
        },
      });

      // Cập nhật từng nút sang IN_CUSTOMER_CUSTODY, canOrder = true, và ghi nhận DeviceMovement
      const staffUserId = staffUser?.userId ? BigInt(staffUser.userId) : null;
      for (const btn of lockedButtons) {
        await tx.ioTButton.update({
          where: { buttonId: btn.button_id },
          data: {
            customerId: rental.customer_id ? BigInt(rental.customer_id) : undefined,
            custodyStoreId: null,
            inventoryState: 'IN_CUSTOMER_CUSTODY',
            status: 'ACTIVE',
            canOrder: true,
            installedAt: effectiveStart,
          },
        });

        await tx.deviceMovement.create({
          data: {
            buttonId: btn.button_id,
            sourceType: 'STORE',
            sourceStoreId: btn.custody_store_id ? BigInt(btn.custody_store_id) : (rental.fulfillment_store_id ? BigInt(rental.fulfillment_store_id) : null),
            destType: 'CUSTOMER',
            rentalId,
            actorUserId: staffUserId,
            reason: 'Bàn giao nút thông minh cho khách hàng kích hoạt dịch vụ',
          },
        });
      }

      // R08: Audit Log
      if ((tx as any).rentalAuditLog) {
        await (tx as any).rentalAuditLog.create({
          data: {
            actorType: staffUser?.role ? (['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(staffUser.role) ? 'ADMIN' : 'STAFF') : 'STAFF',
            actorUserId: staffUserId,
            action: 'HANDOVER_RENTAL',
            targetType: 'RENTAL',
            targetId: rentalId,
            beforeState: rental.status,
            afterState: 'ACTIVE',
            correlationId: rental.rental_code,
            metadata: {
              handoverDate: effectiveStart,
              effectiveExpiry,
              paidMonths,
              buttonCount: lockedButtons.length,
              buttonIds: lockedButtons.map((b) => b.button_id.toString()),
            },
          },
        });
      }

      return {
        rentalId,
        status: 'ACTIVE',
        effectiveExpiresAt: effectiveExpiry,
        handoverDate: effectiveStart,
        paidMonths,
        buttonCount: lockedButtons.length,
      };

}
