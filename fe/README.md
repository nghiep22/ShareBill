# Frontend ShareBill

Thư mục dành cho ứng dụng React/Next.js mobile-first và website quản trị. Backend được triển khai trước trong `../be`; hợp đồng API nằm tại `../docs/BACKEND.md` và `../docs/ADMIN_WEB.md`.

Khi bắt đầu frontend, dùng Firebase Web SDK để đăng nhập, lấy ID token rồi gọi BE với `Authorization: Bearer <token>`. Không đặt Firebase Admin SDK hoặc private key trong thư mục này.
