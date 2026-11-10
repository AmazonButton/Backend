# Kế Hoạch Tổng Thể Cải Tổ Hệ Thống Chi Hộ (Payout) & Đối Soát Tài Chính Toàn Diện (V2 - Chuẩn Xác)

> **Mục tiêu:** Đồng nhất và đóng kín toàn bộ các luồng giao dịch tiền thật (Rút tiền ví Store, Hoàn cọc thuê nút IoT, Hoàn tiền xác minh 2.000đ Store/Customer) đạt chuẩn Zero Side-Effects, Fail-Closed, chống Race Condition, chống tranh chấp đa node (Multi-node Lease Claim) và Idempotent tuyệt đối.

---

## 1. Các Điểm Chỉnh Sửa Kỹ Thuật Chính Xác & Bất Biến Nghiệp Vụ

1. **CAS khi nhận response Payout**:
   - Khi gọi PayOS, trạng thái đã được claim từ `PENDING` sang `PROCESSING`.
   - Khi nhận response từ PayOS: **Không dùng `WHERE status = 'PENDING'`**. 
   - Dùng điều kiện: `WHERE status NOT IN ('SUCCEEDED', 'COMPLETED', 'FAILED')` (hoặc `status = 'PROCESSING'`) để bổ sung `providerPayoutId` thật.
   - **Tuyệt đối không ghi đè trạng thái terminal**: Nếu Webhook đã về trước và đổi sang `SUCCEEDED` thì update này bị bỏ qua, không thể hạ về `PROCESSING`.

2. **Reference Bền Vững & Không Sinh Timestamp Mới**:
   - Tái sử dụng `withdrawalCode` (hoặc `providerReferenceId` duy nhất được lưu bền vững vào DB trước khi gọi PayOS).
   - Retry cùng một attempt bắt buộc gửi lại đúng reference cũ để PayOS áp dụng cơ chế Idempotency 24h, không sinh timestamp mới.

3. **Tên Verifier Chuẩn**:
   - Sử dụng đúng hàm hiện có: `verifyPayosPayoutEvidence` (xác minh thành công) và `verifyPayosPayoutRejectionEvidence` (xác minh từ chối/thất bại). Không tự tạo thêm verifier mới.

4. **Snapshot Tài Khoản Rút Tiền & Giải Mã Đối Chiếu Hash**:
   - Sử dụng đúng các field hiện tại của `StoreWithdrawal`: `bankAccountEncrypted`, `bankAccountHash`, `bankBinSnapshot`.
   - Trước khi gửi tiền: Bắt buộc giải mã `CryptoVaultUtil.decryptAccountNumber(bankAccountEncrypted)`, băm lại bằng `CryptoVaultUtil.hashAccountNumber()` và so khớp với `bankAccountHash`. Nếu sai lệch hoặc lỗi giải mã $\rightarrow$ **Fail-Closed ngay lập tức**, từ chối chuyển tiền.

5. **Quy Định Số Tiền Rút Thực Nhận**:
   - Số tiền giữ/trừ ví: `amount` (Số nguyên dương VND).
   - Phí rút tiền: `fee` do server quyết định 100% (bất biến: $0 \le fee < amount$, nguyên dương VND).
   - Số tiền PayOS thực chuyển: `netAmount = amount - fee`.
   - **Bộ verifier bắt buộc so khớp với `netAmount`** (số tiền thực chuyển).

6. **Transaction Tạo Nghĩa Vụ Hoàn Tiền Store**:
   - Đặt toàn bộ thao tác trong Repository (`bank-verification.repository.ts`), không để ở Service.
   - Ghi nhận xác minh và tạo nghĩa vụ hoàn tiền (hoặc cập nhật `refund_status = 'PENDING_REFUND'`, sinh `refund_reference = 'REF_ST_' || id`) **ngay trong cùng transaction với lock `SELECT FOR UPDATE`**.
   - Có ràng buộc chống tạo trùng lặp.

7. **Cron Hoàn Cọc Thuê Nút (DepositRefund)**:
   - Sử dụng đúng field hiện tại `DepositRefund.providerReferenceId` (nơi đang lưu payout ID thật của PayOS).
   - Hoàn tiền cho 1 nút trong hợp đồng nhiều nút: Chỉ giải phóng tiền cọc của đúng nút đó, **không được đóng toàn bộ hợp đồng thuê**.

---

## 2. Xử Lý 3 Tình Huống Biên Trọng Yếu

### Tình huống 1: Tiền xác minh đã nhận nhưng không xác minh được
- **Các trường hợp**: Tiền đến sau khi phiên hết hạn, sai số tiền, thiếu thông tin tài khoản nguồn, hoặc khách chuyển thêm giao dịch thứ 2 vào phiên đã xử lý.
- **Nguyên tắc xử lý**:
  - Ghi nhận giao dịch tiền thực nhận độc lập vào DB (`received_amount`, `provider_transaction_id`, thời gian nhận).
  - Đánh dấu trạng thái `MANUAL_RECONCILIATION_REQUIRED`.
  - Thiếu bằng chứng người nhận thì **đưa vào hàng đợi đối soát thủ công**, không bỏ qua khoản tiền đó và **tuyệt đối không tự động hoàn về số tài khoản khách đã đăng ký** khi chưa có bằng chứng khớp.

### Tình huống 2: Crash sau khi PayOS nhận lệnh nhưng chưa kịp lưu Payout ID
- Worker/Cron không được chỉ quét các bản ghi đã có `providerPayoutId`.
- Với các attempt chưa rõ kết quả:
  - Tra cứu PayOS theo `referenceId` (dùng `payosPayoutService.getPayouts({ referenceId })`).
  - Nếu tìm thấy payout khớp: Trích xuất payout ID và đưa vào `verifyPayosPayoutEvidence`.
  - Không coi "chưa tìm thấy" là chắc chắn chưa chuyển tiền (có thể do độ trễ đồng bộ của provider).
  - Tuyệt đối không sinh reference mới để chi lại!

### Tình huống 3: Nhiều node chạy worker đồng thời (Multi-node Concurrency)
- Chống tranh chấp giữa cụm Render (Node 1) và AWS EC2 (Node 3):
  - **Claim bằng Lease Token**:
    ```sql
    UPDATE ...
    SET claim_token = :token,
        claimed_at = NOW(),
        lease_expires_at = NOW() + INTERVAL '2 minutes'
    WHERE id = :id AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
    ```
  - **Không giữ connection/transaction DB mở trong lúc gọi HTTP sang PayOS**.
  - Cập nhật kết quả đối soát bằng CAS: `WHERE id = :id AND claim_token = :token`.
  - Nếu node crash giữa chừng: Sau 2 phút `lease_expires_at` hết hạn, node khác có thể claim lại để **đối soát tiếp** (không tạo lệnh chi mới).

---

## 3. Thứ Tự Triển Khai 5 Giai Đoạn (Khép Kín & Không Sửa Vòng Lặp)

```
[Giai đoạn 1: Chuẩn hóa Snapshot, Phí Server-Side & DTO]
                  │
                  ▼
[Giai đoạn 2: Thống nhất Bộ đối soát & CAS Rút tiền Store/Admin]
                  │
                  ▼
[Giai đoạn 3: Nghĩa vụ hoàn tiền Store (Atomic trong Repository)]
                  │
                  ▼
[Giai đoạn 4: Worker phục hồi, Poller hoàn cọc & Multi-node Lease]
                  │
                  ▼
[Giai đoạn 5: Bộ 10 Test Cases Nghiệm Thu Toàn Diện]
```

### Giai đoạn 1: Chuẩn Hóa Snapshot, Phí Server-Side & DTO
1. Sửa `RequestWithdrawalDto`: Loại bỏ `fee` từ client; thêm `@IsOptional() @IsString() bankAccountId`.
2. Sửa `store-wallet.service.ts`:
   - Tính phí rút tiền server-side; kiểm tra $0 \le fee < amount$, $netAmount = amount - fee$.
   - Kiểm tra quyền sở hữu `bankAccountId`.
   - Trước khi payout: Giải mã `bankAccountEncrypted`, băm lại và so khớp `bankAccountHash`. Lỗi giải mã $\rightarrow$ Fail-closed ngay.
3. Sửa `bank-verification-webhook.dto.ts`: Bổ sung `@IsBoolean() success!: boolean`.
4. Sửa `admin.service.ts`: Loại bỏ plaintext fallback và BIN mặc định khi duyệt payout.

### Giai đoạn 2: Thống Nhất Bộ Đối Soát & CAS Rút Tiền
1. Áp dụng CAS khi nhận response `createPayout`:
   - Update `providerPayoutId` với điều kiện `WHERE status NOT IN ('SUCCEEDED', 'COMPLETED', 'FAILED')`.
2. Hợp nhất `AdminService.syncPayoutStatus`, `StoreWalletService.syncWithdrawalStatus` và Webhook:
   - Dùng chung `verifyPayosPayoutEvidence` và `verifyPayosPayoutRejectionEvidence`.
   - So khớp số tiền thực gửi `netAmount`, `bankBinSnapshot`, `bankAccountHash` và `withdrawalCode`.
   - Cho phép đối soát cả `PROCESSING` lẫn `PENDING_RECONCILIATION`. Mâu thuẫn bằng chứng giữ nguyên tiền đóng băng.

### Giai đoạn 3: Nghĩa Vụ Hoàn Tiền Store (Atomic Trong Repository)
1. Trong `bank-verification.repository.ts` (`executeAtomicWebhookVerificationTx`):
   - Khi xác minh thành công: Cập nhật `status = 'VERIFIED'` và `refund_status = 'PENDING_REFUND'` cùng `refund_reference = 'REF_ST_' || id` trong cùng transaction có `SELECT FOR UPDATE`.
   - Khi xác minh thất bại (hoặc nhận tiền bất thường): Lưu `received_amount`, `provider_transaction_id` và đánh dấu `MANUAL_RECONCILIATION_REQUIRED`.
2. Sửa `payos-bank-verification.provider.ts`:
   - Phản hồi `code === '00'` chỉ lưu payout ID và trả về `PENDING_RECONCILIATION`. Tuyệt đối không trả `SUCCESS`.

### Giai đoạn 4: Worker Phục Hồi, Poller Hoàn Cọc & Multi-Node Lease
1. Worker hoàn tiền Store:
   - Claim các bản ghi `PENDING_REFUND` bằng lease token (2 phút timeout).
   - Gọi PayOS ngoài transaction DB; cập nhật kết quả bằng CAS theo claim token.
2. Poller hoàn cọc thuê nút (`deposit-refund-reconcile.cron.ts`):
   - Quét các bản ghi `DepositRefund` ở trạng thái `PENDING_PAYOUT`.
   - Dùng `providerReferenceId` (lưu payout ID thật) để tra cứu PayOS và xác minh qua `verifyDepositRefundPayoutEvidence`.
   - Chỉ khi thành công mới trừ cọc `RESERVED` của đúng nút đó, không đóng nhầm hợp đồng thuê.
3. Chống nghẽn hàng đợi Customer:
   - Thêm `next_reconcile_at`, exponential backoff và lease claim khi quét 10 bản ghi.

---

## 4. Ma Trận 10 Kịch Bản Nghiệm Thu Cụ Thể (Acceptance Test Matrix)

1. **TC-01 (Premature Success)**: PayOS trả về `code='00'` với `approvalState='PROCESSING'` $\rightarrow$ Không được ghi đã hoàn tiền, giữ `PENDING_RECONCILIATION`.
2. **TC-02 (Webhook Arrives Before Response)**: Webhook trả về `SUCCEEDED` trước khi promise `createPayout` kết thúc $\rightarrow$ Không đảo trạng thái về `PROCESSING`, không trừ frozenBalance 2 lần.
3. **TC-03 (Timeout / Crash Post-Provider)**: Timeout/crash sau khi PayOS nhận lệnh $\rightarrow$ Không chi trùng, worker tra cứu lại theo reference và đối soát thành công.
4. **TC-04 (Evidence Mismatch)**: Lệch `netAmount` 1đ, sai BIN ngân hàng, hoặc sai hash tài khoản $\rightarrow$ Không quyết toán, không hoàn ví, giữ tiền đóng băng.
5. **TC-05 (Webhook Replay)**: Gửi lại webhook xác minh Store nhiều lần $\rightarrow$ Chỉ 1 receipt được ghi nhận, đúng 1 nghĩa vụ hoàn tiền được tạo.
6. **TC-06 (Crash Post-Commit)**: Mô phỏng crash ngay sau commit transaction xác minh Store $\rightarrow$ Khởi động lại worker vẫn quét thấy nghĩa vụ và hoàn tất chi tiền.
7. **TC-07 (Multi-Node Concurrency)**: Hai worker trên Render và AWS cùng quét 1 bản ghi $\rightarrow$ Chỉ 1 worker claim được lease token và thực hiện chi tiền, không bị chi đúp.
8. **TC-08 (Anti-Head-of-Line)**: 10 khoản đối soát bị timeout/treo $\rightarrow$ Áp dụng backoff, không chặn khoản thứ 11 được đối soát thành công.
9. **TC-09 (Partial Deposit Refund)**: Hoàn cọc 1 nút trong hợp đồng nhiều nút $\rightarrow$ Sổ cọc trừ đúng số tiền của nút đó, hợp đồng vẫn duy trì trạng thái hiệu lực cho các nút còn lại.
10. **TC-10 (Abnormal Verification Funds)**: Tiền đến muộn sau khi phiên hết hạn hoặc sai số tiền $\rightarrow$ Được ghi nhận đầy đủ `received_amount`, chuyển sang đối soát thủ công, không bị thất thoát và không tự hoàn sai người.
