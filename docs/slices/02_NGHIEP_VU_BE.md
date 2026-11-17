# ShareBill — Nghiệp vụ backend

[Danh mục 20 lát cắt](README.md) · [Thiết kế CSDL](../DATABASE.md) · [Hợp đồng API](../BACKEND.md)

Bổ sung các luồng quản lý chuyến, thành viên và giao dịch trên tài liệu Firestore đã chuẩn hóa.

## S07

**Chỉnh thông tin chuyến và người tham gia**

- **Trạng thái** Hoàn tất trên Firebase Emulator; chưa triển khai cloud.
- **Phụ thuộc** [S05](01_DATABASE_BE.md#s05)
- **Kết quả** Sửa metadata chuyến, đổi tên/ngừng chia và liên kết hoặc gỡ UID với participant.
- **Nghiệm thu** Kiểm quyền owner và `If-Match`. Hai request cạnh tranh chỉ tạo liên kết hợp lệ. Lịch sử, số dư và `ledgerVersion` dùng đúng dữ liệu đã ghi.
- **Đã làm** `PATCH /trips/:tripId` chỉ nhận tên/địa điểm/ghi chú/ngày/múi giờ, kiểm khoảng ngày và schema; `PATCH /participants/:id` đổi tên hoặc active/inactive, không xóa lịch sử; `POST /memberships/:uid/link` kiểm ba chiều membership–link–participant trong transaction, gỡ link cũ rồi liên kết đích cùng commit. Cả ba yêu cầu key và `If-Match`, ghi operation/audit/signal, tăng revision; chỉ sửa trip metadata mới tăng trip.version, không đổi ledgerVersion hay số dư.
- **Kiểm chứng** Emulator: owner/member/outsider, version cũ/thiếu, ngày và timezone sai, currency bị từ chối, expense cũ giữ nguyên sau inactive, expense mới bị chặn, hai UID tranh cùng participant, chuyển/gỡ link và removed membership, participant thuộc chuyến khác. `checkDatabase` sạch sau thay đổi.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="b01"></a>

**B01 · Sửa thông tin chuyến**

- **Kết quả** Owner sửa tên/địa điểm/ngày/note qua API.
- **Phạm vi file/module** `be/src/routes.ts`, `be/src/schemas.ts`.
- **Việc làm** PATCH allowlist, If-Match, dates/timezone, version/revision/signal/audit; giữ nguyên ledgerVersion.
- **Kiểm thử** Owner/member/outsider, version cũ, ngày sai; sửa tên không đổi tiền.
- **Hoàn tất khi** Metadata đổi đúng; conflict không ghi đè; currency/owner/counters không nhận từ body.

<a id="b02"></a>

**B02 · Đổi tên và ngừng chia cho participant**

- **Kết quả** Owner đổi tên hoặc đặt participant inactive mà giữ lịch sử.
- **Phạm vi file/module** `be/src/routes.ts`, schema/service participant.
- **Việc làm** PATCH name/status với version; kiểm quyền; expense cũ giữ shares; inactive vẫn hiện balance và trả nợ.
- **Kiểm thử** Inactive bị chặn ở expense mới; rename không đổi amounts; owner membership vẫn quản lý được.
- **Hoàn tất khi** Không hard delete; tổng tiền và số dư cũ không thay đổi.

<a id="b03"></a>

**B03 · Liên kết hoặc gỡ liên kết danh tính**

- **Kết quả** Owner gắn đúng một UID với đúng một participant.
- **Phạm vi file/module** `be/src/services/participant-link.ts` (mới), routes membership/participant.
- **Việc làm** Transaction kiểm ba chiều link/membership/participant; dọn link cũ khi unlink; audit lý do; không sửa ledger.
- **Kiểm thử** Hai request tranh một participant/UID, người bị gỡ membership, link trỏ chuyến khác.
- **Hoàn tất khi** Không UID có hai participants và không participant bị hai UID nhận cùng lúc.

</details>

## S08

**Lời mời và vòng đời thành viên**

- **Trạng thái** Chưa làm
- **Phụ thuộc** [S06](01_DATABASE_BE.md#s06), [S07](#s07)
- **Kết quả** Tạo/list/revoke/preview/accept link mời, gỡ/khôi phục thành viên và chuyển quyền owner.
- **Nghiệm thu** Kiểm hạn, quota, lượt cuối cạnh tranh và replay không lộ token. Người bị gỡ mất quyền dữ liệu. Chuyển quyền luôn để lại đúng một owner active.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="b04"></a>

**B04 · Tạo lời mời chỉ lưu token hash**

- **Kết quả** Owner tạo link có hạn và số lượt.
- **Phạm vi file/module** `be/src/services/invites.ts` (mới), invite routes.
- **Việc làm** Sinh token; lưu hash lookup+invite/epoch/quota; raw trả một lần; operation không lưu raw token.
- **Kiểm thử** Owner/outsider, key retry sau mất response, expiry/maxUses input.
- **Hoàn tất khi** Firestore/audit/log không có raw token; response retry giải thích token không được trả lại.

<a id="b05"></a>

**B05 · Liệt kê và thu hồi lời mời**

- **Kết quả** Owner nhìn thấy và revoke các invite đã tạo.
- **Phạm vi file/module** Invite routes, query invite trong service.
- **Việc làm** List không raw token; revoke dùng If-Match/key, được phép khi trip archived; ghi audit/revision thích hợp.
- **Kiểm thử** List/revoke sai quyền, revoke hai lần, version cũ.
- **Hoàn tất khi** Link đã revoke không được accept; không lộ token qua list.

<a id="b06"></a>

**B06 · Xem trước lời mời an toàn**

- **Kết quả** Người đăng nhập thấy tên chuyến/người mời trước khi join.
- **Phạm vi file/module** Invite routes/service.
- **Việc làm** POST token trong body; kiểm hạn/epoch/trip/status/quota; DTO tối thiểu; không ghi mutation.
- **Kiểm thử** Token sai/hết hạn/revoked, trip archived/suspended, log không chứa token.
- **Hoàn tất khi** Không lộ ledger/memberships và không tiêu thụ lượt dùng khi preview.

<a id="b07"></a>

**B07 · Nhận lời mời với membership chưa linked**

- **Kết quả** User join chuyến mà không tự nhận participant đã có.
- **Phạm vi file/module** Invite accept service, memberships/tripRefs writers.
- **Việc làm** Transaction kiểm user/lookup/invite/trip/membership/op; thêm membership unlinked/tripRef, counters/usage, signal/audit.
- **Kiểm thử** Accept đồng thời lượt cuối; active join lại; removed join lại; quá quota50.
- **Hoàn tất khi** Không vượt maxUses/counters; active join lại không tăng lượt; removed phải restore riêng.

<a id="b08"></a>

**B08 · Gỡ quyền một thành viên**

- **Kết quả** Owner gỡ quyền truy cập của member và giữ sổ tiền.
- **Phạm vi file/module** Membership service/routes.
- **Việc làm** Set removed, tripRef removed, version/revision/signal/audit; giữ participant/link đến khi owner xử lý riêng.
- **Kiểm thử** Gỡ chính owner bị chặn; member mutation cạnh tranh; tripRef cũ không cấp quyền.
- **Hoàn tất khi** Token còn hợp lệ nhưng member removed không đọc/ghi được chuyến.

<a id="b09"></a>

**B09 · Khôi phục thành viên cũ**

- **Kết quả** Owner restore đúng UID đã từng tham gia.
- **Phạm vi file/module** Membership service/routes.
- **Việc làm** Restore membership/tripRef, giữ joinedAt và all-time count; không tạo participant mới; audit.
- **Kiểm thử** Restore lại cùng key, UID chưa từng là member, participant link đã thay đổi.
- **Hoàn tất khi** Không tăng membershipCountAllTime lần hai; liên kết còn đúng hoặc yêu cầu owner xử lý rõ.

<a id="b10"></a>

**B10 · Chuyển chủ chuyến**

- **Kết quả** Chuyến luôn có đúng một owner active khi chuyển chủ.
- **Phạm vi file/module** Trip/membership service/routes.
- **Việc làm** Transaction kiểm owner hiện tại/người nhận active và đã linked; đổi root owner và hai roles; version/audit/op.
- **Kiểm thử** Hai lệnh chuyển chủ đồng thời, người nhận removed/unlinked, quyền owner cũ sau commit.
- **Hoàn tất khi** Không có thời điểm commit với 0 hoặc 2 owners; tiền không đổi.

</details>

## S09

**Sửa giao dịch và chốt chuyến**

- **Trạng thái** Chưa làm
- **Phụ thuộc** [S08](#s08)
- **Kết quả** Hoàn thiện sửa khoản chi, hủy/đảo trả nợ và archive/reopen chuyến.
- **Nghiệm thu** Delta cũ/mới cập nhật tiền đúng một lần. Chặn chốt khi còn số dư hoặc đề nghị pending. Lời mời cũ hết hiệu lực khi chốt và vẫn vô hiệu sau khi mở lại.

<details>
<summary>Các bước và tiêu chí chi tiết</summary>

<a id="b11"></a>

**B11 · Sửa khoản chi bằng delta cũ và mới**

- **Kết quả** Creator/owner sửa expense active mà số dư vẫn khớp.
- **Phạm vi file/module** Expense service/routes, schemas và money domain.
- **Việc làm** PATCH If-Match; đảo delta cũ+cộng mới; cập nhật category totals/stats/participants và snapshot audit; giữ all-time count.
- **Kiểm thử** Equal→exact, đổi payer/category/amount, conflict, retry, participant inactive.
- **Hoàn tất khi** Tổng net=0, total/category totals đúng; expense void không sửa được.

<a id="b12"></a>

**B12 · Hủy đề nghị trả nợ chưa xác nhận**

- **Kết quả** Creator/owner cancel pending.
- **Phạm vi file/module** `be/src/finance-routes.ts`, settlement service.
- **Việc làm** Version/state check, status cancelled, pending counter/revision/signal/audit/op; không áp delta tiền.
- **Kiểm thử** Confirm và cancel cạnh tranh; cancel lặp; sai actor.
- **Hoàn tất khi** Chỉ một state transition thắng; balances và ledgerVersion không đổi do cancel.

<a id="b13"></a>

**B13 · Đảo lượt trả nợ đã xác nhận**

- **Kết quả** Owner void confirmed settlement có lý do.
- **Phạm vi file/module** Settlement service/routes.
- **Việc làm** Đảo sent/received/net, giữ thông tin confirm cũ; version/revision/ledgerVersion/signal/audit/op.
- **Kiểm thử** Void sau partial payment, hai lần void, member cố void, trip archived.
- **Hoàn tất khi** Delta đảo đúng một lần; không sửa expense để bù tiền.

<a id="b14"></a>

**B14 · Lưu trữ chuyến đã cân bằng**

- **Kết quả** Owner archive khi mọi net=0 và không còn pending.
- **Phạm vi file/module** Trip archive service/routes.
- **Việc làm** Đọc balances/counters/version trong transaction; set archived/archivedAt, inviteEpoch++, signal/audit/op.
- **Kiểm thử** Net khác0, còn pending, create expense cạnh tranh, dùng lại invite cũ.
- **Hoàn tất khi** Chuyến archived chặn ghi nghiệp vụ; ledgerVersion không tăng vì archive.

<a id="b15"></a>

**B15 · Mở lại chuyến đã lưu trữ**

- **Kết quả** Owner reopen để tiếp tục ghi nhận.
- **Phạm vi file/module** Trip reopen service/routes.
- **Việc làm** If-Match/key; active, archivedAt theo hợp đồng, version/revision/signal/audit; epoch không hồi lại.
- **Kiểm thử** Reopen lặp, non-owner, link invite trước archive.
- **Hoàn tất khi** Chuyến ghi được sau reopen; link cũ vẫn vô hiệu và lịch sử không mất.

</details>
