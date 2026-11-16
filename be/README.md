# ShareBill backend

Backend Node.js/Fastify + TypeScript, dùng Firebase Authentication và Cloud Firestore. Đã có đăng ký/đăng nhập email và mật khẩu, làm mới phiên bằng Firebase ID token (JWT), tạo chuyến, thêm người tham gia, tạo/hủy khoản chi chia đều/chia số tiền riêng, xem tổng quan và gợi ý trả nợ, tạo và xác nhận trả nợ. Chưa có API sửa khoản chi, mời thành viên, hủy lượt trả nợ, upload hóa đơn hay quản trị app. Đặc tả đầy đủ nằm trong [BACKEND.md](../docs/BACKEND.md).

## Yêu cầu máy

Thiết kế lưu trữ và backlog hoàn thiện ở [DATABASE.md](../docs/DATABASE.md). Index P0 đã có trong `firestore.indexes.json` và được nối với `firebase.json`; cần deploy và smoke query trên staging trước release. File index bao gồm cả query của chức năng chưa được code.

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

Backend đọc `be/.env` khi chạy từ thư mục `be`. Đừng commit file này. Trên production, cấu hình `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY` (Web API key của cùng Firebase project), `APP_ORIGIN` và server credentials ở host secret store. Bật phương thức **Email/Password** trong Firebase Authentication trước khi dùng tài khoản thật. Tuyệt đối không đặt private key trong `fe/` hay biến `NEXT_PUBLIC_*`.

## Đăng ký, đăng nhập và JWT

| Method | Path | Body | Kết quả |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/register` | `{ "email", "password", "displayName" }` | 201; tạo Firebase Auth user và hồ sơ Firestore |
| POST | `/api/v1/auth/login` | `{ "email", "password" }` | 200; lấy phiên hiện tại |
| POST | `/api/v1/auth/refresh` | `{ "refreshToken" }` | 200; lấy ID token mới |

Mật khẩu cần 8–128 ký tự; tên hiển thị 1–80 ký tự. Cả ba API trả `Cache-Control: no-store` và `data` gồm `tokenType`, `accessToken`, `refreshToken`, `expiresIn` (giây), `user` (`uid`, `email`, `displayName`). `accessToken` là **Firebase ID token dạng JWT**, gửi trong header `Authorization: Bearer <accessToken>` cho các API chuyến đi. API kiểm chữ ký, project, hạn token, revoke và trạng thái tài khoản. Refresh token là bí mật dài hạn; không ghi log, không gắn vào URL. Với React web, nên dùng Firebase Web SDK để quản lý phiên và tự làm mới token; ba endpoint này hữu ích cho client dùng REST. Đăng xuất một thiết bị là xóa phiên phía client; chức năng thu hồi mọi phiên chưa được triển khai.

Ví dụ PowerShell sau khi emulator và API đã chạy:

```powershell
$session = Invoke-RestMethod -Method Post -Uri http://localhost:3001/api/v1/auth/register -ContentType 'application/json' -Body '{"email":"an@example.test","password":"ExamplePass123!","displayName":"An"}'
$token = $session.data.accessToken
Invoke-RestMethod -Uri http://localhost:3001/api/v1/trips -Headers @{ Authorization = "Bearer $token" }
```

Đăng ký có thể tạo tài khoản Auth thành công trước khi ghi hồ sơ Firestore. Nếu Firestore tạm lỗi, đăng nhập lại sẽ hoàn tất hồ sơ; không tạo tài khoản thứ hai. Trên production cần đặt rate limit tại ingress cho các endpoint đăng ký/đăng nhập/làm mới phiên.

## API đã làm

| Method | Path | Yêu cầu |
| --- | --- | --- |
| GET | `/health` | Public |
| POST | `/api/v1/auth/register` | Public; email, password, displayName |
| POST | `/api/v1/auth/login` | Public; email, password |
| POST | `/api/v1/auth/refresh` | Public; refreshToken |
| POST | `/api/v1/trips` | Firebase ID token, Idempotency-Key, body `{name, ownerName}` |
| GET | `/api/v1/trips` | Danh sách tối đa 20 chuyến gần đây của tài khoản |
| GET | `/api/v1/trips/:tripId/overview` | ID token, membership active |
| POST | `/api/v1/trips/:tripId/participants` | ID token, owner, Idempotency-Key, body `{displayName}` |
| POST | `/api/v1/trips/:tripId/expenses` | ID token, member, Idempotency-Key, split equal/exact |
| GET | `/api/v1/trips/:tripId/expenses` | 30 khoản chi gần nhất |
| GET | `/api/v1/trips/:tripId/expenses/:id` | Chi tiết khoản chi |
| POST | `/api/v1/trips/:tripId/expenses/:id/void` | Chủ nhóm/người tạo, If-Match, lý do |
| GET | `/api/v1/trips/:tripId/settlement-suggestions` | Gợi ý từ số dư hiện tại |
| POST | `/api/v1/trips/:tripId/settlements` | Tạo đề nghị trả nợ, Idempotency-Key |
| POST | `/api/v1/trips/:tripId/settlements/:id/confirm` | Người nhận/chủ nhóm xác nhận, If-Match |
| GET | `/api/v1/trips/:tripId/settlements` | 30 lượt trả nợ gần nhất |

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

Mọi lệnh ghi được kiểm tra quyền trong Firestore transaction, ghi operation key cùng dữ liệu để retry không tạo trùng. Tiền lưu số nguyên VND. Firestore Rules hiện deny toàn bộ client direct reads/writes; API server dùng Admin SDK và tự kiểm quyền.

## Kiểm tra

Tạo một bộ dữ liệu mẫu khi Auth/Firestore Emulator đang chạy:

```powershell
pnpm --dir be db:seed
```

Script chỉ chấp nhận `demo-sharebill` và cả hai emulator trên `127.0.0.1`. Nó đi qua API để tạo An/Bình/Chi, hai khoản chi tổng 1.200.000đ và một đề nghị trả nợ pending; kiểm số dư 500.000đ/-100.000đ/-400.000đ. Mỗi lần chạy thêm bộ dữ liệu mới; không reset dữ liệu cũ. Email được in trong summary, mật khẩu emulator công khai `LocalDemo-123!`; không in JWT/refresh token. Xem [schema và seed kỳ vọng](../docs/DATABASE.md#12-seed-và-kịch-bản-kiểm-thử).

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
