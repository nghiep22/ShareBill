# Frontend ShareBill

Thư mục dành cho ứng dụng React/Next.js mobile-first và website quản trị. Backend được triển khai trước trong `../be`; hợp đồng API nằm tại `../docs/BACKEND.md` và `../docs/ADMIN_WEB.md`.

Khi bắt đầu frontend, dùng Firebase Web SDK cho đăng ký/đăng nhập **email và mật khẩu**, quản lý phiên và lấy ID token (JWT), rồi gọi BE với `Authorization: Bearer <token>`. Backend cũng có REST `/api/v1/auth/register`, `/login`, `/refresh` cho client không dùng SDK; hợp đồng và lỗi xem [be/README.md](../be/README.md). Không đặt Firebase Admin SDK hoặc private key trong thư mục này.

Sau khi SDK đăng ký/đăng nhập thành công, gọi `POST /api/v1/me/bootstrap` với Bearer ID token và body trống; sau đó dùng `GET /api/v1/me` để đọc hồ sơ. Tên hiển thị ở Firebase Auth được cập nhật trước khi bootstrap. Backend không nhận UID, role hay status từ body của client.
