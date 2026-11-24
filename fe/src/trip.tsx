'use client';

import { CalendarDays, Check, History, Link2, LockKeyhole, MapPin, Pencil, Plus, RotateCcw, Send, Smartphone, Trash2, Users } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import {
  canWrite, dateLabel, dateRange, isOwner, nameOf, newId, ownerOf, record,
  today, viewerOf, type Demo, type Plan,
} from './model';
import { readTripFields, TripFields } from './screens';
import { Dialog, Empty, PageTitle } from './ui';
import type { ItineraryChange, UpdateTrip } from './trip-command';
import { tripHref } from './workspace-route';
import { financialSnapshot } from './finance-view';

export function Itinerary({ data, update, loading, disabled, saving, readError, selectedDay, onDayChange }: {
  data: Demo; update: UpdateTrip; loading?: boolean; disabled?: boolean; saving?: boolean;
  readError?: string;
  selectedDay?: string; onDayChange?: (day: string) => void;
}) {
  const first = data.trip.start || data.plans.map(plan => plan.day).sort()[0] || today(data.trip.timezone);
  const [localDay, setLocalDay] = useState<string>();
  const day = selectedDay ?? localDay ?? first;
  const selectDay = onDayChange ?? setLocalDay;
  const [editing, setEditing] = useState<(Partial<Plan> & { ideaId?: string; version?: number }) | null>(null);
  const [remove, setRemove] = useState<(Plan & { version?: number }) | null>(null);
  const [memberView, setMemberView] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const ownerView = isOwner(data) && !memberView;
  const writable = canWrite(data) && (!data.remote || data.remote.itineraryVersion !== undefined);
  const managing = ownerView && writable;
  const locked = Boolean(disabled || loading);
  const version = data.remote?.itineraryVersion;
  const itineraryChanged = Boolean(editing && editing.version !== undefined && editing.version !== version);
  const serverActivity = editing?.id ? data.plans.find(plan => plan.id === editing.id) : undefined;
  const removalChanged = Boolean(remove && remove.version !== undefined && remove.version !== version);
  const currentRemoval = remove ? data.plans.find(plan => plan.id === remove.id) : undefined;
  const days = new Set([first, day, ...data.plans.map(plan => plan.day)]);
  const cursor = new Date(first + 'T00:00:00Z');
  for (let index = 0; index < 14 && cursor.toISOString().slice(0, 10) <= data.trip.end; index++) {
    days.add(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const plans = data.plans.filter(plan => plan.day === day).sort((a, b) => a.time.localeCompare(b.time));

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || !managing || locked || itineraryChanged) return;
    const fields = new FormData(event.currentTarget);
    const title = String(fields.get('title')).trim();
    if (!title) { setError('Nhập tên hoạt động.'); return; }
    const activity = { day: String(fields.get('day')), title,
      time: String(fields.get('time')), place: String(fields.get('place')).trim(), note: String(fields.get('note')).trim() };
    const plan = { ...activity, id: editing.id ?? newId(), suggestionId: editing.ideaId ?? editing.suggestionId };
    const change: ItineraryChange = editing.id ? { ...activity, action: 'edit-activity', id: editing.id }
      : { ...activity, action: 'add-activity', suggestionId: editing.ideaId };
    update(record({ ...data, plans: editing.id ? data.plans.map(item => item.id === plan.id ? plan : item) : [...data.plans, plan],
      ideas: editing.ideaId ? (data.ideas ?? []).map(idea => idea.id === editing.ideaId ? { ...idea, scheduled: true } : idea) : data.ideas },
      editing.id ? 'Sửa lịch trình' : 'Thêm hoạt động vào lịch trình', title, '#lich-trinh'),
      { type: 'itinerary', change, version: editing.version }, () => { selectDay(plan.day); setEditing(null); });
  }

  function suggest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writable || locked) return;
    const form = event.currentTarget;
    const title = String(new FormData(form).get('title')).trim();
    if (!title) { setNotice('Nhập điểm đến hoặc hoạt động đề xuất.'); return; }
    const by = data.remote?.actorUid ?? (ownerView || !isOwner(data) ? viewerOf(data) : data.members.find(member => member.id !== ownerOf(data) && !member.inactive && member.linked)?.id);
    if (!by) return;
    const idea = { id: newId(), title, by };
    const next = record({ ...data, viewerId: by, ideas: [...(data.ideas ?? []), idea] }, 'Đề xuất điểm đến', title, '#lich-trinh');
    update({ ...next, viewerId: data.viewerId }, { type: 'itinerary', change: { action: 'suggest', title } },
      () => { form.reset(); setNotice('Đã lưu đề xuất.'); });
  }

  return <>
    <PageTitle title="Lịch trình chuyến đi" description={data.trip.name} back={tripHref(data, 'tong-quan')}>
      {managing && <button className="primary-button compact" disabled={locked} onClick={() => { setError(''); setEditing({ version }); }}><Plus size={18} aria-hidden /> Thêm hoạt động</button>}
    </PageTitle>
    {isOwner(data) && !data.remote && <div className="segmented compact-segments" aria-label="Góc nhìn lịch trình">
      <button aria-pressed={!memberView} onClick={() => { setMemberView(false); setNotice(''); }}>Chủ chuyến</button>
      <button aria-pressed={memberView} onClick={() => { setMemberView(true); setNotice(''); }}>Góc nhìn thành viên</button>
    </div>}
    {!ownerView && <p className="inline-note"><Users size={18} aria-hidden /> {data.ownerId || !data.remote ? nameOf(data, ownerOf(data)) : 'Chủ chuyến'} quản lý lịch trình.{writable && ' Thành viên có thể đề xuất điểm đến.'}</p>}
    {loading && <p className="inline-note" role="status">Đang cập nhật lịch trình…</p>}
    <label className="itinerary-day-picker">Ngày xem lịch trình
      <input type="date" data-pwa-view-control disabled={saving} value={day} onChange={event => { if (event.target.value) selectDay(event.target.value); }} />
    </label>
    <div className="filters itinerary-days" aria-label="Ngày trong lịch trình">
      {[...days].sort().map(date => <button className="pill" key={date} disabled={saving} aria-pressed={date === day} onClick={() => selectDay(date)}><CalendarDays size={15} aria-hidden /> {dateLabel(date)}</button>)}
    </div>
    <section>
      <div className="section-heading"><h2>Lộ trình ngày {dateLabel(day)}</h2><span className="tag">{plans.length} hoạt động</span></div>
      <div className="timeline">
        {plans.map(plan => <article className="timeline-event" key={plan.id}>
          <time dateTime={plan.time}>{plan.time}</time><span className="timeline-dot" />
          <div className="card timeline-card">
            <div><h3>{plan.title}</h3>{plan.place && <p><MapPin size={15} aria-hidden /> {plan.place}</p>}{plan.note && <p>{plan.note}</p>}</div>
            {managing && <div className="row-controls"><button className="icon-button" disabled={locked} aria-label={'Sửa ' + plan.title} onClick={() => { setError(''); setEditing({ ...plan, version }); }}><Pencil size={17} aria-hidden /></button>
              <button className="icon-button" disabled={locked} aria-label={'Xóa ' + plan.title} onClick={() => setRemove({ ...plan, version })}><Trash2 size={17} aria-hidden /></button></div>}
          </div>
        </article>)}
        {!plans.length && <div className="card"><Empty>Chưa có hoạt động cho ngày này.</Empty></div>}
      </div>
    </section>
    <section className="card field-card">
      <h2>Đề xuất điểm đến</h2>
      {!ownerView && writable && (!memberView || data.members.some(member => member.id !== ownerOf(data) && !member.inactive && member.linked)) &&
        <form className="inline-form" onSubmit={suggest}><input name="title" aria-label="Điểm đến đề xuất" placeholder="Bạn muốn ghé đâu?" maxLength={100} required disabled={locked} /><button className="primary-button" disabled={locked}><Send size={16} aria-hidden /> Gửi đề xuất</button></form>}
      {notice && <p role="status">{notice}</p>}
      {!(data.ideas ?? []).length && <p>Chưa có đề xuất.</p>}
      {(data.ideas ?? []).map(idea => <div className="idea-row" key={idea.id}>
        <div><strong>{idea.title}</strong><p>{idea.author ?? nameOf(data, idea.by)}{idea.declined ? ' · Đã từ chối' : idea.scheduled ? ' · Đã lên lịch' : ' · Đang chờ duyệt'}</p></div>
        {managing && !idea.declined && !idea.scheduled && <button className="text-button" disabled={locked} onClick={() => update(record({
          ...data, ideas: (data.ideas ?? []).map(entry => entry.id === idea.id ? { ...entry, declined: true } : entry),
        }, 'Từ chối đề xuất', idea.title, '#lich-trinh'), { type: 'itinerary', change: { action: 'decline-suggestion', id: idea.id } })}>Từ chối</button>}
        {managing && !idea.declined && !idea.scheduled && <button className="soft-button" disabled={locked} onClick={() => { setError(''); setEditing({ ideaId: idea.id, title: idea.title, note: 'Đề xuất của ' + (idea.author ?? nameOf(data, idea.by)), version }); }}>Lên lịch</button>}
      </div>)}
    </section>
    {editing && <Dialog title={editing.id ? 'Sửa hoạt động' : 'Thêm hoạt động'} onClose={() => setEditing(null)}>
      {readError && <p className="inline-note error" role="alert">{readError}</p>}
      <form className="field-card dialog-fields" onSubmit={save}>
        {itineraryChanged && <section className="inline-note" aria-label="Xung đột lịch trình">
          <p>Lịch trình đã thay đổi. Kiểm tra dữ liệu mới trước khi áp lại phần đang nhập.</p>
          {serverActivity && <p>{serverActivity.title} · {dateLabel(serverActivity.day)} · {serverActivity.time} · {serverActivity.place}</p>}
          {editing.id && !serverActivity ? <p>Hoạt động đã được gỡ khỏi lịch trình.</p>
            : <button className="secondary-button" type="button" disabled={locked || !managing} onClick={() => setEditing({ ...editing, version })}>Áp bản nhập lên lịch mới</button>}
        </section>}
        <label>Hoạt động<input name="title" maxLength={100} defaultValue={editing.title} required disabled={locked} /></label>
        <div className="field-pair"><label>Ngày<input name="day" type="date" defaultValue={editing.day ?? day} required disabled={locked} /></label>
          <label>Giờ<input name="time" type="time" defaultValue={editing.time} required disabled={locked} /></label></div>
        <label>Địa điểm<input name="place" maxLength={150} defaultValue={editing.place} disabled={locked} /></label>
        <label>Ghi chú<textarea name="note" rows={2} maxLength={500} defaultValue={editing.note} disabled={locked} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary-button" disabled={locked || !managing || itineraryChanged}>Lưu hoạt động</button>
      </form>
    </Dialog>}
    {remove && <Dialog title="Xóa hoạt động?" onClose={() => setRemove(null)}>
      {readError && <p className="inline-note error" role="alert">{readError}</p>}
      <p>{remove.title} sẽ được gỡ khỏi lịch trình ngày {dateLabel(remove.day)}.</p>
      {removalChanged && <section className="inline-note" aria-label="Thay đổi trước khi xóa">
        {currentRemoval ? <>
          <p>Lịch trình vừa thay đổi. Kiểm tra hoạt động mới nhất trước khi xóa.</p>
          <p>{currentRemoval.title} · {dateLabel(currentRemoval.day)} · {currentRemoval.time}</p>
          <button className="secondary-button" disabled={locked || !managing} onClick={() => setRemove({ ...currentRemoval, version })}>Kiểm tra hoạt động mới nhất</button>
        </> : <p>Hoạt động này đã được gỡ khỏi lịch trình.</p>}
      </section>}
      <button className="danger-button" disabled={locked || !managing || removalChanged || !currentRemoval} onClick={() => {
        if (locked || !managing || removalChanged || !currentRemoval) return;
        update(record({
          ...data, plans: data.plans.filter(item => item.id !== remove.id),
          ideas: data.ideas?.map(idea => idea.id === remove.suggestionId ? { ...idea, scheduled: false } : idea),
        }, 'Xóa hoạt động khỏi lịch trình', remove.title, '#lich-trinh'),
        { type: 'itinerary', change: { action: 'remove-activity', id: remove.id }, version: remove.version }, () => setRemove(null));
      }}>Xóa hoạt động</button>
    </Dialog>}
  </>;
}

export function Settings({ data, update, disabled }: { data: Demo; update: UpdateTrip; disabled?: boolean }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<{ closing: boolean; version?: number }>();
  const [form, setForm] = useState(() => ({ base: data.trip, values: data.trip, version: data.remote?.version }));
  const formRef = useRef<HTMLFormElement>(null);
  const owner = isOwner(data);
  const editing = owner && canWrite(data);
  const conflict = Boolean(form.version !== undefined && data.remote && data.remote.version > form.version);
  const settled = financialSnapshot(data).balanced;

  function loadVersion(keepChanges: boolean) {
    const server = data.trip;
    const values = { ...server };
    const draft = keepChanges && formRef.current ? new FormData(formRef.current) : null;
    for (const key of ['name', 'place', 'start', 'end', 'note', 'timezone'] as const) {
      const value = draft?.get(key);
      if (typeof value === 'string' && value.trim() !== (form.base[key] ?? '')) values[key] = value;
    }
    setForm({ base: server, values, version: data.remote?.version });
    setError('');
    setMessage('');
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || conflict || !editing) return;
    const trip = readTripFields(event.currentTarget, form.base);
    if (typeof trip === 'string') { setError(trip); setMessage(''); return; }
    setError('');
    setMessage('');
    update(record({ ...data, trip }, 'Cập nhật chuyến đi', trip.name, '#cai-dat'), { type: 'save-trip', trip, version: form.version },
      () => {
        setForm({ base: trip, values: trip, version: form.version === undefined ? undefined : form.version + 1 });
        setMessage('Đã lưu thông tin chuyến đi.');
      });
  }
  return <div className="form-page detail-page">
    <PageTitle title="Cài đặt chuyến đi" back={tripHref(data, 'tong-quan')} />
    {editing && conflict && <section className="card field-card">
      <h2>Thông tin chuyến đi đã thay đổi</h2>
      <p>{data.trip.name} · {data.trip.place || 'Chưa chọn địa điểm'} · {dateRange(data.trip)}</p>
      {data.trip.note && <p>{data.trip.note}</p>}
      <div className="button-pair">
        <button className="secondary-button" disabled={disabled} onClick={() => loadVersion(false)}>Dùng bản máy chủ</button>
        <button className="primary-button" disabled={disabled} onClick={() => loadVersion(true)}>Áp lại phần tôi đã sửa</button>
      </div>
    </section>}
    <form className="card field-card" onSubmit={save} ref={formRef}>
      <h2>Thông tin chuyến đi</h2>
      <TripFields key={editing ? form.version : data.remote?.version} trip={editing ? form.values : data.trip} disabled={!editing} />
      <p>Đơn vị chi tiêu: VND</p>
      {editing && <button className="primary-button" disabled={disabled || conflict}><Check size={18} aria-hidden /> Lưu thông tin</button>}
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="positive" role="status">{message}</p>}
    </form>
    <section className="card field-card">
      <h2>Thành viên và lịch sử</h2>
      <a className="secondary-button" href={tripHref(data, 'thanh-vien')}><Users size={17} aria-hidden /> Thành viên và phân quyền</a>
      {owner && <a className="secondary-button" href={tripHref(data, 'loi-moi')}><Link2 size={17} aria-hidden /> Quản lý lời mời</a>}
      <a className="secondary-button" href={tripHref(data, 'hoat-dong')}><History size={17} aria-hidden /> Hoạt động chuyến đi</a>
      {data.remote && <a className="secondary-button" href={tripHref(data, 'tro-giup')}>Báo lỗi về chuyến đi</a>}
    </section>
    {owner && !data.remote?.suspended && (editing || data.trip.closed) && <section className="card field-card">
      <h2>{data.trip.closed ? 'Chuyến đi đã chốt' : 'Chốt chuyến đi'}</h2>
      <p>{data.trip.closed ? 'Mở lại để tiếp tục ghi chi tiêu.' : settled ? 'Tất cả thành viên đã cân bằng. Bạn có thể chốt chuyến đi.' : 'Xác nhận các khoản chuyển và đưa số dư về 0 trước khi chốt.'}</p>
      {data.trip.closed || settled
        ? <button className="secondary-button" disabled={disabled} onClick={() => setConfirmation({ closing: !data.trip.closed, version: data.remote?.version })}>{data.trip.closed ? <><RotateCcw size={17} aria-hidden /> Mở lại chuyến đi</> : <><LockKeyhole size={17} aria-hidden /> Chốt chuyến đi</>}</button>
        : <a className="secondary-button" href={tripHref(data, 'so-du')}>Xem số dư</a>}
    </section>}
    <section className="card field-card">
      <h2><Smartphone size={18} aria-hidden /> Cài ShareBill</h2>
      <p>Chọn <strong>Cài đặt ứng dụng</strong> trong menu trình duyệt. Trên iPhone, trong Safari chọn <strong>Chia sẻ</strong> rồi chọn <strong>Thêm vào màn hình chính</strong>.</p>
    </section>
    {confirmation && <Dialog title={confirmation.closing ? 'Chốt chuyến đi?' : 'Mở lại chuyến đi?'} onClose={() => setConfirmation(undefined)}>
      <p>{confirmation.closing ? 'Các khoản chi và lịch trình chuyển sang chế độ chỉ xem cho đến khi mở lại chuyến đi.' : 'Thành viên có thể tiếp tục thêm khoản chi và ghi nhận chuyển tiền.'}</p>
      <div className="button-pair"><button className="secondary-button" onClick={() => setConfirmation(undefined)}>Quay lại</button>
        <button className="primary-button" disabled={disabled || (confirmation.closing && !settled)} onClick={() => {
          const trip = { ...data.trip, closed: confirmation.closing };
          update(record({ ...data, trip }, confirmation.closing ? 'Chốt chuyến đi' : 'Mở lại chuyến đi', data.trip.name, '#cai-dat'),
            { type: 'close-trip', closed: confirmation.closing, version: confirmation.version }, () => {
              setConfirmation(undefined);
              setMessage('');
              setForm({ base: trip, values: trip, version: confirmation.version === undefined ? undefined : confirmation.version + 1 });
            });
        }}>Xác nhận</button></div>
    </Dialog>}
  </div>;
}
