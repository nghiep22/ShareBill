'use client';

import {
  ArrowDownLeft, ArrowDownUp, ArrowRight, ArrowUpRight, CalendarDays, ChevronRight,
  CircleCheck, History, MapPin, Plus, ReceiptText, Search, Settings2, UserPlus, Wallet,
} from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import {
  activeExpenses, balances, canWrite, categories, dateLabel, dateRange, isOwner, memberFor, money, nameOf, netLabel,
  newId, record, settlementStatus, sharingMembers, suggestions, today, viewerOf, type Demo, type Expense, type Receipt, type Settlement, type Transfer,
} from './model';
import { Amount, Avatar, CategoryIcon, Dialog, Empty, PageTitle } from './ui';
import type { ReceiptActions, UpdateTrip } from './trip-command';
import { PaymentImage, PaymentImagePicker, PaymentQrCard } from './payments';
import { TransferQr } from './transfer-qr';
import { ShareRepaymentQrs } from './share-repayments';
import { tripHref } from './workspace-route';
import { financialSnapshot, transferLimit } from './finance-view';
import { maximumMoney, parsePositiveMoney } from './money-input';

const sortExpenses = (a: Expense, b: Expense) => b.date.localeCompare(a.date);

function ExpenseRow({ expense, data }: { expense: Expense; data: Demo }) {
  const me = viewerOf(data);
  const share = expense.shares[me] ?? 0;
  return <a className={'list-row expense-row' + (expense.voided ? ' voided' : '')} href={tripHref(data, 'khoan-chi', expense.id)}>
    <CategoryIcon category={expense.category} />
    <div className="row-text"><strong>{expense.title}</strong>
      <span>{expense.voided ? 'Đã hủy' : nameOf(data, expense.payer) + ' đã trả'} <span aria-hidden>·</span> {categories[expense.category]}</span>
    </div>
    <div className="row-end expense-money"><strong><Amount value={expense.amount} /></strong>
      {!expense.voided && me && <small>{data.remote?.sharingMode === 'group-equal' ? 'Chi chung của nhóm' : <>Phần của bạn: <Amount value={share} /></>}</small>}
    </div>
    <ChevronRight className="row-chevron" size={16} aria-hidden />
  </a>;
}

function TransferRow({ data, transfer }: { data: Demo; transfer: Transfer }) {
  return <>
    <Avatar member={memberFor(data, transfer.from)} />
    <div className="row-text"><strong className="transfer-names">{nameOf(data, transfer.from)} <ArrowRight size={13} aria-label="chuyển cho" /> {nameOf(data, transfer.to)}</strong></div>
    <strong className="row-end"><Amount value={transfer.amount} /></strong>
  </>;
}

export function Overview({ data, loadingExpenses, loadingTransfers }: { data: Demo; loadingExpenses?: boolean; loadingTransfers?: boolean }) {
  const { trip } = data;
  const members = sharingMembers(data);
  const expenses = activeExpenses(data).sort(sortExpenses);
  const me = viewerOf(data);
  const finance = financialSnapshot(data);
  const personal = finance.lines[me];
  const net = personal?.netMinor ?? 0;
  const transfers = suggestions(data);
  const pending = data.remote?.pendingCount ?? data.settlements.filter(item => settlementStatus(item) === 'pending').length;
  return <>
    <PageTitle title="Tổng quan">
      {canWrite(data) && <a className="primary-button compact overview-add" href={tripHref(data, 'them-khoan-chi')} aria-label="Thêm khoản chi"><Plus size={20} aria-hidden /> <span>Thêm khoản chi</span></a>}
    </PageTitle>
    <section className="trip-card overview-cover" aria-label="Thông tin chuyến đi">
      <div className={'trip-cover' + (trip.cover ? '' : ' cover-plain')}>
        <div className="trip-cover-top">
          <a className="icon-button cover-settings" href={tripHref(data, 'cai-dat')} aria-label="Cài đặt chuyến đi"><Settings2 size={20} aria-hidden /></a>
        </div>
        <div className="trip-cover-text">
          {trip.place && <p><MapPin size={15} aria-hidden /> {trip.place}</p>}
          <h2>{trip.name}</h2>
          <div className="trip-dates"><CalendarDays size={16} aria-hidden /> {dateRange(trip)}
            <span className="trip-status">{data.remote?.suspended ? 'Tạm khóa' : trip.closed ? 'Đã chốt chuyến' : 'Đang mở'}</span>
          </div>
        </div>
      </div>
      <div className="trip-members">
        <a href={tripHref(data, 'thanh-vien')} className="member-preview">
          <span className="avatar-stack">{members.slice(0, 3).map(member => <Avatar key={member.id} member={member} />)}</span>
          <strong>{members.length} thành viên</strong>
        </a>
        <div className="trip-quick-links">
          {canWrite(data) && isOwner(data) && <a className="soft-button invite-shortcut" href={tripHref(data, 'loi-moi')}><UserPlus size={17} aria-hidden /> Mời bạn</a>}
          <a className="secondary-button" href={tripHref(data, 'lich-trinh')}><CalendarDays size={17} aria-hidden /> Lịch trình</a>
        </div>
      </div>
    </section>
    {trip.note && <p className="inline-note trip-note">{trip.note}</p>}
    <div className="summary-grid overview-summary" aria-label="Tóm tắt chi tiêu">
      <a className="summary-card summary-total" href={tripHref(data, 'chi-tieu')}>
        <span className="summary-top"><span className="tile-icon summary-icon"><Wallet size={18} aria-hidden /></span><ArrowUpRight size={17} aria-hidden /></span>
        <span className="summary-label">Tổng chi tiêu</span>
        <strong>{finance.complete ? <Amount value={data.remote!.total} /> : 'Chưa đủ dữ liệu'}</strong>
      </a>
      <a className="summary-card" href={tripHref(data, 'chi-tieu')}>
        <span className="summary-top"><span className="tile-icon summary-icon"><ReceiptText size={18} aria-hidden /></span><ArrowUpRight size={17} aria-hidden /></span>
        <span className="summary-label">Phần chi của bạn</span>
        <strong>{!me ? 'Chưa liên kết' : personal ? <Amount value={personal.owedMinor} /> : 'Chưa đủ dữ liệu'}</strong>
      </a>
      <a className={'summary-card personal' + (net < 0 ? ' negative-card' : '')} href={tripHref(data, 'so-du')}>
        <span className="summary-top"><span className="tile-icon summary-icon"><ArrowDownLeft size={19} aria-hidden /></span><ArrowUpRight size={17} aria-hidden /></span>
        <span className="summary-label">{personal ? netLabel(net) : 'Số dư của bạn'}</span>
        <strong>{!me ? 'Chưa liên kết' : personal ? <Amount value={Math.abs(net)} /> : 'Chưa đủ dữ liệu'}</strong>
      </a>
    </div>
    <div className="overview-sections">
      <section className="card overview-section" aria-labelledby="recent-title">
        <div className="section-heading"><h2 id="recent-title">Chi tiêu gần đây</h2><a className="text-button" href={tripHref(data, 'chi-tieu')}>Xem tất cả <ChevronRight size={16} aria-hidden /></a></div>
        <div className="rows">{loadingExpenses && !expenses.length ? <Empty>Đang tải chi tiêu…</Empty> : expenses.length
          ? expenses.slice(0, 3).map(expense => <ExpenseRow key={expense.id} expense={expense} data={data} />)
          : <Empty>Chuyến đi chưa có khoản chi nào.</Empty>}
        </div>
      </section>
      <section className="card overview-section" aria-labelledby="suggest-title">
        <div className="section-heading"><h2 id="suggest-title">Gợi ý quyết toán</h2><a className="text-button" href={tripHref(data, 'so-du')}>Xem số dư <ChevronRight size={16} aria-hidden /></a></div>
        <div className="rows">{loadingTransfers ? <Empty>Đang tải gợi ý…</Empty> : transfers.length
          ? transfers.slice(0, 3).map(transfer => <div key={transfer.from + '-' + transfer.to} className="list-row"><TransferRow data={data} transfer={transfer} /></div>)
          : <Empty>{finance.balanced ? 'Các thành viên đã cân bằng.' : pending ? 'Có khoản chuyển đang chờ xác nhận.' : 'Chưa có gợi ý đầy đủ. Mở Số dư để kiểm tra và ghi khoản chuyển.'}</Empty>}
        </div>
      </section>
    </div>
  </>;
}

const normalize = (value: string) => value.toLocaleLowerCase('vi').normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');

export type ExpenseFilters = { status: string; category: string; payer: string };

export function Expenses({ data, filters, onFilter, onMore, loading }: {
  data: Demo; filters?: ExpenseFilters; onFilter?: (filters: ExpenseFilters) => void; onMore?: () => void; loading?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [localFilters, setLocalFilters] = useState<ExpenseFilters>({ status: 'all', category: '', payer: '' });
  const { status, category, payer } = filters ?? localFilters;
  const [limit, setLimit] = useState(30);
  function changeFilters(next: ExpenseFilters) {
    setLimit(30);
    (onFilter ?? setLocalFilters)(next);
  }
  const visible = onFilter ? data.expenses : data.expenses.filter(expense =>
    (status === 'all' || (status === 'voided' ? expense.voided : !expense.voided)) &&
    (!category || expense.category === category) && (!payer || expense.payer === payer) &&
    normalize(expense.title + ' ' + expense.note + ' ' + nameOf(data, expense.payer)).includes(normalize(query.trim()))
  ).sort(sortExpenses);
  const page = onFilter ? visible : visible.slice(0, limit);
  const dates = [...new Set(page.map(expense => expense.date))];
  return <>
    <PageTitle title="Chi tiêu" description={(data.remote?.expenseCount ?? activeExpenses(data).length) + ' khoản chi trong chuyến đi'}>
      {canWrite(data) && <a className="primary-button compact" aria-label="Thêm khoản chi" href={tripHref(data, 'them-khoan-chi')}><Plus size={20} aria-hidden /><span>Thêm khoản chi</span></a>}
    </PageTitle>
    <section className="card field-card expense-filters" aria-label="Tìm và lọc khoản chi">
      {!onFilter && <label className="search expense-search"><Search size={19} aria-hidden /><input type="search" placeholder="Tìm khoản chi hoặc người trả" value={query} onChange={e => { setQuery(e.target.value); setLimit(30); }} aria-label="Tìm khoản chi hoặc người trả" /></label>}
      <div className="field-pair">
        <label>Danh mục<select aria-label="Danh mục" value={category} onChange={event => {
          const next = event.target.value;
          changeFilters({ category: next, payer: onFilter ? '' : payer, status: onFilter && next && status === 'all' ? 'active' : status });
        }}><option value="">Tất cả</option>
          {Object.entries(categories).filter(([id]) => !onFilter || id !== 'fun').map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>Người trả<select aria-label="Người trả" value={payer} onChange={event => {
          const next = event.target.value;
          changeFilters({ category: onFilter ? '' : category, payer: next, status: onFilter && next && status === 'all' ? 'active' : status });
        }}><option value="">Tất cả</option>
          {data.members.map(member => <option value={member.id} key={member.id}>{nameOf(data, member.id)}</option>)}</select></label>
      </div>
      <div className="filters" aria-label="Trạng thái khoản chi">
        {[['all', 'Tất cả'], ['active', 'Có hiệu lực'], ['voided', 'Đã hủy']].map(([id, label]) =>
          <button key={id} className="pill" aria-pressed={status === id} onClick={() => {
            changeFilters({ status: id, category: onFilter && id === 'all' ? '' : category, payer: onFilter && id === 'all' ? '' : payer });
          }}>{label}</button>)}
      </div>
    </section>
    {dates.map(date => {
      const group = page.filter(expense => expense.date === date);
      const total = visible.filter(expense => expense.date === date && !expense.voided).reduce((sum, expense) => sum + expense.amount, 0);
      return <section className="expense-group" key={date}>
        <div className="section-heading"><h2><CalendarDays size={17} aria-hidden /> {dateLabel(date)}</h2>{!onFilter && <span className="tag">{money(total)}</span>}</div>
        <div className="card rows">{group.map(expense => <ExpenseRow key={expense.id} expense={expense} data={data} />)}</div>
      </section>;
    })}
    {loading && <p role="status">Đang tải khoản chi…</p>}
    {!dates.length && !loading && <div className="card empty-stack"><ReceiptText size={26} aria-hidden /><Empty>{data.remote?.expenseCount || data.expenses.length ? 'Chưa có khoản chi phù hợp.' : 'Chuyến đi chưa có khoản chi nào.'}</Empty></div>}
    {(onMore || (!onFilter && visible.length > limit)) && <button className="secondary-button" disabled={loading} onClick={onMore ?? (() => setLimit(limit + 30))}>Tải thêm khoản chi</button>}
  </>;
}

export function Balances({ data, update, loading, disabled, receiptActions }: { data: Demo; update: UpdateTrip; loading?: boolean; disabled?: boolean; receiptActions?: ReceiptActions }) {
  const formId = useId();
  const [proof, setProof] = useState<Receipt>();
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<{ transfer?: Transfer; ledgerVersion?: number }>();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const finance = financialSnapshot(data);
  const totals = finance.net;
  const transfers = suggestions(data);
  const transfersReady = !data.remote || data.remote.suggestionsReady === true;
  const pendingTransfers = data.remote?.pendingTransfers ?? data.settlements.filter(item => settlementStatus(item) === 'pending');
  const isPending = (item: Transfer) => pendingTransfers.some(pending => pending.from === item.from && pending.to === item.to);
  const me = viewerOf(data);
  const net = totals[me] ?? 0;
  const complete = finance.complete;
  const hasPersonal = complete && Object.hasOwn(totals, me);
  const pending = data.remote?.pendingCount ?? data.settlements.filter(item => settlementStatus(item) === 'pending').length;
  const allSettled = finance.balanced;
  const groupEqual = data.remote?.sharingMode === 'group-equal';
  const group = sharingMembers(data);
  const visibleMembers = data.members.filter(member => !groupEqual || group.some(person => person.id === member.id) ||
    finance.lines[member.id] && [finance.lines[member.id].paidMinor, finance.lines[member.id].sentMinor, finance.lines[member.id].receivedMinor].some(value => value > 0));
  const singleParticipant = complete && (groupEqual ? group.length : data.members.length) === 1 && data.remote!.total > 0;
  const withoutCosts = new Set(!groupEqual && complete && data.remote!.total > 0 ? data.members.filter(member => {
    const row = finance.lines[member.id];
    return !member.inactive && [row.owedMinor, row.paidMinor, row.sentMinor, row.receivedMinor].every(value => value === 0);
  }).map(member => member.id) : []);
  const noPersonalCost = hasPersonal && withoutCosts.has(me);
  const withoutCostNames = [...withoutCosts].slice(0, 3).map(id => nameOf(data, id)).join(', ') +
    (withoutCosts.size > 3 ? ' và ' + (withoutCosts.size - 3) + ' người khác' : '');
  const emptyTransferTitle = singleParticipant ? 'Chưa có khoản cần chuyển giữa các thành viên' : !allSettled ? 'Chưa có gợi ý chuyển tiền' :
    withoutCosts.size > 0 ? 'Chưa có khoản cần chuyển theo phần chia đã lưu' : 'Mọi người đã cân bằng.';
  const debtors = data.members.filter(member => totals[member.id] < 0 && (isOwner(data) || member.id === me));
  const creditors = data.members.filter(member => totals[member.id] > 0);
  const cap = transferLimit(totals[from] ?? 0, totals[to] ?? 0);
  const transfer = selected?.transfer ?? (cap > 0 ? { from, to, amount: cap } : undefined);
  const ownPayment = Boolean(data.remote && transfer?.from === me);
  const matchingPending = transfer ? pendingTransfers.filter(item => item.from === transfer.from && item.to === transfer.to) : [];
  const alreadyRecorded = matchingPending.length > 0;
  const pendingHref = tripHref(data, 'quyet-toan') + '?status=pending';
  const stale = selected?.ledgerVersion !== undefined && selected.ledgerVersion !== data.remote?.ledgerVersion;

  function open(transfer?: Transfer) {
    if (!transfersReady || disabled || transfer && isPending(transfer)) return;
    setSelected({ transfer: transfer && { ...transfer, amount: Math.min(transfer.amount, maximumMoney) }, ledgerVersion: data.remote?.ledgerVersion });
    setFrom(debtors[0]?.id ?? '');
    setTo(creditors[0]?.id ?? '');
    setError('');
    setProof(undefined);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !transfer || stale || !complete || disabled || uploading || alreadyRecorded || !transfersReady) return;
    if (ownPayment && !proof) { setError('Thêm ảnh chuyển khoản trước khi báo đã chuyển.'); return; }
    const amount = parsePositiveMoney(String(new FormData(event.currentTarget).get('amount') ?? ''));
    if (amount === undefined || amount > transfer.amount) { setError('Nhập số nguyên VND từ 1đ đến ' + money(transfer.amount) + ', ví dụ 10.000.'); return; }
    const entry: Settlement = { ...transfer, amount, id: newId(), confirmed: false, date: today(data.trip.timezone), recordedBy: me, receipts: proof ? [proof] : [] };
    update(record({ ...data, settlements: [entry, ...data.settlements] }, 'Ghi nhận chuyển tiền', nameOf(data, entry.from) + ' → ' + nameOf(data, entry.to) + ' · ' + money(amount), '#quyet-toan'),
      { type: 'record-settlement', transfer: entry, receipts: entry.receipts, ledgerVersion: selected.ledgerVersion }, () => { setSelected(undefined); setProof(undefined); window.location.hash = tripHref(data, 'quyet-toan'); });
  }
  return <>
    <PageTitle title="Số dư & quyết toán">
      <a className="secondary-button compact" href={tripHref(data, 'quyet-toan')}><History size={18} aria-hidden /> Lịch sử</a>
    </PageTitle>
    <div className={'summary-card balance-hero personal' + (net < 0 ? ' negative-card' : '')}>
      <span className="tile-icon summary-icon"><Wallet size={21} aria-hidden /></span>
      <span className="summary-label">{noPersonalCost ? 'Bạn chưa có chi phí phải chịu' : hasPersonal ? netLabel(net) : 'Số dư của bạn'}</span>
      <strong>{hasPersonal ? <Amount value={Math.abs(net)} /> : me ? 'Chưa đủ dữ liệu' : 'Chưa liên kết'}</strong>
      {noPersonalCost && <>
        <a className="text-button" href={tripHref(data, 'chi-tieu')}>Xem khoản chi để chia lại <ChevronRight size={15} aria-hidden /></a>
      </>}
      {!me && <>
        <p className="balance-link-help">Tài khoản chưa liên kết với người chia tiền.</p>
        <a className="text-button" href={tripHref(data, 'thanh-vien', 'tai-khoan')}>Xem tài khoản trong chuyến <ChevronRight size={15} aria-hidden /></a>
      </>}
      {pending > 0 && <a className="text-button" href={tripHref(data, 'quyet-toan')}>{pending} khoản đang chờ xác nhận <ChevronRight size={15} aria-hidden /></a>}
    </div>
    <section aria-label="Số tiền cần chuyển">
      <div className="section-heading"><h2>Số tiền cần chuyển</h2>
        {complete && canWrite(data) && debtors.length > 0 && creditors.length > 0 &&
          <button className="secondary-button compact" disabled={disabled || !transfersReady} onClick={() => open()}>Chuyển trả</button>}
      </div>
      {loading && <p role="status">Đang tải gợi ý chuyển tiền…</p>}
      {!loading && !transfers.length && <div className="card field-card transfer-empty">
        <h3>{allSettled && !withoutCosts.size ? <CircleCheck size={23} aria-hidden /> : <Wallet size={23} aria-hidden />}{emptyTransferTitle}</h3>
        {allSettled && !singleParticipant && withoutCosts.size > 0 && <p><b>Chưa có chi phí phải chịu:</b> {withoutCostNames}.</p>}
        {singleParticipant ? <>
          <p>Hiện chuyến chỉ có 1 người chia tiền là <b>{nameOf(data, (groupEqual ? group : data.members)[0].id)}</b>. Toàn bộ <Amount value={data.remote!.total} /> được tính cho người này nên số cần chuyển là <Amount value={0} />.</p>
        </> : allSettled && data.remote!.total > 0 ?
          <p>Không còn khoản cần chuyển theo phần chia đã lưu.</p> :
          <p>{!complete ? 'Chưa đủ dữ liệu số dư.' : pending ? 'Có khoản chuyển đang chờ xác nhận.' : allSettled ? 'Chuyến chưa có khoản chi.' : 'Chưa có gợi ý chuyển tiền.'}</p>}
        {complete && !data.trip.closed && <div className="money-actions">
          {singleParticipant && isOwner(data) && canWrite(data) && <a className="primary-button compact" href={tripHref(data, groupEqual ? 'loi-moi' : 'thanh-vien', groupEqual ? undefined : 'them-nguoi')}>{groupEqual ? 'Mời bạn vào nhóm' : 'Thêm người chia tiền'}</a>}
          {data.remote!.total > 0 && <a className="secondary-button compact" href={tripHref(data, 'chi-tieu')}>{groupEqual ? 'Xem khoản chi' : 'Xem và sửa khoản chi'}</a>}
          {data.remote!.total === 0 && canWrite(data) && <a className="primary-button compact" href={tripHref(data, 'them-khoan-chi')}>Thêm khoản chi</a>}
          {allSettled && !singleParticipant && isOwner(data) && <a className="secondary-button compact" href={tripHref(data, 'cai-dat')}>Chốt chuyến đi</a>}
        </div>}
      </div>}
      {complete && transfers.length > 0 && <ShareRepaymentQrs data={data} actions={receiptActions} disabled={disabled || loading} />}
      <div className="transfer-grid">{!loading && complete && transfers.map(suggestion => <div className="card transfer-card" key={suggestion.from + '-' + suggestion.to}>
        <div className="list-row"><TransferRow data={data} transfer={suggestion} /></div>
        {canWrite(data) && (isOwner(data) || suggestion.from === me) && (isPending(suggestion)
          ? <a className="soft-button transfer-button" href={pendingHref}><History size={16} aria-hidden /> Xem khoản đang chờ</a>
          : <button className="soft-button transfer-button" disabled={disabled} onClick={() => open(suggestion)}><ArrowDownUp size={16} aria-hidden /> {data.remote ? suggestion.from === me ? 'Chuyển khoản' : 'Ghi nhận thay' : 'Ghi nhận đã chuyển'}</button>)}
      </div>)}</div>
    </section>
    {groupEqual && complete && <section className="card field-card" aria-label="Cách chia đều của nhóm">
      <h2>Tổng chi chia đều cho {group.length} thành viên</h2>
      <p><Amount value={data.remote!.total} /> ÷ {group.length} người. Mỗi người chịu <strong><Amount value={Number(BigInt(data.remote!.total) / BigInt(group.length))} />{data.remote!.total % group.length > 0 && <> – <Amount value={Number(BigInt(data.remote!.total) / BigInt(group.length)) + 1} /></>}</strong>.</p>
    </section>}
    <section>
      <div className="section-heading"><h2>Số tiền của từng thành viên</h2><span className="tag">{visibleMembers.length} người</span></div>
      <div className="card rows">{visibleMembers.map(member => {
        const total = totals[member.id];
        const row = finance.lines[member.id];
        if (total === undefined) return <div className="list-row" key={member.id}><Avatar member={member} />
          <div className="row-text"><strong>{member.name}</strong><span>Chưa có dữ liệu số dư</span></div></div>;
        return <section className="balance-member" aria-label={'Số dư của ' + nameOf(data, member.id)} key={member.id}>
          <div className="list-row"><Avatar member={member} />
            <span className="row-text"><strong>{nameOf(data, member.id)}{member.id === me ? ' (bạn)' : ''}{member.inactive && ' · Ngừng dùng'}</strong><span>{total > 0 ? 'Được nhận' : total < 0 ? 'Cần trả' : withoutCosts.has(member.id) ? 'Chưa có chi phí phải chịu' : 'Đã cân bằng'}</span></span>
            <strong className={'row-end ' + (total < 0 ? 'negative' : total > 0 ? 'positive' : '')}><Amount value={Math.abs(total)} /></strong>
          </div>
          <dl className="balance-breakdown">{[['Phải chịu', row.owedMinor], ['Đã ứng', row.paidMinor], ['Đã chuyển', row.sentMinor], ['Đã nhận', row.receivedMinor]].map(([label, value]) =>
            <div key={label}><dt>{label}</dt><dd><Amount value={Number(value)} /></dd></div>)}</dl>
        </section>;
      })}</div>
    </section>
    <PaymentQrCard data={data} update={update} actions={receiptActions} disabled={disabled} />
    {selected && <Dialog title={ownPayment ? 'Chuyển khoản trả thành viên' : 'Ghi nhận đã chuyển tiền'} onClose={() => { if (!uploading) setSelected(undefined); }} summary={transfer && <section className="payment-amount" aria-label="Số tiền cần chuyển cho người nhận">
      <span>Số tiền cần chuyển</span>
      <strong><Amount value={transfer.amount} /></strong>
      <span>{nameOf(data, transfer.from)} → {nameOf(data, transfer.to)}</span>
    </section>} footer={alreadyRecorded
      ? <a className="primary-button" href={pendingHref}>Xem và xử lý khoản đang chờ</a>
      : <>
        {ownPayment && !proof && <p role="status">Thiếu ảnh chuyển khoản.</p>}
        {uploading && <p role="status">Đang xử lý ảnh, vui lòng chờ…</p>}
        <button type="submit" form={formId} className="primary-button" disabled={disabled || uploading || stale || !transfer || !complete || !transfersReady || Boolean(ownPayment && !proof)}>{ownPayment ? 'Gửi báo đã chuyển khoản' : 'Ghi nhận'}</button>
      </>}>
      <form id={formId} className="field-card dialog-fields" onSubmit={save}>
        {!selected.transfer && <div className="field-pair">
          <label>Người chuyển<select aria-label="Người chuyển" value={from} disabled={uploading || Boolean(proof)} onChange={event => setFrom(event.target.value)}>{debtors.map(member => <option value={member.id} key={member.id}>{nameOf(data, member.id)}</option>)}</select></label>
          <label>Người nhận<select aria-label="Người nhận" value={to} disabled={uploading || Boolean(proof)} onChange={event => setTo(event.target.value)}>{creditors.map(member => <option value={member.id} key={member.id}>{nameOf(data, member.id)}</option>)}</select></label>
        </div>}
        {alreadyRecorded ? <section className="field-card payment-pending" aria-label="Khoản chuyển đang chờ xác nhận">
          <h3>Đã có khoản chuyển đang chờ xác nhận</h3>
          <p>Khoản chuyển này đã được ghi nhận và đang chờ xác nhận.</p>
          <ul>{matchingPending.map((item, index) => <li key={index}>Số tiền đã ghi nhận: <b><Amount value={item.amount} /></b></li>)}</ul>
        </section> : <>
        {ownPayment && transfer && <section className="field-card payment-qr-section">
          <h3>QR nhận tiền của {nameOf(data, transfer.to)}</h3>
          {memberFor(data, transfer.to)?.paymentQrReceiptId ? <TransferQr receipt={{ id: memberFor(data, transfer.to)!.paymentQrReceiptId!, name: 'QR người nhận' }} actions={receiptActions} amount={transfer.amount} label={'QR nhận tiền của ' + nameOf(data, transfer.to)} />
            : <p>Người nhận chưa thêm QR.</p>}
        </section>}
        {transfer && <label>Số tiền đã chuyển (VND)<input key={transfer.from + '/' + transfer.to} inputMode="numeric" name="amount" defaultValue={new Intl.NumberFormat('vi-VN').format(transfer.amount)} onChange={() => setError('')} required /></label>}
        {ownPayment && receiptActions && <PaymentImagePicker receipt={proof} onChange={setProof} actions={receiptActions} label="Ảnh chuyển khoản" busy={uploading} onBusy={setUploading} disabled={disabled} />}
        {ownPayment && !receiptActions && <p role="status">Cần kết nối mạng để tải ảnh chuyển khoản.</p>}
        {data.remote && !ownPayment && <p>Đang ghi nhận thay người chuyển.</p>}
        </>}
        {stale && <p className="error" role="alert">Số dư đã thay đổi. Đóng hộp thoại rồi kiểm tra khoản chuyển mới.</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </Dialog>}
  </>;
}

export type SettlementFilter = 'pending' | 'confirmed' | 'cancelled' | 'void';

export function Settlements({ data, update, onMore, loading, remoteFilter, onFilter, disabled, receiptActions }: {
  data: Demo; update: UpdateTrip; onMore?: () => void; loading?: boolean; remoteFilter?: SettlementFilter; onFilter?: (status: SettlementFilter) => void; disabled?: boolean;
  receiptActions?: ReceiptActions;
}) {
  const formId = useId();
  const [viewing, setViewing] = useState<Settlement>();
  const [localFilter, setLocalFilter] = useState<SettlementFilter>('pending');
  const filter = remoteFilter ?? localFilter;
  const setFilter = onFilter ?? setLocalFilter;
  const [selected, setSelected] = useState<{ item: Settlement; status: 'confirmed' | 'cancelled' | 'void'; ledgerVersion?: number } | null>(null);
  const [error, setError] = useState('');
  const totals = balances(data);
  const finance = financialSnapshot(data);
  const me = viewerOf(data);
  const owner = isOwner(data);
  const actor = data.remote?.actorUid ?? me;
  const recipient = (item: Settlement) => item.to === me && (owner || !data.remote || item.recordedBy !== actor);
  const stale = selected?.status === 'confirmed' && selected.ledgerVersion !== data.remote?.ledgerVersion;
  const entries = data.settlements.filter(item => settlementStatus(item) === filter || (!onFilter && filter === 'cancelled' && settlementStatus(item) === 'void'));
  const labels = { pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận', cancelled: 'Đã hủy', void: 'Đã hủy hiệu lực' };
  const actions = { confirmed: 'Xác nhận đã nhận tiền', cancelled: 'Hủy khoản chuyển', void: 'Hủy hiệu lực khoản chuyển' };

  function open(item: Settlement, status: 'confirmed' | 'cancelled' | 'void') {
    setSelected({ item, status, ledgerVersion: data.remote?.ledgerVersion });
    setError('');
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || stale || disabled || !financialSnapshot(data).complete) return;
    const { item, status } = selected;
    if (status === 'confirmed' && ((totals[item.from] ?? 0) > -item.amount || (totals[item.to] ?? 0) < item.amount)) {
      setError('Số dư đã thay đổi. Hãy hủy khoản chuyển này và xem gợi ý mới.');
      return;
    }
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    if (status === 'void' && !reason) { setError('Nhập lý do hủy hiệu lực.'); return; }
    const entry = { ...item, status, confirmed: status === 'confirmed', reason, confirmedBy: status === 'confirmed' ? me : item.confirmedBy };
    update(record({ ...data, settlements: data.settlements.map(item => item.id === entry.id ? entry : item) }, actions[status], nameOf(data, entry.from) + ' → ' + nameOf(data, entry.to) + ' · ' + money(entry.amount), '#quyet-toan'),
      { type: 'settlement-status', item, status, reason, ledgerVersion: selected.ledgerVersion },
      () => { setSelected(null); setFilter(!onFilter && status === 'void' ? 'cancelled' : status); });
  }

  return <>
    <PageTitle title="Lịch sử chuyển tiền" back={tripHref(data, 'so-du')} />
    {finance.complete && Object.hasOwn(finance.net, me) && <section className="card field-card settlement-summary" aria-label="Công nợ còn lại của bạn">
      <h2>{finance.net[me] > 0 ? 'Còn được nhận' : finance.net[me] < 0 ? 'Còn cần trả' : 'Đã cân bằng'}</h2>
      <strong><Amount value={Math.abs(finance.net[me])} /></strong>
    </section>}
    <div className={'segmented compact-segments ' + (onFilter ? 'four-segments' : 'three-segments')} aria-label="Trạng thái chuyển tiền">
      {(onFilter ? ['pending', 'confirmed', 'cancelled', 'void'] as const : ['pending', 'confirmed', 'cancelled'] as const).map(status =>
        <button key={status} aria-pressed={filter === status} onClick={() => setFilter(status)}>{labels[status]}</button>)}
    </div>
    {loading && <p role="status">Đang tải giao dịch…</p>}
    {!entries.length && !loading && <div className="card empty-stack"><History size={25} aria-hidden /><Empty>Chưa có khoản chuyển trong trạng thái này.</Empty></div>}
    <div className="transfer-grid">{entries.map(item => {
      const status = settlementStatus(item);
      return <div className="card transfer-card" key={item.id}>
        <div className="list-row"><TransferRow data={data} transfer={item} /></div>
        {status === 'pending' && <p className="settlement-amount-note">Số tiền ghi nhận cho khoản chuyển này: <b><Amount value={item.amount} /></b></p>}
        <div className="settlement-meta">{item.date && <span>{dateLabel(item.date)}</span>}{item.recordedBy && <span>{nameOf(data, item.recordedBy)} ghi nhận</span>}
          {item.confirmedBy && <span>{nameOf(data, item.confirmedBy)} {item.confirmationMode === 'owner_on_behalf' ? 'xác nhận thay' : 'xác nhận đã nhận'}{item.confirmedAt && ' · ' + dateLabel(item.confirmedAt.slice(0, 10))}</span>}</div>
        {item.reason && <p className="settlement-meta">Lý do: {item.reason}</p>}
        {item.receipts?.length && (item.from === me || item.to === me) ? <button className="text-button payment-proof-button" onClick={() => setViewing(item)}><ReceiptText size={16} aria-hidden /> Xem ảnh chuyển khoản</button> : null}
        <div className="transfer-footer">
          <span className={'tag ' + (status === 'confirmed' ? 'mint' : status === 'pending' ? 'warm' : '')}>{labels[status]}</span>
          {canWrite(data) && status === 'pending' && <>
            {(owner || (item.recordedBy ?? item.from) === actor) && <button className="text-button muted" onClick={() => open(item, 'cancelled')}>Hủy</button>}
            {(recipient(item) || owner && !item.receipts?.length) && <button className="text-button" onClick={() => open(item, 'confirmed')}><CircleCheck size={16} aria-hidden /> {recipient(item) ? 'Xác nhận đã nhận tiền' : 'Xác nhận thay'}</button>}
          </>}
          {canWrite(data) && owner && status === 'confirmed' && <button className="text-button" onClick={() => open(item, 'void')}>Hủy hiệu lực</button>}
        </div>
      </div>;
    })}</div>
    {onMore && <button className="secondary-button" disabled={loading} onClick={onMore}>Tải thêm giao dịch</button>}
    {viewing && <Dialog title="Ảnh chuyển khoản" onClose={() => setViewing(undefined)} summary={<section className="payment-amount">
      <span>Số tiền đã ghi nhận</span><strong><Amount value={viewing.amount} /></strong><span>{nameOf(data, viewing.from)} → {nameOf(data, viewing.to)}</span>
    </section>} footer={canWrite(data) && recipient(viewing) && settlementStatus(viewing) === 'pending' && <button className="primary-button" disabled={disabled} onClick={() => { setViewing(undefined); open(viewing, 'confirmed'); }}>Xác nhận đã nhận tiền</button>}>
      {viewing.receipts?.map(receipt => <PaymentImage key={receipt.id} receipt={receipt} actions={receiptActions} label={receipt.name} />)}
    </Dialog>}
    {selected && <Dialog title={selected.status === 'confirmed' && !recipient(selected.item) ? 'Xác nhận thay người nhận?' : actions[selected.status] + '?'} onClose={() => setSelected(null)} summary={<section className="payment-amount" aria-label="Số tiền xác nhận của khoản chuyển">
        <span>{selected.status === 'confirmed' ? 'Số tiền xác nhận cho khoản này' : 'Số tiền của khoản chuyển'}</span>
        <strong><Amount value={selected.item.amount} /></strong>
        <span>{nameOf(data, selected.item.from)} → {nameOf(data, selected.item.to)}</span>
        {selected.item.date && <span>Khoản ghi nhận ngày {dateLabel(selected.item.date)}</span>}
      </section>} footer={<div className="button-pair"><button type="button" className="secondary-button" onClick={() => setSelected(null)}>Quay lại</button><button type="submit" form={formId} disabled={disabled || Boolean(stale) || !financialSnapshot(data).complete} className={selected.status === 'confirmed' ? 'primary-button' : 'danger-button'}>Xác nhận</button></div>}>
      {selected.status === 'confirmed' && selected.item.receipts?.map(receipt => <PaymentImage key={receipt.id} receipt={receipt} actions={receiptActions} label={receipt.name} />)}
      {selected.status === 'confirmed' ? !recipient(selected.item) && <p>Đang xác nhận thay người nhận.</p>
        : <p>{selected.status === 'void' ? 'Số dư sẽ được tính lại sau khi hủy hiệu lực.' : 'Khoản chuyển sẽ được hủy và giữ trong lịch sử.'}</p>}
      <form id={formId} className="field-card dialog-fields" onSubmit={save}>
        {selected.status === 'void' && <label>Lý do<input name="reason" maxLength={300} required /></label>}
        {(error || stale) && <p className="error" role="alert">{stale ? 'Số dư đã thay đổi. Đóng hộp thoại và kiểm tra lại.' : error}</p>}
      </form>
    </Dialog>}
  </>;
}
