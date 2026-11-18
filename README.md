# ShareBill — Kế hoạch xây dựng app chia tiền du lịch

**Trạng thái triển khai** — Web/PWA mobile-first nằm trong `fe/` và API nằm trong `be/`. Trong mã nguồn hiện tại, `/` và `/live` dùng API cho tài khoản, chuyến đi, thành viên, lời mời, chi tiêu, quyết toán, lịch trình và báo lỗi. `/demo/` mở bản mẫu với dữ liệu trong trình duyệt. Môi trường staging hiện có dùng Vercel Hobby và Firebase Spark. [Hướng dẫn chạy frontend](fe/README.md) · [Mở bản đang triển khai](https://sharebill-nghiep22.vercel.app/) · [Tài liệu API staging](https://sharebill-api-staging.vercel.app/docs/) · [Thiết lập staging](docs/CICD_DEPLOY.md).

Tài liệu thiết kế và triển khai, cập nhật ngày **16/11/2026**. Ngôn ngữ sản phẩm: tiếng Việt. Mục tiêu: một người có thể đi từ phân tích bài toán, làm frontend/backend, kiểm thử đến vận hành bản thật.

## Bộ tài liệu

| Tài liệu | Nội dung | Người dùng chính |
| --- | --- | --- |
| [Kế hoạch sản phẩm](docs/PRODUCT_PLAN.md) | Phạm vi MVP, hành trình người dùng, quy tắc tiền, quyền, kiến trúc, quyết định SQLite/Firebase | Cả FE và BE |
| [Đặc tả Frontend](docs/FRONTEND.md) | Từng màn hình, form, component, state, API integration, mobile-first, PWA, offline, accessibility | FE |
| [Đặc tả Backend](docs/BACKEND.md) | Schema Firestore, API, phân quyền, chia tiền, transaction, idempotency, ảnh hóa đơn, phương án SQLite | BE |
| [Backend ảnh hóa đơn](docs/RECEIPTS.md) | API S10, upload/xem ảnh có hạn, lease xử lý ảnh, attach, cleanup và cổng kiểm tra bucket thật | BE, FE và vận hành |
| [Thiết kế và hoàn thiện CSDL](docs/DATABASE.md) | Quan hệ và từ điển dữ liệu đầy đủ, index, ràng buộc, migration legacy, seed, backup/restore và kế hoạch hoàn thiện | BE, FE và vận hành |
| [Website quản trị React/Node.js](docs/ADMIN_WEB.md) | UX đơn giản, dashboard, người dùng, chuyến đi, hỗ trợ, quyền quản trị và API Node.js | FE quản trị và BE |
| [CI/CD và triển khai](docs/CICD_DEPLOY.md) | Môi trường, secrets, GitHub Actions, Vercel, Firebase Rules, release, rollback, backup, vận hành | Cả FE và BE |
| [Lộ trình và kiểm thử](docs/ROADMAP_TESTING.md) | Công việc theo giai đoạn, dependency, acceptance criteria, dữ liệu mẫu, test matrix, checklist ra mắt | Cả FE và BE |
| [20 lát cắt triển khai](docs/slices/README.md) | S01–S10 có bằng chứng local, S11–S17 đã triển khai luồng và còn các cổng nghiệm thu | Người trực tiếp triển khai |
| [Kế hoạch hoàn thiện và tiến độ](docs/KE_HOACH_HOAN_THIEN.md) | K01–K11, tiến độ M01–M12 và bằng chứng kiểm thử hiện tại | Cả FE, BE và vận hành |

**Thứ tự đọc:** Product → Database → Frontend/Backend song song → CI/CD → Roadmap. Khi triển khai, Database là hợp đồng lưu trữ, Backend là hợp đồng API và công thức; phạm vi và quy tắc người dùng trong Product là chuẩn nghiệp vụ. Thay đổi hợp đồng phải cập nhật cả hai phía và test liên quan trong cùng PR.

Giao diện quản trị nằm ở `/admin`. Cấp quyền Google operator và chạy worker theo [hướng dẫn backend](be/README.md#quản-trị). Công việc tiếp tục tập trung nghiệm thu thiết bị thật, bucket ảnh staging và phát hành trong [kế hoạch hoàn thiện](docs/KE_HOACH_HOAN_THIEN.md).

## Hướng triển khai đề xuất

- **Frontend:** thư mục `fe/` dành cho Next.js/React + TypeScript, responsive mobile-first, PWA và website quản trị React.
- **Backend:** thư mục `be/` dùng Fastify + Node.js + TypeScript, API REST `/api/v1` và `/api/admin/v1`. Vercel hỗ trợ Fastify theo [tài liệu chính thức](https://vercel.com/docs/frameworks/backend/fastify).
- **Website quản trị:** giao diện React thuộc `fe/`, gọi API Node.js trong `be/`; quyền riêng theo [đặc tả quản trị](docs/ADMIN_WEB.md).
- **Dữ liệu:** Firebase Authentication + Cloud Firestore; mọi thao tác ghi nghiệp vụ đi qua backend.
- **Ảnh hóa đơn:** Cloud Storage for Firebase, bucket riêng tư, upload có kiểm soát.
- **CI/CD:** GitHub Actions kiểm tra và điều phối triển khai Vercel/Firebase, tách staging và production.
- **Offline MVP:** xem bản dữ liệu đã lưu và soạn bản nháp; gửi giao dịch tiền khi có mạng.

Yêu cầu ưu tiên bổ sung: **thao tác dễ dàng, dễ hiểu**. Luồng nhập chi tiêu mặc định chỉ cần tên, số tiền, người trả và người chia; phần nâng cao được mở khi cần. Có tiêu chí usability và kịch bản kiểm thử trong tài liệu quản trị/lộ trình.

SQLite được phân tích như phương án thay thế trong Backend. Không dùng file SQLite trên filesystem của Vercel Functions làm database production. Lý do và nguồn kiểm chứng nằm trong [quyết định kiến trúc](docs/PRODUCT_PLAN.md#8-quyết-định-kiến-trúc).

## Phạm vi bộ tài liệu

Repo có giao diện Web/PWA, backend và môi trường staging trên Vercel Hobby/Firebase Spark. Các đoạn TypeScript, Rules và YAML **trong docs/** vẫn có nội dung thiết kế đích cần đối chiếu với phần đã triển khai. Trạng thái và cách chạy từng phần nằm trong README của `fe/`, `be/` và tài liệu staging.

Các đề xuất chưa có trong yêu cầu gốc được đánh dấu là **giả định thiết kế** hoặc **P1/P2**, để dễ điều chỉnh mà không nhầm với yêu cầu đã được chốt.
