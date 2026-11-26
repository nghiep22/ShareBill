# ShareBill — Cơ sở dữ liệu và nền tảng API

[Danh mục 20 lát cắt](README.md) · [Thiết kế CSDL](../DATABASE.md) · [Hợp đồng API](../BACKEND.md)

Hoàn thiện dữ liệu và hợp đồng API trước khi mở rộng nghiệp vụ. Kết quả kiểm thử của S01–S03 được ghi trong từng lát.

## S01

**Hồ sơ và phiên đăng nhập**

- **Trạng thái** Hoàn tất
- **Phụ thuộc** Nền dự án đã có
- **Kết quả** Chuẩn hóa document người dùng và dùng chung bootstrap hồ sơ từ Firebase Auth.
- **Nghiệm thu** Đăng ký, đăng nhập, refresh, bootstrap và tạo chuyến dùng hồ sơ v1 đúng cách. Tài khoản disabled bị chặn và hồ sơ legacy giữ được dữ liệu.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="d01"></a>

**D01 · Schema và factory hồ sơ người dùng**

- **Kết quả** Tạo một schema v1 và factory cho UserDoc theo DATABASE.md.
- **Phạm vi file/module** `be/src/database/user.ts`, `be/test/database-user.test.ts`.
- **Việc làm** Phân biệt field DB và input HTTP; default moderation chỉ áp cho user mới; không có password/token trong UserDoc.
- **Kiểm thử** Kiểm factory mới và profile disabled; từ chối field sai kiểu.
- **Hoàn tất khi** Factory sinh đủ trường; đọc được profile hợp lệ; không tự đổi disabled sang active.
- **Đã làm** Thêm `userDocumentSchema`, kiểu `UserDocument` và factory `createUserDocument` từ danh tính Firebase Auth. Hồ sơ mới có đủ trường v1; schema từ chối field lạ, trạng thái sai, emailLower không khớp và thời gian cập nhật trước thời gian tạo. Factory không nhận password/token và không sửa document đã tồn tại.
- **Bằng chứng** `pnpm check:be`, `pnpm test:be` (4 test mới, tổng 8 test unit/HTTP đạt) và `pnpm --dir be build` đều thành công. Test đọc profile disabled giữ status/moderation fields. D02 đã nối factory vào các writer và kiểm tích hợp emulator; phạm vi commit D01 chỉ cung cấp schema/factory.

<a id="d02"></a>

**D02 · Dùng chung một luồng bootstrap hồ sơ**

- **Kết quả** Register/login/tạo chuyến dùng cùng cách tạo hoặc đọc hồ sơ.
- **Phạm vi file/module** `be/src/auth-routes.ts`, `be/src/routes.ts`, `be/src/services/user-profile.ts`.
- **Việc làm** Bỏ nhánh tạo user thiếu field trong route trip; giữ profile cũ; bổ sung POST /api/v1/me/bootstrap cho client Firebase SDK và GET /api/v1/me chỉ đọc hồ sơ. Bootstrap dùng danh tính Auth đã xác minh, không nhận role/status từ body.
- **Kiểm thử** Emulator: register→login→create trip; đăng nhập lại user disabled; account Auth có nhưng profile chưa có.
- **Hoàn tất khi** Chỉ có một writer bootstrap; không reset tên, status hoặc moderationVersion đang có.
- **Đã làm** Register/login/refresh và tạo chuyến gọi chung `bootstrapUserProfile`. Chỉ khi thiếu document mới tạo `UserDoc` v1 qua factory D01. Profile cũ được đọc mà không ghi đè; người bị khóa nhận 403. `GET /api/v1/me` đọc hồ sơ và trả 404 nếu chưa có; `POST /api/v1/me/bootstrap` dùng Bearer JWT cùng danh tính lấy từ Firebase Auth, từ chối body tự gán role/status.
- **Bằng chứng** `pnpm check:be`, `pnpm test:be`, `pnpm --dir be build` và integration test Firebase Emulator đạt. Test bao gồm register→login→create trip, SDK user bootstrap, Auth user tạo trip trực tiếp, profile legacy không bị viết đè, disabled giữ moderationVersion, body giả quyền bị từ chối. D03 đã bổ sung dữ liệu gốc chuyến và liên kết owner; migration profile legacy thuộc D13.

</details>

## S02

**Khởi tạo chuyến và người tham gia**

- **Trạng thái** Hoàn tất
- **Phụ thuộc** [S01](#s01)
- **Kết quả** Tạo chuyến cùng toàn bộ liên kết của owner, sau đó thêm participant chưa có tài khoản và số dư ban đầu.
- **Nghiệm thu** Ghi nguyên tử, rollback khi lỗi và retry cùng key. Giới hạn 50 participant không để lại số dư hay liên kết mồ côi.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="d03"></a>

**D03 · Tạo chuyến với đủ liên kết của owner**

- **Kết quả** Một lần tạo chuyến sinh đầy đủ dữ liệu gốc v1.
- **Phạm vi file/module** `be/src/routes.ts`, `be/src/database/trip.ts`, `be/test/emulator.test.ts`.
- **Việc làm** Bổ sung metadata/defaults, participantLinks của owner, membership timestamps, tripRef; tạo audit/operation dùng adapter hiện có và nâng chuẩn ở D08/D09.
- **Kiểm thử** Emulator: kiểm 9 loại document, link ba chiều, retry cùng key và rollback khi ghi lỗi.
- **Hoàn tất khi** Owner/membership/participant/link/balance nhất quán; không tạo chuyến thứ hai khi retry.
- **Đã làm** Factory tạo TripDoc v1 với metadata, số đếm và tổng sáu nhóm chi đều bằng 0. Route tạo trong cùng Firestore transaction owner membership, participant, participantLink, balance, signal, tripRef, audit `trip.created` và operation. Một `Timestamp` dùng cho toàn bộ dữ liệu gốc; `tx.create` tránh ghi đè document đã tồn tại. Retry cùng key trả lại kết quả cũ; dùng key đó cho nội dung khác trả 409.
- **Bằng chứng** `pnpm check:be`, `pnpm test:be`, `pnpm --dir be build` và Firebase Emulator đạt. Integration test đọc đủ chín loại document, kiểm liên kết UID/participant, metadata và timestamps; kiểm retry không tạo chuyến/audit thứ hai và transaction lỗi không để lại document nào. D04 đã chuẩn hóa participant được thêm sau; D06 đồng bộ category totals khi ghi chi; D08/D09 chuẩn hóa audit/operation cho mọi mutation.

<a id="d04"></a>

**D04 · Người tham gia và balance zero đủ metadata**

- **Kết quả** Thêm người chưa có tài khoản tạo đúng participant và balance v1.
- **Phạm vi file/module** `be/src/routes.ts`, `be/src/database/participant.ts`, `be/src/database/trip.ts`, `be/test/emulator.test.ts`.
- **Việc làm** Ghi createdBy/updatedAt/hasLedgerReferences/schemaVersion; balance có updatedAt; giữ giới hạn 50 người all-time.
- **Kiểm thử** Emulator: thêm người, retry, participant thứ 51 bị chặn và không để balance mồ côi.
- **Hoàn tất khi** Một participant có đúng một balance; participantCount tăng một lần; không tự tạo membership.
- **Đã làm** Factory dùng chung cho owner và người thêm sau tạo ParticipantDoc v1 và balance zero với cùng `Timestamp`. Người chưa có tài khoản có `linkedUid=null`, `createdBy`, `updatedAt` và `hasLedgerReferences=false`; balance có `schemaVersion` và `updatedAt`. Transaction dùng `create` cho participant, balance, operation; cập nhật root trip và signal nhưng giữ `schemaVersion` hiện có. Giới hạn 50 người tính cả owner và người từng tạo, không tăng lại khi retry.
- **Bằng chứng** TypeScript check, unit/HTTP tests, build và Firebase Emulator đạt. Integration test kiểm metadata, timestamp, retry trước và tại giới hạn, key dùng lại sai nội dung trả 409; tạo đủ 50 participant có đúng 50 balance, đúng một membership/link owner, lần thêm thứ 51 trả 422 và không ghi operation hay document mồ côi. D05 đã chuẩn hóa expense; D08/D09 chuẩn hóa audit/operation cho các mutation.

</details>

## S03

**Ghi sổ tiền, audit và chống trùng**

- **Trạng thái** Hoàn tất
- **Phụ thuộc** [S02](#s02)
- **Kết quả** Chuẩn hóa writer khoản chi và trả nợ, đồng bộ projection, ghi audit và lưu kết quả idempotency.
- **Nghiệm thu** Kiểm create/void expense, pending/confirm settlement, số dư và tổng theo danh mục. Retry đồng thời chỉ commit một lần, key cũ replay đúng và người mất quyền nhận 404.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="d05"></a>

**D05 · Chuẩn hóa document khoản chi**

- **Kết quả** Expense mới có đủ trường v1; expense cũ vẫn đọc được.
- **Phạm vi file/module** `be/src/routes.ts`, `be/src/database/expense.ts`, `be/src/read-routes.ts`, `be/src/finance-routes.ts`, `be/src/schemas.ts`, `be/test/database-expense.test.ts`, `be/test/emulator.test.ts`.
- **Việc làm** Factory currency/splitInput/receiptIds/update/void metadata; reader tương thích legacy split; không thay công thức shares hiện có.
- **Kiểm thử** Schema test và emulator: equal/exact, shares lẻ, đọc bản ghi legacy.
- **Hoàn tất khi** Writer mới dùng splitInput; không mất shares, amount hoặc lịch sử của bản ghi cũ.
- **Đã làm** Factory và schema v1 tạo expense có `currency=VND`, `splitInput`, shares được kiểm theo cách chia, `receiptIds=[]`, actor/timestamps và void metadata nullable. API POST vẫn nhận `split` để tương thích payload hiện có; document mới chỉ lưu `splitInput`. Hash operation giữ định dạng cũ khi `receiptIds` rỗng để retry trước D05 vẫn nhận đúng kết quả. Reader list/detail bổ sung `splitInput` cho document legacy chỉ có `split`, không sửa bản gốc. Void cập nhật `updatedBy`; receipt ID khác rỗng trả 422 cho tới khi có luồng xác thực ảnh I01–I07.
- **Bằng chứng** TypeScript check, unit/HTTP tests, build, Firebase Emulator và seed local đạt. Unit test kiểm schema/factory và đọc legacy; integration test kiểm equal chia lẻ 101, exact 1+100, document mới/void hợp schema, đọc legacy qua list/detail và không nhận receipt chưa có lifecycle. Seed xác nhận tổng chi 1.200.000đ và net 500.000đ/-100.000đ/-400.000đ. D06 đã đồng bộ category totals, balance timestamps, hasLedgerReferences và signal khi ghi tiền; D15 migration expense legacy.

<a id="d06"></a>

**D06 · Đồng bộ thống kê và số dư khi ghi tiền**

- **Kết quả** Tạo/hủy khoản chi cập nhật đúng balance, counters và category totals.
- **Phạm vi file/module** `be/src/routes.ts`, `be/src/finance-routes.ts`, `be/src/domain/money.ts`, `be/src/database/trip.ts`, `be/scripts/seed-database.ts`, `be/test/money.test.ts`, `be/test/emulator.test.ts`.
- **Việc làm** Dùng delta chung; thêm updatedAt và hasLedgerReferences; kiểm safe integer và signal/version trong cùng transaction.
- **Kiểm thử** Emulator: create→void→retry; tổng paid=owed=totalExpense; tổng net=0; category totals đúng.
- **Hoàn tất khi** Không còn writer tiền bỏ qua categoryTotalsMinor hoặc timestamp balance.
- **Đã làm** Hàm delta chung cập nhật `totalExpenseMinor` và sáu `categoryTotalsMinor` cho tạo/hủy, kiểm map gốc, tổng, số nguyên an toàn và không âm. Route từ chối balance thiếu thay vì tự tạo zero balance; cập nhật `updatedAt` của mọi balance thay đổi, `hasLedgerReferences=true` cho payer/người chia và giữ true khi void. Expense counters, revision, ledgerVersion, signal cùng commit; signal giữ `schemaVersion`. Xác nhận trả nợ cũng cập nhật timestamp balance; tạo pending không làm mất schemaVersion của signal. Trip/projection legacy thiếu category totals cần migration D14/D16 trước khi tiếp tục ghi tiền, thay vì ghi sai thống kê.
- **Bằng chứng** `pnpm check:be`, `pnpm test:be`, `pnpm --dir be build`, Firebase Emulator và seed local đạt. Test kiểm create→confirm→void→retry, tổng paid=owed=totalExpense, tổng sent=received, tổng net=0, category totals, timestamp và signal theo từng bước; balance bị thiếu trả 409 và không ghi expense/operation. Seed kiểm 1.200.000đ chia stay 900.000đ, food 300.000đ và net 500.000đ/-100.000đ/-400.000đ. D07 đã chuẩn hóa settlement document; migration projection legacy ở D14/D16.

<a id="d07"></a>

**D07 · Chuẩn hóa document trả nợ**

- **Kết quả** Tạo pending và confirm hiện có ghi đủ trường v1.
- **Phạm vi file/module** `be/src/finance-routes.ts`, `be/src/database/settlement.ts`, `be/src/read-routes.ts`, `be/test/database-settlement.test.ts`, `be/test/emulator.test.ts`.
- **Việc làm** Bổ sung currency, nullable state metadata, schemaVersion và cờ ledger reference; giữ mốc basedOnLedgerVersion lúc tạo.
- **Kiểm thử** Emulator: pending không đổi tiền; confirm đúng một lần; metadata trước/sau đầy đủ.
- **Hoàn tất khi** Status/version/confirmationMode đúng; không để thiếu trường khiến FE phải suy đoán.
- **Đã làm** Factory/schema v1 tạo settlement pending với `currency=VND`, `basedOnLedgerVersion`, timestamp và toàn bộ trường confirmed/cancelled/void nullable. Transaction tạo settlement cùng counters, signal, operation và đặt `hasLedgerReferences=true` cho cả hai participant. Confirm chỉ cập nhật trạng thái, version, actor/mode/timestamp; giữ nguyên `basedOnLedgerVersion` của lúc tạo. Reader xuất timestamp confirmed/cancelled ở dạng ISO. Cancel/void settlement chưa có route, thuộc các lát nghiệp vụ sau.
- **Bằng chứng** TypeScript check, unit/HTTP tests, build, Firebase Emulator và seed local đạt. Test kiểm pending không đổi balances, metadata trước/sau đúng schema, retry pending/confirm không ghi trùng; ledger thay đổi giữa tạo và confirm thì payload cũ bị từ chối, payload theo ledger hiện tại được xác nhận nhưng document vẫn giữ mốc tạo cũ. GET danh sách trả đủ metadata cho FE. D08 đã chuẩn hóa audit cho các mutation; D15 migration settlement legacy.

<a id="d08"></a>

**D08 · Audit thống nhất cho mutation hiện có**

- **Kết quả** Mọi mutation hiện có tạo sự kiện đủ đối soát trong cùng commit.
- **Phạm vi file/module** `be/src/database/audit.ts`, `be/src/database/trip.ts`, `be/src/routes.ts`, `be/src/finance-routes.ts`, `be/test/database-audit.test.ts`, `be/test/emulator.test.ts`.
- **Việc làm** Builder allowlist action/entity/before/after; nối create trip, add participant, expense và settlement; không sửa audit legacy.
- **Kiểm thử** Emulator: mutation và audit cùng thành công/thất bại; không có token/email/support content trong audit nhóm.
- **Hoàn tất khi** Có actor/entity/revision/ledgerVersion/operationKey; event retry không bị nhân đôi.
- **Đã làm** Một builder/schema v1 chỉ nhận sáu action hiện có: trip/participant/expense/settlement created, expense voided và settlement confirmed. Snapshot trước/sau dùng strict allowlist; expense giữ payer, amount, shares, status và version; settlement giữ hai participant, amount, mốc ledger, status và mode. Mọi route ghi event cùng transaction, gồm thêm participant trước đây thiếu audit. Event có actor, entity, revision, ledgerVersion, operationKey và timestamp; tên actor dạng email/token bị bỏ, email/link/token trong tên chuyến, tên participant và reason được che. Audit legacy không bị sửa; D18 xử lý baseline lịch sử cũ.
- **Bằng chứng** TypeScript check, unit/HTTP tests, build và Firebase Emulator đạt. Unit test loại snapshot chứa token hoặc sai entity/transition, kiểm che email/link/token trong reason. Emulator xác nhận đủ bảy event trong luồng tạo chuyến→thêm người→chi→pending→confirm→void→chi, snapshot trước/sau và không chứa email/token; retry trip/participant/expense/settlement/void không nhân event. Khi tạo expense thất bại vì thiếu balance, không ghi audit hay operation. D09 tiếp tục chuẩn hóa operation; D18 baseline audit legacy.

<a id="d09"></a>

**D09 · Operation chuẩn và tương thích key cũ**

- **Kết quả** Cùng command/key chỉ commit một lần sau khi nâng schema.
- **Phạm vi file/module** `be/src/http.ts`, `be/src/database/operation.ts` (mới), các route ghi.
- **Việc làm** Canonical hash payload+If-Match, method/path, resource và snapshot; vẫn đọc path/response legacy; kiểm quyền trước replay.
- **Kiểm thử** Emulator: cùng key cùng body, khác body/path, legacy key và quyền đã bị gỡ.
- **Hoàn tất khi** Replay đúng kết quả cũ; key xung đột trả 409; không cấp lại dữ liệu cho người đã mất quyền.
- **Đã làm** Sáu lệnh ghi chuyến dùng chung schema operation và commit bản ghi kết quả cùng dữ liệu nghiệp vụ. Hash SHA-256 gắn với method, path, body đã validate và `If-Match` của lệnh có version. Replay kiểm tra quyền xem chuyến hiện tại, kể cả tạo chuyến và key legacy. Bản ghi mới lưu status, DTO, metadata phiên bản và ETag gốc. Bản ghi cũ tiếp tục replay từ `path` và `response`. Việc migration thuộc [S05](#s05).
- **Bằng chứng** TypeScript check, build, 17 unit/HTTP tests và 6 Firebase Emulator tests đạt. Emulator xác nhận hai request tạo expense đồng thời chỉ ghi một expense và một audit event, cùng key khác body/endpoint/`If-Match` trả 409, replay vẫn trả snapshot gốc sau khi settlement đổi version, key legacy replay được và membership bị gỡ trả 404.

</details>

## S04

**Kiểm tra CSDL và đối soát ledger**

- **Trạng thái** Hoàn tất
- **Phụ thuộc** [S03](#s03)
- **Kết quả** Thêm checker CLI chỉ đọc để báo lỗi schema, liên kết, quyền owner và sai lệch giữa ledger với projection.
- **Nghiệm thu** Fixture lỗi báo đúng mã, path và diff. Scan phân trang phát hiện ledger đổi giữa chừng. Xác minh checker chạy xong mà không ghi document.
- **Đã làm** CLI `db:check` nhận project, UUID chuyến và kích thước trang; quét hồ sơ, chuyến, thành viên, liên kết, receipt, audit, operation và sổ tiền theo trang. Báo lỗi schema/FK/owner/balance, đối soát tổng chi, category, số dư và counters. Đọc lại root sau scan; nếu revision, ledgerVersion hoặc updateTime đổi thì thử lại một lần, sau đó báo `TRIP_CHANGED_DURING_SCAN` mà không công bố diff tạm. Checker chỉ đọc và không tự sửa dữ liệu.
- **Bằng chứng** `pnpm check:be`, `pnpm test:be`, `pnpm --dir be build` và 9 bài Emulator đạt. Integration test kiểm fixture sạch (CLI exit 0), sáu diff cụ thể (exit 1), tham số sai (exit 2), liên kết thiếu, owner trùng, receipt sai và scan đổi ledger giữa hai trang. Fingerprint document trước/sau checker giống nhau. Chưa chạy checker với dữ liệu cloud; nghiệm thu hiện dựa trên Firebase Emulator.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="d10"></a>

**D10 · Checker chỉ đọc cho schema và liên kết**

- **Kết quả** Liệt kê được bản ghi sai shape/FK/owner/link mà không sửa dữ liệu.
- **Phạm vi file/module** `be/src/database/check-integrity.ts` (mới), `be/scripts/check-database.ts` (mới).
- **Việc làm** Kiểm schema, owner duy nhất, ba chiều link, balance thiếu, receipt reference; report mã lỗi/path; có scope project/trip và giới hạn trang.
- **Kiểm thử** Fixture cố ý thiếu link/balance hoặc sai participant; xác nhận checker không ghi document.
- **Hoàn tất khi** Bản ghi lỗi xuất report cụ thể; scan hoàn tất có summary và exit code cho CI/operator.
- **Đã làm** `check-integrity.ts` kiểm schema v1, document ID, owner duy nhất, ba chiều membership/participant/link, profile/tripRef, balance và receipt claim. `check-database.ts` xuất JSON `summary` và danh sách issue có code/path/fields/relatedPath; exit 0 sạch, 1 có issue, 2 lỗi tham số/kết nối. CLI giới hạn `--page-size` 1–100 và có thể khoanh một chuyến bằng `--trip`.
- **Bằng chứng** Emulator fixture thiếu link/balance, owner trùng, participant/receipt sai tạo đúng mã và đường dẫn; fingerprint Firestore trước/sau kiểm tra không đổi. CLI sạch và lỗi cho exit code đúng.

<a id="d11"></a>

**D11 · Đối soát ledger và projection chỉ đọc**

- **Kết quả** So sánh số dư/counters/category totals với ledger nguồn.
- **Phạm vi file/module** `be/src/database/reconcile.ts` (mới), `be/src/domain/`, script checker.
- **Việc làm** Đọc ledger theo trang; kiểm ledgerVersion và revision trước/sau; tính bằng domain; mismatch chỉ báo, không tự repair.
- **Kiểm thử** Fixture đúng, projection sai, pending bị tính nhầm và ledger thay đổi trong lúc scan.
- **Hoàn tất khi** Phát hiện diff đúng; bỏ snapshot đã thay đổi; không chỉnh amount/shares hay balance.
- **Đã làm** `reconcile.ts` dựng lại số dư và counters từ expense/settlement hợp lệ, không tính pending vào số dư; checker so sánh với balance, tổng chi và category totals, signal. Root được đọc trước/sau scan phân trang, thử lại khi đổi và chỉ trả mã `TRIP_CHANGED_DURING_SCAN` nếu vẫn không ổn định.
- **Bằng chứng** Emulator kiểm 6 sai lệch với expected/actual, pending settlement không làm đổi tiền, page size 1 và ledger đổi giữa lúc đọc. Khi dữ liệu đổi liên tục, report không chứa diff từ snapshot cũ.

</details>

## S05

**Migration dữ liệu legacy**

- **Trạng thái** Hoàn tất trên Firebase Emulator; chưa chạy trên dữ liệu cloud theo kế hoạch local-first.
- **Phụ thuộc** [S04](#s04)
- **Kết quả** Xây runner có dry-run và checkpoint. Nâng metadata hồ sơ, chuyến, liên kết, khoản chi, trả nợ, projection, operation và audit.
- **Nghiệm thu** Kiểm dry-run/apply/rerun và chạy tiếp sau crash. Giữ nguyên lịch sử tiền, key chống trùng và dữ liệu nguồn. Báo trường thiếu căn cứ hoặc projection lệch.
- **Đã làm** `db:migrate` mặc định dry-run, yêu cầu project và hai Emulator; `--apply` chỉ ghi vào Firestore Emulator. Bảy migration DBM-001–007 chạy lần lượt, checkpoint theo document, lease/checksum/project guard. Metadata thiếu được thêm có kiểm schema; xung đột liên kết, tổng shares và projection lệch là lỗi chặn. Operation không suy được request giữ nguyên và được báo `LEGACY_OPERATION_RETAINED`; audit cũ giữ nguyên, có baseline riêng và `LEGACY_AUDIT_EVENT`. Job có ngoại lệ mang trạng thái `completed_with_exceptions`; báo cáo `completed` chỉ nghĩa là đã quét hết scope, cần đọc `exceptions` và `failed` trước khi coi dữ liệu đạt schema v1.
- **Kiểm chứng** `pnpm check:be`, bộ test Emulator `migration-users.emulator.test.ts` và `migration-slices.emulator.test.ts`: dry-run không ghi, lease tranh chấp, sai project, ngắt giữa chừng rồi resume, rerun, profile disabled/mất Auth, owner link thiếu, UID/link mâu thuẫn, removed membership, invalid shares, void/confirmed, balance/signal/counter lệch, retry key trước/sau migration, operation thiếu response và audit baseline. CLI dry-run cả collection group đã chạy trên Emulator.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="d12"></a>

**D12 · Khung migration có dry-run và checkpoint**

- **Kết quả** Chạy migration theo ID với scope rõ và tiếp tục sau khi bị ngắt.
- **Phạm vi file/module** `be/scripts/migrate-database.ts` (mới), `be/src/database/migrations/` (mới).
- **Việc làm** Dry-run mặc định; project guard, checksum, lease, cursor 100 docs/trang, summary lỗi; bổ sung script package khi đã chạy được.
- **Kiểm thử** Emulator: hai runner tranh lease, crash/resume, sai project và rerun cùng migration.
- **Hoàn tất khi** Không chạy khi API boot/build; dry-run không ghi; checkpoint không bỏ sót document.

<a id="d13"></a>

**D13 · Migration hồ sơ người dùng**

- **Kết quả** Nâng profile legacy thiếu trường mà giữ nguyên trạng thái người dùng.
- **Phạm vi file/module** `be/src/database/migrations/001-users.ts` (mới).
- **Việc làm** Triển khai DBM-001; backfill từ Auth khi có; chỉ bổ sung field thiếu; ghi ngoại lệ khi identity không còn.
- **Kiểm thử** Emulator: profile tối thiểu, disabled, user Auth đã xóa; apply hai lần.
- **Hoàn tất khi** Không reset disabled/version, không tạo admin, rerun không làm thay đổi dữ liệu đã chuẩn.

<a id="d14"></a>

**D14 · Migration trip và liên kết participant**

- **Kết quả** Trip legacy có metadata v1 và các link đã kiểm chứng.
- **Phạm vi file/module** `be/src/database/migrations/002-trips-links.ts` (mới).
- **Việc làm** Triển khai DBM-002/003 trong phạm vi trip; xử lý từng transaction nhỏ; conflict link vào report, không tự chọn người.
- **Kiểm thử** Emulator: owner link thiếu, UID trùng hai participants, removed membership và chạy lại.
- **Hoàn tất khi** Không đổi danh tính/tiền; link mâu thuẫn làm trip đó chưa đạt; không báo completed giả.

<a id="d15"></a>

**D15 · Migration expense và settlement legacy**

- **Kết quả** Ledger cũ đọc/ghi theo schema v1 mà giữ nguyên nội dung kế toán.
- **Phạm vi file/module** `be/src/database/migrations/003-ledger.ts` (mới).
- **Việc làm** Triển khai DBM-004: split→splitInput, currency và nullable metadata; so shares/FK trước khi thêm schemaVersion.
- **Kiểm thử** Emulator: active/void expense, pending/confirmed settlement, shares sai tổng.
- **Hoàn tất khi** Amount/shares/status/version giữ nguyên; bản ghi không đủ suy luận có report.

<a id="d16"></a>

**D16 · Bổ sung metadata projection legacy**

- **Kết quả** Balance/signal thiếu metadata được kiểm và nâng schema có báo cáo.
- **Phạm vi file/module** `be/src/database/migrations/004-projection-metadata.ts` (mới).
- **Việc làm** Triển khai metadata của DBM-005; thêm timestamp/schemaVersion khi đủ chứng cứ; counters/category totals sai chỉ xuất diff cho repair.
- **Kiểm thử** Emulator: thiếu timestamp, signal không khớp root, balance sai tiền, chạy hai lần.
- **Hoàn tất khi** Không tự sửa diff tiền; report phân biệt thiếu metadata và sai projection.

<a id="d17"></a>

**D17 · Migration operation giữ nguyên key**

- **Kết quả** Key legacy tiếp tục replay sau migration.
- **Phạm vi file/module** `be/src/database/migrations/005-operations.ts` (mới).
- **Việc làm** Chuyển path/response khi suy ra được canonicalPath/resource; giữ ID key; retain legacy reader với ngoại lệ.
- **Kiểm thử** Emulator: retry key trước/sau nâng schema; operation thiếu response/resource.
- **Hoàn tất khi** Không gọi lại command, không tạo expense lần hai, không xóa key cũ.

<a id="d18"></a>

**D18 · Baseline cho audit legacy**

- **Kết quả** Lịch sử cũ thiếu dữ liệu được nhận diện rõ.
- **Phạm vi file/module** `be/src/database/migrations/006-audit-baseline.ts` (mới).
- **Việc làm** Triển khai DBM-007: kiểm event cũ, report trường không thể tái dựng, ghi baseline migration riêng; không giả lập actor/before/after.
- **Kiểm thử** Fixture event thiếu actor hoặc snapshot; rerun baseline.
- **Hoàn tất khi** Audit cũ còn nguyên; giới hạn lịch sử có report truy được theo migration/trip.

</details>

## S06

**Phân trang và hợp đồng API cho frontend**

- **Trạng thái** Hoàn tất trên Firebase Emulator; query cloud kiểm ở S18.
- **Phụ thuộc** [S05](#s05)
- **Kết quả** Dùng cursor chung cho chuyến, khoản chi, trả nợ và hoạt động. Bổ sung tra kết quả operation sau timeout và hợp đồng HTTP khác origin.
- **Nghiệm thu** Kiểm nhiều trang, filter, cursor stale, actor đã mất quyền và key legacy. Preflight cho `If-Match` và lỗi HTTP hoạt động theo hợp đồng. Query cloud được kiểm ở S18.
- **Đã làm** Cursor HMAC có hạn 24 giờ, khóa theo UID/chuyến/bộ lọc/sort/revision; giới hạn 20 tripRefs hoặc 50 bản ghi tài chính/hoạt động mỗi trang. Trips đọc `tripRefs` active, kiểm membership hiện tại, trả `nextCursor` kể cả trang lọc rỗng. Expense hỗ trợ status, khoảng ngày, một trong category/payer; settlement hỗ trợ status; activity chỉ xuất DTO allowlist. `GET /operations/:key` trả kết quả tối thiểu sau kiểm quyền hiện tại, gồm key legacy. API xuất `ETag`, `X-Request-Id`, `Cache-Control: private, no-store`, CORS allowlist và lỗi JSON ổn định. `CURSOR_SIGNING_SECRET` bắt buộc ngoài Emulator khi cần phân trang.
- **Kiểm chứng** Unit test ký/tamper/scope/revision; Emulator tạo 23 chuyến với `joinedAt` trùng, trang đầu bị lọc rỗng, membership mất quyền; 32 settlements cùng `createdAt`, expense lọc ngày/danh mục, activity legacy có trường riêng tư, cursor stale sau mutation, tra operation của người khác và sau mất quyền. HTTP test GET/POST/PATCH preflight, origin lạ, header và JSON lỗi. Các composite query mới chưa smoke trên Firestore cloud.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="d19"></a>

**D19 · Cursor dùng chung có ràng buộc scope**

- **Kết quả** Các API list dùng được cursor ổn định và kiểm input.
- **Phạm vi file/module** `be/src/http/cursor.ts` (mới), `be/test/cursor.test.ts` (mới).
- **Việc làm** Encode/decode scope/filter/sort/id/revision; giới hạn page size; chặn cursor thuộc chuyến/filter khác.
- **Kiểm thử** Unit test roundtrip, invalid/oversize, scope sai và sort có giá trị trùng.
- **Hoàn tất khi** Không nhận document path tùy ý; filter mới không dùng cursor cũ.

<a id="d20"></a>

**D20 · Phân trang danh sách chuyến**

- **Kết quả** GET trips không dừng ở 20 chuyến đầu.
- **Phạm vi file/module** `be/src/read-routes.ts`, `be/firestore.indexes.json`.
- **Việc làm** Dùng tripRefs status+joinedAt, cursor và kiểm membership thật; giữ nextCursor khi một trang bị lọc hết.
- **Kiểm thử** Emulator: hơn 20 trips, removed membership/tripRef sót, nhiều joinedAt trùng.
- **Hoàn tất khi** Không trùng/mất trip giữa trang; không rò metadata sau khi mất quyền.

<a id="d21"></a>

**D21 · Phân trang và lọc danh sách khoản chi**

- **Kết quả** Expense list có ngày/status và một filter category hoặc payer.
- **Phạm vi file/module** `be/src/read-routes.ts`, `be/firestore.indexes.json`.
- **Việc làm** Order occurredOn+documentId; cursor gắn revision; reject tổ hợp chưa hỗ trợ; đối chiếu IX02..04.
- **Kiểm thử** Emulator: nhiều trang, ngày trùng, filter sai, revision đổi; query cloud ở O08.
- **Hoàn tất khi** List không tự suy total/balance; nextCursor và lỗi cursor rõ ràng.

<a id="d22"></a>

**D22 · Phân trang danh sách trả nợ**

- **Kết quả** Settlement list có status và nhiều trang.
- **Phạm vi file/module** `be/src/read-routes.ts`, `be/firestore.indexes.json`.
- **Việc làm** Order createdAt+documentId; cursor kiểm scope/revision; metadata response đủ cho các trạng thái.
- **Kiểm thử** Emulator: hơn 30 records, createdAt trùng, đổi status giữa hai lần đọc.
- **Hoàn tất khi** Không dừng ở 30 bản; không lặp hoặc dùng cursor của chuyến khác.

<a id="b16"></a>

**B16 · Đọc lịch sử hoạt động theo trang**

- **Kết quả** Member active xem lịch sử mutation của chuyến.
- **Phạm vi file/module** `be/src/read-routes.ts`, audit query/DTO.
- **Việc làm** GET activity, cursor createdAt+ID, DTO allowlist; không trả admin audit hoặc token.
- **Kiểm thử** Nhiều trang, thời điểm trùng, outsider/removed, event legacy có trường thiếu.
- **Hoàn tất khi** Timeline đúng thứ tự; không lộ nội dung quản trị nội bộ.

<a id="b17"></a>

**B17 · Tra kết quả một operation sau timeout**

- **Kết quả** Client hỏi outcome bằng key trước khi tự cho rằng giao dịch thất bại.
- **Phạm vi file/module** Operation read route/service.
- **Việc làm** GET operations/:key; chỉ actor và quyền hiện tại; trả committed/result/status nhỏ; định nghĩa not-found/unknown outcome.
- **Kiểm thử** Key khác UID, mất membership sau commit, legacy key, key chưa tồn tại.
- **Hoàn tất khi** Không lộ snapshot khi mất quyền; FE có thể giữ key/body để retry an toàn.

<a id="b18"></a>

**B18 · Hoàn thiện hợp đồng HTTP cho FE khác origin**

- **Kết quả** Frontend deploy riêng gọi được protected API và nhận lỗi nhất quán.
- **Phạm vi file/module** `be/src/app.ts`, `be/src/http.ts`, response helpers (mới nếu cần).
- **Việc làm** CORS theo allowlist, If-Match trong preflight, expose ETag/request-id theo hợp đồng, private no-store cho response user, map lỗi input/JSON; không log token/body.
- **Kiểm thử** HTTP tests preflight GET/POST/PATCH với If-Match; origin lạ bị chặn; malformed JSON và lỗi validation.
- **Hoàn tất khi** Không dùng CORS wildcard cho dữ liệu private; API đổi version dùng được từ FE thật.

</details>
