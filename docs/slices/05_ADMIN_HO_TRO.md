# ShareBill — Quản trị và hỗ trợ

[Danh mục 20 lát cắt](README.md) · [Thiết kế CSDL](../DATABASE.md) · [Hợp đồng API](../BACKEND.md)

Quyền platform admin tách khỏi quyền owner chuyến. Triển khai và kiểm quyền API trước khi nối giao diện quản trị.

## S15

**Quản trị tài khoản và chuyến**

- **Trạng thái** Chưa làm
- **Phụ thuộc** [S11](04_FRONTEND_APP.md#s11)
- **Kết quả** Dựng quyền và phiên admin, API/UI tìm tài khoản và chuyến, suspend/resume và khóa/mở tài khoản qua worker Auth.
- **Nghiệm thu** User thường bị chặn ở API và UI. Lệnh moderation có lý do, audit và trạng thái đồng bộ. Worker chịu được retry và lệnh khóa/mở đến gần nhau.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="a01"></a>

**A01 · Bootstrap admin và guard backend**

- **Kết quả** User thường bị chặn admin API; admin active được nhận diện.
- **Phạm vi file/module** Admin bootstrap script, `be/src/services/admin-auth.ts` và admin routes (mới).
- **Việc làm** platformAdmins schema; script dry-run với project/uid; GET admin/me; guard user+admin status và recent auth cho mutation nhạy cảm.
- **Kiểm thử** User/owner403, disabled admin, revoke quyền, bootstrap sai project/UID.
- **Hoàn tất khi** Không có public API tự cấp admin; admin không tự có membership mọi chuyến.

<a id="a02"></a>

**A02 · Khung website quản trị và phiên**

- **Kết quả** Mở được website quản trị với sáu mục điều hướng.
- **Phạm vi file/module** `fe/src/features/admin/` và layout admin (mới).
- **Việc làm** Đăng nhập quản trị theo ADMIN_WEB.md; gọi admin/me, route guard, recent-auth prompt và cache tách khỏi app; nhãn môi trường.
- **Kiểm thử** User thường vào URL admin, token hết hạn, role revoke, reauth cancel.
- **Hoàn tất khi** Sidebar đơn giản; React guard không thay kiểm quyền phía BE.

<a id="a03"></a>

**A03 · API tìm/list/detail tài khoản**

- **Kết quả** Admin tìm đúng UID/email và list theo status.
- **Phạm vi file/module** Admin user query/DTO/routes (mới).
- **Việc làm** Exact lookup không scan; cursor; DTO metadata allowlist, không token/credential; index status+createdAt.
- **Kiểm thử** Email chuẩn hóa, UID sai, nhiều trang, non-admin.
- **Hoàn tất khi** Response chỉ metadata cần dùng; không kéo ledger/receipts của user.

<a id="a04"></a>

**A04 · Trang người dùng có tìm kiếm và chi tiết**

- **Kết quả** Admin tìm và xem tài khoản bằng website.
- **Phạm vi file/module** Admin users list/detail React (mới).
- **Việc làm** Ô tìm đúng loại UID/email, filters/reset, pagination, empty/error; hiển thị trạng thái/Auth sync; chưa gắn action lock trước A09.
- **Kiểm thử** Tìm đúng/không có email, pagination, query lỗi, viewport nhỏ.
- **Hoàn tất khi** Tìm được user mà không cần mở Firebase Console hoặc nhập path collection.

<a id="a05"></a>

**A05 · API metadata chuyến và suspend/resume**

- **Kết quả** Admin xem metadata và tạm khóa/mở thao tác chuyến.
- **Phạm vi file/module** Admin trip query/moderation routes (mới).
- **Việc làm** Search tripID/status hoặc moderationStatus, cursor; moderationVersion, reason, recent auth, signal/admin audit/op; giữ nguyên ledgerVersion.
- **Kiểm thử** Suspend và expense write cạnh tranh, stale version, user không admin.
- **Hoàn tất khi** Suspend chặn ghi nghiệp vụ, không sửa ledger; API admin không trả sổ tiền/ảnh.

<a id="a06"></a>

**A06 · Trang chuyến và thao tác tạm khóa**

- **Kết quả** Admin tìm chuyến và khóa/mở bằng câu chữ rõ ràng.
- **Phạm vi file/module** Admin trips list/detail/dialogs React (mới).
- **Việc làm** ID/status filter, metadata; dialog reason và tác động; request version/key; show normal/suspended riêng active/archived.
- **Kiểm thử** Sai lý do, reauth, version conflict, trip archived và suspended.
- **Hoàn tất khi** Trong ba màn hình hoàn tất hành động; không có nút sửa balance tùy ý.

<a id="a07"></a>

**A07 · Lệnh khóa/mở tài khoản và outbox Auth**

- **Kết quả** Lệnh quản trị ghi desired state và trả jobId ổn định.
- **Phạm vi file/module** Admin user moderation service/routes, Auth job schema (mới).
- **Việc làm** Disable app ngay; enable giữ disabled tới sync xong; transaction version/job/audit/op; không gọi Auth trong tx.
- **Kiểm thử** Disable→enable→disable nhanh, duplicate key, version stale, recent auth hết hạn.
- **Hoàn tất khi** 202 trả cùng jobId khi retry; trạng thái app không tự mở trước Auth sync.

<a id="a08"></a>

**A08 · Worker đồng bộ khóa Firebase Auth**

- **Kết quả** Mỗi UID chỉ có một worker hợp lệ áp desired state mới nhất.
- **Phạm vi file/module** Auth job worker, `adminAuthLeases`, reconciler desired state (mới).
- **Việc làm** Lease theo UID, attempts/backoff, revoke sessions khi disable, version fence và superseded job; kết quả cập nhật sync status.
- **Kiểm thử** Worker cũ hoàn tất muộn, lease hết, Auth API lỗi, process chết giữa hai hệ thống.
- **Hoàn tất khi** Job cũ không mở user vừa bị khóa; lỗi có trạng thái và retry bounded.

<a id="a09"></a>

**A09 · Giao diện khóa/mở user và theo dõi sync**

- **Kết quả** Admin biết lệnh đang đồng bộ hay đã hoàn tất.
- **Phạm vi file/module** Admin user moderation dialogs/job status UI (mới).
- **Việc làm** Reason/reauth, key/version; show pending/failed/synced và action phù hợp; poll bounded theo job API.
- **Kiểm thử** Job chậm/lỗi, đổi trạng thái từ tab khác, mất response.
- **Hoàn tất khi** Không báo mở tài khoản thành công khi app status vẫn disabled; có hướng xử lý job lỗi.

</details>

## S16

**Hỗ trợ, audit và tổng quan quản trị**

- **Trạng thái** Chưa làm
- **Phụ thuộc** [S15](#s15)
- **Kết quả** Tạo ticket trong app, hàng đợi hỗ trợ, ghi chú nội bộ, tra audit và trang dashboard/trạng thái jobs.
- **Nghiệm thu** Người gửi chỉ đọc ticket của họ. Admin xem được hàng đợi, audit và kết quả job theo quyền. Ghi chú nội bộ và thông tin nhạy cảm được giới hạn theo DTO.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="a10"></a>

**A10 · API ticket của chính người gửi**

- **Kết quả** User tạo và đọc ticket riêng với quota.
- **Phạm vi file/module** User support routes, ticket/rate-limit schemas (mới).
- **Việc làm** 5 tickets/ngày/UID transaction; category/message; membership check khi kèm tripId; list/detail scope UID; internal notes không vào DTO.
- **Kiểm thử** Quota vượt, UID khác đọc ticket, tripId ngoài nhóm, duplicate request.
- **Hoàn tất khi** Một key chỉ tạo một ticket; user không đọc được internal note.

<a id="a11"></a>

**A11 · Form gửi lỗi trong app**

- **Kết quả** Người dùng gửi mô tả và xem trạng thái xử lý.
- **Phạm vi file/module** User support form/list/detail React (mới).
- **Việc làm** Context trip tự điền khi hợp lệ; category/message, max length, quota feedback; không hỏi password/token; không upload file P0.
- **Kiểm thử** Message quá ngắn, quota, mất mạng, view ticket người khác.
- **Hoàn tất khi** Gửi một lần có mã ticket; không mất nội dung khi lỗi; chỉ thấy ticket của mình.

<a id="a12"></a>

**A12 · API hàng đợi support và ghi chú nội bộ**

- **Kết quả** Admin xử lý ticket bằng status và internal timeline.
- **Phạm vi file/module** Admin ticket list/update/note routes (mới).
- **Việc làm** Cursor status+updatedAt; If-Match/key đổi status; note append-only, admin audit; DTO chọn field.
- **Kiểm thử** Hai admin đổi cùng ticket, note retry, user thường gọi admin route.
- **Hoàn tất khi** Không ghi đè status mới; note nội bộ không lộ ra endpoint user.

<a id="a13"></a>

**A13 · Trang xử lý hỗ trợ**

- **Kết quả** Admin nhận ticket, cập nhật status và thêm note.
- **Phạm vi file/module** Admin support list/detail React (mới).
- **Việc làm** Ba trạng thái dễ hiểu; list filter/cursor; detail context, note form, conflict/retry.
- **Kiểm thử** Empty queue, version conflict, dài message/note, permission revoked.
- **Hoàn tất khi** Một luồng tìm→xem→xử lý; không cần biết cấu trúc Firestore.

<a id="a14"></a>

**A14 · Tra lịch sử quản trị**

- **Kết quả** Admin xem ai đã tác động user/trip/ticket.
- **Phạm vi file/module** Admin audit query/DTO và activity page (mới).
- **Việc làm** targetType+time window<=31 ngày, cursor; reason/action/requestId; append-only; không render secret/stack trace.
- **Kiểm thử** Nhiều trang, time range quá rộng, non-admin, audit trùng timestamp.
- **Hoàn tất khi** Lọc được lịch sử có lý do; không sửa/xóa audit trong UI.

<a id="a15"></a>

**A15 · API tổng quan và trạng thái hệ thống**

- **Kết quả** Admin đọc counts và job summaries có mốc thời gian.
- **Phạm vi file/module** Admin summary/system routes (mới).
- **Việc làm** Aggregation counts theo hợp đồng; release/environment, backup/reconcile/cleanup status; không scan mọi ledger hoặc trả raw logs.
- **Kiểm thử** Fixture counts/ticket states, job failed/unknown, không có backup, non-admin.
- **Hoàn tất khi** DTO nhỏ và có updatedAt; chưa có dữ liệu hiển thị unknown, không giả số0/thành công.

<a id="a16"></a>

**A16 · Trang tổng quan quản trị**

- **Kết quả** Admin thấy số user/chuyến/ticket chờ và việc cần xử lý.
- **Phạm vi file/module** Admin dashboard React (mới).
- **Việc làm** Cards số liệu+thời điểm, links lọc tới trang liên quan; loading/error; không thêm biểu đồ chưa có nhu cầu.
- **Kiểm thử** Counts stale/unknown, ticket queue rỗng, API lỗi.
- **Hoàn tất khi** Người quản trị biết nên mở trang nào tiếp theo mà không đọc tên collection.

<a id="a17"></a>

**A17 · Trang hệ thống và kết quả jobs**

- **Kết quả** Admin biết môi trường/release và job nào cần kiểm tra.
- **Phạm vi file/module** Admin system page React (mới).
- **Việc làm** Badge staging/prod, SHA, backup/reconcile/cleanup summaries, failure message và runbook link; P0 xem trạng thái.
- **Kiểm thử** Backup quá hạn, job fail, thiếu kết quả, đang pending.
- **Hoàn tất khi** Thông báo có hành động tiếp theo; không có nút chạy shell tùy ý từ website.

</details>
