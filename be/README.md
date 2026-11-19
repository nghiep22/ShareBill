# ShareBill backend

Backend Node.js/Fastify + TypeScript, dùng Firebase Authentication và Cloud Firestore. Đã có đăng ký/đăng nhập email và mật khẩu, làm mới phiên bằng Firebase ID token (JWT), tạo/sửa/chốt/mở lại chuyến, quản lý người tham gia và liên kết danh tính, lời mời có hạn, gỡ/khôi phục thành viên, chuyển chủ chuyến, tạo/sửa/hủy khoản chi chia đều/chia số tiền riêng, xem tổng quan và gợi ý trả nợ, tạo/xác nhận/hủy/đảo trả nợ. Có backend ảnh hóa đơn, cleanup, lịch trình, hỗ trợ và API quản trị với worker đồng bộ Firebase Auth. Đặc tả đầy đủ nằm trong [BACKEND.md](../docs/BACKEND.md), hướng dẫn ảnh tại [RECEIPTS.md](../docs/RECEIPTS.md).

## Yêu cầu máy

Thiết kế lưu trữ và backlog hoàn thiện ở [DATABASE.md](../docs/DATABASE.md). Index P0 đã có trong `firestore.indexes.json` và được nối với `firebase.json`; cần deploy và smoke query trên staging trước release. File index bao gồm cả query của chức năng chưa được code.

Kế hoạch có [20 lát cắt triển khai](../docs/slices/README.md). S01–S10 có kiểm chứng local/Emulator. S11–S17 đã có luồng giao diện, quản trị, worker và browser tests. Các cổng cloud, thiết bị thật và phục hồi tiếp tục theo [tiến độ module](../docs/KE_HOACH_HOAN_THIEN.md#tiến-độ-triển-khai-ngày-18112026).

- Node.js 24 LTS, pnpm 11.25.0; phiên bản lưu trong `.node-version` và `package.json` ở thư mục gốc.
- Java 21 cho Firebase Emulator Suite.
- GitHub CLI chỉ dùng để tạo/đẩy repo, không cần để chạy API.

## Chạy local

Từ thư mục gốc repo:

```powershell
pnpm install --frozen-lockfile
Copy-Item be/.env.example be/.env
pnpm --dir be emulators
```

Mở terminal thứ hai:

```powershell
pnpm dev:be
```

API: `http://localhost:3001/health`. Emulator UI: `http://localhost:4000`. Nếu lệnh `java` chưa nhận sau khi vừa cài JDK trên Windows, mở terminal mới hoặc thêm thư mục `C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot\bin` vào PATH của terminal đó.

Trong terminal **cmd** của VS Code, có thể chạy `cd be` rồi `npm run emulators`; ở terminal thứ hai cũng `cd be` rồi `npm run dev`. Các dependency phải được cài trước; repo dùng `pnpm-lock.yaml` làm lockfile chuẩn.

### Thử API trên Swagger UI

Khi Emulator và API đã chạy, mở **http://localhost:3001/docs/**. Trang này mô tả 67 thao tác hiện có. Đặc tả JSON ở `http://localhost:3001/docs/json`.

1. Mở **Tài khoản → POST /api/v1/auth/register** (hoặc `login`), bấm **Try it out**, điền email/mật khẩu/tên rồi **Execute**. Mỗi lần đăng ký cần email mới.
2. Trong response, sao chép **`data.accessToken`**. Bấm **Authorize** ở đầu trang, dán token vào ô BearerAuth **không thêm chữ `Bearer`**, rồi **Authorize**.
3. Mở **Chuyến đi → POST /api/v1/trips**. Điền `Idempotency-Key` là UUID v4 mới, body gồm `name` và `ownerName`, rồi **Execute**. Lấy `data.id` làm `tripId`, `data.ownerParticipantId` để tạo khoản chi.
4. Dùng `tripId` với **GET /api/v1/trips/{tripId}/overview** hoặc thử thêm thành viên/khoản chi. Với mỗi lệnh ghi mới dùng UUID v4 khác; retry đúng cùng payload mới dùng lại key cũ. Khi hủy khoản chi hoặc xác nhận trả nợ, điền `If-Match` dạng `"1"` theo `version` hiện tại.

Swagger UI chỉ là công cụ thử API; đăng nhập/chuyến đi cần hai Emulator đang chạy. Không chia sẻ accessToken hoặc refreshToken trong ảnh chụp hay issue.

Backend đọc `be/.env` khi chạy từ thư mục `be`. Đừng commit file này. Trên production, cấu hình `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY` (Web API key của cùng Firebase project), `APP_ORIGIN` (danh sách origin FE ngăn bằng dấu phẩy), `CURSOR_SIGNING_SECRET` riêng ít nhất 32 ký tự và server credentials ở host secret store. Bật phương thức **Email/Password** trong Firebase Authentication trước khi dùng tài khoản thật. Tuyệt đối không đặt private key trong `fe/` hay biến `NEXT_PUBLIC_*`.

### Kiểm tra CSDL local chỉ đọc

Khi Firebase Emulator đang chạy, mở terminal khác tại thư mục gốc repo:

```powershell
pnpm --dir be db:check --project demo-sharebill --page-size 25
# Hoặc chỉ kiểm một chuyến:
pnpm --dir be db:check --project demo-sharebill --trip <trip-uuid> --page-size 25
```

Checker xuất JSON với `summary` và các lỗi có mã, đường dẫn, trường và giá trị kỳ vọng/thực tế. Exit code `0` là sạch, `1` là tìm thấy lỗi, `2` là tham số hoặc kết nối sai. Checker không ghi hay sửa document; Emulator không có dữ liệu sẽ báo 0 chuyến đã quét. Chạy bộ test tự khởi động/dừng Emulator bằng `pnpm --dir be exec firebase emulators:exec --project demo-sharebill --only auth,firestore "pnpm test:emulator"`.

### Chuyển dữ liệu legacy trên Emulator

Khi cả Auth và Firestore Emulator đang chạy, tại thư mục gốc:

```powershell
pnpm --dir be db:migrate --project demo-sharebill --page-size 100
pnpm --dir be db:migrate --project demo-sharebill --migration DBM-004-ledger
pnpm --dir be db:migrate --project demo-sharebill --apply
```

Lệnh mặc định chỉ đọc. `--apply` chỉ hoạt động với Emulator; có thể thêm `--max-documents N` để kiểm checkpoint/resume. Chạy các migration theo thứ tự DBM-001–007. `issues` chặn hoàn tất và không ghi thay đổi của document/chuyến đó. `exceptions` ghi lại operation cũ không đủ căn cứ để nâng schema và audit cũ thiếu dữ liệu; bản gốc vẫn nguyên, reader legacy vẫn hoạt động. Job có ngoại lệ được ghi `completed_with_exceptions`, còn `completed` trong báo cáo nghĩa là đã quét hết scope. Chạy lại dry-run để lấy lại danh sách đường dẫn ngoại lệ. Với dữ liệu lớn, runner từ chối tự suy link khi một chuyến có hơn 200 bản ghi ledger; cần xử lý riêng có kiểm chứng. Không chạy migration tự động khi API khởi động hoặc build.

## Đăng ký, đăng nhập và JWT

| Method | Path | Body | Kết quả |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/register` | `{ "email", "password", "displayName" }` | 201; tạo Firebase Auth user và hồ sơ Firestore |
| POST | `/api/v1/auth/login` | `{ "email", "password" }` | 200; lấy phiên hiện tại |
| POST | `/api/v1/auth/refresh` | `{ "refreshToken" }` | 200; lấy ID token mới |
| POST | `/api/v1/me/bootstrap` | Không có body; Bearer JWT | 200; tạo hồ sơ v1 nếu chưa có, giữ nguyên hồ sơ hiện có |
| GET | `/api/v1/me` | Không có body; Bearer JWT | 200; đọc hồ sơ hiện có, 404 nếu chưa bootstrap |

Mật khẩu cần 8–128 ký tự; tên hiển thị 1–80 ký tự. Cả ba API trả `Cache-Control: no-store` và `data` gồm `tokenType`, `accessToken`, `refreshToken`, `expiresIn` (giây), `user` (`uid`, `email`, `displayName`). `accessToken` là **Firebase ID token dạng JWT**, gửi trong header `Authorization: Bearer <accessToken>` cho các API chuyến đi. API kiểm chữ ký, project, hạn token, revoke và trạng thái tài khoản. Refresh token là bí mật dài hạn; không ghi log, không gắn vào URL. Với React web, nên dùng Firebase Web SDK để quản lý phiên và tự làm mới token; ba endpoint này hữu ích cho client dùng REST. Đăng xuất một thiết bị là xóa phiên phía client; chức năng thu hồi mọi phiên chưa được triển khai.

Ví dụ PowerShell sau khi emulator và API đã chạy:

```powershell
$session = Invoke-RestMethod -Method Post -Uri http://localhost:3001/api/v1/auth/register -ContentType 'application/json' -Body '{"email":"an@example.test","password":"ExamplePass123!","displayName":"An"}'
$token = $session.data.accessToken
Invoke-RestMethod -Uri http://localhost:3001/api/v1/trips -Headers @{ Authorization = "Bearer $token" }
```

Đăng ký có thể tạo tài khoản Auth thành công trước khi ghi hồ sơ Firestore. Nếu Firestore tạm lỗi, đăng nhập lại sẽ hoàn tất hồ sơ; không tạo tài khoản thứ hai. Trên production cần đặt rate limit tại ingress cho các endpoint đăng ký/đăng nhập/làm mới phiên.

Frontend dùng Firebase Web SDK gọi `POST /api/v1/me/bootstrap` một lần sau đăng ký/đăng nhập bằng `Authorization: Bearer <ID token>` rồi dùng `GET /api/v1/me` để đọc hồ sơ. Body bootstrap phải trống; API lấy UID/email/tên từ Firebase Auth, không nhận role/status từ client. Việc bổ sung trường v1 vào hồ sơ legacy thuộc [S05](../docs/slices/01_DATABASE_BE.md#s05).

## API đã làm

| Method | Path | Yêu cầu |
| --- | --- | --- |
| GET | `/health` | Public |
| POST | `/api/v1/auth/register` | Public; email, password, displayName |
| POST | `/api/v1/auth/login` | Public; email, password |
| POST | `/api/v1/auth/refresh` | Public; refreshToken |
| POST | `/api/v1/me/bootstrap` | Bearer JWT; tạo hồ sơ nếu thiếu, không nhận field từ client |
| GET | `/api/v1/me` | Bearer JWT; chỉ đọc hồ sơ app |
| POST | `/api/v1/trips` | Firebase ID token, Idempotency-Key, body `{name, ownerName}` |
| GET | `/api/v1/trips` | `status`, `limit` tối đa 20, `cursor`; kiểm membership hiện tại |
| GET | `/api/v1/trips/:tripId/overview` | ID token, membership active |
| PATCH | `/api/v1/trips/:tripId` | Owner sửa tên/địa điểm/ngày/ghi chú/múi giờ; Idempotency-Key, If-Match trip.version |
| POST | `/api/v1/trips/:tripId/archive` | Owner chốt khi từng net=0, không pending, balances đầy đủ; body `{}`, key, If-Match trip.version |
| POST | `/api/v1/trips/:tripId/reopen` | Owner mở lại trip archived/normal; body `{}`, key, If-Match trip.version; không hồi sinh invite cũ |
| POST | `/api/v1/trips/:tripId/participants` | ID token, owner, Idempotency-Key, body `{displayName}` |
| PATCH | `/api/v1/trips/:tripId/participants/:id` | Owner đổi tên/active/inactive; Idempotency-Key, If-Match participant.version |
| POST | `/api/v1/trips/:tripId/memberships/:uid/link` | Owner gắn participantId hoặc null để gỡ; lý do, Idempotency-Key, If-Match membership.version |
| GET | `/api/v1/trips/:tripId/members` | Participants và membership DTO, tối đa 50 mỗi loại; membership active |
| POST | `/api/v1/trips/:tripId/memberships/:uid/remove` | Owner gỡ quyền (được cả archived/suspended); body `{reason}`, key, If-Match membership.version |
| POST | `/api/v1/trips/:tripId/memberships/:uid/restore` | Owner khôi phục UID cũ khi trip active/normal; `{reason}`, key, If-Match membership.version |
| POST | `/api/v1/trips/:tripId/transfer-owner` | Owner chuyển cho member active/linked; `{uid, reason}`, key, If-Match trip.version |
| POST | `/api/v1/trips/:tripId/invites` | Owner tạo lời mời; key, `{expiresInDays?: 1..7, maxUses?: 1..20}`, mặc định 7 ngày/20 lượt |
| GET | `/api/v1/trips/:tripId/invites` | Owner; `limit` tối đa 50, `cursor`; không trả token |
| POST | `/api/v1/trips/:tripId/invites/:id/revoke` | Owner, được cả archived/suspended; body `{}`, key, If-Match invite.version |
| POST | `/api/v1/invites/preview` | User active; `{token}`; chỉ đọc tên chuyến/người mời/hạn, không cần key |
| POST | `/api/v1/invites/accept` | User active; `{token}`, key; join chưa liên kết participant, không nhận role từ client |
| POST | `/api/v1/trips/:tripId/receipts/upload-intents` | Member, `{contentType, bytes}`, key; receipt và signed POST policy TTL ≤5 phút |
| POST | `/api/v1/trips/:tripId/receipts/:id/finalize` | Uploader, `{}`, key, If-Match ban đầu; xử lý ảnh theo lease 2 phút |
| GET | `/api/v1/trips/:tripId/receipts/:id/view-url` | Member xem attached; uploader xem ready của mình; URL TTL 60 giây |
| POST | `/api/v1/trips/:tripId/receipts/:id/discard` | Uploader/owner, `{}`, key, If-Match receipt.version; không bỏ ảnh attached |
| POST | `/api/v1/trips/:tripId/expenses` | ID token, member, Idempotency-Key, split equal/exact |
| GET | `/api/v1/trips/:tripId/expenses` | `status`, `from`/`to`, một trong `category`/`payer`, `limit` tối đa 50, `cursor` |
| GET | `/api/v1/trips/:tripId/expenses/:id` | Chi tiết khoản chi |
| PATCH | `/api/v1/trips/:tripId/expenses/:id` | Creator/owner sửa expense active; metadata riêng hoặc đủ block tiền; key, If-Match expense.version |
| POST | `/api/v1/trips/:tripId/expenses/:id/void` | Chủ nhóm/người tạo, If-Match, lý do |
| GET | `/api/v1/trips/:tripId/settlement-suggestions` | Gợi ý từ số dư hiện tại |
| POST | `/api/v1/trips/:tripId/settlements` | Tạo đề nghị trả nợ, Idempotency-Key |
| POST | `/api/v1/trips/:tripId/settlements/:id/confirm` | Người nhận/chủ nhóm xác nhận, If-Match |
| POST | `/api/v1/trips/:tripId/settlements/:id/cancel` | Creator/owner hủy pending, body `{}`, key, If-Match settlement.version; không đổi tiền |
| POST | `/api/v1/trips/:tripId/settlements/:id/void` | Owner đảo confirmed, `{reason}`, key, If-Match settlement.version; giữ lịch sử confirm |
| GET | `/api/v1/trips/:tripId/settlements` | `status`, `limit` tối đa 50, `cursor` |
| GET | `/api/v1/trips/:tripId/activity` | Lịch sử chuyến, DTO giới hạn trường, `limit` tối đa 50, `cursor` |
| GET | `/api/v1/trips/:tripId/itinerary` | Thành viên đang có quyền truy cập xem hoạt động và đề xuất |
| POST | `/api/v1/trips/:tripId/itinerary` | Chủ chuyến quản lý hoạt động/đề xuất, thành viên có thể đề xuất. Cần key và If-Match của lịch trình |
| POST | `/api/v1/support-tickets` | Gửi loại lỗi, mô tả và tripId tùy chọn, có key. Tối đa 5 lượt/ngày theo giờ Việt Nam |
| GET | `/api/v1/support-tickets` | Danh sách báo lỗi của người gửi, tối đa 25 mỗi trang |
| GET | `/api/v1/support-tickets/:id` | Chi tiết báo lỗi dành cho tài khoản đã gửi |
| GET | `/api/v1/operations/:key` | Tra kết quả theo Idempotency-Key. Cần quyền chuyến hiện tại hoặc là người gửi báo lỗi |

Lịch trình mới bắt đầu ở version 1 và lưu tối đa 100 hoạt động, 100 đề xuất mỗi chuyến. Lên lịch đề xuất ghi cả hoạt động và trạng thái đề xuất trong cùng transaction. Xóa hoạt động gắn với đề xuất đưa đề xuất về chờ duyệt. Ghi lịch trình cập nhật revision và lịch sử chuyến, giữ nguyên số dư và ledgerVersion.

Báo lỗi lưu riêng dưới `supportTickets`. Nếu kèm chuyến, API kiểm quyền tại thời điểm gửi. Người gửi vẫn có thể tra báo lỗi cũ sau khi quyền chuyến thay đổi. Cùng Idempotency-Key và nội dung trả cùng mã báo lỗi, kể cả khi đã hết lượt trong ngày.

Các danh sách phân trang trả `data.items` và `data.nextCursor`; dùng lại cursor với cùng người dùng, chuyến và bộ lọc. `GET members` trả `data.participants` và `data.memberships`, có giới hạn 50 mỗi loại. Khi `revision` của chuyến đổi, API trả `409 CURSOR_STALE` và client tải lại trang đầu. Trang trips có thể rỗng nhưng vẫn có `nextCursor` nếu các tripRefs trong trang không còn quyền hoặc không khớp trạng thái. `404 OPERATION_UNKNOWN` chưa chứng minh lệnh cũ thất bại; retry cùng key và body trước khi tạo key khác. Cursor dùng khóa ký riêng `CURSOR_SIGNING_SECRET` ít nhất 32 ký tự ngoài Emulator; Emulator dùng khóa development cố định. Chưa kiểm composite query trên Firestore cloud; việc đó thuộc S18.

Create invite trả `data.token` với `tokenAvailable=true` chỉ ở lần commit mới. Retry giữ HTTP 201 và trả snapshot an toàn có `tokenAvailable=false`, `message` hướng dẫn thu hồi/tạo mới nếu mất token; operation lookup chỉ trả ID, không khôi phục token. Token gửi trong body của preview/accept, không đưa vào URL API. Lời mời lưu hash SHA-256 ở lookup, không lưu raw token. Accept mới tăng invite.version/usedCount; tải lại list để lấy version trước revoke. Active join lại với key mới trả `status=already-member` không tốn lượt, kể cả khi đã hết lượt; lời mời vẫn phải chưa hết hạn/revoke/khác epoch và trip còn writable. Removed không tự join lại; owner restore giữ joinedAt/count và liên kết đã kiểm ba chiều. Remove giữ sổ tiền/danh tính, chặn đọc/ghi và replay của người bị gỡ dù JWT còn hạn.

PATCH expense nhận `title`, `note`, `occurredOn`, `category`, `receiptIds` riêng; nếu gửi một trong `amountMinor`, `payerParticipantId`, `splitMethod`, `split` thì phải gửi đủ cả bốn. Block mới cần tất cả người active; metadata vẫn sửa được khi người cũ inactive. Metadata, category và block tiền giữ nguyên nghĩa vụ không tăng ledgerVersion. Đổi category chuyển category totals; đổi amount/payer/shares gộp delta mới–cũ, không sửa settlement lịch sử. `receiptIds` tối đa ba ID không trùng: giữ attached của chính expense hoặc thêm ready cùng chuyến do actor upload. Bỏ ảnh chuyển discarded trong cùng transaction, grace 7 ngày; expense void vẫn giữ ảnh attached. PATCH expense và cancel/void settlement yêu cầu document v1 hợp lệ; dữ liệu legacy chưa hoàn thiện cần migration trước (409 `EXPENSE_INVARIANT_FAILED`/`SETTLEMENT_INVARIANT_FAILED`), các đường đọc legacy vẫn giữ.

S10 cần `FIREBASE_STORAGE_BUCKET` server-side, Storage Rules deny client và CORS allowlist trong `be/`. Test nghiệp vụ dùng adapter memory và xử lý ảnh thật; test Rules dùng Storage Emulator. API không tự phát policy giả trên Emulator; ký V4 và smoke IAM/CORS/expiry cần credentials/bucket thật. Xem [luồng upload, retry và cleanup](../docs/RECEIPTS.md). Cleanup mặc định dry-run: `pnpm --dir be receipts:cleanup --project demo-sharebill --trip <trip-uuid>`; apply/resume và cổng cloud được mô tả tại đó.

Archive tăng inviteEpoch và trip.version, giữ ledgerVersion, chỉ thành công khi từng người net=0 và không có pending. `TRIP_NOT_BALANCED`/`PENDING_SETTLEMENTS` hướng dẫn quyết toán hoặc hủy đề nghị trước; `PROJECTION_INVARIANT_FAILED` chặn khi số dư thiếu/sai. Archived vẫn đọc được nhưng chặn ghi mới, trừ remove membership/revoke invite để thu hồi quyền. Reopen đặt archivedAt=null, giữ inviteEpoch mới; lịch sử archive giữ trong audit, link mời cũ tiếp tục vô hiệu. Replay cùng key trả snapshot gốc kể cả entity đã sửa/chuyến đã chuyển trạng thái tiếp, sau khi kiểm quyền xem hiện tại.

Header của lệnh ghi:

```http
Authorization: Bearer <Firebase ID token>
Idempotency-Key: <UUID v4>
Content-Type: application/json
```

Payload khoản chi chia đều:

```json
{
  "title": "Khách sạn",
  "amountMinor": 900000,
  "payerParticipantId": "<participant id>",
  "splitMethod": "equal",
  "split": { "participantIds": ["<participant 1>", "<participant 2>"] },
  "occurredOn": "2026-12-20",
  "category": "stay",
  "note": null
}
```

Các lệnh ghi nghiệp vụ kiểm tra quyền trong Firestore transaction và lưu kết quả cùng dữ liệu. Khi retry, gửi lại cùng `Idempotency-Key`, endpoint, body và `If-Match` nếu lệnh yêu cầu version. API kiểm tra quyền xem chuyến hiện tại rồi trả kết quả gốc kèm `Idempotency-Replayed: true`; create invite có ngoại lệ token một lần như trên. Key đã dùng cho lệnh khác trả `409 IDEMPOTENCY_KEY_REUSED`. Tiền lưu số nguyên VND. Firestore Rules hiện deny toàn bộ client direct reads/writes; API server dùng Admin SDK và tự kiểm quyền.

## Kiểm tra

Tạo một bộ dữ liệu mẫu khi Auth/Firestore Emulator đang chạy:

```powershell
pnpm --dir be db:seed
```

Script chỉ chấp nhận `demo-sharebill` và cả hai emulator trên `127.0.0.1`. Nó đi qua API để tạo An/Bình/Chi, hai khoản chi tổng 1.200.000đ và một đề nghị trả nợ pending; kiểm category totals stay 900.000đ, food 300.000đ và số dư 500.000đ/-100.000đ/-400.000đ. Mỗi lần chạy thêm bộ dữ liệu mới; không reset dữ liệu cũ. Email được in trong summary, mật khẩu emulator công khai `LocalDemo-123!`; không in JWT/refresh token. Xem [schema và seed kỳ vọng](../docs/DATABASE.md#12-seed-và-kịch-bản-kiểm-thử).

```powershell
pnpm check:be
pnpm test:be
pnpm --dir be build
```

Unit/HTTP tests kiểm chia tiền, thay/đảo contribution, ràng buộc số dư, schemas, cursor, HTTP, Swagger và xử lý ảnh/Storage adapter. Emulator suite kiểm Auth, dữ liệu/migration, paging, quản lý chuyến/danh tính, invite/membership, vòng đời tiền/chốt chuyến, receipt state machine, Storage Rules, hỗ trợ và quản trị. Đã đạt 29 unit/HTTP tests và 54 Emulator tests; cloud/thiết bị và vận hành production còn theo kế hoạch các lát sau.

Test emulator tạo tài khoản giả, đi qua API tạo chuyến/người/khoản chi, retry cùng key và kiểm số dư. Khi hai emulator đang chạy, dùng:

```powershell
$env:FIREBASE_PROJECT_ID='demo-sharebill'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_STORAGE_EMULATOR_HOST='127.0.0.1:9199'
$env:FIREBASE_STORAGE_BUCKET='demo-sharebill.appspot.com'
pnpm --dir be test:emulator
```

GitHub Actions có workflow `ShareBill CI` để chạy kiểm tra TypeScript, unit tests, build, toàn bộ Emulator suite và 6 hành trình Chromium trên bản static production, gồm tải lại app khi mất mạng. Các danh sách phân trang dùng cursor. Xem [tiến độ và cổng nghiệm thu](../docs/KE_HOACH_HOAN_THIEN.md) trước phát hành.

## Quản trị

Frontend có `/admin/`, API riêng `/api/admin/v1`. Bật Google provider và authorized domains trên Firebase project đã chọn; cấu hình biến `NEXT_PUBLIC_FIREBASE_*` theo [FE](../fe/.env.example) trước build. Trang quản trị giữ phiên Google trong bộ nhớ và yêu cầu đăng nhập lại sau reload. API kiểm Google provider, email verified, hồ sơ người dùng active và grant `platformAdmins/{uid}` trong transaction. Các lệnh thay đổi yêu cầu xác thực gần nhất trong 10 phút, lý do, version và idempotency key; ghi audit cùng transaction. Chủ chuyến cần grant riêng để sử dụng quản trị.

Người vận hành đăng nhập Google lần đầu để tạo Auth UID. Dùng CLI với credential đúng project để cấp hoặc thu hồi quyền. `--operator` là danh tính người thực hiện, được ghi vào audit. Mặc định chỉ kiểm tra và in dry-run; `--apply` mới ghi thay đổi.

```powershell
pnpm --dir be admin:grant --project demo-sharebill --uid '<google-uid>' --operator '<operator-id>'
pnpm --dir be admin:grant --project demo-sharebill --uid '<google-uid>' --operator '<operator-id>' --apply
pnpm --dir be admin:grant --project demo-sharebill --uid '<google-uid>' --operator '<operator-id>' --apply --revoke
pnpm --dir be admin:auth-worker --project demo-sharebill --limit 25
```

Đặt biến môi trường emulator như phần kiểm thử khi dùng `demo-sharebill`. Với staging/production, thay project ID, bỏ biến emulator và dùng credential của môi trường đó. CLI từ chối project khác `FIREBASE_PROJECT_ID` và project demo thiếu Firestore Emulator. Không đưa service account vào frontend.

Khóa/mở tài khoản tạo job và trả HTTP 202. App khóa quyền ngay khi yêu cầu khóa, chỉ mở lại sau khi Firebase Auth đã được đồng bộ. Worker chạy một lượt hữu hạn rồi thoát, mặc định xử lý tối đa 25 job và quét 25 hồ sơ mỗi lượt, `--limit` cho phép 1–100. Có lease 120 giây theo UID, tối đa 5 lần thử, backoff tối đa 60 giây, kiểm lại desired state/version sau lời gọi Auth. Sweep dùng checkpoint để đối soát dần và đưa sai lệch Auth vào hàng đợi; job mới từ sweep được xử lý ở lượt tiếp theo.

Cần cấu hình scheduler chạy worker định kỳ trên môi trường triển khai, có thể bắt đầu mỗi phút, và theo dõi exit code, job failed, lease hết hạn và độ trễ hàng đợi. Worker chưa được lên lịch trong môi trường local của đợt triển khai này. Job đạt giới hạn thử vẫn giữ trạng thái failed để operator xem và gửi lại lệnh từ giao diện khi đã xử lý nguyên nhân. Tạm khóa chuyến chỉ đổi trạng thái quản trị và revision, giữ ledger/version nghiệp vụ. API quản trị không trả nội dung khoản chi hoặc URL ảnh hóa đơn. Ghi chú nội bộ ticket chỉ hiện trong quản trị.

## Deploy

Đối soát theo từng lượt: `pnpm --dir be db:reconcile --project demo-sharebill --limit 5`. Worker chỉ ghi tiến độ và summary vào maintenanceJobs, không sửa ledger/số dư. Có lease, retry tối đa 3 lần và chu kỳ mới sau 15 phút; kết quả hiện trong trang Hệ thống của admin. Xem [runbook đối soát](../docs/LEDGER_RECONCILIATION.md); lịch cloud chưa được cấu hình.

Log HTTP sử dụng mã request UUID, route template, status, thời gian xử lý và SHA. Response trả `X-Request-Id` để đối chiếu log. Xem [cách tra lỗi và phạm vi S19](../docs/OPERATIONS_LOGGING.md).

Fastify có [hướng dẫn deploy trên Vercel](https://vercel.com/docs/frameworks/backend/fastify). Khi cấu hình Vercel, chọn Root Directory `be`, tách project backend và frontend, đặt origin thật vào `APP_ORIGIN`, và dùng Firebase project/credential riêng cho staging và production. Staging đã có bằng chứng FE/API, Auth, luồng tiền và index cloud; xem [thiết lập staging](../docs/CICD_DEPLOY.md), [cấu hình ảnh](../docs/RECEIPTS.md) và các cổng smoke S18 còn mở.
