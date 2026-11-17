# ShareBill — Backend ảnh hóa đơn

[Danh mục 20 lát cắt](README.md) · [Thiết kế CSDL](../DATABASE.md) · [Hợp đồng API](../BACKEND.md)

Xử lý ảnh riêng tư trên backend và Cloud Storage. Luồng camera và thư viện trên app nằm trong [S12](04_FRONTEND_APP.md#s12).

## S10

**Backend ảnh hóa đơn**

- **Trạng thái** Chưa làm
- **Phụ thuộc** [S09](02_NGHIEP_VU_BE.md#s09)
- **Kết quả** Cấp upload intent, xử lý ảnh theo lease, gắn ảnh vào khoản chi, cấp link xem, discard và dọn ảnh hết hạn.
- **Nghiệm thu** Giới hạn ảnh và kiểm quyền theo chuyến/uploader. Chỉ attempt hợp lệ được finalize. Attach và cleanup cạnh tranh vẫn giữ đủ ảnh đã gắn.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="i01"></a>

**I01 · Cấp upload intent và policy có giới hạn**

- **Kết quả** Member tạo một intent upload riêng tư đúng chuyến.
- **Phạm vi file/module** `be/src/services/receipts.ts` (mới), receipt routes, cấu hình Storage.
- **Việc làm** Receipt schema/factory; quyền/quota; policy cố định path/type/size/expiry; CORS origin thật và client SDK deny; không lưu signature.
- **Kiểm thử** Sai quyền/path/type/size, expiry, replay key; smoke upload staging khi có cloud.
- **Hoàn tất khi** Chỉ upload vào staging path đã cấp; không public bucket hoặc URL dài hạn.

<a id="i02"></a>

**I02 · Claim lease khi bắt đầu finalize**

- **Kết quả** Chỉ một attempt finalize giữ lease hợp lệ.
- **Phạm vi file/module** Receipt finalize service, workflow metadata.
- **Việc làm** If-Match/key/hash/baseVersion, attemptId, leaseUntil; continuation cùng key; trả processing-in-progress khi đang có owner.
- **Kiểm thử** Hai finalize cạnh tranh; cùng key khác body; lease hết và reclaim.
- **Hoàn tất khi** Attempt cũ không thể hoàn tất đè attempt mới; chưa ghi operation committed trước khi xong.

<a id="i03"></a>

**I03 · Xử lý ảnh và hoàn tất metadata**

- **Kết quả** Ảnh hợp lệ được xử lý và chuyển ready.
- **Phạm vi file/module** Image processor (mới), finalize completion service.
- **Việc làm** Đọc đúng object generation; kiểm bytes/type/decode/pixels; rotate/strip/resize; ghi path attempt riêng; commit ready sau recheck lease/quyền; failed/retry rõ.
- **Kiểm thử** Ảnh hỏng/quá giới hạn, crash sau upload output, quyền bị gỡ, attempt cũ commit muộn.
- **Hoàn tất khi** Ready trỏ đúng generation ảnh đạt giới hạn; orphan không bị nhận là kết quả thành công.

<a id="i04"></a>

**I04 · Gắn tối đa ba ảnh vào khoản chi**

- **Kết quả** Expense và receipt ownership được ghi cùng transaction.
- **Phạm vi file/module** Expense create/edit service, receipt attach transaction.
- **Việc làm** Nhận receiptIds allowlist; ready/cùng trip/uploader đúng; max3; không gắn lại receipt sang expense khác; snapshots audit phù hợp.
- **Kiểm thử** Hai expense tranh receipt, quá3, ảnh của người/chuyến khác, sửa expense giữ receipt đã attached.
- **Hoàn tất khi** Không có expense trỏ ảnh chưa claim hoặc một receipt thuộc hai expense.

<a id="i05"></a>

**I05 · Cấp quyền xem ảnh có thời hạn**

- **Kết quả** Member xem ảnh attached; uploader xem ảnh ready của mình.
- **Phạm vi file/module** Receipt view-url route/service.
- **Việc làm** DTO có URL TTL ngắn sau check quyền; private no-store; không persist URL vào DB/op/log; không nhận arbitrary object path.
- **Kiểm thử** Outsider/removed, ready của người khác, attached expense void, URL hết hạn.
- **Hoàn tất khi** API không cấp mới khi mất quyền; path/generation lấy từ receipt server.

<a id="i06"></a>

**I06 · Loại bỏ ảnh chưa attached**

- **Kết quả** Uploader/owner bỏ receipt chưa dùng và lập lịch cleanup bytes.
- **Phạm vi file/module** Receipt discard service/routes.
- **Việc làm** If-Match/key; chuyển discarded, discardedAt/cleanupAfter; attached receipt bị chặn; audit phù hợp.
- **Kiểm thử** Discard và attach cạnh tranh, retry, loại ảnh đang attached.
- **Hoàn tất khi** Không xóa bytes trước khi state đã chặn attach; không bỏ ảnh của expense bằng route này.

<a id="i07"></a>

**I07 · Cleanup orphan và receipt hết hạn**

- **Kết quả** Dọn ảnh không còn dùng với dry-run và retry.
- **Phạm vi file/module** Receipt cleanup worker/script, maintenanceJobs writer.
- **Việc làm** Page candidates, claim discarded/lease, recheck state/generation, xóa bytes ngoài tx rồi lưu kết quả; không xóa attached kể cả expense void.
- **Kiểm thử** Cleanup/attach cạnh tranh, xóa object lỗi, chạy lại, checkpoint giữa trang.
- **Hoàn tất khi** Không mất ảnh đang dùng; lỗi có job summary và retry bounded; metadata/audit còn giữ.

</details>
