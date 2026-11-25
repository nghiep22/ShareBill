# QR nhận tiền và ảnh chuyển khoản

Luồng nằm trong **Số dư & quyết toán** và **Lịch sử chuyển tiền**. QR nhận tiền cũng có thể cập nhật từ **Thành viên & phân quyền**.

1. Mỗi tài khoản đã liên kết thành viên tải ảnh QR ngân hàng của mình lên, xem lại rồi bấm **Lưu QR nhận tiền**. QR được quản lý riêng trong từng nhóm; chỉ chính tài khoản đó được sửa.
2. Người cần trả bấm **Chuyển khoản** ở gợi ý của mình. Hộp thoại hiện **Số tiền cần chuyển** và tên hai người ngay trước QR, điền sẵn số tiền vào ô ghi nhận, kể cả khi chọn **Chuyển trả**. Xem QR người nhận, kiểm tra tài khoản và thực hiện chuyển bằng ứng dụng ngân hàng. Nếu chưa có QR, liên hệ người nhận để lấy thông tin.
3. Chọn số tiền đã chuyển, tải ảnh giao dịch thành công và bấm **Gửi báo đã chuyển khoản** ở cuối cửa sổ. Nút luôn hiện bên ngoài vùng cuộn ảnh; cần thêm bill trước khi gửi. Ứng dụng lưu giao dịch ở trạng thái **Chờ xác nhận**, chưa giảm công nợ.
4. Người nhận mở **Lịch sử chuyển tiền → Chờ xác nhận → Xem ảnh chuyển khoản**, kiểm tra tài khoản thực nhận rồi bấm **Xác nhận đã nhận tiền**. Công nợ, số đã chuyển và đã nhận cập nhật nguyên tử đúng một lần.
5. Ảnh và giao dịch vẫn xem lại được sau khi xác nhận hoặc hủy. Người chuyển có thể hủy báo chuyển đang chờ nếu gửi nhầm.

**Phân biệt công nợ và khoản chuyển:** số **Còn được nhận / Còn cần trả** trong lịch sử là tổng công nợ hiện tại, sau các giao dịch đã xác nhận. Số tiền trên một khoản chờ là số đã nhập lúc tạo khoản đó, không tự đổi theo công nợ mới. Hộp xác nhận hiện riêng **Số tiền xác nhận cho khoản này** và ngày ghi nhận. Trả một phần chỉ giảm đúng số đã ghi nhận; khoản nhập sai cần hủy và ghi nhận lại theo giao dịch thực tế.

Trong **Thành viên & phân quyền**, thẻ **QR nhận tiền của bạn** nằm ngay dưới tiêu đề trang, trước phần Quyền trong chuyến. Trên môi trường Vercel, ảnh dùng kho Blob riêng tư trong gói Hobby; xem cấu hình và kiểm thử kho thật trong [RECEIPTS.md](RECEIPTS.md).

Ảnh là bằng chứng do người dùng cung cấp. Ứng dụng không tự chuyển tiền hay kiểm chứng giao dịch với ngân hàng.

## Chia sẻ QR qua Zalo

Trong **Số dư** hoặc **Chi tiết khoản chi**, bấm **Chia sẻ QR qua Zalo**, chọn **Tạo QR cho [tên người trả]**. Mỗi ảnh có một VietQR ngân hàng với số còn nợ hiện tại, đã trừ tiền ứng và các khoản chuyển được xác nhận; không lấy nguyên phần chia của riêng bill. Cặp người trả/người nhận và số tiền theo gợi ý quyết toán của máy chủ ở cùng revision với số dư. Cặp có khoản pending cần xử lý khoản cũ trước khi tạo QR yêu cầu chuyển thêm.

Ảnh PNG ghi tên nhóm, người chuyển, người nhận, số tiền, thời điểm tạo và tên bill nếu mở từ chi tiết khoản chi. Người dùng có thể **Chia sẻ ảnh** qua bảng chia sẻ của thiết bị rồi chọn Zalo/nhóm nhận, hoặc **Tải ảnh gửi Zalo** và **Sao chép nội dung gửi nhóm**. Thiết bị không hỗ trợ chia sẻ file vẫn tải được PNG. Nội dung sao chép chỉ có liên kết nhóm cần đăng nhập, không có token hay URL xem ảnh ký tạm thời.

Có thể **Sao chép ảnh** rồi dán vào cuộc trò chuyện Zalo, hoặc **Mở Zalo Web** để gửi ảnh đã tải. Giao diện hướng dẫn cách gửi khi chia sẻ trực tiếp/clipboard bị chặn. Cả QR chuyển khoản và QR mời nhóm dùng Web Share API; xem [công nghệ và các hàm QR](QR_SHARING.md).

QR được đọc, kiểm CRC và tạo ảnh ngay trong trình duyệt từ QR người nhận đã lưu; không dùng API tạo QR bên ngoài hoặc công khai kho Blob. Chia sẻ ảnh không tạo/xác nhận settlement. Khi số dư thay đổi, QR mới dùng số mới; ảnh đã gửi là ảnh chụp số dư tại thời điểm tạo, cần đối chiếu số dư trước khi chuyển.

## Hợp đồng API và dữ liệu

- Dùng quy trình ảnh riêng tư hiện có: `upload-intents → upload → finalize`. JPG/PNG/WebP, tối đa 5 MiB; backend kiểm ảnh thực, xử lý và loại bỏ metadata. Không lưu URL ký sẵn trong dữ liệu nghiệp vụ.
- `PATCH /api/v1/trips/:tripId/participants/:id/payment-qr` nhận `{ receiptId: UUID | null }`, cần `Idempotency-Key` và `If-Match` phiên bản thành viên. Ghi `participants.paymentQrReceiptId` và claim ảnh với `attachedParticipantId`. Đổi QR loại ảnh cũ với thời gian giữ 7 ngày. QR chỉ được xem khi tài khoản liên kết vẫn là người đã tải ảnh.
- `POST /api/v1/trips/:tripId/settlements` nhận thêm `receiptIds` tối đa 3 UUID khác nhau. Ảnh phải `ready`, thuộc nhóm và do actor tải; actor phải là người chuyển. Claim `attachedSettlementId` và settlement được tạo trong cùng transaction. Mỗi cặp người chuyển/người nhận chỉ có một khoản pending, áp dụng cả giao dịch không ảnh và ghi nhận thay. Transaction trả `409 PAYMENT_ALREADY_PENDING` nếu ghi thêm bằng key/tài khoản khác hoặc gửi đồng thời. Cùng key cũ trả kết quả cũ, không tạo bản ghi thứ hai.
- `GET .../settlement-suggestions` trả thêm `revision` và `pendingTransfers` đầy đủ trong cùng snapshot với số dư. Frontend chỉ mở ghi nhận khi dữ liệu cùng revision. Cặp có pending hiện liên kết **Xem khoản đang chờ** thay cho nút gửi bị khóa, kể cả sau tải trang hoặc mở tab khác. Nếu mở **Chuyển trả** và chọn cặp đang chờ, cửa sổ hiện số tiền đã ghi cùng nút **Xem và xử lý khoản đang chờ**; chưa cho nhập hay tải bill cho khoản mới. Khi hủy khoản pending, hoặc xác nhận khoản trả một phần và còn nợ, có thể ghi khoản tiếp theo.
- `settlements.receiptIds` mặc định `[]` khi đọc dữ liệu cũ. Ảnh đã dùng không thể dùng lại hoặc xóa trực tiếp. Hủy/đảo giao dịch giữ ảnh để tra cứu.
- `POST .../settlements/:id/confirm`: giao dịch có ảnh chỉ người nhận được xác nhận. Chủ chuyến cũng là người nhận thì nút và bản ghi dùng `recipient` (**Xác nhận đã nhận tiền**), kể cả khi chính chủ chuyến đã ghi khoản chuyển thủ công. Khi chủ chuyến xác nhận cho một người nhận khác trong giao dịch không ảnh, dùng `owner_on_behalf` (**Xác nhận thay**). Giữ kiểm phiên bản và ledger hiện tại; idempotency ngăn cập nhật tiền hai lần.
- `GET .../receipts/:id/view-url`: ảnh QR cho thành viên đang có quyền trong nhóm; ảnh chuyển khoản chỉ cho người chuyển/người nhận. URL riêng tư hết hạn sau 60 giây, có nút lấy lại khi hết hạn. Chủ nhóm không mặc nhiên có quyền xem ảnh chuyển khoản của hai người khác.
- Một ảnh `attached` có đúng một đích trong `attachedExpenseId`, `attachedSettlementId`, `attachedParticipantId`. Database checker kiểm cả hai chiều cho ba loại liên kết. Các trường mới tương thích với bản ghi cũ, không cần backfill trước khi chạy.

Frontend yêu cầu một ảnh trước khi gửi báo chuyển khoản của chính mình. Chủ chuyến vẫn có **Ghi nhận thay** cho giao dịch của người khác; đây là ghi sổ thủ công, không gửi ảnh thay người chuyển. API giữ hỗ trợ các lệnh ghi nhận thủ công cũ không có ảnh.

## Kiểm thử

`be/test/payments.emulator.test.ts` kiểm quyền QR, thay QR, URL riêng tư, claim ảnh nguyên tử, từ chối ảnh người khác/ảnh trùng/ảnh đã dùng, chống gửi pending lặp, quyền xác nhận đúng người nhận, idempotency, cập nhật công nợ sau xác nhận và giữ ảnh sau hủy. Dùng Auth/Firestore emulators và kho ảnh trong bộ nhớ; việc ký URL/upload trên bucket thật cần môi trường Storage được cấu hình theo `RECEIPTS.md`.

Ca hai tài khoản trong `fe/test/workspace.test.mjs` kiểm thêm QR, xem QR người nhận, chặn báo chuyển khi thiếu ảnh, gửi bằng chứng và xác nhận trên viewport điện thoại. Chỉ transport upload/xem ảnh được giả lập; API attach ảnh, giao dịch và số dư chạy thật với Firestore Emulator.
