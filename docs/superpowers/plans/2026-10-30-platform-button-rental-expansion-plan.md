# Kế hoạch mở rộng: Sàn cho thuê nút, Store giao/nhận thiết bị

Ngày: 2026-10-30. Trạng thái: ĐỀ XUẤT TRIỂN KHAI, chưa triển khai nghiệp vụ.

## 1. Kết luận và phạm vi được làm rõ

- Sàn/Admin là bên cho thuê nút, nhận phí thuê và giữ tiền cọc. Không cần tạo Store giả cho Admin.
- Store thông thường vẫn bán hàng tiêu dùng, nhận đơn IoT, và đóng phí duy trì 60.000 VND/tháng. Người dùng đã xác nhận giữ khoản phí này.
- Không giới hạn toàn bộ danh mục sản phẩm hiện hữu thành “Nút”. Catalog thuê nút dùng `RentalPackage`, tách khỏi `Product` bán hàng.
- Đề xuất: Store được Admin chỉ định làm điểm giao/nhận nút từ kho đã phân bổ; quyền sở hữu thiết bị và nghĩa vụ hoàn cọc vẫn thuộc Sàn. Đây là đề xuất vận hành, chưa phải quyết định đã được người dùng phê duyệt.
- Phí thuê đề xuất theo yêu cầu ban đầu: 30.000 VND/nút/kỳ; cọc 200.000 VND/nút. Chỉ cho thuê, không bổ sung bán đứt thiết bị trong đợt này.
- Ví Store tiếp tục chứa doanh thu bán hàng. Không đưa phí thuê nút hoặc cọc vào ví Store, không tự phát sinh hoa hồng giao nút.
- Không thêm ERP, nhà cung cấp, sàn vận chuyển, ví nạp tiền của khách, bảo hiểm hay hệ thống tranh chấp tổng quát.

Kế hoạch dựa trên đọc code/schema/migrations và tài liệu hiện tại, không phải chứng nhận đã chạy E2E hoặc xác minh production. HEAD lúc rà soát: `700dee1`. Working tree đã có thay đổi của người dùng; không ghi đè chúng.

## 2. Vì sao chọn Store làm điểm giao/nhận

| Phương án | Đánh giá |
|---|---|
| Tạo Store của Admin rồi cho thuê như một sản phẩm | Không đề xuất: trộn thuê/cọc với đơn bán hàng, commission và ví Store; dễ cộng tiền cọc vào doanh thu |
| Admin cho thuê và tự giao mọi nút | Đơn giản nếu có đúng một kho và Admin tự vận hành; không tận dụng yêu cầu phân bổ kho Store |
| Sàn cho thuê, Store giữ và giao/nhận thiết bị | Đề xuất: sát BRD hiện hữu, tận dụng Devices/Staff; cần bổ sung giữ chỗ, bàn giao và lịch sử luân chuyển |

MVP chỉ triển khai phương án thứ ba. Có thể chỉ bật một Store đối tác lúc pilot. Không xây đồng thời nhiều mô hình fulfillment.

Phân biệt ba quan hệ:

- `custodyStoreId`: Store đang giữ thiết bị trong kho; có thể null khi ở kho Sàn hoặc đang ở khách.
- `fulfillmentStoreId`: Store chịu trách nhiệm giao/nhận của hợp đồng; snapshot không đổi khi khách remap.
- `IoTButton.storeId`: Store phục vụ đặt hàng trên nút theo contract hiện tại. Không dùng trường này để suy ra bên cho thuê hoặc bên nhận tiền.

Lúc bắt đầu, Store giao nút cũng là Store mặc định nhận đơn. Sau bàn giao, remap chỉ đổi Store nhận đơn và cấu hình sản phẩm. Chỉ Admin có nghiệp vụ điều chuyển mới được đổi Store giao/nhận; phải giữ lịch sử và kiểm tra phạm vi quyền.

## 3. Chính sách đề xuất cần duyệt trước migration nghiệp vụ

| Quyết định | Mặc định đề xuất |
|---|---|
| “Một tháng” | MVP dùng 30 ngày, ghi rõ trên UI và hợp đồng; không gọi là tháng lịch. Nếu chọn tháng lịch, phải định nghĩa quy tắc cuối tháng trước khi code |
| Bắt đầu tính tiền thuê | Khi bàn giao/kích hoạt có bằng chứng; không tính từ lúc tạo hợp đồng chưa thanh toán |
| Gia hạn còn hiệu lực | Cộng kỳ mới từ `paidThrough` hiện tại, chỉ sau xác nhận thu tiền |
| Gia hạn đã hết hạn | Từ thời điểm thanh toán được xác nhận; không tự tính truy thu những ngày đã bị khóa |
| Khóa do hết hạn | Không có grace period tự động; `now >= effectiveExpiresAt` là hết hạn. Quyền được Admin cấp là một nguồn hợp lệ riêng, không phải payment giả |
| Admin điều chỉnh thời hạn | Cho phép cấp mới/gia hạn/đặt lại ngày hết hạn/rút ngắn mà không cần thanh toán, qua API riêng có audit; không sửa lịch sử tiền hoặc cọc |
| Store hết phí 60k | Chặn tạo/đăng lại listing mới; vẫn được xử lý đơn cũ, trả nút, hoàn cọc và thanh toán gia hạn. Không khóa nút của khách đã trả tiền chỉ vì Store nợ phí |
| Nhận thuê nút mới khi Store hết hạn | Đề xuất không chọn Store đó làm điểm giao mới; Store vẫn phải nhận trả hợp đồng cũ |
| Trả sớm | Hoàn đủ cọc sau nhận/kiểm tra nút; không mặc định hoàn phí thuê đã bắt đầu. Hủy trước bàn giao có quy trình hoàn cả tiền thuê và cọc |
| Hỏng/mất nút | Chuyển case sang chờ Admin xử lý, không tự khấu trừ cọc. Mức khấu trừ/phí mất nút chưa được chốt nên không tự thêm |
| Nhắc hạn | D-7, D-3, D-1 và khi hết hạn; khách, Store liên quan và Admin theo loại sự kiện |
| Phí giao/nhận nút | Chưa có chính sách; MVP không tự thu phí hoặc chia hoa hồng |

## 4. Hiện trạng code và các khoảng trống đã kiểm tra

| Nhóm | Đã có | Cần sửa/bổ sung |
|---|---|---|
| Store | Đăng ký chủ Store, duyệt Store, hồ sơ và staff | Nếu Admin tạo trực tiếp: thêm endpoint tạo Store với owner rõ ràng; không biến tài khoản Admin thành owner giả |
| Subscription | Plan, lịch sử, thanh toán bằng ví, kiểm tra trước tạo Product | Gói 60k, QR cho Store chưa có doanh thu, thời hạn nửa mở, kiểm tra mọi đường publish, nhắc hạn |
| Thiết bị | Mã thiết bị, batch generate, allocation có transaction, pairing/remap | Kho Sàn thực sự, custody/lifecycle rõ ràng, reservation, fulfillment, trả kho |
| Rental | Package, hợp đồng, yêu cầu thanh toán, gia hạn, yêu cầu trả | Thanh toán thật theo kỳ, quyền dùng sau trả tiền, gắn thiết bị, bàn giao, expire, hoàn cọc |
| Tiền cọc | `ButtonRental.depositAmount` | Sổ cọc theo thiết bị, trạng thái giữ/đang hoàn/đã hoàn, payout khách và đối soát |
| Notifications | DB history, unread/read, FCM, idempotency key | Event thuê/cọc/subscription, outbox và retry bền vững cho dispatch |

Các điểm cần xử lý trước release, không phải lỗi mới của bốn hạng mục cache đã nghiệm thu trước đó:

1. `src/rentals/rentals.service.ts:137`: `createRentalPaymentRequest` tự dựng paymentLinkId/checkoutUrl/QR; chưa gọi provider tạo link thực.
2. `src/payments/payments.repository.ts:88`: `confirmPaymentAtomicTx` luôn tìm `orders` từ `payment.order_id`; chưa có nhánh hoàn tất riêng cho rental-only/subscription payment.
3. `src/rentals/rentals.repository.ts:105`: gia hạn cập nhật `endDate` trước thu tiền; wrapper tại dòng 201 đặt `createPaymentTx: false`.
4. Migration `20261026090000_concurrency_constraints_and_active_payment_invariants` giới hạn một payment `PENDING` hoặc `PAID` trên toàn rental. Không đáp ứng nhiều kỳ gia hạn đã trả tiền. Phải thay bằng invariant theo khoản thu/kỳ trong migration mới, không sửa migration đã áp dụng.
5. `src/rentals/rentals.service.ts:77`: `totalRentAmount` hiện bao gồm tiền cọc; không thể dùng trực tiếp làm doanh thu thuê. Thời hạn cũng bắt đầu ngay khi tạo hợp đồng chưa thanh toán.
6. `src/devices/devices.service.ts:719`: batch nút trống gọi `registerDevice`; đường này fallback sang Store/Customer đầu tiên tại dòng 348/364 và tạo nút ACTIVE. `getUnassignedDevices` lại suy ra từ INACTIVE. Cần provisioning kho riêng, không gán khách ngẫu nhiên.
7. `src/store-subscriptions/store-subscriptions.repository.ts:67`: current subscription chưa kiểm tra `startDate <= now` và dùng `endDate >= now`; cần sửa thành `[startDate, endDate)` và trả riêng các kỳ mua trước.
8. `src/store-subscriptions/store-subscriptions.service.ts:53`: còn cho phép đăng khi tổng plan bằng 0; chính sách phí bắt buộc phải fail-closed. `ProductsService.create` đang là điểm gọi kiểm tra; cần thống kê đủ update/publish/import/reactivate.
9. Schema `ButtonRental` chưa có Store giao/nhận hoặc lịch sử thiết bị theo lần thuê; `StoreWallet` chỉ có `balance` và `frozenBalance` của withdrawal, không phải sổ cọc.
10. Chưa thấy worker hết hạn rental/subscription trong `src`; `HmacAuthGuard` kiểm tra ACTIVE, chưa kiểm tra kỳ thuê. `requestRentalReturn` hiện chủ yếu đổi status; không phải quy trình hoàn cọc.
11. `NotificationsService.createAndDispatchNotification` lưu DB rồi gửi FCM fire-and-forget; chưa đủ bảo đảm retry sau crash. Dedupe DB notification không đồng nghĩa push được gửi đúng một lần.

## 5. Luồng nghiệp vụ đích

### 5.1 Thuê lần đầu

1. Khách chọn Store có quyền fulfillment và còn nút khả dụng, chọn địa chỉ và gói thuê.
2. Server xác minh Store, địa chỉ thuộc khách, giá từ package; giữ chỗ thiết bị trong transaction. Đề xuất reservation 15 phút, cấu hình được.
3. Tạo khoản thu: phí thuê và cọc là hai line riêng; trả QR động thật từ tài khoản/kênh thanh toán của Sàn.
4. Webhook/sync xác minh xác nhận tiền: ghi receipt, đánh dấu charge PAID, giữ cọc và phát sinh yêu cầu Store giao nút, trong cùng transaction DB với outbox.
5. Store xác nhận chuẩn bị/giao; bàn giao có bằng chứng nhận của khách hoặc pairing proof đã xác minh. Không cho staff tự sửa `paidThrough`.
6. Kích hoạt quyền thuê và bắt đầu kỳ đã mua. Khách ghép nút với Store/sản phẩm theo luồng hiện tại.

Nếu hết reservation nhưng tiền đến muộn: kiểm tra lại kho bằng transaction; nếu không thể thực hiện, ghi `PAID_UNFULFILLABLE` và tạo quy trình hoàn tiền. Không bỏ qua khoản tiền thật, không âm thầm cấp thiết bị của khách khác, không tự đổi Store khách chọn.

### 5.2 Gia hạn/hết hạn

- Tạo charge gia hạn PENDING không tăng quyền dùng.
- Thanh toán thành công mới cập nhật thời hạn đã mua, một lần cho mỗi charge. Admin có đường cấp/điều chỉnh quyền riêng tại mục 14; không được dùng đường đó giả mạo PAID.
- Job hết hạn kiểm tra lại giá trị mới trong transaction; job cũ không được khóa rental vừa gia hạn.
- Đường bấm tạo đơn kiểm tra trực tiếp quyền thuê trong transaction tạo đơn: không phụ thuộc cron, cache dashboard hay biến ACTIVE đơn lẻ.
- Firmware/config nhận `canOrder`, `effectiveExpiresAt`, `disabledReason`, `configVersion`. Thông tin kỳ đã mua và quyền Admin cấp được hiển thị riêng ở ứng dụng. Khi thiết bị offline, không hứa tắt phần cứng tức thì; backend vẫn từ chối nghiệp vụ mới sau hết hạn.
- Vẫn cho phép các thao tác an toàn cần thiết như telemetry/config để phục hồi; không gom tất cả vào một guard chặn toàn bộ khi hết hạn. Nút bị thu hồi bảo mật vẫn chịu quy tắc riêng.

### 5.3 Trả nút/hoàn cọc

1. Khách tạo return request; chưa hoàn cọc ngay.
2. Store phụ trách nhận đúng serial và ghi nhận kiểm tra, bằng chứng, thời điểm, người thao tác.
3. Transaction thu hồi quyền dùng, bỏ cấu hình/phiên pairing của khách cũ, giữ lịch sử thuê; thiết bị chờ kiểm tra hoặc về kho nếu đạt.
4. Tạo refund claim tối đa số cọc còn được hoàn; snapshot ngân hàng đã xác minh, chỉ lưu encrypted/hash/masked.
5. Admin có quyền tài chính duyệt; worker dùng adapter payout, không gọi mạng khi đang giữ DB row lock.
6. Chỉ khi provider xác nhận thành công mới ghi REFUNDED. Timeout là UNKNOWN/RECONCILING, không coi là chưa chuyển tiền để gửi lại với mã mới.

Return receipt và deposit refund là hai tiến trình riêng. Thiết bị có thể đã nhận lại nhưng tiền vẫn đang chờ đối soát. Trả một nút trong gói nhiều nút chỉ thu hồi/hoàn cọc nút đó.

### 5.4 Store trả phí 60k

- Store có thể trả bằng số dư doanh thu khả dụng hoặc QR động về Sàn; không bắt Store mới phải có doanh thu trước mới đăng ký được.
- Wallet debit, ledger và entitlement phải atomic; QR thì chỉ cấp entitlement sau xác nhận tiền.
- Hai kênh thanh toán cùng một charge phải dùng chung trạng thái/khóa; tiền đến sau khi charge đã được thanh toán phải được ghi nhận để hoàn/đối soát, không gia hạn hai lần.
- Hết phí chỉ hạn chế khả năng kinh doanh đã quy định, không cấm đăng nhập, xem lịch sử, thanh toán lại hoặc hoàn thành nghĩa vụ với khách.

## 6. Dữ liệu/ERD đề xuất

Tái sử dụng `Store`, `SubscriptionPlan`, `StoreSubscription`, `RentalPackage`, `ButtonRental`, `IoTButton`, `PaymentTransaction`, `Notification`, `StoreWallet`, `WalletTransaction`. Không tạo bộ bảng Store/Product/Wallet song song cho Admin.

| Thay đổi | Dữ liệu và invariant |
|---|---|
| Store fulfillment capability | Admin bật/tắt điểm giao; store active không tự động có quyền giữ/giao thiết bị |
| IoTButton inventory fields | Custody store nullable, inventoryState, operational/security state độc lập; kho Sàn không cần Store giả hoặc khách giả |
| `device_movements` | Device, nguồn/đích, loại di chuyển, actor, thời điểm, rental/return reference; không sửa lịch sử |
| `rental_items` | Rental + device + giá/cọc snapshot + activatedAt + paidThrough + returnedAt; giữ lịch sử một thiết bị qua nhiều lần thuê |
| `device_reservations` | Device + rental/item + expiresAt + status; unique một reservation/live allocation trên mỗi device bằng cơ chế claim thống nhất |
| ButtonRental mở rộng | fulfillmentStoreId, address snapshot, policyVersion, fulfillmentStatus; không suy ra Store này từ cấu hình nút |
| `billing_charges` + `billing_charge_lines` | Chủ thể thuê/subscription, kỳ, mục đích, currency, số tiền snapshot; line phân biệt RENT/DEPOSIT/STORE_SUBSCRIPTION |
| PaymentTransaction mở rộng | Charge liên quan, reference/provider event duy nhất; giữ tương thích order payment hiện có; nhiều lần thanh toán theo thời gian không bị chặn bởi rentalId |
| `rental_deposits` | Theo rental item: collectedAmount, heldAmount, refundReservedAmount, refundedAmount; không coi số cọc phải thu là tiền đã nhận |
| `rental_returns` + items | Request, serial nhận lại, inspection, evidence, actor; chỉ một return đang mở trên mỗi item |
| `deposit_refunds` + `refund_attempts` | Refund claim, amount, encrypted recipient snapshot, provider reference, trạng thái, lỗi đã làm sạch và audit approval |
| `platform_financial_entries` | Nhật ký bất biến thu thuê/thu cọc/thu phí Store/hoàn tiền; unique business reference, entry reversal thay vì sửa giao dịch cũ |
| `outbox_events` | Ghi cùng transaction nghiệp vụ; worker claim có lease, attempts, nextAttemptAt, processedAt và dedupe key |
| Access entitlement + adjustment history | Rental item và Store có quyền sử dụng hiệu lực riêng với version; lịch sử PAID_PERIOD/ADMIN_GRANT/ADMIN_SET_END/ADMIN_EXTENSION, actor, reason và before/after; không sửa financial ledger |
| `customer_bank_accounts` | Customer/user owner rõ ràng, encrypted/hash/masked, verification status; tái sử dụng adapter bảo mật, không dùng StoreBankAccount của người khác |

Chi tiết bắt buộc:

- Money dùng Decimal hoặc số nguyên VND được kiểm tra chặt, không dùng phép toán float cho ledger.
- Không tái sử dụng `frozenBalance` của Store withdrawal để giữ cọc rental.
- Conservation cho mỗi deposit: `collected = held + refundReserved + refunded` khi chưa có nghiệp vụ khấu trừ. Tất cả không âm; `requestedRefund <= held` dưới khóa.
- Charge settlement chỉ cấp quyền/ghi ledger một lần. Lưu receipt của mọi khoản tiền nhận thật, kể cả thanh toán dư/trùng, vào luồng đối soát thay vì đánh mất dữ liệu vì unique conflict.
- Thiết kế CHECK theo payment purpose: đơn hàng có order, thuê có rental charge, subscription có subscription charge. Chỉnh CHECK cũ `order_id IS NOT NULL OR rental_id IS NOT NULL` bằng migration mới cho subscription.
- Dùng một canonical claim cho mỗi thiết bị để reservation và rental active không lọt qua hai partial index độc lập. Một bảng allocation với trạng thái RESERVED/RENTED và unique live device là phương án phù hợp; có thể gộp `device_reservations` vào bảng này khi chốt ERD.
- Index theo `(fulfillment_store_id, status)`, `(status, paid_through)`, `(status, expires_at)`, `(status, next_attempt_at)`, charge/payment provider refs; kiểm tra EXPLAIN trên dữ liệu test.
- Giá và điều khoản snapshot theo charge/item; thay giá package không sửa khoản thu cũ.
- Dashboard phân biệt tiền thuê đã thu, phí Store đã thu, tiền cọc phải trả, cọc đang hoàn và cọc đã hoàn. Không cộng cọc vào doanh thu hoặc GMV bán hàng; chưa gọi tiền thu trước là doanh thu ghi nhận theo kỳ nếu chưa có chính sách tương ứng.

## 7. API cần giữ, sửa và thêm

Tất cả đường dẫn dưới đây có prefix `/api/v1`. Đây là inventory API triển khai đề xuất, không phải tất cả đã tồn tại. Route cũ tiếp tục qua adapter tương thích; không đổi ngầm semantics response cho frontend.

### A. Store/subscription

| API | Hành động |
|---|---|
| `POST /admin/stores` | Thêm nếu Admin phải tạo trực tiếp Store; owner phải được định danh hợp lệ; transaction Store + membership + cấu hình ban đầu |
| `GET /admin/stores` | Mở rộng lọc còn hạn/sắp hết hạn/hết hạn, fulfillment capability |
| `PATCH /admin/stores/:id/fulfillment-settings` | Thêm bật/tắt nhận giao nút; không cho Store tự nhận quyền |
| `GET /subscription-plans` | Giữ, thêm plan 60k qua dữ liệu cấu hình có version |
| `GET /store/subscriptions`, `/current`, `/:id` | Giữ, sửa phân biệt current/upcoming/expired; tránh route động nuốt route tĩnh |
| `POST /stores/:storeId/subscription-charges` | Thêm khoản thu phí duy trì; scope owner/được ủy quyền và giá server |
| `POST /billing-charges/:id/payment-requests` | QR thu về Sàn cho charge có quyền truy cập |
| `POST /billing-charges/:id/wallet-payments` | Chỉ subscription và owner hợp lệ; trừ ví khả dụng, không mở chức năng ví khách |
| `GET /billing-charges/:id` | Poll trạng thái, số tiền tách line, kỳ, entitlement và phương thức đã dùng |
| `POST /store/subscriptions/subscribe` | Giữ route cũ, đưa về cùng charge/settlement engine và bắt buộc idempotency |

### B. Kho thiết bị và giao nút

| API | Hành động |
|---|---|
| `POST /devices/batch-generate`, `/devices/allocate-store` | Sửa service/repo hiện hữu; thêm resource alias `/device-batches`, `/device-allocations` nếu cần chuẩn REST; không tạo hai implementation |
| `GET /admin/devices` | Danh sách kho toàn Sàn, filter custody/lifecycle/serial, pagination |
| `GET /stores/:storeId/device-inventory` | Kho serial theo Store; không dùng Inventory của Product để suy ra số nút |
| `GET /devices/:id/movements` | Lịch sử điều chuyển, che dữ liệu khách ngoài phạm vi |
| `GET /rental-fulfillment-stores` | Các điểm giao đủ điều kiện; vị trí/filter đơn giản, không tự thêm routing/map platform |
| `GET /stores/:storeId/rental-fulfillments` | Hàng đợi cần chuẩn bị/giao/nhận lại |
| `PATCH /rental-fulfillments/:id/status` | Chuyển trạng thái theo state machine; không chứa quyền sửa payment/deposit |
| `POST /rentals/:id/handovers` | Xác nhận bàn giao có proof; kích hoạt rental items đã thanh toán |

### C. Thuê/gia hạn/trả

| API | Hành động |
|---|---|
| `GET /rentals/packages` | Giữ, DTO rõ giá trên mỗi nút/gói; cấu hình admin hiện hữu tái sử dụng |
| `POST /rentals/order` | Giữ, thêm Store giao + address + reservation; hoặc alias `POST /rentals` cùng service |
| `GET /rentals/my-rentals`, `GET /rentals/:id` | Giữ, thêm items, paidThrough, countdown và fulfillment; phân trang danh sách |
| `POST /rentals/:id/payment-requests` | Sửa: tạo link thật cho initial charge; không tự dựng QR/provider ID |
| `POST /rentals/:id/extensions` | Sửa: tạo yêu cầu gia hạn/charge chưa thanh toán. Nếu response semantics khác contract cũ, thêm route mới `/rentals/:id/renewal-charges` và deprecate route cũ có lộ trình |
| `POST /rentals/:id/return-requests` | Sửa: tạo resource return, chọn item, không chỉ PATCH status và không tự hoàn tiền |
| `GET /rental-returns/:id` | Thêm xem tiến độ trả/kiểm tra/hoàn tiền theo ownership |
| `POST /rental-returns/:id/receipts` | Store/nhân viên được giao xác nhận serial nhận lại và kiểm tra |
| `GET /admin/rentals` | Giữ, thêm filter Store giao, hết hạn, chờ giao, chờ trả |
| `PATCH /admin/rentals/:id/status` | Không cho chuyển tùy ý sang PAID/ACTIVE/REFUNDED; route đặc quyền vẫn phải dùng cùng domain transition |

### D. Cọc/tài chính

| API | Hành động |
|---|---|
| `GET /customers/me/rental-deposits` | Cọc thực nhận/đang giữ/đang hoàn/đã hoàn của đúng khách |
| `POST /rental-returns/:id/refund-requests` | Yêu cầu hoàn cọc, chống trùng, giới hạn số còn hoàn; không chấp nhận amount tùy ý |
| `GET /deposit-refunds/:id` | Poll tiến độ hoàn; tài khoản chỉ masked |
| `POST /deposit-refunds/:id/recipient-verifications` | Xác minh tài khoản nhận tiền thuộc khách theo cơ chế provider đã được kiểm chứng; không tái sử dụng StoreBankAccount sai ownership |
| `GET /admin/deposit-refunds` | Hàng đợi duyệt/đang xử lý/đối soát/thất bại |
| `POST /admin/deposit-refunds/:id/approvals` | SUPER_ADMIN duyệt; outbox tạo lệnh chi sau commit |
| `POST /admin/deposit-refunds/:id/reconciliations` | Yêu cầu sync provider khi pending/unknown; không reset success thành pending |
| `GET /admin/platform-financials` | Tổng hợp thuê/thu phí/cọc tách biệt |
| `GET /admin/platform-financial-transactions` | Ledger có pagination/filter và reference; không trả secret/bank plaintext |

Webhook nhận tiền và payout giữ endpoint hiện hữu, route vào handler theo loại charge/refund/reference. Chỉ tái sử dụng provider adapter/signature sau kiểm chứng; không giả mạo deposit refund thành StoreWithdrawal.

### E. Notifications/dashboard

- Giữ `GET /notifications`, `GET /notifications/unread-count`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`.
- Bổ sung filter type/readStatus; không tạo Notification Center thứ hai.
- Giữ bốn dashboard hiện có, thêm các block thuê nút phù hợp role.
- Admin: thời hạn Store, phân bổ kho, thuê, cọc/hoàn, outbox lỗi.
- Store owner: hạn 60k, kho nút giữ hộ, việc giao/nhận; không cộng tiền cọc Sàn vào ví Store.
- STAFF_BUTTON/STAFF_DELIVERY theo phân công: chỉ thiết bị và việc giao/nhận; không lộ tổng thu/cọc/tài chính.
- Customer: rental items, ngày còn lại, điểm giao/nhận, cọc và tiến độ hoàn.

### F. Điều chỉnh thời hạn bởi Admin

| API | Hành động |
|---|---|
| `POST /admin/rental-items/:id/access-adjustments` | EXTEND hoặc SET_EXPIRY cho đúng nút trong hợp đồng; không chuyển payment thành PAID |
| `GET /admin/rental-items/:id/access-adjustments` | Lịch sử điều chỉnh, người sửa, lý do và hạn trước/sau |
| `POST /admin/stores/:id/access-adjustments` | Cấp quyền gian hàng dù chưa mua subscription, cộng ngày hoặc đặt lại hạn |
| `GET /admin/stores/:id/access-adjustments` | Lịch sử thay đổi quyền sử dụng gian hàng, độc lập lịch sử đóng phí |
| `GET /customers/me/bank-accounts` | Danh sách tài khoản nhận tiền của đúng khách, chỉ trả masked |
| `POST /customers/me/bank-accounts` | Đăng ký ngân hàng nhận cọc, không cho tự khai verified/account owner |
| `POST /customer-bank-accounts/:id/verifications` | Bắt đầu verification thuộc khách; tái sử dụng pipeline đã kiểm chứng phù hợp provider |
| `DELETE /customer-bank-accounts/:id` | Ngừng dùng tài khoản; giữ snapshot của refund đang xử lý, không xóa chứng từ |

Các endpoint tạo verification theo refund ở mục D dùng cùng service verification này, không triển khai hai luồng xác minh độc lập. Có thể bỏ alias theo refund nếu frontend dùng resource ngân hàng chung.

## 8. Kiến trúc, quyền và độ tin cậy

- Giữ NestJS và pipeline 6 lớp. Service điều phối nghiệp vụ; Repository thực hiện toàn bộ DB transaction, query có parameter; controller không chứa Prisma.
- Validation Zod theo AGENTS; nếu tích hợp DTO class-validator hiện hữu, chọn adapter thống nhất và test không có đường bypass. DTO whitelist, money từ server, IDs serialize string, pagination tối đa 100, envelope và errorCode chuẩn.
- SUPER_ADMIN quản lý chính sách/tài chính. ADMIN/SYSTEM_ADMIN đọc theo quyền hiện hành; không mở rộng class-level AdminController để tiện phát triển.
- Customer chỉ thấy hợp đồng/cọc của chính mình. Store/staff chỉ truy cập fulfillment được giao, không dùng configured store của nút làm quyền xem rental.
- Bắt buộc idempotency trên tạo charge, thu tiền, reservation, handover, return/refund và payout approval. Business unique key tồn tại lâu dài, không chỉ cache response 24h.
- Transaction khóa canonical allocation/rental item/charge/deposit theo thứ tự thống nhất. Test renewal-vs-expiry, return-vs-renewal và double delivery.
- Outbox ghi cùng transaction nghiệp vụ; publish at-least-once, consumer có dedupe DB. Enqueue thành công rồi crash hoặc commit xong chưa enqueue đều có đường phục hồi.
- Queue/worker trên Redis dùng chung khi nhiều node; PostgreSQL là nguồn sự thật. Không bật thu/hoàn tự động trên cấu hình queue-memory riêng từng node. Readiness và cấu hình production phải được xác minh trước release, không suy ra từ handoff cũ.
- Job scheduler dùng claim DB/lease, event key bền vững, xử lý theo batch và chạy bù sau downtime. Không giả định chỉ có một process cron.
- Cache chỉ dùng read views; không dùng cache 30s quyết định tiền, ownership hoặc quyền nút đã hết hạn. Invalidation sau commit theo userId khách và đúng Store; multi-node fallback chỉ bảo đảm eventual freshness, không hứa invalidation RAM toàn cụm.
- Log có correlation/event IDs, không có token hoặc account plaintext. Metrics tối thiểu: expiry lag, outbox lag, số refund UNKNOWN, retry/DLQ, chênh lệch đối soát.

## 9. Waterfall triển khai theo task và cổng nghiệm thu

### Phase 0 — Chốt nghiệp vụ và contract

- P0.1 Duyệt mô hình fulfillment; chốt 30 ngày/tháng lịch, bàn giao, mất/hỏng, phí vận chuyển và hủy trước giao.
- P0.2 Viết state matrix riêng cho inventory, rental entitlement, fulfillment, charge, return, refund.
- P0.3 Viết ma trận role/action/tenant và metric definitions cho dashboard.
- P0.4 Kiểm tra provider với tài khoản Sàn: thu tiền, QR, payout, recipient verification và nguồn tiền hoàn; lập test contract offline trước.
- P0.5 Khảo sát dữ liệu thật bằng truy vấn read-only: nút có chủ, rental cũ, payment đã thu, cọc đã hoàn, mapping Store; không suy đoán từ `ACTIVE`.
- Cổng: chính sách/ERD/API contract được duyệt; không bắt đầu migration tài chính nếu nguồn tiền hoặc ownership chưa rõ.

### Phase 1 — Schema, ledger và settlement chung

- P1.1 Additive migrations cho allocation/movement, rental item, charge/line, deposit/refund/attempt, financial entries và outbox.
- P1.2 Backfill có dry-run; đánh dấu LEGACY_REVIEW khi thiếu chứng từ, không tự coi cọc khai báo là đã nhận tiền.
- P1.3 Thêm migration thay unique rental payment theo charge; update CHECK cho subscription, không sửa migration cũ.
- P1.4 Tách provider adapter khỏi PaymentsService order-only; charge settlement dispatch ORDER/RENTAL/SUBSCRIPTION.
- P1.5 Chứng minh atomic money + entitlement + outbox, chống webhook trùng/sai tiền/sai chủ thể.
- P1.6 Access entitlement projection và adjustment history độc lập payment; version/locking dùng chung cho thanh toán, Admin adjustment và expiry worker.
- File trọng tâm: `prisma/schema.prisma`, migrations mới, `src/payments/*`, module billing/deposit/platform-finance/outbox mới.
- Cổng: integration DB thật cô lập kiểm tra rollback, constraints, receipt dedupe và không tạo quyền khi chưa thu tiền.

### Phase 2 — Store 60k và kho thiết bị

- P2.1 Thêm Admin create Store nếu cần; bật capability fulfillment độc lập trạng thái Store.
- P2.2 Cấu hình plan 60k, snapshot giá; thanh toán wallet/QR cùng charge engine.
- P2.3 Sửa current/upcoming và enforcement publish/create/reactivate/import; bỏ fail-open no-plans.
- P2.4 Tách provisioning kho khỏi registerDevice gán khách; bỏ fallback Store/Customer đầu tiên cho nút kho.
- P2.5 Allocation/transfer/history + inventory read views; không allocate nút đang reserved/rented hoặc đang bị kiểm tra.
- P2.6 Admin cấp/sửa hạn Store không qua payment; Products enforcement đọc effective entitlement thay vì chỉ tìm subscription ACTIVE đã mua.
- File trọng tâm: `src/admin/*`, `src/stores/*`, `src/store-subscriptions/*`, `src/products/*`, `src/devices/*`.
- Cổng: Store hết hạn không publish mới; vẫn trả nút/gia hạn; hai Store không nhận cùng một serial.

### Phase 3 — Thuê, bàn giao, gia hạn và khóa hết hạn

- P3.1 Tạo rental với Store giao, address snapshot và giữ chỗ trước QR.
- P3.2 Thay link giả bằng provider; settlement tiền thuê/cọc; xử lý hết reservation và tiền đến muộn.
- P3.3 Hàng đợi Store, handover proof, activation và pairing an toàn.
- P3.4 Gia hạn theo charge đã trả tiền, không thêm cọc lần nữa; giá/kỳ snapshot.
- P3.5 Runtime entitlement check + expiry worker + config firmware; áp dụng cả stored procedure và fallback tạo đơn IoT.
- P3.6 Giữ remap: thay Store nhận đơn không thay fulfillment contract/cọc.
- P3.7 Admin chỉnh hạn rental item với audit, reason, optimistic version, idempotency và notification; không đổi deposit hoặc bỏ qua handover/security hold.
- File trọng tâm: `src/rentals/*`, `src/devices/*`, `src/iot/*`, `src/orders/*`, guards và migration stored procedure mới.
- Cổng: không thu tiền hai lần, không cấp hai khách một nút, không bấm được sau hết hạn dù worker dừng.

### Phase 4 — Nhận trả, thu hồi và hoàn cọc

- P4.1 Return resource theo item, receipt/inspection, thu hồi quyền và làm sạch cấu hình khách cũ.
- P4.2 Refund claim và xác minh ngân hàng khách (không mở customer wallet).
- P4.2a Customer bank accounts riêng theo ownership; tái sử dụng mã hóa/provider, snapshot tài khoản khi duyệt refund và không đổi đích lệnh chi đã gửi.
- P4.3 Admin approval, reserve cọc, provider payout ngoài DB transaction; terminal success/failure/unknown được phân biệt.
- P4.4 Đối soát tự động/manual-trigger, retry cùng reference cho cùng attempt; attempt mới chỉ sau thất bại chắc chắn.
- P4.5 Hủy trước bàn giao: refund rent + deposit theo line, giải phóng reservation; không dùng cùng công thức hoàn cọc sau thuê.
- Cổng: tổng tiền hoàn không vượt tiền nhận; timeout/crash/replay không tạo lần chi thứ hai; thiết bị đã trả không dùng được credential của khách cũ.

### Phase 5 — Jobs, notifications, dashboards và release

- P5.1 Jobs reservation expiry, rental expiry, subscription reminders/expiry, outbox dispatch, payout reconciliation.
- P5.2 Notification matrix đúng người nhận; unique `(recipient, event, entity, period, threshold)`; renewal đổi kỳ không bị job cũ nhắc sai.
- P5.3 Dashboard và drill-down từ receipts/ledger, không lấy tổng hợp đồng gồm cọc làm doanh thu; giữ guard staff và tenant isolation.
- P5.4 Tích hợp tests mới vào master runner, kiểm tra HTTP thật bằng Nest app + DB/Redis cô lập, không chỉ mock gọi helper.
- P5.5 Pilot một Store, số thiết bị nhỏ; đối soát tiền/cọc hằng ngày. Xác minh môi trường production, Redis chung, worker readiness và phương án rollback feature flag.
- P5.6 Cập nhật BRD, ERD đang được người dùng chỉnh bằng patch phối hợp, Swagger, handoff và hướng dẫn vận hành.
- Cổng: toàn bộ acceptance dưới đây đạt và không còn ledger chưa đối soát trước khi mở rộng rollout.

Trong từng task: viết failing test đúng nghiệp vụ → xác nhận fail → implementation tối thiểu qua 6 lớp → chạy lại + regression → review. Không tự commit/push/deploy nếu chưa được yêu cầu.

## 10. Acceptance bắt buộc, không thay bằng số lượng assertion

1. Thuê một nút một kỳ: thu đúng 230.000; phí thuê 30.000, liability cọc 200.000, ví Store không tăng.
2. Gia hạn một kỳ: thu 30.000, cọc không tăng; request chưa trả tiền không đổi `paidThrough`.
3. Hai webhook cùng charge: một settlement/entitlement; receipt tiền dư không bị bỏ mất.
4. Cùng serial được hai khách thuê đồng thời: một reservation thành công, bên còn lại conflict và không bị thu tiền cho phần không cung cấp được.
5. Mua trước kỳ Store không cấp quyền trước `startDate`; đúng `endDate` bị coi là hết hạn.
6. Store hết hạn: create/publish/reactivate bị chặn, kể cả import; return/refund/gia hạn vẫn được phép.
7. Worker dừng qua hạn: request IoT mới bị từ chối; replay yêu cầu cũ không sinh đơn mới.
8. Job expiry cũ chạy sau gia hạn: không khóa rental đã có hạn mới.
9. Remap Store A sang B: không thay bên nhận tiền, cọc, Store giao hoặc quyền đọc của staff ngoài phạm vi.
10. Trả một nút trong gói nhiều nút: chỉ thu hồi và hoàn phần cọc của nút đó.
11. Return request chưa có receipt không được chi cọc; nhận thiết bị sai serial bị từ chối.
12. Refund timeout nhưng provider đã chuyển: reconciliation ghi thành công, không chi lại. Webhook trùng, đảo thứ tự không đảo terminal state.
13. Crash sau DB commit trước enqueue: outbox xử lý lại; crash sau payout trước lưu kết quả: query provider theo reference đã lưu.
14. Tổng collected/held/reserved/refunded đối chiếu đúng sau success/failure/retry; không dùng tiền cọc trả phí Store.
15. Store/khách/staff sửa ID, amount, paidThrough, owner hoặc status nhạy cảm bị chặn; staff dashboard không lộ finance.
16. Không có ngân hàng plaintext/secret trong DB logs/API; notification dedupe đúng recipient và kỳ.
17. HMAC/config/pairing của người thuê cũ không dùng được sau thu hồi; workflow cấp mới không làm lộ credential.
18. Late payment sau hủy/hết reservation được đối soát/hoàn đúng, không tạo hợp đồng ACTIVE không có thiết bị.
19. Sàn thiếu số dư chi: refund vẫn chờ xử lý/cảnh báo, không tuyên bố đã hoàn và không mất nghĩa vụ cọc.
20. Test cache giữ các invariant đã nghiệm thu: userId khác customerId, user 7/77, old/new Store, post-commit, cache outage không nuốt DB error.
21. Admin tặng 7 ngày rental hoặc 30 ngày Store: quyền hiệu lực tăng nhưng payment, doanh thu và tiền cọc không thay đổi.
22. Admin đặt hạn ngắn hơn paid period: chỉ quyền hiệu lực thay đổi, kỳ đã trả tiền giữ nguyên và ghi audit; UI yêu cầu xác nhận ảnh hưởng tới quyền đã mua.
23. Admin cấp hạn Store chưa từng thanh toán: Store có quyền từ ADMIN_GRANT, lịch sử đóng phí vẫn rỗng; không tạo subscription PAID giả.
24. Hai Admin sửa cùng version: một thành công, một 409; retry cùng idempotency key không cộng ngày hai lần.
25. Hạn đã điều chỉnh không bị worker/job cũ ghi đè; payment đang chờ bị tác động đi theo quy tắc reconciliation ở mục 14.
26. Điều chỉnh hạn không hồi sinh nút đã trả/đã cho khách khác thuê hoặc bỏ qua security hold; staff và ADMIN/SYSTEM_ADMIN chưa được cấp quyền không được gọi mutation này.
27. Tài khoản nhận tiền của khách A không dùng hoàn cho khách B; liên kết ngân hàng chưa verified không đủ điều kiện chi. Thay tài khoản sau khi gửi payout không đổi snapshot của attempt đang mở.
28. Hết hạn thuê không xóa số cọc còn giữ; chỉ “không sử dụng nữa” mà chưa trả thiết bị không kích hoạt chi tiền tự động.

Lệnh dự kiến khi triển khai: `npx tsc --noEmit`, `npm run build`, `npx prisma validate`, migration replay trên TEST_DATABASE_URL cô lập, suites liên quan và master runner sau kiểm tra isolation. Chưa chạy các lệnh này trong task lập kế hoạch.

## 11. Migration và tương thích

- Expand → backfill có đối soát → deploy reader/writer mới → validate constraints → retire đường cũ. Không áp NOT NULL khi chưa xác minh dữ liệu cũ.
- IoTButton.storeId hiện bắt buộc và nằm trong composite keys: đánh giá tất cả FK/query/DTO/guards trước khi cho null ở kho Sàn. Không sửa mỗi Prisma field rồi coi migration hoàn tất.
- Giữ legacy order/payment flows. Rental cũ nhiều nút phải có mapping item rõ ràng; missing payment evidence vào hàng đợi review, không auto-credit cọc.
- Không sửa số tiền/hạn hợp đồng cũ để ép về 30k/200k. Chính sách mới có effective date/version.
- Feature flag có thể ngừng nhận thuê mới nhưng không được dừng webhook, trả nút, đối soát hoặc hoàn tiền đang mở.
- Không rollback dữ liệu tiền bằng DROP bảng. Sửa bằng migration tiến và entry bù có audit.

## 12. QR và điều kiện vận hành

Khách có thể trả QR về tài khoản/kênh PayOS của Sàn mà không có Store Admin trong database. Cần QR động cho từng charge và provider reference, không dựa vào screenshot hoặc nút “đã chuyển”. QR tĩnh chuyển thẳng ngân hàng không đủ tự xác định khoản thu, số tiền, hợp đồng và retry.

Tài liệu [payOS API](https://payos.vn/docs/api/) có API payment requests và payouts riêng; payout cần reference, chữ ký và idempotency key. [Tài liệu chữ ký](https://payos.vn/docs/tich-hop-webhook/kiem-tra-du-lieu-voi-signature/) phân biệt chữ ký payout với payment requests. Không giả định nhận tiền vào ngân hàng đồng nghĩa tài khoản chi luôn đủ tiền hoặc đã được bật dịch vụ payout; phải kiểm chứng cấu hình, quyền sử dụng và khả năng đối soát trước release.

Việc tách quỹ trên database chỉ là kiểm soát phần mềm, không tự khóa được tiền trong tài khoản ngân hàng. Cần quy trình vận hành bảo đảm quỹ hoàn cọc; pháp lý/hợp đồng giữ cọc nằm ngoài chứng nhận của kế hoạch kỹ thuật này.

## 13. Bước code đầu tiên đề xuất

Sau khi duyệt Phase 0: bắt đầu bằng test và migration cho `billing_charges`, settlement theo purpose và payment uniqueness theo kỳ. Đây là nền tảng để sửa payment rental giả và gia hạn trước thanh toán. Làm song song trong cùng phase thiết kế ownership/custody, không bắt đầu bằng UI ví Store hay thêm API toggle status.

Tài liệu mới là đầu ra duy nhất của task này. Không thay source, schema, migration, cấu hình hoặc test; không sửa SESSION_HANDOFF.md, không chạy thanh toán, test dữ liệu thật, commit hoặc push.

## 14. Bổ sung yêu cầu: hoàn cọc và Admin tự điều chỉnh thời hạn

### 14.1 Phần ngân hàng hiện tại có thể tái sử dụng đến đâu

Đã đọc lại `src/bank-verification/bank-verification.service.ts:480` và `prisma/schema.prisma` model StoreBankAccount: tài khoản hiện gắn storeId và quyền chủ Store. Đây không phải tài khoản ngân hàng Customer dùng chung. Không mở guard Store cho CUSTOMER để tái sử dụng endpoint một cách trực tiếp.

Giữ adapter lookup/verification, crypto vault, masked DTO và payout transport khi phù hợp. Thêm ownership Customer, repository/table riêng, hoặc chỉ tổng quát hóa account ownership sau khi có migration tương thích và ràng buộc đúng một owner. Phương án ít ảnh hưởng đợt này là customer_bank_accounts riêng.

Hoàn cọc là yêu cầu bắt buộc đã có trong Phase 4: khách yêu cầu trả → Store nhận đúng nút → kiểm tra → duyệt hoàn số cọc thực giữ → payout vào tài khoản đã xác minh của khách → xác nhận hoàn. Không coi việc liên kết ngân hàng là đã có đầy đủ quy trình hoàn cọc. Tra cứu tên tài khoản không tự chứng minh quyền sở hữu; cách verification cụ thể phải được kiểm chứng với provider trước khi mở payout.

Cọc 200.000 được hoàn đủ khi thực nhận đủ 200.000 và thiết bị đạt điều kiện trả. Không sử dụng nút, hết thời hạn hoặc Admin giảm hạn không tự làm mất cọc. Phí thuê đã sử dụng và tiền cọc là hai khoản khác nhau; mất/hỏng/khấu trừ cần chính sách riêng, chưa tự áp dụng.

### 14.2 Đồng hồ thời hạn

- Tiếp tục đề xuất một kỳ = 30 ngày; chưa coi người dùng đã chốt thay cho tháng lịch.
- Rental: nhận tiền giữ quyền bàn giao; thời gian thuê bắt đầu từ handover/activation đã xác minh. Store: quyền từ thời điểm kỳ thuê gian hàng bắt đầu.
- Lưu timestamp UTC; hiển thị Asia/Ho_Chi_Minh. API trả `serverNow`, `effectiveStartsAt`, `effectiveExpiresAt`, `remainingSeconds`, `accessSource`, `accessVersion`; đếm ngược UI không có quyền quyết định backend.
- Khoảng hiệu lực là `[effectiveStartsAt, effectiveExpiresAt)`; đúng thời điểm kết thúc là hết hạn. `remainingSeconds = max(0, floor((effectiveExpiresAt - serverNow) / 1000))` chỉ phục vụ hiển thị.
- Gia hạn trả tiền khi không có xung đột: từ hạn hiệu lực hiện tại nếu còn hạn, từ now nếu đã hết hạn. Kỳ/giá/start-end được snapshot tại charge; lịch sử thu tiền vẫn độc lập với quyền Admin thay đổi.

### 14.3 Admin có thể thay đổi không cần tiền

Có. Quyền bao gồm cấp quyền dùng miễn phí, cộng thời gian, đặt chính xác ngày hết hạn, hoặc rút ngắn về thời điểm hiện tại. MVP không thêm quyền vô thời hạn. Với một gói nhiều nút, điều chỉnh theo rental item để không vô tình sửa các nút khác.

Phải phân biệt:

- Financial history: tiền đã thu và các kỳ đã mua, có receipt/charge bất biến.
- Effective entitlement: quyền thật đang được áp dụng, có thể từ thanh toán hoặc ADMIN_GRANT/ADJUSTMENT.
- Physical/security eligibility: đã bàn giao, chưa trả, đúng người thuê, không bị thu hồi/báo mất/khóa bảo mật.

Không dùng `max(paidThrough, adminExpiresAt)` làm công thức duy nhất vì nó không cho Admin rút ngắn kỳ đã mua. Thay vào đó dùng projection quyền hiệu lực cập nhật atomically từ chuỗi event có version. Lịch sử kỳ mua không bị sửa khi Admin đặt lại hạn.

Body đề xuất:

```json
{
  "operation": "SET_EXPIRY",
  "expiresAt": "2026-12-01T00:00:00+07:00",
  "reason": "Điều chỉnh theo yêu cầu hỗ trợ",
  "expectedVersion": 4
}
```

EXTEND nhận `additionalDays` số nguyên dương, không nhận expiresAt đồng thời; tính từ max(now, effectiveExpiresAt). SET_EXPIRY nhận timestamp có timezone, có thể ngắn hơn hạn hiện tại; nếu ngày đã qua thì mất quyền ngay, không viết lại lịch sử sử dụng trước đó. Ngày kết thúc trước ngày bắt đầu bị từ chối; thu hồi quyền tức thì dùng thời điểm hiện tại cho quyền đã bắt đầu.

- Chỉ SUPER_ADMIN theo phân quyền hiện hành; tên “Admin” trên UI không tự cấp quyền cho mọi role có chữ ADMIN. Muốn phân quyền thêm phải cấp permission riêng, không mở bypass RolesGuard.
- Bắt buộc reason, idempotency key và expectedVersion. Audit giữ actor, source, trước/sau, thời điểm, request ID và lý do. Correction là event mới, không xóa audit.
- Không đổi amount, payment status, deposit amount hoặc refundedAmount. Cấp thời hạn không đồng nghĩa đã nộp cọc; điều kiện giao thiết bị/cọc được xử lý riêng. Không ngầm miễn cọc vì tặng thời gian.
- Rút ngắn phần khách/Store đã mua cần màn hình cảnh báo/xác nhận và thông báo cho bên bị ảnh hưởng. Refund phí thuê nếu có phải là workflow riêng, không tự sửa ngày rồi xóa nghĩa vụ tài chính.
- Không mở lại hợp đồng đã trả/kết thúc hoặc thiết bị đã giao khách khác. Tạo hợp đồng/bàn giao mới khi thuê lại; gia hạn không vượt qua security hold.

### 14.4 Xử lý đồng thời với thanh toán và scheduler

Admin adjustment, settlement và expiry cùng khóa entitlement/item/Store theo thứ tự thống nhất. expectedVersion cũ trả 409; mỗi event chỉ cập nhật projection một lần.

Nếu Admin thay hạn trong khi có charge chưa thanh toán, không âm thầm ghi đè kỳ đã chào cho khách: đánh dấu charge cần báo giá lại và hủy link còn có thể hủy. Khoản tiền đến muộn vẫn lưu receipt và chuyển `PAID_REQUIRES_REVIEW` để xác định cấp đủ kỳ hoặc hoàn tiền; không bỏ tiền đã nhận, không giả định hủy link luôn thành công. Những charge chưa gửi thanh toán có thể thay bằng charge mới, không sửa receipt đã phát sinh.

Job hết hạn đọc lại effectiveExpiresAt/version trong transaction; job tạo trước adjustment tự trở thành no-op nếu không còn khớp. Mọi đường tạo đơn IoT và publish sản phẩm đọc cùng effective entitlement. Cache và notification được invalidation/dispatch sau commit, với event `RENTAL_ACCESS_ADJUSTED` hoặc `STORE_ACCESS_ADJUSTED`.

### 14.5 Vị trí trong roadmap

- Phase 0 chốt quyền Admin và ý nghĩa kỳ thời gian.
- Phase 1 thêm entitlement projection/history cùng ledger nhưng độc lập khoản tiền.
- Phase 2 triển khai Admin chỉnh hạn Store.
- Phase 3 triển khai Admin chỉnh hạn nút và hết hạn theo effective access.
- Phase 4 mở customer bank accounts + hoàn cọc thật.
- Phase 5 kiểm thử 28 tiêu chí trong mục 10 và dashboard hiển thị rõ “đã thanh toán” so với “Admin cấp thêm”.

---

## 15. Roadmap Hoàn thiện End-to-End & Kế hoạch Triển khai Từng Bước

### Phase 0 — Chốt hợp đồng nghiệp vụ và trạng thái nguồn
- **Rental State Machine:** `PENDING_PAYMENT` → `PENDING_HANDOVER` → `ACTIVE` → `EXPIRED`/`RETURNED`/`TERMINATED`.
- **Button Lifecycle:** Kho Sàn (`IN_PLATFORM_WAREHOUSE`) → Kho Store (`ALLOCATED_TO_STORE`) → Khách đang thuê (`RENTED_TO_CUSTOMER`) → Đang trả (`RETURN_IN_TRANSIT`) → Kho Store (`ALLOCATED_TO_STORE`).
- **Refund Lifecycle:** `PENDING_APPROVAL` → `PENDING_PAYOUT` → `REFUNDED`; lỗi/thiếu bằng chứng giữ `refund_reserved_amount`.
- **Chính sách giá:** `monthlyPrice` và `depositFee` được chuẩn hóa theo snapshot gói, không nhân/chia lặp số lượng nút.
- **Gia hạn Store:** Tạo charge gia hạn theo tháng thủ công, không tự động trừ tiền khi chưa có recurring được phê duyệt.

### Phase 1 — Nối thanh toán thật vào BillingCharge (Ưu tiên #1)
- Tạo payment request PayOS thật từ `BillingCharge`, gắn mã tham chiếu duy nhất, `amount` và `currency` với charge.
- Lưu PayOS order/payment-link ID vào charge; trả frontend checkout URL/QR lấy từ phản hồi đã kiểm tra.
- Nối callback/webhook PayOS vào luồng đối soát server-to-server hiện có; không tin trạng thái hoặc số tiền do client gửi.
- Chỉ settle khi mã charge, transaction reference, số tiền, tiền tệ và trạng thái provider cùng khớp.
- Dùng cùng luồng cho phí thuê ban đầu, gia hạn rental và phí duy trì Store; bỏ payment code/QR placeholder.
- Làm cho retry cùng idempotency key trả lại payment request hiện có, không tạo charge hoặc payment link trùng.
- Bảo đảm mock PayOS bị chặn ở mọi môi trường ngoài test, development, local, không riêng một vài method.

### Phase 2 — Gán Store và thiết bị cụ thể vào hợp đồng (Ưu tiên #2)
- Thêm API Admin/ops phân công `fulfillmentStoreId` và danh sách `buttonIds` cho rental đã đủ điều kiện (`PENDING_HANDOVER`).
- Trong một transaction: khóa rental, Store và các button theo thứ tự cố định; xác nhận Store hoạt động, thiết bị thuộc đúng kho (`ALLOCATED_TO_STORE`), chưa gắn rental/khách khác và đủ số lượng.
- Ghi `fulfillmentStoreId`, `rentalId`, `custodyStoreId`, trạng thái kho và `DeviceMovement` đồng bộ.
- Hủy hoặc đổi phân công phải có state transition riêng và audit; không sửa thẳng quan hệ button.
- Bàn giao chỉ được phép khi charge đã thanh toán, đúng Store giữ thiết bị và số nút khớp gói.
- Gỡ hoặc vô hiệu hóa đường `activateRental()` có thể bật `ACTIVE` ngoài quy trình bàn giao.

### Phase 3 — Hoàn tất quản lý phí duy trì Store 60.000đ/tháng (Ưu tiên #4a)
- Nối hàm tạo Store subscription charge vào endpoint gia hạn của Store.
- Dùng payment flow thật từ Phase 1; ghi lịch sử charge và subscription theo từng kỳ.
- Khi hết hạn, chặn đăng sản phẩm như hiện tại; khi thanh toán thành công, nối tiếp thời hạn từ ngày hết hạn cũ nếu còn hiệu lực, nếu đã hết thì tính từ thời điểm gia hạn.
- Không cho Store tự sửa `storeId`, giá gói hoặc trạng thái subscription qua body.
- Cảnh báo “sắp hết hạn” qua notification center.

### Phase 4 — Khóa hạn rental và xử lý hết hạn nhất quán (Ưu tiên #4b)
- Tạo job định kỳ/idempotent tìm rental đến hạn, khóa bản ghi và chuyển trạng thái sang `EXPIRED`.
- Đặt `canOrder = false` cho các nút tương ứng và tạo outbox event trong cùng transaction.
- Tiếp tục giữ kiểm tra hết hạn trong cả đường tạo đơn TypeScript lẫn stored procedure PostgreSQL.
- Gia hạn đã thanh toán cộng thời hạn đúng từ `max(now, effectiveExpiresAt)`, không kích hoạt hợp đồng chưa bàn giao.
- API điều chỉnh thời hạn của Admin validate giới hạn, yêu cầu lý do, ghi audit và làm rõ khác biệt giữa `paidThrough` và quyền truy cập được điều chỉnh.
- Chỉ dùng một đường kích hoạt: bàn giao; loại bỏ bypass `activateRental()`.

### Phase 5 — Đóng quy trình trả nút và hoàn cọc thật (Ưu tiên #3)
- Bảo đảm mỗi button chỉ có tối đa một yêu cầu trả đang xử lý; endpoint retry không tạo return/refund trùng.
- Khi Store xác nhận nhận thiết bị, cập nhật trạng thái kho và ghi movement/audit; tạo yêu cầu refund theo số cọc đã thực thu.
- Khi tạo/duyệt refund, chốt danh tính người nhận bằng snapshot bất biến: bank account ID, BIN, masked/hash và thông tin mã hóa cần cho payout.
- Khi phát payout, dùng idempotency/reference ổn định từ refund code để retry không chi hai lần.
- Viết một hàm reconciliation dùng chung cho worker và API Admin. Bắt buộc transaction detail khớp chính xác mã refund/provider reference, amount và recipient; không fallback amount.
- Chỉ chuyển ledger từ `reserved` sang `refunded` sau khi đủ bằng chứng payout thành công. Processing, response thiếu field, sai người nhận hoặc timeout đều giữ `PENDING_PAYOUT`.
- Bảo toàn số dư cọc và ngăn chặn tuyệt đối dòng tiền cọc đi vào Store Wallet.

### Phase 6 — Nối đầy đủ Outbox và Notification Center (Ưu tiên #5a)
- Tạo outbox event cùng transaction khi khách gửi yêu cầu trả nút.
- Tạo event khi refund được duyệt; thông báo đúng Admin/Store/customer theo vai trò.
- Job hết hạn phát `RENTAL_EXPIRED` và `STORE_SUBSCRIPTION_EXPIRED`.
- Charge đã thanh toán phát `PAYMENT_RECEIVED` cho đối tượng liên quan.
- Dùng idempotency key theo `event + recipient + channel`; không gửi push/in-app lặp khi retry.
- Xử lý thất bại notification độc lập với nghiệp vụ tài chính.
- DLQ có quy trình xem, retry có kiểm soát và audit thao tác replay.

### Phase 7 — Hoàn thiện API validation, phân quyền và audit (Ưu tiên #5b)
- Tạo DTO riêng cho assign fulfillment, refund, điều chỉnh thời hạn, return request và payment request.
- Validate ID, enum trạng thái, số tháng/ngày, kích thước danh sách nút, giới hạn pagination và lý do điều chỉnh.
- Gắn RBAC/BOLA theo Store nhận hàng, khách sở hữu rental và quyền Admin; không dựa vào kiểm tra ở frontend.
- Chuẩn hóa response DTO, tránh trả Prisma entity thẳng ra API.
- Ghi audit cho mọi mutation tài chính, hạn thuê, tình trạng button, phân công Store và chuyển trạng thái return/refund.
- Dùng forward-only migration mới cho sửa schema/backfill; không sửa migration đã chạy.

### Phase 8 — Nghiệm thu và bàn giao (Ưu tiên #5c)
- Kiểm tra schema/migration thực tế trên database test biệt lập và xác nhận trạng thái migration.
- Chạy typecheck, build, format và các suite liên quan; chỉ chạy suite DB sau khi guard/client đã buộc dùng URL test được xác minh.
- Kiểm thử end-to-end: tạo thuê → thanh toán PayOS → phân công Store/nút → bàn giao → hết hạn/gia hạn → yêu cầu trả → Store nhận → Admin duyệt → PayOS payout → thông báo.
- Kiểm thử retry, webhook trùng, hai request đồng thời, sai amount/reference/recipient, thiếu transaction detail và DB/provider timeout.
- Cập nhật `SESSION_HANDOFF.md` bằng kết quả vừa chạy thực tế.

---

### Thứ tự triển khai tuần tự
1. **Bước 1: Phase 1 — Nối charge với PayOS thật** (Hoàn thiện thanh toán thật từ `BillingCharge`, lưu payment link ID, webhook/callback verify HMAC, settle atomic, cấm mock ngoài test/dev).
2. **Bước 2: Phase 2 — Gán fulfillment Store và thiết bị vào rental** (API Admin phân công fulfillment store + button IDs, lock concurrency, ghi DeviceMovement, bàn giao kích hoạt, gỡ bỏ bypass).
3. **Bước 3: Phase 5 — Khóa chặt payout/refund với recipient snapshot và bằng chứng provider** (Hàm reconcile dùng chung, snapshot tài khoản nhận bất biến, đối chiếu 1-1, cấm fallback).
4. **Bước 4: Phase 3 & 4 — Phí Store 60k & Job hết hạn nhất quán** (Nối payment thật cho Store 60k, cron job hết hạn rental và store subscription, khóa nút không cho đặt hàng).
5. **Bước 5: Phase 6, 7 & 8 — Outbox notification đầy đủ, API validation/audit & Nghiệm thu toàn diện**.
