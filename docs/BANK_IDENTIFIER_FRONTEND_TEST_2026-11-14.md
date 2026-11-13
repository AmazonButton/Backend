# Test xác minh ngân hàng sau chuẩn hóa CITAD/BIN

## Bản backend cần dùng

Bản sửa hiện nằm trong working tree. Frontend `src/services/api.ts` có thể chọn backend qua query `?api=...`; frontend local/Vercel mặc định dùng proxy. Proxy production chưa tự nhận code local. Cần deploy cùng bản sửa lên các node tham gia xử lý API, webhook và refund worker trước khi kiểm thử live. Không coi health check xanh là bằng chứng node đã có bản sửa.

Sau deploy, có thể chọn trực tiếp backend đã cập nhật bằng URL frontend dạng:

```text
https://<frontend-host>/<bank-account-page>?api=https%3A%2F%2Fbackend-fae8.onrender.com
```

Giữ route trang ngân hàng thực tế của frontend. DevTools → Network phải hiển thị request đến backend đã chọn. Không đưa token hoặc số tài khoản vào URL. Việc chọn node API không thay đổi webhook đã cấu hình trên PayOS, nên node nhận webhook cũng cần bản sửa.

## Thao tác và kết quả mong đợi

1. Đăng nhập, thêm/chọn tài khoản ngân hàng cần xác minh rồi tạo **phiên mới**. Các phiên cũ đã FAILED_MISMATCH không tự chuyển trạng thái.
2. Kiểm tra ngân hàng và số tài khoản nhận trên checkout đúng tài khoản nền tảng đã cấu hình. Chuẩn hóa ngân hàng người gửi không thay đổi ngân hàng nhận của nền tảng.
3. Nếu thực hiện chuyển khoản, dùng đúng tài khoản đã đăng ký và số tiền của phiên. Không dùng ảnh chuyển tiền hoặc tên chủ tài khoản làm bằng chứng thay cho dữ liệu ngân hàng đã xác thực.
4. Bấm Kiểm tra kết quả. Khi backend có reference thật, tài khoản nguồn đầy đủ và thời hạn hợp lệ: CITAD/BIN cùng ngân hàng phải khớp; tài khoản có thể VERIFIED. Nếu thiếu/masked tài khoản nguồn hoặc mã ngân hàng chưa nhận diện: giữ chờ bằng chứng/đối soát và không tự chi.
5. Khác ngân hàng hoặc số tài khoản: phải từ chối xác minh. Không đổi account về VERIFIED chỉ vì nhận đủ tiền.
6. Theo dõi refundSummary/refundStatus riêng. PENDING_REFUND không có nghĩa đã hoàn thành payout. Callback lặp lại không tạo thêm nghĩa vụ hoặc lệnh hoàn tiền.

Nếu lỗi còn xuất hiện, lấy Request URL, HTTP status và Response body từ Network, kèm giờ kiểm thử. Che tài khoản/thông tin cá nhân; không gửi Authorization/cookie/API keys. Đối soát các phiên cũ và payout attempt riêng, không tạo lại obligation hoặc sửa trực tiếp VERIFIED.

## Phạm vi danh mục và nguồn

- Snapshot CITAD: UOB Full CITAD Code List (May 2026), tải ngày 2026-11-14: https://www.uob.com.vn/assets/web-resources/business/pdf/vi/uobv-citad-code-of-all-branches.pdf
- Snapshot BIN, cùng ngày: https://api.vietqr.io/v2/banks
- 2.975 mã CITAD được liệt kê tường minh, liên kết với 63 định danh ngân hàng có BIN đối chiếu. Không suy diễn các mã chi nhánh chưa có trong snapshot. Không tự hợp nhất các nhãn ngân hàng số/ví vào ngân hàng mẹ.
- Công ty tài chính/cho thuê tài chính không được tự coi là chi nhánh ngân hàng. Mã ngoài danh mục cần kiểm chứng và cập nhật snapshot; không gọi dịch vụ bên ngoài trong webhook để đoán mã.
- Snapshot không bảo đảm ngân hàng luôn trả số tài khoản nguồn đầy đủ; đó vẫn là điều kiện riêng để xác minh sở hữu.
