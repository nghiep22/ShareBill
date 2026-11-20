# O11/O12 — Diễn tập sao lưu và phục hồi local

Ngày 20/11/2026. Có CLI tự chạy một lượt export/import Firestore, Firebase Auth và Storage trên dữ liệu synthetic, sau đó kiểm sổ tiền, quyền, ảnh và repair. Không nhận project cloud hay địa chỉ Emulator đang dùng; luôn tạo project demo và hai bộ cổng loopback riêng.

## Chạy

Cần Node/pnpm và Java như [hướng dẫn backend](../be/README.md). Không cần dừng app hoặc Emulator local hiện có.

```powershell
pnpm --dir be backup:rehearse
# Xuất thêm báo cáo tổng hợp vào file mới:
pnpm --dir be backup:rehearse --report-file ../docs/reports/restore-local-new.json
```

Runner dùng `emulators:exec`, `--export-on-exit` và `--import` theo [hướng dẫn Firebase](https://firebase.google.com/docs/emulator-suite/install_and_configure#export_and_import_emulator_data). CLI Firebase quản lý vòng đời Emulator. Mỗi stage có hạn 180 giây; khi timeout/hủy, runner dừng cây tiến trình của chính lượt đó. Không gửi lệnh reset/import tới Emulator của người phát triển.

File báo cáo phải chưa tồn tại. Exit `0` khi đủ mọi kiểm chứng; exit `2` khi scope, file, tiến trình, bản export hoặc một cổng kiểm không đạt. Log riêng của lượt chạy nằm trong thư mục `.maintenance/restore-*` mà CLI thông báo. Thư mục này được loại khỏi Git và gói triển khai Vercel.

## Trình tự và phạm vi

1. Tạo project `demo-sb-restore-<random>` và source Emulator trống. Chỉ truyền biến môi trường cần cho runtime, không truyền token/secret/service account hay host Emulator của phiên làm việc hiện tại. Firebase CLI dùng thư mục cấu hình riêng.
2. Dùng API app tạo tài khoản, chuyến chia tổng chi, lời mời, khoản chi có ảnh, khoản đã hủy, một chuyển tiền confirmed, một pending, lịch trình và báo lỗi. Google operator Emulator tạo ghi chú nội bộ qua API quản trị. Ảnh JPEG thật được lưu trong Storage, receipt ready được seed bằng schema rồi attach qua API; đây không phải kiểm chứng signed upload hoặc IAM cloud.
3. Checker nguồn phải sạch. Chụp hash toàn bộ document và tài khoản. Duyệt cả collection con dưới document cha không tồn tại, gồm `adminOperations/<uid>/keys`, operations của user và internalNotes. Writer fixture kết thúc trước export; native export tạo bản Auth/Firestore/Storage rồi source Emulator dừng.
4. Lưu inventory SHA-256 của mọi file export, kiểm đủ ba phần và metadata đúng phạm vi. Sao chép Rules/indexes từ repo vào thư mục lượt chạy và ghi hash cấu hình. Native export không tự thay cho việc lưu Rules/indexes.
5. Khởi động target Emulator mới với project demo đó, trên bộ cổng khác, import bản sao. Chỉ source fixture của lượt này được phục hồi; không ghép vào môi trường có dữ liệu khác.
6. Trước khi ghi hay repair, so fingerprint tất cả document, tài khoản và provider UID. Đăng nhập lại email/mật khẩu và Google Emulator phải giữ UID; tài khoản disabled tiếp tục bị chặn. Kiểm quyền thành viên/người ngoài, Google guard, grant quản trị và việc tách ghi chú nội bộ khỏi API người dùng.
7. Gửi lại khoản chi bằng key cũ phải replay đúng ID và không ghi trùng. Đối chiếu số dư/confirmed/pending, receipt attachment, generation và byte hash ảnh. Dùng token client để xác nhận Firestore/Storage Rules vẫn deny; Admin SDK đọc ảnh riêng để đối chiếu.
8. Chỉ sau khi bản phục hồi nguyên trạng đã qua kiểm, làm hỏng projection synthetic trong target, chạy [B19 repair](PROJECTION_REPAIR.md), rồi yêu cầu checker sạch và công nợ khớp ban đầu. Hai Emulator tự dừng. Bản export được hash lại để xác nhận lượt import/verify không làm đổi nó.

Giới hạn kiểm chứng: inventory tối đa 2.000 document/namespace references, sâu tối đa 12; export tối đa 1.000 file và tổng 64 MiB. Đây là bộ dữ liệu thử nhỏ, không phải công cụ xuất toàn bộ môi trường production bất kỳ. Phạm vi Firestore là database `(default)`.

## Bản sao riêng và báo cáo tổng hợp

Trong `.maintenance/restore-*` có native export, fixture chứa mật khẩu/token synthetic, log, context, config, inventory và kế hoạch repair. Không tải cả thư mục này lên artifact hoặc chia sẻ như báo cáo. Các file này được giữ lại để điều tra lượt chạy; công cụ không tự xóa bản sao.

`report.json` chỉ chứa trạng thái, bộ đếm, các cổng kiểm, hash cấu hình/export và thời gian. Schema từ chối cổng thiếu/sai, checker còn lỗi và trường riêng tư thêm vào. Không có email, UID tài khoản/chuyến, token, mật khẩu, ghi chú, đường dẫn ảnh hoặc nội dung ledger. Job CI `recovery` chỉ upload file tổng hợp này, retention 7 ngày; không upload export/log. Cấu hình CI đã thêm, chưa có bằng chứng GitHub Actions của thay đổi chưa đẩy lên.

## Kết quả đã đo

[Báo cáo local ngày 20/11/2026](reports/2026-11-20-local-restore.json) ghi nhận:

| Kiểm chứng | Kết quả |
| --- | --- |
| Firestore | 53 document khớp fingerprint, gồm collection con và namespace không có document cha |
| Auth | 5 tài khoản; email/mật khẩu, Google UID/provider, trạng thái disabled và quyền quản trị khớp |
| Storage | 1 JPEG giữ receipt reference, generation và bytes |
| Quyền và sổ tiền | 18 cổng đạt; replay không ghi trùng, confirmed/pending đúng, checker 0 lỗi |
| Sửa sau phục hồi | Làm hỏng projection → repair target → checker sạch, số tiền khớp trước đó |
| File backup | 9 file, 46.634 bytes; hash giữ nguyên sau import/verify |
| Thời gian toàn lượt | 37.608 ms |
| Khởi động target + import + kiểm + repair + dừng | 18.604 ms |
| Tuổi checkpoint khi bắt đầu restore | 1.432 ms; không có writer mới sau checkpoint, mất 0 ghi fixture |

Các số đo chỉ áp dụng lượt synthetic trên máy local. `recoveryPointAgeMs` là tuổi checkpoint quan sát được, không phải cam kết RPO cloud; `restoreAndVerificationMs` không phải cam kết RTO production. Chưa có backup định kỳ staging/production, IAM/retention cloud, diễn tập dữ liệu thật hoặc nghiệm thu mục tiêu RPO/RTO trong [thiết kế CSDL](DATABASE.md#103-backup-và-phục-hồi).
