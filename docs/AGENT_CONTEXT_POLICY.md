# Agent Context & Handoff Policy

## Mục đích

Tài liệu này quy định cách các agent duy trì bối cảnh dự án giữa các task và các cuộc hội thoại khác nhau.

## Tài liệu nguồn bắt buộc

Trước khi bắt đầu task, agent phải đọc theo thứ tự:

1. [`AGENTS.md`](file:///f:/Learning/SEM9-FPTu/backend/AGENTS.md) — quy tắc bắt buộc của repository.
2. [`SESSION_HANDOFF.md`](file:///f:/Learning/SEM9-FPTu/backend/SESSION_HANDOFF.md) — trạng thái, kiến trúc, test và công việc gần nhất.
3. Các tài liệu BRD/Rules/skill liên quan trực tiếp đến task.

## Cập nhật sau khi hoàn thành task

Nếu task có thay đổi code, migration, cấu hình hoặc test, agent phải cập nhật `SESSION_HANDOFF.md` trước khi bàn giao.

Phần cập nhật tối thiểu phải có:

- Ngày cập nhật.
- Mục tiêu và kết quả thực hiện.
- Các file/migration quan trọng đã thay đổi.
- Lệnh kiểm tra đã chạy và kết quả.
- Vấn đề còn tồn tại hoặc giới hạn chưa kiểm chứng.
- Bước tiếp theo được đề xuất.

Nếu task chỉ là giải thích hoặc review không thay đổi file, agent phải nói rõ không có thay đổi nào được ghi vào handoff.

## Quy tắc bảo mật

Không ghi vào handoff hoặc tài liệu context:

- Nội dung `.env`.
- Firebase service-account private key.
- JWT secret, OTP pepper, database password.
- Cloudinary/PayOS credentials.
- Access token, refresh token hoặc dữ liệu cá nhân thật.

Chỉ ghi tên biến môi trường hoặc trạng thái đã cấu hình, ví dụ `FIREBASE_PROJECT_ID đã cấu hình`.

## Quy tắc kiểm chứng

Agent không được ghi trạng thái `PASS` nếu chưa trực tiếp chạy lệnh tương ứng trong task hiện tại hoặc chưa có bằng chứng rõ ràng từ log/CI.

Khi test phụ thuộc server đang chạy, phải ghi rõ:

- Server command.
- Port/base URL.
- Suite nào đã chạy.
- Suite nào chưa chạy do thiếu điều kiện môi trường.

## Mẫu cập nhật handoff

```md
### [YYYY-MM-DD] <Tên task>
- Status: COMPLETED | PARTIAL | BLOCKED
- Changes: <tóm tắt thay đổi>
- Files: <các file quan trọng>
- Verification: `<command>` — PASS/FAIL
- Remaining: <vấn đề còn lại hoặc None>
- Next: <bước tiếp theo>
```

## Bàn giao trong cuộc hội thoại mới

Agent tiếp theo phải bắt đầu bằng việc đọc `AGENTS.md` và `SESSION_HANDOFF.md`, sau đó kiểm tra `git status`, thay vì giả định trạng thái từ lịch sử chat.
