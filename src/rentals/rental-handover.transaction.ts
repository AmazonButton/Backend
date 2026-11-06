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

    if (rental.pricing_review_required || rental.billing_policy_review_required) {
        throw new BadRequestException('RECONCILIATION_REQUIRED: Hợp đồng có chứng từ thu hoặc chính sách chưa được đối soát');
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

    // R03: Bàn giao tính từ 2 nguồn độc lập không chồng lặp:
    // (1) Kỳ ban đầu được cấp theo tiền cọc/hợp đồng (rental.months_rented)
    // (2) Các kỳ gia hạn (RENTAL_EXTENSION) đã thanh toán hợp lệ
    const paidExtensionCharges = await tx.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(SUM(bcl.duration_count), 0) as extension_months
         FROM billing_charges bc
         JOIN billing_charge_lines bcl ON bc.charge_id = bcl.charge_id
         WHERE bc.target_type = 'RENTAL' AND bc.target_id = $1
           AND bc.status = 'PAID' AND bc.purpose = 'RENTAL_EXTENSION' AND (bcl.line_type = 'RENT' OR bcl.line_type = 'STORE_RENT')`,
        rentalId,
    );
    const extensionMonths = Number(paidExtensionCharges?.[0]?.extension_months || 0);

    const paidInitialRentCharges = await tx.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(SUM(bcl.duration_count), 0) as initial_rent_months
         FROM billing_charges bc
         JOIN billing_charge_lines bcl ON bc.charge_id = bcl.charge_id
         WHERE bc.target_type = 'RENTAL' AND bc.target_id = $1
           AND bc.status = 'PAID' AND bc.purpose = 'RENTAL_INITIAL' AND bcl.line_type = 'RENT'`,
        rentalId,
    );
    const initialPaidRentMonths = Number(paidInitialRentCharges?.[0]?.initial_rent_months || 0);

    // Nếu có gia hạn trước bàn giao, rental.months_rented đã được cộng thêm extensionMonths
    const initialGrantedMonths = initialPaidRentMonths > 0
        ? initialPaidRentMonths
        : Math.max(1, Number(rental.months_rented) - extensionMonths);

    const depositPaid = await tx.$queryRawUnsafe<any[]>(
        `SELECT COUNT(*) as count
         FROM billing_charges bc
         JOIN billing_charge_lines bcl ON bc.charge_id = bcl.charge_id
         WHERE bc.target_type = 'RENTAL' AND bc.target_id = $1
           AND bc.status = 'PAID' AND bcl.line_type = 'DEPOSIT'`,
        rentalId,
    );
    const hasPaidDeposit = Number(depositPaid?.[0]?.count || 0) > 0;
    if (!hasPaidDeposit && initialPaidRentMonths <= 0 && extensionMonths <= 0) {
        throw new BadRequestException('Hợp đồng thuê chưa có khoản thanh toán nào hợp lệ để bàn giao');
    }

    const totalEntitlementMonths = initialGrantedMonths + extensionMonths;
    const totalPaidRentMonths = initialPaidRentMonths + extensionMonths;

      const effectiveStart = handoverDate || new Date();
      const effectiveExpiry = new Date(effectiveStart.getTime() + totalEntitlementMonths * 30 * 24 * 60 * 60 * 1000);
      // R08 & P1: Đồng bộ paidThrough theo snapshot chính sách thống nhất với renewal:
      // Nếu là hợp đồng cũ LEGACY_CUSTOMER_RENT (khách tự trả tiền thuê): cập nhật paidThrough theo kỳ khách đã trả.
      // Nếu là hợp đồng mới STORE_RENT_CUSTOMER_DEPOSIT (Store chịu phí thuê): KHÔNG ghi paidThrough như kỳ thuê khách trả!
      // Chính sách Store-paid bắt buộc giữ paidThrough = null.
      const isLegacy = rental.billing_policy === 'LEGACY_CUSTOMER_RENT';
      const paidThrough = isLegacy && totalPaidRentMonths > 0
        ? new Date(effectiveStart.getTime() + totalPaidRentMonths * 30 * 24 * 60 * 60 * 1000)
        : null;

    // Kích hoạt hợp đồng
    const updatedRental = await tx.buttonRental.update({
        where: { rentalId },
        data: {
            status: 'ACTIVE',
            startDate: effectiveStart,
            endDate: effectiveExpiry,
            paidThrough,
            effectiveExpiresAt: effectiveExpiry,
            monthsRented: totalEntitlementMonths,
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
                    paidMonths: totalEntitlementMonths,
                    initialGrantedMonths,
                    extensionMonths,
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
        paidMonths: totalEntitlementMonths,
        buttonCount: lockedButtons.length,
    };

}
