'use client';

import { CircleHelp, Link2, LogOut, Settings2, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { Session, ShareBillApi } from './api-client';
import type { InviteDto, InvitePreview, Membership } from './api-data';
import { useApiPage } from './api-queries';
import { canWrite, isOwner, memberFor, nameOf, type Demo } from './model';
import { InviteShare } from './invite-share';
import { Avatar, Dialog, Empty, PageTitle } from './ui';
import { tripHref } from './workspace-route';

export type RunMutation = <T>(operation: () => Promise<T>, onSaved?: (result: T) => void) => void;

const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' });

export function InviteManager({ data, tripId, api, epoch, run }: {
  data: Demo; tripId: string; api: ShareBillApi; epoch: number; run: RunMutation;
}) {
  const path = '/trips/' + tripId + '/invites';
  const owner = isOwner(data);
  const page = useApiPage<InviteDto>(api, owner ? path : undefined, { limit: '20' }, epoch);
  const [created, setCreated] = useState<InviteDto>();
  const [revoke, setRevoke] = useState<InviteDto>();
  const url = created?.token ? new URL('/#tham-gia/' + created.token, window.location.origin).href : '';
  const createdStatus = page.items.find(invite => invite.id === created?.id)?.status ?? created?.status;
  if (!owner) return <PageTitle title="Chỉ chủ chuyến có thể quản lý lời mời" back={tripHref(data, 'thanh-vien')} />;

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const body = { expiresInDays: Number(fields.get('days')), maxUses: Number(fields.get('limit')) };
    run(() => api.write<InviteDto>(path, body), setCreated);
  }

  const labels = { active: 'Còn hiệu lực', revoked: 'Đã thu hồi', invalidated: 'Mất hiệu lực', exhausted: 'Hết lượt', expired: 'Hết hạn' };
  return <div className="form-page">
    <PageTitle title="Mời bạn vào chuyến đi" description={data.trip.name} back={tripHref(data, 'thanh-vien')} />
    {canWrite(data) && <form className="card field-card" onSubmit={create}>
      <h2><Link2 size={20} aria-hidden /> Tạo liên kết mời</h2>
      <div className="field-pair">
        <label>Thời hạn<select name="days" defaultValue="7"><option value="1">1 ngày</option><option value="3">3 ngày</option><option value="7">7 ngày</option></select></label>
        <label>Số lượt tham gia<input type="number" name="limit" min="1" max="20" defaultValue="5" required /></label>
      </div>
      <button className="primary-button">Tạo liên kết</button>
    </form>}
    {created && <section className="card field-card">
      <h2>Liên kết vừa tạo</h2>
      {url && createdStatus === 'active' && canWrite(data) ? <InviteShare key={url} url={url} group={data.trip.name} expiresAt={created.expiresAt} />
        : <p role="status">{url ? 'Lời mời không còn hiệu lực. Hãy tạo liên kết mới để chia sẻ.' : created.message ?? 'Đường dẫn chỉ xuất hiện khi tạo. Hãy thu hồi lời mời này và tạo lời mời mới.'}</p>}
    </section>}
    <section className="card field-card">
      <h2>Quản lý liên kết</h2>
      {page.loading && <p role="status">Đang tải lời mời…</p>}
      {page.error && <p role="alert" className="error">{page.error}</p>}
      {page.notice && <p role="status">{page.notice}</p>}
      {!page.loading && !page.error && !page.items.length && <p>Chưa tạo lời mời nào.</p>}
      {page.items.map(invite => <div className="idea-row" key={invite.id}>
        <div><strong>{labels[invite.status]}</strong><p>{invite.usedCount}/{invite.maxUses} lượt · Hạn {dateTime.format(new Date(invite.expiresAt))}</p></div>
        {invite.status === 'active' && <button className="text-button" onClick={() => setRevoke(invite)}>Thu hồi</button>}
      </div>)}
      {page.more && <button className="secondary-button" disabled={page.loading} onClick={() => void page.more?.()}>Tải thêm lời mời</button>}
    </section>
    {revoke && <Dialog title="Thu hồi lời mời?" onClose={() => setRevoke(undefined)}>
      <p>Liên kết sẽ hết hiệu lực ngay. Những người đã tham gia vẫn giữ quyền truy cập.</p>
      <button className="danger-button" onClick={() => run(() => api.write(path + '/' + revoke.id + '/revoke', {}, { version: revoke.version }), () => {
        if (created?.id === revoke.id) setCreated(undefined);
        setRevoke(undefined);
      })}>Thu hồi liên kết</button>
    </Dialog>}
  </div>;
}

export function JoinPreview({ preview, onJoin }: { preview: InvitePreview; onJoin: () => void }) {
  return <div className="form-page">
    <PageTitle title="Lời mời tham gia" back="#chuyen-di" />
    <section className="card field-card">
      <span className="tile-icon"><UserPlus size={21} aria-hidden /></span><h2>{preview.trip.name}</h2>
      {preview.alreadyMember ? <p>Bạn đã là thành viên của chuyến đi này.</p> : <>
        <p>{preview.inviter.displayName ?? 'Chủ chuyến'} đã mời bạn tham gia chuyến đi.</p>
        {preview.trip.sharingMode !== 'per-expense' && <p className="inline-note">Vào nhóm là tự chia đều tổng chi, gồm cả các khoản đã có trước khi bạn tham gia. Tiền bạn ứng sẽ được trừ khi tính số cần trả.</p>}
        <p>Hết hạn {dateTime.format(new Date(preview.expiresAt))}</p>
      </>}
      <button className="primary-button" onClick={onJoin}>{preview.alreadyMember ? 'Mở chuyến đi' : 'Tham gia chuyến đi'}</button>
    </section>
  </div>;
}

type AccountAction = 'link' | 'remove' | 'restore' | 'transfer';
const actionTitle = {
  link: 'Liên kết người chia tiền', remove: 'Gỡ quyền truy cập', restore: 'Khôi phục quyền truy cập', transfer: 'Chuyển quyền chủ chuyến',
};

export function MemberAccounts({ data, accounts, tripId, api, run }: {
  data: Demo; accounts: Membership[]; tripId: string; api: ShareBillApi; run: RunMutation;
}) {
  const [chosen, setChosen] = useState<Membership & { tripVersion?: number }>();
  const [action, setAction] = useState<AccountAction>();
  const [error, setError] = useState('');
  const writable = canWrite(data);
  const owner = isOwner(data);
  const version = data.remote?.version;
  const root = '/trips/' + tripId;
  const ownUid = data.remote?.actorUid;
  const label = (account: Membership) => account.displayName || (account.participantId && nameOf(data, account.participantId)) || 'Tài khoản thành viên';
  const close = () => { setChosen(undefined); setAction(undefined); setError(''); };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen || !action) return;
    const fields = new FormData(event.currentTarget);
    const reason = String(fields.get('reason')).trim();
    if (!reason) { setError('Nhập lý do để lưu vào lịch sử.'); return; }
    const memberPath = root + '/memberships/' + encodeURIComponent(chosen.uid);
    run(() => action === 'transfer' ? api.write(root + '/transfer-owner', { uid: chosen.uid, reason }, { version: chosen.tripVersion }) :
      api.write(memberPath + '/' + action, action === 'link' ? { reason, participantId: String(fields.get('participant') ?? '') || null } : { reason },
        { version: chosen.version }), close);
  }

  return <>
    <div className="card rows">
      {!accounts.length && <Empty>Chưa có tài khoản trong chuyến.</Empty>}
      {accounts.map(account => <div className="list-row member-row" key={account.uid}>
        <Avatar member={account.participantId ? memberFor(data, account.participantId) : { id: account.uid, tone: 1, name: label(account) }} />
        <div className="row-text"><strong>{label(account)}{ownUid === account.uid && ' (bạn)'}</strong>
          <span>{account.status === 'removed' ? 'Đã gỡ quyền' : account.role === 'owner' ? 'Chủ chuyến' : 'Thành viên'} · {data.remote?.sharingMode === 'group-equal' ? data.trip.closed ? 'Giữ phần chia lúc chốt' : account.status === 'active' ? 'Tự chia đều tổng chi' : 'Không còn tính vào số người chia' : account.participantId ? 'Chia tiền với tên ' + nameOf(data, account.participantId) : 'Chưa liên kết người chia tiền'}</span>
        </div>
        {owner && account.role !== 'owner' && <button className="icon-button member-settings" aria-label={'Quản lý tài khoản ' + label(account)} onClick={() => setChosen({ ...account, tripVersion: version })}><Settings2 size={18} aria-hidden /></button>}
      </div>)}
    </div>
    {chosen && !action && <Dialog title={'Quản lý ' + label(chosen)} onClose={close}>
      <div className="member-actions">
        {data.remote?.sharingMode !== 'group-equal' && writable && (chosen.status === 'active' || chosen.participantId) && <button className="secondary-button" onClick={() => setAction('link')}>{actionTitle.link}</button>}
        {writable && chosen.status === 'active' && chosen.participantId && !memberFor(data, chosen.participantId)?.inactive &&
          <button className="secondary-button" onClick={() => setAction('transfer')}>{actionTitle.transfer}</button>}
        {chosen.status === 'active' ? <button className="danger-button" onClick={() => setAction('remove')}>{actionTitle.remove}</button>
          : writable ? <button className="secondary-button" onClick={() => setAction('restore')}>{actionTitle.restore}</button> : <p>Mở lại chuyến để khôi phục quyền truy cập.</p>}
      </div>
    </Dialog>}
    {chosen && action && <Dialog title={actionTitle[action]} onClose={close} key={action}>
      <form className="field-card dialog-fields" onSubmit={submit}>
        <p>{label(chosen)}</p>
        {action === 'link' && <label>Người chia tiền<select name="participant" aria-label="Người chia tiền" defaultValue={chosen.participantId ?? ''}>
          <option value="">Bỏ liên kết</option>
          {chosen.status === 'active' && data.members.filter(member => !member.inactive && (!member.linked || member.id === chosen.participantId))
            .map(member => <option key={member.id} value={member.id}>{nameOf(data, member.id)}</option>)}
        </select></label>}
        {action === 'remove' && <p>{data.remote?.sharingMode === 'group-equal' ? data.trip.closed
          ? 'Tài khoản sẽ mất quyền mở chuyến. Phần chia và số dư lúc chốt được giữ nguyên; mở lại chuyến sẽ chia lại cho các tài khoản còn trong nhóm.'
          : 'Tài khoản sẽ mất quyền mở chuyến và không còn chịu phần tổng chi. Tổng chi sẽ chia lại cho những người còn trong nhóm. Tiền đã ứng, đã chuyển và đã nhận vẫn được giữ, nên công nợ có thể thay đổi.'
          : 'Tài khoản sẽ mất quyền mở chuyến. Khoản chi và số dư đã ghi vẫn được giữ.'}</p>}
        {action === 'restore' && data.remote?.sharingMode === 'group-equal' && <p>Tài khoản sẽ vào lại nhóm và cùng chia toàn bộ tổng chi, kể cả chi phí trước đó. Tiền đã ứng và các khoản chuyển đã xác nhận vẫn được giữ; công nợ sẽ được tính lại.</p>}
        {action === 'transfer' && <p>Thành viên này sẽ quản lý chuyến đi. Bạn sẽ chuyển thành thành viên.</p>}
        <label>Lý do<input name="reason" required maxLength={300} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className={action === 'remove' || action === 'transfer' ? 'danger-button' : 'primary-button'}>Xác nhận</button>
      </form>
    </Dialog>}
  </>;
}

export function LiveAccount({ session, signOut, trusted, onTrust }: {
  session: Session; signOut: () => void; trusted: boolean; onTrust: (trusted: boolean) => void;
}) {
  return <div className="form-page">
    <PageTitle title="Tài khoản" back="#chuyen-di" />
    <section className="card field-card">
      <h2>{session.user.displayName}</h2><p>{session.user.email}</p>
      <a className="secondary-button" href="#tro-giup"><CircleHelp size={18} aria-hidden /> Trợ giúp và báo lỗi</a>
      <button className="secondary-button" onClick={signOut}><LogOut size={18} aria-hidden /> Đăng xuất</button>
    </section>
    <section className="card field-card">
      <h2>Dữ liệu ngoại tuyến</h2>
      <p>Lưu bản nháp thêm khoản chi và số dư chuyến trên trình duyệt này trong 24 giờ. Tắt khi dùng thiết bị chung.</p>
      <label><input type="checkbox" checked={trusted} onChange={event => onTrust(event.target.checked)} /> Tin cậy thiết bị này</label>
      {trusted && <button className="secondary-button" onClick={() => onTrust(false)}>Tắt và xóa dữ liệu ngoại tuyến</button>}
    </section>
  </div>;
}
