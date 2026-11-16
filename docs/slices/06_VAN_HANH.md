# ShareBill — 06 — CI/CD, realtime, offline và phát hành

[Danh mục và thứ tự thực hiện](README.md) · [Thiết kế CSDL](../DATABASE.md) · [Hợp đồng API](../BACKEND.md)

Các lát cloud có thể chuẩn bị sớm khi dependencies đủ; không cần chờ mọi giao diện xong mới tạo staging. Chỉ O14 là gate phát hành production; từng lần triển khai phải dùng đúng project và commit đã kiểm.

**Số lát cắt: 14.** Trạng thái ban đầu đều **Chưa làm**. File hiện có là điểm sửa; đường dẫn ghi “mới” hoặc tên module chưa tồn tại là vị trí dự kiến. Mỗi lát cập nhật hợp đồng API/schema liên quan nếu có thay đổi.

## Danh sách nhanh

| Mã | Kết quả cần làm | Phụ thuộc |
| --- | --- | --- |
| [O01](#o01) | Đưa frontend vào CI | [F01](04_FRONTEND_APP.md#f01), [F03](04_FRONTEND_APP.md#f03) |
| [O02](#o02) | Một hành trình browser xuyên suốt | [O01](#o01), [F05](04_FRONTEND_APP.md#f05), [F10](04_FRONTEND_APP.md#f10), [F13](04_FRONTEND_APP.md#f13), [F16](04_FRONTEND_APP.md#f16) |
| [O03](#o03) | Realtime invalidation theo signal | [D03](01_DATABASE_BE.md#d03), [B08](02_NGHIEP_VU_BE.md#b08), [F06](04_FRONTEND_APP.md#f06), [F08](04_FRONTEND_APP.md#f08) |
| [O04](#o04) | PWA shell và cập nhật phiên bản | [F01](04_FRONTEND_APP.md#f01), [O01](#o01) |
| [O05](#o05) | Bản nháp và snapshot offline có opt-in | [O04](#o04), [F09](04_FRONTEND_APP.md#f09), [F12](04_FRONTEND_APP.md#f12), [F25](04_FRONTEND_APP.md#f25) |
| [O06](#o06) | Tạo và cấu hình môi trường cloud staging | [D11](01_DATABASE_BE.md#d11), [B18](02_NGHIEP_VU_BE.md#b18) |
| [O07](#o07) | Deploy backend staging | [O06](#o06), [B18](02_NGHIEP_VU_BE.md#b18) |
| [O08](#o08) | Deploy frontend và website quản trị staging | [O07](#o07), [O02](#o02), [A02](05_ADMIN_HO_TRO.md#a02) |
| [O09](#o09) | Smoke index và cursor trên Firestore thật | [O07](#o07), [D20](01_DATABASE_BE.md#d20), [D21](01_DATABASE_BE.md#d21), [D22](01_DATABASE_BE.md#d22), [A03](05_ADMIN_HO_TRO.md#a03), [A05](05_ADMIN_HO_TRO.md#a05), [A12](05_ADMIN_HO_TRO.md#a12), [A14](05_ADMIN_HO_TRO.md#a14), [I07](03_HOA_DON.md#i07) |
| [O10](#o10) | Lập lịch workers và reconcile chỉ đọc | [O06](#o06), [I07](03_HOA_DON.md#i07), [A08](05_ADMIN_HO_TRO.md#a08), [D11](01_DATABASE_BE.md#d11) |
| [O11](#o11) | Cấu hình backup cho dữ liệu và ảnh | [O06](#o06), [D11](01_DATABASE_BE.md#d11) |
| [O12](#o12) | Diễn tập restore và repair | [O11](#o11), [B19](02_NGHIEP_VU_BE.md#b19), [O09](#o09) |
| [O13](#o13) | Log, metrics và cảnh báo vận hành | [O07](#o07), [O10](#o10), [A17](05_ADMIN_HO_TRO.md#a17) |
| [O14](#o14) | Cổng phát hành production | [I08](03_HOA_DON.md#i08), [F18](04_FRONTEND_APP.md#f18), [F21](04_FRONTEND_APP.md#f21), [F23](04_FRONTEND_APP.md#f23), [F24](04_FRONTEND_APP.md#f24), [A06](05_ADMIN_HO_TRO.md#a06), [A09](05_ADMIN_HO_TRO.md#a09), [A11](05_ADMIN_HO_TRO.md#a11), [A13](05_ADMIN_HO_TRO.md#a13), [A16](05_ADMIN_HO_TRO.md#a16), [O03](#o03), [O05](#o05), [O08](#o08), [O12](#o12), [O13](#o13) |

## Chi tiết từng lát cắt

### O01

**Đưa frontend vào CI**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F01](04_FRONTEND_APP.md#f01), [F03](04_FRONTEND_APP.md#f03).

**Kết quả:** PR kiểm được FE cùng với BE đang có.

**Phạm vi file/module:** FE package scripts, `.github/workflows/`.

**Việc làm:** Install frozen lockfile, FE typecheck/build và component tests trọng yếu; demo config không secret; lưu artifact phù hợp.

**Kiểm thử:** PR fixture có lỗi type/build làm job fail; workflow không chạy với credential production.

**Hoàn tất khi:** Một check đỏ chặn release; không cài lại phiên bản ngẫu nhiên mỗi lần CI.

### O02

**Một hành trình browser xuyên suốt**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [O01](#o01), [F05](04_FRONTEND_APP.md#f05), [F10](04_FRONTEND_APP.md#f10), [F13](04_FRONTEND_APP.md#f13), [F16](04_FRONTEND_APP.md#f16).

**Kết quả:** Browser test auth→trip→expense→balances→confirm trả nợ bằng dữ liệu giả.

**Phạm vi file/module:** `fe/e2e/` hoặc test folder đã chọn, CI emulator job.

**Việc làm:** Seed namespace riêng; kiểm UI/số tiền và permission; thêm case retry/conflict có ý nghĩa; không dùng tài khoản cá nhân.

**Kiểm thử:** Chạy trên CI; test thất bại khi UI báo saved trước commit hoặc số dư lệch.

**Hoàn tất khi:** Chứng minh FE/API/DB nối được cùng một hành trình, không chỉ từng unit rời.

### O03

**Realtime invalidation theo signal**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D03](01_DATABASE_BE.md#d03), [B08](02_NGHIEP_VU_BE.md#b08), [F06](04_FRONTEND_APP.md#f06), [F08](04_FRONTEND_APP.md#f08).

**Kết quả:** Tab đang mở nhận biết dữ liệu/quyền thay đổi.

**Phạm vi file/module:** `be/firestore.rules`, signal/membership subscription FE.

**Việc làm:** Chỉ mở Rules đọc signal và own membership theo hợp đồng; SDK listener cleanup; revision tăng invalidate queries; không stream ledger toàn bộ.

**Kiểm thử:** Rules emulator: outsider/removed/admin không member; hai tab, unmount, reconnect.

**Hoàn tất khi:** Member mới thấy dữ liệu sau refresh; removed mất view private; không mở client read sổ tiền.

### O04

**PWA shell và cập nhật phiên bản**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F01](04_FRONTEND_APP.md#f01), [O01](#o01).

**Kết quả:** Cài app lên màn hình chính và mở offline page.

**Phạm vi file/module:** Manifest/icons/service worker/offline page FE.

**Việc làm:** HTTPS/manifest/icons, shell cache allowlist; bỏ qua API/admin/Auth/ảnh signed; update prompt khi có draft.

**Kiểm thử:** Install trên thiết bị thật; service worker update khi đang nhập form; không cache private response.

**Hoàn tất khi:** App cài được; update không làm mất draft hoặc phục vụ dữ liệu user khác.

### O05

**Bản nháp và snapshot offline có opt-in**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [O04](#o04), [F09](04_FRONTEND_APP.md#f09), [F12](04_FRONTEND_APP.md#f12), [F25](04_FRONTEND_APP.md#f25).

**Kết quả:** Thiết bị tin cậy lưu draft/snapshot tách theo UID.

**Phạm vi file/module:** `fe/src/features/offline/` (mới), IndexedDB adapter.

**Việc làm:** Opt-in, timestamp/stale banner; offline chỉ soạn nháp; online kiểm lại quyền/participants/version và yêu cầu user gửi; logout/xóa cache đúng partition.

**Kiểm thử:** Mất mạng giữa submit, đổi UID, draft cũ, quyền bị gỡ, full quota storage.

**Hoàn tất khi:** Không auto commit tiền khi có mạng trở lại và không hiển thị 'đã lưu' cho draft chưa gửi.

### O06

**Tạo và cấu hình môi trường cloud staging**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D11](01_DATABASE_BE.md#d11), [B18](02_NGHIEP_VU_BE.md#b18).

**Kết quả:** Có Auth/Firestore/Storage staging tách khỏi demo và production.

**Phạm vi file/module:** Cloud setup/runbook và env examples.

**Việc làm:** Project/region phù hợp, Email/Password, admin provider theo kế hoạch, IAM/credentials, deny Rules, billing Storage cần thiết, budget/rate controls; không commit secret.

**Kiểm thử:** Auth test account và server-only connectivity; check project identity; cloud config checklist có kết quả.

**Hoàn tất khi:** Staging không dùng demo key/host; không mở DB test mode; các giá trị cần FE/BE được phân biệt rõ.

### O07

**Deploy backend staging**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [O06](#o06), [B18](02_NGHIEP_VU_BE.md#b18).

**Kết quả:** API staging chạy đúng commit và Firebase project.

**Phạm vi file/module:** Vercel backend project/config và workflow deploy.

**Việc làm:** Root be, env/secrets/origin thật, runtime/build theo host; health và protected smoke; deploy không tự chạy migration.

**Kiểm thử:** Health, register/login/token, create/read trip và preflight từ origin staging.

**Hoàn tất khi:** Release SHA truy được; API không trỏ production và không lộ credential.

### O08

**Deploy frontend và website quản trị staging**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [O07](#o07), [O02](#o02), [A02](05_ADMIN_HO_TRO.md#a02).

**Kết quả:** FE và admin gọi được API staging từ domain thật.

**Phạm vi file/module:** Vercel FE project/config và workflow deploy.

**Việc làm:** Root fe, public config đúng scope, Auth domains/CORS; build cùng SHA; browser smoke login→trip và admin guard.

**Kiểm thử:** Thiết bị360px, login/refresh, request If-Match, user thường vào adminURL.

**Hoàn tất khi:** Không gọi localhost/demo/prod từ staging; route admin có API guard.

### O09

**Smoke index và cursor trên Firestore thật**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [O07](#o07), [D20](01_DATABASE_BE.md#d20), [D21](01_DATABASE_BE.md#d21), [D22](01_DATABASE_BE.md#d22), [A03](05_ADMIN_HO_TRO.md#a03), [A05](05_ADMIN_HO_TRO.md#a05), [A12](05_ADMIN_HO_TRO.md#a12), [A14](05_ADMIN_HO_TRO.md#a14), [I07](03_HOA_DON.md#i07).

**Kết quả:** Từng IX01..16 dùng được trên cloud và phân trang đúng.

**Phạm vi file/module:** Index deployment và staging query smoke scripts (mới).

**Việc làm:** Deploy index/Rules theo cấu hình, đợi ready, seed synthetic scope, chạy query real credentials; ghi report index/query/cursor.

**Kiểm thử:** Tất cả composite inventory, ngày/timestamp trùng, filter sai và cursor stale.

**Hoàn tất khi:** Không missing-index; không xem pass emulator là bằng chứng cho index cloud.

### O10

**Lập lịch workers và reconcile chỉ đọc**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [O06](#o06), [I07](03_HOA_DON.md#i07), [A08](05_ADMIN_HO_TRO.md#a08), [D11](01_DATABASE_BE.md#d11).

**Kết quả:** Auth sync, cleanup và reconcile được kích hoạt có kiểm soát.

**Phạm vi file/module:** Scheduler/trusted worker endpoints/workflows và job runbook.

**Việc làm:** Service identity, schedule/retry/timeouts/lease và checkpoint; query scope bounded; summary cho admin; reconcile không tự repair.

**Kiểm thử:** Duplicate trigger, job chạy quá lease, worker crash, lỗi auth scheduler.

**Hoàn tất khi:** Một việc không có hai owner commit; failed job có thể truy được và không retry vô hạn.

### O11

**Cấu hình backup cho dữ liệu và ảnh**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [O06](#o06), [D11](01_DATABASE_BE.md#d11).

**Kết quả:** Có bản backup phục vụ restore theo scope đã chọn.

**Phạm vi file/module:** Backup/export configuration và runbook.

**Việc làm:** Firestore schedule/retention, phương án Auth identity và Storage bytes, IAM bucket backup, inventory collection con; ghi job/result summary.

**Kiểm thử:** Một lần backup thật trên staging; kiểm đủ collections/subcollections và object references; không đưa export vào public artifact.

**Hoàn tất khi:** Có backupId/thời điểm/scope rõ; chưa diễn tập restore thì chưa báo đạt RPO/RTO.

### O12

**Diễn tập restore và repair**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [O11](#o11), [B19](02_NGHIEP_VU_BE.md#b19), [O09](#o09).

**Kết quả:** Khôi phục vào project/database cách ly và chứng minh sổ tiền đúng.

**Phạm vi file/module:** Restore rehearsal report/runbook, checker/repair scripts.

**Việc làm:** Restore Firestore+Auth/Storage theo scope, Rules/indexes/TTL config, checker, ảnh referenced, auth/API smoke; đo thời gian.

**Kiểm thử:** Làm hỏng projection synthetic rồi dry-run/repair đúng version; kiểm net/category/counter0diff.

**Hoàn tất khi:** Có báo cáo thực đo và dữ liệu phục hồi dùng được; không import đè live writer.

### O13

**Log, metrics và cảnh báo vận hành**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [O07](#o07), [O10](#o10), [A17](05_ADMIN_HO_TRO.md#a17).

**Kết quả:** Phát hiện lỗi auth/transaction/jobs/backup và tra bằng requestId.

**Phạm vi file/module:** Logging/redaction, monitoring dashboard/rules và runbook.

**Việc làm:** Không log password/JWT/raw token/note; metrics lỗi/latency/lease retry, backup quá hạn; alert có người nhận và hướng xử lý đã cấu hình.

**Kiểm thử:** Synthetic failure, secret redaction, job fail/backup stale, requestId nối FE↔BE.

**Hoàn tất khi:** Có cảnh báo hành động được; không có PII/secret trong log hoặc public test artifacts.

### O14

**Cổng phát hành production**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [I08](03_HOA_DON.md#i08), [F18](04_FRONTEND_APP.md#f18), [F21](04_FRONTEND_APP.md#f21), [F23](04_FRONTEND_APP.md#f23), [F24](04_FRONTEND_APP.md#f24), [A06](05_ADMIN_HO_TRO.md#a06), [A09](05_ADMIN_HO_TRO.md#a09), [A11](05_ADMIN_HO_TRO.md#a11), [A13](05_ADMIN_HO_TRO.md#a13), [A16](05_ADMIN_HO_TRO.md#a16), [O03](#o03), [O05](#o05), [O08](#o08), [O12](#o12), [O13](#o13).

**Kết quả:** Bản đã nghiệm thu được phát hành đúng môi trường.

**Phạm vi file/module:** Release checklist, production env/workflow và smoke report.

**Việc làm:** Đối chiếu toàn bộ P0/checklists và thử usability app/admin theo tiêu chí 4/5 người mới trong tài liệu UX; production config riêng, migration dry-run/report, backup và rollback; promote SHA đã kiểm; smoke mobile/auth/admin/quyền/ảnh/ledger.

**Kiểm thử:** Kiểm gate đỏ chặn release; canonical domain login, create/read tiền bằng test account có scope, admin guard và rollback rehearsal.

**Hoàn tất khi:** Không còn blocker tiền/quyền/dữ liệu; report ghi SHA/môi trường/kết quả và người chịu trách nhiệm vận hành.
