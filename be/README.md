# ShareBill backend

Backend Node.js/Fastify + TypeScript, dùng Firebase Authentication và Cloud Firestore. Đây là **lát cắt backend đầu tiên**: tạo chuyến, thêm người tham gia, tạo khoản chi chia đều/chia số tiền riêng và xem tổng quan số dư. Chưa có API sửa/hủy khoản chi, mời thành viên, trả nợ, upload hóa đơn hay quản trị app. Đặc tả đầy đủ nằm trong [BACKEND.md](../docs/BACKEND.md).

## Yêu cầu máy

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

Backend đọc `be/.env` khi chạy từ thư mục `be`. Đừng commit file này. Trên production, cấu hình `FIREBASE_PROJECT_ID`, `APP_ORIGIN` và server credentials ở host secret store; tuyệt đối không đặt private key trong `fe/` hay biến `NEXT_PUBLIC_*`.

## API đã làm

| Method | Path | Yêu cầu |
| --- | --- | --- |
| GET | `/health` | Public |
| POST | `/api/v1/trips` | Firebase ID token, Idempotency-Key, body `{name, ownerName}` |
| GET | `/api/v1/trips/:tripId/overview` | ID token, membership active |
| POST | `/api/v1/trips/:tripId/participants` | ID token, owner, Idempotency-Key, body `{displayName}` |
| POST | `/api/v1/trips/:tripId/expenses` | ID token, member, Idempotency-Key, split equal/exact |

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

```powershell
pnpm check:be
pnpm test:be
pnpm --dir be build
```

Unit tests hiện có kiểm hàm chia tiền, delta số dư và health endpoint. Integration test emulator kiểm luồng đầu tiên, nhưng chưa bao phủ đầy đủ quyền, concurrency và tình huống lỗi; chưa coi API nghiệp vụ đã nghiệm thu cho production.

Test emulator tạo tài khoản giả, đi qua API tạo chuyến/người/khoản chi, retry cùng key và kiểm số dư. Khi hai emulator đang chạy, dùng:

```powershell
$env:FIREBASE_PROJECT_ID='demo-sharebill'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
pnpm --dir be test:emulator
```

GitHub Actions có workflow `Backend CI` để chạy kiểm tra TypeScript, unit tests, build và emulator integration. Các luồng sửa/hủy, trả nợ và upload vẫn chưa code; chưa xem đây là backend hoàn chỉnh để chạy production.

## Deploy

Fastify có [hướng dẫn deploy trên Vercel](https://vercel.com/docs/frameworks/backend/fastify). Khi cấu hình Vercel, chọn Root Directory `be`, tách project backend và frontend, đặt origin thật vào `APP_ORIGIN`, và dùng Firebase project/credential riêng cho staging và production. Chưa có deployment hay Firebase cloud project được tạo.
