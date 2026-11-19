# S18 — Kiểm cấu hình và smoke bản triển khai

Ngày 19/11/2026. Công cụ đã diễn tập trên bản build static và Firebase Emulator. Chưa triển khai đợt mã này lên cloud; các kết quả local không thay cho cổng staging.

## Cấu hình bản phát hành

API trả `/health` với `status`, `service` và `release: { environment, commit, firebaseProjectId }`. Endpoint chỉ kiểm tiến trình, không chứng minh kết nối Auth/Firestore. Response có `Cache-Control: no-store`; không trả credential.

Web export `/release.json` từ cấu hình lúc build, gồm `service`, cùng ba trường `release` và `apiOrigin`. File không được đưa vào cache service worker; Vercel gửi `no-store`. Đổi cấu hình public cần build lại, theo cách Next.js đóng gói biến `NEXT_PUBLIC_*`.

| Giá trị | API runtime | Web build |
| --- | --- | --- |
| Môi trường | `APP_ENVIRONMENT=staging` | `NEXT_PUBLIC_APP_ENVIRONMENT=staging` |
| Commit | `RELEASE_COMMIT` hoặc `VERCEL_GIT_COMMIT_SHA` | Cùng biến, cùng SHA đầy đủ 40 ký tự |
| Firebase | `FIREBASE_PROJECT_ID` | `NEXT_PUBLIC_FIREBASE_PROJECT_ID` |
| Web/API | `APP_ORIGIN` là danh sách origin HTTPS phân cách dấu phẩy | `NEXT_PUBLIC_SHAREBILL_API_URL` là origin HTTPS của API |
| Auth | `FIREBASE_WEB_API_KEY` | `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` |
| Khóa server | `CURSOR_SIGNING_SECRET` ít nhất 32 ký tự, credential runtime | Không đưa vào web build |

API dừng khởi tạo với cấu hình cloud thiếu trường bắt buộc, project `demo-*`, host Emulator, origin HTTP/localhost hoặc cặp credential khai báo dở. Web cloud build cũng bị chặn nếu thiếu SHA/cấu hình public hoặc API origin không hợp lệ. Trên Vercel phải khai báo môi trường rõ ràng; project staging dùng Vercel production deployment vẫn đặt giá trị **staging**. Local không cần credential cloud. Bộ kiểm này không kiểm tính hợp lệ của key/IAM/provider trên dịch vụ thật.

Giữ Vercel Hobby/Firebase Spark theo ràng buộc miễn phí hiện tại. Bước này không tạo tài nguyên, đổi gói hoặc chọn bucket ảnh.

## Chạy kiểm chỉ đọc

Từ thư mục gốc repo, dùng SHA **của bản đã triển khai**, không tự lấy HEAD nếu chưa deploy:

```powershell
pnpm.cmd smoke --api-url https://sharebill-api-staging.vercel.app --web-url https://sharebill-nghiep22.vercel.app --environment staging --project sharebill-staging --commit <full-deployed-sha> --report staging-smoke.json
```

Lệnh mặc định chỉ đọc: đối chiếu SHA/môi trường/project của FE và API với giá trị mong đợi, kiểm origin API của bản web, HTTP shell `/` và `/admin`, preflight POST/PATCH cùng `If-Match`, và guard 401 cho user/admin API. Hai manifest lệch sẽ dừng trước đăng nhập. HTTP redirect bị từ chối; truyền canonical origin trực tiếp. Shell tải được chưa chứng minh hành trình browser hay quyền operator.

Exit code 0 khi tất cả kiểm tra đã chọn đạt; 1 khi cấu hình, kết nối hoặc một bước kiểm thất bại. Report ghi rõ `mode`, `coverage`, `remaining`, từng check, trip thử và khóa lệnh. Report chỉ lấy metadata cho phép; không chứa email, mật khẩu, token, nội dung response hay thông báo lỗi từ upstream. Có thể lưu report trong artifact CI; không kèm `.env`/auth state.

## Kiểm luồng ghi bằng tài khoản thử

Chuẩn bị **tài khoản Email/Password synthetic riêng** đã có trong staging. Truyền `SMOKE_EMAIL` và `SMOKE_PASSWORD` bằng biến môi trường hoặc secret của runner; không truyền mật khẩu trên dòng lệnh, ghi vào tài liệu hay commit vào repo. Thêm `--exercise` vào lệnh trên.

Luồng ghi thực hiện đăng nhập/làm mới token và kiểm tài khoản thường bị chặn admin. Sau đó tạo một chuyến `SMOKE <uuid>`, một participant, khoản chia đôi 100.000đ và khoản 1đ riêng của owner. Gửi lại khoản đầu với cùng key phải trả cùng ID, tổng chỉ 100.001đ, số dư +50.000đ/-50.000đ. Kiểm tra operation và hai trang lọc khoản chi cùng ngày, tạo/xác nhận trả nợ 50.000đ bằng owner rồi chốt chuyến khi mọi số dư bằng 0.

Không đăng ký, xóa tài khoản, sửa chuyến có sẵn hay reset dữ liệu. Chuyến thử được giữ ở trạng thái archived để tra cứu. Nếu thất bại giữa chừng, report lưu tripId đã biết và các key có `confirmed: false`; tra operation bằng chính tài khoản thử trước khi xử lý thủ công. Không tự gửi bù hoặc xóa sổ tiền để che một lần chạy lỗi. Mỗi lần chạy lại tạo chuyến mới, cần tính quota của tài khoản thử.

## Diễn tập local và CI

Đặt cùng `RELEASE_COMMIT` cho build FE, tiến trình API và terminal kiểm thử. Local dùng project `demo-sharebill`, `APP_ENVIRONMENT=local`, `NEXT_PUBLIC_APP_ENVIRONMENT=local`; chạy Auth/Firestore/Storage Emulator. Không bật `NODE_ENV=production` cho API Emulator.

```powershell
$env:RELEASE_COMMIT = git rev-parse HEAD
pnpm.cmd --dir fe build
pnpm.cmd --dir be build
# Mở API và FE static cổng 3001/3000 ở các terminal riêng.
# Terminal API cũng phải có RELEASE_COMMIT ở trên.
$env:SHAREBILL_PWA_TEST = '1'
$env:SHAREBILL_SMOKE_REPORT = Join-Path $env:TEMP 'sharebill-smoke-local.json'
pnpm.cmd --dir fe test:browser
```

Bộ browser tạo tài khoản synthetic trên Emulator và chạy smoke exercise cùng sáu hành trình hiện có. CI frontend build và chạy API cùng `${{ github.sha }}`, lưu report tối đa 7 ngày; backend CI chạy thêm `pnpm test:smoke`. Lockfile đã đồng bộ dependency Firebase của frontend; `pnpm install --frozen-lockfile` đạt sau cập nhật.

Ngày 19/11 đã đạt frozen install, build/typecheck FE/BE, 29 unit/HTTP và 24 kiểm thử cấu hình release, 54 kiểm thử Emulator, 6 kiểm thử smoke CLI, cùng 7 hành trình browser trên Chrome chạy tự động. Diễn tập local sử dụng SHA HEAD làm giá trị đối chiếu trên working tree đang sửa; đây là bằng chứng cho cơ chế kiểm, **không phải** bằng chứng artifact cloud đã phát hành từ SHA đó.

## Cổng S18 còn mở

### Kiểm toàn bộ composite index

`pnpm smoke:indexes --project sharebill-staging --trip <synthetic-trip-uuid> --uid <synthetic-owner-uid> --report index-smoke.json` dùng access token Google ngắn hạn trong biến `FIRESTORE_SMOKE_ACCESS_TOKEN` của trusted runner. Không truyền token trong tham số, commit token hoặc ghi token vào report. CLI không tự đọc phiên đăng nhập cá nhân hay file `.env` local.

Lệnh đối chiếu đủ 18 index trong cấu hình với metadata Firestore cloud, gồm chiều sort `__name__`, và dừng trước query nếu thiếu index hoặc chưa READY. Khi đủ, chạy một query giới hạn 1, chỉ projection tên tài liệu cho mỗi index; không trả tên/nội dung tài liệu vào report. Các query ledger nằm trong chuyến synthetic đã nêu; các query admin/worker kiểm collection gốc và group receipt. Có hash SHA-256 cấu hình index trong report để đối chiếu release. Đây là công cụ chỉ đọc, không deploy index hay sửa dữ liệu. Test CLI nằm trong `pnpm test:smoke` (10 kiểm thử).

Cần build/deploy cùng SHA thật lên staging, deploy/đợi indexes Ready rồi chạy smoke với cấu hình và credential staging. Smoke hiện kiểm một query index khoản chi và cursor, chưa bao phủ toàn bộ inventory index. Còn nghiệm thu Google operator thực, bucket/IAM/CORS/URL ảnh hết hạn, Auth trên domain và thiết bị thật. Backup/restore, lịch worker và rollback vẫn thuộc S19/S20. Mỗi report đạt chỉ áp dụng cho phạm vi `coverage` của lần chạy đó.
