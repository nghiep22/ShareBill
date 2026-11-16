# ShareBill — Website quản trị bằng React và Node.js

Phiên bản 1.0 · 16/11/2026 · Yêu cầu trực tiếp: thao tác dễ dàng, dễ hiểu; quản trị app qua website React/Node.js.

**Cập nhật cấu trúc:** React admin thuộc `fe/`, Node.js/Fastify admin API thuộc `be/`. Layout/routes trong Next.js dưới đây là mục tiêu FE; Node API không còn ở `src/app/api/admin/...` cùng project.

Tra nhanh: [React/Node.js](#1-kiến-trúc-đã-chọn) · [Dễ dùng](#3-nguyên-tắc-ux-dễ-dùng) · [Quyền admin](#4-vai-trò-quản-trị) · [Màn hình](#5-đặc-tả-từng-màn-hình) · [Schema](#6-schema-bổ-sung-cho-be) · [API](#7-api-quản-trị-nodejs) · [Nghiệm thu](#10-definition-of-done-cho-website-quản-trị).

## 1. Kiến trúc đã chọn

Sản phẩm có hai khu vực giao diện, dùng cùng backend nghiệp vụ:

| Khu vực | Công nghệ | Đường dẫn | Người dùng |
| --- | --- | --- | --- |
| App chia tiền | React qua Next.js, PWA mobile-first | `/trips/...` | Người đi du lịch |
| Website quản trị | React qua Next.js, desktop-first responsive | `/admin/...` | Người vận hành app |
| API app | Node.js, Next.js Route Handlers | `/api/v1/...` | App authenticated |
| API quản trị | Node.js, Next.js Route Handlers | `/api/admin/v1/...` | Admin được cấp quyền riêng |

Next.js là framework React; Route Handlers ở đây chạy Node.js. Lựa chọn này đáp ứng React/Node.js và deploy Vercel với một repo, tránh thêm backend server thứ hai khi chưa cần. Website quản trị có layout, bundles, route guard và module quyền riêng. Có thể tách React SPA/API thành repo riêng sau này mà vẫn giữ hợp đồng HTTP.

```text
src/app/(admin)/admin/
  layout.tsx
  page.tsx
  users/page.tsx
  users/[uid]/page.tsx
  trips/page.tsx
  trips/[tripId]/page.tsx
  support/page.tsx
  support/[ticketId]/page.tsx
  activity/page.tsx
  system/page.tsx
src/app/api/admin/v1/...
src/features/admin/{dashboard,users,trips,support,activity,system}/
src/server/admin/{auth,users,trips,support,audit,jobs}/
```

Không dùng Firebase Console thay cho website quản trị nghiệp vụ. Console/cloud dashboard chỉ phục vụ cấu hình hạ tầng, billing, IAM và sự cố kỹ thuật chuyên sâu.

## 2. Phạm vi P0 và P1

| Chức năng | P0 | P1 |
| --- | --- | --- |
| Đăng nhập quản trị | Google + server allowlist role | SSO/MFA chuyên biệt nếu cần |
| Dashboard | Số user, số chuyến, ticket chờ, job lỗi; nhãn cập nhật | Biểu đồ xu hướng, realtime operational metrics |
| Người dùng | Tìm theo UID/email chính xác, xem metadata, khóa/mở | Tìm prefix tên/email, export có kiểm soát |
| Chuyến đi | Tìm trip ID, filter trạng thái, xem metadata, tạm khóa/mở | Tìm tên toàn văn |
| Hỗ trợ | Nhận báo lỗi từ app, gán trạng thái, ghi chú nội bộ | Reply trong app/email, SLA và assignment nhiều nhân viên |
| Hệ thống | Phiên bản release, job cleanup/reconcile/backup gần nhất | Feature flags có schema, maintenance UI |
| Audit | Tra hoạt động quản trị | Policy retention và export |
| Quản lý admin | Bootstrap/grant bằng quy trình operator ngoài UI | Màn hình phân quyền với cơ chế bảo vệ admin cuối cùng |
| Xem sổ tiền/ảnh của mọi nhóm | Không cấp mặc định | Support access có chủ nhóm cho phép, hết hạn và audit |
| Sửa số dư trực tiếp | Không có | Không tạo tính năng sửa tùy ý |

P0 không có bulk delete, xóa cứng tài khoản/chuyến, impersonate người dùng, sửa ledger trực tiếp hoặc xem toàn bộ receipt trong một thư viện công khai.

## 3. Nguyên tắc UX dễ dùng

### 3.1. Cho người dùng app

- Tạo chuyến chỉ bắt buộc tên chuyến và tên người tạo; phần ngày/địa điểm mở khi cần.
- Tạo khoản chi trong một màn hình; “Ai trả?” mặc định tôi khi đã liên kết, “Chia cho ai?” mặc định tất cả người active.
- Chia đều mặc định, cách chia riêng đặt dưới “Chia cách khác”.
- Ngày hôm nay, danh mục khác là giá trị mặc định; ảnh và ghi chú tùy chọn.
- Một nút chính “Lưu khoản chi”; không bắt bấm xem preview ở trang khác trước khi lưu khoản đơn giản.
- Nút trả nợ ghi “Tôi đã nhận tiền”, tránh “Approve transaction”.
- Kết quả tiền có câu “Bạn cần trả…”/“Bạn được nhận…”, không chỉ một số có dấu âm.
- Hướng dẫn ngay nơi cần; không bắt đọc tutorial dài mới được dùng.
- Lỗi phải có cách sửa, ví dụ “Bạn chưa chọn người chia”, “Tổng các phần còn thiếu 20.000đ”.

### 3.2. Cho quản trị viên

- Sidebar chỉ 6 mục: **Tổng quan, Người dùng, Chuyến đi, Hỗ trợ, Hoạt động, Hệ thống**.
- Tác vụ thông thường tìm → xem chi tiết → hành động, không quá ba màn hình.
- Mỗi bảng có ô tìm đúng loại, filter rõ, reset filter, empty state và phân trang.
- Không bắt admin biết Firestore collection, object path hoặc API để vận hành thường ngày.
- Tên người/tên chuyến hiển thị trước; ID có nút copy và font nhỏ cho tra cứu.
- Khóa/mở có giải thích tác động và lý do; không dùng màu đỏ cho mọi nút.
- Tác vụ đồng bộ Auth đang chạy hiển thị “Đang hoàn tất”, không báo thành công hoàn toàn khi còn job lỗi.
- Không ép nhập lại cùng thông tin ở nhiều màn hình; mã ticket được chuyển theo context.
- Thời gian hiển thị Asia/Ho_Chi_Minh cho admin P0, đồng thời có ISO UTC khi copy chi tiết sự cố.

### 3.3. Tiêu chí usability

| Tác vụ | Tiêu chí nghiệm thu |
| --- | --- |
| User thêm chi phí chia đều lần đầu | ≥4/5 người mới hoàn tất trong 60 giây, không có trợ giúp lời nói |
| User đọc số dư | ≥4/5 giải thích đúng mình cần trả hay được nhận và số tiền |
| Admin tìm người dùng có email | Hoàn tất trong 30 giây, không cần cloud console |
| Admin tạm khóa đúng chuyến | Trong 3 màn hình; đọc hiểu ảnh hưởng trước xác nhận |
| Admin xử lý ticket | Đổi trạng thái, ghi lý do và thấy lịch sử mà không mở database |
| Form lỗi | Không mất nội dung đã nhập; người thử biết cần sửa gì |

Thử trước với prototype đơn giản; lỗi hiểu nhầm cần sửa trước khi thêm biểu đồ/trang trí.

## 4. Vai trò quản trị

### 4.1. Tách ba cấp quyền

| Vai trò | Phạm vi |
| --- | --- |
| User/member | Các chuyến mình là member active |
| Trip owner | Quản lý một chuyến, không có quyền nền tảng |
| Platform admin | Quản trị app qua namespace admin, không tự trở thành owner/member mọi chuyến |

P0 chỉ một role `platform_admin` để tránh ma trận quá lớn. Có thể thêm support read-only sau khi có nhu cầu. Firebase custom claims không là nguồn quyền duy nhất trong kế hoạch này; source of truth là server-only admin membership doc.

### 4.2. Schema

```ts
type PlatformAdminDoc = {
  uid: string;
  role: 'platform_admin';
  status: 'active' | 'disabled';
  version: number;
  grantedBy: string; // operator identifier
  grantedAt: Timestamp;
};
```

Collection `platformAdmins/{uid}` bị deny toàn bộ với Firebase client Rules; chỉ Admin SDK server được đọc. `/api/admin/v1/me` trả quyền tối thiểu sau verify token và lookup. Mọi admin route tự requirePlatformAdmin, không chỉ đặt guard ở React layout.

- Bootstrap admin đầu tiên bằng script operator có `--project`, `--uid`, dry-run mặc định, kiểm tra environment; không tạo public endpoint tự cấp quyền.
- Không dùng “email kết thúc bằng @gmail.com” hoặc email trong body để cấp quyền.
- Không có nút khóa bản thân hoặc khóa tài khoản đang giữ platform admin trong màn hình user P0; xử lý qua quy trình quản trị danh tính riêng.
- Admin ghi nhạy cảm yêu cầu đăng nhập gần đây (`auth_time` ≤10 phút); nếu quá thời gian, reauthenticate Google rồi retry với key/body giữ nguyên.
- Admin frontend không có trusted-device offline cache; dữ liệu private quản trị không đưa vào IndexedDB hoặc service worker.

## 5. Đặc tả từng màn hình

### 5.1. Tổng quan `/admin`

4 card: **Tài khoản đang hoạt động**, **Chuyến đang mở**, **Báo lỗi chưa xử lý**, **Tác vụ hệ thống lỗi**.

Bên dưới là 5 ticket mới nhất và 5 sự kiện quản trị mới nhất. Mỗi card mở đúng bảng có filter tương ứng. Không hiển thị tổng tiền toàn bộ người dùng hoặc feed hóa đơn riêng tư.

Count dùng aggregation query phù hợp, cache server trong tài liệu metric tối đa 5 phút; hiển thị `updatedAt`. Cache phải phân quyền admin khi trả API, không dùng CDN public. Không scan toàn bộ ledger mỗi lần mở dashboard. [Firestore aggregation queries](https://firebase.google.com/docs/firestore/query-data/aggregation-queries).

### 5.2. Người dùng `/admin/users`

Search selector **Email / Mã người dùng**. Email chuẩn hóa lowercase cho exact lookup trên `users.emailLower`, UID lookup thẳng. P0 không hứa full-text.

Cột: tên, email, trạng thái app, ngày tạo, mã người dùng rút gọn. Page 25, max50; sort createdAt desc, id desc. Filter active/disabled. Không show số dư cá nhân.

Trang chi tiết: thông tin nhận diện, trạng thái, ngày tạo, lý do khóa gần nhất, sync status Firebase Auth, danh sách metadata những chuyến tham gia có phân trang. Email chỉ hiển thị cho admin authorized; không đưa vào telemetry.

**Khóa tài khoản:** dialog nêu tài khoản mất quyền gọi API và cần được mở lại để sử dụng; khoản chi cũ và participant vẫn còn. Required reason 10–500 ký tự. Trả trạng thái “Đã khóa trong app, đang đồng bộ đăng nhập” nếu Auth job chưa xong.

**Mở tài khoản:** cũng có reason, reauth và audit. UI không yêu cầu tạo user mới hoặc reset mật khẩu Google.

### 5.3. Chuyến đi `/admin/trips`

Filter trạng thái chuyến active/archived và trạng thái kiểm soát normal/suspended; P0 giới hạn một filter chính mỗi query nếu chưa có index tổ hợp. Search theo tripId chính xác.

Cột: tên chuyến, chủ nhóm UID/tên, số participants, ngày tạo, trạng thái, khóa/mở. Detail hiển thị metadata, counts expenses/settlements, mã release/sự cố liên quan nếu có. Không trả title từng expense, note, shares, balance hay receipt qua admin metadata endpoint.

**Tạm khóa chuyến:** `moderationStatus = suspended`, mọi ghi nghiệp vụ bị chặn, dữ liệu vẫn cho thành viên active xem; giải thích “Chuyến đang tạm khóa. Bạn vẫn xem được lịch sử”. Archive là chốt chuyến do owner; suspended là quản trị, hai trạng thái độc lập.

**Mở lại quyền thao tác:** chuyển normal, không tự reopen một chuyến archived. Luôn cần reason và audit. Gỡ membership/revoke invite để thu hồi quyền vẫn được phép khi suspended, owner không được dùng để thay đổi sổ tiền.

Không có nút “Điều chỉnh số dư”, “Chuyển chủ nhóm hộ” hay “Xem ảnh tất cả” trong P0. Sự cố chủ nhóm bị khóa cần mở tài khoản hoặc quy trình hỗ trợ được thiết kế riêng, không tạo lối bypass tự động.

### 5.4. Hỗ trợ `/admin/support`

User trong app có “Báo lỗi” ở menu chuyến hoặc `/help`. Form chỉ cần loại lỗi và mô tả; tripId được điền theo context nếu có, không bắt user tìm ID kỹ thuật.

Loại: thao tác khó hiểu, số dư cần kiểm tra, lỗi tải ảnh, lỗi đăng nhập/khác. Mô tả 10–2.000 ký tự, nhắc không nhập mật khẩu/thông tin ngân hàng. P0 không nhận file đính kèm ticket.

Admin list filter open/in_progress/resolved, 25/trang. Detail có thông tin user gửi, trip metadata liên quan, status và timeline nội bộ. Admin mở ticket → đánh “Đang xử lý” → ghi chú → “Đã xử lý”. Ghi chú nội bộ không trả cho user; user chỉ thấy mã báo lỗi và trạng thái.

P0 không gửi email hoặc nhắn tin tự động. Nếu cần phản hồi user trong app, triển khai P1 với message schema/quyền/notification riêng.

### 5.5. Hoạt động quản trị `/admin/activity`

Cột: admin, thao tác, đối tượng, lý do, thời gian, kết quả, requestId. Filter theo target type và time range giới hạn tối đa31 ngày; query/index có danh sách cho phép.

Ghi nhận cả khóa/mở user, khóa/mở trip, đổi ticket, cấp quyền operator và chạy maintenance có liên quan. Không cho sửa hoặc xóa audit trong UI. Tra raw logs qua công cụ vận hành khi cần, không render stack trace/secret trong bảng.

### 5.6. Hệ thống `/admin/system`

- Môi trường có badge rõ: STAGING/PRODUCTION, commit release, giờ deploy.
- Kết quả backup, cleanup, reconciliation gần nhất; trạng thái thành công/lỗi và jobId.
- Link đến runbook và dashboard cloud do người vận hành cấu hình; không tự suy ra billing từ số đọc API.
- P0 chỉ xem job status. Chạy lại job bằng workflow/operator có kiểm soát; không đặt nút chạy mọi script shell từ website.
- Cảnh báo có nội dung hành động: “Backup gần nhất đã quá 24 giờ. Kiểm tra job …”, không chỉ icon đỏ.

## 6. Schema bổ sung cho BE

### 6.1. User và trip mở rộng

```ts
// Bổ sung UserDoc trong BACKEND.md
type UserModerationFields = {
  emailLower: string | null;
  status: 'active' | 'disabled';      // Nguồn kiểm soát API app
  moderationVersion: number;
  desiredAuthDisabled: boolean;
  authSyncStatus: 'synced' | 'pending' | 'failed';
  disabledReason: string | null;
  disabledAt: Timestamp | null;
  disabledBy: string | null;
};

// Bổ sung TripDoc
type TripModerationFields = {
  moderationStatus: 'normal' | 'suspended';
  moderationVersion: number;
  moderationReason: string | null;
  moderatedAt: Timestamp | null;
  moderatedBy: string | null;
};
```

Mọi API app đọc user.status; financial transaction đọc lại UserDoc trong transaction để disable cạnh tranh không vượt quyền cũ. Mọi business mutation đọc trip.moderationStatus. Profile bootstrap không được reset `status`/moderation fields hoặc admin role.

### 6.2. Support ticket

```ts
type SupportTicketDoc = {
  createdBy: string;
  tripId: string | null;
  category: 'usability' | 'balance' | 'receipt' | 'account' | 'other';
  message: string;
  status: 'open' | 'in_progress' | 'resolved';
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

`supportTickets/{id}/internalNotes/{id}` server-only; `adminAuditEvents/{id}` append-only. Người tạo chỉ đọc ticket của mình qua API; việc gửi tripId yêu cầu membership active tại thời điểm tạo. User bị disabled không được gọi API protected, có trang giải thích và kênh liên hệ hỗ trợ do operator cấu hình ngoài app nếu cần.

### 6.3. Khóa Auth là workflow nhiều hệ thống

Firestore và Firebase Auth không commit nguyên tử chung. Không gọi disable Auth bên trong transaction Firestore.

- Disable command transaction ghi UserDoc.status disabled ngay, tăng moderationVersion, desiredAuthDisabled true, authSync pending; tạo adminAuthJob và audit/operation.
- Worker xử lý Auth disabled + revoke refresh tokens, sau đó cập nhật sync status theo version. API app đã bị chặn từ bước đầu dù Auth đồng bộ chậm.
- Enable command giữ app status disabled, đặt desiredAuthDisabled false và job pending; chỉ chuyển app active sau khi Auth đã enable thành công và moderationVersion vẫn đúng.
- Một user chỉ một worker lease; job cũ phải đọc desired state/version mới trước khi tác động và trước commit. Reconciler sửa Auth về desired state mới nhất nếu có cạnh tranh qua hai hệ thống; không để job cũ mở app status.
- Response command `202` có jobId; UI poll job status bounded, hiển thị failed/retry thông qua workflow vận hành.
- Mọi key retry trả cùng jobId, không enqueue trùng.
- Token cũ có thể còn dùng với Firebase client cho đến khi expire/Rules chặn. Đường ledger API kiểm UserDoc nên đã chặn; signed upload policy đã cấp còn tối đa5 phút chỉ ghi staging private, không finalize/attach được.

API hỗ trợ disable user và revoke session được mô tả trong [Manage users](https://firebase.google.com/docs/auth/admin/manage-users), [Manage sessions](https://firebase.google.com/docs/auth/admin/manage-sessions).

## 7. API quản trị Node.js

Mọi route verify token, active user và active platform admin. Mutation dùng idempotency key, If-Match theo moderationVersion/version tương ứng, reason, recent authentication. Các thay đổi quan trọng đọc lại admin doc trong transaction để revoke quyền cạnh tranh có hiệu lực.

| Method | Endpoint | Kết quả |
| --- | --- | --- |
| GET | `/api/admin/v1/me` | Role/capabilities hiện tại |
| GET | `/api/admin/v1/dashboard` | Counts + updatedAt + health summaries |
| GET | `/api/admin/v1/users?email=&uid=&status=&cursor=` | Danh sách/tìm exact, max50 |
| GET | `/api/admin/v1/users/:uid` | Metadata + moderationVersion + auth sync |
| GET | `/api/admin/v1/users/:uid/trips?cursor=` | Trip metadata, không ledger |
| POST | `/api/admin/v1/users/:uid/disable` | 202 jobId, app chặn ngay |
| POST | `/api/admin/v1/users/:uid/enable` | 202 jobId, chờ sync trước mở app |
| GET | `/api/admin/v1/trips?tripId=&status=&moderationStatus=&cursor=` | Metadata max50 |
| GET | `/api/admin/v1/trips/:id` | Counts, trạng thái; không note/receipt/shares |
| POST | `/api/admin/v1/trips/:id/suspend` | Tạm khóa ghi, audit |
| POST | `/api/admin/v1/trips/:id/resume` | Bỏ khóa quản trị, không tự reopen archived |
| GET | `/api/admin/v1/support?status=&cursor=` | Ticket list |
| GET | `/api/admin/v1/support/:id` | Ticket + internal timeline |
| PATCH | `/api/admin/v1/support/:id` | Chỉ status; If-Match ticket.version |
| POST | `/api/admin/v1/support/:id/notes` | Thêm internal note, max2000 chars |
| GET | `/api/admin/v1/activity?targetType=&from=&to=&cursor=` | Audit paginated |
| GET | `/api/admin/v1/system` | Release và job summaries |
| GET | `/api/admin/v1/jobs/:id` | Trạng thái job được phép xem |
| GET | `/api/admin/v1/operations/:key` | Kết quả command của chính admin |

API user bổ sung: `POST /api/v1/support-tickets`, `GET /api/v1/support-tickets`, `GET /api/v1/support-tickets/:id`. Tạo ticket dùng idempotency key, giới hạn 5 tickets/ngày/uid. Body/response đều plain text.

Operation admin dùng collection `adminOperations/{uid}/keys/{key}` để tách app operations. Audit admin nằm riêng; không tự đưa reason khóa tài khoản nhạy cảm vào activity công khai của chuyến. Trip suspend/resume vẫn tăng revision và signal để member UI chuyển read-only kịp thời, không tăng ledgerVersion.

## 8. Query/index và bảo mật quản trị

- Users: index status + createdAt desc + name; exact emailLower dùng index tương ứng, không scan.
- Trips: status hoặc moderationStatus + createdAt desc + id; chỉ hỗ trợ tổ hợp đã có index.
- Tickets: status + updatedAt desc + id; own tickets createdBy + createdAt desc + id.
- Admin audit: targetType + createdAt desc + id; giới hạn date window và page size.
- Auth jobs: status + availableAt; per-user lease/version như workflow.
- Deny client SDK mọi collections admin, tickets, jobs; mọi truy cập qua Node API.
- Throttle admin queries/mutations theo uid, không dựa vào trình duyệt nội bộ.
- API metadata chọn field allowlist, không serialize toàn bộ Firestore document rồi ẩn cột bằng CSS.
- Không có chức năng export toàn bộ người dùng P0, không ghi email/ticket content vào logs.
- Admin React route có `noindex`; bảo vệ bằng API authorization, không coi robots/noindex là cơ chế cấp quyền.
- Sitewide service worker bỏ qua `/admin`, `/api/admin`, admin auth responses và không cache navigation admin.
- Admin bị revoke: `/me` hoặc command trả403, dừng poll, xóa Query cache quản trị và chuyển trang không quyền.

## 9. Luồng thao tác mẫu

### 9.1. Tạm khóa một chuyến bị báo lỗi

Mở ticket → bấm tên chuyến → xem metadata → “Tạm khóa thao tác” → nhập lý do → xác nhận → thấy trạng thái Đã tạm khóa → owner/member nhận banner khi refresh/signal.

Mở lại: cùng trang → “Cho phép thao tác” → lý do → xác nhận. Nếu chuyến archived, UI vẫn hiển thị archived; owner quyết định reopen qua app.

### 9.2. Người dùng không đăng nhập được

Tìm email → mở user → xem app status/auth sync status. Nếu disabled có lý do hợp lệ để mở, admin reauth → yêu cầu mở → chờ job hoàn tất. Không yêu cầu user cung cấp mật khẩu, access token hoặc private key.

### 9.3. Người dùng báo số dư sai

Mở ticket → kiểm tra job reconciliation summary theo trip ID → nếu mismatch, xử lý sự cố theo runbook. Nếu invariant đúng, hướng dẫn owner đối chiếu expense/shares/confirmed settlement. Admin không nhập một con số để ép balance về 0. Support access chi tiết có consent là P1 trước khi xem nội dung tiền riêng tư.

## 10. Definition of Done cho website quản trị

- Người dùng thường và trip owner không truy cập được admin API dù tự gõ URL.
- Đủ 6 mục điều hướng, search/filter đúng khả năng, loading/empty/error rõ.
- Tác vụ khóa/mở tài khoản và chuyến có reason, audit, version check, idempotency và recent auth.
- User disable/enable hiển thị đúng trạng thái giữa Firestore/Auth, retry job không mở nhầm tài khoản.
- Admin không tự có quyền xem/sửa ledger hoặc ảnh trong nhóm không tham gia.
- Không có dữ liệu admin lưu offline; logout/revoke xóa cache.
- Có test E2E cho admin allow/deny, khóa/mở, ticket và thao tác dễ hiểu.
- Người vận hành hoàn thành kịch bản tìm user/khóa chuyến/xử lý ticket mà không mở Firebase Console.
