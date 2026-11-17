'use client';

import {
  ArrowDownLeft, ArrowDownUp, ArrowRight, ArrowUpRight, CalendarDays, ChevronRight,
  CircleCheck, ListFilter, MapPin, Plus, Search, UserPlus, Users, Wallet,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
  activeExpenses, balances, categories, dateLabel, me, memberFor, money, nameOf, netLabel,
  newId, suggestions, type Demo, type Expense, type Transfer,
} from './model';
import { Amount, Avatar, CategoryIcon, Empty, PageTitle } from './ui';

function ExpenseRow({ expense, data }: { expense: Expense; data: Demo }) {
  return <a className={`list-row expense-row ${expense.voided ? 'voided' : ''}`} href={`#khoan-chi/${expense.id}`}>
    <CategoryIcon category={expense.category} />
    <div className="row-text"><strong>{expense.title}</strong>
      <span>{expense.voided ? 'Đã hủy' : `${nameOf(data, expense.payer)} đã trả`} <span aria-hidden>·</span> {categories[expense.category]}</span>
    </div>
    <strong className="row-end"><Amount value={expense.amount} /></strong>
    <ChevronRight className="row-chevron" size={16} aria-hidden />
  </a>;
}

function TransferRow({ data, transfer }: { data: Demo; transfer: Transfer }) {
  return <>
    <Avatar member={memberFor(data, transfer.from)} />
    <div className="row-text"><strong className="transfer-names">{nameOf(data, transfer.from)} <ArrowRight size={13} aria-hidden /> {nameOf(data, transfer.to)}</strong></div>
    <strong className="row-end"><Amount value={transfer.amount} /></strong>
  </>;
}

export function Overview({ data }: { data: Demo }) {
  const { trip, members } = data;
  const expenses = activeExpenses(data);
  const net = balances(data)[me];
  const transfers = suggestions(data);
  return <>
    <p className="desktop-page-title" aria-hidden="true">Tổng quan chuyến đi</p>
    <section className="trip-card" aria-label="Thông tin chuyến đi">
      <div className="trip-cover">
        <span className="trip-status"><span />{trip.closed ? 'Đã chốt chuyến' : 'Đang diễn ra'}</span>
        <div className="trip-cover-text">
          <p><MapPin size={14} aria-hidden /> {trip.place}</p>
          <h1>{trip.name}</h1>
          <div className="trip-dates"><CalendarDays size={15} aria-hidden /> {dateLabel(trip.start)} – {dateLabel(trip.end)}</div>
        </div>
      </div>
      <div className="trip-members">
        <a href="#thanh-vien" className="member-preview">
          <span className="avatar-stack">{members.slice(0, 3).map(member => <Avatar key={member.id} member={member} />)}</span>
          <strong>{members.length} thành viên</strong>
        </a>
        {!trip.closed && <a className="soft-button" href="#loi-moi"><UserPlus size={16} aria-hidden /> Mời bạn</a>}
      </div>
    </section>

    <div className="summary-grid" aria-label="Tóm tắt chi tiêu">
      <a className="summary-card" href="#chi-tieu">
        <span className="summary-top"><span className="tile-icon summary-icon"><Wallet size={18} aria-hidden /></span><ArrowUpRight size={16} aria-hidden /></span>
        <span className="summary-label">Tổng chi tiêu</span>
        <strong><Amount value={expenses.reduce((sum, expense) => sum + expense.amount, 0)} /></strong>
      </a>
      <a className={`summary-card personal ${net < 0 ? 'negative-card' : ''}`} href="#so-du">
        <span className="summary-top"><span className="tile-icon summary-icon"><ArrowDownLeft size={19} aria-hidden /></span><ArrowUpRight size={16} aria-hidden /></span>
        <span className="summary-label">{netLabel(net)}</span>
        <strong><Amount value={Math.abs(net)} /></strong>
      </a>
    </div>

    {!trip.closed && <a className="primary-button overview-add" href="#them-khoan-chi"><Plus size={21} aria-hidden /> Thêm khoản chi</a>}

    <div className="overview-sections">
      <section aria-labelledby="recent-title">
        <div className="section-heading"><h2 id="recent-title">Chi tiêu gần đây</h2><a className="text-button" href="#chi-tieu">Xem tất cả <ChevronRight size={16} aria-hidden /></a></div>
        <div className="card rows">{expenses.length > 0
          ? expenses.slice(0, 3).map(expense => <ExpenseRow key={expense.id} expense={expense} data={data} />)
          : <Empty>Chuyến đi chưa có khoản chi nào.</Empty>}
        </div>
      </section>
      <section aria-labelledby="suggest-title">
        <div className="section-heading"><h2 id="suggest-title">Gợi ý quyết toán</h2><a className="text-button" href="#so-du">Xem số dư <ChevronRight size={16} aria-hidden /></a></div>
        <div className="card rows">{transfers.length > 0
          ? transfers.slice(0, 3).map(transfer => <div key={`${transfer.from}-${transfer.to}`} className="list-row"><TransferRow data={data} transfer={transfer} /></div>)
          : <Empty>{data.settlements.some(item => !item.confirmed) ? 'Có khoản chuyển đang chờ xác nhận.' : 'Các thành viên đã cân bằng.'}</Empty>}
        </div>
      </section>
    </div>
  </>;
}

export function Expenses({ data }: { data: Demo }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const normalize = (value: string) => value.toLocaleLowerCase('vi').normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');
  const visible = data.expenses.filter(expense =>
    (filter === 'all' || (filter === 'voided' ? expense.voided : expense.category === filter))
      && normalize(`${expense.title} ${expense.note} ${nameOf(data, expense.payer)}`).includes(normalize(query.trim()))
  );
  const dates = [...new Set(visible.map(expense => expense.date))].sort().reverse();
  return <>
    <PageTitle title="Chi tiêu" description={`${activeExpenses(data).length} khoản chi trong chuyến đi`}>
      {!data.trip.closed && <a className="primary-button compact" aria-label="Thêm khoản chi" href="#them-khoan-chi"><Plus size={20} aria-hidden /><span>Thêm khoản chi</span></a>}
    </PageTitle>
    <label className="search"><Search size={19} aria-hidden /><input type="search" placeholder="Tìm khoản chi hoặc người trả" value={query} onChange={e => setQuery(e.target.value)} aria-label="Tìm khoản chi hoặc người trả" /></label>
    <div className="filters" aria-label="Lọc khoản chi"><ListFilter size={18} aria-hidden />
      {[['all', 'Tất cả'], ...Object.entries(categories), ['voided', 'Đã hủy']].map(([id, label]) =>
        <button key={id} className="pill" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
    </div>
    {dates.map(date => {
      const group = visible.filter(expense => expense.date === date);
      return <section className="expense-group" key={date}>
        <div className="section-heading"><h2><CalendarDays size={17} aria-hidden /> {dateLabel(date)}</h2><span className="tag">{money(group.reduce((sum, item) => sum + (item.voided ? 0 : item.amount), 0))}</span></div>
        <div className="card rows">{group.map(expense => <ExpenseRow key={expense.id} expense={expense} data={data} />)}</div>
      </section>;
    })}
    {!dates.length && <div className="card"><Empty>Chưa có khoản chi phù hợp.</Empty></div>}
  </>;
}

export function Balances({ data, update }: { data: Demo; update: (next: Demo) => void }) {
  const [selected, setSelected] = useState<Transfer | null>(null);
  const totals = balances(data);
  const transfers = suggestions(data);
  const net = totals[me];
  return <>
    <PageTitle title="Số dư & quyết toán" description="Theo dõi số tiền mỗi thành viên cần trả hoặc được nhận." />
    <div className={`summary-card balance-hero personal ${net < 0 ? 'negative-card' : ''}`}>
      <span className="tile-icon summary-icon"><Wallet size={21} aria-hidden /></span>
      <span className="summary-label">{netLabel(net)}</span><strong><Amount value={Math.abs(net)} /></strong>
    </div>
    <section>
      <div className="section-heading"><h2>Số dư thành viên</h2><span className="tag">{data.members.length} người</span></div>
      <div className="card rows">{data.members.map(member => {
        const net = totals[member.id];
        return <div className="list-row" key={member.id}><Avatar member={member} />
          <div className="row-text"><strong>{member.name}{member.id === me ? ' (bạn)' : ''}</strong><span>{net > 0 ? 'Được nhận' : net < 0 ? 'Cần trả' : 'Đã cân bằng'}</span></div>
          <strong className={`row-end ${net < 0 ? 'negative' : net > 0 ? 'positive' : ''}`}><Amount value={net} signed /></strong>
        </div>;
      })}</div>
    </section>
    <section>
      <div className="section-heading"><h2>Gợi ý chuyển tiền</h2></div>
      {!transfers.length && <div className="card"><Empty>{data.settlements.some(item => !item.confirmed) ? 'Các khoản còn lại đang chờ xác nhận.' : 'Không còn khoản nào cần chuyển.'}</Empty></div>}
      {transfers.map(transfer => {
        const isSelected = selected?.from === transfer.from && selected.to === transfer.to;
        return <div className="card transfer-card" key={`${transfer.from}-${transfer.to}`}>
          <div className="list-row"><TransferRow data={data} transfer={transfer} /></div>
          {isSelected
            ? <div className="confirm-block">
              <p>Ghi nhận {nameOf(data, transfer.from)} đã chuyển {money(transfer.amount)} cho {nameOf(data, transfer.to)}?</p>
              <div className="button-pair"><button className="secondary-button" onClick={() => setSelected(null)}>Quay lại</button><button className="primary-button" onClick={() => {
                update({ ...data, settlements: [{ ...transfer, id: newId(), confirmed: false }, ...data.settlements] });
                setSelected(null);
              }}>Ghi nhận</button></div>
            </div>
            : !data.trip.closed && <button className="soft-button transfer-button" onClick={() => setSelected(transfer)}><ArrowDownUp size={16} aria-hidden /> Ghi nhận đã chuyển</button>}
        </div>;
      })}
    </section>
    {data.settlements.length > 0 && <section>
      <div className="section-heading"><h2>Lịch sử chuyển tiền</h2></div>
      {data.settlements.map(item => <div className="card transfer-card" key={item.id}>
        <div className="list-row"><TransferRow data={data} transfer={item} /></div>
        <div className="transfer-footer">
          <span className={`tag ${item.confirmed ? 'mint' : 'warm'}`}>{item.confirmed ? 'Đã xác nhận' : 'Chờ xác nhận'}</span>
          {!item.confirmed && <><button className="text-button muted" onClick={() => update({ ...data, settlements: data.settlements.filter(entry => entry.id !== item.id) })}>Hủy</button>
            <button className="text-button" onClick={() => {
              if (totals[item.from] > -item.amount || totals[item.to] < item.amount) {
                window.alert('Số dư đã thay đổi. Hãy hủy khoản chuyển này và xem gợi ý mới.');
                return;
              }
              update({ ...data, settlements: data.settlements.map(entry => entry.id === item.id ? { ...entry, confirmed: true } : entry) });
            }}><CircleCheck size={16} aria-hidden /> Đã nhận tiền</button>
          </>}
        </div>
      </div>)}
    </section>}
  </>;
}

export function Members({ data, update }: { data: Demo; update: (next: Demo) => void }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name')).trim();
    if (!name || data.members.some(member => member.name.toLocaleLowerCase('vi') === name.toLocaleLowerCase('vi'))) {
      setError('Nhập tên khác với các thành viên hiện có.');
      return;
    }
    update({ ...data, members: [...data.members, { id: newId(), name, tone: data.members.length }] });
    setAdding(false);
    setError('');
  }
  return <>
    <PageTitle title="Thành viên" description={`${data.members.length} người trong chuyến đi`}>
      {!data.trip.closed && <a className="primary-button compact" href="#loi-moi"><UserPlus size={18} aria-hidden /> Mời bạn</a>}
    </PageTitle>
    <div className="card rows">
      {data.members.map(member => <div className="list-row" key={member.id}>
        <Avatar member={member} /><div className="row-text"><strong>{member.name}{member.id === me ? ' (bạn)' : ''}</strong>
          <span>{member.id === me ? 'Quản lý chuyến đi' : 'Có tên trong danh sách chia chi phí'}</span></div>
        <span className={`tag ${member.id === me ? 'mint' : ''}`}>{member.id === me ? 'Chủ chuyến' : 'Thành viên'}</span>
      </div>)}
    </div>
    {adding
      ? <form className="card field-card" onSubmit={addMember}>
        <label>Tên thành viên<input autoFocus name="name" autoComplete="off" maxLength={40} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="button-pair"><button type="button" className="secondary-button" onClick={() => { setAdding(false); setError(''); }}>Hủy</button><button className="primary-button">Lưu thành viên</button></div>
      </form>
      : !data.trip.closed && <button className="secondary-button" onClick={() => setAdding(true)}><Users size={18} aria-hidden /> Thêm thành viên</button>}
  </>;
}
