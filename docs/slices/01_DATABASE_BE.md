# ShareBill — 01 — Cơ sở dữ liệu và backend hiện có

[Danh mục và thứ tự thực hiện](README.md) · [Thiết kế CSDL](../DATABASE.md) · [Hợp đồng API](../BACKEND.md)

Hoàn thiện dữ liệu được các API hiện có ghi ra trước khi bổ sung thêm chức năng. D01–D03 đã hoàn tất; D04–D22 còn lại. Schema/index/seed đã có là đầu vào.

**Số lát cắt: 22; đã xong: 3; còn lại: 19.** File hiện có là điểm sửa; đường dẫn ghi “mới” hoặc tên module chưa tồn tại là vị trí dự kiến. Mỗi lát cập nhật hợp đồng API/schema liên quan nếu có thay đổi.

## Danh sách nhanh

| Mã | Kết quả cần làm | Phụ thuộc |
| --- | --- | --- |
| [D01](#d01) | ✅ Schema và factory hồ sơ người dùng | Nền dự án đã có |
| [D02](#d02) | ✅ Dùng chung một luồng bootstrap hồ sơ | [D01](#d01) |
| [D03](#d03) | ✅ Tạo chuyến với đủ liên kết của owner | [D02](#d02) |
| [D04](#d04) | Người tham gia và balance zero đủ metadata | [D03](#d03) |
| [D05](#d05) | Chuẩn hóa document khoản chi | [D04](#d04) |
| [D06](#d06) | Đồng bộ thống kê và số dư khi ghi tiền | [D05](#d05) |
| [D07](#d07) | Chuẩn hóa document trả nợ | [D06](#d06) |
| [D08](#d08) | Audit thống nhất cho mutation hiện có | [D03](#d03), [D04](#d04), [D05](#d05), [D07](#d07) |
| [D09](#d09) | Operation chuẩn và tương thích key cũ | [D08](#d08) |
| [D10](#d10) | Checker chỉ đọc cho schema và liên kết | [D09](#d09) |
| [D11](#d11) | Đối soát ledger và projection chỉ đọc | [D10](#d10) |
| [D12](#d12) | Khung migration có dry-run và checkpoint | [D10](#d10) |
| [D13](#d13) | Migration hồ sơ người dùng | [D02](#d02), [D12](#d12) |
| [D14](#d14) | Migration trip và liên kết participant | [D03](#d03), [D04](#d04), [D12](#d12) |
| [D15](#d15) | Migration expense và settlement legacy | [D05](#d05), [D07](#d07), [D12](#d12) |
| [D16](#d16) | Bổ sung metadata projection legacy | [D11](#d11), [D12](#d12), [D15](#d15) |
| [D17](#d17) | Migration operation giữ nguyên key | [D09](#d09), [D12](#d12) |
| [D18](#d18) | Baseline cho audit legacy | [D08](#d08), [D12](#d12) |
| [D19](#d19) | Cursor dùng chung có ràng buộc scope | [D09](#d09) |
| [D20](#d20) | Phân trang danh sách chuyến | [D19](#d19) |
| [D21](#d21) | Phân trang và lọc danh sách khoản chi | [D19](#d19), [D05](#d05) |
| [D22](#d22) | Phân trang danh sách trả nợ | [D19](#d19), [D07](#d07) |

## Chi tiết từng lát cắt

### D01

**Schema và factory hồ sơ người dùng**

**Trạng thái:** Hoàn tất. **Phụ thuộc:** nền dự án đã có.

**Kết quả:** Tạo một schema v1 và factory cho UserDoc theo DATABASE.md.

**Phạm vi file/module:** `be/src/database/user.ts`, `be/test/database-user.test.ts`.

**Việc làm:** Phân biệt field DB và input HTTP; default moderation chỉ áp cho user mới; không có password/token trong UserDoc.

**Kiểm thử:** Kiểm factory mới và profile disabled; từ chối field sai kiểu.

**Hoàn tất khi:** Factory sinh đủ trường; đọc được profile hợp lệ; không tự đổi disabled sang active.

**Đã làm:** Thêm `userDocumentSchema`, kiểu `UserDocument` và factory `createUserDocument` từ danh tính Firebase Auth. Hồ sơ mới có đủ trường v1; schema từ chối field lạ, trạng thái sai, emailLower không khớp và thời gian cập nhật trước thời gian tạo. Factory không nhận password/token và không sửa document đã tồn tại.

**Bằng chứng:** `pnpm check:be`, `pnpm test:be` (4 test mới, tổng 8 test unit/HTTP đạt) và `pnpm --dir be build` đều thành công. Test đọc profile disabled giữ status/moderation fields. D02 đã nối factory vào các writer và kiểm tích hợp emulator; phạm vi commit D01 chỉ cung cấp schema/factory.

### D02

**Dùng chung một luồng bootstrap hồ sơ**

**Trạng thái:** Hoàn tất. **Phụ thuộc:** [D01](#d01).

**Kết quả:** Register/login/tạo chuyến dùng cùng cách tạo hoặc đọc hồ sơ.

**Phạm vi file/module:** `be/src/auth-routes.ts`, `be/src/routes.ts`, `be/src/services/user-profile.ts`.

**Việc làm:** Bỏ nhánh tạo user thiếu field trong route trip; giữ profile cũ; bổ sung POST /api/v1/me/bootstrap cho client Firebase SDK và GET /api/v1/me chỉ đọc hồ sơ. Bootstrap dùng danh tính Auth đã xác minh, không nhận role/status từ body.

**Kiểm thử:** Emulator: register→login→create trip; đăng nhập lại user disabled; account Auth có nhưng profile chưa có.

**Hoàn tất khi:** Chỉ có một writer bootstrap; không reset tên, status hoặc moderationVersion đang có.

**Đã làm:** Register/login/refresh và tạo chuyến gọi chung `bootstrapUserProfile`. Chỉ khi thiếu document mới tạo `UserDoc` v1 qua factory D01. Profile cũ được đọc mà không ghi đè; người bị khóa nhận 403. `GET /api/v1/me` đọc hồ sơ và trả 404 nếu chưa có; `POST /api/v1/me/bootstrap` dùng Bearer JWT cùng danh tính lấy từ Firebase Auth, từ chối body tự gán role/status.

**Bằng chứng:** `pnpm check:be`, `pnpm test:be`, `pnpm --dir be build` và integration test Firebase Emulator đạt. Test bao gồm register→login→create trip, SDK user bootstrap, Auth user tạo trip trực tiếp, profile legacy không bị viết đè, disabled giữ moderationVersion, body giả quyền bị từ chối. D03 đã bổ sung dữ liệu gốc chuyến và liên kết owner; migration profile legacy thuộc D13.

### D03

**Tạo chuyến với đủ liên kết của owner**

**Trạng thái:** Hoàn tất. **Phụ thuộc:** [D02](#d02).

**Kết quả:** Một lần tạo chuyến sinh đầy đủ dữ liệu gốc v1.

**Phạm vi file/module:** `be/src/routes.ts`, `be/src/database/trip.ts`, `be/test/emulator.test.ts`.

**Việc làm:** Bổ sung metadata/defaults, participantLinks của owner, membership timestamps, tripRef; tạo audit/operation dùng adapter hiện có và nâng chuẩn ở D08/D09.

**Kiểm thử:** Emulator: kiểm 9 loại document, link ba chiều, retry cùng key và rollback khi ghi lỗi.

**Hoàn tất khi:** Owner/membership/participant/link/balance nhất quán; không tạo chuyến thứ hai khi retry.

**Đã làm:** Factory tạo TripDoc v1 với metadata, số đếm và tổng sáu nhóm chi đều bằng 0. Route tạo trong cùng Firestore transaction owner membership, participant, participantLink, balance, signal, tripRef, audit `trip.created` và operation. Một `Timestamp` dùng cho toàn bộ dữ liệu gốc; `tx.create` tránh ghi đè document đã tồn tại. Retry cùng key trả lại kết quả cũ; dùng key đó cho nội dung khác trả 409.

**Bằng chứng:** `pnpm check:be`, `pnpm test:be`, `pnpm --dir be build` và Firebase Emulator đạt. Integration test đọc đủ chín loại document, kiểm liên kết UID/participant, metadata và timestamps; kiểm retry không tạo chuyến/audit thứ hai và transaction lỗi không để lại document nào. D04 tiếp tục chuẩn hóa participant được thêm sau; D06 đồng bộ category totals khi ghi chi; D08/D09 chuẩn hóa audit/operation cho mọi mutation.

### D04

**Người tham gia và balance zero đủ metadata**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D03](#d03).

**Kết quả:** Thêm người chưa có tài khoản tạo đúng participant và balance v1.

**Phạm vi file/module:** `be/src/routes.ts`, `be/src/database/participant.ts` (mới).

**Việc làm:** Ghi createdBy/updatedAt/hasLedgerReferences/schemaVersion; balance có updatedAt; giữ giới hạn 50 người all-time.

**Kiểm thử:** Emulator: thêm người, retry, participant thứ 51 bị chặn và không để balance mồ côi.

**Hoàn tất khi:** Một participant có đúng một balance; participantCount tăng một lần; không tự tạo membership.

### D05

**Chuẩn hóa document khoản chi**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D04](#d04).

**Kết quả:** Expense mới có đủ trường v1; expense cũ vẫn đọc được.

**Phạm vi file/module:** `be/src/routes.ts`, `be/src/database/expense.ts` (mới), `be/src/read-routes.ts`.

**Việc làm:** Factory currency/splitInput/receiptIds/update/void metadata; reader tương thích legacy split; không thay công thức shares hiện có.

**Kiểm thử:** Schema test và emulator: equal/exact, shares lẻ, đọc bản ghi legacy.

**Hoàn tất khi:** Writer mới dùng splitInput; không mất shares, amount hoặc lịch sử của bản ghi cũ.

### D06

**Đồng bộ thống kê và số dư khi ghi tiền**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D05](#d05).

**Kết quả:** Tạo/hủy khoản chi cập nhật đúng balance, counters và category totals.

**Phạm vi file/module:** `be/src/routes.ts`, `be/src/finance-routes.ts`, `be/src/domain/money.ts`.

**Việc làm:** Dùng delta chung; thêm updatedAt và hasLedgerReferences; kiểm safe integer và signal/version trong cùng transaction.

**Kiểm thử:** Emulator: create→void→retry; tổng paid=owed=totalExpense; tổng net=0; category totals đúng.

**Hoàn tất khi:** Không còn writer tiền bỏ qua categoryTotalsMinor hoặc timestamp balance.

### D07

**Chuẩn hóa document trả nợ**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D06](#d06).

**Kết quả:** Tạo pending và confirm hiện có ghi đủ trường v1.

**Phạm vi file/module:** `be/src/finance-routes.ts`, `be/src/database/settlement.ts` (mới).

**Việc làm:** Bổ sung currency, nullable state metadata, schemaVersion và cờ ledger reference; giữ mốc basedOnLedgerVersion lúc tạo.

**Kiểm thử:** Emulator: pending không đổi tiền; confirm đúng một lần; metadata trước/sau đầy đủ.

**Hoàn tất khi:** Status/version/confirmationMode đúng; không để thiếu trường khiến FE phải suy đoán.

### D08

**Audit thống nhất cho mutation hiện có**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D03](#d03), [D04](#d04), [D05](#d05), [D07](#d07).

**Kết quả:** Mọi mutation hiện có tạo sự kiện đủ đối soát trong cùng commit.

**Phạm vi file/module:** `be/src/database/audit.ts` (mới), các route ghi trong `be/src/`.

**Việc làm:** Builder allowlist action/entity/before/after; nối create trip, add participant, expense và settlement; không sửa audit legacy.

**Kiểm thử:** Emulator: mutation và audit cùng thành công/thất bại; không có token/email/support content trong audit nhóm.

**Hoàn tất khi:** Có actor/entity/revision/ledgerVersion/operationKey; event retry không bị nhân đôi.

### D09

**Operation chuẩn và tương thích key cũ**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D08](#d08).

**Kết quả:** Cùng command/key chỉ commit một lần sau khi nâng schema.

**Phạm vi file/module:** `be/src/http.ts`, `be/src/database/operation.ts` (mới), các route ghi.

**Việc làm:** Canonical hash payload+If-Match, method/path, resource và snapshot; vẫn đọc path/response legacy; kiểm quyền trước replay.

**Kiểm thử:** Emulator: cùng key cùng body, khác body/path, legacy key và quyền đã bị gỡ.

**Hoàn tất khi:** Replay đúng kết quả cũ; key xung đột trả 409; không cấp lại dữ liệu cho người đã mất quyền.

### D10

**Checker chỉ đọc cho schema và liên kết**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D09](#d09).

**Kết quả:** Liệt kê được bản ghi sai shape/FK/owner/link mà không sửa dữ liệu.

**Phạm vi file/module:** `be/src/database/check-integrity.ts` (mới), `be/scripts/check-database.ts` (mới).

**Việc làm:** Kiểm schema, owner duy nhất, ba chiều link, balance thiếu, receipt reference; report mã lỗi/path; có scope project/trip và giới hạn trang.

**Kiểm thử:** Fixture cố ý thiếu link/balance hoặc sai participant; xác nhận checker không ghi document.

**Hoàn tất khi:** Bản ghi lỗi xuất report cụ thể; scan hoàn tất có summary và exit code cho CI/operator.

### D11

**Đối soát ledger và projection chỉ đọc**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D10](#d10).

**Kết quả:** So sánh số dư/counters/category totals với ledger nguồn.

**Phạm vi file/module:** `be/src/database/reconcile.ts` (mới), `be/src/domain/`, script checker.

**Việc làm:** Đọc ledger theo trang; kiểm ledgerVersion và revision trước/sau; tính bằng domain; mismatch chỉ báo, không tự repair.

**Kiểm thử:** Fixture đúng, projection sai, pending bị tính nhầm và ledger thay đổi trong lúc scan.

**Hoàn tất khi:** Phát hiện diff đúng; bỏ snapshot đã thay đổi; không chỉnh amount/shares hay balance.

### D12

**Khung migration có dry-run và checkpoint**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D10](#d10).

**Kết quả:** Chạy migration theo ID với scope rõ và tiếp tục sau khi bị ngắt.

**Phạm vi file/module:** `be/scripts/migrate-database.ts` (mới), `be/src/database/migrations/` (mới).

**Việc làm:** Dry-run mặc định; project guard, checksum, lease, cursor 100 docs/trang, summary lỗi; bổ sung script package khi đã chạy được.

**Kiểm thử:** Emulator: hai runner tranh lease, crash/resume, sai project và rerun cùng migration.

**Hoàn tất khi:** Không chạy khi API boot/build; dry-run không ghi; checkpoint không bỏ sót document.

### D13

**Migration hồ sơ người dùng**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D02](#d02), [D12](#d12).

**Kết quả:** Nâng profile legacy thiếu trường mà giữ nguyên trạng thái người dùng.

**Phạm vi file/module:** `be/src/database/migrations/001-users.ts` (mới).

**Việc làm:** Triển khai DBM-001; backfill từ Auth khi có; chỉ bổ sung field thiếu; ghi ngoại lệ khi identity không còn.

**Kiểm thử:** Emulator: profile tối thiểu, disabled, user Auth đã xóa; apply hai lần.

**Hoàn tất khi:** Không reset disabled/version, không tạo admin, rerun không làm thay đổi dữ liệu đã chuẩn.

### D14

**Migration trip và liên kết participant**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D03](#d03), [D04](#d04), [D12](#d12).

**Kết quả:** Trip legacy có metadata v1 và các link đã kiểm chứng.

**Phạm vi file/module:** `be/src/database/migrations/002-trips-links.ts` (mới).

**Việc làm:** Triển khai DBM-002/003 trong phạm vi trip; xử lý từng transaction nhỏ; conflict link vào report, không tự chọn người.

**Kiểm thử:** Emulator: owner link thiếu, UID trùng hai participants, removed membership và chạy lại.

**Hoàn tất khi:** Không đổi danh tính/tiền; link mâu thuẫn làm trip đó chưa đạt; không báo completed giả.

### D15

**Migration expense và settlement legacy**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D05](#d05), [D07](#d07), [D12](#d12).

**Kết quả:** Ledger cũ đọc/ghi theo schema v1 mà giữ nguyên nội dung kế toán.

**Phạm vi file/module:** `be/src/database/migrations/003-ledger.ts` (mới).

**Việc làm:** Triển khai DBM-004: split→splitInput, currency và nullable metadata; so shares/FK trước khi thêm schemaVersion.

**Kiểm thử:** Emulator: active/void expense, pending/confirmed settlement, shares sai tổng.

**Hoàn tất khi:** Amount/shares/status/version giữ nguyên; bản ghi không đủ suy luận có report.

### D16

**Bổ sung metadata projection legacy**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D11](#d11), [D12](#d12), [D15](#d15).

**Kết quả:** Balance/signal thiếu metadata được kiểm và nâng schema có báo cáo.

**Phạm vi file/module:** `be/src/database/migrations/004-projection-metadata.ts` (mới).

**Việc làm:** Triển khai metadata của DBM-005; thêm timestamp/schemaVersion khi đủ chứng cứ; counters/category totals sai chỉ xuất diff cho repair.

**Kiểm thử:** Emulator: thiếu timestamp, signal không khớp root, balance sai tiền, chạy hai lần.

**Hoàn tất khi:** Không tự sửa diff tiền; report phân biệt thiếu metadata và sai projection.

### D17

**Migration operation giữ nguyên key**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D09](#d09), [D12](#d12).

**Kết quả:** Key legacy tiếp tục replay sau migration.

**Phạm vi file/module:** `be/src/database/migrations/005-operations.ts` (mới).

**Việc làm:** Chuyển path/response khi suy ra được canonicalPath/resource; giữ ID key; retain legacy reader với ngoại lệ.

**Kiểm thử:** Emulator: retry key trước/sau nâng schema; operation thiếu response/resource.

**Hoàn tất khi:** Không gọi lại command, không tạo expense lần hai, không xóa key cũ.

### D18

**Baseline cho audit legacy**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D08](#d08), [D12](#d12).

**Kết quả:** Lịch sử cũ thiếu dữ liệu được nhận diện rõ.

**Phạm vi file/module:** `be/src/database/migrations/006-audit-baseline.ts` (mới).

**Việc làm:** Triển khai DBM-007: kiểm event cũ, report trường không thể tái dựng, ghi baseline migration riêng; không giả lập actor/before/after.

**Kiểm thử:** Fixture event thiếu actor hoặc snapshot; rerun baseline.

**Hoàn tất khi:** Audit cũ còn nguyên; giới hạn lịch sử có report truy được theo migration/trip.

### D19

**Cursor dùng chung có ràng buộc scope**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D09](#d09).

**Kết quả:** Các API list dùng được cursor ổn định và kiểm input.

**Phạm vi file/module:** `be/src/http/cursor.ts` (mới), `be/test/cursor.test.ts` (mới).

**Việc làm:** Encode/decode scope/filter/sort/id/revision; giới hạn page size; chặn cursor thuộc chuyến/filter khác.

**Kiểm thử:** Unit test roundtrip, invalid/oversize, scope sai và sort có giá trị trùng.

**Hoàn tất khi:** Không nhận document path tùy ý; filter mới không dùng cursor cũ.

### D20

**Phân trang danh sách chuyến**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D19](#d19).

**Kết quả:** GET trips không dừng ở 20 chuyến đầu.

**Phạm vi file/module:** `be/src/read-routes.ts`, `be/firestore.indexes.json`.

**Việc làm:** Dùng tripRefs status+joinedAt, cursor và kiểm membership thật; giữ nextCursor khi một trang bị lọc hết.

**Kiểm thử:** Emulator: hơn 20 trips, removed membership/tripRef sót, nhiều joinedAt trùng.

**Hoàn tất khi:** Không trùng/mất trip giữa trang; không rò metadata sau khi mất quyền.

### D21

**Phân trang và lọc danh sách khoản chi**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D19](#d19), [D05](#d05).

**Kết quả:** Expense list có ngày/status và một filter category hoặc payer.

**Phạm vi file/module:** `be/src/read-routes.ts`, `be/firestore.indexes.json`.

**Việc làm:** Order occurredOn+documentId; cursor gắn revision; reject tổ hợp chưa hỗ trợ; đối chiếu IX02..04.

**Kiểm thử:** Emulator: nhiều trang, ngày trùng, filter sai, revision đổi; query cloud ở O08.

**Hoàn tất khi:** List không tự suy total/balance; nextCursor và lỗi cursor rõ ràng.

### D22

**Phân trang danh sách trả nợ**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D19](#d19), [D07](#d07).

**Kết quả:** Settlement list có status và nhiều trang.

**Phạm vi file/module:** `be/src/read-routes.ts`, `be/firestore.indexes.json`.

**Việc làm:** Order createdAt+documentId; cursor kiểm scope/revision; metadata response đủ cho các trạng thái.

**Kiểm thử:** Emulator: hơn 30 records, createdAt trùng, đổi status giữa hai lần đọc.

**Hoàn tất khi:** Không dừng ở 30 bản; không lặp hoặc dùng cursor của chuyến khác.
