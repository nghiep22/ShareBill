# Tự chia đều tổng chi của nhóm

Nhóm mới dùng `sharingMode=group-equal`. Mỗi tài khoản có membership đang active là một người chia tiền. Khi nhận lời mời, server tạo người tham gia và liên kết cùng transaction; không phải thêm tên hay liên kết thủ công.

`Phải chịu = tổng chi chưa hủy / số tài khoản trong nhóm`. Chia phần lẻ VND một lần trên tổng chi theo thứ tự participant ID cố định; chênh lệch tối đa 1đ. Tổng nhiều khoản có thể vượt giới hạn một khoản chi, vẫn phải nằm trong số nguyên an toàn. `Số dư = đã ứng − phải chịu + đã chuyển − đã nhận`. Chỉ tính chuyển tiền đã xác nhận còn hiệu lực.

Người mới vào được chia cả chi phí trước khi tham gia. Thêm/sửa/hủy khoản chi, đổi người ứng, gỡ hoặc khôi phục thành viên đều tính lại phần phải chịu trong transaction với trip root; không đọc hay sửa toàn bộ lịch sử expense. Các khoản đã ứng, đã chuyển và đã nhận được giữ, nên thay đổi người chia có thể phát sinh khoản hoàn tiền. Khoản chuyển pending vẫn chờ, không trừ nợ; ledgerVersion thay đổi chặn xác nhận dựa vào số dư cũ.

Tên thêm tay trước đây chưa gắn với tài khoản không làm tăng số người chia. Giữ người và số dư trong lịch sử, đặc biệt khi họ từng ứng hoặc chuyển tiền; không gộp người chỉ vì trùng tên. Thành viên hiện tại và người có giao dịch còn liên quan vẫn được hiển thị trong Số dư. Không cho tạo tên thủ công hoặc đổi liên kết trong nhóm tự động; chủ chuyến dùng lời mời và quản lý tài khoản.

Nhóm đang mở chưa có sharingMode được ứng dụng nâng cấp trước khi hiển thị overview qua `POST /trips/:tripId/share-equally`. Thao tác có Idempotency-Key, kiểm quyền thành viên và trạng thái nhóm, audit, cùng transaction cho danh tính/số dư/counters/signal. Thành viên chưa liên kết được cấp participant riêng theo UID. Gọi lại không tạo thêm người. Giới hạn 50 tài khoản từng tham gia và 50 participant gồm lịch sử; không có migration quét toàn bộ expense.

Nhóm đã chốt giữ nguyên số dư và cách chia tại lúc chốt. Gỡ quyền truy cập sau chốt không đổi tiền; mở lại nhóm tự động tính lại theo tài khoản còn active. API giữ `per-expense` cho tương thích dữ liệu và bộ kiểm thử cũ; giao diện tạo nhóm bình thường mặc định chỉ dùng chia đều tổng chi.

Giao diện khoản chi chỉ nhập số tiền và người ứng; không có chọn người/nhập từng phần trong nhóm tự động. Số dư hiển thị phép chia tổng chi, số người, phần phải chịu và công nợ còn lại. Lời mời nói rõ tham gia sẽ cùng chia cả chi phí trước đó. Checker/worker đối soát dùng cùng phép chia tổng chi, kiểm equalParticipantIds khớp membership active và giữ tham chiếu lịch sử expense.

Sửa tên, ghi chú, ngày, danh mục hoặc ảnh không tự thay phần chia đã lưu của khoản cũ và không tăng ledgerVersion. Khi sửa số tiền, được giữ đúng người đã ứng khoản đó dù họ đã rời nhóm hoặc ngừng hoạt động từ trước lúc nâng cấp; không được đổi sang người ngoài nhóm khác. Bỏ chọn người chia không còn là điều kiện chặn sửa khoản cũ. Hộp thoại gỡ/khôi phục tài khoản giải thích trước tác động tới tổng chi và công nợ; chuyến đã chốt ghi rõ giữ phần chia lúc chốt.

Kiểm thử gồm chia phần lẻ tổng, tổng vượt cap mỗi khoản, vào nhóm/retry, đổi tiền/người ứng/hủy chi, giữ confirmed, gỡ/khôi phục, nâng cấp người chưa liên kết, bỏ tên trùng thêm tay khỏi số chia, ghi đồng thời với nhận lời mời và quyền API. Browser kiểm tham gia từ lời mời, không có bước liên kết/chọn người, tự chia 2.100.000đ thành 2 rồi 3 phần, trừ tiền aaa ứng thêm, và tự nâng cấp nhóm cũ.

Ngày 20/11/2026: 9/9 ca Emulator chia nhóm đạt, gồm sửa khoản có người ứng inactive và chặn xác nhận pending bằng ledger cũ hoặc vượt nợ mới. Trong 15 hành trình browser đã đạt có luồng gỡ người ứng → sửa nội dung không đổi tiền → sửa số tiền giữ người ứng → khôi phục → chuyển tiền → chốt → gỡ quyền nhưng giữ phần chia lúc chốt. Kiểm bổ sung khoản cũ `exact` sau nâng cấp: sửa tên vẫn giữ `splitMethod`, shares và ledgerVersion. Đây là kiểm chứng local trên Emulator và Chrome, chưa phải nghiệm thu thiết bị vật lý hoặc triển khai cloud.
