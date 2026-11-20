'use client';

import { Link2, Settings2, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { balances, canWrite, isOwner, nameOf, newId, ownerOf, record, viewerOf, type Demo, type Member } from './model';
import { Amount, Avatar, Dialog, Empty, PageTitle } from './ui';
import type { UpdateTrip } from './trip-command';
import { tripHref } from './workspace-route';
import type { ReactNode } from 'react';

export function Members({ data, update, accounts, view }: { data: Demo; update: UpdateTrip; accounts?: ReactNode; view?: string }) {
  const groupEqual = data.remote?.sharingMode === 'group-equal';
  const [filter, setFilter] = useState<'all' | 'linked'>(view === 'tai-khoan' ? 'linked' : 'all');
  const [editing, setEditing] = useState<Member | 'new' | null>(!groupEqual && view === 'them-nguoi' && isOwner(data) && canWrite(data) ? 'new' : null);
  const [confirm, setConfirm] = useState<'owner' | 'inactive' | 'unlink' | null>(null);
  const [error, setError] = useState('');
  const owner = isOwner(data);
  const canEdit = owner && canWrite(data);
  const members = filter === 'all' ? data.members : data.members.filter(member => member.linked && !member.inactive);
  const totals = balances(data);
  const selected = editing === 'new' ? null : editing;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get('name')).trim();
    if (!name) { setError('Nhập tên thành viên.'); return; }
    const member = selected
      ? { ...selected, name }
      : { id: newId(), name, tone: data.members.length, linked: false };
    update(record({ ...data, members: selected ? data.members.map(item => item.id === member.id ? member : item) : [...data.members, member] },
      selected ? 'Đổi tên thành viên' : 'Thêm người chia tiền', name, '#thanh-vien'),
      { type: 'save-member', member, previous: selected ?? undefined }, () => setEditing(null));
  }

  function apply(action: 'owner' | 'inactive' | 'unlink' | 'link' | 'activate') {
    if (!owner || !selected || selected.id === ownerOf(data)) return;
    const labels = { owner: 'Chuyển quyền chủ chuyến', inactive: 'Ngừng dùng thành viên', unlink: 'Gỡ tài khoản', link: 'Liên kết tài khoản', activate: 'Khôi phục thành viên' };
    const members = data.members.map(member => member.id !== selected.id ? member : {
      ...member, linked: action === 'unlink' ? false : action === 'link' ? true : member.linked,
      inactive: action === 'inactive' ? true : action === 'activate' ? false : member.inactive,
    });
    const next = record({ ...data, members }, labels[action], selected.name, '#thanh-vien');
    const member = members.find(item => item.id === selected.id)!;
    update(action === 'owner' ? { ...next, ownerId: selected.id } : next,
      action === 'inactive' || action === 'activate' ? { type: 'save-member', member, previous: selected } : undefined,
      () => { setConfirm(null); setEditing(null); });
  }

  function edit(member: Member | 'new') {
    setError('');
    setEditing(member);
  }

  return <>
    <PageTitle title="Thành viên & phân quyền" description={data.trip.name}>
      {canEdit && <a className="primary-button compact" href={tripHref(data, 'loi-moi')}><UserPlus size={18} aria-hidden /> Mời bạn</a>}
    </PageTitle>
    <section className="card field-card">
      <h2><ShieldCheck size={20} aria-hidden /> Quyền trong chuyến</h2>
      <p><strong>{data.remote && !data.ownerId ? 'Chủ chuyến' : nameOf(data, ownerOf(data))}</strong> quản lý thành viên, lời mời và chốt chuyến. Thành viên có tài khoản có thể ghi khoản chi.</p>
    </section>
    <div className="section-heading"><h2><Users size={20} aria-hidden /> Danh sách thành viên</h2>
      {canEdit && !groupEqual && <button className="secondary-button" onClick={() => edit('new')}><UserPlus size={17} aria-hidden /> Thêm người</button>}</div>
    {!groupEqual && <div className="segmented compact-segments" aria-label="Loại thành viên">
      <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Người chia tiền</button>
      <button aria-pressed={filter === 'linked'} onClick={() => setFilter('linked')}>Tài khoản truy cập</button>
    </div>}
    {!groupEqual && filter === 'all' && <p className="inline-note money-explainer">Người chia tiền là những người được chọn trong khoản chi, không cần có tài khoản. Thêm người mới giữ nguyên phần chia của khoản chi cũ; vào Chi tiêu → mở khoản chi → Sửa → Chia cho ai? để chọn thêm người.</p>}
    {data.remote && (groupEqual || filter === 'linked') ? accounts : <div className="card rows">
      {!members.length && <Empty>Chưa có tài khoản truy cập.</Empty>}
      {members.map(member => {
        const id = member.id;
        const net = totals[id];
        return <div className="list-row member-row" key={id}>
          <Avatar member={member} />
          <div className="row-text"><strong>{nameOf(data, id)}{id === viewerOf(data) ? ' (bạn)' : ''}</strong>
            <span>{member.inactive ? 'Ngừng sử dụng' : id === ownerOf(data) ? 'Chủ chuyến' : member.linked ? 'Đã liên kết tài khoản' : 'Chưa có tài khoản'}</span>
          </div>
          <span className="row-end member-money">{net === undefined ? 'Chưa đủ dữ liệu' : <>
            <small>{net < 0 ? 'Cần trả' : net > 0 ? 'Được nhận' : 'Đã cân bằng'}</small>
            <strong className={net > 0 ? 'positive' : net < 0 ? 'negative' : 'muted'}><Amount value={Math.abs(net)} /></strong>
          </>}</span>
          {(data.remote ? canEdit : owner) && <button className="icon-button member-settings" aria-label={'Quản lý ' + nameOf(data, id)} onClick={() => edit(member)}><Settings2 size={18} aria-hidden /></button>}
        </div>;
      })}
    </div>}
    {editing && !confirm && <Dialog title={selected ? 'Quản lý ' + nameOf(data, selected.id) : 'Thêm người chia tiền'} onClose={() => setEditing(null)}>
      {canEdit && <form className="field-card dialog-fields" onSubmit={save}>
        <label>Tên hiển thị<input name="name" defaultValue={selected?.name} maxLength={80} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary-button">{selected ? 'Lưu tên' : 'Thêm thành viên'}</button>
      </form>}
      {selected && selected.id !== ownerOf(data) && <div className="member-actions">
        {!data.remote && canEdit && !selected.inactive && !selected.linked && <button className="secondary-button" onClick={() => apply('link')}><Link2 size={17} aria-hidden /> Liên kết tài khoản mẫu</button>}
        {!data.remote && selected.linked && <button className="secondary-button" onClick={() => setConfirm('unlink')}>Gỡ tài khoản</button>}
        {canEdit && (selected.inactive
          ? <button className="secondary-button" onClick={() => apply('activate')}>Khôi phục thành viên</button>
          : <button className="secondary-button" onClick={() => setConfirm('inactive')}>Ngừng dùng để chia tiền</button>)}
        {!data.remote && canEdit && selected.linked && !selected.inactive && <button className="danger-button" onClick={() => setConfirm('owner')}>Chuyển quyền chủ chuyến</button>}
      </div>}
      {selected?.id === ownerOf(data) && !canEdit && <p>Chuyến đã chốt. Mở lại chuyến để sửa thông tin.</p>}
    </Dialog>}
    {confirm && selected && <Dialog title={confirm === 'owner' ? 'Chuyển quyền chủ chuyến?' : confirm === 'unlink' ? 'Gỡ tài khoản?' : 'Ngừng sử dụng thành viên?'} onClose={() => setConfirm(null)}>
      <p>{confirm === 'owner' ? selected.name + ' sẽ quản lý chuyến đi. Vai trò hiện tại của bạn sẽ chuyển thành thành viên.'
        : confirm === 'unlink' ? selected.name + ' sẽ mất quyền truy cập với tài khoản mẫu. Chi phí và số dư hiện tại được giữ lại.'
        : selected.name + ' sẽ không xuất hiện khi tạo khoản chi mới. Chi phí và số dư hiện tại được giữ lại.'}</p>
      <div className="button-pair"><button className="secondary-button" onClick={() => setConfirm(null)}>Quay lại</button><button className="danger-button" onClick={() => apply(confirm)}>Xác nhận</button></div>
    </Dialog>}
  </>;
}
