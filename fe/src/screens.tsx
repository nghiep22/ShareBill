'use client';

import { ArrowRight, CalendarDays, ChevronRight, CircleHelp, CloudOff, History, Luggage, MapPin, Plus, WalletCards } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { LocalWorkspace, Profile, Report } from './local-workspace';
import { activeExpenses, dateRange, defaultTimezone, nameOf, newId, type Demo, type Trip } from './model';
import { Amount, Dialog, Empty, PageTitle } from './ui';
import { tripHref } from './workspace-route';

export function Trips({ state, onOpen, onStatus, remoteArchived, onMore, loading }: {
  state: LocalWorkspace; onOpen: (id: string) => void; onStatus?: (archived: boolean) => void;
  remoteArchived?: boolean; onMore?: () => void; loading?: boolean;
}) {
  const [localArchived, setLocalArchived] = useState(false);
  const archived = remoteArchived ?? localArchived;
  const setArchived = onStatus ?? setLocalArchived;
  const trips = Object.entries(state.trips).filter(([, data]) => data.trip.closed === archived);
  return <>
    <PageTitle title="Chuyến đi của tôi" description="Xem và quản lý chi tiêu theo từng chuyến.">
      <a className="primary-button compact" href="#tao-chuyen"><Plus size={19} aria-hidden /> Tạo chuyến đi</a>
    </PageTitle>
    <div className="segmented compact-segments" aria-label="Trạng thái chuyến đi">
      <button aria-pressed={!archived} onClick={() => setArchived(false)}>Đang mở</button>
      <button aria-pressed={archived} onClick={() => setArchived(true)}>Đã chốt</button>
    </div>
    <div className="trip-grid">
      {trips.map(([id, data]) => <button key={id} className="trip-card trip-tile" onClick={() => onOpen(id)}>
        <span className={`trip-cover ${data.trip.cover ? '' : 'cover-plain'}`}>
          <span className="trip-status"><span />{data.remote?.suspended ? 'Tạm khóa' : data.trip.closed ? 'Đã chốt' : 'Đang mở'}</span>
          <strong>{data.trip.name}</strong>
        </span>
        <span className="trip-tile-body">
          <span><MapPin size={15} aria-hidden /> {data.trip.place || 'Chưa chọn địa điểm'}</span>
          <span><CalendarDays size={15} aria-hidden /> {dateRange(data.trip)}</span>
          <span className="trip-tile-total"><span>{data.remote?.participantCount ?? data.members.filter(member => !member.inactive).length} thành viên <span aria-hidden>·</span> <Amount value={data.remote?.total ?? activeExpenses(data).reduce((sum, expense) => sum + expense.amount, 0)} /></span><ChevronRight size={18} aria-hidden /></span>
        </span>
      </button>)}
    </div>
    {loading && <p role="status">Đang tải chuyến đi…</p>}
    {!trips.length && !loading && !onMore && <div className="card empty-stack"><Luggage size={27} aria-hidden /><Empty>{archived ? 'Chưa có chuyến đi đã chốt.' : 'Bạn chưa có chuyến đi đang mở.'}</Empty>
      {!archived && <a className="secondary-button" href="#tao-chuyen">Tạo chuyến đầu tiên</a>}
    </div>}
    {onMore && <button className="secondary-button" disabled={loading} onClick={onMore}>Tải thêm chuyến đi</button>}
  </>;
}

export function TripFields({ trip, disabled, optionalCollapsed }: { trip?: Trip; disabled?: boolean; optionalCollapsed?: boolean }) {
  const timezone = trip?.timezone ?? defaultTimezone;
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const timezones = [...new Set([defaultTimezone, 'UTC', timezone, ...supported])];
  const planning = <>
    <label>Địa điểm<input name="place" defaultValue={trip?.place} placeholder="Thành phố hoặc khu vực" maxLength={150} disabled={disabled} /></label>
    <div className="field-pair">
      <label>Ngày bắt đầu<input name="start" type="date" defaultValue={trip?.start} disabled={disabled} /></label>
      <label>Ngày kết thúc<input name="end" type="date" defaultValue={trip?.end} disabled={disabled} /></label>
    </div>
    <label>Ghi chú<textarea name="note" defaultValue={trip?.note} maxLength={1000} rows={3} disabled={disabled} /></label>
    <label>Múi giờ<select name="timezone" aria-label="Múi giờ" defaultValue={timezone} disabled={disabled}>
      {timezones.map(item => <option key={item} value={item}>{item === defaultTimezone ? 'Giờ Việt Nam' : item.replaceAll('_', ' ')}</option>)}
    </select></label>
  </>;
  return <>
    <label>Tên chuyến đi<input name="name" defaultValue={trip?.name} placeholder="Ví dụ: Cuối tuần ở Đà Lạt" maxLength={100} required disabled={disabled} /></label>
    {optionalCollapsed ? <details className="optional-fields"><summary>Ngày, địa điểm và múi giờ</summary><div className="field-card">{planning}</div></details> : planning}
  </>;
}

export function readTripFields(form: HTMLFormElement, previous?: Trip): Trip | string {
  const fields = new FormData(form);
  const name = String(fields.get('name')).trim();
  const start = String(fields.get('start'));
  const end = String(fields.get('end'));
  if (!name) return 'Nhập tên chuyến đi.';
  if (Boolean(start) !== Boolean(end)) return 'Chọn cả ngày bắt đầu và ngày kết thúc.';
  if (start > end) return 'Ngày kết thúc cần từ ngày bắt đầu trở đi.';
  return { ...previous, name, start, end, closed: previous?.closed ?? false, place: String(fields.get('place')).trim(),
    note: String(fields.get('note')).trim(), timezone: String(fields.get('timezone') ?? defaultTimezone) };
}

export function CreateTrip({ profile, onCreate, remote }: { profile?: Profile; onCreate: (trip: Trip, name: string) => void; remote?: boolean }) {
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trip = readTripFields(event.currentTarget);
    if (typeof trip === 'string') { setError(trip); return; }
    const name = String(new FormData(event.currentTarget).get('owner')).trim();
    if (!name) { setError('Nhập tên của bạn trong chuyến.'); return; }
    onCreate(trip, name);
  }
  return <div className="form-page">
    <PageTitle title="Tạo chuyến đi" back="#chuyen-di" />
    <form className="card field-card" onSubmit={submit}>
      <TripFields optionalCollapsed={remote} />
      <label>Tên của bạn trong chuyến<input name="owner" defaultValue={profile?.name} maxLength={80} required /></label>
      <p className="inline-note">Đơn vị chi tiêu: VND</p>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary-button"><Plus size={19} aria-hidden /> Tạo chuyến đi</button>
    </form>
  </div>;
}

export function SignIn({ registering, onSubmit, remote }: { registering: boolean; onSubmit: (profile: Profile, password: string) => void; remote?: boolean }) {
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const email = String(fields.get('email')).trim();
    const name = registering ? String(fields.get('name')).trim() : email.split('@')[0];
    if (!name) { setError('Nhập tên hiển thị.'); return; }
    onSubmit({ name, email }, String(fields.get('password')));
  }
  return <div className="form-page auth-page">
    <div className="card field-card">
      <span className="tile-icon"><WalletCards size={23} aria-hidden /></span>
      <h1>{registering ? 'Tạo tài khoản' : 'Đăng nhập'}</h1>
      {remote ? <p>Lưu chuyến đi và chia chi phí với các thành viên trong nhóm.</p> : <p>Biểu mẫu dùng thử trên thiết bị này. Hãy dùng email và mật khẩu mẫu.</p>}
      <form className="form-stack field-card auth-fields" onSubmit={submit}>
        {registering && <label>Tên hiển thị<input name="name" autoComplete="name" maxLength={80} required /></label>}
        <label>Email<input name="email" type="email" autoComplete="email" placeholder="ban@example.com" maxLength={254} required /></label>
        <label>Mật khẩu<input name="password" type="password" minLength={remote && !registering ? 1 : 8} autoComplete={registering ? 'new-password' : 'current-password'} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary-button">{remote ? registering ? 'Tạo tài khoản' : 'Đăng nhập' : registering ? 'Tạo hồ sơ mẫu' : 'Mở hồ sơ mẫu'} <ArrowRight size={17} aria-hidden /></button>
      </form>
      <a className="text-button" href={registering ? '#dang-nhap' : '#dang-ky'}>{registering ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký'}</a>
      <a className="secondary-button" href={remote ? '/demo/' : '#tong-quan'}>Tiếp tục xem thử</a>
    </div>
  </div>;
}

export function Account({ profile, onSignOut, onReset }: { profile?: Profile; onSignOut: () => void; onReset: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function reset() {
    setBusy(true);
    setError('');
    try {
      await onReset();
      setConfirming(false);
    } catch {
      setError('Chưa xóa được dữ liệu trên thiết bị. Hãy thử lại.');
    } finally {
      setBusy(false);
    }
  }
  return <div className="form-page">
    <PageTitle title="Tài khoản" back="#tong-quan" />
    <section className="card field-card">
      <h2>Hồ sơ dùng thử</h2>
      {profile ? <><p>{profile.name} <span aria-hidden>·</span> {profile.email}</p><button className="secondary-button" onClick={onSignOut}>Đăng xuất</button></>
        : <div className="button-pair"><a className="primary-button" href="#dang-nhap">Đăng nhập</a><a className="secondary-button" href="#dang-ky">Đăng ký</a></div>}
    </section>
    <section className="card field-card">
      <h2>Dữ liệu trên thiết bị</h2>
      <p>Chuyến đi, hồ sơ và ảnh hóa đơn dùng thử được lưu trong trình duyệt này.</p>
      <button className="danger-button" onClick={() => setConfirming(true)}>Xóa dữ liệu dùng thử</button>
    </section>
    <div className="card rows">
      <a className="list-row" href="#ngoai-tuyen"><CloudOff size={20} aria-hidden /><span className="row-text">Dữ liệu ngoại tuyến</span><ChevronRight size={18} aria-hidden /></a>
      <a className="list-row" href="#tro-giup"><CircleHelp size={20} aria-hidden /><span className="row-text">Trợ giúp</span><ChevronRight size={18} aria-hidden /></a>
    </div>
    {confirming && <Dialog title="Xóa dữ liệu dùng thử?" onClose={() => { if (!busy) setConfirming(false); }}>
      <p>Các chuyến đi, ảnh hóa đơn và hồ sơ bạn đã lưu trên thiết bị sẽ bị xóa. Chuyến Đà Lạt mẫu sẽ được khôi phục.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="button-pair"><button className="secondary-button" disabled={busy} onClick={() => setConfirming(false)}>Quay lại</button><button className="danger-button" disabled={busy} onClick={() => void reset()}>Xóa dữ liệu</button></div>
    </Dialog>}
  </div>;
}

const activityTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' });

export function ActivityScreen({ data, onMore, loading }: { data: Demo; onMore?: () => void; loading?: boolean }) {
  const [limit, setLimit] = useState(30);
  const items = data.activity ?? [];
  return <>
    <PageTitle title="Hoạt động chuyến đi" description={data.trip.name} back={tripHref(data, 'tong-quan')} />
    <div className="card rows">
      {!items.length && <Empty>Chưa có hoạt động trong chuyến đi.</Empty>}
      {(data.remote ? items : items.slice(0, limit)).map(item => <article className="list-row" key={item.id}>
        <span className="tile-icon"><History size={19} aria-hidden /></span>
        <div className="row-text"><strong>{item.href ? <a href={item.href}>{item.title}</a> : item.title}</strong>
          {item.detail && <span>{item.detail}</span>}<span>{item.actorName ?? nameOf(data, item.actor)} · <time dateTime={item.at}>{activityTime.format(new Date(item.at))}</time></span></div>
      </article>)}
    </div>
    {(onMore || (!data.remote && items.length > limit)) && <button className="secondary-button" disabled={loading} onClick={onMore ?? (() => setLimit(limit + 30))}>Tải thêm hoạt động</button>}
  </>;
}

export function Support({ reports, onReport }: { reports: Report[]; onReport: (report: Report) => void }) {
  const [notice, setNotice] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const title = String(fields.get('title')).trim();
    const detail = String(fields.get('detail')).trim();
    if (!title || !detail) { setNotice('Nhập chủ đề và mô tả.'); return; }
    onReport({ id: newId(), title, detail, at: new Date().toISOString() });
    event.currentTarget.reset();
    setNotice('Đã lưu báo cáo trên thiết bị.');
  }
  return <div className="form-page">
    <PageTitle title="Trợ giúp" back="#tai-khoan" />
    <form className="card field-card" onSubmit={submit}>
      <h2>Báo lỗi giao diện</h2>
      <label>Chủ đề<input name="title" maxLength={100} required /></label>
      <label>Mô tả<textarea name="detail" rows={3} maxLength={1000} required /></label>
      <button className="primary-button">Lưu báo cáo dùng thử</button>
      {notice && <p className="inline-note" role="status">{notice}</p>}
    </form>
    <section className="card field-card">
      <h2>Báo cáo đã lưu</h2>
      {!reports.length && <p>Chưa có báo cáo.</p>}
      {reports.map(report => <details key={report.id}><summary>{report.title}</summary><p>{report.detail}</p><time dateTime={report.at}>{activityTime.format(new Date(report.at))}</time></details>)}
    </section>
  </div>;
}

export function Offline() {
  return <div className="form-page">
    <PageTitle title="Dữ liệu ngoại tuyến" back="#tai-khoan" />
    <section className="card field-card">
      <span className="tile-icon"><CloudOff size={23} aria-hidden /></span>
      <h2>Chuyến đi trên thiết bị</h2>
      <p>Khi giao diện đã được tải, bạn có thể mở và chỉnh sửa các chuyến đi đã lưu trên trình duyệt kể cả khi mất mạng.</p>
      <a className="primary-button" href="#chuyen-di">Mở danh sách chuyến đi <ArrowRight size={17} aria-hidden /></a>
    </section>
  </div>;
}
