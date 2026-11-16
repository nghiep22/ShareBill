# ShareBill — 05 — Website quản trị và hỗ trợ

[Danh mục và thứ tự thực hiện](README.md) · [Thiết kế CSDL](../DATABASE.md) · [Hợp đồng API](../BACKEND.md)

Quyền platform_admin tách khỏi owner chuyến. A01/A03/A05/A07/A08/A10/A12/A15 là các phần BE có thể làm trước giao diện; các lát còn lại ghép React vào API đã kiểm quyền.

**Số lát cắt: 17.** Trạng thái ban đầu đều **Chưa làm**. File hiện có là điểm sửa; đường dẫn ghi “mới” hoặc tên module chưa tồn tại là vị trí dự kiến. Mỗi lát cập nhật hợp đồng API/schema liên quan nếu có thay đổi.

## Danh sách nhanh

| Mã | Kết quả cần làm | Phụ thuộc |
| --- | --- | --- |
| [A01](#a01) | Bootstrap admin và guard backend | [D02](01_DATABASE_BE.md#d02), [D09](01_DATABASE_BE.md#d09) |
| [A02](#a02) | Khung website quản trị và phiên | [F01](04_FRONTEND_APP.md#f01), [F03](04_FRONTEND_APP.md#f03), [A01](#a01) |
| [A03](#a03) | API tìm/list/detail tài khoản | [A01](#a01), [D19](01_DATABASE_BE.md#d19) |
| [A04](#a04) | Trang người dùng có tìm kiếm và chi tiết | [A02](#a02), [A03](#a03) |
| [A05](#a05) | API metadata chuyến và suspend/resume | [A01](#a01), [D03](01_DATABASE_BE.md#d03), [D09](01_DATABASE_BE.md#d09) |
| [A06](#a06) | Trang chuyến và thao tác tạm khóa | [A02](#a02), [A05](#a05) |
| [A07](#a07) | Lệnh khóa/mở tài khoản và outbox Auth | [A01](#a01), [D13](01_DATABASE_BE.md#d13), [D09](01_DATABASE_BE.md#d09) |
| [A08](#a08) | Worker đồng bộ khóa Firebase Auth | [A07](#a07) |
| [A09](#a09) | Giao diện khóa/mở user và theo dõi sync | [A04](#a04), [A08](#a08) |
| [A10](#a10) | API ticket của chính người gửi | [D02](01_DATABASE_BE.md#d02), [D09](01_DATABASE_BE.md#d09), [D19](01_DATABASE_BE.md#d19) |
| [A11](#a11) | Form gửi lỗi trong app | [F25](04_FRONTEND_APP.md#f25), [A10](#a10) |
| [A12](#a12) | API hàng đợi support và ghi chú nội bộ | [A01](#a01), [A10](#a10) |
| [A13](#a13) | Trang xử lý hỗ trợ | [A02](#a02), [A12](#a12) |
| [A14](#a14) | Tra lịch sử quản trị | [A02](#a02), [A07](#a07), [A12](#a12), [D19](01_DATABASE_BE.md#d19) |
| [A15](#a15) | API tổng quan và trạng thái hệ thống | [A01](#a01), [A08](#a08), [A12](#a12) |
| [A16](#a16) | Trang tổng quan quản trị | [A02](#a02), [A15](#a15) |
| [A17](#a17) | Trang hệ thống và kết quả jobs | [A02](#a02), [A15](#a15) |

## Chi tiết từng lát cắt

### A01

**Bootstrap admin và guard backend**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D02](01_DATABASE_BE.md#d02), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** User thường bị chặn admin API; admin active được nhận diện.

**Phạm vi file/module:** Admin bootstrap script, `be/src/services/admin-auth.ts` và admin routes (mới).

**Việc làm:** platformAdmins schema; script dry-run với project/uid; GET admin/me; guard user+admin status và recent auth cho mutation nhạy cảm.

**Kiểm thử:** User/owner403, disabled admin, revoke quyền, bootstrap sai project/UID.

**Hoàn tất khi:** Không có public API tự cấp admin; admin không tự có membership mọi chuyến.

### A02

**Khung website quản trị và phiên**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F01](04_FRONTEND_APP.md#f01), [F03](04_FRONTEND_APP.md#f03), [A01](#a01).

**Kết quả:** Mở được website quản trị với sáu mục điều hướng.

**Phạm vi file/module:** `fe/src/features/admin/` và layout admin (mới).

**Việc làm:** Đăng nhập quản trị theo ADMIN_WEB.md; gọi admin/me, route guard, recent-auth prompt và cache tách khỏi app; nhãn môi trường.

**Kiểm thử:** User thường vào URL admin, token hết hạn, role revoke, reauth cancel.

**Hoàn tất khi:** Sidebar đơn giản; React guard không thay kiểm quyền phía BE.

### A03

**API tìm/list/detail tài khoản**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A01](#a01), [D19](01_DATABASE_BE.md#d19).

**Kết quả:** Admin tìm đúng UID/email và list theo status.

**Phạm vi file/module:** Admin user query/DTO/routes (mới).

**Việc làm:** Exact lookup không scan; cursor; DTO metadata allowlist, không token/credential; index status+createdAt.

**Kiểm thử:** Email chuẩn hóa, UID sai, nhiều trang, non-admin.

**Hoàn tất khi:** Response chỉ metadata cần dùng; không kéo ledger/receipts của user.

### A04

**Trang người dùng có tìm kiếm và chi tiết**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A02](#a02), [A03](#a03).

**Kết quả:** Admin tìm và xem tài khoản bằng website.

**Phạm vi file/module:** Admin users list/detail React (mới).

**Việc làm:** Ô tìm đúng loại UID/email, filters/reset, pagination, empty/error; hiển thị trạng thái/Auth sync; chưa gắn action lock trước A09.

**Kiểm thử:** Tìm đúng/không có email, pagination, query lỗi, viewport nhỏ.

**Hoàn tất khi:** Tìm được user mà không cần mở Firebase Console hoặc nhập path collection.

### A05

**API metadata chuyến và suspend/resume**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A01](#a01), [D03](01_DATABASE_BE.md#d03), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** Admin xem metadata và tạm khóa/mở thao tác chuyến.

**Phạm vi file/module:** Admin trip query/moderation routes (mới).

**Việc làm:** Search tripID/status hoặc moderationStatus, cursor; moderationVersion, reason, recent auth, signal/admin audit/op; giữ nguyên ledgerVersion.

**Kiểm thử:** Suspend và expense write cạnh tranh, stale version, user không admin.

**Hoàn tất khi:** Suspend chặn ghi nghiệp vụ, không sửa ledger; API admin không trả sổ tiền/ảnh.

### A06

**Trang chuyến và thao tác tạm khóa**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A02](#a02), [A05](#a05).

**Kết quả:** Admin tìm chuyến và khóa/mở bằng câu chữ rõ ràng.

**Phạm vi file/module:** Admin trips list/detail/dialogs React (mới).

**Việc làm:** ID/status filter, metadata; dialog reason và tác động; request version/key; show normal/suspended riêng active/archived.

**Kiểm thử:** Sai lý do, reauth, version conflict, trip archived và suspended.

**Hoàn tất khi:** Trong ba màn hình hoàn tất hành động; không có nút sửa balance tùy ý.

### A07

**Lệnh khóa/mở tài khoản và outbox Auth**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A01](#a01), [D13](01_DATABASE_BE.md#d13), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** Lệnh quản trị ghi desired state và trả jobId ổn định.

**Phạm vi file/module:** Admin user moderation service/routes, Auth job schema (mới).

**Việc làm:** Disable app ngay; enable giữ disabled tới sync xong; transaction version/job/audit/op; không gọi Auth trong tx.

**Kiểm thử:** Disable→enable→disable nhanh, duplicate key, version stale, recent auth hết hạn.

**Hoàn tất khi:** 202 trả cùng jobId khi retry; trạng thái app không tự mở trước Auth sync.

### A08

**Worker đồng bộ khóa Firebase Auth**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A07](#a07).

**Kết quả:** Mỗi UID chỉ có một worker hợp lệ áp desired state mới nhất.

**Phạm vi file/module:** Auth job worker, `adminAuthLeases`, reconciler desired state (mới).

**Việc làm:** Lease theo UID, attempts/backoff, revoke sessions khi disable, version fence và superseded job; kết quả cập nhật sync status.

**Kiểm thử:** Worker cũ hoàn tất muộn, lease hết, Auth API lỗi, process chết giữa hai hệ thống.

**Hoàn tất khi:** Job cũ không mở user vừa bị khóa; lỗi có trạng thái và retry bounded.

### A09

**Giao diện khóa/mở user và theo dõi sync**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A04](#a04), [A08](#a08).

**Kết quả:** Admin biết lệnh đang đồng bộ hay đã hoàn tất.

**Phạm vi file/module:** Admin user moderation dialogs/job status UI (mới).

**Việc làm:** Reason/reauth, key/version; show pending/failed/synced và action phù hợp; poll bounded theo job API.

**Kiểm thử:** Job chậm/lỗi, đổi trạng thái từ tab khác, mất response.

**Hoàn tất khi:** Không báo mở tài khoản thành công khi app status vẫn disabled; có hướng xử lý job lỗi.

### A10

**API ticket của chính người gửi**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D02](01_DATABASE_BE.md#d02), [D09](01_DATABASE_BE.md#d09), [D19](01_DATABASE_BE.md#d19).

**Kết quả:** User tạo và đọc ticket riêng với quota.

**Phạm vi file/module:** User support routes, ticket/rate-limit schemas (mới).

**Việc làm:** 5 tickets/ngày/UID transaction; category/message; membership check khi kèm tripId; list/detail scope UID; internal notes không vào DTO.

**Kiểm thử:** Quota vượt, UID khác đọc ticket, tripId ngoài nhóm, duplicate request.

**Hoàn tất khi:** Một key chỉ tạo một ticket; user không đọc được internal note.

### A11

**Form gửi lỗi trong app**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F25](04_FRONTEND_APP.md#f25), [A10](#a10).

**Kết quả:** Người dùng gửi mô tả và xem trạng thái xử lý.

**Phạm vi file/module:** User support form/list/detail React (mới).

**Việc làm:** Context trip tự điền khi hợp lệ; category/message, max length, quota feedback; không hỏi password/token; không upload file P0.

**Kiểm thử:** Message quá ngắn, quota, mất mạng, view ticket người khác.

**Hoàn tất khi:** Gửi một lần có mã ticket; không mất nội dung khi lỗi; chỉ thấy ticket của mình.

### A12

**API hàng đợi support và ghi chú nội bộ**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A01](#a01), [A10](#a10).

**Kết quả:** Admin xử lý ticket bằng status và internal timeline.

**Phạm vi file/module:** Admin ticket list/update/note routes (mới).

**Việc làm:** Cursor status+updatedAt; If-Match/key đổi status; note append-only, admin audit; DTO chọn field.

**Kiểm thử:** Hai admin đổi cùng ticket, note retry, user thường gọi admin route.

**Hoàn tất khi:** Không ghi đè status mới; note nội bộ không lộ ra endpoint user.

### A13

**Trang xử lý hỗ trợ**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A02](#a02), [A12](#a12).

**Kết quả:** Admin nhận ticket, cập nhật status và thêm note.

**Phạm vi file/module:** Admin support list/detail React (mới).

**Việc làm:** Ba trạng thái dễ hiểu; list filter/cursor; detail context, note form, conflict/retry.

**Kiểm thử:** Empty queue, version conflict, dài message/note, permission revoked.

**Hoàn tất khi:** Một luồng tìm→xem→xử lý; không cần biết cấu trúc Firestore.

### A14

**Tra lịch sử quản trị**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A02](#a02), [A07](#a07), [A12](#a12), [D19](01_DATABASE_BE.md#d19).

**Kết quả:** Admin xem ai đã tác động user/trip/ticket.

**Phạm vi file/module:** Admin audit query/DTO và activity page (mới).

**Việc làm:** targetType+time window<=31 ngày, cursor; reason/action/requestId; append-only; không render secret/stack trace.

**Kiểm thử:** Nhiều trang, time range quá rộng, non-admin, audit trùng timestamp.

**Hoàn tất khi:** Lọc được lịch sử có lý do; không sửa/xóa audit trong UI.

### A15

**API tổng quan và trạng thái hệ thống**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A01](#a01), [A08](#a08), [A12](#a12).

**Kết quả:** Admin đọc counts và job summaries có mốc thời gian.

**Phạm vi file/module:** Admin summary/system routes (mới).

**Việc làm:** Aggregation counts theo hợp đồng; release/environment, backup/reconcile/cleanup status; không scan mọi ledger hoặc trả raw logs.

**Kiểm thử:** Fixture counts/ticket states, job failed/unknown, không có backup, non-admin.

**Hoàn tất khi:** DTO nhỏ và có updatedAt; chưa có dữ liệu hiển thị unknown, không giả số0/thành công.

### A16

**Trang tổng quan quản trị**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A02](#a02), [A15](#a15).

**Kết quả:** Admin thấy số user/chuyến/ticket chờ và việc cần xử lý.

**Phạm vi file/module:** Admin dashboard React (mới).

**Việc làm:** Cards số liệu+thời điểm, links lọc tới trang liên quan; loading/error; không thêm biểu đồ chưa có nhu cầu.

**Kiểm thử:** Counts stale/unknown, ticket queue rỗng, API lỗi.

**Hoàn tất khi:** Người quản trị biết nên mở trang nào tiếp theo mà không đọc tên collection.

### A17

**Trang hệ thống và kết quả jobs**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [A02](#a02), [A15](#a15).

**Kết quả:** Admin biết môi trường/release và job nào cần kiểm tra.

**Phạm vi file/module:** Admin system page React (mới).

**Việc làm:** Badge staging/prod, SHA, backup/reconcile/cleanup summaries, failure message và runbook link; P0 xem trạng thái.

**Kiểm thử:** Backup quá hạn, job fail, thiếu kết quả, đang pending.

**Hoàn tất khi:** Thông báo có hành động tiếp theo; không có nút chạy shell tùy ý từ website.
