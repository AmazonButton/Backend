# Đối chiếu brainstorm 12 cụm flow với Backend và tài liệu

Ngày: 2026-11-19. Nhánh: `feat/system-staff-role-transition`; commit nền: `5a04d51`; có thay đổi chưa commit của người dùng trong BRD và SESSION_HANDOFF.

## 1. Kết luận và phạm vi

**Bản brainstorm đã bao quát các miền chính nhưng chưa đủ để kết luận “không bỏ sót luồng chính, ngoại lệ hay luồng nền”.** Vấn đề lớn hơn số lượng cụm là một số flow đang mô tả sai actor, sai thời điểm ghi tiền/tồn kho, hoặc coi đề xuất trong tài liệu là chức năng đã triển khai.

Đã lập danh mục toàn bộ controller trong `src/`: **43 file controller, 47 lớp controller, 285 method HTTP**; alias của một method không đếm thành endpoint riêng. Schema hiện có **69 Prisma model**. Đây là kiểm kê cấu trúc để tìm miền bị bỏ quên, không phải chỉ số chứng minh mọi nhánh đã được kiểm thử.

Đã đối chiếu các service/repository, worker, DTO và policy liên quan; BRD, các mô tả Use Case/Activity/State, kế hoạch trong `docs/superpowers`, tài liệu banking và handoff. Đã đọc XML của cả hai file Draw.io hiện tại, mỗi file có **32 trang**. Không sửa code, migration, cấu hình, test hay sơ đồ trong lần review này. Không gọi PayOS/Didit, không chạy payout, không thay dữ liệu DB và không chạy lại test runtime.

Quy ước:

- **Có trong code**: tìm thấy entry point và phần xử lý liên quan; không đồng nghĩa đã chạy E2E trong phiên này.
- **Cần chốt**: mô tả nghiệp vụ còn mâu thuẫn hoặc flow chưa nối kín qua các entry point hiện tại.
- **Đề xuất**: chưa tìm thấy chuỗi API/service hoàn chỉnh tương ứng trong phạm vi rà soát; không đưa vào danh sách chức năng đã hoàn thành.
- Những dòng “cần bổ sung” dưới đây là bổ sung vào brainstorm/checklist. Chúng không mặc nhiên là yêu cầu viết thêm toàn bộ chức năng đó.

## 2. Những mô tả phải sửa trước khi bổ sung flow

| # | Mô tả hiện tại | Kết quả đối chiếu và cách viết lại | Nguồn trong Backend |
|---|---|---|---|
| 1 | Goong lỗi thì dùng Haversine để kiểm tra vùng giao 5 km | `DeliveryEligibilityService` trả `DELIVERY_DISTANCE_UNAVAILABLE` khi thiếu key, lỗi provider hoặc dữ liệu không hợp lệ. Không có Haversine fallback trong service này. Haversine ở luồng hoàn tất giao hàng dùng cho geofencing POD, là bước khác. Ghi riêng nhánh dịch vụ khoảng cách không khả dụng và nhánh ngoài vùng. | [delivery-eligibility.service.ts](../../src/orders/delivery-eligibility.service.ts), `fetchGoongDistanceMeters`; [orders.repository.ts](../../src/orders/orders.repository.ts), `completeDeliveryAtomicTx` |
| 2 | Auto-confirm sau 5 phút | Worker quét mỗi **5 giây**, xét cửa sổ `cancel_window_seconds`, mặc định **60 giây**. Chỉ auto-confirm đơn gắn nút hoặc đã thanh toán; không áp dụng như nhau cho mọi đơn storefront chưa trả tiền. | [orders-lifecycle.worker.ts](../../src/orders/orders-lifecycle.worker.ts), `processPendingOrdersLifecycle` |
| 3 | Tạo đơn thì trừ kho | Cần tách **giữ chỗ** với **trừ tồn vật lý**. Luồng giao hàng trừ `quantity_on_hand` và giải phóng `reserved_quantity` tại `DELIVERED`; hủy/thất bại có nhánh giải phóng giữ chỗ. | [orders.repository.ts](../../src/orders/orders.repository.ts), tạo đơn, `cancelOrderAtomicTx`, `completeDeliveryAtomicTx`, `failDeliveryAtomicTx` |
| 4 | Đến COMPLETED mới cộng ví | `completeDeliveryAtomicTx` đã cộng ví tại **DELIVERED** cho đơn có giao dịch PayOS `PAID`; chặn cộng lại bằng tham chiếu `ORDER:<id>`. Không diễn giải COD như tiền PayOS được sàn thu hộ. | [orders.repository.ts](../../src/orders/orders.repository.ts), `completeDeliveryAtomicTx` |
| 5 | Các role tạo thành chuỗi kế thừa quyền tăng dần | Cần bảng actor–action. `getRoleCapabilities` cấp quyền tường minh; `SYSTEM_STAFF` không có quyền tài chính. `RolesGuard` có ngoại lệ cho `SUPER_ADMIN`, không có cơ chế suy ra mọi role còn lại đều kế thừa theo dấu `<`. | [authority.policy.ts](../../src/auth/authority.policy.ts), `getRoleCapabilities`; [roles.guard.ts](../../src/common/guards/roles.guard.ts) |
| 6 | Admin/Super Admin đều được duyệt rút, batch payout | Các mutation payout trong `AdminController` kế thừa `@Roles('SUPER_ADMIN')`. Một số API đọc cho phép các admin khác. Duyệt hoàn cọc thuê là nhóm quyền khác, có `ADMIN`/`SYSTEM_ADMIN`/`SUPER_ADMIN`. | [admin.controller.ts](../../src/admin/admin.controller.ts); [rentals.controller.ts](../../src/rentals/rentals.controller.ts) |
| 7 | Admin/System Staff gán, kích hoạt, bàn giao, điều chỉnh hợp đồng | Các thao tác tại `AdminRentalsController` đang dành cho nhóm admin; endpoint activate tại `RentalsController` khai báo `ADMIN`/`SYSTEM_ADMIN` và chịu ngoại lệ SUPER_ADMIN của guard. Không gộp SYSTEM_STAFF vào các quyền này. Staff kiểm tra thiết bị/trả nút và lập đề nghị tài chính theo quyền riêng. | [admin-rentals.controller.ts](../../src/rentals/admin-rentals.controller.ts); [rentals.controller.ts](../../src/rentals/rentals.controller.ts) |
| 8 | Khách luôn trả phí thuê và phí gia hạn | Phải tách `STORE_RENT_CUSTOMER_DEPOSIT` với `LEGACY_CUSTOMER_RENT`. Luồng mới không thu phí gia hạn thuê từ CUSTOMER; luồng legacy mới thu từ khách qua PayOS. Có guard `pricingReviewRequired`. | [rentals.service.ts](../../src/rentals/rentals.service.ts), `extendRentalContract`; [rentals.repository.ts](../../src/rentals/rentals.repository.ts) |
| 9 | Gia hạn có thể đóng PayOS hoặc tiền mặt giống thuê ban đầu | Cash voucher hiện ràng buộc `purpose = RENTAL_INITIAL`, rental `PENDING_PAYMENT` và charge `PENDING`. Chưa có cơ sở mô tả thu tiền mặt cho mọi khoản gia hạn như flow đã hỗ trợ. | [store-cash.repository.ts](../../src/store-cash/store-cash.repository.ts), phát voucher và thu tiền |
| 10 | Mua/gia hạn subscription đều qua QR; gói giới hạn số sản phẩm | `subscribe` gọi nhánh trừ ví; `renew-charge` có nhánh PayOS và nhánh trial 0đ kích hoạt trực tiếp. `validateStoreCanListProducts` hiện ghi rõ **không giới hạn số lượng sản phẩm**, kiểm tra gói còn hiệu lực. | [store-subscriptions.controller.ts](../../src/store-subscriptions/store-subscriptions.controller.ts); [store-subscriptions.service.ts](../../src/store-subscriptions/store-subscriptions.service.ts) |
| 11 | Warranty cho phép đổi miễn phí nhóm A/B | `approveSwap` và transaction tương ứng chỉ nhận **GROUP_A**. Không ghi B được đổi như A. Tách xử lý cấu hình/hỗ trợ, resolve, reject và khóa/thu hồi thay vì ép mọi phiếu đi vào swap. | [warranty.service.ts](../../src/warranty/warranty.service.ts), `approveSwap`; [warranty.repository.ts](../../src/warranty/warranty.repository.ts) |
| 12 | Pin ≤20% tự tạo phiếu; CUSTOMER trực tiếp tạo phiếu | IoT hiện phát cảnh báo/thông báo khi `0 < battery < 20`, không tạo `WarrantyTicket` trong hàm cảnh báo. API tạo phiếu cho owner, staff và admin; không có CUSTOMER trong danh sách role. Tách “cảnh báo” và “lập phiếu”. | [iot.service.ts](../../src/iot/iot.service.ts), `checkAndDispatchDeviceAlerts`; [warranty.controller.ts](../../src/warranty/warranty.controller.ts) |
| 13 | Đơn đã giao lỗi thì có thể giao lại | Graph cho `DELIVERY_FAILED → SHIPPING`, nhưng cập nhật chung chặn SHIPPING; `claimOrderAtomicTx` chỉ nhận `READY_FOR_DELIVERY` chưa có người nhận. Chưa thấy API riêng nối kín nhánh retry này. Cần chốt API nhận lại, giữ chỗ tồn kho lại, bằng chứng và lịch sử lần giao. | [update-order-status.dto.ts](../../src/orders/dto/update-order-status.dto.ts); [orders.service.ts](../../src/orders/orders.service.ts), `updateOrderStatus`, `claimOrder`; [orders.repository.ts](../../src/orders/orders.repository.ts), `claimOrderAtomicTx` |
| 14 | Có hoàn tiền đơn tự động qua PayOS giống hoàn cọc | `refundOrder` hiện ghi trạng thái qua repository và phát thông báo; không gọi adapter payout trong đường xử lý này. Cần phân biệt **xác nhận đã hoàn bên ngoài** với **thực hiện và đối soát chi tiền**. Không dùng nó làm bằng chứng đã có engine hoàn tiền đơn tự động. | [orders.service.ts](../../src/orders/orders.service.ts), `refundOrder`; [orders.repository.ts](../../src/orders/orders.repository.ts), `refundOrderAtomicTx` |
| 15 | eKYC là điều kiện bắt buộc đã được áp dụng trước mở store/giao dịch nhạy cảm | Trong luồng register owner, approve store đã rà, chưa thấy guard đối chiếu `kycStatus` thực thi tiền điều kiện này. Cần xác định thao tác nào thật sự bắt buộc KYC và thêm vào ma trận điều kiện; không kết luận từ mô tả ACT/UC. | [auth.service.ts](../../src/auth/auth.service.ts), `register`; [admin.service.ts](../../src/admin/admin.service.ts), `approveStore`; [admin.repository.ts](../../src/admin/admin.repository.ts), `approveStore` |

## 3. Các flow còn thiếu hoặc bị gộp trong từng cụm

### Cụm 1 — Auth, tài khoản và phiên

- **Có trong code, cần tách rõ**: refresh access token/refresh token; phiên refresh hết hạn hoặc bị revoke; quyền thực tế thay đổi giữa lúc login, refresh và `/auth/me`.
- **Bổ sung checklist**: OTP sai/hết hạn/đã sử dụng, gửi lại và giới hạn thử; email tồn tại nhưng chưa xác minh; user bị khóa; password reset token hết hạn/đã dùng; token trước lúc đổi mật khẩu không được sống lại khi mở khóa.
- **Bổ sung checklist**: Google/Firebase trùng danh tính liên kết, SĐT đã thuộc người khác, user thiếu customer profile; phân biệt xác minh SĐT với tạo tài khoản mới.
- **Có trong code, cần tách**: cập nhật hồ sơ cá nhân, avatar và đồng bộ `/auth/me`; đây không chỉ là luồng login.
- **Bổ sung đa node**: socket đang mở bị revoke, socket reconnect bằng token cũ, API trên node khác, refresh sau đổi role, role legacy bị hạ về CUSTOMER.

Nguồn: [AuthController](../../src/auth/auth.controller.ts), [AuthService](../../src/auth/auth.service.ts), [JwtStrategy](../../src/auth/jwt.strategy.ts), [authority.policy.ts](../../src/auth/authority.policy.ts), [EventsGateway](../../src/websocket/events.gateway.ts).

### Cụm 2 — Governance

- **Có trong code, cần tách**: cấp role, đổi role và thu hồi role là ba flow; mỗi flow có audit, thu hồi phiên và kết quả `newEffectiveRole` sau phân giải lại quyền.
- **Bổ sung checklist**: bootstrap SUPER_ADMIN không được hạ quyền; xung đột với owner; target bị khóa; cấp/thu hồi đồng thời; không tự nâng store staff cũ thành SYSTEM_STAFF.
- **Bổ sung vòng đời store**: PENDING → ACTIVE hoặc SUSPENDED khi bị từ chối; sau đó đình chỉ/mở lại có tác động gì tới đơn đang giao, hợp đồng và ví. Phần tác động liên miền cần được chốt, không suy ra cứ khóa store là hủy mọi khoản nợ.
- **Bổ sung cấu hình**: gói bị vô hiệu hóa khi đang có khách sử dụng; sửa giá áp dụng cho hợp đồng mới hay cả khoản thu đang mở; snapshot giá/commission của giao dịch cũ.
- **Đề xuất, chưa coi đã triển khai**: admin tạo user trực tiếp; khôi phục/mời nhận tài khoản và thiết lập mật khẩu an toàn. Không có endpoint create-user tương ứng trong controller đã kiểm kê.
- **Tách công cụ vận hành**: script Step 7 và outbox processing không đồng nghĩa có màn hình/API quản trị đầy đủ cho mọi loại DLQ.
- **Bổ sung ngừng role cũ**: chặn mời/gán/tái kích hoạt store staff và shipper; chấm dứt membership theo lịch sử thay vì xóa vật lý; thu hồi phiên và giữ liên kết đơn/ca/audit cũ.

Nguồn: [AdminController](../../src/admin/admin.controller.ts), [AdminService](../../src/admin/admin.service.ts), [AdminRepository](../../src/admin/admin.repository.ts), [script execute/rollback](../../scripts/step7-role-transition-execute.ts).

### Cụm 3 — eKYC

- **Bổ sung checklist**: tạo lại khi đã có phiên; provider không khả dụng; user thoát rồi quay lại; webhook đến trước/sau polling; webhook trùng hoặc không tìm thấy liên kết session.
- **Tách trạng thái**: trạng thái phiên của provider, trạng thái session nội bộ và `users.kycStatus` không nên viết thành một chuỗi chung.
- **Bổ sung checklist**: user xem/xóa session của người khác; provider trả kết quả lỗi/không đầy đủ; xóa phiên có thay đổi quyền đã được cấp hay không.
- **Cần chốt**: thao tác nào cần KYC; tái KYC khi hết hạn hoặc thay đổi thông tin; ai được xem dữ liệu nhạy cảm và chính sách lưu/xóa dữ liệu.

Nguồn: [IdentityVerificationsController](../../src/identity-verifications/identity-verifications.controller.ts), [IdentityVerificationsService](../../src/identity-verifications/identity-verifications.service.ts).

### Cụm 4 — Địa chỉ và điều kiện giao hàng

- **Bổ sung**: đổi/xóa địa chỉ mặc định; nút còn trỏ địa chỉ cũ; đơn đã tạo phải giữ snapshot, không bị sửa theo profile mới.
- **Bổ sung**: báo giá giao hàng trước đặt đơn, sau đó kiểm tra lại phía server lúc tạo đơn; không tin khoảng cách/phí do client tự gửi.
- **Bổ sung checklist**: thiếu tọa độ, tọa độ sai, không tìm thấy đường, Goong timeout/429/5xx, đúng ranh 5.000 m, ngoài ranh.
- **Bổ sung**: cache phụ thuộc tọa độ của cả store và địa chỉ; đổi vị trí cần tính lại; phân biệt IoT dùng địa chỉ mặc định với mobile chọn địa chỉ cụ thể.
- **Cần chốt**: đã báo giá nhưng store thay vị trí/ngừng hoạt động trước khi đặt đơn; hành vi khi dịch vụ khoảng cách không khả dụng. Không thay bằng Haversine nếu chưa có quyết định và implementation tương ứng.

Nguồn: [CustomerAddressesService](../../src/customer-addresses/customer-addresses.service.ts), [DeliveryEligibilityService](../../src/orders/delivery-eligibility.service.ts), [OrdersService](../../src/orders/orders.service.ts), `getDeliveryQuote`, `quickReorder`, `handleButtonEvent`.

### Cụm 5 — Phần cứng và provisioning

- **Bổ sung lifecycle ghép nối**: session/token hết hạn, đã dùng, device không khớp session, hai khách cùng confirm, thiết bị đã thuộc người khác. Legacy claim bị từ chối, không phải tuyến thay thế tương đương confirmation.
- **Có API nhưng brainstorm bỏ ngắn**: unclaim, tạo mã transfer, re-pair, factory reset; phân biệt reset WiFi với xóa liên kết nghiệp vụ.
- **Bổ sung**: đổi store phục vụ xóa mapping sản phẩm cũ và chọn sản phẩm thuộc store mới; không tự đổi kho giữ `custodyStoreId` hoặc nghĩa vụ thuê chỉ vì đổi routing `storeId`.
- **Bổ sung checklist**: cấp phát thiết bị đang gắn khách/hợp đồng, trùng mã nhập kho, mẫu bị xóa/sửa sau triển khai, SKU không thuộc store routing.
- **Bổ sung kết quả batch**: tất cả thất bại, một phần thất bại, request HTTP 201 nhưng `success: false`; giao diện phải đọc kết quả từng thiết bị.
- **Cần chốt**: điều kiện cho chuyển sở hữu khi còn cọc/hợp đồng/phiếu bảo hành; mất thiết bị và thu hồi/thanh lý. API tạo mã transfer chưa đủ chứng minh toàn bộ chính sách tài sản đã kín.

Nguồn: [ProvisioningService](../../src/devices/provisioning.service.ts), [ProvisioningRepository](../../src/devices/provisioning.repository.ts), [DevicesService](../../src/devices/devices.service.ts), [DevicesRepository](../../src/devices/devices.repository.ts), [DeviceTemplatesService](../../src/devices/device-templates.service.ts).

### Cụm 6 — Đặt hàng và nhận tiền

- **Bổ sung checklist IoT**: nonce/timestamp sai, request bị replay, request đã nhận nhưng thiết bị timeout rồi gửi lại, double press sau cửa sổ hủy, nút không `canOrder`, sai mapping hoặc hết tồn khả dụng.
- **Bổ sung các điểm vào**: storefront, physical button, simulate và quick reorder không phải một tuyến duy nhất; cần kiểm tra cùng điều kiện giá, tồn kho, vùng giao, subscription và quyền khách.
- **Bổ sung snapshot**: giá/khuyến mãi/số lượng/địa chỉ/phí/commission lấy phía server; sửa giá hoặc discount sau khi tạo đơn không được thay tổng tiền lịch sử.
- **Có trong code, cần viết rõ**: đơn storefront PENDING, UNPAID, không có button quá 15 phút được worker hủy và nhả giữ chỗ tồn kho.
- **Bổ sung thanh toán**: tạo lại link, hủy link, chuyển COD/PayOS, link cũ được trả tiền muộn, có active sibling, webhook đến sau khi đơn đã hủy/từ chối, polling và webhook cùng tới.
- **Tách ba trạng thái**: `orderStatus`, `paymentStatus`, `PaymentTransaction.status`; return URL thành công hoặc tiền provider nhận không tự chứng minh đơn đã được giao/hoàn tất.

Nguồn: [IotService](../../src/iot/iot.service.ts), [OrdersService](../../src/orders/orders.service.ts), [OrdersRepository](../../src/orders/orders.repository.ts), [PaymentsService](../../src/payments/payments.service.ts), [PaymentsRepository](../../src/payments/payments.repository.ts), [OrdersLifecycleWorker](../../src/orders/orders-lifecycle.worker.ts).

### Cụm 7 — Xử lý đơn, giao hàng và POD

- **Bổ sung**: timeline; khách hủy và owner từ chối ở từng trạng thái; thao tác stale hoặc lặp lại; không cho dùng endpoint update chung bỏ qua bằng chứng giao hàng.
- **Bổ sung POD đầy đủ**: xin upload → upload thành công → gắn đúng đơn → xác nhận giao → người được phép xem qua URL có hạn. Tách endpoint upload Cloudinary và presigned object storage, không giả định mọi ảnh đi cùng một tuyến.
- **Bổ sung checklist**: file sai/thiếu, object chưa tồn tại, khóa object không thuộc đơn, khác store, URL xem hết hạn, vị trí giao không hợp lệ; upload thành công chưa có nghĩa đơn đã DELIVERED.
- **Tách kết toán**: COD người giao cầm tiền, PayOS đã thu hộ, settlement tồn kho một lần, cộng ví một lần, COMPLETED không cộng lại.
- **Cần chốt và nối kín**: retry sau DELIVERY_FAILED; hiện graph và entry point mâu thuẫn như mục 2. Nếu giao lại phải quyết định giữ chỗ hàng lại và lưu bằng chứng từng lần.
- **Cần thống nhất thêm**: graph có `SHIPPING → CANCELLED`, nhưng `cancelOrderAtomicTx` chặn hủy khi SHIPPING. Quyết định có cho hủy khi đang giao hay không, rồi đồng bộ graph và API; không coi cạnh trên graph là bằng chứng đã có flow thực thi.
- **Bổ sung legacy**: takeover đơn SHIPPING; ca OPEN/CLOSED còn COD; settle đồng thời; HANDED_OVER bất biến. Cần chốt owner còn mở ca mới hay module ca chỉ để đóng lịch sử: code vẫn có `POST /api/v1/driver-shifts/start` cho STORE_OWNER.

Nguồn: [OrdersController](../../src/orders/orders.controller.ts), [OrdersService](../../src/orders/orders.service.ts), [OrdersRepository](../../src/orders/orders.repository.ts), [MediaController](../../src/media/media.controller.ts), [ObjectStorageService](../../src/media/object-storage.service.ts), [DriverShiftsController](../../src/driver-shifts/driver-shifts.controller.ts), [DriverShiftsService](../../src/driver-shifts/driver-shifts.service.ts).

### Cụm 8 — Hợp đồng thuê, tiền mặt và trả nút

- **Bổ sung điều kiện và bảng giá**: policy người trả phí; số lượng tối thiểu; gói ngừng bán; draft thay thế; điều kiện ưu đãi thời hạn lần đầu; snapshot phí/cọc và trường hợp `pricingReviewRequired` phải đối soát.
- **Bổ sung fulfillment**: trả tiền xong nhưng chưa có nút, chưa assign/bàn giao, nút không thuộc kho được phép; phân biệt PAID, PENDING_HANDOVER và ACTIVE; ngày quyền sử dụng bắt đầu theo bàn giao thực tế.
- **Bổ sung gia hạn**: trước hạn, sau EXPIRED, gói chưa tới ngày bắt đầu; quyền và người thanh toán theo `billingPolicy`; tránh thanh toán trùng làm cộng thời hạn hai lần.
- **Bổ sung hết hạn**: cron chuyển hợp đồng hết hạn, khóa `can_order`, thông báo; xác định điều kiện phục hồi sử dụng sau đóng phí. Không coi cron này là engine tự phát hành hóa đơn tháng.
- **Bổ sung trả nút**: đề nghị, tiếp nhận kỹ thuật, khấu trừ, phần cọc đang được đề nghị hoàn ở flow khác; duyệt tài chính một lần; hoàn 0đ khi khấu trừ hết; payout PROCESSING/chưa rõ/thất bại cuối/hoàn tất.
- **Tách cash thành flow riêng**: voucher ràng buộc đúng charge, ví owner bị cấn trừ, receipt và handover. Chi tiết ở cụm đề nghị bổ sung phía dưới.

Nguồn: [RentalsService](../../src/rentals/rentals.service.ts), [RentalsRepository](../../src/rentals/rentals.repository.ts), [rental-handover.transaction.ts](../../src/rentals/rental-handover.transaction.ts), [RentalExpiryCronService](../../src/rentals/rental-expiry-cron.service.ts), [StoreCashRepository](../../src/store-cash/store-cash.repository.ts), [OutboxConsumerService](../../src/rentals/outbox-consumer.service.ts).

### Cụm 9 — Bảo hành

- **Bổ sung các kết quả độc lập**: nhóm A đổi 1–1; hỗ trợ/cấu hình và resolve không đổi; reject kèm lý do; khóa thiết bị và đề nghị hoàn cọc. Không suy ra mọi nhóm đều có thể swap.
- **Bổ sung checklist**: hết hạn bảo hành, không còn nút thay thế, replacement đã có khách/hợp đồng/đã được dùng, đổi nút cho chính nó, owner thuộc store khác.
- **Bổ sung tranh chấp đồng thời**: hai ticket cùng nút, hai phiếu dùng chung replacement, swap cạnh tranh lock, nút đã đổi từ A sang B thì ticket cũ không đổi A sang C tiếp.
- **Bổ sung legacy snapshot**: rental/customer/store thay đổi sau lập phiếu; ticket cũ chưa có `rentalId`; chặn và chuyển đối soát, không suy ra hợp đồng hiện tại để bù snapshot thiếu.
- **Tách kỹ thuật và tài chính**: khóa kỹ thuật tạo đề nghị, không lập tức giữ/trừ cọc lần nữa; admin duyệt mới chốt ledger; theo dõi `warrantyTicketId` để tránh trùng với flow trả nút.

Nguồn: [WarrantyController](../../src/warranty/warranty.controller.ts), [WarrantyService](../../src/warranty/warranty.service.ts), [WarrantyRepository](../../src/warranty/warranty.repository.ts), [RentalsRepository](../../src/rentals/rentals.repository.ts), `approveDepositRefundTx`.

### Cụm 10 — Vận hành store và subscription

- **Cần tách onboarding**: đăng ký mới với role STORE_OWNER và store chờ duyệt khác với CUSTOMER hiện hữu xin nâng lên owner. Chưa tìm thấy API riêng hoàn chỉnh cho tuyến thứ hai; tên trang Frontend không chứng minh có backend tương ứng.
- **Bổ sung subscription**: trial 0đ chỉ dùng một lần, gói ngắn có phí vẫn thanh toán, trừ ví và PayOS là hai đường, gói mua trước nằm ở upcoming, hết hạn thì mất quyền đăng bán theo guard.
- **Bổ sung catalog**: sản phẩm/danh mục ngừng hoạt động hoặc bị xóa khi đang có button mapping, discount hoặc đơn; đơn cũ giữ snapshot; chọn SKU mới thuộc đúng store.
- **Bổ sung giá/discount**: thời điểm bắt đầu/kết thúc, thay đổi giá gốc giữa campaign, discount phần trăm hoặc số tiền, lịch sử giá; kiểm tra tiền cuối cùng phía server.
- **Bổ sung tồn kho**: nhập/điều chỉnh, tồn khả dụng sau reservation, không hạ tồn xuống dưới lượng đang giữ chỗ, cảnh báo low stock và giải phóng reservation khi đơn kết thúc không thành công.
- **Bổ sung quan hệ khách–store**: xem lịch sử, block/unblock khách; đổi store phục vụ thì dữ liệu cũ được giữ ở store nào, đơn cũ không chuyển tenant theo routing mới.
- **Sửa tên API trong brainstorm**: controller danh mục hiện là `/api/v1/categories`, catalog là `/api/v1/products/storefront/catalog`; không ghi `/stores/:storeId/categories` hoặc `storefront/catalog` như đường dẫn thật.

Nguồn: [AuthService](../../src/auth/auth.service.ts), [StoreSubscriptionsController](../../src/store-subscriptions/store-subscriptions.controller.ts), [StoreSubscriptionsRepository](../../src/store-subscriptions/store-subscriptions.repository.ts), [CategoriesController](../../src/categories/categories.controller.ts), [ProductsController](../../src/products/products.controller.ts), [StoreCustomersController](../../src/store-customers/store-customers.controller.ts).

### Cụm 11 — Ngân hàng, xác minh và payout

- **Bổ sung vòng đời bank account**: thêm, trùng tài khoản, default, đổi default, xóa; phiếu xác minh hết hạn/hủy/tạo lại; tài khoản dùng để tạo lệnh phải được snapshot thay vì đọc lại default sau này.
- **Tách rõ ba kết quả xác minh**: tiền đã đến, đủ bằng chứng sở hữu, tiền đã hoàn. Một kết quả không tự kéo theo hai kết quả còn lại.
- **Bổ sung inbound**: gửi thiếu/thừa, nhiều lần gửi, reference trùng, webhook trùng, polling cạnh tranh webhook, tiền đến sau session hết hạn/đã verified, thiếu thông tin sender, sender khác STK đăng ký.
- **Bổ sung refund**: một nghĩa vụ trên mỗi khoản tiền thực nhận phù hợp; đã hoàn một phần khác hoàn hết; manual reconciliation khi thiếu nguồn; cooling-off và feature flag. Customer worker mặc định lấy cooling-off 12 giờ và chỉ chi thật khi bật cờ cùng đủ key, nên không hứa “hoàn ngay 2.000đ”.
- **Bổ sung withdrawal**: tối thiểu 50.000đ, thiếu tiền khả dụng, bank chưa OWNERSHIP_VERIFIED, request lặp, nhiều lệnh đồng thời; tiền khả dụng và tiền đóng băng thay đổi thế nào.
- **Bổ sung payout không chắc chắn**: timeout sau dispatch, duplicate idempotency, sai/thiếu chữ ký hoặc detail, query danh sách rỗng khi recovery, provider còn PROCESSING, terminal failure có bằng chứng. Không nhả tiền hoặc tạo payout mới chỉ vì HTTP lỗi/lookup rỗng.
- **Cần chốt vận hành**: ai giải quyết PENDING_MANUAL_REFUND/PENDING_RECONCILIATION, lấy chứng cứ từ đâu, quyền phê duyệt và cách chứng minh đã hoàn. Có trạng thái và worker không đồng nghĩa đã có bàn xử lý thủ công hoàn chỉnh.

Nguồn: [CustomerBankPennyVerificationService](../../src/customers/customer-bank-penny-verification.service.ts), [CustomersRepository](../../src/customers/customers.repository.ts), [BankVerificationService](../../src/bank-verification/bank-verification.service.ts), [StoreWalletService](../../src/store-wallet/store-wallet.service.ts), [PayOSPayoutService](../../src/payments/payos-payout.service.ts), [payos-payout-verifier.ts](../../src/payments/payos-payout-verifier.ts), [deposit-payout-verifier.ts](../../src/rentals/deposit-payout-verifier.ts).

### Cụm 12 — Analytics, thông báo và vận hành

- **Bổ sung thông báo**: danh sách, unread count, đọc một/đọc tất cả; FCM đổi token, logout ngừng push, token không hợp lệ; notification lưu DB nhưng gửi push/socket thất bại; reconnect phải lấy lại dữ liệu.
- **Đề xuất/cần xác nhận contract**: chưa thấy API lưu notification preferences trong controller hiện tại hoặc trường tương ứng qua tìm kiếm source/schema. Không viết tính năng này như đã có chỉ vì giao diện có công tắc.
- **Bổ sung analytics**: kỳ báo cáo/timezone, bộ lọc, đơn COD với PayOS, GMV với revenue với số dư ví, snapshot commission, refund và đơn hủy, BOLA, cache invalidation sau mutation và fallback khi Redis mất kết nối.
- **Bổ sung lỗi liên node**: request đến node khác sau timeout, outbox lease hết hạn, worker restart, Redis Pub/Sub mất kết nối, fallback node cho third-party route. “Ưu tiên node 1” không đồng nghĩa không bao giờ failover sang node khác.
- **Tách health**: liveness khác readiness; node còn HTTP nhưng DB/queue không sẵn sàng; external provider mất kết nối khác lỗi credential/cấu hình.
- **Bổ sung sự cố và khôi phục**: job retry tới DLQ, phát lại có kiểm soát, đối soát sau crash, thay đổi role/deploy/migration đồng bộ, rollback quyền không phục hồi token cũ đã revoke.

Nguồn: [NotificationsController](../../src/notifications/notifications.controller.ts), [NotificationsService](../../src/notifications/notifications.service.ts), [EventsGateway](../../src/websocket/events.gateway.ts), [AppController](../../src/app.controller.ts), [worker.js](../../cloudflare-worker/worker.js), [OutboxConsumerService](../../src/rentals/outbox-consumer.service.ts), [Step 7 execute/rollback](../../scripts/step7-role-transition-execute.ts).

## 4. Nên bổ sung cụm riêng nào?

Không cần tạo thêm một cụm cho mỗi module. Đề nghị giữ 12 cụm hiện tại và **tách rõ thêm ba cụm E2E** sau; phần lớn cơ chế đã tồn tại nhưng đang bị chia giữa nhiều cụm:

### Cụm 13 — Thu hộ tiền mặt, cấn trừ ví và bàn giao tại quầy

Chuỗi chính: khách phát voucher hợp lệ cho khoản thuê ban đầu → owner xem preview → kiểm tra đủ số dư khả dụng → xác nhận thu tiền → trừ ví store → consume voucher → settle charge/cọc → receipt → bàn giao theo điều kiện hợp đồng.

Các nhánh bắt buộc: voucher sai store/charge/khách, hết hạn/đã dùng, phát voucher mới thay voucher cũ, ví thiếu tiền, idempotency cùng key khác nội dung, hai cashier gửi cùng lúc, PayOS thanh toán trước khi thu cash, cash xong PayOS mới đến, thanh toán xong chưa bàn giao.

Không ghi “store nhận cash thì ví được cộng”. Store nhận tiền vật lý; nền tảng **cấn trừ ví store** tương ứng. Phân biệt khoản này với COD của đơn bán hàng.

Nguồn: [StoreCashController](../../src/store-cash/store-cash.controller.ts), [StoreCashRepository](../../src/store-cash/store-cash.repository.ts); [kế hoạch cash/wallet offset](../superpowers/plans/2026-11-02-store-cash-collection-and-wallet-offset.md).

### Cụm 14 — Đối soát khoản tiền bất thường và xử lý nghĩa vụ hoàn

Chuỗi: tiền thật vào → lưu receipt có định danh → xác định thuộc order/billing/bank verification nào → quyết định được settle hay ghi nghĩa vụ hoàn → xác minh nguồn/đích → chi hoặc chờ đối soát → xác nhận trạng thái cuối.

Ma trận tối thiểu: duplicate webhook khác với khoản chuyển lần hai; trả tiền link cũ; giao dịch muộn sau cancel; cash và PayOS cùng trả; thiếu/thừa tiền; dữ liệu sender thiếu; provider báo PAID nhưng chưa đủ chứng cứ nghiệp vụ; payout timeout và query lại chưa rõ.

**Giữ các ledger/đích hoàn riêng cho từng miền**, không có nghĩa gom mọi khoản hoàn vào một endpoint hoặc tự hoàn về tài khoản default của user. Mục đích của cụm này là người vận hành thấy được toàn bộ nghĩa vụ còn mở.

Nguồn: [PaymentsRepository](../../src/payments/payments.repository.ts), [BillingChargesRepository](../../src/billing-charges/billing-charges.repository.ts), [CustomerBankPennyVerificationService](../../src/customers/customer-bank-penny-verification.service.ts), [BankVerificationRepository](../../src/bank-verification/bank-verification.repository.ts), [OutboxConsumerService](../../src/rentals/outbox-consumer.service.ts).

### Cụm 15 — Chuyển liên kết thiết bị, đổi nơi phục vụ và thu hồi

Tách ba tình huống: đổi store nhận đơn; chuyển quyền sử dụng cho user khác; chuyển kho/thu hồi tài sản. Mỗi tình huống có điều kiện, actor, mapping cần xóa/giữ và ảnh hưởng hợp đồng/cọc khác nhau.

Nhánh cần mô tả: sản phẩm mặc định không thuộc store mới; địa chỉ ngoài vùng; đơn cũ vẫn mở; warranty PENDING; rental còn hiệu lực hoặc nợ phí; unclaim/reset rồi ghép lại; token chuyển giao hết hạn hoặc bị dùng hai lần.

Đã có các primitive API/remap/transfer/unclaim, nhưng chính sách đối với hợp đồng còn nghĩa vụ phải được chốt. Không suy ra đổi `storeId` là đổi `custodyStoreId` hoặc tự điều chuyển phí thuê giữa hai store.

Nguồn: [ProvisioningService](../../src/devices/provisioning.service.ts), [DevicesService](../../src/devices/devices.service.ts), [DevicesRepository](../../src/devices/devices.repository.ts), `remapStore`, `allocateDevicesToStore`.

Nếu muốn giữ đúng **12 cụm**: đưa cụm 13 thành mục lớn trong 8; cụm 14 thành ma trận chung cho 6/8/11; cụm 15 thành mục lớn trong 5. Không phụ thuộc cách đánh số, nội dung này vẫn cần xuất hiện.

## 5. Tài liệu và sơ đồ đang không đồng bộ

| Tài liệu | Điểm cần chỉnh/đánh dấu | Đối chiếu |
|---|---|---|
| [Project Specification](../../BRD/Project_Specification_MultiStore_VN_V2.1.md), phần phạm vi và mô hình tài chính | Có mô tả trừ tồn vật lý lúc xác nhận, commission khi COMPLETED và khách trả phí thuê hàng tháng như mặc định chung. | Đối chiếu settlement tại DELIVERED và hai `billingPolicy` hiện tại. |
| [Activity Markdown](../../BRD/MO_TA_13_SO_DO_HOAT_DONG_ACTIVITY.md), ACT 3 | Viết cập nhật “trạng thái đơn thành PAID”. | Đổi thành paymentStatus/transaction PAID; orderStatus là chiều độc lập. |
| Activity Markdown, ACT 7 | Mô tả backend phát SMS OTP và đối soát hash trong DB. | Tách email OTP do backend quản lý với Firebase Phone Auth xác minh ID token. |
| Activity Markdown, ACT 9 | Mô tả khách mở tranh chấp, thương lượng và tự gọi PayOS hoàn tiền như đã có. | Trang ACT 9 trong Draw.io hiện đã ghi **PROPOSED ONLY**; Markdown chưa theo kịp. `refundOrder` chưa thực hiện payout tự động. |
| Activity Markdown, ACT 13 | Mô tả đổi `custody_store_id` khi khách chuyển nơi phục vụ và tự điều chuyển phí thuê. | `remapStore` đổi routing `storeId`, xóa mapping sản phẩm cũ, liên kết khách–store mới; không thực hiện chuỗi điều chuyển phí như mô tả. |
| Activity/Use Case, phần KYC, onboarding và thu cước hàng tháng | Mô tả KYC là gate chắc chắn, tạo tài khoản/gửi mật khẩu sau duyệt và engine thu cước hàng tháng. | Backend đăng ký owner có user/store trước duyệt; `approveStore` đổi trạng thái user/store. Cần kiểm chứng/triển khai từng gate và engine riêng; không lấy tên cron expiry làm chứng cứ monthly billing. |
| [State Markdown](../../BRD/MO_TA_9_SO_DO_TRANG_THAI_STATE.md), STATE 1/4/8/9 | Có tên rút gọn hoặc không khớp enum/state thực tế: FAILED, PENDING_DEPOSIT, RENEWED, SUCCESS... | Lập lại transition table từ DTO/service/repository; phân biệt state của contract, charge, payment, payout và entitlement. |
| State Markdown, STATE 6 | Nói module ca chỉ giữ để tất toán legacy. | `DriverShiftsController.startShift` vẫn mở cho STORE_OWNER. Cần xác định chủ store có tiếp tục dùng ca mới hay không. |
| State/Use Case, bank verification | Gộp nhận tiền, verified và refunded; có mô tả hoàn ngay 2.000đ. | Sender evidence, trạng thái refund độc lập, cooling-off, manual reconciliation và feature flag đều cần được mô tả. |
| [Use Case Markdown](../../BRD/MO_TA_SO_DO_USECASE.md), theo dõi lộ trình | Có mô tả xem vị trí tài xế di chuyển trên bản đồ. | Chưa tìm thấy chuỗi API GPS streaming/tracking hoàn chỉnh trong controller đã kiểm kê; phân biệt geofencing lúc giao với live tracking. |
| [Kế hoạch cash 11-02](../superpowers/plans/2026-11-02-store-cash-collection-and-wallet-offset.md) và các kế hoạch cũ | Còn actor STORE_MANAGER/STAFF_BUTTON hoặc checklist chưa phản ánh bản triển khai mới. | Giữ lịch sử nhưng gắn nhãn superseded tại phần actor/contract; dùng authority mới để viết flow hiện hành. |
| [Kế hoạch business fixes 11-16](../superpowers/plans/2026-11-16-business-logic-13-fixes.md) và mô tả bảo hành cũ | Mô tả cũ có thể gộp khóa kỹ thuật với trừ/giữ cọc. | Phiếu PENDING_APPROVAL và bước admin chốt ledger hiện tại là hai bước; dùng migration/source mới làm đối chiếu. |
| [Draw.io](../../BRD/ERD_Level_3_Editable.drawio), [XML mirror](../../BRD/erd_level_3_drawio_editable.xml), [mô tả 64 bảng](../../BRD/MO_TA_64_BANG_DATABASE.md) | Các nhãn 64/66 chưa thống nhất với 69 model hiện tại. | Cần mapping model → physical table → entity trong ERD. Chênh số nhãn chưa đủ chứng minh thiếu đúng 3 bảng trong sơ đồ. |
| [SESSION_HANDOFF](../../SESSION_HANDOFF.md) | Phần đầu vẫn ghi Frontend chưa làm/Redis chờ, trong khi phần sau đã có kết quả FE và lịch sử trao đổi có CI. | Gộp thành trạng thái hiện hành dựa trên bằng chứng; không dùng phần đầu để kết luận trạng thái production/CI. Lần review này không kiểm tra lại CI hay deployment. |

Lưu ý: hai file sơ đồ hiện có chỉnh sửa chưa commit trước phiên review. Không được lấy bản Markdown cũ để suy ra tất cả trang sơ đồ cũng còn lỗi giống hệt; ACT 9 là ví dụ đã được sửa nhãn trong sơ đồ nhưng Markdown chưa sửa.

## 6. Những yêu cầu phải chốt trước khi tuyên bố flow hoàn chỉnh

1. **Giao lại sau DELIVERY_FAILED**: dùng API nào, ai nhận lại, reserve hàng lại lúc nào, COD và POD lưu từng lần ra sao?
2. **Hoàn tiền đơn đã hủy**: ai thực hiện chuyển tiền, xác minh bằng chứng gì trước khi ghi REFUNDED, có cần adapter tự động và workflow duyệt riêng?
3. **Thuê nút**: policy nào là mặc định, bên nào trả khoản nào, gia hạn cash có thực sự cần hỗ trợ, giá thay đổi áp dụng cho ai?
4. **KYC**: bắt buộc ở đăng ký owner, duyệt store, thuê nút, rút tiền hay chỉ một số bước? Gate server ở đâu?
5. **Chuyển chủ/chuyển store**: hợp đồng, cọc, phí, warranty và đơn đang mở đi theo chủ nào/tenant nào?
6. **Manual reconciliation**: nhóm có thẩm quyền, chứng từ, phê duyệt, thời hạn và audit; không để chỉ có trạng thái chờ vô hạn mà không có lối giải quyết nghiệp vụ.
7. **Store bị đình chỉ/user bị khóa**: dừng tạo mới nhưng xử lý giao hàng, khoản phải trả và refund đang mở thế nào?
8. **Ca giao hàng**: owner dùng ca mới hay chỉ xử lý ca shipper cũ? Code và STATE 6 phải thống nhất.
9. **Proposal**: admin tạo user trực tiếp, customer hiện hữu nâng lên owner, tranh chấp/trả hàng, monthly billing tự động, notification preferences, live GPS — chức năng nào thật sự nằm trong scope tiếp theo?

## 7. Cách hoàn thiện brainstorm để dùng cho kiểm thử

Mỗi flow nên có: **mã flow; actor; trigger; tiền điều kiện; API/job; trạng thái trước/sau của từng đối tượng; bút toán/tồn kho; thông báo; nhánh lỗi; replay/concurrency; cách đối soát; trạng thái triển khai; nguồn code; tài liệu; test chứng minh**.

Ví dụ flow cần mô tả riêng: cash settle thành công → PayOS chuyển đến sau. Kết quả mong đợi là không cộng thêm hạn thuê/cọc, vẫn ghi khoản tiền thực nhận và nghĩa vụ đối soát; không viết đơn giản “thanh toán trùng bị bỏ qua”.

Thứ tự làm đề nghị: sửa 15 mô tả ở mục 2 → chốt các quyết định ở mục 6 → bổ sung flow theo 12 cụm → nối ba flow liên miền ở mục 4 → cập nhật Markdown và sơ đồ theo cùng một transition table → map test hiện có và phần thiếu. Không cần bắt đầu bằng viết thêm code cho mọi dòng trong checklist.

## 8. Bằng chứng của phiên review

- Đã đọc attachment brainstorm, rules, policy handoff và các skill `uml-diagram-expert`, `drawio` cho việc đối chiếu workflow/trạng thái và XML sơ đồ.
- Chạy kiểm kê TypeScript AST bằng Node/TypeScript trên các controller: 43 file, 47 lớp, 285 method HTTP. Đếm schema: 69 model.
- Parse XML Draw.io bằng Python ElementTree, hỗ trợ nội dung diagram nén: 32 trang trên mỗi file. Đã xác nhận nhãn PROPOSED ONLY tại ACT 9; không kiểm chứng layout/render trong phiên này.
- Dùng `rg` và đọc source để đối chiếu các method được dẫn trong báo cáo. Các kết luận “chưa tìm thấy” là kết quả kiểm kê/search tĩnh, không thay thế kiểm thử runtime hay quyết định scope của chủ dự án.
- Không chạy typecheck/build/test vì không có thay đổi source/config/test. Không suy diễn kết quả test từ báo cáo cũ thành kết quả của phiên này.
