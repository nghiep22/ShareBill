'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AdminClient } from './admin-client';
import { ApiError } from './api-client';
import { useHash } from './workspace-shell';
import { Dialog, PageTitle } from './ui';

type Page<T> = { items: T[]; nextCursor: string | null };
type User = { id: string; name: string | null; email: string | null; status: string; moderationVersion: number; authSyncStatus: string; disabledReason?: string };
type Trip = { id: string; name: string; ownerUid: string; status: string; moderationStatus: string; moderationVersion: number;
  participantCount: number; expenseCount: number; settlementCount: number; moderationReason?: string };
type Ticket = { id: string; createdBy: string; tripId: string | null; category: string; status: string; version: number;
  message?: string; author?: string; trip?: string; notes?: Note[]; notesCursor?: string; updatedAt: string };
type Note = { id: string; note: string; actorUid: string; createdAt: string };
type Audit = { id: string; action: string; actorUid: string; targetType: string; targetId: string; reason: string; createdAt: string };
type Dashboard = { users: number; trips: number; support: number; failures: number; updatedAt: string; tickets: Ticket[]; activity: Audit[] };
type Job = { id: string; uid?: string; status: string; moderationVersion?: number; attempts: number; lastErrorCode: string | null; updatedAt: string;
  kind?: 'ledger_reconcile' | 'projection_repair'; repairSummary?: { changedDocuments: number } | null;
  resultSummary?: { tripsScanned: number; tripsChecked: number; tripsWithIssues: number; issueCount: number; scanErrors: number } | null };
type System = { environment: string; release: string | null; jobs: Job[]; maintenance: Job[] };
const names: Record<string, string> = {
  open: 'Mới gửi', in_progress: 'Đang xử lý', resolved: 'Đã xử lý', active: 'Đang hoạt động', disabled: 'Đã khóa',
  archived: 'Đã chốt', normal: 'Bình thường', suspended: 'Tạm khóa', synced: 'Đã đồng bộ', pending: 'Đang đồng bộ',
  queued: 'Đang chờ', running: 'Đang chạy', succeeded: 'Thành công', failed: 'Lỗi', superseded: 'Đã có lệnh mới hơn',
  usability: 'Thao tác', balance: 'Số dư', receipt: 'Ảnh hóa đơn', account: 'Tài khoản', other: 'Khác',
  user: 'Người dùng', trip: 'Chuyến đi', support: 'Báo lỗi',
  'ticket.status_updated': 'Đổi trạng thái báo lỗi', 'ticket.note_added': 'Thêm ghi chú',
  'user.enable': 'Yêu cầu mở tài khoản', 'user.disable': 'Khóa tài khoản',
  'trip.projections_repaired': 'Sửa số dư từ sổ tiền',
  'trip.suspend': 'Tạm khóa chuyến', 'trip.resume': 'Mở quyền ghi chuyến',
  'admin.granted': 'Cấp quyền quản trị', 'admin.revoked': 'Thu hồi quyền quản trị',
};
const label = (value: string) => names[value] ?? value;
const time = (value: string) => new Date(value).toLocaleString('vi-VN');

function useRead<T>(api: AdminClient, path: string, epoch: number) {
  const [result, setResult] = useState<{ path: string; epoch: number; data?: T; error?: string; denied?: boolean }>();
  useEffect(() => {
    let active = true;
    api.read<T>(path).then(data => {
      if (active) setResult({ path, epoch, data });
    }, cause => {
      if (active) setResult({ path, epoch, error: cause instanceof Error ? cause.message : 'Chưa tải được dữ liệu.',
        denied: cause instanceof ApiError && [401, 403].includes(cause.status) });
    });
    return () => { active = false; };
  }, [api, path, epoch]);
  const current = result?.path === path && result.epoch === epoch ? result : undefined;
  return { data: current?.data, error: current?.error, denied: current?.denied, loading: !current };
}

export function AdminWorkspace() {
  const hash = useHash();
  const [api] = useState(() => new AdminClient());
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const path = hash.split('?')[0].split('/')[0];
  const current = ['users', 'trips', 'support', 'activity', 'system'].includes(path) ? path : 'dashboard';
  async function login() {
    setError('');
    setBusy(true);
    try { await api.login(); setAuthenticated(true); setEpoch(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa đăng nhập được.'); }
    finally { setBusy(false); }
  }
  return <div className="admin-workspace">
    <header className="app-header"><a className="brand" href="/admin/">ShareBill · Quản trị</a>
      {authenticated && <button className="secondary-button compact" disabled={busy} onClick={async () => {
        await api.logout(); setAuthenticated(false); setError('');
      }}>Đăng xuất</button>}
    </header>
    {authenticated && <nav className="admin-nav" aria-label="Quản trị">
      {[['dashboard', 'Tổng quan'], ['users', 'Người dùng'], ['trips', 'Chuyến đi'], ['support', 'Báo lỗi'], ['activity', 'Nhật ký'], ['system', 'Hệ thống']].map(([route, title]) =>
        <a key={route} href={'#' + route} aria-current={current === route ? 'page' : undefined}>{title}</a>)}
    </nav>}
    <main className="admin-main">
      {error && <p className="inline-note error" role="alert">{error}</p>}
      {!authenticated ? <section className="card field-card admin-login">
        <h1>Đăng nhập quản trị</h1>
        <p>Dùng tài khoản Google đã được cấp quyền quản trị ShareBill.</p>
        <button className="primary-button" disabled={busy} onClick={() => void login()}>{busy ? 'Đang xác thực…' : 'Đăng nhập với Google'}</button>
        <a className="text-button" href="/">Về ứng dụng</a>
      </section> : <AdminContent key={hash + ':' + epoch} api={api} hash={hash || 'dashboard'} epoch={epoch}
        refresh={() => setEpoch(value => value + 1)} onDenied={() => setAuthenticated(false)} reauthenticate={() => api.login()} />}
    </main>
  </div>;
}

function AdminContent({ api, hash, epoch, refresh, onDenied, reauthenticate }: {
  api: AdminClient; hash: string; epoch: number; refresh: () => void; onDenied: () => void; reauthenticate: () => Promise<void>;
}) {
  const [section, id, child] = hash.split('?')[0].split('/');
  const query = new URLSearchParams(hash.split('?')[1]);
  const endpoint = !['users', 'trips', 'support', 'activity', 'system'].includes(section) ? '/dashboard' : '/' + section + (id ? '/' + encodeURIComponent(id) : '') +
    (child === 'trips' && section === 'users' ? '/trips' : '') + (query.size ? '?' + query.toString() : '');
  const result = useRead<Dashboard | User | Trip | Ticket | System | Page<User | Trip | Ticket | Audit>>(api, endpoint, epoch);
  useEffect(() => { if (result.denied) onDenied(); }, [result.denied, onDenied]);
  if (result.error) return <section className="card field-card"><p className="error" role="alert">{result.error}</p>
    <button className="secondary-button" onClick={refresh}>Tải lại</button></section>;
  if (!result.data) return <p role="status">Đang tải dữ liệu quản trị…</p>;
  const data = result.data;
  return <>
    <div className="section-heading"><h1>{({ dashboard: 'Tổng quan', users: 'Người dùng', trips: 'Chuyến đi', support: 'Báo lỗi', activity: 'Nhật ký quản trị', system: 'Hệ thống' } as Record<string, string>)[section]}</h1>
      <button className="secondary-button compact" onClick={refresh}>Làm mới</button></div>
    {section === 'dashboard' ? <DashboardView data={data as Dashboard} />
      : section === 'system' ? <SystemView data={data as System} />
        : child === 'trips' && section === 'users' ? <><a className="text-button" href={'#users/' + id}>Về người dùng</a>
          <AdminList section="trips" page={data as Page<Trip>} query={query} base={'users/' + id + '/trips'} /></>
        : id ? <AdminDetail api={api} section={section} value={data as User | Trip | Ticket} refresh={refresh} reauthenticate={reauthenticate} />
          : <AdminList section={section} page={data as Page<User | Trip | Ticket | Audit>} query={query} />}
  </>;
}

function DashboardView({ data }: { data: Dashboard }) {
  return <>
    <p className="muted">Cập nhật lúc {time(data.updatedAt)}</p>
    <div className="admin-metrics">
      {[['users?status=active', 'Tài khoản hoạt động', data.users], ['trips?status=active', 'Chuyến đang mở', data.trips],
        ['support', 'Báo lỗi chưa xử lý', data.support], ['system', 'Tác vụ lỗi', data.failures]].map(([href, title, count]) =>
        <a className="card field-card" key={String(href)} href={'#' + href}><span>{title}</span><strong>{count}</strong></a>)}
    </div>
    <h2>Báo lỗi mới</h2><TicketRows rows={data.tickets} />
    <h2>Nhật ký gần đây</h2><AuditRows rows={data.activity} />
  </>;
}

function AdminList({ section, page, query, base = section }: { section: string; page: Page<User | Trip | Ticket | Audit>; query: URLSearchParams; base?: string }) {
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget), next = new URLSearchParams();
    for (const [key, value] of values) if (value) next.set(key, String(value));
    window.location.hash = section + (next.size ? '?' + next : '');
  }
  const next = new URLSearchParams(query);
  if (page.nextCursor) next.set('cursor', page.nextCursor);
  return <>
    {base === section && <form className="card field-card admin-filters" onSubmit={filter}>
      {section === 'users' && <>
        <label>Email chính xác<input type="email" name="email" defaultValue={query.get('email') ?? ''} /></label>
        <label>Mã người dùng<input name="uid" defaultValue={query.get('uid') ?? ''} /></label>
        <label>Trạng thái<select name="status" defaultValue={query.get('status') ?? ''}><option value="">Tất cả</option><option value="active">Hoạt động</option><option value="disabled">Đã khóa</option></select></label>
      </>}
      {section === 'trips' && <>
        <label>Mã chuyến<input name="tripId" defaultValue={query.get('tripId') ?? ''} /></label>
        <label>Trạng thái<select name="status" defaultValue={query.get('status') ?? ''}><option value="">Tất cả</option><option value="active">Đang mở</option><option value="archived">Đã chốt</option></select></label>
        <label>Kiểm soát<select name="moderationStatus" defaultValue={query.get('moderationStatus') ?? ''}><option value="">Tất cả</option><option value="normal">Bình thường</option><option value="suspended">Tạm khóa</option></select></label>
      </>}
      {section === 'support' && <label>Trạng thái<select name="status" defaultValue={query.get('status') ?? 'open'}>{['open', 'in_progress', 'resolved'].map(status => <option key={status} value={status}>{label(status)}</option>)}</select></label>}
      {section === 'activity' && <>
        <label>Đối tượng<select name="targetType" defaultValue={query.get('targetType') ?? ''}><option value="">Tất cả</option><option value="user">Người dùng</option><option value="trip">Chuyến đi</option><option value="support">Báo lỗi</option></select></label>
        <label>Từ ngày<input type="date" name="from" defaultValue={query.get('from') ?? ''} /></label>
        <label>Đến ngày<input type="date" name="to" defaultValue={query.get('to') ?? ''} /></label>
      </>}
      <button className="primary-button">Lọc</button><a className="text-button" href={'#' + section}>Xóa lọc</a>
    </form>}
    {section === 'support' ? <TicketRows rows={page.items as Ticket[]} />
      : section === 'activity' ? <AuditRows rows={page.items as Audit[]} />
        : <div className="card admin-table"><table><thead><tr><th>{section === 'users' ? 'Người dùng' : 'Chuyến đi'}</th><th>Trạng thái</th><th>{section === 'users' ? 'Đồng bộ đăng nhập' : 'Kiểm soát'}</th><th>Chi tiết</th></tr></thead>
          <tbody>{page.items.map(row => {
            const user = row as User, trip = row as Trip;
            return <tr key={row.id}><td>{section === 'users' ? <>{user.name}<small>{user.email}</small></> : trip.name}</td>
              <td>{label((row as User | Trip).status)}</td><td>{label(section === 'users' ? user.authSyncStatus : trip.moderationStatus)}</td>
              <td><a className="text-button" href={'#' + section + '/' + row.id}>Mở chi tiết</a></td></tr>;
          })}</tbody></table>{!page.items.length && <p className="empty">Chưa có kết quả.</p>}</div>}
    <div className="button-pair"><a className="text-button" href={'#' + base}>Về trang đầu</a>
      {page.nextCursor && <a className="secondary-button" href={'#' + base + '?' + next}>Trang tiếp</a>}</div>
  </>;
}

function TicketRows({ rows }: { rows: Ticket[] }) {
  return <div className="card field-card">{rows.length ? rows.map(ticket => <a key={ticket.id} className="admin-ticket" href={'#support/' + ticket.id}>
    <div><strong>{label(ticket.category)}</strong><p>{label(ticket.status)} · {time(ticket.updatedAt)}</p><small>{ticket.id}</small></div><span>Mở chi tiết</span>
  </a>) : <p>Chưa có báo lỗi.</p>}</div>;
}
function AuditRows({ rows }: { rows: Audit[] }) {
  return <div className="card admin-table"><table><thead><tr><th>Thao tác</th><th>Đối tượng</th><th>Người xử lý</th><th>Lý do</th><th>Thời gian</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}><td>{label(row.action)}</td><td>{label(row.targetType)}<small>{row.targetId}</small></td>
      <td>{row.actorUid}</td><td>{row.reason}</td><td>{time(row.createdAt)}</td></tr>)}</tbody>
  </table>{!rows.length && <p className="empty">Chưa có hoạt động.</p>}</div>;
}

function AdminDetail({ api, section, value, refresh, reauthenticate }: {
  api: AdminClient; section: string; value: User | Trip | Ticket; refresh: () => void; reauthenticate: () => Promise<void>;
}) {
  const [action, setAction] = useState<{ path: string; method?: string; version: number; title: string; status?: string; note?: boolean }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reauth, setReauth] = useState(false);
  const [job, setJob] = useState<string>();
  const user = value as User, trip = value as Trip, ticket = value as Ticket;
  const [notes, setNotes] = useState(ticket.notes ?? []);
  const [notesCursor, setNotesCursor] = useState(ticket.notesCursor);
  const [notesError, setNotesError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || busy) return;
    const form = new FormData(event.currentTarget);
    const text = String(form.get('text')).trim();
    const body = action.note ? { note: text } : { reason: text, ...(action.status && { status: action.status }) };
    setBusy(true); setError(''); setReauth(false);
    try {
      const result = await api.write(action.path, body, action.version, action.method) as { jobId?: string };
      if (result.jobId) { setJob(result.jobId); setAction(undefined); }
      else refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa lưu được thao tác.');
      setReauth(cause instanceof ApiError && cause.code === 'ADMIN_REAUTH_REQUIRED');
    } finally { setBusy(false); }
  }
  const open = (path: string, title: string, version: number, extra?: { status?: string; note?: boolean; method?: string }) => {
    setError(''); setReauth(false); setAction({ path, title, version, ...extra });
  };
  return <>
    <PageTitle title={section === 'users' ? user.name ?? 'Người dùng' : section === 'trips' ? trip.name : 'Chi tiết báo lỗi'} back={'#' + section} />
    <section className="card field-card">
      <p>Mã {value.id}</p>
      {section === 'users' && <>
        <p>{user.email}</p><p>{label(user.status)} · {label(user.authSyncStatus)}</p>{user.disabledReason && <p>{user.disabledReason}</p>}
        <a className="text-button" href={'#users/' + user.id + '/trips'}>Xem các chuyến tham gia</a>
        <div className="button-pair">
          <button className="danger-button" onClick={() => open('/users/' + user.id + '/disable', 'Khóa tài khoản', user.moderationVersion)}>Khóa tài khoản</button>
          {user.status === 'disabled' && <button className="secondary-button" onClick={() => open('/users/' + user.id + '/enable', 'Mở tài khoản', user.moderationVersion)}>Mở tài khoản</button>}
        </div>
      </>}
      {section === 'trips' && <>
        <p>{trip.status === 'active' ? 'Đang mở' : label(trip.status)} · {label(trip.moderationStatus)}</p>
        <p>{trip.participantCount} người chia tiền · {trip.expenseCount} khoản chi · {trip.settlementCount} lượt trả nợ</p>
        {trip.moderationReason && <p>{trip.moderationReason}</p>}
        <button className={trip.moderationStatus === 'suspended' ? 'secondary-button' : 'danger-button'}
          onClick={() => open('/trips/' + trip.id + (trip.moderationStatus === 'suspended' ? '/resume' : '/suspend'),
            trip.moderationStatus === 'suspended' ? 'Mở quyền ghi của chuyến' : 'Tạm khóa chuyến', trip.moderationVersion)}>
          {trip.moderationStatus === 'suspended' ? 'Mở quyền ghi' : 'Tạm khóa chuyến'}</button>
      </>}
      {section === 'support' && <>
        <p>{label(ticket.category)} · {label(ticket.status)}</p>
        <p>Người gửi {ticket.author ?? ticket.createdBy}</p>
        {ticket.trip && <p>Chuyến {ticket.trip}</p>}
        <p className="admin-message">{ticket.message}</p>
        <div className="button-pair">
          {['open', 'in_progress', 'resolved'].filter(status => status !== ticket.status).map(status =>
            <button key={status} className="secondary-button" onClick={() => open('/support/' + ticket.id, label(status), ticket.version, { status, method: 'PATCH' })}>{label(status)}</button>)}
          <button className="primary-button" onClick={() => open('/support/' + ticket.id + '/notes', 'Thêm ghi chú nội bộ', ticket.version, { note: true })}>Thêm ghi chú nội bộ</button>
        </div>
      </>}
    </section>
    {section === 'support' && <section className="card field-card"><h2>Ghi chú nội bộ</h2>
      {notes.map(note => <article key={note.id}><p className="admin-message">{note.note}</p><small>{note.actorUid} · {time(note.createdAt)}</small></article>)}
      {!notes.length && <p>Chưa có ghi chú.</p>}
      {notesError && <p className="error" role="alert">{notesError}</p>}
      {notesCursor && <button className="secondary-button" disabled={busy} onClick={async () => {
        setBusy(true); setNotesError('');
        try {
          const page = await api.read<Page<Note>>('/support/' + ticket.id + '/notes?cursor=' + encodeURIComponent(notesCursor));
          setNotes(previous => [...previous, ...page.items.filter(note => !previous.some(item => item.id === note.id))]);
          setNotesCursor(page.nextCursor ?? undefined);
        } catch (cause) { setNotesError(cause instanceof Error ? cause.message : 'Chưa tải được ghi chú.'); }
        finally { setBusy(false); }
      }}>Ghi chú cũ hơn</button>}
    </section>}
    {job && <JobStatus api={api} id={job} onFinished={refresh} />}
    {action && <Dialog title={action.title} onClose={() => { if (!busy) setAction(undefined); }}>
      <form className="field-card" onSubmit={submit}>
        {section === 'users' && <p>{action.path.endsWith('/disable') ? 'Tài khoản sẽ mất quyền truy cập ứng dụng. Đăng nhập sẽ được đồng bộ theo trạng thái tác vụ.' : 'Tài khoản sử dụng lại được khi đồng bộ đăng nhập thành công.'}</p>}
        {section === 'trips' && <p>Thành viên xem được lịch sử khi chuyến tạm khóa.</p>}
        <label>{action.note ? 'Ghi chú nội bộ' : 'Lý do'}<textarea name="text" rows={4} minLength={action.note ? 1 : 10} maxLength={action.note ? 2000 : 500} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        {reauth && <button className="secondary-button" type="button" onClick={async () => {
          try { await reauthenticate(); setReauth(false); setError('Đã xác thực. Kiểm tra nội dung rồi xác nhận lại.'); }
          catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa xác thực được.'); }
        }}>Xác thực lại với Google</button>}
        <button className="primary-button" disabled={busy}>{busy ? 'Đang lưu…' : 'Xác nhận'}</button>
      </form>
    </Dialog>}
  </>;
}

function JobStatus({ api, id, onFinished }: { api: AdminClient; id: string; onFinished: () => void }) {
  const [epoch, setEpoch] = useState(0);
  const job = useRead<Job>(api, '/jobs/' + id, epoch);
  useEffect(() => {
    if (!job.data || !['queued', 'running'].includes(job.data.status) || epoch >= 20) return;
    const timer = window.setTimeout(() => setEpoch(value => value + 1), 3000);
    return () => window.clearTimeout(timer);
  }, [job.data, epoch]);
  return <section className="card field-card"><h2>Đồng bộ đăng nhập</h2>
    <p role="status">{job.data ? label(job.data.status) : job.error ?? 'Đang kiểm tra…'}</p>
    {job.data?.lastErrorCode && <p className="error">{job.data.lastErrorCode}</p>}
    <button className="secondary-button" onClick={onFinished}>Tải lại tài khoản</button>
  </section>;
}
function SystemView({ data }: { data: System }) {
  return <section className="card field-card">
    <p>{data.environment} · {data.release ?? 'Chưa khai báo phiên bản phát hành'}</p>
    <h2>Đồng bộ tài khoản gần đây</h2>
    {data.jobs.map(job => <p key={job.id}>{job.id} · {label(job.status)} · {time(job.updatedAt)}</p>)}
    {!data.jobs.length && <p>Chưa có tác vụ đồng bộ.</p>}
    <h2>Tác vụ bảo trì gần đây</h2>
    {data.maintenance.map(job => <div key={job.id}>
      <p>{job.kind === 'ledger_reconcile' ? 'Đối soát sổ tiền' : job.kind === 'projection_repair' ? 'Sửa số dư từ sổ tiền' : job.id} · {label(job.status)} · {time(job.updatedAt)}</p>
      {job.resultSummary && <p>Đã kiểm {job.resultSummary.tripsChecked}/{job.resultSummary.tripsScanned} chuyến · {job.resultSummary.tripsWithIssues} chuyến cần kiểm tra · {job.resultSummary.issueCount} sai lệch · {job.resultSummary.scanErrors} lỗi quét</p>}
      {job.repairSummary && <p>Đã sửa {job.repairSummary.changedDocuments} bản ghi số dư, bộ đếm và thông báo cập nhật. Chuyến tiếp tục tạm khóa để kiểm tra.</p>}
      {job.lastErrorCode && <p className="error">{job.lastErrorCode}</p>}
    </div>)}
    {!data.maintenance.length && <p>Chưa có kết quả bảo trì.</p>}
  </section>;
}
