# ShareBill backend

Backend Node.js/Fastify + TypeScript, dùng Firebase Authentication và Cloud Firestore. Đã có đăng ký/đăng nhập email và mật khẩu, làm mới phiên bằng Firebase ID token (JWT), tạo chuyến, thêm người tham gia, tạo/hủy khoản chi chia đều/chia số tiền riêng, xem tổng quan và gợi ý trả nợ, tạo và xác nhận trả nợ. Chưa có API sửa khoản chi, mời thành viên, hủy lượt trả nợ, upload hóa đơn hay quản trị app. Đặc tả đầy đủ nằm trong [BACKEND.md](../docs/BACKEND.md).

## Yêu cầu máy

Thiết kế lưu trữ và backlog hoàn thiện ở [DATABASE.md](../docs/DATABASE.md). Index P0 đã có trong `firestore.indexes.json` và được nối với `firebase.json`; cần deploy và smoke query trên staging trước release. File index bao gồm cả query của chức năng chưa được code.

Kế hoạch có [20 lát cắt triển khai](../docs/slices/README.md). S01–S06 đã hoàn tất trên local/Emulator. Backend tiếp tục với [S07 — Chỉnh thông tin chuyến và người tham gia](../docs/slices/02_NGHIEP_VU_BE.md#s07).

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

Khi cả Emulator và API đã chạy, mở **http://localhost:3001/docs/**. Trang này mô tả 20 endpoint hiện có; đặc tả JSON ở `http://localhost:3001/docs/json`.

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
| POST | `/api/v1/trips/:tripId/participants` | ID token, owner, Idempotency-Key, body `{displayName}` |
| POST | `/api/v1/trips/:tripId/expenses` | ID token, member, Idempotency-Key, split equal/exact |
| GET | `/api/v1/trips/:tripId/expenses` | `status`, `from`/`to`, một trong `category`/`payer`, `limit` tối đa 50, `cursor` |
| GET | `/api/v1/trips/:tripId/expenses/:id` | Chi tiết khoản chi |
| POST | `/api/v1/trips/:tripId/expenses/:id/void` | Chủ nhóm/người tạo, If-Match, lý do |
| GET | `/api/v1/trips/:tripId/settlement-suggestions` | Gợi ý từ số dư hiện tại |
| POST | `/api/v1/trips/:tripId/settlements` | Tạo đề nghị trả nợ, Idempotency-Key |
| POST | `/api/v1/trips/:tripId/settlements/:id/confirm` | Người nhận/chủ nhóm xác nhận, If-Match |
| GET | `/api/v1/trips/:tripId/settlements` | `status`, `limit` tối đa 50, `cursor` |
| GET | `/api/v1/trips/:tripId/activity` | Lịch sử chuyến, DTO giới hạn trường, `limit` tối đa 50, `cursor` |
| GET | `/api/v1/operations/:key` | Tra kết quả tối thiểu theo Idempotency-Key, cần quyền chuyến hiện tại |

Các danh sách trả `data.items` và `data.nextCursor`; dùng lại cursor với cùng người dùng, chuyến và bộ lọc. Khi `revision` của chuyến đổi, API trả `409 CURSOR_STALE` và client tải lại trang đầu. Trang trips có thể rỗng nhưng vẫn có `nextCursor` nếu các tripRefs trong trang không còn quyền hoặc không khớp trạng thái. `404 OPERATION_UNKNOWN` chưa chứng minh lệnh cũ thất bại; retry cùng key và body trước khi tạo key khác. Cursor dùng khóa ký riêng `CURSOR_SIGNING_SECRET` ít nhất 32 ký tự ngoài Emulator; Emulator dùng khóa development cố định. Chưa kiểm composite query trên Firestore cloud; việc đó thuộc S18.

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

Sáu lệnh ghi nghiệp vụ kiểm tra quyền trong Firestore transaction và lưu kết quả cùng dữ liệu. Khi retry, gửi lại cùng `Idempotency-Key`, endpoint, body và `If-Match` nếu lệnh yêu cầu version. API kiểm tra quyền xem chuyến hiện tại rồi trả kết quả gốc kèm `Idempotency-Replayed: true`. Key đã dùng cho lệnh khác trả `409 IDEMPOTENCY_KEY_REUSED`. Tiền lưu số nguyên VND. Firestore Rules hiện deny toàn bộ client direct reads/writes; API server dùng Admin SDK và tự kiểm quyền.

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

Unit tests hiện có kiểm hàm chia tiền, delta số dư và health endpoint. Integration test emulator kiểm đăng ký/đăng nhập/JWT/refresh, tài khoản bị khóa và luồng nghiệp vụ đầu tiên, nhưng chưa bao phủ đầy đủ quyền, concurrency và tình huống lỗi; chưa coi API nghiệp vụ đã nghiệm thu cho production.

Test emulator tạo tài khoản giả, đi qua API tạo chuyến/người/khoản chi, retry cùng key và kiểm số dư. Khi hai emulator đang chạy, dùng:

```powershell
$env:FIREBASE_PROJECT_ID='demo-sharebill'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
pnpm --dir be test:emulator
```

GitHub Actions có workflow `Backend CI` để chạy kiểm tra TypeScript, unit tests, build và emulator integration. List endpoints hiện giới hạn 20/30 bản gần nhất và chưa có cursor; cần bổ sung pagination trước khi dùng cho chuyến nhiều dữ liệu. Các luồng sửa khoản chi, hủy/void trả nợ, lời mời, ảnh và quản trị vẫn chưa code; chưa xem đây là backend hoàn chỉnh để chạy production.

## Deploy

Fastify có [hướng dẫn deploy trên Vercel](https://vercel.com/docs/frameworks/backend/fastify). Khi cấu hình Vercel, chọn Root Directory `be`, tách project backend và frontend, đặt origin thật vào `APP_ORIGIN`, và dùng Firebase project/credential riêng cho staging và production. Chưa có deployment hay Firebase cloud project được tạo.
