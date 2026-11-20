# ShareBill — Backend ảnh hóa đơn S10

Cập nhật 18/11/2026. Backend, xử lý ảnh thật và state machine đã kiểm trên local/Emulator. Chưa tạo/triển khai bucket cloud, đổi gói dịch vụ hoặc chạy smoke IAM/CORS/signed policy thật. Ràng buộc miễn phí của staging vẫn giữ; quyết định lưu trữ cloud và smoke nằm ở S18. Adapter mặc định dùng Cloud Storage for Firebase; interface `ReceiptStorage` tách khỏi nghiệp vụ nếu cần đổi nhà cung cấp.

## Cấu hình

- Runtime server: `FIREBASE_STORAGE_BUCKET` là tên bucket, không có `gs://`; credentials dùng cùng cơ chế Firebase Admin hiện có. Không đưa private key vào frontend.
- `be/storage.rules` deny toàn bộ read/write qua Firebase client SDK. API server tự kiểm quyền; signed requests dùng IAM và không đi qua Rules.
- `be/storage.cors.json` giới hạn origin local và Web/PWA staging đã cấu hình. Đối chiếu origin canonical trước khi áp dụng lên bucket.
- Bucket thật cần private IAM, không có `allUsers`/`allAuthenticatedUsers`, uniform bucket-level access và public access prevention; runtime cần quyền object theo prefix và quyền ký phù hợp credential. Không tạo Firebase download token dài hạn.
- Local dùng Auth/Firestore/Storage Emulators. Test nghiệp vụ inject `MemoryReceiptStorage` và dùng Sharp thật; chỉ test Rules sử dụng Storage Emulator. API mặc định không phát policy giả khi thiếu credentials/signing trên Emulator: trả 503, giữ intent để retry. Test signer/adapter không chứng minh IAM/CORS/TTL trên cloud.

## Hợp đồng API

Tất cả endpoint cần Bearer Firebase ID token. Lệnh ghi cần `Idempotency-Key` UUID v4; finalize/discard còn cần `If-Match` dạng `"1"`.

| Endpoint | Body | Kết quả |
| --- | --- | --- |
| `POST /trips/:tripId/receipts/upload-intents` | `{contentType,bytes}` | Receipt DTO và `upload:{url,fields,expiresAt}`; intent 15 phút, policy tối đa 5 phút |
| `POST /trips/:tripId/receipts/:id/finalize` | `{}` | Claim processing rồi trả ready; chỉ ghi operation committed khi hoàn tất |
| `GET /trips/:tripId/receipts/:id/view-url` | — | `{id,url,expiresAt}`, signed GET pin generation, TTL 60 giây |
| `POST /trips/:tripId/receipts/:id/discard` | `{}` | Uploader/owner bỏ ảnh chưa attached, grace 7 ngày |

Prefix API là `/api/v1`. Chi tiết tương tác trong `be/openapi.json` và `/docs/`.

Upload intent chỉ nhận JPEG/PNG/WebP, dung lượng dự kiến nguyên từ 1 byte tới 5 MiB. Policy cố định staging key, MIME và size 1..5 MiB; quota 10 lần cấp policy/giờ/UID/chuyến, gồm cả replay. Kích thước khai báo chỉ là kiểm đầu vào; finalize kiểm bytes thực. Không nhận filename/path/ACL từ client. Policy được ký sau commit; nếu mất response/lỗi signer, retry cùng key trong hạn intent để cấp lại sau kiểm quyền/trạng thái/quota. Policy/signature không nằm trong operation hoặc audit.

Ví dụ phần upload trên frontend sau khi nhận intent:

```ts
const form = new FormData();
for (const [name, value] of Object.entries(intent.upload.fields)) form.append(name, value);
form.append('file', file); // Đặt file cuối; không tự thêm ACL/metadata/Content-Type header cho request.
const uploaded = await fetch(intent.upload.url, { method: 'POST', body: form });
if (!uploaded.ok) throw new Error('Upload chưa hoàn tất');
// Sau đó POST finalize với key riêng và If-Match phiên bản ban đầu.
```

Policy có thể upload lại cùng staging key tới khi hết hạn; processed object bất biến nên ảnh đã gắn không bị thay bởi lần upload lại.

## Finalize và retry

Claim lần đầu từ version 1 sang processing version 2, lease 2 phút. Receipt giữ `processingOperationKey/requestHash/baseVersion/attemptId/leaseUntil`; `users/{uid}/receiptWorkflows/{key}` reserve key trước khi có operation committed. Các transaction khác cũng đọc reservation, nên không dùng cùng key để tạo khoản chi hoặc xử lý receipt khác trong lúc workflow đang chạy.

Retry khi lease còn hạn trả `409 PROCESSING_IN_PROGRESS`. Sau lease hết, gửi lại **cùng key, body và If-Match ban đầu**, không thay bằng version processing. Mỗi reclaim có attempt ID/path riêng. Cửa sổ retry workflow là 24 giờ từ lúc tạo; cleanup giữ staging source trong cửa sổ này. Callback cũ không được commit sau khi lease mất hoặc attempt đổi. Nếu operation đã committed, retry trả snapshot cũ sau kiểm membership hiện tại.

Processor đọc đúng source generation, giới hạn 5 MiB và 20 megapixel, so magic bytes với MIME, từ chối animation/ảnh hỏng. Sharp xoay EXIF, bỏ metadata, resize cạnh dài ≤1.600px, xuất JPEG ≤2 MiB; decode có timeout. Output ghi với generation precondition không overwrite, path riêng cho attempt:

```text
receipt-staging/{tripId}/{uploaderUid}/{receiptId}/original
receipt-processed/{tripId}/{receiptId}/{attemptId}.jpg
```

Transaction cuối kiểm user/membership/trip/lease/attempt một lần nữa rồi ghi ready, generation, kích thước ảnh, audit/signal/operation. Thường ready version 3, cao hơn nếu reclaim. Lỗi ảnh `422 INVALID_RECEIPT_IMAGE` chuyển failed; tạo intent mới. Lỗi tạm thời giữ processing và cho retry sau lease. Output ghi xong nhưng mất quyền/crash trước commit là orphan, được worker dọn. Xóa staging thất bại tạo maintenance job pending; không làm mất kết quả ready đã commit.

## Gắn ảnh và quyền xem

Expense create/PATCH nhận tối đa ba `receiptIds` không trùng. Ảnh mới phải ready, cùng chuyến, do actor upload. Giữ ảnh đã attached vào chính expense được phép dù uploader là tài khoản khác. Không gắn ảnh sang expense thứ hai. Expense và receipt claim/audit/operation được ghi cùng transaction.

Bỏ ảnh qua PATCH chuyển ảnh sang discarded, đặt cleanupAfter sau 7 ngày; chỉ thay receipt IDs không tăng ledgerVersion. Void expense vẫn giữ ảnh attached. Route discard không bỏ ảnh attached; processing receipt có thể discard, làm attempt đang chạy mất hiệu lực.

Member active xem được ảnh attached, kể cả expense void. Ready chưa gắn chỉ uploader xem. API cấp signed GET đúng processed generation, TTL 60 giây; response/object cache `private, no-store`, URL không persist vào DB/op/audit/log. Gỡ membership chặn cấp URL mới; URL đã phát hành có thể còn hiệu lực tới hạn ngắn này.

## Cleanup

Mặc định dry-run, không thay Firestore hoặc Storage:

```powershell
pnpm --dir be receipts:cleanup --project demo-sharebill --trip <trip-uuid> --limit 25
pnpm --dir be receipts:cleanup --project demo-sharebill --trip <trip-uuid> --limit 25 --apply
pnpm --dir be receipts:cleanup --project demo-sharebill --trip <trip-uuid> --limit 25 --apply --resume <job-uuid>
```

Project phải khớp cấu hình; project demo cần Emulator. CLI dùng adapter Storage thật/Admin SDK; test state machine dùng adapter memory. `--apply` ghi `maintenanceJobs/{uuid}`, checkpoint và lease worker; resume phải giữ trip scope. Không truyền `--trip` để quét collection group tất cả chuyến. Tối đa 100 receipts/lượt, một trang 100 objects cho mỗi staging/processed prefix mỗi lượt; cần resume nếu còn trang hoặc lỗi.

- Intent hết hạn, ready không gắn sau 24h, processing hết cửa sổ retry và failed được chuyển discarded dưới transaction trước xóa.
- Staging của processing được giữ trong cửa sổ retry 24h; sau ready/attached có thể dọn staging hết hạn và output của attempt cũ, luôn giữ processed generation đang dùng.
- Discard/detach chủ động giữ processed bytes 7 ngày. Attached được bảo vệ kể cả expense void. Mọi delete pin generation, recheck trạng thái/pointer trước xóa.
- Lỗi Storage retry tối đa ba lần/receipt/job; sau đó job `failed`, giữ failedPaths cho người vận hành xử lý. Job khác chỉ reclaim khi lease cũ hết. Xóa bytes xong mới đặt storageDeletedAt; metadata và audit vẫn giữ. Lần quét mới tiếp tục thu gom object ghi muộn sau crash/policy replay.
- `summary.deletedObjects` trong dry-run là số dự kiến xóa. Exit 0 là lượt xử lý không lỗi (có thể còn `pending`); 1 là có lỗi/failed paths; 2 là tham số, kết nối hoặc job lease không hợp lệ. Job trạng thái pending/completed_with_errors cần resume.

Worker chạy độc lập, không dựa vào tác vụ nền sau HTTP response. Việc chạy định kỳ và theo dõi vận hành thuộc S19.

## Kiểm chứng và cổng cloud

29 unit/HTTP tests và 43 Emulator tests đạt (72 tổng). Riêng S10 có 4 unit tests ảnh/SDK adapter, 9 kịch bản API/state/concurrency/cleanup và 1 test Rules dùng client token. Test mock signer không chứng minh chính sách upload thật.

Trước release ở S18, cần bucket staging theo lựa chọn phù hợp ràng buộc môi trường, credentials ký thật, CORS đúng origin, IAM private, policy sai key/type/size/hết hạn bị từ chối, view URL hết hạn, generation preconditions và thu gom orphan trên bucket thật. Chưa có thao tác tạo bucket, nâng gói hoặc deploy nào trong S10.

Nguồn API dùng để triển khai: [Cloud Storage signed policies](https://cloud.google.com/storage/docs/authentication/signatures), [Node Storage File API](https://googleapis.dev/nodejs/storage/latest/File.html), [Sharp input limits](https://sharp.pixelplumbing.com/api-constructor/) và [Sharp output/metadata](https://sharp.pixelplumbing.com/api-output/).
