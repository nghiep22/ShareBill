# ShareBill — 02 — Các luồng nghiệp vụ backend còn thiếu

[Danh mục và thứ tự thực hiện](README.md) · [Thiết kế CSDL](../DATABASE.md) · [Hợp đồng API](../BACKEND.md)

Mỗi lát bổ sung một hành động nghiệp vụ hoặc một cặp hành động có cùng ràng buộc. Demo bằng API trên emulator trước khi ghép giao diện.

**Số lát cắt: 19.** Trạng thái ban đầu đều **Chưa làm**. File hiện có là điểm sửa; đường dẫn ghi “mới” hoặc tên module chưa tồn tại là vị trí dự kiến. Mỗi lát cập nhật hợp đồng API/schema liên quan nếu có thay đổi.

## Danh sách nhanh

| Mã | Kết quả cần làm | Phụ thuộc |
| --- | --- | --- |
| [B01](#b01) | Sửa thông tin chuyến | [D03](01_DATABASE_BE.md#d03), [D08](01_DATABASE_BE.md#d08), [D09](01_DATABASE_BE.md#d09) |
| [B02](#b02) | Đổi tên và ngừng chia cho participant | [D04](01_DATABASE_BE.md#d04), [D08](01_DATABASE_BE.md#d08), [D09](01_DATABASE_BE.md#d09) |
| [B03](#b03) | Liên kết hoặc gỡ liên kết danh tính | [D14](01_DATABASE_BE.md#d14), [D08](01_DATABASE_BE.md#d08), [D09](01_DATABASE_BE.md#d09) |
| [B04](#b04) | Tạo lời mời chỉ lưu token hash | [D03](01_DATABASE_BE.md#d03), [D09](01_DATABASE_BE.md#d09) |
| [B05](#b05) | Liệt kê và thu hồi lời mời | [B04](#b04), [D19](01_DATABASE_BE.md#d19) |
| [B06](#b06) | Xem trước lời mời an toàn | [B04](#b04) |
| [B07](#b07) | Nhận lời mời với membership chưa linked | [B05](#b05), [B06](#b06), [D09](01_DATABASE_BE.md#d09) |
| [B08](#b08) | Gỡ quyền một thành viên | [B07](#b07) |
| [B09](#b09) | Khôi phục thành viên cũ | [B08](#b08) |
| [B10](#b10) | Chuyển chủ chuyến | [B03](#b03), [B09](#b09) |
| [B11](#b11) | Sửa khoản chi bằng delta cũ và mới | [D05](01_DATABASE_BE.md#d05), [D06](01_DATABASE_BE.md#d06), [D08](01_DATABASE_BE.md#d08), [D09](01_DATABASE_BE.md#d09) |
| [B12](#b12) | Hủy đề nghị trả nợ chưa xác nhận | [D07](01_DATABASE_BE.md#d07), [D09](01_DATABASE_BE.md#d09) |
| [B13](#b13) | Đảo lượt trả nợ đã xác nhận | [B12](#b12), [D06](01_DATABASE_BE.md#d06) |
| [B14](#b14) | Lưu trữ chuyến đã cân bằng | [B05](#b05), [B11](#b11), [B13](#b13) |
| [B15](#b15) | Mở lại chuyến đã lưu trữ | [B14](#b14) |
| [B16](#b16) | Đọc lịch sử hoạt động theo trang | [D08](01_DATABASE_BE.md#d08), [D18](01_DATABASE_BE.md#d18), [D19](01_DATABASE_BE.md#d19) |
| [B17](#b17) | Tra kết quả một operation sau timeout | [D09](01_DATABASE_BE.md#d09), [D17](01_DATABASE_BE.md#d17) |
| [B18](#b18) | Hoàn thiện hợp đồng HTTP cho FE khác origin | [D09](01_DATABASE_BE.md#d09) |
| [B19](#b19) | Repair projection có kiểm soát | [D11](01_DATABASE_BE.md#d11), [D12](01_DATABASE_BE.md#d12), [D16](01_DATABASE_BE.md#d16) |

## Chi tiết từng lát cắt

### B01

**Sửa thông tin chuyến**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D03](01_DATABASE_BE.md#d03), [D08](01_DATABASE_BE.md#d08), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** Owner sửa tên/địa điểm/ngày/note qua API.

**Phạm vi file/module:** `be/src/routes.ts`, `be/src/schemas.ts`.

**Việc làm:** PATCH allowlist, If-Match, dates/timezone, version/revision/signal/audit; giữ nguyên ledgerVersion.

**Kiểm thử:** Owner/member/outsider, version cũ, ngày sai; sửa tên không đổi tiền.

**Hoàn tất khi:** Metadata đổi đúng; conflict không ghi đè; currency/owner/counters không nhận từ body.

### B02

**Đổi tên và ngừng chia cho participant**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D04](01_DATABASE_BE.md#d04), [D08](01_DATABASE_BE.md#d08), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** Owner đổi tên hoặc đặt participant inactive mà giữ lịch sử.

**Phạm vi file/module:** `be/src/routes.ts`, schema/service participant.

**Việc làm:** PATCH name/status với version; kiểm quyền; expense cũ giữ shares; inactive vẫn hiện balance và trả nợ.

**Kiểm thử:** Inactive bị chặn ở expense mới; rename không đổi amounts; owner membership vẫn quản lý được.

**Hoàn tất khi:** Không hard delete; tổng tiền và số dư cũ không thay đổi.

### B03

**Liên kết hoặc gỡ liên kết danh tính**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D14](01_DATABASE_BE.md#d14), [D08](01_DATABASE_BE.md#d08), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** Owner gắn đúng một UID với đúng một participant.

**Phạm vi file/module:** `be/src/services/participant-link.ts` (mới), routes membership/participant.

**Việc làm:** Transaction kiểm ba chiều link/membership/participant; dọn link cũ khi unlink; audit lý do; không sửa ledger.

**Kiểm thử:** Hai request tranh một participant/UID, người bị gỡ membership, link trỏ chuyến khác.

**Hoàn tất khi:** Không UID có hai participants và không participant bị hai UID nhận cùng lúc.

### B04

**Tạo lời mời chỉ lưu token hash**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D03](01_DATABASE_BE.md#d03), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** Owner tạo link có hạn và số lượt.

**Phạm vi file/module:** `be/src/services/invites.ts` (mới), invite routes.

**Việc làm:** Sinh token; lưu hash lookup+invite/epoch/quota; raw trả một lần; operation không lưu raw token.

**Kiểm thử:** Owner/outsider, key retry sau mất response, expiry/maxUses input.

**Hoàn tất khi:** Firestore/audit/log không có raw token; response retry giải thích token không được trả lại.

### B05

**Liệt kê và thu hồi lời mời**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [B04](#b04), [D19](01_DATABASE_BE.md#d19).

**Kết quả:** Owner nhìn thấy và revoke các invite đã tạo.

**Phạm vi file/module:** Invite routes, query invite trong service.

**Việc làm:** List không raw token; revoke dùng If-Match/key, được phép khi trip archived; ghi audit/revision thích hợp.

**Kiểm thử:** List/revoke sai quyền, revoke hai lần, version cũ.

**Hoàn tất khi:** Link đã revoke không được accept; không lộ token qua list.

### B06

**Xem trước lời mời an toàn**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [B04](#b04).

**Kết quả:** Người đăng nhập thấy tên chuyến/người mời trước khi join.

**Phạm vi file/module:** Invite routes/service.

**Việc làm:** POST token trong body; kiểm hạn/epoch/trip/status/quota; DTO tối thiểu; không ghi mutation.

**Kiểm thử:** Token sai/hết hạn/revoked, trip archived/suspended, log không chứa token.

**Hoàn tất khi:** Không lộ ledger/memberships và không tiêu thụ lượt dùng khi preview.

### B07

**Nhận lời mời với membership chưa linked**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [B05](#b05), [B06](#b06), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** User join chuyến mà không tự nhận participant đã có.

**Phạm vi file/module:** Invite accept service, memberships/tripRefs writers.

**Việc làm:** Transaction kiểm user/lookup/invite/trip/membership/op; thêm membership unlinked/tripRef, counters/usage, signal/audit.

**Kiểm thử:** Accept đồng thời lượt cuối; active join lại; removed join lại; quá quota50.

**Hoàn tất khi:** Không vượt maxUses/counters; active join lại không tăng lượt; removed phải restore riêng.

### B08

**Gỡ quyền một thành viên**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [B07](#b07).

**Kết quả:** Owner gỡ quyền truy cập của member và giữ sổ tiền.

**Phạm vi file/module:** Membership service/routes.

**Việc làm:** Set removed, tripRef removed, version/revision/signal/audit; giữ participant/link đến khi owner xử lý riêng.

**Kiểm thử:** Gỡ chính owner bị chặn; member mutation cạnh tranh; tripRef cũ không cấp quyền.

**Hoàn tất khi:** Token còn hợp lệ nhưng member removed không đọc/ghi được chuyến.

### B09

**Khôi phục thành viên cũ**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [B08](#b08).

**Kết quả:** Owner restore đúng UID đã từng tham gia.

**Phạm vi file/module:** Membership service/routes.

**Việc làm:** Restore membership/tripRef, giữ joinedAt và all-time count; không tạo participant mới; audit.

**Kiểm thử:** Restore lại cùng key, UID chưa từng là member, participant link đã thay đổi.

**Hoàn tất khi:** Không tăng membershipCountAllTime lần hai; liên kết còn đúng hoặc yêu cầu owner xử lý rõ.

### B10

**Chuyển chủ chuyến**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [B03](#b03), [B09](#b09).

**Kết quả:** Chuyến luôn có đúng một owner active khi chuyển chủ.

**Phạm vi file/module:** Trip/membership service/routes.

**Việc làm:** Transaction kiểm owner hiện tại/người nhận active và đã linked; đổi root owner và hai roles; version/audit/op.

**Kiểm thử:** Hai lệnh chuyển chủ đồng thời, người nhận removed/unlinked, quyền owner cũ sau commit.

**Hoàn tất khi:** Không có thời điểm commit với 0 hoặc 2 owners; tiền không đổi.

### B11

**Sửa khoản chi bằng delta cũ và mới**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D05](01_DATABASE_BE.md#d05), [D06](01_DATABASE_BE.md#d06), [D08](01_DATABASE_BE.md#d08), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** Creator/owner sửa expense active mà số dư vẫn khớp.

**Phạm vi file/module:** Expense service/routes, schemas và money domain.

**Việc làm:** PATCH If-Match; đảo delta cũ+cộng mới; cập nhật category totals/stats/participants và snapshot audit; giữ all-time count.

**Kiểm thử:** Equal→exact, đổi payer/category/amount, conflict, retry, participant inactive.

**Hoàn tất khi:** Tổng net=0, total/category totals đúng; expense void không sửa được.

### B12

**Hủy đề nghị trả nợ chưa xác nhận**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D07](01_DATABASE_BE.md#d07), [D09](01_DATABASE_BE.md#d09).

**Kết quả:** Creator/owner cancel pending.

**Phạm vi file/module:** `be/src/finance-routes.ts`, settlement service.

**Việc làm:** Version/state check, status cancelled, pending counter/revision/signal/audit/op; không áp delta tiền.

**Kiểm thử:** Confirm và cancel cạnh tranh; cancel lặp; sai actor.

**Hoàn tất khi:** Chỉ một state transition thắng; balances và ledgerVersion không đổi do cancel.

### B13

**Đảo lượt trả nợ đã xác nhận**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [B12](#b12), [D06](01_DATABASE_BE.md#d06).

**Kết quả:** Owner void confirmed settlement có lý do.

**Phạm vi file/module:** Settlement service/routes.

**Việc làm:** Đảo sent/received/net, giữ thông tin confirm cũ; version/revision/ledgerVersion/signal/audit/op.

**Kiểm thử:** Void sau partial payment, hai lần void, member cố void, trip archived.

**Hoàn tất khi:** Delta đảo đúng một lần; không sửa expense để bù tiền.

### B14

**Lưu trữ chuyến đã cân bằng**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [B05](#b05), [B11](#b11), [B13](#b13).

**Kết quả:** Owner archive khi mọi net=0 và không còn pending.

**Phạm vi file/module:** Trip archive service/routes.

**Việc làm:** Đọc balances/counters/version trong transaction; set archived/archivedAt, inviteEpoch++, signal/audit/op.

**Kiểm thử:** Net khác0, còn pending, create expense cạnh tranh, dùng lại invite cũ.

**Hoàn tất khi:** Chuyến archived chặn ghi nghiệp vụ; ledgerVersion không tăng vì archive.

### B15

**Mở lại chuyến đã lưu trữ**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [B14](#b14).

**Kết quả:** Owner reopen để tiếp tục ghi nhận.

**Phạm vi file/module:** Trip reopen service/routes.

**Việc làm:** If-Match/key; active, archivedAt theo hợp đồng, version/revision/signal/audit; epoch không hồi lại.

**Kiểm thử:** Reopen lặp, non-owner, link invite trước archive.

**Hoàn tất khi:** Chuyến ghi được sau reopen; link cũ vẫn vô hiệu và lịch sử không mất.

### B16

**Đọc lịch sử hoạt động theo trang**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D08](01_DATABASE_BE.md#d08), [D18](01_DATABASE_BE.md#d18), [D19](01_DATABASE_BE.md#d19).

**Kết quả:** Member active xem lịch sử mutation của chuyến.

**Phạm vi file/module:** `be/src/read-routes.ts`, audit query/DTO.

**Việc làm:** GET activity, cursor createdAt+ID, DTO allowlist; không trả admin audit hoặc token.

**Kiểm thử:** Nhiều trang, thời điểm trùng, outsider/removed, event legacy có trường thiếu.

**Hoàn tất khi:** Timeline đúng thứ tự; không lộ nội dung quản trị nội bộ.

### B17

**Tra kết quả một operation sau timeout**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D09](01_DATABASE_BE.md#d09), [D17](01_DATABASE_BE.md#d17).

**Kết quả:** Client hỏi outcome bằng key trước khi tự cho rằng giao dịch thất bại.

**Phạm vi file/module:** Operation read route/service.

**Việc làm:** GET operations/:key; chỉ actor và quyền hiện tại; trả committed/result/status nhỏ; định nghĩa not-found/unknown outcome.

**Kiểm thử:** Key khác UID, mất membership sau commit, legacy key, key chưa tồn tại.

**Hoàn tất khi:** Không lộ snapshot khi mất quyền; FE có thể giữ key/body để retry an toàn.

### B18

**Hoàn thiện hợp đồng HTTP cho FE khác origin**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D09](01_DATABASE_BE.md#d09).

**Kết quả:** Frontend deploy riêng gọi được protected API và nhận lỗi nhất quán.

**Phạm vi file/module:** `be/src/app.ts`, `be/src/http.ts`, response helpers (mới nếu cần).

**Việc làm:** CORS theo allowlist, If-Match trong preflight, expose ETag/request-id theo hợp đồng, private no-store cho response user, map lỗi input/JSON; không log token/body.

**Kiểm thử:** HTTP tests preflight GET/POST/PATCH với If-Match; origin lạ bị chặn; malformed JSON và lỗi validation.

**Hoàn tất khi:** Không dùng CORS wildcard cho dữ liệu private; API đổi version dùng được từ FE thật.

### B19

**Repair projection có kiểm soát**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D11](01_DATABASE_BE.md#d11), [D12](01_DATABASE_BE.md#d12), [D16](01_DATABASE_BE.md#d16).

**Kết quả:** Operator sửa projection sai từ ledger nguồn với diff được kiểm trước.

**Phạm vi file/module:** `be/scripts/repair-projections.ts` (mới), maintenance service.

**Việc làm:** Dry-run mặc định; backup reference, maintenance fence, expected ledgerVersion/revision; commit projection+signal/audit/job; không sửa ledger; chạy cloud chỉ sau backup đã xác minh.

**Kiểm thử:** Emulator: version thay đổi sau diff, writer cạnh tranh, rerun repair và scope sai.

**Hoàn tất khi:** Không áp diff cũ; repair xong checker không lệch; không có public endpoint sửa balance.
