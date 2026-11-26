# S19 — Log HTTP và tra lỗi theo request

Runtime Fastify dùng chung `createServer` trong `be/src/logging.ts` cho local và Vercel. Mỗi request nhận UUID mới từ server; header `X-Request-Id` do client gửi không được dùng làm mã log. Response gửi mã qua `X-Request-Id`, CORS cho phép frontend đọc header này.

Mỗi response có một event `http.request.completed`, gồm `requestId`, method, route template, HTTP status, thời gian xử lý, môi trường và SHA của bản chạy. Query và giá trị tham số không được log: `/api/admin/v1/users?email=...` chỉ ghi `/api/admin/v1/users`; đường dẫn tài liệu ghi tên tham số như `:tripId`. Đường dẫn không khớp route được ghi `unmatched`.

Lỗi 5xx có thêm event `http.request.failed` cùng requestId. `errorCode` chỉ lấy từ danh sách mã cố định: bất biến tiền, lỗi socket và mã gRPC; lỗi khác dùng `INTERNAL_ERROR`. Đối chiếu event hoàn tất để biết route, status và bản triển khai. Hành vi này không thay đổi response nghiệp vụ hoặc quyền truy cập.

Hook logger chỉ nhận các trường trên, bỏ đối tượng/header/body tự do và nội dung message/stack/cause của exception. Thông báo log được tạo từ event cố định. Mật khẩu, bearer/refresh token, raw invite, URL ký, note, ticket và email trong URL không được đưa vào log HTTP. Hook có nhánh dự phòng cho exception getter lỗi để việc ghi log không làm hỏng xử lý request. Dùng API audit/operation để kiểm tra giao dịch và quyền truy cập theo danh tính được phép.

Năm kiểm thử ở `be/test/logging.test.ts` kiểm raw query/path/header/body/exception không lọt vào log, lỗi JSON/404, mã request giữa hai instance và header giả mạo, mã bất biến, và exception có getter lỗi. Các kiểm thử không cần credential cloud.

Đây là phần log HTTP của O13, chưa phải hệ thống cảnh báo hoàn chỉnh. Log/analytics do Vercel hoặc Google thu thập và báo cáo CLI có cấu hình riêng. Còn lịch workers/reconcile, backup/restore, repair và cảnh báo có nơi nhận trước khi đóng S19. Chưa có bằng chứng diễn tập backup/restore hoặc RPO/RTO.
