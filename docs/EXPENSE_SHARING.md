# Chọn người chia từng khoản và QR theo khoản chi

Yêu cầu ngày 26/11/2026: khoản mới chọn được người chia, chi tiết hiện người và số tiền từng phần, QR trong chi tiết dùng phần của khoản đó. Người dùng đã chọn **giữ nguyên cách tính các khoản cũ**.

## Cách dùng

Khoản mới mặc định chọn các thành viên hiện tại. Trong **Chia cho ai?**, bỏ chọn người không tham gia, chọn chia đều hoặc **Nhập từng phần**. Người ứng tiền có thể không nằm trong danh sách chia. Tổng các phần luôn bằng số tiền khoản chi, theo số nguyên VND.

Ví dụ nhóm An, Bình, Chi có vé 700.000đ do An ứng, chỉ An và Bình dùng vé:

| Người | Phần vé | QR của khoản vé |
| --- | ---: | --- |
| An | 350.000đ | Người ứng, không cần tự chuyển |
| Bình | 350.000đ | Bình chuyển An 350.000đ |
| Chi | Không được chọn | Không có QR trả vé |

Nếu Bình còn chịu 425.000đ từ khoản khác, Số dư hiển thị công nợ tổng 775.000đ; QR trong chi tiết vé vẫn là 350.000đ. QR ở Số dư tiếp tục dùng công nợ còn lại của toàn chuyến.

QR theo khoản dùng **phần chia gốc**, chưa trừ các lượt chuyển tiền đã xác nhận, vì hệ thống quyết toán theo toàn chuyến và chưa gán mỗi lượt chuyển cho một hóa đơn. Hộp thoại ghi rõ và dẫn sang Số dư để kiểm tra trước khi chuyển. Chia sẻ QR không tự ghi nhận hoặc xác nhận thanh toán.

## Khoản cũ và thay đổi thành viên

- Khoản cũ tự chia tổng nhóm tiếp tục cách tính hiện tại; mở xem hoặc sửa tên/ảnh/ghi chú không đổi phần chia hay công nợ.
- Khoản mới có danh sách riêng giữ phần chia khi có người tham gia, rời hoặc trở lại nhóm. Gỡ quyền truy cập không xóa phần phải chịu đã ghi.
- Chỉ các khoản cũ tự chia tổng nhóm được tính lại theo thành viên hiện tại. Phần lẻ của nhóm khoản cũ tiếp tục được phân bổ một lần trên tổng.
- Form sửa khoản cũ có hành động riêng **Chọn người cho khoản này** nếu người dùng chủ động muốn đổi cách chia của chính khoản đó; không chuyển hàng loạt.
- Người vừa vào nhóm không tự được thêm vào bản nháp đang mở. Người rời nhóm vẫn hiện trong bản nhập để chủ động bỏ chọn trước khi lưu. API kiểm trạng thái trong transaction.

## Hợp đồng dữ liệu

**Bỏ chọn tất cả** bỏ cả người đang tham gia lẫn người đã rời nhóm trong phần chia. **Chọn tất cả** chỉ thêm người đang hoạt động; chưa chọn ai thì form yêu cầu chọn ít nhất một người trước khi gửi. Chi tiết giữ phần chia lịch sử và ghi rõ người đã rời nhóm/ngừng dùng.

Create/PATCH nhận `sharingScope: "selected"` cùng block tiền gồm `amountMinor`, `payerParticipantId`, `splitMethod` và `split`. `equal` dùng `split.participantIds`; `exact` dùng `split.shares`. Giới hạn 50 người, tổng phần phải khớp số tiền. Không gửi field này giữ hành vi cũ để client đã triển khai không bị thay đổi ngầm.

Expense lưu field tùy chọn `sharingScope: "selected"`, vẫn có `splitInput`, `shares` chuẩn và audit. Sửa tiền của expense đã chọn người phải gửi lại `sharingScope`; client cũ thiếu field bị chặn bằng `EXPENSE_SELECTION_REQUIRED` để tải lại ứng dụng. Metadata không cần block tiền và không chuyển cách chia.

Balance có `allocatedOwedMinor` tùy chọn: tổng phần phải chịu của các expense active có `sharingScope=selected`. Thiếu field được hiểu là 0 ở dữ liệu cũ. Trong nhóm tự chia tổng:

```text
chi cũ tự chia = totalExpenseMinor − tổng allocatedOwedMinor
owedMinor = allocatedOwedMinor + phần chia của chi cũ tự chia
netMinor = paidMinor − owedMinor + sentMinor − receivedMinor
```

Create/edit/void cập nhật phần cố định cùng balances, tổng, revision, ledgerVersion, operation và audit trong transaction. Đổi thành viên chỉ chia lại phần chi cũ; không quét hoặc viết lại lịch sử expense. Checker, reconciliation, repair và snapshot ngoại tuyến hiểu thành phần cố định. Không thêm index hoặc đổi Rules cho tính năng này.

Các field mới là phần mở rộng schema v1. Sau khi có khoản chọn người, chỉ dùng API/worker/repair hiểu `sharingScope` và `allocatedOwedMinor`; không rollback API về bản chưa hỗ trợ rồi bỏ qua lỗi checker. Ưu tiên sửa tiến, giữ dữ liệu nguồn và các lượt chuyển đã xác nhận.

## Kiểm chứng

Unit kiểm chia phần lẻ, giữ phần cố định, số tổng an toàn, QR theo bill và snapshot tài chính. Emulator kiểm legacy + selected, join/remove/restore, metadata/edit/void, replay, client cũ, danh sách sai và join đồng thời. Browser kiểm ví dụ 700.000đ/350.000đ/775.000đ, phần riêng, thành viên mới, ngoại tuyến, bỏ chọn người đã rời và giải mã QR để đối chiếu số tiền.

FE/API đã lên cùng SHA `5801c47230e322cdd0fb15f0295fede0437a12e6`; CI và cloud đạt, gồm UI tạo/sửa, giữ bản ghi cũ, Blob upload/view/download và giải mã ảnh QR theo khoản 350.000đ so với QR tổng 775.000đ. [Báo cáo phát hành và phạm vi](reports/2026-11-26-expense-selection-release.json). Các khoản synthetic đã hủy, QR thử đã gỡ và chuyến đã chốt; không thực hiện chuyển tiền ngân hàng hoặc gửi Zalo thật.
