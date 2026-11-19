'use client';

import {
  ArrowDownLeft, ArrowDownUp, ArrowRight, ArrowUpRight, CalendarDays, ChevronRight,
  CircleCheck, History, MapPin, Plus, ReceiptText, Search, Settings2, UserPlus, Wallet,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
  activeExpenses, balances, canWrite, categories, dateLabel, dateRange, isOwner, memberFor, money, nameOf, netLabel,
  newId, record, settlementStatus, suggestions, today, viewerOf, type Demo, type Expense, type Settlement, type Transfer,
} from './model';
import { Amount, Avatar, CategoryIcon, Dialog, Empty, PageTitle } from './ui';
import type { UpdateTrip } from './trip-command';
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
      {!expense.voided && me && <small>Phần của bạn: <Amount value={share} /></small>}
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
  const members = data.members.filter(member => !member.inactive);
  const expenses = activeExpenses(data).sort(sortExpenses);
  const me = viewerOf(data);
  const finance = financialSnapshot(data);
  const personal = finance.lines[me];
  const net = personal?.netMinor ?? 0;
  const transfers = suggestions(data);
  const pending = data.remote?.pendingCount ?? data.settlements.filter(item => settlementStatus(item) === 'pending').length;
  return <>
    <PageTitle title="Tổng quan" description="Chi tiêu và kế hoạch chuyến đi">
      {canWrite(data) && <a className="primary-button compact overview-add" href={tripHref(data, 'them-khoan-chi')} aria-label="Thêm khoản chi"><Plus size={20} aria-hidden /> <span>Thêm khoản chi</span></a>}
    </PageTitle>
    <section className="trip-card overview-cover" aria-label="Thông tin chuyến đi">
      <div className={'trip-cover' + (trip.cover ? '' : ' cover-plain')}>
        <div className="trip-cover-top">
          <span className="trip-status"><span />{data.remote?.suspended ? 'Tạm khóa' : trip.closed ? 'Đã chốt chuyến' : 'Đang mở'}</span>
          <a className="icon-button cover-settings" href={tripHref(data, 'cai-dat')} aria-label="Cài đặt chuyến đi"><Settings2 size={20} aria-hidden /></a>
        </div>
        <div className="trip-cover-text">
          {trip.place && <p><MapPin size={15} aria-hidden /> {trip.place}</p>}
          <h2>{trip.name}</h2>
          <div className="trip-dates"><CalendarDays size={16} aria-hidden /> {dateRange(trip)}</div>
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

export function Balances({ data, update, loading, disabled }: { data: Demo; update: UpdateTrip; loading?: boolean; disabled?: boolean }) {
  const [selected, setSelected] = useState<{ transfer?: Transfer; ledgerVersion?: number }>();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const finance = financialSnapshot(data);
  const totals = finance.net;
  const transfers = suggestions(data);
  const me = viewerOf(data);
  const net = totals[me] ?? 0;
  const complete = finance.complete;
  const hasPersonal = complete && Object.hasOwn(totals, me);
  const pending = data.remote?.pendingCount ?? data.settlements.filter(item => settlementStatus(item) === 'pending').length;
  const allSettled = finance.balanced;
  const debtors = data.members.filter(member => totals[member.id] < 0 && (isOwner(data) || member.id === me));
  const creditors = data.members.filter(member => totals[member.id] > 0);
  const cap = transferLimit(totals[from] ?? 0, totals[to] ?? 0);
  const transfer = selected?.transfer ?? (cap > 0 ? { from, to, amount: cap } : undefined);
  const stale = selected?.ledgerVersion !== undefined && selected.ledgerVersion !== data.remote?.ledgerVersion;

  function open(transfer?: Transfer) {
    setSelected({ transfer: transfer && { ...transfer, amount: Math.min(transfer.amount, maximumMoney) }, ledgerVersion: data.remote?.ledgerVersion });
    setFrom(debtors[0]?.id ?? '');
    setTo(creditors[0]?.id ?? '');
    setError('');
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !transfer || stale || !complete || disabled) return;
    const amount = parsePositiveMoney(String(new FormData(event.currentTarget).get('amount') ?? ''));
    if (amount === undefined || amount > transfer.amount) { setError('Nhập số nguyên VND từ 1đ đến ' + money(transfer.amount) + ', ví dụ 10.000.'); return; }
    const entry: Settlement = { ...transfer, amount, id: newId(), confirmed: false, date: today(data.trip.timezone), recordedBy: me };
    update(record({ ...data, settlements: [entry, ...data.settlements] }, 'Ghi nhận chuyển tiền', nameOf(data, entry.from) + ' → ' + nameOf(data, entry.to) + ' · ' + money(amount), '#quyet-toan'),
      { type: 'record-settlement', transfer: entry, ledgerVersion: selected.ledgerVersion }, () => { setSelected(undefined); window.location.hash = tripHref(data, 'quyet-toan'); });
  }
  return <>
    <PageTitle title="Số dư & quyết toán">
      <a className="secondary-button compact" href={tripHref(data, 'quyet-toan')}><History size={18} aria-hidden /> Lịch sử</a>
    </PageTitle>
    <div className={'summary-card balance-hero personal' + (net < 0 ? ' negative-card' : '')}>
      <span className="tile-icon summary-icon"><Wallet size={21} aria-hidden /></span>
      <span className="summary-label">{hasPersonal ? netLabel(net) : 'Số dư của bạn'}</span>
      <strong>{hasPersonal ? <Amount value={Math.abs(net)} /> : me ? 'Chưa đủ dữ liệu' : 'Chưa liên kết'}</strong>
      {pending > 0 && <a className="text-button" href={tripHref(data, 'quyet-toan')}>{pending} khoản đang chờ xác nhận <ChevronRight size={15} aria-hidden /></a>}
    </div>
    <section>
      <div className="section-heading"><h2>Số tiền của từng thành viên</h2><span className="tag">{data.members.length} người</span></div>
      <p className="inline-note money-explainer">Phải chịu là tổng phần được chia từ các khoản chi. Cần trả / được nhận đã trừ tiền ứng và các khoản chuyển được xác nhận.</p>
      <div className="card rows">{data.members.map(member => {
        const total = totals[member.id];
        const row = finance.lines[member.id];
        if (total === undefined) return <div className="list-row" key={member.id}><Avatar member={member} />
          <div className="row-text"><strong>{member.name}</strong><span>Chưa có dữ liệu số dư</span></div></div>;
        return <section className="balance-member" aria-label={'Số dư của ' + nameOf(data, member.id)} key={member.id}>
          <div className="list-row"><Avatar member={member} />
            <span className="row-text"><strong>{nameOf(data, member.id)}{member.id === me ? ' (bạn)' : ''}{member.inactive && ' · Ngừng dùng'}</strong><span>{total > 0 ? 'Được nhận' : total < 0 ? 'Cần trả' : 'Đã cân bằng'}</span></span>
            <strong className={'row-end ' + (total < 0 ? 'negative' : total > 0 ? 'positive' : '')}><Amount value={Math.abs(total)} /></strong>
          </div>
          <dl className="balance-breakdown">{[['Phải chịu', row.owedMinor], ['Đã ứng', row.paidMinor], ['Đã chuyển', row.sentMinor], ['Đã nhận', row.receivedMinor]].map(([label, value]) =>
            <div key={label}><dt>{label}</dt><dd><Amount value={Number(value)} /></dd></div>)}</dl>
        </section>;
      })}</div>
    </section>
    <section>
      <div className="section-heading"><h2>Gợi ý chuyển tiền</h2>
        {complete && canWrite(data) && debtors.length > 0 && creditors.length > 0 &&
          <button className="secondary-button compact" disabled={disabled} onClick={() => open()}>Ghi khoản chuyển khác</button>}
      </div>
      {loading && <p role="status">Đang tải gợi ý chuyển tiền…</p>}
      {!loading && !transfers.length && <div className="card empty-stack">{allSettled ? <CircleCheck size={26} aria-hidden /> : <Wallet size={26} aria-hidden />}<Empty>{allSettled ? 'Mọi người đã cân bằng.' : pending ? 'Các khoản còn lại đang chờ xác nhận.' : 'Chưa có gợi ý cho số dư hiện tại.'}</Empty>
        {allSettled && !data.trip.closed && isOwner(data) && <a className="secondary-button" href={tripHref(data, 'cai-dat')}>Chốt chuyến đi</a>}
      </div>}
      {pending > 0 && <p className="inline-note">Các khoản đang chờ vẫn nằm ngoài số tiền đã xác nhận. Kiểm tra lịch sử trước khi ghi thêm khoản chuyển.</p>}
      <div className="transfer-grid">{!loading && complete && transfers.map(suggestion => <div className="card transfer-card" key={suggestion.from + '-' + suggestion.to}>
        <div className="list-row"><TransferRow data={data} transfer={suggestion} /></div>
        {canWrite(data) && (isOwner(data) || suggestion.from === me) && <button className="soft-button transfer-button" disabled={disabled} onClick={() => open(suggestion)}><ArrowDownUp size={16} aria-hidden /> Ghi nhận đã chuyển</button>}
      </div>)}</div>
    </section>
    {selected && <Dialog title="Ghi nhận đã chuyển tiền" onClose={() => setSelected(undefined)}>
      <p>{selected.transfer && nameOf(data, selected.transfer.from) + ' → ' + nameOf(data, selected.transfer.to) + '. '}Số dư cập nhật sau khi khoản chuyển được xác nhận.</p>
      <form className="field-card dialog-fields" onSubmit={save}>
        {!selected.transfer && <div className="field-pair">
          <label>Người chuyển<select aria-label="Người chuyển" value={from} onChange={event => setFrom(event.target.value)}>{debtors.map(member => <option value={member.id} key={member.id}>{nameOf(data, member.id)}</option>)}</select></label>
          <label>Người nhận<select aria-label="Người nhận" value={to} onChange={event => setTo(event.target.value)}>{creditors.map(member => <option value={member.id} key={member.id}>{nameOf(data, member.id)}</option>)}</select></label>
        </div>}
        {transfer && <label>Số tiền đã chuyển (VND)<input key={transfer.from + '/' + transfer.to} inputMode="numeric" name="amount" placeholder="Ví dụ: 10.000" defaultValue={selected.transfer?.amount} required /></label>}
        {transfer && <p>Tối đa {money(transfer.amount)}</p>}
        {stale && <p className="error" role="alert">Số dư đã thay đổi. Đóng hộp thoại rồi kiểm tra khoản chuyển mới.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary-button" disabled={disabled || stale || !transfer || !complete}>Ghi nhận</button>
      </form>
    </Dialog>}
  </>;
}

export type SettlementFilter = 'pending' | 'confirmed' | 'cancelled' | 'void';

export function Settlements({ data, update, onMore, loading, remoteFilter, onFilter, disabled }: {
  data: Demo; update: UpdateTrip; onMore?: () => void; loading?: boolean; remoteFilter?: SettlementFilter; onFilter?: (status: SettlementFilter) => void; disabled?: boolean;
}) {
  const [localFilter, setLocalFilter] = useState<SettlementFilter>('pending');
  const filter = remoteFilter ?? localFilter;
  const setFilter = onFilter ?? setLocalFilter;
  const [selected, setSelected] = useState<{ item: Settlement; status: 'confirmed' | 'cancelled' | 'void'; ledgerVersion?: number } | null>(null);
  const [error, setError] = useState('');
  const totals = balances(data);
  const me = viewerOf(data);
  const owner = isOwner(data);
  const actor = data.remote?.actorUid ?? me;
  const recipient = (item: Settlement) => item.to === me && (!data.remote || item.recordedBy !== actor);
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
        <div className="settlement-meta">{item.date && <span>{dateLabel(item.date)}</span>}{item.recordedBy && <span>{nameOf(data, item.recordedBy)} ghi nhận</span>}
          {item.confirmedBy && <span>{nameOf(data, item.confirmedBy)} {item.confirmationMode === 'owner_on_behalf' ? 'xác nhận thay' : 'xác nhận đã nhận'}{item.confirmedAt && ' · ' + dateLabel(item.confirmedAt.slice(0, 10))}</span>}</div>
        {item.reason && <p className="settlement-meta">Lý do: {item.reason}</p>}
        <div className="transfer-footer">
          <span className={'tag ' + (status === 'confirmed' ? 'mint' : status === 'pending' ? 'warm' : '')}>{labels[status]}</span>
          {canWrite(data) && status === 'pending' && <>
            {(owner || (item.recordedBy ?? item.from) === actor) && <button className="text-button muted" onClick={() => open(item, 'cancelled')}>Hủy</button>}
            {(owner || recipient(item)) && <button className="text-button" onClick={() => open(item, 'confirmed')}><CircleCheck size={16} aria-hidden /> {recipient(item) ? 'Tôi đã nhận tiền' : 'Xác nhận thay'}</button>}
          </>}
          {canWrite(data) && owner && status === 'confirmed' && <button className="text-button" onClick={() => open(item, 'void')}>Hủy hiệu lực</button>}
        </div>
      </div>;
    })}</div>
    {onMore && <button className="secondary-button" disabled={loading} onClick={onMore}>Tải thêm giao dịch</button>}
    {selected && <Dialog title={selected.status === 'confirmed' && !recipient(selected.item) ? 'Xác nhận thay người nhận?' : actions[selected.status] + '?'} onClose={() => setSelected(null)}>
      <p>{nameOf(data, selected.item.from)} → {nameOf(data, selected.item.to)} · {money(selected.item.amount)}</p>
      <p>{selected.status === 'confirmed' ? recipient(selected.item)
        ? 'Hãy kiểm tra tiền thực tế đã nhận trước khi ghi sổ.'
        : 'Bạn đang ghi sổ thay người nhận. Hãy xác minh người nhận đã nhận khoản tiền này.'
        : selected.status === 'void' ? 'Số dư sẽ được tính lại sau khi hủy hiệu lực.' : 'Khoản chuyển chờ xác nhận sẽ được hủy và vẫn xuất hiện trong lịch sử.'}</p>
      <form className="field-card dialog-fields" onSubmit={save}>
        {selected.status === 'void' && <label>Lý do<input name="reason" maxLength={300} required /></label>}
        {(error || stale) && <p className="error" role="alert">{stale ? 'Số dư đã thay đổi. Đóng hộp thoại và kiểm tra lại.' : error}</p>}
        <div className="button-pair"><button type="button" className="secondary-button" onClick={() => setSelected(null)}>Quay lại</button><button disabled={disabled || Boolean(stale) || !financialSnapshot(data).complete} className={selected.status === 'confirmed' ? 'primary-button' : 'danger-button'}>Xác nhận</button></div>
      </form>
    </Dialog>}
  </>;
}
