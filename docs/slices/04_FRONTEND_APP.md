# ShareBill — 04 — Frontend app cho điện thoại

[Danh mục và thứ tự thực hiện](README.md) · [Thiết kế CSDL](../DATABASE.md) · [Hợp đồng API](../BACKEND.md)

FE hiện mới có README. Mỗi lát dưới đây làm một màn hình hoặc một hành động chính bằng API đã nghiệm thu. Tuân theo layout và từ ngữ dễ dùng trong FRONTEND.md.

**Số lát cắt: 25.** Trạng thái ban đầu đều **Chưa làm**. File hiện có là điểm sửa; đường dẫn ghi “mới” hoặc tên module chưa tồn tại là vị trí dự kiến. Mỗi lát cập nhật hợp đồng API/schema liên quan nếu có thay đổi.

## Danh sách nhanh

| Mã | Kết quả cần làm | Phụ thuộc |
| --- | --- | --- |
| [F01](#f01) | Khởi tạo ứng dụng và khung mobile | [D03](01_DATABASE_BE.md#d03) |
| [F02](#f02) | Màn hình đăng ký | [F01](#f01), [D02](01_DATABASE_BE.md#d02) |
| [F03](#f03) | Đăng nhập, làm mới phiên và đăng xuất | [F02](#f02), [B18](02_NGHIEP_VU_BE.md#b18) |
| [F04](#f04) | Danh sách chuyến của tôi | [F03](#f03), [D20](01_DATABASE_BE.md#d20) |
| [F05](#f05) | Tạo chuyến từ form ngắn | [F04](#f04), [D03](01_DATABASE_BE.md#d03) |
| [F06](#f06) | Tổng quan và sửa thông tin chuyến | [F05](#f05), [B01](02_NGHIEP_VU_BE.md#b01), [D06](01_DATABASE_BE.md#d06) |
| [F07](#f07) | Thêm/đổi tên/ngừng chia cho participant | [F06](#f06), [B02](02_NGHIEP_VU_BE.md#b02) |
| [F08](#f08) | Danh sách chi tiêu và filter | [F06](#f06), [D21](01_DATABASE_BE.md#d21) |
| [F09](#f09) | Nhập khoản chi chia đều | [F07](#f07), [F08](#f08), [D05](01_DATABASE_BE.md#d05), [D09](01_DATABASE_BE.md#d09), [B17](02_NGHIEP_VU_BE.md#b17) |
| [F10](#f10) | Chia theo số tiền riêng | [F09](#f09) |
| [F11](#f11) | Chi tiết khoản chi và quyền thao tác | [F08](#f08), [D05](01_DATABASE_BE.md#d05) |
| [F12](#f12) | Sửa khoản chi và giải quyết conflict | [F10](#f10), [F11](#f11), [B11](02_NGHIEP_VU_BE.md#b11) |
| [F13](#f13) | Hủy khoản chi có lý do | [F11](#f11), [D06](01_DATABASE_BE.md#d06) |
| [F14](#f14) | Số dư và gợi ý chuyển tiền | [F06](#f06), [D11](01_DATABASE_BE.md#d11) |
| [F15](#f15) | Ghi nhận đề nghị trả nợ | [F14](#f14), [D07](01_DATABASE_BE.md#d07), [D22](01_DATABASE_BE.md#d22) |
| [F16](#f16) | Người nhận xác nhận đã nhận tiền | [F15](#f15) |
| [F17](#f17) | Hủy/đảo lượt trả nợ theo trạng thái | [F16](#f16), [B12](02_NGHIEP_VU_BE.md#b12), [B13](02_NGHIEP_VU_BE.md#b13) |
| [F18](#f18) | Mở link mời và xác nhận tham gia | [F03](#f03), [B06](02_NGHIEP_VU_BE.md#b06), [B07](02_NGHIEP_VU_BE.md#b07) |
| [F19](#f19) | Owner liên kết account với participant | [F07](#f07), [B03](02_NGHIEP_VU_BE.md#b03), [B07](02_NGHIEP_VU_BE.md#b07) |
| [F20](#f20) | Gỡ/khôi phục quyền thành viên | [F19](#f19), [B08](02_NGHIEP_VU_BE.md#b08), [B09](02_NGHIEP_VU_BE.md#b09) |
| [F21](#f21) | Chuyển quyền owner trên giao diện | [F20](#f20), [B10](02_NGHIEP_VU_BE.md#b10) |
| [F22](#f22) | Chốt chuyến đã cân bằng | [F17](#f17), [B14](02_NGHIEP_VU_BE.md#b14) |
| [F23](#f23) | Mở lại chuyến đã chốt | [F22](#f22), [B15](02_NGHIEP_VU_BE.md#b15) |
| [F24](#f24) | Lịch sử hoạt động của nhóm | [F06](#f06), [B16](02_NGHIEP_VU_BE.md#b16) |
| [F25](#f25) | Cài đặt thiết bị và điều hướng trợ giúp | [F03](#f03) |

## Chi tiết từng lát cắt

### F01

**Khởi tạo ứng dụng và khung mobile**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [D03](01_DATABASE_BE.md#d03).

**Kết quả:** Mở được FE local có navigation, tokens và error/empty/loading primitives.

**Phạm vi file/module:** `fe/package.json`, cấu hình Next.js/React/TypeScript, app shell (mới).

**Việc làm:** Pin môi trường, scripts/env.example; layout 360px; một trang home dẫn tới login/trips; API base URL từ env.

**Kiểm thử:** Typecheck/build, xem viewport360/desktop, không cuộn ngang.

**Hoàn tất khi:** FE chạy độc lập và gọi được health BE; không có credential Admin trong bundle.

### F02

**Màn hình đăng ký**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F01](#f01), [D02](01_DATABASE_BE.md#d02).

**Kết quả:** Tạo tài khoản email/mật khẩu/tên bằng form dễ hiểu.

**Phạm vi file/module:** `fe/src/features/auth/` (mới), route register.

**Việc làm:** Firebase Web SDK quản lý tài khoản/phiên; cập nhật tên hiển thị Auth rồi gọi POST /me/bootstrap và GET /me để lấy hồ sơ app. Có validation inline, submit state, lỗi trùng email và điều hướng trips sau thành công.

**Kiểm thử:** Form hợp lệ, email trùng, password yếu, mất mạng; không log mật khẩu.

**Hoàn tất khi:** Tạo được tài khoản và profile đúng tên; lỗi không xóa form hoặc tạo session giả.

### F03

**Đăng nhập, làm mới phiên và đăng xuất**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F02](#f02), [B18](02_NGHIEP_VU_BE.md#b18).

**Kết quả:** Một phiên được dùng nhất quán giữa trang và API.

**Phạm vi file/module:** Auth provider/hooks, route login/settings session, API client.

**Việc làm:** Auth initializing/authenticated/unauthenticated; bootstrap hồ sơ app sau login SDK; lấy ID token trước request; refresh tối đa1lần khi401; logout/đổi uid xóa cache partition; returnTo nội bộ.

**Kiểm thử:** Session hết hạn, revoked/disabled, reload, đổi tài khoản, mạng lỗi.

**Hoàn tất khi:** Không flash dữ liệu của user trước; không lưu refresh token thủ công vào app storage.

### F04

**Danh sách chuyến của tôi**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F03](#f03), [D20](01_DATABASE_BE.md#d20).

**Kết quả:** User xem và tải tiếp chuyến mình còn quyền.

**Phạm vi file/module:** Trip list page/query (mới).

**Việc làm:** Cards tên/vai trò/tổng, active/archived theo hợp đồng list; empty CTA; pagination, loading/retry.

**Kiểm thử:** Hơn20 chuyến, empty, removed, trang bị filter hết nhưng vẫn còn cursor.

**Hoàn tất khi:** Không báo hết danh sách khi vẫn có nextCursor; chỉ hiển thị metadata được API cấp.

### F05

**Tạo chuyến từ form ngắn**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F04](#f04), [D03](01_DATABASE_BE.md#d03).

**Kết quả:** User nhập tên chuyến và tên mình rồi vào overview.

**Phạm vi file/module:** Trip create form/schema/query mutation (mới).

**Việc làm:** Hai field chính; key cho một submit; pending disable; giữ key/body khi outcome chưa rõ; điều hướng bằng ID server.

**Kiểm thử:** Double tap, timeout sau commit, validation; kiểm created trip.

**Hoàn tất khi:** Chỉ tạo một chuyến; người mới hiểu thao tác và không cần cấu hình nâng cao.

### F06

**Tổng quan và sửa thông tin chuyến**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F05](#f05), [B01](02_NGHIEP_VU_BE.md#b01), [D06](01_DATABASE_BE.md#d06).

**Kết quả:** Xem tổng chi/số dư/người và sửa metadata theo quyền.

**Phạm vi file/module:** Trip overview/settings page (mới).

**Việc làm:** Overview từ snapshot BE, version/revision; owner mở form metadata; 409 yêu cầu tải lại có giữ draft.

**Kiểm thử:** Ledger thay đổi, member không owner, archived/suspended, thiếu dữ liệu.

**Hoàn tất khi:** Không tính tổng từ list phân trang; nội dung và CTA theo trạng thái/quyền.

### F07

**Thêm/đổi tên/ngừng chia cho participant**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F06](#f06), [B02](02_NGHIEP_VU_BE.md#b02).

**Kết quả:** Owner quản lý tên và trạng thái người được chia tiền.

**Phạm vi file/module:** Participant list/forms (mới).

**Việc làm:** Thêm người chưa có account; nhãn chưa liên kết; rename/inactive với version; không lẫn membership và participant.

**Kiểm thử:** Thêm trùng tên, hết quota, inactive còn nợ, member cố dùng action owner.

**Hoàn tất khi:** Người chưa có tài khoản vẫn dùng được trong chuyến; inactive không mất số dư cũ.

### F08

**Danh sách chi tiêu và filter**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F06](#f06), [D21](01_DATABASE_BE.md#d21).

**Kết quả:** Xem và tải tiếp chi tiêu theo các filter API hỗ trợ.

**Phạm vi file/module:** Expense list/filter/query (mới).

**Việc làm:** Ngày/status, một filter category hoặc payer; reset cursor khi đổi filter; empty khác error; invalidate khi revision đổi.

**Kiểm thử:** Nhiều trang/ngày trùng, cursor stale, thay filter, offline/error.

**Hoàn tất khi:** Không giữ cursor thuộc filter cũ; không tải mọi record để giả search toàn bộ.

### F09

**Nhập khoản chi chia đều**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F07](#f07), [F08](#f08), [D05](01_DATABASE_BE.md#d05), [D09](01_DATABASE_BE.md#d09), [B17](02_NGHIEP_VU_BE.md#b17).

**Kết quả:** Thêm expense equal từ một màn hình.

**Phạm vi file/module:** Expense create form/mutation (mới).

**Việc làm:** Tên/số tiền/người trả/người chia; VND input chuẩn; defaults hợp lý; key/body giữ khi outcome chưa rõ; lấy kết quả chuẩn server.

**Kiểm thử:** Số lẻ, bỏ chọn hết người, inactive, double tap, response thất lạc.

**Hoàn tất khi:** Chỉ một expense; tổng phần chia đúng; thông báo thành công chỉ sau commit.

### F10

**Chia theo số tiền riêng**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F09](#f09).

**Kết quả:** Chuyển từ chia đều sang nhập từng phần exact.

**Phạm vi file/module:** Split editor và schema form (mới).

**Việc làm:** Hiển thị tổng/đã chia/còn thiếu; integer; preserve input khi chuyển/chỉnh; gửi exact đã validate.

**Kiểm thử:** Tổng thiếu/thừa, share0, số quá lớn, người trùng.

**Hoàn tất khi:** Người dùng hiểu phải sửa phần nào; không tự làm tròn làm đổi tổng tiền.

### F11

**Chi tiết khoản chi và quyền thao tác**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F08](#f08), [D05](01_DATABASE_BE.md#d05).

**Kết quả:** Xem payer/shares/note/status/version và action được phép.

**Phạm vi file/module:** Expense detail page/query (mới).

**Việc làm:** DTO server; phân biệt active/void; links tới edit/void chỉ khi quyền phù hợp; receipt slot nối ở I08.

**Kiểm thử:** Outsider404, member không creator, khoản void và quyền thay đổi.

**Hoàn tất khi:** Không hiển thị nút cho thao tác chắc chắn bị chặn; vẫn xử lý403/409 từ server.

### F12

**Sửa khoản chi và giải quyết conflict**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F10](#f10), [F11](#f11), [B11](02_NGHIEP_VU_BE.md#b11).

**Kết quả:** Creator/owner sửa expense với bản nháp được giữ khi xung đột.

**Phạm vi file/module:** Expense edit form/mutation (mới).

**Việc làm:** Prefill splitInput, If-Match, key/hash theo lần sửa; 409 tải mới và cho xem lại draft, không ghi đè âm thầm.

**Kiểm thử:** Hai tab sửa cùng expense; đổi payer/category/split; timeout/retry.

**Hoàn tất khi:** Bản cũ không đè bản mới; UI dùng response server và invalidate đúng query.

### F13

**Hủy khoản chi có lý do**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F11](#f11), [D06](01_DATABASE_BE.md#d06).

**Kết quả:** User có quyền void active expense và nhìn thấy ảnh hưởng.

**Phạm vi file/module:** Void expense dialog/mutation (mới).

**Việc làm:** Dialog title/amount/reason; If-Match/key; no hard delete; refresh overview/list/detail/activity.

**Kiểm thử:** Void lặp, sai quyền, version cũ, mạng lỗi.

**Hoàn tất khi:** Void thành công có nhãn lịch sử; tổng và số dư cập nhật từ server.

### F14

**Số dư và gợi ý chuyển tiền**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F06](#f06), [D11](01_DATABASE_BE.md#d11).

**Kết quả:** User hiểu ai cần trả ai và số tiền.

**Phạm vi file/module:** Balances/suggestions page (mới).

**Việc làm:** Hiển thị ứng/chịu/chuyển/nhận/net; nhãn tiếng Việt đúng dấu; suggestions cùng ledgerVersion; không dùng dữ liệu list làm sổ.

**Kiểm thử:** Net âm/dương/0, participant unlinked/inactive, suggestions stale.

**Hoàn tất khi:** Có câu 'cần trả/được nhận'; số tiền và phiên bản khớp snapshot server.

### F15

**Ghi nhận đề nghị trả nợ**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F14](#f14), [D07](01_DATABASE_BE.md#d07), [D22](01_DATABASE_BE.md#d22).

**Kết quả:** Owner hoặc người gửi tạo pending settlement.

**Phạm vi file/module:** Settlement create/list form/query (mới).

**Việc làm:** Prefill từ suggestion; amount<=nợ hiện tại; key và basedOnLedgerVersion; pending ghi rõ chưa xác nhận.

**Kiểm thử:** Partial payment, ledger changed, role sai, timeout.

**Hoàn tất khi:** Pending không làm UI báo đã hết nợ; người dùng thấy bước người nhận cần xác nhận.

### F16

**Người nhận xác nhận đã nhận tiền**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F15](#f15).

**Kết quả:** Recipient hoặc owner thay mặt confirm pending.

**Phạm vi file/module:** Settlement confirm action/dialog (mới).

**Việc làm:** Nút 'Tôi đã nhận tiền', mode owner có nhãn; If-Match/current ledgerVersion/key; refresh balances sau commit.

**Kiểm thử:** Pending bị cancel/confirm từ nơi khác, ledger stale, user không có quyền.

**Hoàn tất khi:** Tiền đổi một lần; owner_on_behalf hiện rõ, không gán ngầm là recipient đã bấm.

### F17

**Hủy/đảo lượt trả nợ theo trạng thái**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F16](#f16), [B12](02_NGHIEP_VU_BE.md#b12), [B13](02_NGHIEP_VU_BE.md#b13).

**Kết quả:** Pending có action hủy; confirmed có action đảo dành cho owner.

**Phạm vi file/module:** Settlement cancel/void dialogs (mới).

**Việc làm:** Nêu khác biệt tác động tiền, reason khi void, If-Match/key và giữ historical mode.

**Kiểm thử:** Sai state, version conflict, retry và permission downgrade.

**Hoàn tất khi:** UI không đổi from/to/amount của record cũ; tổng tiền được lấy lại sau thao tác.

### F18

**Mở link mời và xác nhận tham gia**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F03](#f03), [B06](02_NGHIEP_VU_BE.md#b06), [B07](02_NGHIEP_VU_BE.md#b07).

**Kết quả:** User mở link, đăng nhập và chủ động join.

**Phạm vi file/module:** Invite landing/preview/join flow (mới).

**Việc làm:** Đọc token fragment, không gắn URL query/log; returnTo nội bộ; preview metadata tối thiểu; join xong thông báo chưa linked.

**Kiểm thử:** Hết hạn/revoke/quota, đã member, removed, reload khi login.

**Hoàn tất khi:** Không tự claim participant; token không vào analytics/cache lâu dài.

### F19

**Owner liên kết account với participant**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F07](#f07), [B03](02_NGHIEP_VU_BE.md#b03), [B07](02_NGHIEP_VU_BE.md#b07).

**Kết quả:** Owner nhìn hai danh sách và liên kết đúng danh tính.

**Phạm vi file/module:** Membership/participant link dialog (mới).

**Việc làm:** Hiển thị linked/unlinked, xác nhận link/unlink, dùng versions; giải thích không đổi sổ tiền.

**Kiểm thử:** UID đã linked, participant đang linked, thao tác cạnh tranh, member giả owner.

**Hoàn tất khi:** UI không tự gán danh tính khi join; conflict giữ lựa chọn và yêu cầu tải mới.

### F20

**Gỡ/khôi phục quyền thành viên**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F19](#f19), [B08](02_NGHIEP_VU_BE.md#b08), [B09](02_NGHIEP_VU_BE.md#b09).

**Kết quả:** Owner thu hồi hoặc khôi phục quyền cộng tác.

**Phạm vi file/module:** Member list và remove/restore dialogs (mới).

**Việc làm:** Phân biệt member removed và participant inactive; dialog nêu người đó vẫn có nợ/chi phí cũ; refresh membership cache.

**Kiểm thử:** Không gỡ owner, removed đang mở trip, restore UID cũ.

**Hoàn tất khi:** Dữ liệu tiền còn nguyên; người bị gỡ được chuyển khỏi view private khi quyền được kiểm lại.

### F21

**Chuyển quyền owner trên giao diện**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F20](#f20), [B10](02_NGHIEP_VU_BE.md#b10).

**Kết quả:** Owner chuyển chủ cho member active đã linked.

**Phạm vi file/module:** Trip owner transfer dialog (mới).

**Việc làm:** Chọn người nhận, xác nhận vai trò/quyền bị mất, gửi If-Match/key; tải lại membership và root sau commit.

**Kiểm thử:** Hai tab chuyển chủ; recipient removed/unlinked; người dùng cũ không còn owner.

**Hoàn tất khi:** UI không giữ quyền owner cũ trong cache và không nhận thay ownerUid từ form metadata.

### F22

**Chốt chuyến đã cân bằng**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F17](#f17), [B14](02_NGHIEP_VU_BE.md#b14).

**Kết quả:** Owner chốt chuyến và thấy toàn bộ app chuyển chỉ đọc.

**Phạm vi file/module:** Trip archive dialog/action (mới).

**Việc làm:** Giải thích archive, số nợ/pending chặn, If-Match/key; refresh root/mutations; không xóa cache lịch sử.

**Kiểm thử:** Còn nợ, còn pending, một người khác thêm chi phí trong lúc chốt.

**Hoàn tất khi:** Chỉ báo chốt thành công khi server commit; action ghi tiền bị khóa theo trạng thái mới.

### F23

**Mở lại chuyến đã chốt**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F22](#f22), [B15](02_NGHIEP_VU_BE.md#b15).

**Kết quả:** Owner mở lại để tiếp tục ghi chi tiêu.

**Phạm vi file/module:** Trip reopen dialog/action (mới).

**Việc làm:** Nêu rõ link mời cũ không hồi sinh; If-Match/key; active state sau commit và invalidation.

**Kiểm thử:** Non-owner, version stale, reload sau reopen và dùng invite cũ.

**Hoàn tất khi:** Giao diện ghi được đúng trạng thái; không dựng lại invitation token cũ.

### F24

**Lịch sử hoạt động của nhóm**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F06](#f06), [B16](02_NGHIEP_VU_BE.md#b16).

**Kết quả:** Member đọc được ai đã thay đổi gì.

**Phạm vi file/module:** Activity timeline page (mới).

**Việc làm:** Map action sang câu tiếng Việt; page cursor; actor legacy không biết có nhãn phù hợp; timestamps theo locale.

**Kiểm thử:** Nhiều trang, entity void, event legacy, removed member.

**Hoàn tất khi:** Timeline rõ và không render raw JSON hoặc admin audit nội bộ.

### F25

**Cài đặt thiết bị và điều hướng trợ giúp**

**Trạng thái:** Chưa làm. **Phụ thuộc:** [F03](#f03).

**Kết quả:** User hiểu trạng thái phiên, thiết bị tin cậy và lối gửi hỗ trợ.

**Phạm vi file/module:** Settings page/preferences (mới).

**Việc làm:** Hiển thị tài khoản/logout; preference trusted-device opt-in; xóa cache; slot vào support form A11; chưa bật offline snapshot khi O04 chưa xong.

**Kiểm thử:** Đổi user, logout trong khi có draft, xóa cache có xác nhận khi làm mất draft.

**Hoàn tất khi:** Không trộn cache giữa UID; lựa chọn lưu dữ liệu được giải thích rõ.
