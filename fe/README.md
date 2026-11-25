# Frontend ShareBill

Ứng dụng người dùng là Web/PWA mobile-first, viết bằng Next.js và TypeScript. Trang `/` và đường dẫn tương thích `/live` dùng API ShareBill. Đã gỡ bản xem thử, dữ liệu mẫu khởi tạo và chức năng lưu hồ sơ mẫu. Link `/demo` cũ chuyển về ứng dụng chính trên Vercel và qua service worker.

## Chạy giao diện

Từ thư mục gốc của repo:

```sh
pnpm install
pnpm --dir fe dev
```

Để dùng ứng dụng tại `http://localhost:3000`, chạy [Firebase Emulator và backend](../be/README.md#chạy-local), sau đó đăng ký hoặc đăng nhập. Các thao tác nghiệp vụ cần API.

Màn hình đăng nhập có **Quên mật khẩu?** để yêu cầu hướng dẫn qua email. Firebase xử lý liên kết đặt lại mật khẩu; giao diện dùng cùng thông báo cho email có hoặc chưa có tài khoản. Khi đang đăng nhập, đăng ký hoặc gửi yêu cầu khôi phục, form hiện trạng thái và khóa gửi lặp. Lỗi dịch vụ tạm thời giữ phiên để có thể thử lại.

Để thử cài PWA và tải lại khi mất mạng, dừng máy chủ dev rồi chạy bản production.

```sh
pnpm --dir fe build
pnpm --dir fe start
```

Mở ứng dụng khi có mạng để service worker lưu giao diện. Trong Tài khoản, chọn **Tin cậy thiết bị này** để lưu snapshot và nháp thêm khoản chi mới trong IndexedDB. Dữ liệu tách theo API, UID và chuyến, hết hạn đọc sau 24 giờ. Khi ngoại tuyến, có thể mở tổng quan, số dư và soạn khoản chi mới từ snapshot. App kiểm lại dữ liệu khi có mạng và chờ người dùng bấm lưu. Nháp sửa khoản chi và ảnh upload chưa lưu ngoại tuyến. Tắt lựa chọn hoặc đăng xuất để xóa dữ liệu riêng trên thiết bị.

Snapshot giữ cách chia đều, danh sách thành viên được chia và danh tính của người đang xem, nên nhóm vẫn hiển thị đúng khi mở lại ngoại tuyến. Khi có mạng, form dùng danh sách thành viên mới nhất trước khi người dùng lưu. Bản cache của phiên bản cũ thiếu cách chia sẽ yêu cầu kết nối lại để tải dữ liệu; app không tự đoán cách chia từ bản cache đó.

App tự kiểm phiên bản mới mỗi phút khi đang mở và kiểm lại khi có mạng hoặc quay về ứng dụng. Bản mới tự áp dụng và tải lại khi các tab ShareBill không có nội dung đang nhập, giao dịch đang lưu hoặc hộp thoại đang mở; không hiện thông báo yêu cầu cập nhật. Sau khi lưu hoặc rời form, app tự tiếp tục cập nhật. Tab còn chạy phiên bản cũ cần bấm **Cập nhật** một lần hoặc đóng hết tab ShareBill rồi mở lại để nhận cơ chế này. Khi thử trên điện thoại, phục vụ thư mục `fe/out` qua HTTPS. Khi quay lại dev, worker tại `public/sw.js` gỡ worker production cũ sau khi trình duyệt cập nhật worker.

## Tích hợp backend

Backend nằm trong `../be`. Hợp đồng API của người dùng và quản trị nằm ở [BACKEND.md](../docs/BACKEND.md) và [ADMIN_WEB.md](../docs/ADMIN_WEB.md).

Giao diện chính gọi REST cho tài khoản, chuyến đi, thành viên, lời mời, chi tiêu, quyết toán, lịch trình, hỗ trợ và lịch sử. Nhóm mới tự chia tổng chi cho các tài khoản đang trong nhóm, kể cả chi phí trước khi họ tham gia; không cần liên kết hay chọn lại từng khoản. Sửa tên/ghi chú của khoản cũ giữ nguyên dữ liệu tiền, kể cả sau khi người ứng rời nhóm. [Quy tắc chia tổng chi](../docs/GROUP_SHARING.md). Phiên đăng nhập được lưu trong `sessionStorage` của tab. Trên localhost, API mặc định dùng cổng 3001. Đặt `NEXT_PUBLIC_SHAREBILL_API_URL` khi build nếu cần chỉ định API khác.

Trong **Lịch trình**, chủ chuyến thêm, sửa, xóa hoạt động và duyệt đề xuất. Thành viên có quyền truy cập chuyến xem lịch trình và đề xuất điểm đến. Mở **Trợ giúp và báo lỗi** từ **Tài khoản**, hoặc mở **Báo lỗi về chuyến đi** trong cài đặt chuyến để kèm ngữ cảnh. Người gửi tra mã và trạng thái trong **Báo lỗi của tôi**. Operator xử lý tại `/admin`. [Hướng dẫn quản trị](../be/README.md#quản-trị)

Ngày xem lịch trình nằm trong link `/#chuyen/{tripId}/lich-trinh?day=YYYY-MM-DD`, giữ khi tải lại hoặc mở link ở tab mới. Đổi ngày giữ focus và vị trí cuộn; máy khác thêm hoạt động cũng không tự chuyển ngày đang xem. Bộ chọn ngày luôn hiển thị, kể cả khi chuyến chưa có ngày bắt đầu/kết thúc; mặc định dùng ngày đầu chuyến hoặc ngày hoạt động sớm nhất. Khi tải lại lỗi, lịch đã tải vẫn xem được và khóa ghi tới khi tải thành công. Bản sửa được giữ khi xung đột; trước khi xóa, cần kiểm tra lại nếu hoạt động vừa đổi trên máy khác.

Link màn hình chuyến có dạng `/#chuyen/{tripId}/khoan-chi/{expenseId}?category=food`. Bộ lọc đi cùng link khi mở chi tiết và quay lại. App kiểm revision qua API mỗi 30 giây khi tab đang hiện, cùng lúc chuyển màn hình, trở lại foreground hoặc có mạng. Sau lỗi mạng, mục **thao tác chưa rõ kết quả** cho tra operation. Gửi lại đúng nội dung/version dùng lại key đã lưu trong tab.

Trên điện thoại, thanh dưới mở Tổng quan, Chi tiêu, Số dư và Thành viên. Mục **Thêm** mở Lịch trình, Hoạt động, Cài đặt chuyến đi, Tài khoản và Trợ giúp. Tiêu đề cùng thao tác chính luôn ở đầu màn hình khi cuộn; nút lưu khoản chi nằm ở cuối vùng nhìn. Danh sách ngày lịch trình cuộn ngang cho chuyến dài ngày.

## Kiểm thử trình duyệt và quản trị

`pnpm --dir fe test:browser` có 28 hành trình bằng Playwright với frontend cổng 3000, API 3001 và Emulator 8080/9099, gồm bố cục 320–1280px, điều hướng, Auth, lịch trình, luồng tiền, hóa đơn, QR lời mời/chia sẻ, quản trị và nháp ngoại tuyến. Hai hành trình ngoại tuyến kiểm giữ cách chia nhóm sau reload, lấy lại danh sách thành viên khi có mạng và từ chối suy đoán cách chia từ cache cũ. Cài Chromium bằng `pnpm --dir fe exec playwright install chromium`. Trên Windows có thể đặt `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` tới Chrome. Đặt `SHAREBILL_PWA_TEST=1` khi kiểm bản static production để kiểm cả reload offline và smoke S18; đặt cùng `RELEASE_COMMIT` khi build FE, chạy API và chạy bộ test. [Hướng dẫn smoke và cấu hình cloud](../docs/STAGING_SMOKE.md).

Sau khi build, `pnpm --dir fe test:pwa` chạy 5 tình huống đổi phiên bản service worker thực tế: tự tải lại đúng một lần, giữ nội dung đang nhập, không chặn cập nhật sau khi chọn ngày xem, chờ giao dịch/hộp thoại và chờ tab khác đang soạn. Bộ này dùng máy chủ local riêng và được chạy trong CI.

Trang `/admin` dùng Google sign-in và quyền server trong `platformAdmins/{uid}`. Sao chép các trường Firebase public trong [.env.example](.env.example) và đặt giá trị của môi trường khi build. Với project demo trên localhost, Google popup dùng Auth Emulator. Môi trường cloud cần Google provider và authorized domains đã cấu hình. Phiên quản trị nằm trong bộ nhớ, đăng nhập lại sau reload. API kiểm quyền ở mỗi request và yêu cầu xác thực trong 10 phút cho lệnh ghi.

Ảnh hóa đơn đi qua upload intent, tải trực tiếp lên kho lưu trữ, finalize rồi gắn vào khoản chi. Ảnh đính kèm được mở bằng liên kết ngắn hạn. Tải ảnh trên môi trường thật cần bucket, CORS và quyền ký đã cấu hình. [Hợp đồng ảnh hóa đơn](../docs/RECEIPTS.md)

<details>
<summary>Ảnh bìa chuyến đi</summary>

Ảnh [da-lat.jpg](public/da-lat.jpg) được tạo bằng công cụ ImageGen tích hợp.

> Use case: photorealistic-natural. Asset type: panoramic trip cover photo for the ShareBill mobile app. Generate a premium realistic travel photograph of Đà Lạt, Vietnam at dawn from above, looking out across the pine-covered rolling hills and an understated coffee-growing valley. Soft low clouds between the receding mountains, clusters of Vietnamese hillside rooftops barely visible in the middle distance, dark green pines in foreground, and subtle warm golden first light coming from the far right. Expansive and peaceful natural color, blue-green shadows, quiet detail, authentic travel editorial photography. Wide landscape framing approximately 2.25:1 with the clearest hills and light on the right half, ample darker pine texture at left and lower frame for a short white app title that will be layered later. No embedded text, people, graphics, frames, logos, or watermarks.

</details>
