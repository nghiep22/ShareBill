# QR và chia sẻ qua Zalo

ShareBill có hai loại QR: **lời mời tham gia chuyến đi** và **QR chuyển khoản ngân hàng**. Chúng dùng chung thư viện tạo ảnh QR, nhưng nội dung được mã hóa khác nhau.

## QR mời vào nhóm

Vào **Thành viên → Mời bạn → Tạo liên kết**. Giao diện hiện liên kết và ảnh QR có tên chuyến, thời hạn. Người nhận quét bằng camera điện thoại hoặc Zalo, mở liên kết, đăng nhập ShareBill và xác nhận tham gia. Quét QR chỉ mở lời mời; việc tham gia vẫn do API kiểm tra.

- Nội dung QR là toàn bộ URL `https://<domain>/#tham-gia/<token>`; token nằm trong fragment của URL.
- `prepareInviteQrShare()` trong `fe/src/qr-share.tsx` dùng `qrcode.toDataURL()` để tạo QR, Canvas 2D để ghép tên chuyến/thời hạn và `canvas.toBlob()` + `new File()` để tạo ảnh PNG chia sẻ. Ảnh được tạo ngay trong trình duyệt.
- `InviteShare()` trong `fe/src/invite-share.tsx` hiển thị QR, sao chép và chia sẻ liên kết; `shareLink()` gọi `navigator.share({ title, text, url })` trực tiếp từ thao tác bấm.
- `InviteManager()` trong `fe/src/api-trip-screens.tsx` tạo và thu hồi lời mời qua API. Khi tạo liên kết mới, ảnh cũ được thay; khi thu hồi, hết hạn hoặc API báo hết lượt, giao diện ngừng cung cấp ảnh/link đó để chia sẻ.
- Backend `newInviteToken()` dùng `crypto.randomBytes(32).toString('base64url')`; `inviteTokenHash()` dùng SHA-256 để tra cứu token trong Firestore. `resolveInvite()` kiểm tra thời hạn, thu hồi, trạng thái chuyến và epoch. API accept kiểm tra lượt sử dụng trong transaction.
- Token chỉ trả ở lần tạo mới, không đọc lại từ danh sách. Tải lại trang sẽ mất bản link/QR vừa tạo trong bộ nhớ; có thể dùng ảnh đã tải hoặc tạo lời mời mới. QR/link đã gửi cũng hết hiệu lực theo lời mời trên server.

## QR chuyển khoản

| Chức năng | Công nghệ và hàm trong mã nguồn |
| --- | --- |
| Lưu QR ngân hàng của thành viên | `PaymentQrCard()` và `PaymentImagePicker()` trong `fe/src/payments.tsx`; upload ảnh qua API rồi lưu `paymentQrReceiptId`. |
| Hiển thị ảnh QR gốc | `PaymentImage()` lấy URL xem ảnh có hạn từ `ReceiptActions.view()`; kho ảnh Vercel Blob riêng tư trên môi trường hiện tại. |
| Đọc QR từ ảnh ngân hàng | `readQr()` trong `fe/src/transfer-qr.tsx`: tải ảnh, vẽ lên Canvas, lấy pixel bằng `getImageData()`, giải mã bằng thư viện `jsqr` qua `jsQR()`. |
| Gắn số tiền cần chuyển | `withVietQrAmount()` trong `fe/src/vietqr.ts`: đọc VietQR NAPAS theo EMV TLV, kiểm CRC, giữ ngân hàng/tài khoản nhận, thay trường `54` bằng số tiền VND, đặt trường `01` thành `12`, tính lại CRC-16/CCITT-FALSE bằng `crc16()`. Chỉ hỗ trợ VietQR chuyển vào tài khoản NAPAS hợp lệ. |
| Tạo QR chuyển khoản mới | `TransferQr()` gọi `qrcode.toDataURL(payload, { width: 512, margin: 4, errorCorrectionLevel: 'M' })`. |
| Tạo ảnh gửi nhóm | `prepareQrShare()` trong `fe/src/qr-share.tsx`: Canvas 2D ghép QR, tên nhóm/người chuyển/người nhận, số tiền, thời điểm; `toBlob()` và `File` xuất PNG. |
| Chọn người và số cần trả | `ShareRepaymentQrs()` trong `fe/src/share-repayments.tsx`, `financialSnapshot()` và `validSuggestions()`: lấy số còn nợ theo dữ liệu quyết toán hiện tại. |

Frontend hiện dùng `qrcode@1.5.4`, `jsqr@1.4.0`, React và TypeScript. Không gọi dịch vụ tạo QR bên ngoài. Ảnh QR chỉ mang thông tin chuyển khoản; việc chuyển tiền thực hiện trong ứng dụng ngân hàng. ShareBill cập nhật công nợ qua luồng ghi nhận và xác nhận đã nhận tiền.

## Chia sẻ qua Zalo dùng gì?

`QrShareActions()` trong `fe/src/qr-share.tsx` được dùng cho cả QR lời mời và QR chuyển khoản:

| Thao tác | Hàm/API |
| --- | --- |
| Chia sẻ ảnh | Kiểm tra `navigator.canShare({ files })`, sau đó `navigator.share({ files, title, text })` để mở bảng chia sẻ của thiết bị; người dùng chọn Zalo và cuộc trò chuyện. |
| Tải ảnh gửi Zalo | Thẻ `<a download>` lưu PNG; người dùng đính kèm ảnh trong Zalo. |
| Sao chép ảnh | `navigator.clipboard.write([new ClipboardItem({ 'image/png': file })])`; mở Zalo, dán ảnh rồi gửi. Nếu clipboard không hỗ trợ/bị chặn, giao diện hướng dẫn tải ảnh. |
| Sao chép link/nội dung | `navigator.clipboard.writeText()`; khi bị chặn vẫn có ô để chọn và sao chép thủ công. |
| Mở Zalo Web | Liên kết `https://chat.zalo.me/` mở cuộc trò chuyện do người dùng lựa chọn; không tự đính kèm hoặc gửi ảnh/link. |

**Không dùng Zalo SDK, Zalo OA API hay Zalo Mini App.** Nút chia sẻ dùng [Web Share API của trình duyệt](https://www.w3.org/TR/web-share/). API mở danh sách ứng dụng do thiết bị cung cấp, không có tham số ép chọn Zalo; Zalo cần xuất hiện như một ứng dụng nhận chia sẻ trên thiết bị. Web Share cần secure context (HTTPS, hoặc localhost khi phát triển) và thao tác bấm của người dùng. Không thể bảo đảm mọi trình duyệt, Zalo WebView hay Zalo trên Windows đều hỗ trợ nhận file qua API này.

Trên máy tính, có thể **Tải ảnh gửi Zalo** rồi đính kèm, hoặc **Sao chép ảnh → mở Zalo → dán và gửi**. Nếu thiết bị hỗ trợ chia sẻ trực tiếp, chọn **Chia sẻ ảnh** rồi chọn Zalo. Hủy bảng chia sẻ không bị báo lỗi và không tự gửi nội dung. Chia sẻ QR không tạo hoặc xác nhận giao dịch tiền.

Kiểm thử trình duyệt giải mã ảnh QR tải xuống để đối chiếu đúng URL lời mời/số tiền chuyển khoản; thử mở QR lời mời bằng tài khoản khác và tham gia thật trên Firebase Emulator. Các nhánh Web Share/clipboard được mô phỏng để kiểm hỗ trợ, bị chặn và hủy; việc Zalo nhận ảnh trên từng điện thoại/máy tính cần nghiệm thu trên thiết bị đó.
