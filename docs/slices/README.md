# ShareBill — 20 lát cắt triển khai

Cập nhật 19/11/2026. **S01–S10 có kiểm chứng local/Emulator. S11–S17 đã có luồng trong mã nguồn và còn các cổng nghiệm thu. S18 đã deploy và có bằng chứng cloud cho Auth/tiền/index; còn Google, ảnh và thiết bị thật.** Tiến độ hiện tại theo [kế hoạch hoàn thiện](../KE_HOACH_HOAN_THIEN.md).

## Thứ tự triển khai

| Mã | Lát cắt | Trạng thái | Phụ thuộc |
| --- | --- | --- | --- |
| [S01](01_DATABASE_BE.md#s01) | Hồ sơ và phiên đăng nhập | Hoàn tất | — |
| [S02](01_DATABASE_BE.md#s02) | Khởi tạo chuyến và người tham gia | Hoàn tất | [S01](01_DATABASE_BE.md#s01) |
| [S03](01_DATABASE_BE.md#s03) | Ghi sổ tiền, audit và chống trùng | Hoàn tất | [S02](01_DATABASE_BE.md#s02) |
| [S04](01_DATABASE_BE.md#s04) | Kiểm tra CSDL và đối soát ledger | Hoàn tất | [S03](01_DATABASE_BE.md#s03) |
| [S05](01_DATABASE_BE.md#s05) | Migration dữ liệu legacy | Hoàn tất trên Emulator | [S04](01_DATABASE_BE.md#s04) |
| [S06](01_DATABASE_BE.md#s06) | Phân trang và hợp đồng API cho frontend | Hoàn tất trên Emulator | [S05](01_DATABASE_BE.md#s05) |
| [S07](02_NGHIEP_VU_BE.md#s07) | Chỉnh thông tin chuyến và người tham gia | Hoàn tất trên Emulator | [S05](01_DATABASE_BE.md#s05) |
| [S08](02_NGHIEP_VU_BE.md#s08) | Lời mời và vòng đời thành viên | Hoàn tất trên Emulator | [S06](01_DATABASE_BE.md#s06), [S07](02_NGHIEP_VU_BE.md#s07) |
| [S09](02_NGHIEP_VU_BE.md#s09) | Sửa giao dịch và chốt chuyến | Hoàn tất trên Emulator | [S08](02_NGHIEP_VU_BE.md#s08) |
| [S10](03_HOA_DON.md#s10) | Backend ảnh hóa đơn | Hoàn tất local/Emulator, chưa smoke bucket thật | [S09](02_NGHIEP_VU_BE.md#s09) |
| [S11](04_FRONTEND_APP.md#s11) | Ứng dụng mobile, tài khoản và chuyến đi | Đã triển khai local, còn nghiệm thu | [S06](01_DATABASE_BE.md#s06), [S07](02_NGHIEP_VU_BE.md#s07) |
| [S12](04_FRONTEND_APP.md#s12) | Giao diện khoản chi và ảnh hóa đơn | Đã triển khai local, còn nghiệm thu | [S10](03_HOA_DON.md#s10), [S11](04_FRONTEND_APP.md#s11) |
| [S13](04_FRONTEND_APP.md#s13) | Giao diện trả nợ và chốt chuyến | Đã triển khai local, còn nghiệm thu | [S09](02_NGHIEP_VU_BE.md#s09), [S11](04_FRONTEND_APP.md#s11) |
| [S14](04_FRONTEND_APP.md#s14) | Giao diện lời mời, thành viên và hoạt động | Đã triển khai local, còn nghiệm thu | [S08](02_NGHIEP_VU_BE.md#s08), [S11](04_FRONTEND_APP.md#s11) |
| [S15](05_ADMIN_HO_TRO.md#s15) | Quản trị tài khoản và chuyến | Đã triển khai local, còn nghiệm thu | [S11](04_FRONTEND_APP.md#s11) |
| [S16](05_ADMIN_HO_TRO.md#s16) | Hỗ trợ, audit và tổng quan quản trị | Đã triển khai local, còn nghiệm thu | [S15](05_ADMIN_HO_TRO.md#s15) |
| [S17](06_VAN_HANH.md#s17) | CI browser, realtime và offline | Đã triển khai local, còn nghiệm thu | [S12](04_FRONTEND_APP.md#s12), [S13](04_FRONTEND_APP.md#s13) |
| [S18](06_VAN_HANH.md#s18) | Cloud staging và smoke test | FE/API/Auth/tiền/index đạt cloud, còn Google/ảnh/thiết bị thật | [S16](05_ADMIN_HO_TRO.md#s16), [S17](06_VAN_HANH.md#s17) |
| [S19](06_VAN_HANH.md#s19) | Workers, backup, restore và sửa sai lệch | Chưa làm | [S18](06_VAN_HANH.md#s18) |
| [S20](06_VAN_HANH.md#s20) | Nghiệm thu và phát hành production | Chưa làm | [S14](04_FRONTEND_APP.md#s14), [S19](06_VAN_HANH.md#s19) |

## Cách thực hiện và cập nhật tiến độ

- Theo dõi trạng thái **Chưa làm → Đang làm → Hoàn tất** trên S01–S20. Mỗi lát có kết quả kiểm chứng được và có thể triển khai qua nhiều PR.
- Mở phần **Các bước và tiêu chí chi tiết** trong từng lát để xem phạm vi file, kiểm thử và đối chiếu mã cũ. D01–D09 đã hoàn tất và có bằng chứng trong S01–S03.
- Bắt đầu từ backend. Các bước chuẩn bị cloud trong S18 có thể làm sớm sau khi hoàn tất phần liên quan ở S04 và S06. Đóng S18 sau khi đủ phụ thuộc và có kết quả smoke staging.
- Đóng lát sau khi đạt tiêu chí nghiệm thu. Với tiền, quyền và transaction, kiểm cả lỗi và cạnh tranh liên quan. Ghi lại commit/PR, bằng chứng kiểm thử và điều kiện còn thiếu nếu có.

## Tài liệu liên quan

[CSDL](../DATABASE.md) · [Backend](../BACKEND.md) · [Frontend](../FRONTEND.md) · [Quản trị](../ADMIN_WEB.md) · [Lộ trình và ma trận kiểm thử](../ROADMAP_TESTING.md) · [CI/CD](../CICD_DEPLOY.md)
