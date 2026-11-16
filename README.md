# ShareBill — Kế hoạch xây dựng app chia tiền du lịch

**Trạng thái triển khai:** monorepo có `fe/` và `be/`; đang làm backend trước. Đã có đăng ký/đăng nhập email và mật khẩu, làm mới Firebase ID token (JWT) cùng các API chia tiền đầu tiên. [Chạy backend local](be/README.md). Tài liệu dưới đây là thiết kế đích, một số API/tính năng vẫn chưa được code.

Tài liệu thiết kế và triển khai, cập nhật ngày **16/11/2026**. Ngôn ngữ sản phẩm: tiếng Việt. Mục tiêu: một người có thể đi từ phân tích bài toán, làm frontend/backend, kiểm thử đến vận hành bản thật.

## Bộ tài liệu

| Tài liệu | Nội dung | Người dùng chính |
| --- | --- | --- |
| [Kế hoạch sản phẩm](docs/PRODUCT_PLAN.md) | Phạm vi MVP, hành trình người dùng, quy tắc tiền, quyền, kiến trúc, quyết định SQLite/Firebase | Cả FE và BE |
| [Đặc tả Frontend](docs/FRONTEND.md) | Từng màn hình, form, component, state, API integration, mobile-first, PWA, offline, accessibility | FE |
| [Đặc tả Backend](docs/BACKEND.md) | Schema Firestore, API, phân quyền, chia tiền, transaction, idempotency, ảnh hóa đơn, phương án SQLite | BE |
| [Website quản trị React/Node.js](docs/ADMIN_WEB.md) | UX đơn giản, dashboard, người dùng, chuyến đi, hỗ trợ, quyền quản trị và API Node.js | FE quản trị và BE |
| [CI/CD và triển khai](docs/CICD_DEPLOY.md) | Môi trường, secrets, GitHub Actions, Vercel, Firebase Rules, release, rollback, backup, vận hành | Cả FE và BE |
| [Lộ trình và kiểm thử](docs/ROADMAP_TESTING.md) | Công việc theo giai đoạn, dependency, acceptance criteria, dữ liệu mẫu, test matrix, checklist ra mắt | Cả FE và BE |

**Thứ tự đọc:** Product → Frontend/Backend song song → CI/CD → Roadmap. Khi triển khai, mã lỗi, tên trường và công thức trong Backend là hợp đồng kỹ thuật; phạm vi và quy tắc người dùng trong Product là chuẩn nghiệp vụ. Thay đổi hợp đồng phải cập nhật cả hai phía và test liên quan trong cùng PR.

## Hướng triển khai đề xuất

- **Frontend:** thư mục `fe/` dành cho Next.js/React + TypeScript, responsive mobile-first, PWA và website quản trị React.
- **Backend:** thư mục `be/` dùng Fastify + Node.js + TypeScript, API REST `/api/v1` và tương lai `/api/admin/v1`. Vercel hỗ trợ Fastify theo [tài liệu chính thức](https://vercel.com/docs/frameworks/backend/fastify).
- **Website quản trị:** giao diện React thuộc `fe/`, gọi API Node.js trong `be/`; quyền riêng theo [đặc tả quản trị](docs/ADMIN_WEB.md).
- **Dữ liệu:** Firebase Authentication + Cloud Firestore; mọi thao tác ghi nghiệp vụ đi qua backend.
- **Ảnh hóa đơn:** Cloud Storage for Firebase, bucket riêng tư, upload có kiểm soát.
- **CI/CD:** GitHub Actions kiểm tra và điều phối triển khai Vercel/Firebase, tách staging và production.
- **Offline MVP:** xem bản dữ liệu đã lưu và soạn bản nháp; gửi giao dịch tiền khi có mạng.

Yêu cầu ưu tiên bổ sung: **thao tác dễ dàng, dễ hiểu**. Luồng nhập chi tiêu mặc định chỉ cần tên, số tiền, người trả và người chia; phần nâng cao được mở khi cần. Có tiêu chí usability và kịch bản kiểm thử trong tài liệu quản trị/lộ trình.

SQLite được phân tích như phương án thay thế trong Backend. Không dùng file SQLite trên filesystem của Vercel Functions làm database production. Lý do và nguồn kiểm chứng nằm trong [quyết định kiến trúc](docs/PRODUCT_PLAN.md#8-quyết-định-kiến-trúc).

## Phạm vi bộ tài liệu

Đây là kế hoạch và phần khởi đầu backend. `be/` đã có code chạy local; `fe/` mới là khung thư mục. Các đoạn TypeScript, Rules và YAML **trong docs/** vẫn là mẫu thiết kế, cần hoàn thiện theo checklist trước khi deploy. Chưa có Firebase cloud project, deployment hay tài nguyên trả phí nào được tạo.

Các đề xuất chưa có trong yêu cầu gốc được đánh dấu là **giả định thiết kế** hoặc **P1/P2**, để dễ điều chỉnh mà không nhầm với yêu cầu đã được chốt.
