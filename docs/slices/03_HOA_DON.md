# ShareBill — 03 — Ảnh hóa đơn: backend trước, giao diện sau

[Danh mục và thứ tự thực hiện](README.md) · [Thiết kế CSDL](../DATABASE.md) · [Hợp đồng API](../BACKEND.md)

I01..I07 là backend/Storage. I08 ghép vào form FE sau khi luồng khoản chi đã dùng được. Các bước finalize tách riêng vì Firestore và Storage không có chung transaction.

**Số lát cắt: 8.** Trạng thái ban đầu đều **Chưa làm**. File hiện có là điểm sửa; đường dẫn ghi “mới” hoặc tên module chưa tồn tại là vị trí dự kiến. Mỗi lát cập nhật hợp đồng API/schema liên quan nếu có thay đổi.

## Danh sách nhanh

| Mã | Kết quả cần làm | Phụ thuộc |
| --- | --- | --- |
| [I01](#i01) | Cấp upload intent và policy có giới hạn | [D05](01_DATABASE_BE.md#d05), [D09](01_DATABASE_BE.md#d09) |
| [I02](#i02) | Claim lease khi bắt đầu finalize | [I01](#i01) |
| [I03](#i03) | Xử lý ảnh và hoàn tất metadata | [I02](#i02) |
| [I04](#i04) | Gắn tối đa ba ảnh vào khoản chi | [I03](#i03), [B11](02_NGHIEP_VU_BE.md#b11) |
| [I05](#i05) | Cấp quyền xem ảnh có thời hạn | [I04](#i04) |
| [I06](#i06) | Loại bỏ ảnh chưa attached | [I03](#i03), [D09](01_DATABASE_BE.md#d09) |
| [I07](#i07) | Cleanup orphan và receipt hết hạn | [I05](#i05), [I06](#i06) |
| [I08](#i08) | Camera/chọn ảnh và trạng thái upload trên FE | [I04](#i04), [I05](#i05), [I06](#i06), [F09](04_FRONTEND_APP.md#f09), [F12](04_FRONTEND_APP.md#f12) |

## Chi tiết từng lát cắt

### I01

**Cấp upload intent và policy có giới hạn**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D05](01_DATABASE_BE.md#d05), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** Member tạo một intent upload riêng tư đúng chuyến.

**Phạm vi file/module:** `be/src/services/receipts.ts` (mới), receipt routes, cấu hình Storage.

**Việc làm:** Receipt schema/factory; quyền/quota; policy cố định path/type/size/expiry; CORS origin thật và client SDK deny; không lưu signature.

**Kiểm thử:** Sai quyền/path/type/size, expiry, replay key; smoke upload staging khi có cloud.

**Hoàn tất khi:** Chỉ upload vào staging path đã cấp; không public bucket hoặc URL dài hạn.

### I02

**Claim lease khi bắt đầu finalize**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [I01](#i01).

**Kết quả:** Chỉ một attempt finalize giữ lease hợp lệ.

**Phạm vi file/module:** Receipt finalize service, workflow metadata.

**Việc làm:** If-Match/key/hash/baseVersion, attemptId, leaseUntil; continuation cùng key; trả processing-in-progress khi đang có owner.

**Kiểm thử:** Hai finalize cạnh tranh; cùng key khác body; lease hết và reclaim.

**Hoàn tất khi:** Attempt cũ không thể hoàn tất đè attempt mới; chưa ghi operation committed trước khi xong.

### I03

**Xử lý ảnh và hoàn tất metadata**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [I02](#i02).

**Kết quả:** Ảnh hợp lệ được xử lý và chuyển ready.

**Phạm vi file/module:** Image processor (mới), finalize completion service.

**Việc làm:** Đọc đúng object generation; kiểm bytes/type/decode/pixels; rotate/strip/resize; ghi path attempt riêng; commit ready sau recheck lease/quyền; failed/retry rõ.

**Kiểm thử:** Ảnh hỏng/quá giới hạn, crash sau upload output, quyền bị gỡ, attempt cũ commit muộn.

**Hoàn tất khi:** Ready trỏ đúng generation ảnh đạt giới hạn; orphan không bị nhận là kết quả thành công.

### I04

**Gắn tối đa ba ảnh vào khoản chi**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [I03](#i03), [B11](02_NGHIEP_VU_BE.md#b11).

**Kết quả:** Expense và receipt ownership được ghi cùng transaction.

**Phạm vi file/module:** Expense create/edit service, receipt attach transaction.

**Việc làm:** Nhận receiptIds allowlist; ready/cùng trip/uploader đúng; max3; không gắn lại receipt sang expense khác; snapshots audit phù hợp.

**Kiểm thử:** Hai expense tranh receipt, quá3, ảnh của người/chuyến khác, sửa expense giữ receipt đã attached.

**Hoàn tất khi:** Không có expense trỏ ảnh chưa claim hoặc một receipt thuộc hai expense.

### I05

**Cấp quyền xem ảnh có thời hạn**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [I04](#i04).

**Kết quả:** Member xem ảnh attached; uploader xem ảnh ready của mình.

**Phạm vi file/module:** Receipt view-url route/service.

**Việc làm:** DTO có URL TTL ngắn sau check quyền; private no-store; không persist URL vào DB/op/log; không nhận arbitrary object path.

**Kiểm thử:** Outsider/removed, ready của người khác, attached expense void, URL hết hạn.

**Hoàn tất khi:** API không cấp mới khi mất quyền; path/generation lấy từ receipt server.

### I06

**Loại bỏ ảnh chưa attached**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [I03](#i03), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** Uploader/owner bỏ receipt chưa dùng và lập lịch cleanup bytes.

**Phạm vi file/module:** Receipt discard service/routes.

**Việc làm:** If-Match/key; chuyển discarded, discardedAt/cleanupAfter; attached receipt bị chặn; audit phù hợp.

**Kiểm thử:** Discard và attach cạnh tranh, retry, loại ảnh đang attached.

**Hoàn tất khi:** Không xóa bytes trước khi state đã chặn attach; không bỏ ảnh của expense bằng route này.

### I07

**Cleanup orphan và receipt hết hạn**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [I05](#i05), [I06](#i06).

**Kết quả:** Dọn ảnh không còn dùng với dry-run và retry.

**Phạm vi file/module:** Receipt cleanup worker/script, maintenanceJobs writer.

**Việc làm:** Page candidates, claim discarded/lease, recheck state/generation, xóa bytes ngoài tx rồi lưu kết quả; không xóa attached kể cả expense void.

**Kiểm thử:** Cleanup/attach cạnh tranh, xóa object lỗi, chạy lại, checkpoint giữa trang.

**Hoàn tất khi:** Không mất ảnh đang dùng; lỗi có job summary và retry bounded; metadata/audit còn giữ.

### I08

**Camera/chọn ảnh và trạng thái upload trên FE**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [I04](#i04), [I05](#i05), [I06](#i06), [F09](04_FRONTEND_APP.md#f09), [F12](04_FRONTEND_APP.md#f12).

**Kết quả:** Người dùng thêm ảnh từ điện thoại, chờ ready rồi lưu khoản chi.

**Phạm vi file/module:** `fe/src/features/receipts/` (mới), expense form/detail.

**Việc làm:** Chọn/chụp, preview,max3, upload/finalize progress, retry/remove; attach receiptIds; giữ draft khi lỗi và tắt gửi khi ảnh chưa ready.

**Kiểm thử:** Mobile camera/gallery, mạng chậm/mất kết nối, retry finalize, ảnh lỗi; mở lại ảnh attached.

**Hoàn tất khi:** Một luồng dễ hiểu; không báo đã lưu ảnh/khoản chi khi server chưa xác nhận.
