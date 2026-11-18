# Kế hoạch chuyển từ nhân viên cửa hàng sang nhân viên hệ thống

Ngày: 2026-11-17. Trạng thái: đề xuất triển khai; chưa thay đổi runtime/schema/dữ liệu.

## 1. Phạm vi người dùng đã xác nhận

- Bỏ các vai trò nhân viên cửa hàng và shipper riêng của từng cửa hàng.
- Thêm một vai trò `SYSTEM_STAFF`: chỉ quản lý nút bấm và bảo hành nút bấm.
- Chủ cửa hàng tự cập nhật tiến trình giao hàng và ảnh bằng chứng giao hàng (POD).
- Giữ khách hàng, chủ cửa hàng và các vai trò quản trị hiện hành. Việc gộp `ADMIN` / `SYSTEM_ADMIN` / `SUPER_ADMIN` là thay đổi riêng, không nằm trong kế hoạch này.

Các role cần ngừng cấp trong mô hình mới: `STORE_MANAGER`, `STORE_STAFF`, `STAFF_ORDER`, `STAFF_INVENTORY`, `STAFF_BUTTON`, `STAFF_DELIVERY`. Rà thêm các alias `STAFF`, `DRIVER`, `TECHNICIAN` tại từng điểm sử dụng; không tự chuyển tất cả các alias thành `SYSTEM_STAFF`.

## 2. Những phụ thuộc đã kiểm tra trong source

Source tham chiếu: commit `39c781c`. Worktree có thay đổi sẵn ở `BRD/ERD_Level_3_Editable.drawio` và `SESSION_HANDOFF.md`; kế hoạch này không chỉnh sửa sơ đồ.

- `prisma/schema.prisma`: `Role` hiện chỉ liên kết gán quyền qua `StoreStaff`; `User` chưa có quan hệ gán role hệ thống độc lập.
- `src/auth/auth.service.ts:56`: `resolveUserRole` đọc cả quyền quản trị qua `user.storeStaffs`.
- `src/auth/jwt.strategy.ts:82`: xác định quyền theo cùng mô hình membership cửa hàng.
- `src/admin/admin.repository.ts`: `updateStaffRole` chỉ cập nhật các hàng `storeStaff` có sẵn; không tạo membership hệ thống cho một người dùng mới.
- `src/websocket/events.gateway.ts`: có nhánh room cho admin/store/customer; role mới cần room vận hành thiết bị riêng.
- `src/orders/`, `src/media/`: giao hàng, phân công người giao và tải/xem POD có logic theo role shipper, cửa hàng và người được phân công.
- `src/rentals/`, `src/store-cash/`: một số kiểm tra quyền nằm trong SQL, yêu cầu membership `STORE_MANAGER` hoặc `STAFF_BUTTON`. Chỉ sửa `@Roles` sẽ chưa đủ.
- `src/devices/`, `src/warranty/`: vừa kiểm tra role ở controller vừa kiểm tra tenant trong service/repository.
- `Frontend/src/types/index.ts`, `App.tsx`, `layouts/Sidebar.tsx`, các luồng login: khai báo role, điều hướng và menu cần thay đồng bộ.
- Tìm kiếm các role nhân viên cũ trong `src` cho thấy 43 file backend và 16 file frontend có liên quan. Đây là kết quả tìm theo chuỗi role, không phải tổng số file cuối cùng phải sửa.

## 3. Ma trận quyền đích được đề xuất

| Chức năng | Chủ cửa hàng | SYSTEM_STAFF | Quản trị |
|---|---|---|---|
| Sản phẩm, giá, giảm giá, kho hàng bán của store | Store mình | Không | Theo quyền quản trị hiện hành |
| Đơn hàng, giao hàng, POD | Store mình | Không | Theo quyền quản trị hiện hành |
| Ví, ngân hàng, yêu cầu rút tiền | Store mình | Không | Theo quyền tài chính hiện hành |
| Gán role, khóa tài khoản, duyệt store | Không | Không | Người có quyền quản trị tương ứng |
| Kho nút bấm, thông tin kỹ thuật, phân bổ thiết bị | Theo quyền sở hữu/custody | Có trong nghiệp vụ thiết bị | Có |
| Báo lỗi và theo dõi phiếu bảo hành | Thiết bị thuộc phạm vi store | Có | Có |
| Kiểm tra, sửa, đổi nút, khóa nút lỗi | Theo quy trình được phép | Có, theo chính sách bảo hành | Có |
| Duyệt tiền khấu trừ, hoàn cọc, phát lệnh payout | Không qua quyền bảo hành | Không | Theo quyền tài chính hiện hành |

Đây là thiết kế quyền chi tiết được đề xuất từ phạm vi đã xác nhận. Staff có thể đọc thông tin nhận/trả thiết bị cần thiết cho công việc; không được xem toàn bộ hồ sơ khách hàng, danh sách đơn bán hàng hay dữ liệu ngân hàng.

Việc đổi/khóa nút phải kiểm tra trạng thái thuê, sở hữu, custody và phiếu bảo hành. Đóng phiếu kỹ thuật không có nghĩa là đã hoàn tiền. Quyền khôi phục hoạt động không được vượt qua điều kiện thuê còn hiệu lực hoặc lệnh khóa quản trị.

## 4. Các giai đoạn triển khai

### Giai đoạn 1 — Chốt contract quyền và mô hình lưu trữ

- Tạo mã role chuẩn `SYSTEM_STAFF` và định nghĩa tập quyền tập trung, phân biệt vận hành thiết bị với quản trị tài chính.
- Đề xuất thêm bảng `platform_memberships`: `user_id`, `role_id`, `status`, người cấp quyền, thời điểm cấp/thu hồi. Bảng không bắt buộc `store_id`.
- Gán quyền hệ thống bằng membership độc lập, không dựng một cửa hàng giả để chứa nhân viên hệ thống.
- Có thể dùng bảng này cho các admin đang dựa vào `store_staff`; cần chuyển tương đương quyền hiện có trước khi bỏ cách đọc cũ.
- Chốt quy tắc nếu một tài khoản đồng thời sở hữu store và được gán quyền hệ thống; không để thứ tự `if/else` tự quyết định quyền ngoài ý muốn. Phiên vận hành hệ thống không kế thừa quyền tài chính của phiên chủ store.
- Migration đầu tiên chỉ bổ sung bảng/index/role, chưa xóa bảng hoặc role lịch sử.

### Giai đoạn 2 — Backend authentication và thu hồi quyền

- Đưa việc xác định authority về một policy/resolver dùng chung cho login mật khẩu, Google, điện thoại, refresh, `/auth/me`, JWT và WebSocket.
- Cập nhật API quản trị để tạo/gán/thu hồi `platform_memberships`, whitelist role, ghi actor và audit log.
- `SYSTEM_STAFF` không cần `storeId`; truy vấn thiết bị/bảo hành phải có kiểm tra phạm vi rõ ràng, không dùng điều kiện thiếu `storeId` để bỏ qua ownership.
- Chỉ quản trị được tạo nhân viên hệ thống. Public registration và chủ store không được tự cấp role này.
- Khi role bị thu hồi: vô hiệu hóa phiên theo cơ chế dùng chung giữa các node, xử lý refresh token và các socket đang mở; không chỉ ẩn menu.
- Bổ sung DTO trả role/capability đúng để frontend không phải tự suy diễn.

### Giai đoạn 3 — Nút bấm và bảo hành

- Mở các endpoint thiết bị/bảo hành cần thiết cho `SYSTEM_STAFF`; kiểm tra cả controller, service, repository và SQL authority.
- Các endpoint cấp lô nút, phân bổ kho, reset, sửa, khóa/mở và cấu hình phải có quyền riêng theo thao tác. Không thêm role mới vào tất cả endpoint `/admin`.
- Dùng dữ liệu hợp đồng/cọc và quy tắc phía server để tính khấu trừ, không tin số tiền hoặc phân loại lỗi do client tự gửi.
- Đổi nút trong transaction với khóa ticket và hai thiết bị theo thứ tự nhất quán; bảo vệ khỏi hai phiếu dùng chung một nút thay thế.
- Chuyển đúng liên kết rental/customer/address/custody và cấu hình cần thiết; nút cũ mất quyền đặt hàng; nút mới tuân theo hạn thuê.
- Dashboard staff chỉ có nút bấm, kho nút, bảo hành và thông báo kỹ thuật. WebSocket/FCM chỉ phát dữ liệu cần thiết cho phạm vi này.
- Các nghiệp vụ thu tiền mặt, duyệt hợp đồng, gia hạn và payout không tự mở cho staff chỉ vì nằm gần màn hình quản lý nút.

### Giai đoạn 4 — Giao hàng do chủ store thực hiện

- Giữ luồng trạng thái đơn và POD; thay chủ thể thao tác sang chủ store sở hữu đơn.
- Kiểm tra ownership ở transaction khi nhận giao, hoàn tất/thất bại, tải ảnh và xem ảnh. Chủ store A không thao tác được đơn của store B.
- Ngừng phụ thuộc vào tài khoản shipper, trạng thái online và ca shipper cho đơn mới.
- Lập danh sách đơn đang giao có `assigned_driver_id`: hoàn thành hoặc bàn giao về chủ store qua thao tác có audit, không sửa hàng loạt thành đã giao.
- Đối soát ca và tiền COD đang mở trước khi ngừng workflow ca giao hàng. Lưu dữ liệu lịch sử người giao, ca làm và ảnh bằng chứng.
- Đổi UI giao hàng thành màn hình trong khu vực chủ store; bỏ điều hướng đăng nhập sang vai trò shipper.

### Giai đoạn 5 — Frontend và chuyển dữ liệu

- Thêm role vào types, login redirects, AuthContext, routes và navigation; tạo khu vực `/staff/devices` và `/staff/warranties` (đường dẫn đề xuất).
- Menu chủ store giữ sản phẩm, đơn hàng, giao hàng/POD, ví và nghiệp vụ thiết bị của store; bỏ tuyển/mời/quản lý nhân viên và màn hình ca shipper.
- Menu staff hệ thống không chứa doanh thu, sản phẩm của store, ngân hàng hoặc payout.
- Kiểm kê tài khoản cũ bằng truy vấn chỉ đọc. Giữ tài khoản người dùng, lịch sử thao tác và quan hệ FK.
- Thu hồi các membership nhân viên cửa hàng theo danh sách đã xác định. Chỉ cấp `SYSTEM_STAFF` cho người được quản trị chọn rõ ràng; không tự nâng toàn bộ staff/shipper cũ lên quyền hệ thống.
- Chuyển quyền admin đang lưu trong `store_staff` sang mô hình mới và xác minh đăng nhập admin trước khi cắt cơ chế cũ.
- Ngừng API tuyển/mời/cấp role cũ bằng lỗi nghiệp vụ rõ ràng. Dọn imports/module/route sau khi caller đã chuyển hết; giữ bảng lịch sử ở giai đoạn đầu.

### Giai đoạn 6 — Kiểm thử, tài liệu và phát hành

- Regression quyền: mỗi thao tác được phép, bị cấm, khác store, bị thu hồi và token cũ phải có ca kiểm thử.
- Staff hệ thống quản lý thiết bị/bảo hành được nhưng các API đơn hàng, catalog quản trị, ví, ngân hàng, payout, gán role trả lỗi quyền.
- Chủ store tự giao đơn, tải POD, báo thất bại; khác store bị chặn; dữ liệu đơn đang giao chuyển giao đúng.
- Bảo hành: đổi trùng ticket/nút bị chặn; giữ đúng rental và hạn thuê; thao tác kỹ thuật không tự phát lệnh hoàn tiền.
- Auth và WS: các phương thức login trả cùng role; mất membership phải mất quyền HTTP và realtime trên mọi node.
- Test migration trên database tách biệt: tài khoản admin vẫn vào được; lịch sử/FK còn nguyên; không tự cấp role mới cho tài khoản cũ.
- Typecheck/build backend và frontend, chạy các suite liên quan rồi CI hồi quy. Tách bằng chứng mock, DB cô lập và provider thật.
- Cập nhật BRD, use case, ERD và handoff theo mô hình mới bằng task tài liệu riêng; không chỉnh sơ đồ đang có thay đổi chưa commit trong đợt lập kế hoạch này.
- Phát hành theo thứ tự: schema bổ sung -> backend tương thích -> frontend -> chuyển membership/cắt role cũ -> dọn code. Trong lúc rollout nhiều node, phải ngăn node cũ tiếp tục cấp hoặc chấp nhận role đã ngừng.
- Chuẩn bị phương án quay về phiên bản tương thích; không xóa dữ liệu lịch sử ở cùng đợt rollout đầu.

## 5. Điều kiện hoàn tất

1. Không thể cấp mới hoặc dùng authority nhân viên/shipper cửa hàng trong runtime mới.
2. `SYSTEM_STAFF` hoạt động độc lập cửa hàng, giới hạn ở thiết bị và bảo hành.
3. Chủ store hoàn tất quy trình giao hàng/POD cho store mình.
4. Các tài khoản admin, giao dịch tiền, lịch sử giao hàng/bảo hành và FK vẫn hợp lệ.
5. Có bằng chứng kiểm thử cho quyền âm, đồng thời, chuyển dữ liệu và thu hồi phiên.

## 6. Trạng thái thực hiện trong phiên lập kế hoạch

- Đã đọc skill `auth-rbac-implementation` và rà các phụ thuộc nêu trên bằng đọc source/tìm kiếm.
- Chưa triển khai các giai đoạn; chưa chạy migration, truy vấn production, payout hoặc deploy.
- Chưa chạy test/build cho thay đổi mô hình này vì chưa thay đổi code.
