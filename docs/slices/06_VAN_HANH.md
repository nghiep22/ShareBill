# ShareBill — CI/CD, offline và vận hành

[Danh mục 20 lát cắt](README.md) · [Thiết kế CSDL](../DATABASE.md) · [Hợp đồng API](../BACKEND.md)

Kiểm hành trình qua browser, chạy staging và diễn tập khôi phục trước cổng phát hành production.

## S17

**CI browser, realtime và offline**

- **Trạng thái** Đã có browser CI, polling có kiểm quyền, PWA và nháp opt-in. Còn nghiệm thu thiết bị thật
- **Phụ thuộc** [S12](04_FRONTEND_APP.md#s12), [S13](04_FRONTEND_APP.md#s13)
- **Kết quả** Đưa frontend vào CI, kiểm hành trình browser, cập nhật qua signal và bổ sung PWA, snapshot offline, bản nháp opt-in.
- **Nghiệm thu** E2E chạy qua FE/API/DB. Realtime phản ánh thu hồi quyền. PWA giữ bản nháp qua update và yêu cầu người dùng gửi lại giao dịch khi online.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="o01"></a>

**O01 · Đưa frontend vào CI**

- **Kết quả** PR kiểm được FE cùng với BE đang có.
- **Phạm vi file/module** FE package scripts, `.github/workflows/`.
- **Việc làm** Install frozen lockfile, FE typecheck/build và component tests trọng yếu; demo config không secret; lưu artifact phù hợp.
- **Kiểm thử** PR fixture có lỗi type/build làm job fail; workflow không chạy với credential production.
- **Hoàn tất khi** Một check đỏ chặn release; không cài lại phiên bản ngẫu nhiên mỗi lần CI.

<a id="o02"></a>

**O02 · Một hành trình browser xuyên suốt**

- **Kết quả** Browser test auth→trip→expense→balances→confirm trả nợ bằng dữ liệu giả.
- **Phạm vi file/module** `fe/e2e/` hoặc test folder đã chọn, CI emulator job.
- **Việc làm** Seed namespace riêng; kiểm UI/số tiền và permission; thêm case retry/conflict có ý nghĩa; không dùng tài khoản cá nhân.
- **Kiểm thử** Chạy trên CI; test thất bại khi UI báo saved trước commit hoặc số dư lệch.
- **Hoàn tất khi** Chứng minh FE/API/DB nối được cùng một hành trình, không chỉ từng unit rời.

<a id="o03"></a>

**O03 · Realtime invalidation theo signal**

Triển khai hiện tại dùng REST signal kiểm quyền mỗi 30 giây khi tab đang hiện, cùng revalidation ở foreground/reconnect/chuyển màn hình. Client Rules tiếp tục deny toàn bộ. SDK listener ở các bước dưới là phương án có thể bổ sung sau khi đo tải. [Mã workspace](../../fe/src/connected-workspace.tsx)

- **Kết quả** Tab đang mở nhận biết dữ liệu/quyền thay đổi.
- **Phạm vi file/module** `be/firestore.rules`, signal/membership subscription FE.
- **Việc làm** Chỉ mở Rules đọc signal và own membership theo hợp đồng; SDK listener cleanup; revision tăng invalidate queries; không stream ledger toàn bộ.
- **Kiểm thử** Rules emulator: outsider/removed/admin không member; hai tab, unmount, reconnect.
- **Hoàn tất khi** Member mới thấy dữ liệu sau refresh; removed mất view private; không mở client read sổ tiền.

<a id="o04"></a>

**O04 · PWA shell và cập nhật phiên bản**

- **Kết quả** Cài app lên màn hình chính và mở offline page.
- **Phạm vi file/module** Manifest/icons/service worker/offline page FE.
- **Việc làm** HTTPS/manifest/icons, shell cache allowlist; bỏ qua API/admin/Auth/ảnh signed; update prompt khi có draft.
- **Kiểm thử** Install trên thiết bị thật; service worker update khi đang nhập form; không cache private response.
- **Hoàn tất khi** App cài được; update không làm mất draft hoặc phục vụ dữ liệu user khác.

<a id="o05"></a>

**O05 · Bản nháp và snapshot offline có opt-in**

- **Kết quả** Thiết bị tin cậy lưu draft/snapshot tách theo UID.
- **Phạm vi file/module** `fe/src/features/offline/` (mới), IndexedDB adapter.
- **Việc làm** Opt-in, timestamp/stale banner; offline chỉ soạn nháp; online kiểm lại quyền/participants/version và yêu cầu user gửi; logout/xóa cache đúng partition.
- **Kiểm thử** Mất mạng giữa submit, đổi UID, draft cũ, quyền bị gỡ, full quota storage.
- **Hoàn tất khi** Không auto commit tiền khi có mạng trở lại và không hiển thị 'đã lưu' cho draft chưa gửi.

</details>

## S18

**Cloud staging và smoke test**

- **Trạng thái** Đã deploy FE/API cùng SHA, CI, Auth/tiền/index cloud và browser 390px đạt. Còn Google operator, bucket ảnh và thiết bị thật
- **Phụ thuộc** [S16](05_ADMIN_HO_TRO.md#s16), [S17](#s17)
- **Kết quả** Cấu hình Firebase/Vercel staging, deploy BE/FE/admin và smoke các index/cursor trên Firestore thật.
- **Nghiệm thu** Health, Auth, preflight, luồng browser và admin guard đạt trên staging đúng SHA. Chạy query sau khi index ready và lưu kết quả.

[Công cụ và runbook smoke S18](../STAGING_SMOKE.md) kiểm FE/API cùng SHA/project/môi trường, CORS, guard và luồng tiền trong chuyến synthetic riêng. Kết quả Emulator không thay bằng chứng IAM/index/Google/bucket cloud.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="o06"></a>

**O06 · Tạo và cấu hình môi trường cloud staging**

- **Kết quả** Có Auth/Firestore/Storage staging tách khỏi demo và production.
- **Phạm vi file/module** Cloud setup/runbook và env examples.
- **Việc làm** Project/region phù hợp, Email/Password, admin provider theo kế hoạch, IAM/credentials, deny Rules, billing Storage cần thiết, budget/rate controls; không commit secret.
- **Kiểm thử** Auth test account và server-only connectivity; check project identity; cloud config checklist có kết quả.
- **Hoàn tất khi** Staging không dùng demo key/host; không mở DB test mode; các giá trị cần FE/BE được phân biệt rõ.

<a id="o07"></a>

**O07 · Deploy backend staging**

- **Kết quả** API staging chạy đúng commit và Firebase project.
- **Phạm vi file/module** Vercel backend project/config và workflow deploy.
- **Việc làm** Root be, env/secrets/origin thật, runtime/build theo host; health và protected smoke; deploy không tự chạy migration.
- **Kiểm thử** Health, register/login/token, create/read trip và preflight từ origin staging.
- **Hoàn tất khi** Release SHA truy được; API không trỏ production và không lộ credential.

<a id="o08"></a>

**O08 · Deploy frontend và website quản trị staging**

- **Kết quả** FE và admin gọi được API staging từ domain thật.
- **Phạm vi file/module** Vercel FE project/config và workflow deploy.
- **Việc làm** Root fe, public config đúng scope, Auth domains/CORS; build cùng SHA; browser smoke login→trip và admin guard.
- **Kiểm thử** Thiết bị360px, login/refresh, request If-Match, user thường vào adminURL.
- **Hoàn tất khi** Không gọi localhost/demo/prod từ staging; route admin có API guard.

<a id="o09"></a>

**O09 · Smoke index và cursor trên Firestore thật**

- **Kết quả** Từng IX01..18 dùng được trên cloud và phân trang đúng.
- **Phạm vi file/module** Index deployment và staging query smoke scripts (mới).
- **Việc làm** Deploy index/Rules theo cấu hình, đợi ready, seed synthetic scope, chạy query real credentials; ghi report index/query/cursor.
- **Kiểm thử** Tất cả composite inventory, ngày/timestamp trùng, filter sai và cursor stale.
- **Hoàn tất khi** Không missing-index; không xem pass emulator là bằng chứng cho index cloud.

</details>

## S19

**Workers, backup, restore và sửa sai lệch**

- **Trạng thái** Đang làm: log HTTP và worker đối soát từng lượt có lease/checkpoint/summary admin. Còn lịch cloud, backup/restore, repair và cảnh báo
- **Phụ thuộc** [S18](#s18)
- **Kết quả** Lập lịch worker và reconcile, cấu hình backup, triển khai repair projection có kiểm soát, diễn tập restore và thiết lập cảnh báo.
- **Nghiệm thu** Kiểm retry/lease, backup có scope, restore đo RPO/RTO và repair chỉ áp khi version còn khớp. Checker sau repair đạt và cảnh báo đến người phụ trách.

[Log HTTP và cách tra lỗi](../OPERATIONS_LOGGING.md) đã có trong runtime; không ghi query/body/exception tự do. Các kiểm thử riêng kiểm dữ liệu riêng tư và mã request.

[Worker đối soát từng lượt](../LEDGER_RECONCILIATION.md) có CLI, lease chống trùng, retry có giới hạn và summary trong Hệ thống. Nguồn tiền chỉ đọc; chưa lên lịch cloud.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="o10"></a>

**O10 · Lập lịch workers và reconcile chỉ đọc**

- **Kết quả** Auth sync, cleanup và reconcile được kích hoạt có kiểm soát.
- **Phạm vi file/module** Scheduler/trusted worker endpoints/workflows và job runbook.
- **Việc làm** Service identity, schedule/retry/timeouts/lease và checkpoint; query scope bounded; summary cho admin; reconcile không tự repair.
- **Kiểm thử** Duplicate trigger, job chạy quá lease, worker crash, lỗi auth scheduler.
- **Hoàn tất khi** Một việc không có hai owner commit; failed job có thể truy được và không retry vô hạn.

<a id="o11"></a>

**O11 · Cấu hình backup cho dữ liệu và ảnh**

- **Kết quả** Có bản backup phục vụ restore theo scope đã chọn.
- **Phạm vi file/module** Backup/export configuration và runbook.
- **Việc làm** Firestore schedule/retention, phương án Auth identity và Storage bytes, IAM bucket backup, inventory collection con; ghi job/result summary.
- **Kiểm thử** Một lần backup thật trên staging; kiểm đủ collections/subcollections và object references; không đưa export vào public artifact.
- **Hoàn tất khi** Có backupId/thời điểm/scope rõ; chưa diễn tập restore thì chưa báo đạt RPO/RTO.

<a id="b19"></a>

**B19 · Repair projection có kiểm soát**

- **Kết quả** Operator sửa projection sai từ ledger nguồn với diff được kiểm trước.
- **Phạm vi file/module** `be/scripts/repair-projections.ts` (mới), maintenance service.
- **Việc làm** Dry-run mặc định; backup reference, maintenance fence, expected ledgerVersion/revision; commit projection+signal/audit/job; không sửa ledger; chạy cloud chỉ sau backup đã xác minh.
- **Kiểm thử** Emulator: version thay đổi sau diff, writer cạnh tranh, rerun repair và scope sai.
- **Hoàn tất khi** Không áp diff cũ; repair xong checker không lệch; không có public endpoint sửa balance.

<a id="o12"></a>

**O12 · Diễn tập restore và repair**

- **Kết quả** Khôi phục vào project/database cách ly và chứng minh sổ tiền đúng.
- **Phạm vi file/module** Restore rehearsal report/runbook, checker/repair scripts.
- **Việc làm** Restore Firestore+Auth/Storage theo scope, Rules/indexes/TTL config, checker, ảnh referenced, auth/API smoke; đo thời gian.
- **Kiểm thử** Làm hỏng projection synthetic rồi dry-run/repair đúng version; kiểm net/category/counter0diff.
- **Hoàn tất khi** Có báo cáo thực đo và dữ liệu phục hồi dùng được; không import đè live writer.

<a id="o13"></a>

**O13 · Log, metrics và cảnh báo vận hành**

- **Kết quả** Phát hiện lỗi auth/transaction/jobs/backup và tra bằng requestId.
- **Phạm vi file/module** Logging/redaction, monitoring dashboard/rules và runbook.
- **Việc làm** Không log password/JWT/raw token/note; metrics lỗi/latency/lease retry, backup quá hạn; alert có người nhận và hướng xử lý đã cấu hình.
- **Kiểm thử** Synthetic failure, secret redaction, job fail/backup stale, requestId nối FE↔BE.
- **Hoàn tất khi** Có cảnh báo hành động được; không có PII/secret trong log hoặc public test artifacts.

</details>

## S20

**Nghiệm thu và phát hành production**

- **Trạng thái** Chưa làm
- **Phụ thuộc** [S14](04_FRONTEND_APP.md#s14), [S19](#s19)
- **Kết quả** Đối chiếu tiêu chí P0, usability, migration, backup và rollback trước khi promote SHA từ staging.
- **Nghiệm thu** Release gate chặn lỗi tiền/quyền/dữ liệu. Smoke mobile, auth, admin, ảnh và ledger trên môi trường production, lưu SHA và người phụ trách.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="o14"></a>

**O14 · Cổng phát hành production**

- **Kết quả** Bản đã nghiệm thu được phát hành đúng môi trường.
- **Phạm vi file/module** Release checklist, production env/workflow và smoke report.
- **Việc làm** Đối chiếu toàn bộ P0/checklists và thử usability app/admin theo tiêu chí 4/5 người mới trong tài liệu UX; production config riêng, migration dry-run/report, backup và rollback; promote SHA đã kiểm; smoke mobile/auth/admin/quyền/ảnh/ledger.
- **Kiểm thử** Kiểm gate đỏ chặn release; canonical domain login, create/read tiền bằng test account có scope, admin guard và rollback rehearsal.
- **Hoàn tất khi** Không còn blocker tiền/quyền/dữ liệu; report ghi SHA/môi trường/kết quả và người chịu trách nhiệm vận hành.

</details>
