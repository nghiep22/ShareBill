# Bảo trì định kỳ trên Vercel Hobby

API có trusted endpoint `GET /api/internal/maintenance`, dùng các worker Auth và đối soát sổ tiền hiện có. `be/vercel.json` cấu hình cron `0 20 * * *`: khoảng **03:00–03:59 giờ Việt Nam** mỗi ngày. Vercel Hobby chỉ hỗ trợ tần suất hằng ngày và không bảo đảm đúng phút; không đổi gói hoặc bật billing trong đợt này. [Giới hạn cron chính thức](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing).

## Quyền và phạm vi

- `CRON_SECRET` là secret phía server, 32–256 ký tự base64url; Vercel tự gửi `Authorization: Bearer <CRON_SECRET>` cho cron. Không dùng Firebase JWT, query token hoặc user-agent để xác thực. Thiếu/sai cấu hình thì không gọi worker.
- Không nhận query/body hoặc scope tùy ý. `HEAD` và `POST` không kích hoạt. Response là `private, no-store`.
- Một lượt quét tối đa 25 hồ sơ Auth, xử lý tối đa 25 tác vụ Auth và đối soát tối đa một chuyến, page size 50. Các worker giữ checkpoint để lượt sau tiếp tục.
- Auth chỉ áp trạng thái quản trị đã ghi trong hồ sơ. Đối soát chỉ đọc sổ tiền và ghi metadata tác vụ; không tự repair, không tạo/xác nhận chuyển tiền, không xóa ảnh, không tạo backup.

Với nhiều hồ sơ/chuyến, một chu kỳ có thể cần nhiều lượt hằng ngày. Đây là lịch nền cơ bản trong hạn mức miễn phí, không phải cam kết kiểm toàn bộ dự án mỗi ngày hoặc đáp ứng lịch 15 phút. Khoảng 15 phút trong worker là cooldown, không phải tần suất cron Hobby. Nếu cần xử lý nhanh, trusted operator có thể gọi endpoint bằng secret sau cooldown hoặc dùng CLI worker hiện có trong môi trường tin cậy.

## Chống trùng và phục hồi

`maintenanceJobs/scheduled-maintenance` lưu trạng thái, lần chạy, mốc thời gian và bộ đếm. Transaction nhận khóa 5 phút; request đồng thời trả `skipped=lease-held`, request trong cooldown 15 phút trả `skipped=cooldown`, không gọi lại worker. Function giới hạn 240 giây, ngắn hơn lease. Sau crash, request mới nhận lại khóa khi hết hạn; worker cũ không được công bố kết quả hoặc mở bước sau khi đã mất/hết khóa. Worker Auth từng UID và worker đối soát vẫn giữ khóa riêng.

Hai bước được kiểm độc lập: lỗi Auth không ngăn thử đối soát, lỗi đối soát không xóa kết quả Auth. Lỗi upstream chỉ ghi mã cố định, không lưu exception hoặc nội dung riêng tư. Bộ đếm chưa biết giữ `null`, không giả bằng 0.

HTTP 200 có thể là lượt hoàn tất hoặc bỏ qua. `status=succeeded` nói lượt chạy hoàn tất; `ledgerState=queued` nghĩa là chu kỳ đối soát còn tiếp tục, `not-due`/`lease-held` nghĩa là lượt đó không kiểm lại ledger. HTTP 503 khi có lỗi hoặc phát hiện sai lệch; kiểm metadata job để phân biệt và xử lý. Không suy ra sổ tiền sạch từ một request 200 hoặc số chuyến xử lý bằng 0.

## Vận hành

1. Đặt `CRON_SECRET` ở **Production environment của project API** bằng Vercel Secrets, rồi deploy API. Secret được chụp vào deployment; đổi secret cần deploy lại. Project ứng dụng vẫn có `APP_ENVIRONMENT=staging` dù Vercel target là production.
2. Kiểm request không secret bị chặn trước khi gọi worker. Chạy một lượt xác thực và kiểm trạng thái/kết quả; gửi lại phải bị cooldown. Không in secret hoặc header vào log/báo cáo.
3. Vào `/admin` → **Hệ thống** xem **Bảo trì định kỳ**, số hồ sơ/tác vụ, trạng thái đối soát, số chuyến trong lượt, sai lệch/lỗi của chu kỳ và thời điểm cập nhật. DTO không trả secret, lease owner, checkpoint hoặc diff sổ tiền.
4. Kiểm lần cron thực sự đầu tiên qua Vercel Schedules/Cron Jobs và log request. Một lần gọi thủ công xác thực chứng minh endpoint hoạt động, chưa chứng minh scheduler đã tự kích hoạt. Vercel giao cron theo best effort, có thể trùng hoặc lỡ lượt. [Xác thực và giao cron](https://vercel.com/docs/schedules/cron-jobs/manage-cron-jobs).

Mã lỗi chính: `MAINTENANCE_NOT_CONFIGURED`, `MAINTENANCE_UNAVAILABLE`, `MAINTENANCE_AUTH_FAILED`, `MAINTENANCE_LEDGER_FAILED`, `RECONCILE_ISSUES_FOUND`. Kiểm secret/snapshot deployment với lỗi xác thực, credential/index/runtime với lỗi thực thi, và [checker/đối soát](LEDGER_RECONCILIATION.md) với sai lệch tiền. Không tự sửa hoặc bỏ qua số dư để làm job chuyển xanh.

Sao lưu/restore cloud, retention, thông báo tới người vận hành và nghiệm thu Google operator thật vẫn là các cổng riêng. [Diễn tập restore local](RESTORE_REHEARSAL.md) không chứng minh đã có backup cloud.
