# ShareBill — Các lát cắt triển khai nhỏ

Cập nhật 16/11/2026. **105 lát cắt tổng cộng; đã xong D01–D02, còn 103**, chia thành 6 nhóm tài liệu. Đây là kế hoạch thực thi phần còn thiếu của ShareBill, giữ ưu tiên **backend trước**. Không đánh dấu hoàn tất chỉ vì đã có schema mẫu hoặc API happy path.

## 1. Những gì đã có để dùng làm đầu vào

| Đã có | Giới hạn hiện tại |
| --- | --- |
| Monorepo public `fe/` và `be/`, môi trường Node/pnpm/Java, CI backend | FE mới có README; chưa có CI frontend hoặc deployment cloud |
| API register/login/refresh Firebase JWT | D02 đã thống nhất bootstrap; profile legacy cần migration D13 |
| Tạo chuyến/người/khoản chi equal/exact, void expense, overview/suggestions, pending/confirm settlement | Chưa đủ fields/audit/operation của thiết kế; còn thiếu nhiều lifecycle và pagination |
| Thiết kế CSDL, 16 composite indexes, seed local có assertion | Chưa có migration runner/checker, chưa deploy/test index cloud |

Các phần đã có không tạo thành task “làm lại”. Lát D/F/B tương ứng chỉ bổ sung điều kiện còn thiếu hoặc nối FE vào BE hiện có. [D01](01_DATABASE_BE.md#d01) và [D02](01_DATABASE_BE.md#d02) đã hoàn tất; [D03](01_DATABASE_BE.md#d03) là lát kế tiếp.

## 2. Cách dùng một lát cắt

- Mỗi lát tập trung vào một kết quả có thể demo bằng API, script hoặc màn hình. Mục tiêu 2–6 giờ tập trung; migration/concurrency có thể 6–8 giờ. Đây là kích thước mục tiêu, không phải deadline.
- Nếu triển khai vượt một ngày hoặc cần hai kết quả độc lập, tách tiếp thành `D12a/D12b` và cập nhật dependency trước khi tiếp tục; giữ mã gốc làm mục cha.
- Mỗi lát làm trên một thay đổi review được, thường là một commit/PR nhỏ. Lát BE bao gồm schema/service/route và test cần cho chính hành vi đó; không đợi đến cuối dự án mới kiểm tiền/quyền.
- Làm một lát tại một thời điểm. Trước khi bắt đầu, các dependency phải hoàn tất; vị trí trong bảng ưu tiên không cho phép bỏ dependency.
- Trạng thái dùng `Chưa làm → Đang làm → Hoàn tất`; nếu thiếu cloud credential hoặc quyết định sản phẩm thì ghi đúng điều kiện còn thiếu. Chỉ đóng sau khi có bằng chứng kiểm thử/nghiệm thu.
- Thay đổi tài liệu chỉ kiểm nội dung/link/dependency; thay đổi code chạy check và test phù hợp. Khi sửa money/auth/transaction phải có case lỗi hoặc cạnh tranh cần thiết, không chỉ happy path.

Có thể yêu cầu theo mã, ví dụ: **“Làm D01”**, **“Làm tiếp D02”** hoặc **“Thực hiện D01 đến D03 theo thứ tự”**. Các câu này chỉ là ví dụ cách giao việc; tài liệu này chưa tự bắt đầu triển khai các lát.

## 3. Danh mục sáu nhóm

| Nhóm | Mã | Số lát | Tài liệu |
| --- | --- | ---: | --- |
| CSDL và chuẩn hóa BE đang có | D01–D22 | 22 | [01_DATABASE_BE.md](01_DATABASE_BE.md) |
| Nghiệp vụ BE còn thiếu | B01–B19 | 19 | [02_NGHIEP_VU_BE.md](02_NGHIEP_VU_BE.md) |
| Ảnh hóa đơn | I01–I08 | 8 | [03_HOA_DON.md](03_HOA_DON.md) |
| App React mobile | F01–F25 | 25 | [04_FRONTEND_APP.md](04_FRONTEND_APP.md) |
| Quản trị và hỗ trợ | A01–A17 | 17 | [05_ADMIN_HO_TRO.md](05_ADMIN_HO_TRO.md) |
| CI/CD, offline và vận hành | O01–O14 | 14 | [06_VAN_HANH.md](06_VAN_HANH.md) |

Mỗi thẻ có: trạng thái, dependency, kết quả, phạm vi file/module, việc làm, kiểm thử và điều kiện hoàn tất. Các module mới là vị trí dự kiến; không cần tạo cả cây thư mục rỗng ngay từ đầu.

## 4. Thứ tự làm đề xuất cho một người, BE trước

| Đợt | Lát cắt theo thứ tự | Mốc có thể demo |
| --- | --- | --- |
| 1 | D01 → D22 | API hiện có ghi dữ liệu v1, có migration/checker và pagination |
| 2 | B01 → B19 | Đủ nghiệp vụ metadata, membership/invite, expense edit, settlement, archive và repair có kiểm soát |
| 3 | I01 → I07 | BE upload/finalize/attach/view/cleanup ảnh có kiểm quyền |
| 4 | A01, A03, A05, A07, A08, A10, A12, A15 | API admin/support và worker Auth; chưa phụ thuộc website admin |
| 5 | F01 → F25 | App mobile đi được từ đăng nhập đến ghi chi, trả nợ, mời thành viên và chốt chuyến |
| 6 | I08, A02, A04, A06, A09, A11, A13, A14, A16, A17 | Giao diện ảnh, hỗ trợ người dùng và website quản trị |
| 7 | O01 → O14 | CI browser, realtime/PWA/offline, staging, restore và cổng phát hành production |

Thứ tự trên đã được đối chiếu dependency của cả 105 lát. Cloud staging O06/O07 và CI O01 có thể làm sớm khi đủ dependency để giảm thời gian chờ; không cần trì hoãn cấu hình cloud đến cuối. Đây không phải yêu cầu chạy đồng thời hoặc giao nhiều agent.

## 5. Hai lát đã xong và ba lát kế tiếp

| Thứ tự | Lát | Sản phẩm review được |
| --- | --- | --- |
| 1 ✅ | [D01](01_DATABASE_BE.md#d01) — schema user | Đã có schema/factory hồ sơ và 4 kiểm thử; chưa nối vào writer (D02) |
| 2 ✅ | [D02](01_DATABASE_BE.md#d02) — bootstrap thống nhất | Register/login/create trip dùng một writer; user disabled không bị mở lại |
| 3 | [D03](01_DATABASE_BE.md#d03) — tạo chuyến đầy đủ | Một transaction có owner membership/participant/link/balance/ref/signal/audit/op |
| 4 | [D04](01_DATABASE_BE.md#d04) — thêm participant | Người chưa có tài khoản có metadata và zero balance đúng |
| 5 | [D05](01_DATABASE_BE.md#d05) — expense v1 | Writer đủ trường, reader vẫn đọc expense legacy |

Sau D03–D05, chạy luồng emulator đang có và seed để kiểm lại tổng chi/số dư. Nếu fail phải sửa trong lát vừa làm trước khi chuyển D06; không dùng seed thay kiểm migration hoặc cloud index.

## 6. Cổng nghiệm thu theo cụm

| Sau cụm | Bằng chứng cần có |
| --- | --- |
| D01–D09 | Existing mutations ghi schema/audit/operation mới; retry và tài khoản disabled đúng |
| D10–D18 | Checker/reconcile read-only; migration dry-run/apply/rerun/crash-resume; không đổi ledger hoặc mất key |
| D19–D22 | Cursor/filter đúng với dữ liệu hơn một trang; cloud index còn chờ O09 |
| B01–B19 | Lifecycle/quyền/concurrency đúng; expense/settlement đổi tiền đúng một lần; repair không là public mutation |
| I01–I07 | Lease/generation/attach/cleanup không làm mất ảnh đang dùng |
| F01–F25/I08 | Luồng mobile dễ hiểu, timeout/conflict không sinh giao dịch trùng, không mất draft |
| A01–A17 | User thường bị chặn admin; moderation có reason/audit/desired-state sync; ticket chỉ đúng người được xem |
| O01–O14 | CI và smoke staging/cloud index/backup/restore đạt; production đúng SHA/môi trường và có rollback |

## 7. Liên kết với tài liệu lớn

| Nhóm cũ | Lát chi tiết thay cho công việc lớn |
| --- | --- |
| DATABASE DB-02 | D01, D02, D03, D04, D05, D07 |
| DATABASE DB-03 | D03, D04, D06, D08 |
| DATABASE DB-04 / DBM-001..007 | D10–D18, B19 |
| DATABASE DB-05 | B11–B13; các writer nền D05–D09 |
| DATABASE DB-06 | B03–B10, B14–B15 |
| DATABASE DB-07 | I01–I08 |
| DATABASE DB-08 | A01–A17 |
| DATABASE DB-09 | O06–O14 |
| FRONTEND FE-01..10 | F01–F25, I08, O01–O05 |
| ROADMAP giai đoạn 0–9 | Dùng sáu nhóm trên làm work items; giai đoạn cũ chỉ là mốc sản phẩm |

Tham chiếu: [Database](../DATABASE.md), [Backend](../BACKEND.md), [Frontend](../FRONTEND.md), [Admin](../ADMIN_WEB.md), [Roadmap và test matrix](../ROADMAP_TESTING.md), [CI/CD](../CICD_DEPLOY.md).

## 8. Mẫu ghi kết quả khi đóng một lát

```md
Mã: D01
Trạng thái: Hoàn tất
Commit/PR: <đường dẫn hoặc SHA>
Đã đổi: <hành vi hoặc dữ liệu thay đổi>
Đã kiểm: <lệnh/case và kết quả>
Giới hạn còn lại: <nếu có, ghi mã lát theo dõi>
Lát tiếp theo: D02
```

Không điền trạng thái hoàn tất cho các lát còn thiếu chỉ vì đã hoàn thành phần lập kế hoạch.
