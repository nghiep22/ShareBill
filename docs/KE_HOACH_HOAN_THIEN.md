# ShareBill — Khảo sát hiện trạng và kế hoạch hoàn thiện

Ngày khảo sát 18/11/2026 · Phạm vi mã trong workspace, giao diện và API local, Firebase Emulator, bộ thiết kế `GiaoDien` và đặc tả nghiệp vụ.

## Chọn người theo khoản và sửa QR ngày 26/11/2026

Theo yêu cầu mới, khoản chi mới trong nhóm chọn người tham gia, chia đều hoặc nhập từng phần. Danh sách và số tiền được lưu cùng sổ tiền; thêm/gỡ thành viên không chia lại khoản đã chọn người. Các khoản cũ giữ cách tính cũ theo lựa chọn của người dùng, không migration hàng loạt. Chi tiết luôn hiện mỗi người chịu bao nhiêu; QR tại khoản chi dùng phần của chính khoản đó. QR tại Số dư vẫn dùng công nợ toàn chuyến. Hộp thoại theo khoản ghi rõ chưa trừ lượt chuyển đã xác nhận.

Đã kiểm ví dụ nhóm ba người, vé 700.000đ chỉ chọn hai người: Bình chịu và có QR 350.000đ, dù số dư cả chuyến là 775.000đ; người không được chọn không xuất hiện trong phần chia/QR. Đã kiểm sửa sang phần riêng, thành viên thứ tư không bị tính vào chi đã chọn, reload ngoại tuyến, người rời nhóm trong lúc soạn, giữ khoản cũ, replay, metadata/edit/void và join đồng thời. Unit hiện có 247 ca; file group Emulator đạt 12 ca. Bộ browser cập nhật 35 hành trình. Kết quả CI/cloud của bản phát hành sẽ bổ sung sau khi deploy. [Hợp đồng và ví dụ](EXPENSE_SHARING.md).

## Phát hành phiên và ngoại tuyến ngày 26/11/2026

FE và API đã deploy cùng SHA `113926d6dbcba9e242d7d78a0e79fc98fdd47115` lên domain [ShareBill](https://sharebill-nghiep22.vercel.app/). [CI](https://github.com/nghiep22/ShareBill/actions/runs/45770790589) đạt 238 unit/HTTP, 98 Emulator, 33 hành trình browser, 5 PWA, 10 smoke và diễn tập restore cách ly. Trên domain thật đã kiểm đổi tài khoản với phản hồi cũ đến muộn, cache hỏng khi offline rồi reconnect, lưu khi IndexedDB treo, đăng nhập khi storage bị chặn và retry sau mất phản hồi chỉ tạo một khoản chi. Luồng Auth/tiền/replay/quyết toán/chốt và bố cục 320/390/1280px đạt; không có lỗi JavaScript.

Các khoản chi thử đã hủy và ba chuyến browser synthetic đã chốt; chuyến của smoke tiền cũng đã chốt. Hai domain phục vụ đúng deployment mới, cron bảo trì vẫn bật trên API hiện hành; thông tin bypass tạm dùng kiểm candidate đã thu hồi. [Bằng chứng, phạm vi và rollback](reports/2026-11-26-session-offline-reliability-release.json). Còn nghiệm thu thiết bị vật lý, Google operator, giao thư thật, lịch tự chạy sau bản mới và backup/restore cloud.

## Phục hồi khi bộ nhớ ngoại tuyến lỗi ngày 26/11/2026

Mỗi bước mở IndexedDB hoặc thực hiện transaction chờ tối đa 5 giây. Khi bị chặn, treo hoặc hết dung lượng, form giữ bản nhập trong tab và hướng dẫn giữ tab mở; lỗi xóa nháp sau khi server đã lưu không làm kẹt trạng thái đang lưu. Connection mở muộn được đóng, transaction quá hạn được hủy và connection nhường khi có yêu cầu đổi phiên bản database.

Snapshot và nháp được kiểm cấu trúc, tài khoản/chuyến, loại dữ liệu và mốc lưu trước khi khôi phục. Bỏ bản quá 24 giờ, timestamp không hợp lệ hoặc ở tương lai; snapshot còn phải có ngày/múi giờ hợp lệ, danh sách chia đúng và số tiền nhất quán. Bản nháp được phép chưa nhập đủ nhưng không nhận cấu trúc hỏng. Đọc và xóa cache lỗi trong cùng transaction để không xóa nhầm bản mới từ tab khác. Callback lưu snapshot cũ bị bỏ qua sau khi đổi chuyến hoặc rời màn hình.

Kiểm chứng local: 32 ca unit mới kiểm validation và giới hạn chờ; ba hành trình trình duyệt mới kiểm cache hỏng/hết hạn, nháp hỏng rồi soạn lại và lưu chi tiêu khi IndexedDB treo. Bộ hồi quy gồm 238 unit/HTTP, 33 hành trình trên static/PWA, 5 kiểm thử cập nhật PWA và 10 kiểm thử công cụ smoke. Typecheck/build FE và BE đạt. Đã bổ sung kiểm chứng cloud trong mục phát hành ở trên; Chromium trên desktop chưa thay cho Safari iOS/Chrome Android và bộ nhớ thiết bị vật lý.

CI phát hiện bước hủy chuyển tiền trong fixture cũ có thể nhận nhầm nút lọc **Đã hủy** trước khi giao dịch hoàn tất. Bài kiểm thử đã đổi sang chờ nhãn trạng thái trên thẻ chuyển tiền và kiểm danh sách pending rỗng trước khi mở sửa khoản chi. Không đổi quy tắc hay runtime quyết toán.

## Cách ly phiên đăng nhập và khôi phục giao dịch ngày 26/11/2026

Mỗi lần đăng nhập/đăng xuất tạo một mốc phiên riêng, kể cả khi đăng nhập lại cùng tài khoản. Phản hồi đọc, ghi, retry và refresh của phiên cũ bị bỏ qua; lỗi 401 hoặc tài khoản bị khóa đến muộn không làm mới token hoặc đăng xuất phiên mới. Refresh trong cùng phiên vẫn dùng chung một request và giữ các lượt đọc đang chạy. Nếu có nhiều yêu cầu đăng nhập đồng thời, chỉ yêu cầu mới nhất được nhận kết quả.

Giao dịch chưa rõ kết quả giữ khóa chống trùng trong nhật ký của tài khoản ban đầu để tra cứu hoặc gửi lại sau khi đăng nhập lại. Bỏ callback của màn hình đã đóng và không tự nâng cấp cách chia của chuyến từ phản hồi của màn hình đã rời. Khi trình duyệt chặn lưu trữ, phiên và khóa retry vẫn hoạt động trong bộ nhớ của tab; thông báo yêu cầu giữ tab mở vẫn hiển thị.

Kiểm chứng local ban đầu: 18 ca mới về cạnh tranh phiên trong bộ unit, hai hành trình mới với API/Firebase Emulator kiểm đổi tài khoản khi tổng quan đang tải và mất phản hồi sau khi đã lưu khoản chi trên trình duyệt chặn storage. Lượt đó gồm 206 unit/HTTP, 30 hành trình trình duyệt trên bản static/PWA, 5 tình huống cập nhật PWA và 10 kiểm thử công cụ smoke. Typecheck và build FE/BE đạt. Sau khi bổ sung hoàn thiện bộ nhớ, đã deploy và kiểm cloud cùng đợt phát hành ở trên; các cổng thiết bị vật lý, Google operator, giao thư thật và backup/restore cloud vẫn cần nghiệm thu riêng.

## Worker bảo trì và lịch Hobby ngày 25/11/2026

Đã bổ sung endpoint máy chủ dùng `CRON_SECRET`, không nhận Firebase token/query scope hoặc HEAD. Một lượt đồng bộ Auth có giới hạn và kiểm một chuyến bằng worker đối soát hiện có. Transaction nhận khóa 5 phút, cooldown 15 phút và kiểm chủ khóa/hạn khóa trước mỗi checkpoint; request trùng không chạy worker, callback cũ sau crash/reclaim không công bố kết quả. Auth/ledger lỗi độc lập, bộ đếm chưa biết giữ null, exception riêng tư không lưu vào job.

Cron `0 20 * * *` tương ứng khoảng 03:00–03:59 giờ Việt Nam, hằng ngày trên Vercel Hobby. Giữ gói miễn phí; cooldown 15 phút không đồng nghĩa scheduler chạy mỗi 15 phút. Với nhiều người/chuyến, một chu kỳ cần nhiều ngày; không cam kết đã quét toàn dự án chỉ vì lượt hiện tại thành công. UI quản trị có nhãn **Bảo trì định kỳ**, trạng thái và bộ đếm đã kiểm schema, không trả secret/lease/checkpoint/diff.

Local đã đạt 188 unit/HTTP (9 ca route mới), 17 ca Emulator Auth/quản trị/worker (7 ca fencing mới) và hành trình Google operator qua giao diện System. FE/BE typecheck/build đạt; OpenAPI có 71 thao tác. Cron secret được lưu phía project API. [Runbook và giới hạn](SCHEDULED_MAINTENANCE.md); SHA/bằng chứng cloud được ghi trong lịch sử triển khai. Backup/restore cloud, cleanup tự động, thông báo có người nhận và nghiệm thu lịch tự kích hoạt đầu tiên vẫn cần kiểm riêng.

FE/API đã deploy cùng SHA `83f321a773f0b239ee97169689217ab25107dcb4`. Cloud kiểm request bảo vệ, một lượt xác thực (24 hồ sơ Auth, một chuyến, 0 lỗi/sai lệch trong lượt), request lặp bị cooldown và smoke ứng dụng synthetic đạt. Vercel project có cron enabled, đúng definition và deployment đang phục vụ domain. Chu kỳ ledger vẫn queued; lần cron tự kích hoạt đầu tiên chưa quan sát. [Báo cáo chi tiết](reports/2026-11-25-scheduled-maintenance-release.json).

## Rà soát và ổn định chế độ ngoại tuyến ngày 25/11/2026

Đã bổ sung snapshot riêng tư các trường `sharingMode`, `equalParticipantIds`, `myParticipantId`. Nhóm tự chia đều tiếp tục giữ đúng danh sách chia, số dư và danh tính người đang xem sau khi reload ngoại tuyến; không quay về giao diện chia từng khoản. Sau khi có mạng, form kiểm theo danh sách thành viên hiện tại và chờ người dùng bấm lưu. Bản cache cũ thiếu cách chia của chuyến đang mở được bỏ qua, có hướng dẫn kết nối lại thay vì tự suy đoán cách chia.

Hai hành trình mới kiểm nhóm hai người có chi chung, reload khi mất mạng, xem số dư, soạn nháp, người thứ ba tham gia trong lúc offline, rồi kết nối lại và lưu đúng ba phần; cùng việc từ chối cache cũ và phục hồi khi có mạng. Bộ trình duyệt trên bản static/PWA đạt 28/28, PWA update đạt 5/5; kiểm tiền, ảnh, lời mời và quản trị đều nằm trong lượt này. FE/BE typecheck và build đạt; 179 unit/HTTP và 10 kiểm thử công cụ smoke đạt.

Lượt Emulator toàn bộ có 89/90 ca đạt, ca phân trang cũ thất bại do tạo 32 pending cho cùng cặp người gửi/nhận, trái quy tắc hiện tại. Đã đổi fixture thành 32 cặp riêng với công nợ hợp lệ, giữ kiểm phân trang/timestamp trùng/cursor cũ; chạy lại file phân trang đạt 2/2. Không nới quy tắc chống pending trùng trong runtime.

QR mời nhóm, chia sẻ/tải/sao chép ảnh gửi Zalo và mục hóa đơn luôn hiện đã triển khai và kiểm cloud trong các đợt trước cùng ngày. Bằng chứng và SHA hiện tại được ghi tại [lịch sử triển khai](CICD_DEPLOY.md).

Đợt ngoại tuyến đã lên FE tại SHA `5eafee6bd0e0b7b5181d9511253ed024249c0767`. Domain thật kiểm thành công nhóm hai người với công nợ 75.000đ, reload offline, soạn nháp, người thứ ba tham gia, reconnect không tự submit và lưu đúng ba phần sau khi người dùng bấm lưu. Cache cũ thiếu cách chia hiện hướng dẫn tải lại và phục hồi khi có mạng. Chuyến synthetic đã chốt, các khoản thử đã hủy. [Báo cáo cloud và phạm vi kiểm thử](reports/2026-11-25-offline-group-reliability-release.json).

Các cổng còn cần nghiệm thu riêng: Safari iOS/Chrome Android và camera trên thiết bị vật lý, giao thư khôi phục mật khẩu thật, Google operator trên cloud, lịch workers/cảnh báo và backup/restore cloud. Kiểm thử Google Emulator, viewport điện thoại và diễn tập restore local không thay cho các cổng này. Những ghi chú ngày 18–24/11 bên dưới là bằng chứng theo từng thời điểm.

## Lịch trình khi đổi ngày và nhiều máy cùng sửa ngày 24/11/2026

Ngày đang xem được lưu trong query `day` của link lịch trình; giữ khi tải lại và bỏ qua ngày không hợp lệ. Chuyến chưa định ngày mở hoạt động sớm nhất, có bộ chọn ngày luôn hiển thị để mở ngày chưa có hoạt động hoặc ngày ngoài hàng nút cuộn. Đổi query giữ focus/vị trí cuộn; hoạt động mới từ máy khác không tự đổi ngày mặc định đang xem. Chọn ngày xem không đánh dấu là bản nhập cần giữ khi cập nhật PWA.

Khi tải lại chậm/lỗi, giữ lịch đã tải để xem và khóa các lệnh ghi tới khi có dữ liệu hợp lệ. Hộp thoại sửa/xóa hiển thị lỗi đọc ngay bên trong, giữ bản nhập. Xóa hoạt động kiểm version lúc mở; nếu lịch trình đã đổi, cần xem lại hoạt động mới nhất trước khi xác nhận, hoặc báo hoạt động đã bị gỡ. Không thay đổi API hay công thức tiền.

Ba hành trình mới kiểm link ngày, chuyến chưa có ngày/dài ngày, ngày sai, giữ bản sửa khi xung đột, kiểm tra lại trước khi xóa, hoạt động bị máy khác gỡ và trạng thái tải chậm/lỗi. Bộ PWA có thêm ca chọn ngày xem rồi tự cập nhật, nâng tổng lên 5 ca. TypeScript, production build và lượt kiểm tra cuối 24/24 hành trình cùng 5/5 PWA đạt.

Đã triển khai FE tại SHA `f3e901b610c35b166746215cb5410459a969be2d`, giữ API `f936eaaceed74501033e477015aa747c8ef5f4e3`. Trên domain thật, chuyến thử riêng đã kiểm giữ focus/ngày khi tải lại, bố cục 320/390/1280px, lưu hoạt động qua API và kiểm tra lại bản mới trước khi xóa sau sửa đồng thời. Chuyến thử đã chốt, tổng chi và ledgerVersion vẫn bằng 0. Sau chỉnh focus, kiểm riêng thêm 5 hành trình điều hướng/lịch trình và luồng tiền đều đạt. [Báo cáo phát hành và ghi chú kiểm thử](reports/2026-11-24-itinerary-reliability-release.json).

## Khôi phục tài khoản và ổn định phiên ngày 24/11/2026

Bổ sung **Quên mật khẩu** từ đăng nhập và API `/api/v1/auth/password-reset`: email được chuẩn hóa, Firebase gửi hướng dẫn tiếng Việt, phản hồi không tiết lộ địa chỉ có tài khoản hay không và không trả mã đặt lại. Form đăng nhập/đăng ký/khôi phục khóa gửi lặp và hiện trạng thái đang xử lý. Lỗi REST hoặc kiểm tra token tạm thời trả 503/429 thay vì xóa phiên; token sai/hết hạn/thu hồi vẫn trả 401 và tài khoản bị khóa trả 403, áp dụng cho cả API người dùng và quản trị. Phản hồi refresh thiếu dữ liệu cũng được coi là lỗi dịch vụ.

Kiểm chứng: 22 kiểm thử Auth theo HTTP (gồm ma trận kiểm tra token user/admin/refresh), 16 ca Emulator liên quan tài khoản/quản trị, 21 hành trình trình duyệt và 4 tình huống cập nhật PWA đạt. Đã thử yêu cầu khôi phục → lấy mã trong Auth Emulator → đổi mật khẩu → từ chối mật khẩu cũ → đăng nhập cùng UID; mã đã dùng không thể dùng lại. Kiểm thử trình duyệt còn giữ phiên khi refresh trả 503 rồi phục hồi khi thử lại. OpenAPI có 70 thao tác. Chỉ dùng thư giả lập trong kiểm thử local; chưa nghiệm thu giao thư vào hộp thư thật.

Đã triển khai cả FE/API cùng SHA `f936eaaceed74501033e477015aa747c8ef5f4e3`. Kiểm trên domain thật đạt release identity, CORS/quyền, route khôi phục, kiểm email/body trước khi gửi, sai mật khẩu và refresh token vẫn trả 401, bố cục 320px và mở lại trang khi offline; không có lỗi JavaScript. Kiểm cloud không gửi email khôi phục. [Bằng chứng phát hành](reports/2026-11-24-account-recovery-release.json).

## Hoàn thiện giao diện ngày 24/11/2026

Theo yêu cầu cập nhật tự động: bỏ thông báo và bước xác nhận phiên bản PWA. App kiểm bản mới mỗi phút và khi quay lại/có mạng, hỏi trạng thái các tab trước khi kích hoạt, chờ nội dung đang nhập, lệnh ghi và hộp thoại; sau đó tự tải lại đúng một lần. Bốn kiểm thử thay phiên bản service worker thật đã đạt, gồm cả bảo vệ form ở tab khác. Các tab còn ở cơ chế cũ cần xác nhận cập nhật một lần hoặc đóng hết tab rồi mở lại.

Đã triển khai frontend lên domain [ShareBill](https://sharebill-nghiep22.vercel.app/) tại SHA `a35e0bda14b9636ca0e5aac620c7cb8b9472f2fb`. Kiểm trên cloud đạt release identity, worker/giao thức cập nhật, API health/CORS, trình duyệt 390px, điều khiển mật khẩu, tải lại offline và không có lỗi JavaScript. API tiếp tục dùng bản đã triển khai `39ba5c8fee654663780b194db526d91c4f9cf1c0`. [Bằng chứng phát hành](reports/2026-11-24-responsive-auto-update-release.json).

Hoàn thiện bố cục responsive và điều hướng trên điện thoại: menu **Thêm** mở các mục phụ, tự đóng khi chuyển trang hoặc dùng nút Quay lại; màn hình lời mời giữ mục Thành viên đang chọn. Tiêu đề và thao tác chính bám đầu màn hình khi cuộn, nút lưu khoản chi bám cuối vùng nhìn. Danh sách thành viên và phần chia tiền đứng trước các mục tùy chọn; lịch trình dài ngày dùng thanh ngày cuộn ngang. Tên chuyến dài được thu gọn ở thanh đầu trang desktop, vẫn xem đầy đủ trong tổng quan. Trạng thái đồng bộ thường nằm cuối nội dung; cảnh báo ngoại tuyến vẫn ở đầu trang.

Kiểm chứng local: TypeScript và build FE/BE đạt; 157 kiểm thử unit/HTTP backend, 10 kiểm thử công cụ smoke và 19 hành trình Chromium trên bản static production đều đạt. Bộ giao diện kiểm các độ rộng 320, 390, 768, 960, 1280px, chiều cao 568px, tên chuyến 100 ký tự, menu bằng bàn phím và nút Quay lại. Đã kiểm trực quan desktop và điện thoại. Các hành trình tiền, QR/ảnh chuyển khoản, quản trị, PWA và ngoại tuyến dùng API/Firebase Emulator. Giao diện đã lên cloud; nghiệm thu thiết bị thật và các cổng vận hành bên dưới vẫn còn mở.

## Tiến độ triển khai ngày 18/11/2026

Ngày 20/11, đợt phục hồi: thêm [diễn tập O11/O12 local](RESTORE_REHEARSAL.md) và job CI `recovery`. Đã export/import thực tế 53 document, 5 tài khoản (email/mật khẩu, Google và disabled), 1 ảnh có generation/bytes đúng; 18 cổng về tiền/quyền/replay/repair đạt và checker 0 lỗi. Lượt local mất 37,608 giây, phần target/import/verify 18,604 giây. Đây chưa là RPO/RTO cloud; backup định kỳ, IAM/retention và phục hồi staging tiếp tục mở. Bản export riêng được loại khỏi Git/Vercel; artifact CI chỉ gồm báo cáo tổng hợp.

Ngày 20/11, đợt vận hành: bổ sung [B19 sửa projection](PROJECTION_REPAIR.md) trên Emulator. Dry-run và file snapshot/diff, kiểm nguồn v1/danh tính, khóa chuyến, kiểm version/updateTime, transaction sửa + job/audit, replay/no-op và checker sau apply. Admin thấy nhãn/kết quả tổng hợp; vẫn khóa được chuyến khi signal thiếu. Đã đạt 117 unit/HTTP, 9 Emulator repair, 9 Emulator quản trị và hành trình browser operator; TypeScript/build FE/BE đạt. Cloud apply, backup/restore toàn dự án và RPO/RTO tiếp tục là cổng mở.

Ngày 20/11: hoàn thiện sửa khoản chi trong nhóm tự chia đều sau khi người ứng rời nhóm. Đổi nội dung giữ phần chia và ledgerVersion; sửa tiền giữ đúng người ứng cũ, kể cả người đã inactive trước khi nâng cấp. Bổ sung giải thích gỡ/khôi phục, giữ phần chia lúc chốt, kiểm pending sau đổi thành viên và đồng bộ hợp đồng 68 endpoint. Bộ unit giới hạn 4 workers để tránh timeout khi khởi tạo quá nhiều tiến trình trên máy local. Kiểm chứng: 108 unit/HTTP, 73 ca Emulator (toàn bộ 71 ca hiện có và bộ chia nhóm 9/9 sau khi bổ sung 2 ca), 10 smoke CLI, 15 hành trình browser trên bản static có PWA/S18; kiểm riêng sửa nội dung khoản chia chính xác sau nâng cấp cũng đạt. TypeScript FE/BE, build FE/BE và diff-check đạt. Chưa triển khai đợt sửa này lên cloud.

Ngày 19/11: đơn giản hóa thành **vào nhóm là tự chia tổng chi cho các tài khoản active**, kể cả chi cũ. Giữ tiền ứng/chuyển, tự liên kết UID, chia phần lẻ một lần trên tổng và bỏ tên thêm tay chưa có tài khoản khỏi số người chia. Nhóm cũ đang mở được nâng cấp khi truy cập; nhóm đã chốt giữ lịch sử. [Quy tắc và kiểm chứng](GROUP_SHARING.md).

Ngày 19/11: đưa **Số tiền cần chuyển** lên trước chi tiết từng người. Trường hợp một người hoặc chưa liên kết có giải thích và nút dẫn đúng màn hình; phân biệt tài khoản truy cập với người chia tiền, nhắc chia lại khoản cũ khi thêm người. Có hành trình hai tài khoản từ 1.550.000đ chưa chia đến nợ 775.000đ/người và liên kết tài khoản.

Hoàn thiện màn hình tiền: phần phải chịu hiển thị rõ trong form/chi tiết và luôn thấy trong Số dư cùng đã ứng/chuyển/nhận. Dùng snapshot server đầy đủ cho kết luận công nợ/chốt; bỏ fallback cộng expense đang lọc. Ô chuyển tiền hiểu VND có dấu phân nhóm giống khoản chi. Có thêm 36 unit và 2 hành trình browser cho chia đều/lẻ, trả một phần/đảo, chia chính xác và dữ liệu thiếu. [Quy tắc và bằng chứng](MONEY_SCREENS.md).

Bổ sung S19: [worker đối soát từng lượt](LEDGER_RECONCILIATION.md) dùng lại checker, lease 120 giây, checkpoint theo chuyến, retry tối đa 3 lần và chu kỳ 15 phút. Summary có trong Hệ thống quản trị; dữ liệu tiền chỉ đọc. Có kiểm thử lease stale, crash/reclaim, phân trang và schema DTO. Lịch cloud, backup/restore, repair và cảnh báo vẫn còn mở.

Bổ sung: ô mật khẩu đăng nhập/đăng ký có nút hiện/ẩn bằng con mắt, kiểm cả thao tác bàn phím và giữ nội dung. Bắt đầu O13 của S19 với [log HTTP theo allowlist và mã request](OPERATIONS_LOGGING.md); đã có 5 kiểm thử cho dữ liệu riêng tư, lỗi server và request ID. Lịch workers, backup/restore, repair và cảnh báo còn mở.

Cập nhật 19/11: đã deploy FE/API staging cùng SHA `5256b3f`, CI frontend/backend đạt. Browser 390px trên domain thật đã kiểm đăng ký, đăng nhập lại, tạo chuyến, chi tiêu và chốt; smoke tiền/replay/cursor và 18 query index cloud đều đạt. Giữ Vercel Hobby, Firebase billing chưa bật. Bộ local có 53 unit/cấu hình, 54 Emulator, 10 smoke và 7 browser. Còn Google provider/operator, bucket ảnh, thiết bị vật lý và các cổng S19/S20. Xem [runbook, bằng chứng và cổng còn mở](STAGING_SMOKE.md).

Đã sửa K01–K09 trong mã nguồn. K01, K02, K04 và K05 có kiểm thử Chromium trong repo. K03 có kiểm thử transaction và cạnh tranh với tạo settlement. K06 được kiểm với owner nhận tiền do member tạo. K08 kiểm membership active mở lời mời hết lượt và tiếp tục chặn người ngoài.

| Module | Kết quả đã triển khai | Phần còn cần nghiệm thu |
| --- | --- | --- |
| M01 | URL có tripId và bộ lọc. Form khoản chi/cài đặt giữ snapshot cùng version, cho đối chiếu và chọn cách áp lại. Lịch trình, chuyển chủ và quyết toán giữ version lúc mở. Khóa thao tác và dấu vân tay request lưu theo API/UID trong sessionStorage, tra operation sau reload. | Kiểm trên các trình duyệt đích và khi thiết bị chặn storage. Retry tự động cùng key yêu cầu cùng nội dung và version. Khi đã đổi nội dung, dùng bảng khôi phục để kiểm tra giao dịch trước. |
| M02 | Tạo/sửa múi giờ, ngày mặc định theo chuyến, nhóm tùy chọn khi tạo chuyến. Trạng thái tạm khóa riêng. Khôi phục link sau đăng nhập, dọn dữ liệu khi phiên mất hiệu lực hoặc đổi tài khoản. | Smoke Auth trên staging và thiết bị thật. |
| M03 | Chặn đổi liên kết của participant có pending ở cả chiều gửi/nhận trong transaction. UI dẫn tới lịch sử để xử lý. Người đã tham gia mở được chuyến từ lời mời hết lượt. | Nghiệm thu lời mời trên thiết bị thật. |
| M04 | Form nhanh mặc định Khác, mục Thêm thông tin, kiểm ngày ngoài khoảng chuyến. Giữ bản nhập khi xung đột và chỉ gửi các trường metadata đã đổi. | Thử với ít nhất 5 người mới theo tiêu chí 60 giây. |
| M05 | Nhãn nhận tiền/xác nhận thay khớp API và lịch sử. Cho nhập cặp khác hợp lệ và trả một phần, tiếp tục hiện gợi ý khi có pending. Chỉ báo cân bằng khi snapshot đầy đủ. Hành trình chi → trả nợ → xác nhận → chốt có E2E hai tài khoản. | Smoke trên staging với cùng bản FE/API. |
| M06 | Luồng upload/finalize/attach/discard, retry, Rules và cleanup đã có kiểm thử. Lưu khoản chi vẫn dùng được sau lỗi upload. | Bucket thật, IAM ký, CORS, URL hết hạn và camera thiết bị thật. |
| M07 | Giữ ngày và bản nhập lịch trình, phát hiện version đổi và yêu cầu kiểm lại trước khi áp. Nhật ký có link đúng chuyến. | Nghiệm thu nhiều ngày và giới hạn 100 hoạt động/đề xuất trên điện thoại. |
| M08 | Báo lỗi của người gửi nhận trạng thái từ workflow quản trị. Nội dung ghi chú nội bộ giữ riêng. Có E2E người dùng → operator → người gửi. | Smoke staging. |
| M09 | Trang /admin, Google sign-in trong bộ nhớ, grant server-only, recent auth, dashboard, tra cứu, quản trị chuyến/tài khoản, ticket, ghi chú phân trang, audit, system và jobs. Worker Auth có lease theo UID, retry, kiểm desired state/version và sweep đối soát. CLI grant mặc định dry-run. | Cấu hình Google provider/domain, cấp operator thật, lịch chạy worker và smoke cloud. |
| M10 | Opt-in thiết bị tin cậy. IndexedDB tách API/UID/chuyến cho snapshot tối thiểu và nháp thêm khoản chi, hạn đọc 24 giờ. Xóa khi tắt, đăng xuất, tài khoản bị khóa hoặc chuyến mất quyền. Kiểm cache trước khi khôi phục; giới hạn chờ khi bộ nhớ bị kẹt. Ngoại tuyến chỉ soạn, người dùng kiểm lại và bấm lưu khi có mạng. PWA tự cập nhật khi các tab không có bản nhập, giao dịch đang lưu hoặc hộp thoại. | Safari iOS, Chrome Android, cài từ HTTPS, bàn phím và trình đọc màn hình trên thiết bị thật. Nháp sửa khoản chi và ảnh upload chưa được lưu ngoại tuyến. |
| M11 | 29 unit/HTTP, 54 Emulator và 6 Chromium E2E đã đạt trên local. CI có kiểm TypeScript, build, Emulator, browser và tải lại PWA khi offline. OpenAPI có 67 thao tác. | Kết quả thực thi GitHub Actions trên commit đẩy lên và smoke cloud. |
| M12 | Có runbook, cấu hình và các công cụ checker/migration/cleanup/worker để đưa lên môi trường đã chọn. | Deploy cùng commit, index cloud, lịch workers/backup, diễn tập restore/rollback và nghiệm thu phát hành. |

Đã chọn polling REST có kiểm quyền mỗi 30 giây khi tab đang hiện để theo dõi revision. Chuyển màn hình, quay lại foreground và có mạng trở lại đều kiểm dữ liệu lại. Khi revision đổi, app tải lại snapshot và query đang mở. Cách triển khai này giữ toàn bộ truy cập dữ liệu nghiệp vụ qua backend. Quy tắc Firestore client tiếp tục deny. Thời gian thấy thay đổi giữa hai thiết bị phụ thuộc vòng polling và kết nối.

Mặc định chỉ dấu vân tay request, key và thời điểm được lưu cho khôi phục lệnh trong tab. Bản nháp nội dung và snapshot cần opt-in riêng. Snapshot ngoại tuyến chỉ hỗ trợ tổng quan, số dư và soạn khoản chi mới, gắn với phiên còn hiệu lực trên tab. Giao diện quản trị dùng phiên Google trong bộ nhớ. Tải lại trang quản trị yêu cầu đăng nhập Google lại.

Bản build và kiểm thử ở trên dùng dữ liệu synthetic trên Firebase Emulator. Môi trường local hiện có cấu hình demo. Chưa có bằng chứng deploy của đợt sửa này, bucket staging ký thật, Google provider cloud, thiết bị vật lý hoặc diễn tập phục hồi. Các tiêu chí này còn mở và dự án tiếp tục ở trạng thái chuẩn bị phát hành.

Nguồn triển khai [E2E](../fe/test/workspace.test.mjs) · [Admin tests](../be/test/admin.emulator.test.ts) · [Worker](../be/src/services/admin-auth-jobs.ts) · [Dữ liệu thiết bị](../fe/src/private-device.ts) · [CI](../.github/workflows/backend-ci.yml) · [Hướng dẫn quản trị](../be/README.md#quản-trị).

## 1. Kết luận khảo sát ban đầu

**Luồng chính đã chạy được trên dữ liệu API local. Dự án chưa đạt chuẩn phát hành MVP/P0.** Hai tài khoản có thể tạo chuyến, mời và liên kết thành viên, ghi chi phí, xác nhận trả nợ, chốt hoặc mở lại chuyến. Lịch trình đã dùng dữ liệu chung của chuyến và báo lỗi đã lưu theo tài khoản gửi. Ba điểm chặn ra mắt là ghi đè sau xung đột, tạo trùng khi mất phản hồi rồi tải lại và thay đổi quyền xác nhận khoản trả nợ đang chờ. Xem các lỗi K01–K03 ở mục 3.

Frontend dùng Next.js/React và TypeScript, backend dùng Fastify, Firebase Auth và Firestore. Mã hiện tại có 46 thao tác trong OpenAPI. `/` và `/live` mở giao diện gọi API. `/demo/` dùng dữ liệu và ảnh mẫu lưu cục bộ. Nhiều thay đổi vẫn nằm trong working tree, vì vậy phạm vi báo cáo là mã đang có trên máy. Trạng thái deploy, cấu hình cloud và dữ liệu staging chưa được đối chiếu trong lần khảo sát. [Frontend](../fe/README.md) · [OpenAPI](../be/openapi.json) · [Triển khai](CICD_DEPLOY.md)

Các mẫu trong `GiaoDien` bao phủ tổng quan, chi tiêu, form khoản chi, số dư, thành viên, lời mời, cài đặt và lịch trình theo vai trò. Giao diện hiện có đủ điểm vào cho các nhóm màn hình này. Cần đánh giá nghiệm thu bằng hành vi trên API, đặc biệt ở phân quyền, dữ liệu đồng thời, lỗi mạng và thao tác trên điện thoại. [Mẫu và hệ thống thiết kế](../GiaoDien/GiaoDien) · [Mục tiêu nghiệp vụ P0](PRODUCT_PLAN.md#3-phân-kỳ-tính-năng)

**Cách đọc bảng.** “Đã chạy” nghĩa là có đường đi qua UI và API hoặc có kiểm chứng trên Emulator. “Còn thiếu” là phần còn thiếu trong hành trình hoặc trong bằng chứng nghiệm thu. **P0** chặn phát hành chính thức. **P1** là cải tiến sau khi các cổng P0 đạt hoặc theo quyết định sản phẩm.

## 2. Bản đồ màn hình và nghiệp vụ hiện có

| Nhóm màn hình | Đã có trong mã hiện tại | Đánh giá đối với MVP |
| --- | --- | --- |
| Đăng nhập, đăng ký, tài khoản | Email/mật khẩu, làm mới token, đăng xuất, đi tiếp từ lời mời | Đường đi chính đã chạy. Cần nghiệm thu phiên hết hạn, phiên bị khóa, đổi tài khoản và khôi phục điểm vào sau đăng nhập. |
| Danh sách chuyến, tạo chuyến, tổng quan, cài đặt | Chuyến mở/đã chốt, phân trang, tạo và chỉnh metadata, tổng chi và số dư cá nhân, chốt/mở lại | Đúng mô hình chuyến. Thiếu định danh chuyến trong URL màn hình con, xử lý trạng thái khóa rõ ràng và UI múi giờ của chuyến. |
| Thành viên, tài khoản truy cập, lời mời | Participant tách membership, thêm người chưa có tài khoản, liên kết, gỡ/khôi phục, chuyển chủ, link có hạn | Đúng mô hình quyền cơ bản. Đổi liên kết khi có khoản trả nợ đang chờ và vào lại qua link hết lượt cần xử lý. |
| Chi tiêu, thêm/sửa, chi tiết, hủy | Lọc/phân trang, một người trả, chia đều hoặc nhập riêng, preview, sửa metadata và phần tiền, lý do hủy | Sổ tiền có kiểm thử. UI còn sai lệch khi quay lại danh sách, khi tải lại sau xung đột và khi thử lại sau tải lại trang. Form nhanh chưa đạt bố cục P0. |
| Ảnh hóa đơn | Chọn/chụp, upload intent, gửi file, finalize, gắn/gỡ, mở bằng URL có hạn, cleanup CLI | Đã chạy với Storage adapter kiểm thử. Còn cổng bucket ký thật, CORS, IAM, hết hạn, upload lỗi và kiểm trên thiết bị thật. |
| Số dư, gợi ý, lịch sử chuyển tiền | Số dư từ server, chi tiết đã ứng/chịu/chuyển/nhận, tạo từ gợi ý, xác nhận/hủy/đảo | Đúng nền tảng ledger. Cần hoàn tất trả một phần cho cặp hợp lệ ngoài gợi ý và thống nhất cách hiện pending, xác nhận thay, lịch sử. |
| Lịch trình và hoạt động | Chủ chuyến quản lý hoạt động, thành viên đề xuất, chủ chuyến duyệt, thay đổi có version và lịch sử | Đã chạy với hai tài khoản. Cần chuẩn hóa xung đột, cập nhật đa thiết bị và kiểm mobile cho chuyến nhiều ngày. |
| Trợ giúp và báo lỗi | Gửi chung hoặc kèm chuyến, mã báo lỗi, trạng thái và phân trang riêng theo người gửi | Khâu người dùng đã chạy. Còn hàng đợi và thao tác xử lý cho quản trị viên. |
| PWA, ngoại tuyến | Manifest, icons, cache khung app, offline demo | Chưa có nháp giao dịch và snapshot opt-in cho app thật. Cần thử cài, cập nhật và đăng xuất trên thiết bị thật. |
| Quản trị | Có đặc tả, trường trạng thái kiểm soát, index chuẩn bị và dữ liệu báo lỗi | Chưa có route `/admin`, API `/api/admin/v1`, quyền operator và workflow vận hành. |

Nguồn đối chiếu [Điều hướng app thật](../fe/src/connected-workspace.tsx) · [Phạm vi API](../be/src/create-app.ts) · [Đặc tả từng màn hình](FRONTEND.md#5-đặc-tả-màn-hình) · [Quản trị](ADMIN_WEB.md).

## 3. Điểm lệch cần sửa

### Đã tái hiện trên local/Emulator

| Mã | Mức | Tái hiện và tác động | Đạt khi |
| --- | --- | --- | --- |
| K01 | P0 | Hai phiên mở khoản chi. Phiên B lưu tiêu đề mới. Phiên A gặp 409 và bấm **Tải lại**. API trả nội dung mới nhưng form vẫn hiện giá trị ban đầu. Lưu lần nữa ghi đè bản B bằng dữ liệu cũ. [Form và thao tác tải lại](../fe/src/connected-workspace.tsx#L185) · [Giá trị khởi tạo form](../fe/src/expense.tsx#L171) | Form tải bản mới từ response đã hoàn tất, mang đúng version của dữ liệu đang hiển thị. Bản nhập của A còn để đối chiếu. A phải xác nhận các trường muốn áp lại. |
| K02 | P0 | Cho server commit khoản chi rồi làm mất phản hồi. Tải lại trang và nhập lại cùng khoản. Hai request dùng hai key và sinh hai khoản chi. Retry trong cùng phiên đang mở có cơ chế giữ key, nhưng bảng key nằm trong bộ nhớ. [Client gửi lệnh](../fe/src/api-client.ts#L131) · [Tra operation](../be/src/read-routes.ts#L186) | Sau reload, app tìm được thao tác chưa rõ kết quả, kiểm tra operation hoặc gửi lại cùng key, body và version. Fixture chỉ có một khoản chi và một lần thay đổi ledger. |
| K03 | P0 | Có settlement pending tới participant đã liên kết. Chủ chuyến gỡ liên kết của tài khoản cũ rồi gắn tài khoản mới vào cùng participant. Tài khoản mới xác nhận được khoản tạo trước khi đổi liên kết. Điều này lệch quy tắc hủy và lập lại pending khi đổi quyền xác nhận. [Liên kết participant](../be/src/services/participant-link.ts) · [Kiểm quyền xác nhận](../be/src/finance-routes.ts#L111) · [Nghiệp vụ thành viên](PRODUCT_PLAN.md#42-những-ràng-buộc-về-thành-viên) | API báo rõ khi có pending liên quan tới liên kết cũ hoặc mới. Owner có lối hủy khoản rồi lập lại. Test cạnh tranh đổi link với tạo/xác nhận settlement giữ đúng quyền. |
| K04 | P0 | Lọc **Ăn uống**, mở một khoản rồi quay lại. Ô lọc hiện **Tất cả** trong khi API vẫn trả danh mục **Ăn uống**. [Bộ lọc UI](../fe/src/dashboard.tsx#L117) · [Bộ lọc request](../fe/src/connected-workspace.tsx#L135) | Nhãn bộ lọc, query và kết quả luôn khớp khi back, reload hoặc đổi chuyến. |
| K05 | P0 | Mở URL chi tiết khoản chi ở tab mới đã đăng nhập nhưng chưa chọn chuyến. App yêu cầu chọn chuyến vì URL chỉ có expenseId và tripId được lấy từ phiên của tab. [Chọn chuyến và dựng query](../fe/src/connected-workspace.tsx#L115) | Link xác định đúng chuyến và bản ghi, back giữ đúng ngữ cảnh, quyền truy cập tiếp tục do API xác thực. |

### Phát hiện qua đối chiếu mã và đặc tả

- **K06 · Xác nhận trả nợ và nhãn vai trò.** Backend ghi `owner_on_behalf` cho mọi lần owner xác nhận, trong khi UI có thể hiện **Tôi đã nhận tiền** khi owner là người nhận. Chốt ma trận owner tự nhận, owner xác nhận thay, member nhận và người tạo đề nghị. Dùng cùng ma trận cho nhãn nút, kiểm quyền, lý do và hiển thị audit. [Mã xác nhận](../be/src/finance-routes.ts#L128) · [Nhãn giao diện](../fe/src/dashboard.tsx#L293)
- **K07 · Trả một phần và gợi ý.** Form đang mở từ cặp gợi ý, dù API nhận mọi cặp đủ điều kiện. UI ẩn cả cặp nếu tìm thấy pending trong trang đang tải, kể cả khi pending chỉ là một phần. Đặc tả cho phép nhiều pending và kiểm dư nợ lúc xác nhận. Cần hiện số dư thật, tổng đang chờ và hành động riêng cho cặp khác hợp lệ. [Lọc gợi ý](../fe/src/connected-workspace.tsx#L175) · [Quy tắc settlement](PRODUCT_PLAN.md#55-trả-nợ-và-chốt-chuyến)
- **K08 · Lời mời tới người đã tham gia.** API accept có nhánh `already-member`, nhưng preview từ chối link hết lượt trước khi giao diện tới bước accept. Cần đường mở chuyến cho membership active, kể cả trường hợp mở lại link đã dùng hết lượt, và giữ phản hồi tối thiểu đối với người ngoài. [Preview và accept](../be/src/invite-routes.ts#L128)
- **K09 · Trải nghiệm nhập nhanh.** Ngày, danh mục, ghi chú và ảnh đang trải ngay trên form. Mặc định danh mục hiện là **Ăn uống**. Đặc tả đặt mặc định **Khác**, gộp phần tùy chọn dưới **Thêm thông tin**, dùng ngày theo múi giờ chuyến và hỏi lại nếu ngày chi nằm ngoài khoảng chuyến. [Form](../fe/src/expense.tsx#L209) · [Mặc định danh mục](../fe/src/ui.tsx#L37) · [Tiêu chí nhập nhanh](PRODUCT_PLAN.md#63-nguyên-tắc-dễ-dùng-bắt-buộc)
- **K10 · Trạng thái dữ liệu và quyền khi nhiều máy cùng mở chuyến.** UI có làm mới thủ công, API kiểm quyền trên request và backend ghi revision/signal. App chưa tự nhận thay đổi từ thiết bị khác. Cần thời điểm cập nhật hiển thị được, kiểm lại khi quay lại app và xóa view/cache của chuyến khi phát hiện mất quyền. [Query và làm mới](../fe/src/api-queries.ts) · [Rules hiện hành](../be/firestore.rules) · [Đặc tả S17](slices/06_VAN_HANH.md#s17)
- **K11 · Theo dõi tiến độ theo mã.** README và danh mục lát cắt vẫn nói S11–S14 “Chưa làm”, trong khi nhiều màn hình đã gọi API. S11–S14 nên ghi “đã nối API, còn các hạng mục nghiệm thu”. A10–A11 đã có. S15, phần quản trị S16 và S17–S20 còn cổng riêng. [Danh mục lát cắt](slices/README.md) · [A10–A11](slices/05_ADMIN_HO_TRO.md#a10)

## 4. Kế hoạch theo module

### M01 · Điều hướng, trạng thái lệnh và xung đột — P0

- Dùng một nguồn dữ liệu cho tripId, resourceId và bộ lọc theo link/màn hình. Định nghĩa back và đích sau đăng nhập, hỗ trợ URL hash hiện có qua lớp tương thích. Khi đổi chuyến, dọn dữ liệu và trạng thái thao tác của chuyến trước.
- Ghép form với snapshot/version đã tải. Khi 409, giữ bản nhập, tải bản server riêng và cho người dùng so sánh trước khi áp lại. Ưu tiên khoản chi và cài đặt chuyến, sau đó áp cho thành viên, lịch trình và quyết toán.
- Lưu định danh thao tác chưa rõ kết quả theo UID và chuyến. Dùng tra operation và retry cùng ý định. Phân biệt **Đang gửi**, **Chưa gửi**, **Chưa xác định kết quả**, **Đã lưu**. Đặt vòng đời xóa và dữ liệu tối thiểu theo chính sách thiết bị của M10.
- **Nghiệm thu:** K01, K02, K04, K05 thành test tự động. Bấm Lưu liên tục, mất phản hồi, reload, back/forward và đổi chuyến cho kết quả trên server đúng ý định. [Client API](../fe/src/api-client.ts) · [Workspace](../fe/src/connected-workspace.tsx)

### M02 · Tài khoản, chuyến và tổng quan — P0

- Hoàn thiện trạng thái phiên hết hạn, user bị khóa và đăng nhập lại. Chọn đích tiếp tục trong các route nội bộ hợp lệ. Xóa dữ liệu hiển thị của tài khoản cũ khi đăng xuất hoặc đổi UID.
- Hoàn thiện UI tạo/sửa theo thứ tự tên chuyến và tên người tạo trước, tùy chọn địa điểm/ngày/ghi chú sau. Lấy múi giờ của chuyến cho ngày mặc định trong khoản chi, quyết toán và lịch trình. VND là đơn vị của MVP.
- Phân biệt **Đang mở**, **Đã chốt**, **Tạm khóa**. Tổng quan dùng tổng chi và số dư từ server, có đường vào rõ cho thành viên chưa liên kết và chuyến chưa có chi tiêu. Xử lý trang danh sách lọc rỗng nhưng còn cursor.
- **Nghiệm thu:** Người mới tạo chuyến tối thiểu, thêm người, xem số dư cá nhân, mở lại link từ tab mới. Xác minh các trạng thái có dữ liệu, rỗng, đang tải, hết phiên, mất quyền và lỗi mạng. [Màn hình tài khoản và chuyến](../fe/src/screens.tsx) · [Mô hình chuyến](../be/src/database/trip.ts)

### M03 · Thành viên, danh tính và lời mời — P0

- Giữ hai danh sách **Người chia tiền** và **Tài khoản truy cập**. Nêu đúng tác động của ngừng dùng participant, gỡ quyền truy cập, đổi liên kết, khôi phục và chuyển chủ. Giữ phần tiền và lịch sử của người đã tham gia.
- Sửa K03 trong transaction. API kiểm pending liên quan cùng lúc với version và liên kết. UI đưa tới đúng khoản pending cần giải quyết.
- Sửa K08 và hoàn thiện link hợp lệ/hết hạn/thu hồi/hết lượt, hai người tranh lượt cuối và yêu cầu tạo link bị mất phản hồi. Raw token hiện một lần, link nằm trong fragment và được bỏ khỏi URL sau luồng tham gia.
- **Nghiệm thu:** Chủ chuyến thêm người chưa có tài khoản và ghi chi phí ngay. Người mới chỉ được ghi nhận dưới danh tính đã gắn. Người đã bị gỡ bị chặn đọc/ghi dù cầm URL cũ, cùng một tài khoản tham gia lại hợp lệ chỉ có một membership. [API thành viên](../be/src/membership-routes.ts) · [API lời mời](../be/src/invite-routes.ts)

### M04 · Chi tiêu và form nhanh — P0

- Sửa K01/K02/K04 và K09. Mở form mặc định với tên, số tiền, người trả, người chia và chia đều. Đặt cách chia riêng, ngày, danh mục, ghi chú, ảnh ở chỗ dễ mở. Giải thích chênh lệch chia ngay cạnh tổng và cho phép share 0 theo đặc tả.
- Cho xem chi tiết người trả, phần chia, liệu khoản chi đã hủy và hành động đúng quyền. Khi sửa tiền hoặc hủy sau khi đã quyết toán, nêu tác động đến số dư và gợi ý. Metadata thuần giữ nguyên cách chia cũ, kể cả người đã inactive.
- Giữ đồng nhất làm tròn theo ID và VND nguyên giữa preview và server. Cho người dùng kiểm ngày ngoài phạm vi, thông tin share và người trả. Xác nhận số tiền khi gửi lại sau offline.
- **Nghiệm thu:** ≥4/5 người chưa dùng app thêm khoản chia đều trong 60 giây lần đầu, không cần giải thích trực tiếp. So lại 100.000đ chia 3, 1đ chia 3, chia chính xác có phần 0, payer ngoài danh sách chia, sửa/hủy có và không có settlement. [Nghiệp vụ và fixture](ROADMAP_TESTING.md#5-dữ-liệu-mẫu-chuẩn-để-febe-đối-chiếu) · [Backend khoản chi](../be/src/ledger-routes.ts)

### M05 · Số dư, quyết toán, lịch sử và chốt chuyến — P0

- Xử lý K06/K07. Hiển thị tổng đã ứng, phần chịu, đã chuyển, đã nhận và số dư. Phân biệt gợi ý, pending và giao dịch xác nhận. Cho chọn cặp hợp lệ ngoài gợi ý, nhập khoản trả một phần và xem giới hạn theo số dư mới nhất. Chỉ hiển thị **Đã cân bằng** khi snapshot số dư đầy đủ.
- Thống nhất xác nhận nhận tiền, xác nhận thay, hủy pending và đảo confirmed. Khi ledger đổi, yêu cầu kiểm lại cặp/số tiền. Trong chi tiết và lịch sử, hiện ngày, tác nhân, trạng thái và xác nhận thay khi có.
- Chốt chỉ khi tất cả net = 0 và hết pending. Hiển thị khoản đang cản chốt và đường xử lý. Sau chốt, giao diện chuyển chỉ xem, hỗ trợ thao tác thu hồi quyền và mở lại đúng vai trò.
- **Nghiệm thu:** Fixture 1.170.000đ cho net An +480.000đ, Bình −240.000đ, Chi −240.000đ. Pending giữ các net đó, xác nhận 120.000đ từ Chi cho An đưa An về +360.000đ và Chi về −120.000đ. Kiểm xác nhận cạnh tranh, hủy/đảo, audit và chốt đúng điều kiện. [Quy tắc tiền](PRODUCT_PLAN.md#5-quy-tắc-nghiệp-vụ-tiền) · [Backend quyết toán](../be/src/finance-routes.ts)

### M06 · Ảnh hóa đơn — P0

- Hoàn thiện tình trạng chọn ảnh, tải, kiểm ảnh, sẵn sàng, đính kèm và lỗi. Giữ form và cho phép lưu khoản chi khi tải ảnh gặp lỗi. Retry finalize giữ key và version ban đầu. URL xem chỉ nằm trong bộ nhớ khi mở ảnh.
- Chốt kho lưu trữ phù hợp ngân sách staging đã ghi trong dự án. Kiểm bucket riêng tư, quyền ký, origin CORS và tình huống thiếu quyền. Có hướng dẫn bật môi trường rõ ràng và kiểm ảnh trên camera/trình duyệt thật.
- **Nghiệm thu:** Kiểm 0–3 ảnh, sai loại, quá dung lượng, ảnh hỏng, mất mạng giữa upload và finalize, đính kèm đúng một khoản, gỡ ảnh, hết hạn URL, người ngoài hoặc bị gỡ quyền, cleanup giữ ảnh đang gắn. Thực hiện smoke với bucket staging đã chọn. [Hợp đồng và cổng bucket](RECEIPTS.md) · [Tích hợp frontend](../fe/src/api-data.ts#L174)

### M07 · Lịch trình và nhật ký chuyến — P0 cho luồng đang có, P1 cho mở rộng

- Áp cách xử lý xung đột của M01 cho lịch trình, giữ ngày đang xem và sửa logic tải lại. Kiểm UI khi chuyến nhiều ngày, trạng thái đã chốt/bị khóa và khi tới giới hạn 100 hoạt động/100 đề xuất của snapshot hiện tại.
- Giữ workflow đề xuất → lên lịch/từ chối. Xóa hoạt động đã lên từ đề xuất đưa đề xuất về chờ duyệt. Hiện tác nhân, thời gian, thay đổi tiền trước/sau và link trở về đúng chuyến trong nhật ký.
- **Nghiệm thu:** Hai thiết bị thấy cùng lịch sau cập nhật, quyền chủ chuyến/thành viên đúng, thao tác đồng thời có kết quả rõ, đối soát tiền sau sửa lịch vẫn đạt. Lịch nhắc sự kiện và chức năng mở rộng xếp P1. [API lịch trình](../be/src/itinerary-routes.ts) · [Giao diện lịch trình](../fe/src/trip.tsx)

### M08 · Báo lỗi người dùng — P0

- Giữ mã và trạng thái theo tài khoản đã gửi. Hoàn tất mục xác nhận ngữ cảnh chuyến và khôi phục thao tác khi mất mạng theo M01. Chuẩn hóa phản hồi hết 5 lượt trong ngày theo giờ Việt Nam.
- Kết nối hiển thị trạng thái với hàng đợi M09. Khi operator đổi trạng thái, người gửi xem được kết quả trong lịch sử của mình. Trả DTO người dùng theo allowlist, nội dung nội bộ chỉ dùng trong khu vực quản trị.
- **Nghiệm thu:** Ticket kèm chuyến kiểm membership khi gửi, retry trả cùng mã, cursor thuộc đúng UID, tài khoản khác không đọc được chi tiết, trạng thái đi được từ **Mới gửi** đến **Đã xử lý** qua UI quản trị. [API báo lỗi](../be/src/support-routes.ts) · [Giao diện hỗ trợ](../fe/src/api-support.tsx)

### M09 · Website và API quản trị — P0

- Làm guard trước UI. Dùng danh tính và vai trò platform riêng, theo hợp đồng đăng nhập quản trị, allowlist, recent auth và audit đã đặc tả. Giới hạn dữ liệu quản trị theo quyền và mục đích.
- Thứ tự triển khai: phiên/guard → tra người dùng và chuyến → hàng đợi ticket, ghi chú nội bộ và đổi trạng thái → khóa/mở user hoặc chuyến → audit, dashboard và tình trạng jobs.
- Với khóa/mở tài khoản, dùng job đồng bộ Auth có version/lease và retry theo trạng thái mới nhất. Màn hình hiển thị **Đang đồng bộ**, **Thành công** hoặc **Lỗi** theo kết quả job. Với khóa chuyến, dùng trạng thái kiểm soát riêng với chốt chuyến.
- **Nghiệm thu:** Tài khoản thường bị chặn ở API và UI. Operator xử lý ticket từ danh sách tới chi tiết, đổi trạng thái, ghi chú và thấy audit. Kiểm khóa/mở cạnh tranh, thu hồi quyền admin, metadata ít nhất cần thiết và kiểm thử lỗi truy cập ledger/ảnh riêng tư từ admin. [Đặc tả quản trị](ADMIN_WEB.md) · [S15–S16](slices/05_ADMIN_HO_TRO.md)

### M10 · Đồng bộ, bản nháp và PWA — P0

- Làm mới có kiểm soát khi app trở lại foreground và khi phiên hoặc quyền đổi. Chốt cách nhận revision theo S17. Nếu dùng Firebase listener, chỉ cấp đọc signal và own membership theo quyền đã xác minh.
- Lưu nháp và snapshot theo UID, thiết bị tin cậy opt-in, có thời điểm đồng bộ và hành động xóa. Khi có mạng, tải lại quyền, người chia, phiên bản và cho người dùng xác nhận gửi.
- Kiểm nâng phiên bản PWA khi đang soạn, cài từ HTTPS, Safari iOS, Chrome Android, màn hình hẹp, bàn phím, focus, đọc màn hình và trạng thái chạm. Service worker dùng danh sách tài nguyên công khai được phép cache.
- **Nghiệm thu:** Thoát app, mất mạng hoặc update vẫn có bản nháp đủ điều kiện. Dữ liệu tài khoản khác, token, API riêng và URL ký ngắn hạn không đi vào cache dùng chung. Thu hồi quyền kích hoạt dọn dữ liệu của chuyến ở app. [Service worker](../fe/scripts/prepare-pwa.mjs) · [S17](slices/06_VAN_HANH.md#s17)

### M11 · Toàn vẹn dữ liệu, kiểm thử và CI — P0

- Đưa browser tests vào repo và CI, dùng Emulator và fixture độc lập. Giữ bộ unit, API, Rules, migration và kiểm thử cạnh tranh đang có. Bổ sung fixture K01–K05, quyền theo vai trò, một hành trình chi → trả nợ → chốt và một hành trình báo lỗi → xử lý quản trị.
- Dùng lại checker và migration dry-run để kiểm dữ liệu legacy, tổng tiền, balances và audit. Ghi checkpoint, kết quả đối soát và phương án tương thích khi nâng schema. Kiểm cả thao tác không rõ kết quả sau retry.
- **Nghiệm thu:** PR có kiểm TypeScript, build, API/Emulator và browser E2E có thể chạy lại từ checkout sạch. Khóa phát hành khi có lỗi tiền, quyền, giao dịch trùng hoặc dữ liệu sau phục hồi lệch. [Workflow hiện tại](../.github/workflows/backend-ci.yml) · [Checker](../be/scripts/check-database.ts) · [Ma trận kiểm thử](ROADMAP_TESTING.md#7-test-matrix-bắt-buộc)

### M12 · Staging, vận hành và phát hành — P0

- Chốt bản build FE/API cùng commit, origin API theo môi trường, indexes, Rules, thông tin phiên bản và smoke Auth/ảnh/admin/API trên staging. Xác định index đã sẵn sàng bằng query thật.
- Thiết lập lịch cleanup, backup, checker/đối soát, giám sát và đầu mối xử lý. Diễn tập restore cô lập cho dữ liệu Firestore, Auth và ảnh. Đo khả năng phục hồi và đối chiếu ledger, quyền và idempotency sau restore.
- **Nghiệm thu:** Có bằng chứng smoke với đúng bản staging, một lần diễn tập restore và rollback, log an toàn không chứa token, link ký hoặc nội dung ticket và ghi nhận các điều kiện phát hành. [CI/CD](CICD_DEPLOY.md) · [S18–S20](slices/06_VAN_HANH.md#s18)

## 5. Thứ tự triển khai đề xuất

| Đợt | Công việc | Cổng bàn giao |
| --- | --- | --- |
| 1. An toàn tiền và quyền | M01, K03 của M03, các nhánh xác nhận ở M05. Đưa test tái hiện vào M11 ngay trong từng PR. | K01–K03 hết tái hiện trên FE/API/DB. Test khóa dữ liệu cũ, thao tác trùng và đổi quyền xác nhận chuyển xanh. |
| 2. Hoàn chỉnh app người dùng | M02–M05, M07, M08. Chuẩn bị M06 và chốt thiết kế M10. | Hai tài khoản chạy một chuyến từ tạo đến chốt, nhập chi theo tiêu chí dễ dùng, báo lỗi có mã và đúng quyền đọc. |
| 3. Quản trị và thiết bị thật | M09, M10, M11. Smoke ký ảnh staging của M06 có thể chuẩn bị song song khi đã có kho lưu trữ được chọn. | Operator xử lý được ticket từ app, PWA đạt kịch bản offline/reconnect, browser E2E có trong CI. |
| 4. Diễn tập và phát hành | M12 với bản FE/API cùng commit, data synthetic ở staging. | Đạt smoke trên staging, kiểm thiết bị thật, đối soát và restore/rollback. Phạm vi production được chốt sau các kiểm chứng này. |

Ba PR đầu nên xử lý lần lượt K01, K02 và K03, với test tái hiện kèm từng bản sửa. Mỗi PR ghi tình huống sửa, tiêu chí nghiệm thu, kết quả test và phiên bản staging nếu có. Đồng bộ trạng thái thực tế trong README, OpenAPI và các lát cắt khi đóng hạng mục. Chia theo phần trăm/trọng số, CSV, OCR, đa tiền tệ và native/push đã có trong phạm vi P1/P2. Thanh toán thật cần quyết định phạm vi riêng. [Phân kỳ sản phẩm](PRODUCT_PLAN.md#3-phân-kỳ-tính-năng)

## 6. Bằng chứng kiểm tra của lần khảo sát

- Kiểm TypeScript và build frontend/backend đều đạt. Chạy lại được 29 bài unit/HTTP và 45 bài Firebase Emulator. Test Swagger xác nhận 46 thao tác đăng ký theo OpenAPI.
- Hai hành trình trình duyệt với dữ liệu thử trên Emulator đã qua: chuyến/chi tiêu/quyết toán và lịch trình/báo lỗi. Dùng hai tài khoản riêng để kiểm lời mời, quyền và việc từ chối mở ticket của người khác.
- Dùng dữ liệu kiểm thử local để tái hiện K01–K05. Các script trình duyệt chỉ phục vụ khảo sát, CI hiện tại chưa có bộ test browser trong repo.
- Bằng chứng ảnh hóa đơn hiện dựa trên adapter kiểm thử và Storage Rules Emulator. Cổng IAM/CORS/ký URL trên bucket thật, thiết bị vật lý và staging theo commit cần kiểm trong M06/M12. [Workflow hiện có](../.github/workflows/backend-ci.yml) · [Phạm vi kiểm thử hóa đơn](RECEIPTS.md#kiểm-chứng-và-cổng-cloud)
