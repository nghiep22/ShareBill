'use client';

import { CalendarDays, Check, Clipboard, LockKeyhole, MapPin, Plus, RotateCcw, Send, Share2, Smartphone, WalletCards } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { balances, dateLabel, newId, type Demo } from './model';
import { Empty, PageTitle } from './ui';

export function Itinerary({ data, update }: { data: Demo; update: (next: Demo) => void }) {
  const [adding, setAdding] = useState(false);
  const [day, setDay] = useState(data.trip.start);
  const days = [...new Set([data.trip.start, data.trip.end, ...data.plans.map(plan => plan.day)])].sort();
  const plans = data.plans.filter(plan => plan.day === day).sort((a, b) => a.time.localeCompare(b.time));
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const title = String(fields.get('title')).trim();
    if (!title) return;
    update({ ...data, plans: [...data.plans, { id: newId(), day, title, time: String(fields.get('time')), place: String(fields.get('place')).trim() }] });
    setAdding(false);
  }
  return <>
    <PageTitle title="Lịch trình" description={data.trip.name} back="#tong-quan">
      {!data.trip.closed && <button className="primary-button compact" onClick={() => setAdding(!adding)}>{adding ? 'Đóng' : <><Plus size={18} aria-hidden /> Thêm lịch</>}</button>}
    </PageTitle>
    <div className="filters itinerary-days" aria-label="Ngày trong lịch trình">
      {days.map(date => <button className="pill" key={date} aria-pressed={date === day} onClick={() => setDay(date)}><CalendarDays size={15} aria-hidden /> {dateLabel(date)}</button>)}
    </div>
    {adding && <form className="card field-card" onSubmit={save}>
      <label>Hoạt động<input name="title" autoFocus maxLength={80} required /></label>
      <div className="field-pair"><label>Giờ<input name="time" type="time" required /></label><label>Địa điểm<input name="place" maxLength={80} /></label></div>
      <button className="primary-button">Lưu vào ngày {dateLabel(day)}</button>
    </form>}
    <div className="timeline">
      {plans.map(plan => <article className="timeline-event" key={plan.id}>
        <time>{plan.time}</time><span className="timeline-dot" />
        <div className="card"><h2>{plan.title}</h2>{plan.place && <p><MapPin size={15} aria-hidden /> {plan.place}</p>}</div>
      </article>)}
      {!plans.length && <div className="card"><Empty>Chưa có hoạt động cho ngày này.</Empty></div>}
    </div>
  </>;
}

export function Invite({ data, preview }: { data: Demo; preview?: boolean }) {
  const [notice, setNotice] = useState('');
  const [link, setLink] = useState('');
  async function copyLink() {
    const url = new URL('#tham-gia', window.location.href);
    setLink(url.href);
    try {
      await navigator.clipboard.writeText(url.href);
      setNotice('Đã sao chép liên kết xem thử.');
    } catch {
      setNotice('Chọn liên kết bên dưới để sao chép.');
    }
  }
  return <div className="form-page detail-page">
    <PageTitle title={preview ? 'Lời mời tham gia' : 'Mời bạn vào chuyến đi'} back={preview ? '#loi-moi' : '#thanh-vien'} />
    <section className="card invite-card">
      <div className="trip-cover invite-cover"><span className="trip-status"><span />Bản xem thử</span></div>
      <div className="field-card">
        <h2>{data.trip.name}</h2>
        <p><MapPin size={16} aria-hidden /> {data.trip.place}</p>
        <p><CalendarDays size={16} aria-hidden /> {dateLabel(data.trip.start)} – {dateLabel(data.trip.end)}</p>
        {preview
          ? <a className="primary-button" href="#tong-quan"><WalletCards size={19} aria-hidden /> Mở chuyến đi mẫu</a>
          : <><button className="primary-button" onClick={copyLink}><Clipboard size={18} aria-hidden /> Sao chép liên kết xem thử</button>
            <a className="secondary-button" href="#tham-gia"><Send size={17} aria-hidden /> Xem trước lời mời</a></>}
        {link && <input aria-label="Liên kết xem thử" value={link} readOnly onFocus={event => event.currentTarget.select()} />}
        {notice && <p className="inline-note" role="status">{notice}</p>}
      </div>
    </section>
  </div>;
}

export function Settings({ data, update }: { data: Demo; update: (next: Demo) => void }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const settled = Object.values(balances(data)).every(total => total === 0) && data.settlements.every(item => item.confirmed);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get('name')).trim();
    const place = String(fields.get('place')).trim();
    const start = String(fields.get('start'));
    const end = String(fields.get('end'));
    if (!name || !place || start > end) {
      setError('Nhập tên và địa điểm. Ngày kết thúc cần từ ngày bắt đầu trở đi.');
      setMessage('');
      return;
    }
    update({ ...data, trip: { ...data.trip, name, place, start, end } });
    setMessage('Đã lưu thông tin chuyến đi.');
    setError('');
  }
  return <div className="form-page detail-page">
    <PageTitle title="Cài đặt chuyến đi" back="#tong-quan" />
    <form className="card field-card" onSubmit={save}>
      <h2>Thông tin chuyến đi</h2>
      <label>Tên chuyến đi<input name="name" defaultValue={data.trip.name} maxLength={60} required disabled={data.trip.closed} /></label>
      <label>Địa điểm<input name="place" defaultValue={data.trip.place} maxLength={60} required disabled={data.trip.closed} /></label>
      <div className="field-pair">
        <label>Ngày bắt đầu<input type="date" name="start" defaultValue={data.trip.start} required disabled={data.trip.closed} /></label>
        <label>Ngày kết thúc<input type="date" name="end" defaultValue={data.trip.end} required disabled={data.trip.closed} /></label>
      </div>
      {!data.trip.closed && <button className="primary-button"><Check size={18} aria-hidden /> Lưu thông tin</button>}
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="positive" role="status">{message}</p>}
    </form>
    <section className="card field-card">
      <h2>{data.trip.closed ? 'Chuyến đi đã chốt' : 'Chốt chuyến đi'}</h2>
      <p>{data.trip.closed ? 'Bạn có thể mở lại để tiếp tục ghi chi tiêu.' : settled ? 'Chốt chuyến sẽ khóa các thao tác chỉnh sửa.' : 'Hoàn tất các khoản chuyển tiền trước khi chốt.'}</p>
      {data.trip.closed
        ? <button className="secondary-button" onClick={() => update({ ...data, trip: { ...data.trip, closed: false } })}><RotateCcw size={17} aria-hidden /> Mở lại chuyến đi</button>
        : confirming && settled
          ? <div className="button-pair"><button className="secondary-button" onClick={() => setConfirming(false)}>Quay lại</button>
            <button className="primary-button" onClick={() => { update({ ...data, trip: { ...data.trip, closed: true } }); setConfirming(false); setMessage(''); }}>Xác nhận chốt</button></div>
          : settled
            ? <button className="secondary-button" onClick={() => setConfirming(true)}><LockKeyhole size={17} aria-hidden /> Chốt chuyến đi</button>
            : <a className="secondary-button" href="#so-du">Xem số dư</a>}
    </section>
    <section className="card field-card">
      <h2><Smartphone size={18} aria-hidden /> Cài ShareBill</h2>
      <p>Trong menu trình duyệt, chọn <strong>Cài đặt ứng dụng</strong>. Trên iPhone, mở trong Safari, nhấn <Share2 size={15} aria-hidden /> <strong>Chia sẻ</strong> rồi chọn <strong>Thêm vào MH chính</strong>.</p>
    </section>
  </div>;
}
