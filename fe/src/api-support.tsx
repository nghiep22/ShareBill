'use client';

import { ChevronRight, CircleHelp, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { ShareBillApi } from './api-client';
import { useApiPage, useApiRead } from './api-queries';
import type { RunMutation } from './api-trip-screens';
import { Empty, PageTitle } from './ui';
import { tripRoute } from './workspace-route';

const categories = {
  usability: 'Thao tác khó hiểu',
  balance: 'Số dư cần kiểm tra',
  receipt: 'Lỗi tải ảnh',
  account: 'Lỗi tài khoản hoặc đăng nhập',
  other: 'Khác',
};
const statuses = { open: 'Mới gửi', in_progress: 'Đang xử lý', resolved: 'Đã xử lý' };
const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' });
const path = '/support-tickets';

type Ticket = {
  id: string; tripId: string | null; category: keyof typeof categories; status: keyof typeof statuses;
  createdAt: string; updatedAt: string;
};

function TicketStatus({ status }: { status: Ticket['status'] }) {
  const color = status === 'resolved' ? 'mint' : status === 'in_progress' ? 'warm' : '';
  return <span className={'tag ' + color}>{statuses[status]}</span>;
}

export function HelpDesk({ api, epoch, segment, contextTrip, loadingContext, run, onReload, busy }: {
  api: ShareBillApi; epoch: number; segment?: string; contextTrip?: { id: string; name: string }; loadingContext?: boolean;
  run: RunMutation; onReload: () => void; busy: boolean;
}) {
  const detailId = segment && segment !== 'chuyen' ? segment : undefined;
  const list = useApiPage<Ticket>(api, detailId ? undefined : path, { limit: '25' }, epoch);
  const detail = useApiRead<Ticket & { message: string }>(api, detailId ? path + '/' + encodeURIComponent(detailId) : undefined, epoch);
  const [lastSent, setLastSent] = useState('');
  const [formError, setFormError] = useState('');
  const error = detail.error ?? list.error;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const message = String(values.get('message')).trim();
    if (message.length < 10) { setFormError('Nhập mô tả từ 10 đến 2.000 ký tự.'); return; }
    setFormError('');
    run(() => api.write<Ticket>(path, {
      message, category: values.get('category'), tripId: values.has('includeTrip') ? contextTrip?.id ?? null : null,
    }), ticket => {
      form.reset();
      setLastSent(ticket.id);
      window.location.hash = 'tro-giup/' + ticket.id;
    });
  }

  return <div className="form-page">
    <PageTitle title={detailId ? 'Chi tiết báo lỗi' : 'Trợ giúp'}
      back={detailId ? '#tro-giup' : segment === 'chuyen' && contextTrip ? '#' + tripRoute(contextTrip.id, 'cai-dat') : '#tai-khoan'} />
    {error && <div className="inline-note error workspace-notice" role="alert">
      <span>{error}</span><button className="text-button" onClick={onReload}>Tải lại</button>
    </div>}
    {detailId ? <>
      {detail.loading && <p role="status">Đang tải báo cáo…</p>}
      {detail.data && <section className="card field-card">
        {lastSent === detailId && <p className="positive" role="status">Đã gửi báo lỗi.</p>}
        <div className="section-heading"><h2>{categories[detail.data.category]}</h2><TicketStatus status={detail.data.status} /></div>
        <dl className="support-meta">
          <div><dt>Mã báo lỗi</dt><dd><code>{detail.data.id}</code></dd></div>
          <div><dt>Gửi lúc</dt><dd><time dateTime={detail.data.createdAt}>{dateTime.format(new Date(detail.data.createdAt))}</time></dd></div>
          {detail.data.updatedAt !== detail.data.createdAt && <div><dt>Cập nhật lúc</dt><dd><time dateTime={detail.data.updatedAt}>{dateTime.format(new Date(detail.data.updatedAt))}</time></dd></div>}
        </dl>
        <p className="support-message">{detail.data.message}</p>
      </section>}
    </> : <>
      <form className="card field-card" onSubmit={submit} onChange={() => { if (formError) setFormError(''); }}>
        <h2><CircleHelp size={20} aria-hidden /> Gửi báo lỗi</h2>
        <label>Loại lỗi<select name="category" aria-label="Loại lỗi" defaultValue="" required>
          <option value="" disabled>Chọn loại lỗi</option>
          {Object.entries(categories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
        <label>Mô tả<textarea name="message" placeholder="Ví dụ: Tôi không mở được ảnh hóa đơn sau khi lưu." minLength={10} maxLength={2000} rows={4} required /></label>
        <p>Chỉ mô tả lỗi. Bỏ qua mật khẩu và thông tin ngân hàng.</p>
        {loadingContext && <p role="status">Đang lấy thông tin chuyến đi…</p>}
        {segment === 'chuyen' && !loadingContext && !contextTrip && <p>Thông tin chuyến đi chưa sẵn sàng. Bạn vẫn có thể gửi báo lỗi chung.</p>}
        {contextTrip && <label className="support-context"><input type="checkbox" name="includeTrip" defaultChecked /> Kèm chuyến {contextTrip.name}</label>}
        {formError && <p className="error" role="alert">{formError}</p>}
        <button className="primary-button" disabled={busy || loadingContext}><Send size={17} aria-hidden /> Gửi báo lỗi</button>
      </form>
      <section className="card field-card">
        <h2>Báo lỗi của tôi</h2>
        {list.loading && <p role="status">Đang tải danh sách…</p>}
        {!list.loading && !list.error && !list.items.length && <Empty>Bạn chưa gửi báo lỗi nào.</Empty>}
        {list.items.map(ticket => <a key={ticket.id} className="support-row" href={'#tro-giup/' + ticket.id}>
          <span><strong>{categories[ticket.category]}</strong><time dateTime={ticket.createdAt}>{dateTime.format(new Date(ticket.createdAt))}</time></span>
          <TicketStatus status={ticket.status} /><ChevronRight size={16} aria-hidden />
        </a>)}
        {list.more && <button className="secondary-button" disabled={list.loading} onClick={() => void list.more?.()}>Tải thêm báo lỗi</button>}
      </section>
    </>}
  </div>;
}
