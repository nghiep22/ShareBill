# Màn hình và quy tắc hiển thị tiền

## Phần phải chịu và số còn cần trả

Sau khi nhập khoản chi chia đều, form hiện **Phải chịu** bên cạnh mỗi người được chọn. Tổng phần chia bằng số tiền khoản chi; phần lẻ VND được phân bổ theo ID thành viên cố định, chênh lệch tối đa 1đ. Ví dụ 100.000đ chia ba người sẽ có một phần 33.334đ và hai phần 33.333đ. Mỗi lần nhập lại cùng danh sách cho cùng kết quả với backend.

Chi tiết khoản chi dùng nhãn **Mỗi người phải chịu**, đánh dấu người đã ứng tiền và có link sang Số dư. Đây là chi phí từng người được chia, chưa khẳng định họ đã chuyển tiền. Khoản đã hủy giữ phần chia để xem lịch sử nhưng không còn tính vào số dư.

Trong **Số dư & quyết toán**, mỗi thành viên luôn hiện trực tiếp:

- **Phải chịu:** tổng phần chi từ mọi khoản chưa hủy, không chỉ trang chi tiêu đang tải.
- **Đã ứng:** tổng tiền người đó đã ứng cho nhóm.
- **Đã chuyển / Đã nhận:** chỉ tính các khoản chuyển đã xác nhận còn hiệu lực.
- **Cần trả / Được nhận:** phần còn lại sau ứng tiền và chuyển tiền; hiển thị số tiền dương kèm nhãn, không bắt người dùng tự hiểu dấu âm.

Ví dụ An ứng 100.000đ chia ba người; Bình chịu 33.333đ và chưa ứng gì. Bình cần trả 33.333đ. Sau khi khoản Bình chuyển 10.000đ được xác nhận, phần phải chịu vẫn là 33.333đ, đã chuyển là 10.000đ và còn cần trả 23.333đ. Pending không trừ nợ và không giữ chỗ tiền; gợi ý có thể gồm các cặp đang có pending, nên người dùng kiểm lịch sử trước khi ghi thêm.

Tổng quan hiển thị tổng chi, phần chi của tài khoản đang xem và số còn cần trả/được nhận từ snapshot server. Danh sách khoản chi dùng nhãn **Phần của bạn** để tránh hiểu số âm/dương của riêng một khoản là toàn bộ công nợ. Màn hình thành viên cũng có nhãn Cần trả/Được nhận.

## Nhập và quyết toán

Mục **Số tiền cần chuyển** nằm ngay sau số dư cá nhân, trước bảng chi tiết từng người. Mỗi dòng ghi rõ người chuyển → người nhận và số tiền. Người dùng chuyển tiền bên ngoài ứng dụng rồi ghi nhận và xác nhận.

Nếu chỉ có một người chia tiền, màn hình giải thích toàn bộ chi phí đang tính cho người đó nên cần chuyển 0đ, kèm nút cho chủ chuyến **Thêm người chia tiền** và **Xem và sửa khoản chi**. Thêm người hoặc mời tài khoản không tự chia lại khoản chi cũ: mở từng khoản chi → Sửa → Chia cho ai? → chọn đủ người hoặc Chọn tất cả → Lưu khoản chi. Form sửa nhắc rõ khi có người chưa nằm trong phần chia cũ.

**Chưa liên kết** nghĩa là tài khoản đang xem chưa gắn với người chia tiền. Nút **Xem tài khoản trong chuyến** mở thẳng tab Tài khoản truy cập; chủ chuyến quản lý tài khoản thành viên → Liên kết người chia tiền → chọn đúng tên và xác nhận. Liên kết không thay đổi phần chia hay số dư của nhóm. Người chưa liên kết vẫn xem được số tiền cần chuyển của nhóm.

Ô ghi nhận chuyển tiền dùng cùng quy tắc VND với khoản chi. `10.000`, `10,000` và `10000` đều thành 10.000đ. Từ chối số lẻ, trộn dấu, số mũ như `1e3`, số âm/0, vượt giới hạn và vượt số nợ hiện tại. Không dùng việc chuyển dấu chấm thành phần thập phân của HTML number để ghi nhầm 10.000đ thành 10đ.

Có thể chuyển một phần hoặc chọn cặp người chuyển/người nhận khác hợp lệ. Lưu chỉ tạo đề nghị chờ; người nhận hoặc chủ chuyến xác nhận đúng quyền mới cập nhật số dư. Hủy pending giữ nguyên tiền. Hủy hiệu lực confirmed đảo đúng số tiền đã ghi nhận, giữ lịch sử và yêu cầu lý do. Sửa/hủy khoản chi cập nhật phần chia và công nợ; các khoản chuyển đã xác nhận trước đó vẫn được giữ riêng theo sổ.

Chia theo số tiền cho phép phần 0đ và người ứng tiền ở ngoài nhóm được chia. Tiền nguyên VND, tổng phần chia phải khớp tổng khoản. Bản ghi tài chính có version; API tiếp tục chặn xung đột, trả vượt số nợ và thao tác sai quyền.

## Dữ liệu thiếu và cập nhật

Mọi màn hình tiền dùng một hàm kiểm snapshot: đủ và duy nhất mỗi participant, khớp số người của chuyến, số nguyên hợp lệ, công thức từng người, tổng đã ứng/phải chịu bằng tổng chi, tổng gửi bằng tổng nhận và tổng số dư bằng 0. Không lấy tổng từ trang expense đã lọc/phân trang để thay cho số dư.

Khi snapshot thiếu hoặc lệch, hiển thị **Chưa đủ dữ liệu**, bỏ kết luận cân bằng và không cho quyết toán/chốt. Không render 0đ/NaNđ thay dữ liệu thiếu. Gợi ý chuyển chỉ hiện khi cùng phiên bản sổ tiền, đủ cặp và tổng chuyển khớp các số dư; không dùng gợi ý cũ khi đang tải lại. Chốt cần toàn bộ số dư bằng 0 và không có pending; backend vẫn kiểm lại trong transaction.

## Bằng chứng kiểm thử

38 kiểm thử unit kiểm phần chi và nợ còn lại, snapshot thiếu/trùng/sai, tổng tiền/chuyển, chốt, gợi ý, làm tròn, nhập VND và giới hạn mỗi lần chuyển. Các hành trình browser kiểm chia đều ba người, trả một phần, số nhập không hợp lệ/vượt nợ, xác nhận/hủy/đảo, sửa tiền/chia chính xác có 0đ và payer ngoài nhóm, hủy khoản chi, chốt; trường hợp snapshot thiếu không được báo cân bằng hoặc chốt. Luồng mới kiểm từ một người, thêm người không đổi khoản cũ, chọn lại phần chia 1.550.000đ thành hai phần 775.000đ, rồi liên kết tài khoản để xem nợ cá nhân. Hành trình hai tài khoản hiện có tiếp tục kiểm người gửi/người nhận và quyền sau chốt. Các bộ transaction/concurrency/idempotency backend vẫn là kiểm chứng cuối của số dư server.
