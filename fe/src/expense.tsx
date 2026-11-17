'use client';

import { Check, Pencil, ReceiptText, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
  categories, dateLabel, me, money, moneyInput, nameOf, newId, splitEqually,
  type Category, type Demo, type Expense,
} from './model';
import { Amount, Avatar, CategoryIcon, CategorySelect, PageTitle } from './ui';

const digits = (value: string) => value.replace(/[.\s]/g, '');

export function ExpenseForm({ data, expense, update }: { data: Demo; expense?: Expense; update: (next: Demo) => void }) {
  const back = expense ? `#khoan-chi/${expense.id}` : '#chi-tieu';
  const [amount, setAmount] = useState(expense ? String(expense.amount) : '');
  const [payer, setPayer] = useState(expense?.payer ?? me);
  const [mode, setMode] = useState(expense?.mode ?? 'equal');
  const [selected, setSelected] = useState<string[]>(expense ? Object.keys(expense.shares) : data.members.map(member => member.id));
  const [exact, setExact] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(expense?.shares ?? {}).map(([id, share]) => [id, String(share)])),
  );
  const [error, setError] = useState('');
  const ids = data.members.filter(member => selected.includes(member.id)).map(member => member.id);
  const total = Number(amount);
  const shares = mode === 'exact' ? Object.fromEntries(ids.map(id => [id, Number(exact[id] ?? 0)])) : splitEqually(total, ids);
  const difference = total - Object.values(shares).reduce((sum, share) => sum + share, 0);

  if (data.trip.closed || expense?.voided) {
    return <PageTitle title="Khoản chi chỉ có thể xem" back={back} />;
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const title = String(fields.get('title')).trim();
    if (!title || total <= 0 || !ids.length || difference !== 0 || Object.values(shares).some(share => share <= 0)) {
      setError('Nhập tên, số tiền và phần chia lớn hơn 0 cho từng người. Tổng phần chia phải bằng số tiền khoản chi.');
      return;
    }
    const item: Expense = {
      id: expense?.id ?? newId(), title, payer, amount: total, mode, shares,
      date: String(fields.get('date')), category: String(fields.get('category')) as Category,
      note: String(fields.get('note')).trim(),
    };
    update({
      ...data,
      expenses: expense ? data.expenses.map(entry => entry.id === expense.id ? item : entry) : [item, ...data.expenses],
    });
    window.location.hash = `khoan-chi/${item.id}`;
  }

  return <div className="form-page">
    <PageTitle title={expense ? 'Sửa khoản chi' : 'Thêm khoản chi'} back={back} />
    <form className="form-stack" onSubmit={save}>
      <div className="card field-card">
        <label htmlFor="expense-amount">Số tiền đã trả</label>
        <div className="money-field">
          <input id="expense-amount" placeholder="0" inputMode="numeric" value={moneyInput(amount)} required
            onChange={e => { const value = digits(e.target.value); if (/^\d{0,9}$/.test(value)) setAmount(value); }} />
          <span>VNĐ</span>
        </div>
        <label>Tên khoản chi<input name="title" placeholder="Ví dụ: Ăn tối ở Đà Lạt" defaultValue={expense?.title} maxLength={80} required /></label>
      </div>
      <fieldset className="card field-card">
        <legend>Ai đã trả tiền?</legend>
        <div className="payer-options">
          {data.members.map(member => <label className="payer-option" key={member.id}>
            <input type="radio" name="payer" value={member.id} checked={payer === member.id} onChange={() => setPayer(member.id)} />
            <Avatar member={member} /><span>{member.id === me ? `${member.name} (bạn)` : member.name}</span>
          </label>)}
        </div>
      </fieldset>
      <fieldset className="card field-card">
        <legend>Chia cho ai?</legend>
        <div className="segmented" aria-label="Cách chia">
          <button type="button" aria-pressed={mode === 'equal'} onClick={() => setMode('equal')}>Chia đều</button>
          <button type="button" aria-pressed={mode === 'exact'} onClick={() => setMode('exact')}>Nhập từng phần</button>
        </div>
        <div className="split-list">
          {data.members.map(member => <div className="split-row" key={member.id}>
            <label><input type="checkbox" checked={selected.includes(member.id)} onChange={e =>
              setSelected(e.target.checked ? [...selected, member.id] : selected.filter(id => id !== member.id))
            } /><Avatar member={member} /> {member.name}</label>
            {selected.includes(member.id) && (mode === 'equal'
              ? <strong><Amount value={shares[member.id]} /></strong>
              : <input className="split-input" aria-label={`Phần chia của ${member.name}`} inputMode="numeric" placeholder="0"
                value={moneyInput(exact[member.id] ?? '')} onChange={e => {
                  const value = digits(e.target.value);
                  if (/^\d{0,9}$/.test(value)) setExact({ ...exact, [member.id]: value });
                }} />
            )}
          </div>)}
        </div>
        {mode === 'exact' && <p className={`inline-note ${difference ? 'error' : 'positive'}`} aria-live="polite">
          {difference > 0 ? `Còn thiếu ${money(difference)}` : difference < 0 ? `Đã chia dư ${money(-difference)}` : 'Tổng phần chia khớp số tiền.'}
        </p>}
      </fieldset>
      <fieldset className="card field-card">
        <legend>Thông tin chi tiết</legend>
        <div className="field-pair">
          <label>Ngày chi<input name="date" type="date" defaultValue={expense?.date ?? data.trip.start} required /></label>
          <label>Danh mục<CategorySelect defaultValue={expense?.category} /></label>
        </div>
        <label><span>Ghi chú <span className="optional">(tùy chọn)</span></span><textarea name="note" defaultValue={expense?.note} maxLength={240} rows={2} /></label>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-action"><button className="primary-button"><Check size={19} aria-hidden /> Lưu khoản chi{total > 0 && ` · ${money(total)}`}</button></div>
    </form>
  </div>;
}

export function ExpenseDetail({ data, expense, update }: { data: Demo; expense: Expense; update: (next: Demo) => void }) {
  const [voiding, setVoiding] = useState(false);
  function voidExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason')).trim();
    if (!reason) return;
    update({ ...data, expenses: data.expenses.map(entry => entry.id === expense.id ? { ...entry, voided: true, voidReason: reason } : entry) });
    setVoiding(false);
  }
  return <div className="form-page detail-page">
    <PageTitle title="Chi tiết khoản chi" back="#chi-tieu" />
    <section className="card field-card detail-summary">
      <CategoryIcon category={expense.category} />
      <h2>{expense.title}</h2><strong><Amount value={expense.amount} /></strong>
      <p>{nameOf(data, expense.payer)} đã trả · {dateLabel(expense.date)}</p>
      <span className="tag">{expense.voided ? 'Đã hủy' : categories[expense.category]}</span>
      {expense.note && <p className="expense-note"><ReceiptText size={17} aria-hidden /> {expense.note}</p>}
      {expense.voidReason && <p>Lý do hủy — {expense.voidReason}</p>}
    </section>
    <section>
      <div className="section-heading"><h2>Phần chia</h2><span className="tag">{expense.mode === 'equal' ? 'Chia đều' : 'Theo số tiền'}</span></div>
      <div className="card rows">{data.members.filter(member => member.id in expense.shares).map(member =>
        <div key={member.id} className="list-row"><Avatar member={member} /><strong className="row-text">{member.name}</strong>
          <strong className="row-end"><Amount value={expense.shares[member.id]} /></strong></div>
      )}</div>
    </section>
    {!data.trip.closed && !expense.voided && (voiding
      ? <form className="card field-card" onSubmit={voidExpense}>
        <p>Hủy khoản chi {money(expense.amount)} và tính lại số dư của nhóm.</p>
        <label>Lý do hủy<input name="reason" maxLength={160} autoFocus required /></label>
        <div className="button-pair"><button type="button" className="secondary-button" onClick={() => setVoiding(false)}>Quay lại</button><button className="danger-button">Xác nhận hủy</button></div>
      </form>
      : <div className="button-pair"><a className="secondary-button" href={`#sua-khoan-chi/${expense.id}`}><Pencil size={17} aria-hidden /> Sửa khoản chi</a>
        <button className="danger-button" onClick={() => setVoiding(true)}><Trash2 size={17} aria-hidden /> Hủy khoản chi</button></div>
    )}
  </div>;
}
