# B19 — Sửa số dư và bộ đếm từ sổ tiền

Ngày 20/11/2026. Công cụ `db:repair` đã kiểm trên Emulator; chưa cho phép ghi vào cloud. Không có endpoint sửa số dư từ trình duyệt và worker đối soát không tự gọi công cụ này.

## Phạm vi

Nguồn tính là các khoản chi và khoản chuyển tiền v1, người tham gia, membership và liên kết đã kiểm schema/danh tính. Dùng lại `reconcileLedger`, gồm cách chia từng khoản và chia tổng chi của nhóm. Chuyến đã chốt giữ `equalParticipantIds` lúc chốt dù đã gỡ quyền truy cập.

Công cụ sửa các trường tiền trong `balances`, tổng chi, tổng theo danh mục, số đếm khoản chi/chuyển/người/tài khoản, cờ `hasLedgerReferences` còn thiếu và `signals/current`. Khi có thay đổi, tăng version/revision/ledgerVersion để client và yêu cầu quyết toán cũ phải tải lại. Khoản chi, khoản chuyển, danh tính, quyền, hóa đơn, audit chuyến và operation gốc được giữ nguyên. Chuyến tiếp tục tạm khóa sau khi sửa.

Mỗi lượt chỉ nhận một chuyến, tối đa 50 người/tài khoản/liên kết/số dư, 2.000 khoản chi và 2.000 khoản chuyển; file kế hoạch tối đa 2 MiB. Nguồn legacy/không hợp lệ, liên kết mâu thuẫn, người tham gia bị thiếu hoặc balance không có participant sẽ bị chặn; cần điều tra/migration riêng. Công cụ không suy đoán hay sửa nguồn tiền để khớp một số dư đã sai.

## Xem trước và lưu bản sao

Chạy từ thư mục gốc repo với cấu hình local của `be/.env`. `FIREBASE_PROJECT_ID` phải khớp `--project`; host Firestore phải là loopback và project bắt đầu bằng `demo-`. Client thực tế được ghim vào host này. Có thể chọn named database bằng `--database`; mặc định là `(default)`.

Trước khi xuất bản để áp dụng, operator tạm khóa chuyến ở `/admin` → Chuyến đi. Khóa vẫn thực hiện được khi signal đang thiếu; thao tác này không đổi sổ tiền. Nếu xuất khi chuyến chưa khóa, vẫn xem được diff nhưng không áp dụng được. Khóa sau khi xuất làm kế hoạch cũ hết hiệu lực, cần xuất lại.

```powershell
New-Item -ItemType Directory -Force be/.maintenance
pnpm --dir be db:repair --project demo-sharebill --trip <trip-uuid>
pnpm --dir be db:repair --project demo-sharebill --trip <trip-uuid> --plan-out .maintenance/repair-plan.json
```

Mặc định chỉ đọc: không tạo job hoặc sửa document. JSON stdout có scope, revision/ledgerVersion, trạng thái khóa và diff trước/sau. `--plan-out` lưu thêm snapshot nguồn và projection trước sửa, updateTime chính xác và SHA-256; từ chối ghi đè file đã có. Timestamp trong snapshot dùng `{"$timestamp":[seconds,nanoseconds]}`.

File chứa tên, ghi chú, danh tính và giá trị tiền của chuyến; giữ tại nơi riêng của người vận hành. `.maintenance/` đã được gitignore. Đây là bản sao đúng scope đã đọc để kiểm tra và truy vết sửa projection, không phải backup toàn bộ chuyến, Firebase Auth, ảnh hoặc cấu hình. Công cụ chưa có lệnh restore; không import snapshot đè lên dữ liệu đang có writer.

## Áp dụng và kiểm lại

Xem diff và lưu file trước. `--actor` phải là UID có hồ sơ active và grant `platformAdmins` active. CLI dùng quyền máy chủ local; UID này là danh tính truy vết, không thay cho xác thực Google trên website quản trị. Lý do bắt buộc, tối đa 300 ký tự.

```powershell
pnpm --dir be db:repair --project demo-sharebill --trip <trip-uuid> --apply --plan .maintenance/repair-plan.json --actor <operator-uid> --reason 'Sửa projection synthetic sau đối soát'
```

Apply kiểm digest, project, database, host, tripId và quyền operator. Trong một transaction, đọc lại root, ledger, danh tính và projection; so toàn bộ dữ liệu/updateTime cùng revision/ledgerVersion và diff đã duyệt. Thay đổi trực tiếp một khoản chi không tăng revision cũng làm kế hoạch cũ bị từ chối. Các query và root nằm trong transaction cùng lần sửa, nên writer hoặc bản repair cạnh tranh không thể áp diff cũ khi transaction chạy lại.

Chỉ sau khi mọi kiểm tra đạt mới ghi projection, signal, `maintenanceJobs/projection-repair-<planId>` và `adminAuditEvents/<planId>` cùng transaction. Job lưu actor/lý do, hash bản sao và số document đã sửa; không lưu nguồn tiền hay diff. Gửi lại cùng file/actor/lý do trả kết quả cũ, không tăng phiên bản lần nữa. Đổi actor/lý do trên plan đã áp bị chặn. Kế hoạch mới không có sai lệch không tạo job và không ghi dữ liệu.

CLI chạy checker sau apply và trả summary. Exit `0`: apply/replay/no-op xong và checker đạt; `1`: đã áp nhưng checker còn lỗi hoặc chưa kiểm được chuyến; `2`: tham số, scope, nguồn, file, quyền, kế hoạch cũ hoặc kết nối không đạt. Không mở lại chuyến chỉ dựa vào trạng thái job `succeeded`: trạng thái này xác nhận transaction sửa đã commit, còn nghiệm thu dựa vào checker và đối chiếu dữ liệu. Sau khi kiểm xong, operator chủ động mở khóa qua quản trị.

Trong `/admin` → Hệ thống, tác vụ có nhãn **Sửa số dư từ sổ tiền** và số bản ghi đã sửa. DTO chỉ trả bộ đếm được kiểm schema; không trả bản sao, digest, lý do hoặc diff. Nhật ký quản trị ghi người thực hiện và lý do.

| Mã | Xử lý |
| --- | --- |
| `REPAIR_PLAN_STALE` | Giữ chuyến tạm khóa, kiểm writer/thay đổi mới, xuất diff mới và xem lại. |
| `REPAIR_MAINTENANCE_REQUIRED` | Khóa chuyến trước, rồi xuất kế hoạch mới. |
| `REPAIR_INVALID_SOURCE`, `REPAIR_INVALID_IDENTITY`, `REPAIR_INVALID_GROUP` | Điều tra nguồn/danh tính; không sửa amount/shares để làm hết sai lệch. |
| `REPAIR_ORPHAN_BALANCE`, `REPAIR_MISSING_PARTICIPANT` | Giữ bằng chứng và xử lý danh tính riêng; công cụ không xóa balance mồ côi. |
| `REPAIR_INVALID_PLAN`, `REPAIR_SCOPE_MISMATCH` | Kiểm đúng file, project/database/host; không sửa tay file để ép áp dụng. |
| `REPAIR_ADMIN_REQUIRED` | Kiểm hồ sơ và grant của operator. |
| `REPAIR_EMULATOR_REQUIRED` | Công cụ hiện chỉ hỗ trợ project demo trên loopback. |

## Bằng chứng và cổng còn mở

9 kiểm thử unit/scope/CLI, 9 Emulator cho repair và bộ quản trị 9/9 đã đạt. Có kiểm xem trước không ghi, hai cách chia, confirmed/pending, balance/signal thiếu, trường projection thừa, chuyến chốt, replay/no-op, kế hoạch cũ, ghi trực tiếp không tăng version, repair/writer cạnh tranh, quyền thu hồi, file sai scope và round-trip CLI có checker sạch. Browser operator kiểm nhãn/kết quả và không lộ dữ liệu riêng; TypeScript/build FE/BE đạt.

Chưa bật cloud apply hoặc nghiệm thu backup/RPO/RTO cloud. Đã có [diễn tập native export/import ba dịch vụ trên synthetic local](RESTORE_REHEARSAL.md), gồm kiểm bản phục hồi nguyên trạng trước khi thử repair. Phần cloud cần backup đã xác minh và diễn tập ở môi trường cách ly theo S19 trước khi mở phạm vi.
