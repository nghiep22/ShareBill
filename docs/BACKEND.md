# ShareBill — Đặc tả Backend

**Bổ sung 20/11/2026:** [QR nhận tiền và ảnh chuyển khoản](PAYMENTS.md) mô tả API QR, đính kèm bằng chứng giao dịch và quyền xác nhận của người nhận.

Phiên bản 1.0 · 16/11/2026 · Phương án chính: Next.js API trên Vercel + Firebase.

**Cập nhật implementation:** theo yêu cầu tách `fe/` và `be/`, backend thực tế dùng Fastify/Node.js trong `be/` và có thể deploy Vercel như một project riêng. Những đường `src/app/api/...` và đoạn nói Route Handlers bên dưới là thiết kế ban đầu; hợp đồng `/api/v1` và quy tắc tiền/quyền vẫn áp dụng. Xem [BE hiện có](../be/README.md) để biết endpoints đã code.

**Cập nhật auth:** P0 hiện dùng email/password. `POST /api/v1/auth/register`, `/login`, `/refresh` trả Firebase ID token dạng JWT và refresh token; các API protected dùng `verifyIdToken(token, true)`. Web API key chọn Firebase project, không phải bằng chứng xác thực. Quản trị đã triển khai Google sign-in, grant server-only, recent auth, audit và worker đồng bộ Firebase Auth. Xem [hướng dẫn quản trị](../be/README.md#quản-trị). OpenAPI hiện có 67 thao tác; kết quả local/Emulator và phần còn nghiệm thu nằm trong [kế hoạch module](KE_HOACH_HOAN_THIEN.md).

`POST /api/v1/me/bootstrap` nhận Bearer ID token và body trống, lấy danh tính từ Firebase Auth để chỉ tạo hồ sơ v1 khi chưa có. `GET /api/v1/me` chỉ đọc hồ sơ, trả 404 nếu chưa bootstrap. Register/login/refresh và tạo chuyến dùng chung logic bootstrap. Việc bổ sung trường v1 vào hồ sơ legacy thuộc [S05](slices/01_DATABASE_BE.md#s05). Xem [API đang chạy](../be/README.md).

**Thiết kế CSDL hợp nhất:** [DATABASE.md](DATABASE.md) bổ sung từ điển dữ liệu cho cả app/admin/jobs, schemaVersion, owner link, receipt cleanup fields, index thực thi, migration và cổng nghiệm thu. Đây là hợp đồng lưu trữ đích; trạng thái code hiện tại được ghi riêng, không coi collection đã hoàn thiện chỉ vì có schema mẫu. Các mục bên dưới tiếp tục giải thích thuật toán và API.

Các quy tắc trong [Product](PRODUCT_PLAN.md) là chuẩn nghiệp vụ. Các schema, endpoint và mã lỗi dưới đây là hợp đồng để FE/BE cùng triển khai. Code mẫu minh họa cấu trúc, chưa thay thế implementation và test.

Tra nhanh: [Dữ liệu](#3-mô-hình-firestore) · [API](#4-api-conventions) · [Tính tiền](#5-thuật-toán-tiền) · [Transaction/retry](#6-transaction-concurrency-và-idempotency) · [Phân quyền](#7-auth-authorization-và-rules) · [Ảnh hóa đơn](#8-ảnh-hóa-đơn-private-upload-và-lifecycle) · [SQLite](#12-phương-án-thay-thế-sqlite-có-backend-riêng).

## 1. Trách nhiệm và ranh giới

Backend chịu trách nhiệm xác thực, phân quyền theo chuyến, chuẩn hóa tiền, chia tiền, kiểm tra bất biến, ghi sổ nguyên tử, chống ghi trùng, kiểm soát ảnh và audit. Không tin số dư, vai trò, actor hoặc kết quả chia do FE tự gửi.

### 1.1. Stack

- Next.js Route Handlers, runtime Node.js; không Edge cho module Firebase Admin/image processing.
- TypeScript strict, Zod cho input và DTO; hàm tiền thuần dùng chung FE/BE.
- Firebase Admin SDK cho Auth/Firestore/Storage ở server.
- Cloud Firestore Standard edition cho dữ liệu, default database để đơn giản hóa môi trường và tooling.
- Firebase Auth Email/Password provider P0; Google OAuth tùy chọn P1.
- Cloud Storage for Firebase cho staging ảnh và ảnh đã chuẩn hóa.
- `sharp` hoặc thư viện xử lý ảnh server tương đương đã kiểm tra tương thích runtime.
- Emulator Suite cho auth/data/rules tests; Vitest, property-based tests cho domain.
- Không thêm NestJS riêng trong phương án chính; vẫn tách service/repository để API không chứa toàn bộ business logic.

### 1.2. Phân lớp

```text
src/server/
  auth/{verify-token,require-membership,permissions}.ts
  config/{env,firebase-admin}.ts
  http/{error,response,request-context,rate-limit}.ts
  modules/
    trips/{schemas,service,repository,dto}.ts
    participants/{schemas,service,repository,dto}.ts
    expenses/{schemas,service,repository,dto}.ts
    balances/{service,repository}.ts
    settlements/{schemas,service,repository,dto}.ts
    invites/{schemas,service,repository}.ts
    receipts/{schemas,service,storage-adapter}.ts
    audit/{service,dto}.ts
    operations/{service,repository}.ts
  jobs/{cleanup-receipts,reconcile-balances}.ts
src/shared/
  contracts/
  domain/{money,split,balance,suggest}.ts
src/app/api/v1/.../route.ts
```

Route: parse HTTP → auth → validate → service → map DTO/error. Service quyết định quyền và transaction. Repository chỉ đọc/ghi dữ liệu. Domain chỉ tính toán, không có IO. Mọi module server dùng `server-only`.

## 2. Quy ước dữ liệu

| Loại | Quy ước |
| --- | --- |
| ID nội bộ | UUID/Firestore auto-ID ASCII do server cấp; không chứa tên người |
| Auth user | Firebase `uid` |
| Tiền | Số nguyên minor unit, VND exponent 0, tối đa 10^12/khoản |
| Trung gian phép nhân/chia | `bigint`, kiểm tra bounds trước khi chuyển number |
| Timestamp DB | Firestore Timestamp server; ISO UTC khi serialize API |
| Ngày chi/ngày chuyến | `YYYY-MM-DD`, kiểm tra ngày lịch thật |
| Timezone | IANA, mặc định `Asia/Ho_Chi_Minh` |
| Nội dung | Trim, plain text, max length theo schema |
| Enum | Giá trị ASCII cố định, không lưu nhãn tiếng Việt |
| Version | Số nguyên tăng từ 1, client gửi qua If-Match |
| Tiền tệ P0 | Chỉ `VND`; không nhận currency khác trong payload |

Các trường `createdBy`, `updatedBy`, `ownerUid`, timestamps, versions, computed shares/balances không cho client tự gán. PATCH chỉ nhận allowlist; từ chối field lạ để tránh mass assignment.

### 2.1. Ba loại phiên bản

- `version` trên entity: chống ghi đè entity khi sửa. `trip.version` tăng khi đổi metadata/status/owner, không tăng chỉ vì có expense mới.
- `revision` trên trip: tăng với mọi thay đổi nghiệp vụ nhìn thấy trong chuyến, dùng realtime invalidation và cursor nhất quán.
- `ledgerVersion` trên trip: tăng khi ảnh hưởng tiền thay đổi: tạo/sửa phần tiền/hủy expense, confirm/void settlement. Không tăng do upload intent, sửa note, pending settlement hoặc đổi tên.

Commit nghiệp vụ có thay đổi `revision` phải cập nhật `signals/current` trong cùng transaction. Upload staging/processing tạm chưa gắn vào expense không cần làm nhiễu signal toàn nhóm.

## 3. Mô hình Firestore

```text
users/{uid}
  tripRefs/{tripId}
  operations/{idempotencyKey}
trips/{tripId}
  memberships/{uid}
  participantLinks/{uid}
  participants/{participantId}
  expenses/{expenseId}
  settlements/{settlementId}
  balances/{participantId}
  receipts/{receiptId}
  invites/{inviteId}
  auditEvents/{eventId}
  signals/current
inviteTokens/{sha256Token}
rateLimits/{hashedScopeAndWindow}
maintenanceJobs/{jobId}
```

`users.tripRefs` là chỉ mục danh sách chuyến của tài khoản, không phải nguồn cấp quyền. `memberships` mới là nguồn quyền. `balances` và stats là projection có thể tính lại từ expense/settlement; ledger nguồn là các bản ghi active/confirmed có audit.

### 3.1. User và chỉ mục chuyến

```ts
type UserDoc = {
  displayName: string;       // 1..80, không dùng làm khóa
  email: string | null;     // Lấy từ token/Auth, không tin body
  emailLower: string | null;
  status: 'active' | 'disabled';
  moderationVersion: number;
  desiredAuthDisabled: boolean;
  authSyncStatus: 'synced' | 'pending' | 'failed';
  disabledReason: string | null;
  disabledAt: Timestamp | null;
  disabledBy: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
type TripRefDoc = {
  tripId: string;
  joinedAt: Timestamp;
  status: 'active' | 'removed';
};
```

Lấy tối đa 20 tripRefs active mỗi trang, đọc root trip tương ứng để có title/status/stats hiện tại; không đồng bộ fan-out title/totals vào tất cả user refs. Truy vấn status active/archived của danh sách chuyến thực hiện sau khi lấy root; cursor theo tripRefs phải trả `nextCursor` kể cả khi trang lọc ra ít phần tử. Nếu cần danh sách lọc dày về sau, thêm index projection có cơ chế đồng bộ riêng.

### 3.2. Trip

```ts
type TripDoc = {
  name: string;              // 1..100
  destination: string | null;// <=150
  note: string | null;      // <=1000
  startDate: string | null;
  endDate: string | null;
  timezone: string;
  currency: 'VND';
  currencyExponent: 0;
  ownerUid: string;
  status: 'active' | 'archived';
  moderationStatus: 'normal' | 'suspended';
  moderationVersion: number;
  moderationReason: string | null;
  moderatedAt: Timestamp | null;
  moderatedBy: string | null;
  inviteEpoch: number;
  version: number;
  revision: number;
  ledgerVersion: number;
  participantCount: number;       // Tổng đã tạo, kể cả inactive, max 50
  membershipCountAllTime: number; // Tổng UID từng được thêm, kể cả removed, max 50
  expenseCountAllTime: number;   // Max 2000, kể cả void
  settlementCountAllTime: number;// Max 2000, kể cả cancelled/void
  activeExpenseCount: number;
  pendingSettlementCount: number;
  totalExpenseMinor: number;
  categoryTotalsMinor: Record<Category, number>;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archivedAt: Timestamp | null;
};
```

`ownerUid` luôn có một membership owner active. Không cho nhiều owner. Sửa metadata tăng trip.version/revision; nghiệp vụ tiền tăng revision/ledgerVersion và các counters cần thiết. Chuyển chủ đồng thời đổi hai memberships và root owner.

### 3.3. Membership và participant link

```ts
type MembershipDoc = {
  uid: string;
  role: 'owner' | 'member';
  status: 'active' | 'removed';
  participantId: string | null;
  version: number;
  joinedAt: Timestamp;
  updatedAt: Timestamp;
  removedAt: Timestamp | null;
};
type ParticipantLinkDoc = {
  uid: string;
  participantId: string;
  updatedAt: Timestamp;
};
```

`participantLinks/{uid}` làm khóa unique UID trong chuyến, participant có `linkedUid` làm khóa chiều ngược. Link/unlink transaction đọc membership, participant, link cũ/mới rồi kiểm tra cả hai chiều. Membership bị gỡ không tự giải phóng danh tính; owner quản lý relink có audit. Không cho nhận invite tự gán `role=owner` hoặc participantId.

### 3.4. Participant

```ts
type ParticipantDoc = {
  displayName: string;       // 1..80, tên trùng được phép
  linkedUid: string | null;
  status: 'active' | 'inactive';
  version: number;
  hasLedgerReferences: boolean;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

Không xóa participant. Inactive không vào expense mới/chỉnh phần tiền mới; vẫn vào balances và settlement. P0 cho phép participant của owner inactive về tài chính, membership owner vẫn quản lý chuyến; UI phải thể hiện hai trạng thái độc lập.

### 3.5. Expense

```ts
type Category = 'food' | 'transport' | 'stay' | 'tickets' | 'shopping' | 'other';
type Share = { participantId: string; amountMinor: number };
type ExpenseDoc = {
  title: string;             // 1..120
  amountMinor: number;
  currency: 'VND';
  payerParticipantId: string;
  splitMethod: 'equal' | 'exact'; // P1 bổ sung percentage/weighted
  shares: Share[];           // Server tính/kiểm tra, sort theo participantId
  splitInput: { participantIds: string[] } | { shares: Share[] };
  occurredOn: string;
  category: Category;
  note: string | null;       // <=1000
  receiptIds: string[];      // max 3
  status: 'active' | 'void';
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  voidedAt: Timestamp | null;
  voidedBy: string | null;
  voidReason: string | null; // 1..300 khi void
};
```

Mỗi expense chỉ có một payer. Lưu shares đã tính để lịch sử không đổi khi thêm người. `splitInput` giúp UI sửa đúng cách chia gốc; `shares` là kết quả chuẩn. Không gửi nguyên ExpenseDoc từ FE; dùng request schema riêng.

### 3.6. Settlement

```ts
type SettlementDoc = {
  fromParticipantId: string;
  toParticipantId: string;
  amountMinor: number;
  currency: 'VND';
  occurredOn: string;
  note: string | null;       // <=1000
  status: 'pending' | 'confirmed' | 'cancelled' | 'void';
  basedOnLedgerVersion: number;
  version: number;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  confirmedBy: string | null;
  confirmedAt: Timestamp | null;
  confirmationMode: 'recipient' | 'owner_on_behalf' | null;
  cancelledBy: string | null;
  cancelledAt: Timestamp | null;
  voidedBy: string | null;
  voidedAt: Timestamp | null;
  voidReason: string | null;
};
```

P0 không đính kèm ảnh settlement để giữ lifecycle ảnh đơn giản. Không UPDATE from/to/amount khi đã tạo; cancel rồi tạo bản mới. Người nhận đã linked không loại bỏ quyền owner xác nhận thay, nhưng mọi lần thay mặt luôn có nhãn/audit.

Code hiện tạo pending document v1 với các trường trạng thái chưa xảy ra bằng `null`. Confirm ghi `confirmedBy`, `confirmedAt`, `confirmationMode` và version mới; `basedOnLedgerVersion` vẫn là mốc lúc tạo. Cancel/void settlement là API còn trong backlog.

### 3.7. Balance và signal

```ts
type BalanceDoc = {
  participantId: string;
  paidMinor: number;
  owedMinor: number;
  sentMinor: number;
  receivedMinor: number;
  netMinor: number;
  updatedAt: Timestamp;
};
type SignalDoc = {
  revision: number;
  ledgerVersion: number;
  updatedAt: Timestamp;
};
```

Không cần lưu `ledgerVersion` riêng trên từng balance vì transaction chỉ cập nhật những người liên quan. Đọc overview transaction với root version làm mốc để có snapshot chung. Participant mới luôn được tạo balance zero trong cùng transaction.

### 3.8. Invite

- Sinh 32 byte ngẫu nhiên CSPRNG, encode base64url; chỉ trả raw token một lần cho owner.
- `inviteTokens/{sha256(token)}` chứa tripId, inviteId để lookup. Không dùng mã 6 chữ số dễ đoán.
- Invite chứa `createdBy, createdAt, expiresAt, maxUses, usedCount, revokedAt, version`; mặc định 7 ngày/20 lượt, tối đa tương ứng P0.
- `accept` transaction đọc token mapping, invite, trip, membership và op, kiểm tra hạn theo server, tăng usage nếu thực sự thêm thành viên mới.
- Người đã active join lại trả trạng thái already-member, không tăng lượt. Người đã removed không được tự join lại bằng link; owner phải restore membership bằng hành động riêng.
- Max50 memberships all-time/chuyến, gồm owner và removed; restore UID cũ không tăng count. Kiểm counter trong transaction accept; không để invite tạo số lượng cộng tác viên vô hạn dù participants đã giới hạn.
- Archive revoke mọi invite: để không fan-out hàng loạt, dùng `trip.inviteEpoch` tăng khi archive; invite lưu `epoch`, accept yêu cầu epoch khớp. Trip khởi tạo inviteEpoch = 1.
- Reopen không hồi sinh link cũ. Không dùng TTL làm kiểm tra hạn; luôn so expiresAt ngay lúc request.

**S08 đã triển khai trên Emulator (18/11/2026):** `POST /trips/:tripId/invites` nhận `{expiresInDays?: 1..7, maxUses?: 1..20}`; raw token chỉ có ở response commit mới, replay trả `tokenAvailable=false` và hướng dẫn thu hồi/tạo mới. `GET invites` phân trang theo createdAt/id và revision, không có token. Revoke nhận `{}` với If-Match invite.version (accept mới cũng tăng version), cho phép cả archived/suspended. Preview nhận `{token}`, chỉ trả trip `{id,name}`, inviter `{displayName}`, expiresAt; không cần key và không tăng usage. Accept nhận `{token}` cùng key, trả `{tripId,uid,status: joined|already-member,participantId,version}`; active join lại không tốn lượt kể cả exhausted, nhưng vẫn kiểm hạn/revoke/epoch/trip. Removed cần owner restore. Token không đưa vào URL API. [OpenAPI thực thi](../be/openapi.json) và [hướng dẫn thử](../be/README.md).

S08 còn có `GET /trips/:tripId/members` trả hai danh sách giới hạn 50; remove/restore nhận `{reason}` với If-Match membership.version. Remove giữ participant/link/sổ tiền, được cả archived/suspended; restore cần trip writable, user active và liên kết còn nhất quán, không tăng all-time count. Transfer-owner nhận `{uid,reason}` với If-Match trip.version, tăng version của root và hai memberships, giữ ledgerVersion. Owner cũ vẫn active có thể replay key chuyển chủ đã commit; mất membership thì replay trả 404.

### 3.9. Audit và operation

Audit có `eventId, actorUid, actorDisplayNameSnapshot, action, entityType, entityId, before, after, reason, revision, ledgerVersion, operationKey, createdAt`. Snapshot chỉ giữ trường cần đối soát; không chứa signed URL, raw token hay file bytes. Giá trị tiền trước/sau và shares phải đủ tính lại thay đổi.

Operation trong `users/{uid}/operations/{key}`:

```ts
type OperationDoc = {
  actorUid: string;
  tripId: string | null;
  method: string;
  canonicalPath: string;
  requestHash: string;       // SHA-256 canonical validated payload + If-Match
  state: 'committed';
  resourceType: string;
  resourceId: string;
  httpStatus: number;
  responseSnapshot: {       // DTO nhỏ, không receipt URL/raw invite token
    data: unknown;
    meta: { revision?: number; ledgerVersion?: number };
  };
  responseEtag: string | null;
  committedAt: Timestamp;
};
```

Operation tài chính không tự hết hạn 24h để tránh retry muộn tạo trùng. Giữ cùng vòng đời sổ chuyến; quy trình xóa dữ liệu sau này phải giữ tombstone/hash/key đủ chống replay hoặc đóng hoàn toàn namespace cũ. Không dùng TTL tự xóa idempotency khi vẫn cho phép nhận lại request cũ.

Raw invite không được lưu trong responseSnapshot. Riêng create invite: retry cùng key trả inviteId/status đã tạo và thông báo token không được trả lại; owner revoke/tạo link mới nếu mất response đầu. FE cần diễn đạt ngoại lệ này; không làm token trở thành dữ liệu đọc lại.

## 4. API conventions

Base path `/api/v1`. JSON UTF-8, UTC timestamps, cùng origin. Mọi protected route có ID token hợp lệ. Health liveness công khai không trả cấu hình hoặc trạng thái quyền.

```http
Authorization: Bearer <Firebase ID token>
Content-Type: application/json
Idempotency-Key: 8acb0b89-8898-4e71-b198-1c4868c29d39
If-Match: "3"
```

- `Idempotency-Key`: required cho mọi POST/PATCH/DELETE thay đổi dữ liệu. UUID v4, scoped theo uid; cùng key khác endpoint/body/If-Match → 409.
- `If-Match`: required khi sửa hoặc chuyển trạng thái entity đã có; thiếu → 428. So với `entity.version`, khác → 409.
- GET detail trả `ETag: "<version>"`; create/update trả DTO và ETag mới.
- Successful response `{ data, meta: { requestId, revision?, ledgerVersion? } }`. Khả năng tạm thời như raw invite token/signed upload policy/signed view URL không lưu trong responseSnapshot; ngoại lệ trả lại được mô tả riêng ở workflow tương ứng.
- List response `data: { items, nextCursor }`; cursor opaque, signed, bound với uid, tripId, filters, sort và revision.
- Error response theo schema FE; không trả stack trace hoặc phân biệt trip không tồn tại với trip không có quyền cho người ngoài.
- Default max JSON body 128KiB; note/title không cho HTML. File đi Storage, không nhận multipart file trên API route.
- Responses dữ liệu user: `Cache-Control: private, no-store`. API không nhận auth qua query.

### 4.1. Danh sách endpoints

Tất cả dòng có “ghi” đều dùng idempotency key. Cột Version chỉ rõ entity của `If-Match`.

| Method | Endpoint | Quyền / kết quả | Version |
| --- | --- | --- | --- |
| GET | `/health` | Liveness, release SHA, không ping DB mỗi lần | — |
| POST | `/me/bootstrap` | Upsert profile từ Auth | — |
| GET | `/me` | Profile hiện tại | — |
| GET | `/trips?status=&cursor=&limit=` | Chuyến của uid | — |
| POST | `/trips` | Tạo trip + owner + participant + balance + ref | — |
| GET | `/trips/:tripId` | Trip metadata + permissions | — |
| PATCH | `/trips/:tripId` | Owner sửa metadata | Trip |
| GET | `/trips/:tripId/overview` | Snapshot trip, participants, balances, stats, recent 5 | — |
| POST | `/trips/:tripId/archive` | Owner, zero balances, zero pending | Trip |
| POST | `/trips/:tripId/reopen` | Owner | Trip |
| POST | `/trips/:tripId/transfer-owner` | Owner → member active | Trip |
| GET | `/trips/:tripId/members` | Participants + membership DTO | — |
| POST | `/trips/:tripId/participants` | Owner tạo participant/balance | — |
| PATCH | `/trips/:tripId/participants/:id` | Owner đổi tên/status | Participant |
| POST | `/trips/:tripId/memberships/:uid/link` | Owner link/unlink participant | Membership |
| POST | `/trips/:tripId/memberships/:uid/remove` | Owner gỡ tài khoản, không gỡ chính owner | Membership |
| POST | `/trips/:tripId/memberships/:uid/restore` | Owner khôi phục người bị gỡ | Membership |
| GET | `/trips/:tripId/expenses?status=&category=&payer=&cursor=` | Member active, page max 50 | — |
| POST | `/trips/:tripId/expenses` | Member active, trip active | — |
| GET | `/trips/:tripId/expenses/:id` | Detail + permissions | — |
| PATCH | `/trips/:tripId/expenses/:id` | Creator/owner, chỉ expense active | Expense |
| POST | `/trips/:tripId/expenses/:id/void` | Creator/owner + reason | Expense |
| GET | `/trips/:tripId/balances` | Consistent snapshot | — |
| GET | `/trips/:tripId/settlement-suggestions` | balances + suggestions + ledgerVersion | — |
| GET | `/trips/:tripId/settlements?status=&cursor=` | Member active | — |
| POST | `/trips/:tripId/settlements` | Owner hoặc from linked với actor | — |
| GET | `/trips/:tripId/settlements/:id` | Detail + permissions | — |
| POST | `/trips/:tripId/settlements/:id/confirm` | Recipient hoặc owner thay mặt | Settlement |
| POST | `/trips/:tripId/settlements/:id/cancel` | Creator/owner, pending | Settlement |
| POST | `/trips/:tripId/settlements/:id/void` | Owner + reason, confirmed | Settlement |
| POST | `/trips/:tripId/invites` | Owner tạo link | — |
| GET | `/trips/:tripId/invites` | Owner, không raw token | — |
| POST | `/trips/:tripId/invites/:id/revoke` | Owner, được khi archived | Invite |
| POST | `/invites/preview` | Auth + token body, metadata tối thiểu | — |
| POST | `/invites/accept` | Auth + token body, join member unlinked | — |
| POST | `/trips/:tripId/receipts/upload-intents` | Member, trip active, quota ảnh | — |
| POST | `/trips/:tripId/receipts/:id/finalize` | Uploader, trip active | Receipt |
| GET | `/trips/:tripId/receipts/:id/view-url` | Member xem ảnh attached hoặc uploader xem ready | — |
| POST | `/trips/:tripId/receipts/:id/discard` | Uploader/owner, chỉ ảnh chưa attached | Receipt |
| GET | `/trips/:tripId/activity?cursor=` | Member active | — |
| GET | `/trips/:tripId/itinerary` | Membership active | Hoạt động, đề xuất, version |
| POST | `/trips/:tripId/itinerary` | Chuyến đang mở, chủ chuyến quản lý và thành viên gửi đề xuất, key + If-Match lịch trình | ID và version |
| POST | `/support-tickets` | User active, key, kiểm membership nếu kèm chuyến, 5 báo lỗi/ngày theo giờ Việt Nam | Mã và trạng thái báo lỗi |
| GET | `/support-tickets` | Người gửi, cursor, tối đa 25 | Danh sách báo lỗi của mình |
| GET | `/support-tickets/:id` | Người gửi | Báo lỗi và mô tả |
| GET | `/operations/:key` | Actor của operation, quyền chuyến hiện tại hoặc quyền sở hữu báo lỗi | — |

`/invites/preview` là POST đọc vì token không đưa vào URL; không thay đổi dữ liệu, không cần idempotency key. Profile bootstrap có key nhưng không phải transaction tiền.

Không có DELETE sổ tiền hay participant P0. Không có `/balance/update` từ client. Các route xuất CSV, đa tiền tệ và OCR chưa tồn tại trong P0.

### 4.2. Ví dụ tạo expense chia đều

```json
{
  "title": "Khách sạn",
  "amountMinor": 900000,
  "payerParticipantId": "p_A",
  "splitMethod": "equal",
  "split": { "participantIds": ["p_A", "p_B", "p_C"] },
  "occurredOn": "2026-12-20",
  "category": "stay",
  "note": null,
  "receiptIds": []
}
```

```json
{
  "data": {
    "id": "exp_01",
    "title": "Khách sạn",
    "amountMinor": 900000,
    "currency": "VND",
    "payerParticipantId": "p_A",
    "splitMethod": "equal",
    "shares": [
      { "participantId": "p_A", "amountMinor": 300000 },
      { "participantId": "p_B", "amountMinor": 300000 },
      { "participantId": "p_C", "amountMinor": 300000 }
    ],
    "status": "active",
    "version": 1
  },
  "meta": { "requestId": "req_01", "revision": 7, "ledgerVersion": 1 }
}
```

Response minh họa rút gọn; DTO thật còn các trường metadata theo schema. Client không truyền computed shares trong chế độ equal.

API hiện nhận `split` trong payload tạo khoản chi; document mới lưu dạng chuẩn `splitInput`. GET danh sách/chi tiết trả `splitInput` cả với bản ghi legacy chỉ có `split`. S10 nhận tối đa ba `receiptIds` không trùng, ready/cùng chuyến/do actor upload; create/PATCH claim ảnh cùng transaction. PATCH có thể giữ attached của expense dù uploader khác; ảnh bỏ chuyển discarded grace 7 ngày, ảnh của expense void giữ attached.

Chia exact thay `splitMethod` bằng `exact`, `split` bằng:

```json
{
  "shares": [
    { "participantId": "p_A", "amountMinor": 100000 },
    { "participantId": "p_B", "amountMinor": 250000 },
    { "participantId": "p_C", "amountMinor": 550000 }
  ]
}
```

PATCH chấp nhận toàn bộ block tiền `amountMinor, payerParticipantId, splitMethod, split` nếu thay một trường trong block, tránh dữ liệu cũ/mới không đồng bộ; các trường metadata có thể patch riêng. Không nhận `status` để lách route void.

**S09 đã triển khai trên Emulator (18/11/2026):** PATCH kiểm creator/owner, If-Match và trip writable; tính contribution mới trừ cũ theo participant, giữ counters all-time/active và settlement lịch sử. Đổi category chỉ dịch category totals; metadata hoặc đổi cách diễn đạt split nhưng giữ amount/payer/shares không tăng ledgerVersion. Đảo phần cũ không yêu cầu người cũ active, còn toàn bộ người trong block tiền gửi mới phải active. PATCH chỉ sửa document v1 hợp lệ; legacy cần migration trước nếu trả `EXPENSE_INVARIANT_FAILED`. [OpenAPI](../be/openapi.json) có request/response cho 37 endpoints.

S09 thêm cancel pending (creator/owner, body `{}`) và void confirmed (owner, `{reason}`), đều có key/If-Match settlement.version; chỉ void đổi balances/ledgerVersion và giữ nguyên `confirmedBy/At/Mode`. Archive/reopen nhận `{}` với key/If-Match trip.version. Archive transaction kiểm balances đủ cho participants, net từng người bằng 0 và cả pending counter/rows; trả `TRIP_NOT_BALANCED`, `PENDING_SETTLEMENTS` hoặc `PROJECTION_INVARIANT_FAILED` khi chưa đủ điều kiện. Archive tăng epoch để vô hiệu mọi lời mời cũ; reopen đặt archivedAt=null, không giảm epoch. Cả hai giữ ledgerVersion; trip suspended không được archive/reopen. [Bằng chứng kiểm thử S09](slices/02_NGHIEP_VU_BE.md#s09).

### 4.3. Ví dụ settlement

```json
{
  "fromParticipantId": "p_C",
  "toParticipantId": "p_A",
  "amountMinor": 120000,
  "occurredOn": "2026-12-22",
  "note": "Đã chuyển khoản, chờ An xác nhận",
  "basedOnLedgerVersion": 3
}
```

Confirm dùng `If-Match` của settlement và body `{ "basedOnLedgerVersion": 3 }`. Nếu ledger đã thay đổi, trả 409 `LEDGER_CHANGED`; sau refresh người dùng xác nhận lại với lệnh/key mới. Nếu version ledger khớp nhưng amount vượt số dư, trả 422 `SETTLEMENT_EXCEEDS_BALANCE`.

### 4.4. Mã HTTP và mã lỗi

| HTTP | code | Hành vi FE |
| --- | --- | --- |
| 400 | `INVALID_JSON`, `UNKNOWN_FIELD`, `INVALID_CURSOR` | Sửa request; không retry |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED` | Refresh một lần hoặc login |
| 403 | `FORBIDDEN` | Có quyền xem nhưng thiếu quyền thao tác |
| 404 | `NOT_FOUND` | Không tồn tại hoặc không có membership active |
| 409 | `VERSION_CONFLICT`, `LEDGER_CHANGED`, `CURSOR_STALE` | Refresh, giữ form |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Không đổi payload của lệnh đang chờ |
| 409 | `OPERATION_RESULT_UNAVAILABLE` | Giữ key và kiểm tra lại trạng thái nghiệp vụ khi kết quả đã lưu thiếu dữ liệu |
| 409 | `TRIP_ARCHIVED`, `INVALID_STATE_TRANSITION`, `PARTICIPANT_ALREADY_LINKED` | Giải thích điều kiện trạng thái |
| 409 | `RECEIPT_NOT_READY`, `RECEIPT_ALREADY_ATTACHED`, `PROCESSING_IN_PROGRESS` | Chờ hoặc chọn ảnh khác |
| 422 | `VALIDATION_ERROR`, `SPLIT_TOTAL_MISMATCH`, `UNSAFE_AMOUNT` | Field errors |
| 422 | `SETTLEMENT_EXCEEDS_BALANCE`, `TRIP_NOT_BALANCED`, `PENDING_SETTLEMENTS_EXIST` | Điều chỉnh nghiệp vụ |
| 413 | `BODY_TOO_LARGE`, `RECEIPT_TOO_LARGE` | Giảm kích thước |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Chọn JPEG/PNG/WebP |
| 428 | `PRECONDITION_REQUIRED` | Lấy version trước khi ghi |
| 429 | `RATE_LIMITED`, `TRIP_LIMIT_REACHED` | Tôn trọng Retry-After; limit sản phẩm có hướng dẫn |
| 500 | `INTERNAL_ERROR`, `BALANCE_INVARIANT_FAILED` | Message an toàn + requestId, alert vận hành |
| 503 | `DEPENDENCY_UNAVAILABLE`, `TRANSACTION_BUSY` | Retry cùng key có backoff |

## 5. Thuật toán tiền

### 5.1. Chuẩn hóa

Input API chỉ nhận number nguyên an toàn trong bounds. Từ chối số thập phân, NaN, Infinity, numeric string và `-0` nếu đường parse cho phép. Không lấy `parseFloat()` từ chuỗi có dấu phân cách. Kiểm tra uniqueness, participant tồn tại và thuộc đúng trip.

FE nhận chuỗi để nhập; adapter FE đổi thành integer trước gửi. BE kiểm tra lại độc lập.

### 5.2. Hàm chia đều

```ts
function splitEqual(total: bigint, ids: string[]) {
  const sorted = [...ids].sort(); // ASCII IDs, trước đó validate unique/non-empty
  const n = BigInt(sorted.length);
  const q = total / n;
  const r = total % n;
  return sorted.map((participantId, i) => ({
    participantId,
    amountMinor: q + (BigInt(i) < r ? 1n : 0n),
  }));
}
```

Không dùng `Math.round(T/n)` cho mọi người. Invariants: tổng bằng T, chênh lệch tối đa 1, thứ tự nhập không đổi kết quả, kết quả deterministic.

### 5.3. Largest remainder cho P1

```text
W = sum(weights)
base[i] = floor(T * weight[i] / W)
remainder[i] = (T * weight[i]) mod W
missing = T - sum(base)
sort theo remainder giảm dần, participantId tăng dần khi hòa
thêm 1 cho missing người đầu
```

Phần trăm: weight là bps nguyên 0..10000, tổng = 10000, có ít nhất một weight >0. Weighted: weight nguyên 1..10000, tối đa 50 người. Công thức dùng bigint toàn bộ; không chuyển phần dư sang float để sort.

### 5.4. Expense contribution và sửa/hủy

Cho expense T, payer P, shares s:

```text
paid[P] += T
owed[i] += share[i]
net[P] += T
net[i] -= share[i]
```

Nếu payer cũng nằm trong shares, phải gộp delta cùng participant trước ghi, không ghi đè một nhánh. `sum(delta.net) = 0` luôn đúng.

Sửa tài chính: `delta = contribution(new) - contribution(old)`. Hủy: `delta = -contribution(old)`. Tính delta cả `paid`, `owed`, `net`, totalExpense, categoryTotals và activeExpenseCount khi phù hợp. Đổi category chỉ dịch category totals, không đổi net/ledgerVersion vì tổng nghĩa vụ tiền không đổi.

Khi sửa metadata trên expense có participant inactive, giữ shares cũ; nếu client gửi block tiền mới thì yêu cầu tất cả người trong block active. Không bắt active đối với bản cũ khi đảo delta.

### 5.5. Settlement contribution

Confirmed X → Y số tiền S:

```text
sent[X] += S; net[X] += S
received[Y] += S; net[Y] -= S
```

Void đảo contribution. Pending/cancelled contribution bằng 0. Không cộng settlement vào totalExpense. Confirm/void không được áp dụng contribution hai lần.

### 5.6. Gợi ý thanh toán

1. Đọc toàn bộ balance docs (max 50) và trip trong snapshot nhất quán.
2. Kiểm tra tổng net = 0; nếu sai, dừng gợi ý và báo invariant failure, không sửa bằng cách cộng phần lệch cho owner.
3. Debtors: net <0, giá trị nợ = -net. Creditors: net >0.
4. Sort giá trị giảm dần rồi ID tăng dần để deterministic.
5. Ghép hai đầu, `x = min(debt, credit)`, tạo from/to/x; trừ và chuyển con trỏ khi hết.
6. Trả suggestions cùng `ledgerVersion` và `snapshotAt`; không lưu suggestions như sổ.

Với k người có số dư khác 0, thuật toán tạo tối đa k−1 dòng. Đây là cách tìm một phương án cân bằng đơn giản, không chứng minh tối ưu toàn cục. Kiểm tra tổng outgoing/incoming đúng số dư ban đầu bằng property tests.

## 6. Transaction, concurrency và idempotency

### 6.1. Luồng chung cho financial command

```text
Ngoài transaction:
  verify token, parse schema, canonicalize payload, hash request
  cấp resourceId/auditId dự kiến; không gửi email, upload hoặc gọi dịch vụ ngoài trong callback

Trong transaction, đọc trước khi ghi:
  operation của uid/key
  trip + membership hiện tại của actor
  UserDoc của actor: status phải active; trip.moderationStatus phải normal khi ghi nghiệp vụ
  entity/version + participants/balances/receipts/links liên quan
  nếu operation tồn tại:
    kiểm tra hash và quyền truy cập hiện tại; trả response snapshot, không apply lại
  nếu chưa tồn tại:
    kiểm tra trip state, role, ownership, If-Match, ledgerVersion nếu cần
    validate invariants; tính shares và tất cả deltas
    ghi entity, balance docs, counters, audit event, signal, operation committed

Sau transaction:
  serialize response; log outcome; invalidation phía FE
```

Trong implementation, nhánh operation replay không cần đọc tất cả ledger docs; chỉ cần các reads xác nhận quyền truy cập và request hash trước khi trả. Không thực hiện bất kỳ write nào trước khi đọc xong nhánh tương ứng.

Firestore có thể chạy lại callback transaction khi tranh chấp. Vì vậy không sinh side effect ngoài DB trong callback, không tăng counter trong memory để tính version, không lấy thời gian khác nhau cho quyết định mỗi retry nếu có thể tránh. [Tài liệu transaction Firebase](https://firebase.google.com/docs/firestore/manage-data/transactions).

### 6.2. Điểm bắt buộc

- Membership được đọc trong chính transaction ghi, để remove và mutation cạnh tranh không vượt kiểm tra quyền cũ. Không chỉ authorize một lần trước transaction.
- UserDoc.status cũng đọc trong transaction; tài khoản disabled không được đọc/ghi protected API. Trip suspended chặn ghi nghiệp vụ; owner vẫn được gỡ membership/revoke invite để thu hồi quyền. Xem workflow quản trị trong [ADMIN_WEB.md](ADMIN_WEB.md).
- Mọi mutation có ảnh hưởng ledger đều ghi trip root; root là điểm serialization cho nhóm nhỏ, giúp ledgerVersion, archive và settlement kiểm tra cùng trạng thái.
- Archive transaction đọc tất cả balances, pending count, root và owner membership; concurrent create expense/confirm phải conflict qua root.
- Counter membership/participant/expense giới hạn phải tăng trong transaction, không query-count ngoài transaction rồi ghi.
- Giá trị mới có kiểm tra `net = paid - owed + sent - received`, bounds, tổng delta = 0. Không truncate hoặc round để chữa lỗi.
- Khi transaction retry quá ngưỡng, trả 503 `TRANSACTION_BUSY`; client dùng lại key.
- Không gửi cùng lệnh sang queue và API trực tiếp cùng lúc.

### 6.3. Idempotency chi tiết

1. Scope key theo actor uid. Hash gồm method, canonical path, body đã validate và If-Match đã parse ở endpoint yêu cầu version. Sắp xếp key JSON ở mọi cấp và giữ thứ tự phần tử mảng.
2. Operation committed được ghi nguyên tử với dữ liệu nghiệp vụ; không có khoảng “expense đã có nhưng key chưa lưu”.
3. Cùng key/hash: trả status, DTO, metadata phiên bản và ETag đã lưu, kèm `Idempotency-Replayed: true`, kể cả entity đã có version cao hơn. Bản ghi legacy lưu DTO dùng HTTP 200 và trả DTO cũ kèm dấu replay.
4. Cùng key khác hash: 409, không ghi gì.
5. Response snapshot có thể cũ theo thiết kế replay; FE invalidate và GET lại overview/detail sau đó.
6. Nếu uid không còn quyền xem trip, không trả response snapshot riêng tư; trả 404. Replay không tự cấp lại quyền.
7. Không cần kiểm tra lại quyền thực hiện hành động đã hoàn tất, ví dụ owner cũ replay transfer-owner; chỉ kiểm tra quyền truy cập hiện tại và actor sở hữu operation.
8. Timeout trước commit: operation không có; retry cùng key tạo đúng một lần. Timeout sau commit: retry trả snapshot.
9. Validation lỗi trước khi ghi không tạo operation committed. Người dùng sửa payload phải dùng key mới để tránh ambiguity với request cũ đang chạy.
10. `GET /operations/:key` chỉ trả trạng thái completed + entity + committedAt nếu có; 404 là chưa tìm thấy, không phải bằng chứng cho phép tạo key khác. Luôn retry key cũ nếu còn cùng ý định.

Với tạo trip chưa có membership trước đó: transaction đọc operation trước; nếu replay lấy tripId từ operation rồi kiểm tra membership hiện tại. Nếu create mới, tạo tất cả docs liên quan nguyên tử.

### 6.4. Đọc nhất quán và pagination

- Overview dùng read-only transaction đọc membership, trip, participants, balances và recent expenses trong cùng snapshot.
- Suggestions dùng snapshot tương tự nhưng không cần toàn bộ expenses.
- Expense list đọc membership/root/query trong read-only transaction, cursor mang revision đã ký. Revision khác cursor trả 409 `CURSOR_STALE`, FE tải lại trang 1.
- Không aggregate balance bằng cách cộng riêng trang expenses đang đọc.
- Activity pagination cũng có cursor bound filters; có thể dùng append-only boundary timestamp/id để không reset mỗi sự kiện, nhưng P0 dùng cùng revision policy cho đơn giản.
- Signed cursor dùng secret riêng, có expiration; không coi cursor là quyền, vẫn kiểm membership mỗi request.

### 6.5. Hiệu năng và giới hạn thiết kế

Trip root được cập nhật ở mọi commit nghiệp vụ nên là điểm tranh chấp. Chấp nhận cho nhóm nhỏ; cần đo emulator và staging với 5–10 writers trước release. Nếu tăng lên hàng trăm người/ghi liên tục, phải thiết kế lại serialization/projections trước khi tăng giới hạn.

Không lưu toàn bộ expenses hoặc audit vào một array trên trip. Không đặt tất cả balances vào một blob phải ghi lại nếu không cần. Không batch hàng nghìn documents trong request web; cleanup/reconcile dùng job có checkpoint.

## 7. Auth, authorization và Rules

### 7.1. API auth

- Verify Firebase ID token bằng Admin SDK, kiểm tra project/audience/issuer đúng environment.
- P0 dùng `verifyIdToken(token, true)` cho API protected để kiểm tra revoke/disabled; theo dõi overhead và availability, không bỏ check mà không có quyết định rõ ràng.
- Firebase token verification thông thường không tự kiểm tra revoke nếu không yêu cầu. [Verify ID tokens](https://firebase.google.com/docs/auth/admin/verify-id-tokens).
- Không dùng Firebase API key làm bằng chứng người dùng đã đăng nhập.
- Không nhận actorUid/role/ownerUid từ body để authorize.
- Bearer token chỉ qua HTTPS header; không cookie auth trong P0. Nếu chuyển cookie sau này phải bổ sung CSRF, SameSite và session revocation design.
- CORS same-origin mặc định; không `Access-Control-Allow-Origin: *` cho private API.
- Đối tượng nằm dưới trip khác: trả 404, không để IDOR.

### 7.2. Firestore Rules

Admin/server SDK bỏ qua Firestore Security Rules. Vì vậy Rules bảo vệ đường client, còn API phải tự kiểm quyền. [Tài liệu chính thức](https://firebase.google.com/docs/firestore/security/rules-conditions).

Chính sách client P0: chỉ get/listen signal khi member active; get own membership kể cả removed để nhận biết bị gỡ; không list memberships, không read/write sổ qua SDK.

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    function activeMember(tripId) {
      return signedIn()
        && exists(/databases/$(database)/documents/trips/$(tripId)/memberships/$(request.auth.uid))
        && get(/databases/$(database)/documents/trips/$(tripId)/memberships/$(request.auth.uid)).data.status == 'active';
    }
    match /trips/{tripId}/signals/current {
      allow get: if activeMember(tripId);
      allow list, write: if false;
    }
    match /trips/{tripId}/memberships/{uid} {
      allow get: if signedIn() && request.auth.uid == uid;
      allow list, write: if false;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

Mẫu trên phải chạy Rules emulator tests; Rules match là OR giữa các allow, nên không thêm một rule rộng `authenticated → read/write` ở nơi khác. Không triển khai Firestore test mode lên public environment.

### 7.3. Abuse và rate limit

Rate limit phải dùng store phân tán; memory counter trong function chỉ bổ sung, không phải nguồn chính. P0 có thể dùng Firestore transaction theo hash uid + routeGroup + minute window, server-only. Làm rõ đây là bounded transaction tăng thêm chi phí đọc/ghi.

Giới hạn đề xuất: 60 mutations/phút/uid, 10 upload intents/giờ/uid/trip, 5 create trips/giờ/uid, 10 invite preview/accept/phút/uid. Tune bằng dữ liệu thật. Hạn mức product 50 participants, 2.000 expenses/settlements chống quét/đọc không giới hạn.

Public invalid tokens bị chặn trước Firestore auth checks tốn phí khi có thể; dùng platform firewall/rate controls nếu gói hiện tại có. App Check là lớp chống abuse bổ sung P1, không thay auth hoặc membership. Debug token không được vào production.

## 8. Ảnh hóa đơn: private upload và lifecycle

### 8.1. Schema và object paths

```ts
type ReceiptDoc = {
  uploaderUid: string;
  status: 'awaiting_upload' | 'processing' | 'ready' | 'attached' | 'discarded' | 'failed';
  declaredContentType: 'image/jpeg' | 'image/png' | 'image/webp';
  maxBytes: number;               // 5 * 1024 * 1024
  expiresAt: Timestamp;           // upload intent: 15 phút
  stagingPath: string;
  stagingGeneration: string | null;
  processedPath: string | null;
  processedGeneration: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  attachedExpenseId: string | null;
  processingLeaseUntil: Timestamp | null;
  processingAttemptId: string | null;
  processingOperationKey: string | null;
  processingRequestHash: string | null;
  processingBaseVersion: number | null;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

```text
receipt-staging/{tripId}/{uploaderUid}/{receiptId}/original
receipt-processed/{tripId}/{receiptId}/{processingAttemptId}.jpg
```

Không dùng tên file gốc làm path. Một receipt chỉ thuộc một expense; không cho gắn cùng ảnh vào nhiều khoản trong P0. Cả hai vùng đều không public.

### 8.2. Luồng chuẩn

**S10 đã triển khai trên local/Emulator:** bốn endpoint receipt trong OpenAPI (41 endpoints toàn API), Sharp processor thật, quota cấp policy 10 lần/giờ/UID/trip gồm replay, workflow reservation theo UID/key, attach/detach transaction, Storage Rules/CORS config và cleanup CLI có dry-run/apply/checkpoint/lease/retry. Dữ liệu capability không lưu vào DB/op/audit/log. Test state machine inject Storage adapter memory; Rules được kiểm qua client đã đăng nhập trên Storage Emulator. Chưa có bucket cloud/deploy/smoke IAM/CORS/signed policy thật. Xem [hướng dẫn S10](RECEIPTS.md).

1. API `upload-intents`: transaction kiểm user/membership/trip active và normal/quota, tạo receipt awaiting_upload, version 1, expiresAt +15 phút. Sau commit cấp GCS V4 signed POST policy TTL5 phút cho đúng stagingPath, size1..5MiB và exact contentType. Không lưu policy signature trong operation/log; replay có thể cấp lại policy với hạn không vượt expiresAt sau khi kiểm quyền hiện tại.
2. FE upload trực tiếp vào bucket Firebase Storage qua Cloud Storage XML POST endpoint bằng FormData policy. Mọi Firebase client SDK read/write đều deny; quyền upload nằm trong policy ngắn hạn do API cấp, không tạo Firebase download token dài hạn. Bucket CORS chỉ cho app origins, không public IAM.
3. FE gọi finalize với If-Match và key. API transaction claim processing lease 2 phút, gán attemptId/version; không ghi operation committed nếu xử lý ảnh chưa hoàn tất.
4. Ngoài transaction, Admin đọc metadata và đúng object generation, giới hạn raw ≤5MiB, magic bytes/decode JPEG/PNG/WebP, tối đa 20 megapixels, từ chối animation và ảnh hỏng.
5. Auto-rotate theo EXIF rồi strip metadata, resize cạnh dài ≤1.600px, encode JPEG chất lượng đủ đọc; processed output ≤2MiB. Nếu không đạt mà không mất độ rõ, báo lỗi, không tự nhận ảnh không đọc được.
6. Ghi processed object path duy nhất theo attemptId với generation precondition không overwrite.
7. Transaction cuối đọc lease/attempt, membership/trip/receipt, revalidate rồi set ready, save processed path/generation/dimensions, tăng version và ghi operation committed.
8. Attach receipt trong expense create/PATCH transaction: recheck ready, same trip, uploader là actor (hoặc ảnh đã attached vào chính expense đó), quota max3, rồi set attachedExpenseId/status.
9. Xóa staging bằng thao tác idempotent sau ready; lỗi xóa chuyển cleanup job, không làm hỏng expense.

Finalize là workflow nhiều pha do Firestore và Storage không có distributed transaction. Lease/attemptId chống hai lần finalize chạy song song. Nếu process chết sau claim, retry cùng key nhận `PROCESSING_IN_PROGRESS` cho đến lease hết; sau đó reclaim và tạo attemptId mới. Nếu chết sau tạo processed object nhưng trước commit, object là orphan được cleanup. Attempt cũ không được commit đè attempt mới.

Trong giai đoạn processing, If-Match của lần bắt đầu không được kiểm lại như một request sửa mới khi retry cùng workflow key: lưu `processingOperationKey/requestHash/baseVersion` để nhận diện continuation. Cùng key khác payload vẫn 409. Worker lấy lại workflow trước rồi mới quyết định claim/continue. Đây là ngoại lệ có state workflow bên cạnh OperationDoc chỉ chứa committed.

### 8.3. Signed upload policy, IAM và Storage Rules

Chọn signed POST policy cho đường upload production. Policy cố định bucket/key, expiration5 phút, content-length-range1..5MiB, exact Content-Type và form fields được phép; không nhận tùy ý metadata/ACL từ FE. Không ký quyền list/get/delete hoặc path processed. [Cloud Storage form upload](https://cloud.google.com/storage/docs/xml-api/post-object-forms), [V4 signatures/policy documents](https://cloud.google.com/storage/docs/authentication/signatures).

Firebase Storage Rules deny tất cả truy cập trực tiếp bằng client SDK:

```text
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} {
      allow read, write: if false;
    }
  }
}
```

Signed Cloud Storage requests dùng chữ ký/IAM, không đi qua Firebase Rules. Vì vậy API cấp policy và bucket IAM mới là nơi giới hạn upload; test Rules deny không đủ chứng minh policy an toàn. Bật public access prevention nếu phù hợp, không có allUsers/allAuthenticatedUsers ACL, không tạo firebaseStorageDownloadTokens cho processed objects.

Policy là capability có thể bị phát lại vào **cùng staging key** đến khi hết hạn; không hứa one-time hoặc thu hồi tức thì. Finalize pin generation đọc và ghi processed path bất biến theo attemptId, nên upload lại staging không thay ảnh đã gắn. Nếu generation bị thay trong lúc xử lý, fail/retry có kiểm soát; không đọc âm thầm bytes mới. Cleanup xóa generation hiện tại và orphan sau hết hạn. Quota mint policy, TTL ngắn và giám sát upload bytes giảm abuse; không coi CORS là quyền truy cập.

Khi trip archived/suspended hoặc user bị khóa, không cấp policy mới, không finalize/attach. Policy đã cấp có thể còn upload staging tối đa5 phút; không ảnh hưởng ledger. Không lưu signed policy vào durable API response snapshot; trả intentId ổn định và chỉ reissue sau kiểm trạng thái/quyền. Đây là dữ liệu capability tạm, tương tự view URL.

Local tests mock signer/adapter và dùng emulator để kiểm state machine; policy expiration, CORS, IAM và content-length cần smoke với bucket staging thật. Rules không xác minh magic bytes; bước finalize làm kiểm tra định dạng/decode.

### 8.4. Xem ảnh và thu hồi quyền

- `view-url` kiểm member active; chỉ cho xem attached receipt hoặc uploader xem ready chưa gắn. Member khác không đọc receipt nháp.
- API cấp signed GET URL tối đa 60 giây, bound đúng object/generation; không tạo Firebase download token dài hạn.
- Set object/cache response `private, no-store`; giữ URL ở memory, không audit/log query signature.
- Signed URL là bearer capability trong thời gian còn hạn; gỡ membership chặn cấp URL mới, không thu hồi tức thì link đã phát hành. Nếu cần revoke ngay từng request, chuyển sang authenticated image proxy trong đặc tả riêng.
- Service account cần quyền ký URL đúng cơ chế credential đang dùng; thử ở staging, không chỉ emulator.
- Khi expense void, receipt vẫn attached để đối soát. Khi bỏ ảnh khỏi expense active, chuyển ready lại cho uploader hoặc discarded theo lựa chọn rõ ràng; P0 chọn discarded và giữ grace 7 ngày trước xóa bytes.

### 8.5. Cleanup

- Intent hết hạn chưa upload/ready không gắn >24h: đánh discarded, xóa staging/processed orphan bằng generation precondition.
- Processing lease hết hạn không tự coi thành công; có thể retry workflow trong 24h, sau đó failed/discarded.
- Ảnh detached/discarded: xóa bytes sau 7 ngày; receipt metadata/audit giữ trong vòng đời chuyến.
- Receipt attached vào active/void expense không bị job orphan xóa.
- Job claim/check state trong transaction trước xóa; recheck generation/path để không xóa file đã được attach bởi request cạnh tranh. Chuyển sang discarded dưới transaction làm attach mới bị chặn, rồi mới xóa bytes.
- Job paging max100 docs/lượt, checkpoint, retry bounded, không phụ thuộc function chạy nền sau response.
- Scheduler và tài khoản chạy job theo [CI/CD](CICD_DEPLOY.md); local emulator seed/job không được trỏ production.

## 9. Index và query plan

Không cần index mọi tổ hợp filter. Commit `firestore.indexes.json` cùng query code và test staging query trước release.

| Collection | Query | Composite đề xuất |
| --- | --- | --- |
| expenses | status + occurredOn desc + id desc | status ASC, occurredOn DESC, __name__ DESC |
| expenses | status + category + occurredOn desc + id desc | status ASC, category ASC, occurredOn DESC, __name__ DESC |
| expenses | status + payer + occurredOn desc + id desc | status ASC, payerParticipantId ASC, occurredOn DESC, __name__ DESC |
| settlements | status + createdAt desc + id desc | status ASC, createdAt DESC, __name__ DESC |
| auditEvents | createdAt desc + id desc | Theo yêu cầu index thực tế |
| users/*/tripRefs | status + joinedAt desc + id desc | status ASC, joinedAt DESC, __name__ DESC |
| receipts collection group | status + expiresAt/updatedAt để cleanup | Mỗi query có index collection-group riêng |

Truy vấn không status với sort đơn có thể dùng index mặc định. Tắt index trường note, shares, splitInput, audit before/after, responseSnapshot nếu không query; giảm index size/cost. Khi disable map indexing phải kiểm tra tác động các subfield cần query.

Firestore thiếu native full-text search cho kế hoạch này; P1 tìm kiếm phải quyết định prefix field/external index. Không tải tất cả expenses để search toàn bộ ở FE.

## 10. Reconciliation, audit và vận hành

- Job `reconcile-balances` đọc expenses active + settlements confirmed và tính lại từng component balance/stats bằng domain module.
- P0 tối đa 4.000 financial records/chuyến, phân trang; không giữ read transaction hàng nghìn docs quá lâu. Lấy root ledgerVersion trước và sau quá trình đọc; nếu thay đổi, bỏ kết quả/retry, không báo sai giả.
- So sánh stored với computed, log mismatch theo tripId hash/ID và request/jobId, không dump title/note.
- Không tự sửa số dư trong job lịch. Repair yêu cầu chế độ maintenance, backup, dry-run diff và transaction kiểm ledgerVersion chưa đổi.
- Restore Firestore và object bytes là hai việc riêng; bảo đảm ảnh referenced tồn tại sau restore.
- Audit app là dữ liệu cùng hệ thống, không chứng cứ chống sửa tuyệt đối bởi quản trị cloud. Giảm quyền production và ghi deployment/operator actions riêng.
- `GET /health` không gọi DB để tránh health checks tạo chi phí; readiness/dependency test là endpoint nội bộ/smoke authenticated riêng.

## 11. Biến môi trường và config

| Biến | Public? | Ý nghĩa |
| --- | --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Có | Firebase client config, không phải private credential |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Có | Auth domain |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Có | Project của web client |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Có | Bucket name |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Có | Client app ID |
| `FIREBASE_PROJECT_ID` | Không cần public | Server project, phải khớp web config |
| `FIREBASE_CLIENT_EMAIL` | Server-only | Service account credential nếu dùng key |
| `FIREBASE_PRIVATE_KEY` | Tuyệt đối server-only | Credential, bảo toàn newline qua secret store |
| `FIREBASE_STORAGE_BUCKET` | Server-only | Bucket của environment |
| `CURSOR_SIGNING_SECRET` | Secret | Ký opaque cursor, riêng mỗi environment |
| `APP_ORIGIN` | Config | Canonical origin để tạo invite |
| `APP_ENV` | Config | local/test/staging/production |
| `RELEASE_SHA` | Config | Trace release |
| `FIREBASE_AUTH_EMULATOR_HOST` | Chỉ local/test | Không được tồn tại production |
| `FIRESTORE_EMULATOR_HOST` | Chỉ local/test | Chặn boot nếu APP_ENV=production |
| `FIREBASE_STORAGE_EMULATOR_HOST` | Chỉ local/test | Tương tự |

Ưu tiên short-lived workload identity nếu Vercel/GCP project đã cấu hình và chứng minh ký Storage URL được. Với MVP dùng service account key trong secret store có least privilege, rotation và quy trình revoke; không commit JSON key hoặc đặt dưới `NEXT_PUBLIC_`.

Startup schema kiểm project client/server khớp, emulator không lẫn production, origin HTTPS đúng, private key có cấu trúc đúng. Không in giá trị secret trong lỗi config.

## 12. Phương án thay thế: SQLite có backend riêng

### 12.1. Kiến trúc

FE Next.js trên Vercel → API Fastify/NestJS trên host/container có persistent volume → SQLite. Ảnh ở Firebase Storage hoặc object storage khác. Auth có thể giữ Firebase Auth; backend vẫn verify token.

Không dùng SQLite file trên Vercel Functions. Nếu cần cả API trên Vercel và SQL, lựa chọn một dịch vụ SQLite/libSQL từ xa rồi xác minh SDK, transactions, consistency, quota và chi phí trước khi thay architecture. Kế hoạch này không giả định mọi provider đều tương đương SQLite local.

### 12.2. Schema quan hệ tương ứng

Các bảng tối thiểu:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE trips (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'VND'),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  ledger_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  display_name TEXT NOT NULL,
  linked_uid TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (trip_id, id),
  UNIQUE (trip_id, linked_uid)
);

CREATE TABLE memberships (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  uid TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  status TEXT NOT NULL CHECK (status IN ('active','removed')),
  participant_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (trip_id, uid),
  FOREIGN KEY (trip_id, participant_id) REFERENCES participants(trip_id,id)
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  payer_participant_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
  status TEXT NOT NULL CHECK (status IN ('active','void')),
  version INTEGER NOT NULL DEFAULT 1,
  occurred_on TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (trip_id, id),
  FOREIGN KEY (trip_id,payer_participant_id) REFERENCES participants(trip_id,id)
);

CREATE TABLE expense_shares (
  trip_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (expense_id,participant_id),
  FOREIGN KEY (trip_id,expense_id) REFERENCES expenses(trip_id,id),
  FOREIGN KEY (trip_id,participant_id) REFERENCES participants(trip_id,id)
);
```

DDL minh họa phần lõi, **chưa phải migration hoàn chỉnh**: cần thêm title/category/note/timestamps, settlements, balances, receipts, invites, audit_events, operations, constraints và indexes như schema Firebase. `SUM(shares)=expense.amount` là invariant liên bảng, phải kiểm trong transaction/service hoặc trigger đã kiểm thử; CHECK một cột không đảm bảo được.

### 12.3. Ghi và vận hành SQLite

- Mỗi command `BEGIN IMMEDIATE` → membership/version/op checks → entity/shares/balances/audit/op → COMMIT; rollback khi lỗi.
- Unique `(actor_uid, idempotency_key)` cho operations; version update có `WHERE id=? AND version=?`, kiểm affected rows.
- Bật WAL và busy timeout theo môi trường sau khi benchmark; dùng local persistent volume, kiểm compatibility filesystem/backup, không mặc định shared network disk phù hợp.
- Một writer tại một thời điểm; không scale nhiều API replicas cùng một file nếu chưa thiết kế file locking/replication.
- Backup dùng SQLite backup API/cơ chế nhất quán của provider; không copy riêng file `.db` đang chạy WAL rồi coi là backup đủ.
- Migrations có version và backup/restore rehearsal. Không chạy SQL drop/reset production qua startup script.

Nguồn kiểm chứng khi chọn phương án này: [SQLite transactions](https://www.sqlite.org/lang_transaction.html), [WAL](https://www.sqlite.org/wal.html), [Online Backup API](https://www.sqlite.org/backup.html). Các chi tiết SQLite phải đối chiếu lại nguồn chính thức ở bước implementation; không áp dụng tuning chưa đo.

## 13. Checklist hoàn tất Backend

- Tất cả route protected verify token và kiểm quyền theo trip; Admin SDK không là lối bỏ qua authorization.
- Ghi tiền nguyên tử với balances/stats/audit/operation/signal.
- Shares và balance invariants có unit/property/integration tests có ý nghĩa.
- Create/update/void/confirm cùng key không nhân đôi; key khác body bị chặn.
- Hai writer cùng version, confirm đồng thời, archive cạnh tranh và remove cạnh tranh có kết quả đúng.
- Upload intent/finalize/attach/cleanup có state machine, lease và object generation; không public receipts.
- Queries có bounded pagination và indexes sẵn sàng staging.
- Secrets không vào browser/log/artifact; staging và prod tách project.
- Có seed emulator, backup/restore, reconciliation dry-run và runbook incidents.
- Hợp đồng DTO/error/version khớp Frontend, checks trong Roadmap đạt trước production.
