# Frontend ShareBill

Ứng dụng người dùng là Web/PWA mobile-first, viết bằng Next.js và TypeScript. Trang `/` dùng API cho đăng ký/đăng nhập, tạo chuyến đi, thêm thành viên và khoản chi chia đều; khi chạy ở localhost, trang gọi API local tại cổng 3001. Trang `/demo/` dựa trên các mẫu trong [GiaoDien](../GiaoDien/GiaoDien) và lưu dữ liệu minh họa trên trình duyệt. Các thao tác quyết toán và mời bạn trong bản xem thử chưa gọi API hoặc đồng bộ với người khác.

## Chạy giao diện

Từ thư mục gốc của repo:

```sh
pnpm install
pnpm --dir fe dev
```

Chạy Firebase Emulator và backend theo [hướng dẫn backend](../be/README.md#chạy-local), rồi mở `http://localhost:3000` để dùng dữ liệu local. Không dùng tài khoản Firebase staging trên emulator; dữ liệu emulator có thể mất khi dừng. Mở `http://localhost:3000/demo/` để xem bản mẫu mà không cần backend. Để thử cài PWA và tải lại khi mất mạng, dừng máy chủ dev rồi chạy bản production:

```sh
pnpm --dir fe build
pnpm --dir fe start
```

Mở ứng dụng một lần khi có mạng để service worker lưu phần giao diện. Dữ liệu thật vẫn cần kết nối API; bản `/demo/` chỉ lưu trên thiết bị. Khi thử trên điện thoại, phục vụ thư mục `fe/out` qua HTTPS để trình duyệt có thể cài PWA.

## Tích hợp backend

Backend nằm trong `../be`. Hợp đồng API của người dùng và quản trị nằm ở [BACKEND.md](../docs/BACKEND.md) và [ADMIN_WEB.md](../docs/ADMIN_WEB.md).

Giao diện hiện dùng REST `/api/v1/auth/register`, `/login`, `/refresh` của backend, lưu phiên trong `sessionStorage` của tab và gửi `Authorization: Bearer <token>` cho thao tác dữ liệu. Trên localhost, yêu cầu đi tới API tại `http://localhost:3001`; trên host khác dùng API staging. Hợp đồng và lỗi xem [be/README.md](../be/README.md). Không đặt Firebase Admin SDK hoặc private key trong thư mục này. Chưa có đặt lại mật khẩu, sửa/hủy khoản chi hoặc quyết toán trong luồng dữ liệu thật.

Sau khi SDK đăng ký/đăng nhập thành công, gọi `POST /api/v1/me/bootstrap` với Bearer ID token và body trống; sau đó dùng `GET /api/v1/me` để đọc hồ sơ. Tên hiển thị ở Firebase Auth được cập nhật trước khi bootstrap. Backend không nhận UID, role hay status từ body của client.

<details>
<summary>Ảnh bìa chuyến đi</summary>

Ảnh [da-lat.jpg](public/da-lat.jpg) được tạo bằng công cụ ImageGen tích hợp.

> Use case: photorealistic-natural. Asset type: panoramic trip cover photo for the ShareBill mobile app. Generate a premium realistic travel photograph of Đà Lạt, Vietnam at dawn from above, looking out across the pine-covered rolling hills and an understated coffee-growing valley. Soft low clouds between the receding mountains, clusters of Vietnamese hillside rooftops barely visible in the middle distance, dark green pines in foreground, and subtle warm golden first light coming from the far right. Expansive and peaceful natural color, blue-green shadows, quiet detail, authentic travel editorial photography. Wide landscape framing approximately 2.25:1 with the clearest hills and light on the right half, ample darker pine texture at left and lower frame for a short white app title that will be layered later. No embedded text, people, graphics, frames, logos, or watermarks.

</details>
