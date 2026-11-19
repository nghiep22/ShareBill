# S19 — Đối soát sổ tiền theo từng lượt

Worker `db:reconcile` chạy lại checker hiện có, lưu tiến độ vào `maintenanceJobs/ledger-reconcile-all` hoặc `maintenanceJobs/ledger-reconcile-<tripId>`. Chỉ tài khoản máy chủ tin cậy chạy CLI; không có endpoint công khai để kích hoạt và không chạy tự động trong request của người dùng.

## Chạy một lượt

Từ thư mục gốc repo, khi Emulator và cấu hình local trong `be/.env` đã sẵn sàng:

```powershell
pnpm.cmd --dir be db:reconcile --project demo-sharebill --limit 5
pnpm.cmd --dir be db:reconcile --project demo-sharebill --trip <trip-uuid> --page-size 50
```

Mỗi lần gọi xử lý tối đa 1–10 chuyến, mặc định 5, rồi thoát. Page size đọc tài liệu là 1–100; giới hạn này không phải tổng số tài liệu của một chuyến. Checker giữ giới hạn ledger 2.000 khoản chi/2.000 settlement và kiểm đầy đủ membership, signal, receipt, audit theo phạm vi hiện có. Nếu một chuyến quá lớn hoặc đọc quá lâu, lượt đó có thể hết lease và phải điều tra riêng bằng `db:check`.

CLI kiểm project khớp cấu hình. Project `demo-*` phải có Firestore Emulator; cloud không được lẫn host Emulator. Môi trường cloud cần credential máy chủ của đúng project và bỏ cấu hình `.env` local. Không đưa credential vào tham số, frontend, Git hoặc artifact. Worker không tự đọc phiên CLI Google cá nhân.

Kết quả gồm mã job, trạng thái, số chuyến đã thử trong lượt và tổng hợp. Exit 0 khi lượt đạt hoặc bị bỏ qua vì lease/cooldown; exit 1 khi summary hiện có sai lệch/lỗi quét; exit 2 khi tham số, credential, giao dịch hoặc lease bị lỗi. Khi bị bỏ qua, kiểm trang Hệ thống để xem kết quả lần trước; code 0 lúc skip không chứng minh sổ tiền sạch.

## Khóa, retry và tiếp tục

- Khóa 120 giây có owner UUID và cycle riêng. Lượt chạy trùng cùng scope nhận `lease-held`; khác scope có thể cùng đọc vì không ghi dữ liệu nghiệp vụ.
- Worker gia hạn trước khi kiểm mỗi chuyến. Chỉ owner còn lease mới ghi checkpoint/kết quả. Lượt chậm không được công bố kết quả khi lease đã hết, kể cả chưa có worker khác nhận khóa.
- Mỗi chuyến thành công được cộng summary và cập nhật checkpoint trong cùng transaction của job. Sau crash, lượt mới nhận lease hết hạn và tiếp tục từ checkpoint, không cộng kết quả cũ hai lần.
- Lỗi đọc hoặc chuyến đổi liên tục khiến checker chưa kết luận sẽ giữ nguyên chuyến để thử lại, cách ít nhất 5 giây. Tối đa 3 lần; sau đó ghi một lỗi quét và đi tiếp, không retry vô hạn. Không lưu exception, token hay diff riêng tư vào job.
- Quét xong chuyển `succeeded` nếu không có lỗi, hoặc `failed` nếu có sai lệch/lỗi quét. Chu kỳ mới chỉ bắt đầu sau 15 phút; bộ đếm được đặt lại cho chu kỳ mới. Chuyến được tạo với ID nhỏ hơn checkpoint trong khi đang quét sẽ được kiểm ở chu kỳ sau.

Kết quả đang quét chưa là kết luận toàn dự án. Checkpoint là tiến độ đọc, không phải snapshot nguyên tử của mọi chuyến. Checker kiểm lại revision/updateTime của từng chuyến; job không khóa thao tác người dùng.

## Xem và xử lý kết quả

Trong `/admin` → **Hệ thống**, phần bảo trì hiện “Đối soát sổ tiền”, trạng thái, số chuyến đã kiểm, số chuyến cần kiểm tra, tổng sai lệch và số lỗi quét. API chỉ trả năm bộ đếm đã kiểm schema; không trả checkpoint, lease owner, nội dung ledger hoặc diff tài liệu.

`RECONCILE_ISSUES_FOUND` cần operator chạy checker chi tiết trong môi trường tin cậy để xác định sai lệch. `RECONCILE_SCAN_FAILED` cần kiểm credential, giới hạn, dữ liệu legacy và tần suất thay đổi. Worker chỉ ghi metadata job; không sửa số dư, khoản chi, settlement, quyền, audit hoặc signal. Repair cần backup/fence/diff/version và vẫn là công việc riêng của S19.

## Kiểm chứng và phần còn mở

Emulator có bộ kiểm thử riêng trong named database để tách dữ liệu người phát triển. Đã kiểm dữ liệu thật của checker và fingerprint toàn cây chuyến/user trước-sau, projection hỏng, chạy trùng, crash/reclaim, lease hết hạn, retry có giới hạn, phục hồi lỗi tạm thời, cooldown, phân trang và trường hợp chuyến retry bị xóa. API admin có kiểm thử lọc dữ liệu; hành trình browser operator kiểm phần tổng hợp trong Hệ thống.

CLI hiện chạy một lượt, chưa cấu hình scheduler cloud. Có thể đưa vào trusted runner định kỳ sau khi chốt identity, giới hạn lượt và theo dõi exit code; không thêm vòng lặp vô hạn hay tự repair. Lịch Auth/cleanup, cảnh báo có nơi nhận, backup, restore/RPO/RTO và repair còn mở. Môi trường tiếp tục giữ gói miễn phí hiện tại.
