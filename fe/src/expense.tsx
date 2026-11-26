'use client';

import { Camera, Check, ImagePlus, Pencil, ReceiptText, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  canEditExpense, canWrite, categories, dateLabel, money, nameOf, newId, ownerOf, record, sharingMembers, splitEqually, today, viewerOf,
  type Category, type Demo, type Expense, type Receipt,
} from './model';
import { Amount, Avatar, CategoryIcon, CategorySelect, Dialog, PageTitle } from './ui';
import type { ReceiptActions, UpdateTrip } from './trip-command';
import { tripHref } from './workspace-route';
import { maximumMoney as maximum, parseMoney } from './money-input';
import { clearExpenseDraft, getExpenseDraft, saveExpenseDraft, type DeviceScope, type ExpenseDraft } from './private-device';
import { PaymentImage } from './payments';
import { ShareRepaymentQrs } from './share-repayments';
import { expenseShares } from './expense-sharing';

const receiptTypes = ['image/jpeg', 'image/png', 'image/webp'];

async function readReceipt(file: File): Promise<Receipt> {
  const incoming = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = incoming;
    await image.decode();
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Không mở được ảnh.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { id: newId(), name: file.name, src: canvas.toDataURL('image/jpeg', 0.88) };
  } finally {
    URL.revokeObjectURL(incoming);
  }
}

function expenseFields(expense?: Expense, timezone?: string) {
  return { title: expense?.title ?? '', date: expense?.date ?? today(timezone), category: expense?.category ?? 'other' as Category, note: expense?.note ?? '' };
}

export function ExpenseForm({ data, expense: latest, update, receiptActions, disabled, device }: {
  data: Demo; expense?: Expense; update: UpdateTrip; receiptActions?: ReceiptActions; disabled?: boolean; device?: DeviceScope;
}) {
  const [expense, setExpense] = useState(latest);
  const [fields, setFields] = useState(() => expenseFields(expense, data.trip.timezone));
  const conflict = Boolean(expense && latest && latest.version !== expense.version);
  const writable = canWrite(data);
  const back = expense ? tripHref(data, 'khoan-chi', expense.id) : tripHref(data, 'chi-tieu');
  const me = viewerOf(data);
  const groupEqual = data.remote?.sharingMode === 'group-equal';
  const [customSplit, setCustomSplit] = useState(!groupEqual || !expense || expense.sharingScope === 'selected');
  const automatic = groupEqual && !customSplit;
  const active = sharingMembers(data);
  const [amount, setAmount] = useState(expense ? String(expense.amount) : '');
  const [payer, setPayer] = useState(expense?.payer ?? (active.some(member => member.id === me) ? me : ''));
  const [selectedMode, setMode] = useState(expense?.mode ?? 'equal');
  const mode = automatic ? 'equal' : selectedMode;
  const [selected, setSelected] = useState<string[]>(expense ? Object.keys(expense.shares) : active.map(member => member.id));
  const eligible = data.members.filter(member => (groupEqual ? active.some(person => person.id === member.id) : !member.inactive) ||
    selected.includes(member.id) || expense?.payer === member.id || member.id in (expense?.shares ?? {}));
  const [exact, setExact] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(expense?.shares ?? {}).map(([id, share]) => [id, String(share)])),
  );
  const [receipts, setReceipts] = useState(expense?.receipts ?? []);
  const [image, setImage] = useState<Receipt | null>(null);
  const [reading, setReading] = useState(false);
  const [receiptError, setReceiptError] = useState('');
  const [progress, setProgress] = useState('');
  const retryFile = useRef<File[]>([]);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [outsideDate, setOutsideDate] = useState<Expense>();
  const filePicker = useRef<HTMLInputElement>(null);
  const cameraPicker = useRef<HTMLInputElement>(null);
  const [draftChecking, setDraftChecking] = useState(Boolean(device));
  const [savedDraft, setSavedDraft] = useState<{ value: ExpenseDraft; at: number }>();
  const [draftError, setDraftError] = useState(false);
  const firstForm = useRef<ExpenseDraft>({ fields, amount, payer, mode, selected, exact });
  const ids = (automatic ? active : eligible.filter(member => selected.includes(member.id))).map(member => member.id);
  if (data.remote) ids.sort();
  const total = Number(amount);
  const originalSplit = !automatic && expense && total === expense.amount && mode === expense.mode &&
    ids.length === Object.keys(expense.shares).length && ids.every(id => id in expense.shares);
  const shares = mode === 'exact' ? Object.fromEntries(ids.map(id => [id, Number(exact[id] ?? 0)])) :
    originalSplit ? expense.shares : splitEqually(total, ids);
  const assigned = Object.values(shares).reduce((sum, share) => sum + share, 0);
  const difference = total - assigned;

  useEffect(() => {
    if (!device) return;
    let active = true;
    getExpenseDraft(device).then(draft => { if (active) setSavedDraft(draft); }, () => {
      if (active) setDraftError(true);
    }).finally(() => { if (active) setDraftChecking(false); });
    return () => { active = false; };
  }, [device]);

  useEffect(() => {
    if (!device || draftChecking || savedDraft || !writable) return;
    const draft = { fields, amount, payer, mode, selected, exact };
    if (JSON.stringify(draft) === JSON.stringify(firstForm.current)) return;
    let active = true;
    saveExpenseDraft(device, draft).catch(() => { if (active) setDraftError(true); });
    return () => { active = false; };
  }, [device, draftChecking, savedDraft, fields, amount, payer, mode, selected, exact, writable]);

  if (!writable || (latest && !canEditExpense(data, latest) && !conflict)) {
    return <PageTitle title="Khoản chi chỉ có thể xem" back={back} />;
  }

  function loadVersion(keepChanges: boolean) {
    if (!expense || !latest || reading) return;
    const start = expenseFields(expense);
    const server = expenseFields(latest);
    setFields({
      title: keepChanges && fields.title !== start.title ? fields.title : server.title,
      date: keepChanges && fields.date !== start.date ? fields.date : server.date,
      category: keepChanges && fields.category !== start.category ? fields.category : server.category,
      note: keepChanges && fields.note !== start.note ? fields.note : server.note,
    });
    const changedShares = automatic ? total !== expense.amount || payer !== expense.payer :
      groupEqual && expense.sharingScope !== 'selected' ||
      !originalSplit || payer !== expense.payer || Object.entries(shares).some(([id, share]) => expense.shares[id] !== share);
    if (!keepChanges || !changedShares) {
      setAmount(String(latest.amount));
      setPayer(latest.payer);
      setMode(latest.mode);
      setSelected(Object.keys(latest.shares));
      setExact(Object.fromEntries(Object.entries(latest.shares).map(([id, share]) => [id, String(share)])));
      setCustomSplit(!groupEqual || latest.sharingScope === 'selected');
    }
    const originalIds = new Set(expense.receipts?.map(item => item.id));
    const localIds = new Set(receipts.map(item => item.id));
    const additions = receipts.filter(item => !originalIds.has(item.id));
    const current = latest.receipts ?? [];
    setReceipts(keepChanges ? [...current.filter(item => !originalIds.has(item.id) || localIds.has(item.id)),
      ...additions.filter(item => !current.some(serverItem => serverItem.id === item.id))] : current);
    setExpense(latest);
    if (!keepChanges || !changedShares) setInvalid([]);
    setError('');
  }

  function enterMoney(field: string, value: string, set: (value: string) => void) {
    const parsed = parseMoney(value);
    setInvalid(current => parsed === undefined ? [...new Set([...current, field])] : current.filter(id => id !== field));
    if (parsed !== undefined) set(parsed);
  }

  async function addImages(files: File[]) {
    if (!files.length || reading || disabled) return;
    setReceiptError('');
    if (data.remote && !receiptActions) { setReceiptError('Cần kết nối mạng để tải ảnh hóa đơn.'); return; }
    if (receipts.length + files.length > 3) { setReceiptError('Chọn tối đa 3 ảnh cho mỗi khoản chi.'); return; }
    if (files.some(file => !receiptTypes.includes(file.type) || file.size === 0 || file.size > 5 * 1024 * 1024)) {
      setReceiptError('Chọn ảnh JPG, PNG hoặc WebP có dung lượng tối đa 5 MiB mỗi ảnh.');
      return;
    }
    setReading(true);
    setProgress('Đang chuẩn bị ảnh…');
    retryFile.current = [...files];
    try {
      for (const file of files) {
        const receipt = receiptActions ? await receiptActions.upload(file, setProgress) : await readReceipt(file);
        retryFile.current.shift();
        setReceipts(current => [...current, receipt]);
      }
    } catch (cause) {
      setReceiptError(cause instanceof Error && receiptActions ? cause.message : 'Ảnh không đọc được. Hãy chọn một ảnh khác.');
    } finally {
      setReading(false);
    }
  }

  function attach(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    void addImages(files);
  }

  async function removeReceipt(receipt: Receipt) {
    setReceiptError('');
    setReading(true);
    setProgress('Đang bỏ ảnh…');
    try {
      if (receipt.version) await receiptActions?.discard(receipt);
      setReceipts(previous => previous.filter(item => item.id !== receipt.id));
    } catch (cause) {
      setReceiptError(cause instanceof Error ? cause.message : 'Chưa bỏ được ảnh.');
    } finally {
      setReading(false);
    }
  }

  function persist(item: Expense) {
    if (disabled || conflict) return;
    const changes = expense && expense.amount !== item.amount ? money(expense.amount) + ' → ' + money(item.amount) : money(item.amount);
    update(record({
      ...data,
      expenses: expense ? data.expenses.map(entry => entry.id === expense.id ? item : entry) : [item, ...data.expenses],
    }, expense ? 'Sửa khoản chi' : 'Thêm khoản chi', item.title + ' · ' + changes, '#khoan-chi/' + item.id),
    { type: 'save-expense', expense: item, previous: expense }, id => {
      setOutsideDate(undefined);
      window.location.hash = tripHref(data, 'khoan-chi', id ?? item.id);
    });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reading || disabled || conflict) return;
    const title = fields.title.trim();
    const moneyError = invalid.some(id => id === 'amount' || (mode === 'exact' && selected.includes(id)));
    if (moneyError) { setError('Sửa số tiền chưa đúng định dạng.'); return; }
    if (!title || !payer || total < 1 || total > maximum || !ids.length || difference !== 0 || receipts.length > 3 || Object.values(shares).some(share => share < (data.remote ? 0 : 1))) {
      if (receipts.length > 3) { setError('Giữ tối đa 3 ảnh trước khi lưu.'); return; }
      setError('Kiểm tra tên, người trả, số tiền và phần chia. Tổng phần chia cần khớp số tiền đã trả.');
      return;
    }
    const sameSplit = expense && (automatic ? total === expense.amount && payer === expense.payer :
      originalSplit && payer === expense.payer && ids.every(id => shares[id] === expense.shares[id]));
    const validPeople = automatic ? payer === expense?.payer || active.some(member => member.id === payer) :
      sameSplit || [payer, ...selected].every(id => active.some(member => member.id === id) ||
        expense && (id === payer && id === expense.payer || shares[id] === expense.shares[id] && id in expense.shares));
    if (!validPeople) {
      setError('Chọn người trả và người chia đang hoạt động để thay đổi số tiền hoặc cách chia.');
      return;
    }

    const item: Expense = {
      id: expense?.id ?? newId(), title, payer, amount: total,
      mode: automatic && sameSplit ? expense.mode : mode,
      shares: automatic && sameSplit ? expense.shares : shares, receipts,
      ...(groupEqual && !automatic && { sharingScope: 'selected' as const }),
      date: fields.date, category: fields.category, note: fields.note.trim(),
      createdBy: expense ? (expense.createdBy ?? ownerOf(data)) : me, editedBy: expense ? me : undefined,
    };
    if (data.remote && item.date !== expense?.date &&
        ((data.trip.start && item.date < data.trip.start) || (data.trip.end && item.date > data.trip.end))) {
      setOutsideDate(item);
      return;
    }
    persist(item);
  }

  return <div className="form-page">
    <PageTitle title={expense ? 'Sửa khoản chi' : 'Thêm khoản chi'} description={data.trip.name} back={back} />
    {device && savedDraft && <section className="card field-card">
      <h2>Bản nháp trên thiết bị</h2>
      <p>Cập nhật lúc {new Date(savedDraft.at).toLocaleString('vi-VN')}. Kiểm tra lại người trả, người chia và số tiền trước khi gửi.</p>
      <div className="button-pair">
        <button className="secondary-button" onClick={() => {
          const value = savedDraft.value;
          setFields(value.fields);
          setAmount(value.amount);
          setPayer(value.payer);
          setMode(value.mode);
          const allowed = value.selected.filter(id => active.some(member => member.id === id));
          setSelected(allowed);
          if (allowed.length !== value.selected.length) setError('Danh sách người chia đã thay đổi. Hãy kiểm tra phần chia trước khi gửi.');
          setExact(value.exact);
          setInvalid([]);
          setSavedDraft(undefined);
        }}>Tiếp tục bản nháp</button>
        <button className="text-button" onClick={() => {
          void clearExpenseDraft(device).then(() => setSavedDraft(undefined), () => setDraftError(true));
        }}>Xóa bản nháp</button>
      </div>
    </section>}
    {device && draftError && <p className="inline-note error" role="status">Thiết bị chưa lưu hoặc đọc được bản nháp. Bản nhập vẫn ở tab này; hãy giữ tab mở tới khi lưu khoản chi thành công.</p>}
    {conflict && latest && <section className="card field-card" aria-label="Xung đột khoản chi">
      <h2>Bản trên máy chủ đã thay đổi</h2>
      <p>Bản nhập vẫn ở bên dưới. Hãy chọn dữ liệu để tiếp tục, rồi kiểm tra trước khi lưu.</p>
      <details open><summary>Bản mới nhất trên máy chủ</summary>
        <p>{latest.title} · {money(latest.amount)} · {dateLabel(latest.date)} · {categories[latest.category]}</p>
        <p>{nameOf(data, latest.payer)} đã trả · {latest.mode === 'equal' ? 'Chia đều' : 'Nhập riêng'}</p>
        <ul>{Object.entries(latest.shares).map(([id, share]) => <li key={id}>{nameOf(data, id)} · {money(share)}</li>)}</ul>
        {latest.note && <p>{latest.note}</p>}
        <p>{latest.receipts?.length ?? 0} ảnh hóa đơn</p>
      </details>
      {canEditExpense(data, latest) ? <div className="button-pair">
        <button className="secondary-button" type="button" disabled={reading || disabled} onClick={() => loadVersion(false)}>Dùng bản máy chủ</button>
        <button className="primary-button" type="button" disabled={reading || disabled} onClick={() => loadVersion(true)}>Áp lại phần tôi đã sửa</button>
      </div> : <p>Khoản chi hiện chuyển sang chế độ chỉ xem.</p>}
    </section>}
    <form className="form-stack" onSubmit={save}>
      <div className="card field-card">
        <label htmlFor="expense-amount">Số tiền đã trả</label>
        <div className="money-field">
          <input id="expense-amount" placeholder="0" inputMode="numeric" value={amount} required aria-invalid={invalid.includes('amount')}
            onChange={e => enterMoney('amount', e.target.value, setAmount)} />
          <span>VND</span>
        </div>
        {invalid.includes('amount') && <p className="error" role="alert">Nhập số nguyên, ví dụ 150.000.</p>}
        <label>Tên khoản chi<input name="title" placeholder="Ví dụ: Ăn tối ở Đà Lạt" value={fields.title} onChange={event => setFields({ ...fields, title: event.target.value })} maxLength={120} required /></label>
      </div>
      <fieldset className="card field-card">
        <legend>Ai đã trả tiền?</legend>
        <div className="payer-options">
          {eligible.filter(member => active.some(person => person.id === member.id) || member.id === expense?.payer).map(member => <label className="payer-option" key={member.id}>
            <input type="radio" name="payer" value={member.id} checked={payer === member.id} onChange={() => setPayer(member.id)} />
            <Avatar member={member} /><span>{nameOf(data, member.id)}{member.id === me ? ' (bạn)' : ''}{!active.some(person => person.id === member.id) ? groupEqual ? ' · Đã rời nhóm' : ' · Ngừng dùng' : ''}</span>
          </label>)}
        </div>
      </fieldset>
      {automatic ? <section className="card field-card" aria-label="Chia đều tự động">
        <h2>Khoản cũ chia đều cho cả nhóm</h2>
        <p>Giữ cách chia cũ khi chỉ sửa nội dung. Chọn người riêng sẽ cập nhật phần chia và công nợ của khoản này.</p>
        <button type="button" className="secondary-button" onClick={() => { setSelected(active.map(member => member.id)); setMode('equal'); setCustomSplit(true); }}>Chọn người cho khoản này</button>
        <a className="text-button" href={tripHref(data, 'so-du')}>Xem số tiền của từng người</a>
      </section> : <fieldset className="card field-card">
        <legend>Chia cho ai?</legend>
        <div className="split-heading"><span>{ids.length} người được chia</span>
          <button type="button" className="text-button" onClick={() => setSelected(active.every(member => selected.includes(member.id)) ? selected.filter(id => !active.some(member => member.id === id)) : [...new Set([...selected, ...active.map(member => member.id)])])}>
            {active.every(member => selected.includes(member.id)) ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
          </button></div>
        <div className="segmented" aria-label="Cách chia">
          <button type="button" aria-pressed={mode === 'equal'} onClick={() => setMode('equal')}>Chia đều</button>
          <button type="button" aria-pressed={mode === 'exact'} onClick={() => {
            if (mode === 'equal' && !Object.keys(exact).length) setExact(Object.fromEntries(Object.entries(shares).map(([id, share]) => [id, String(share)])));
            setMode('exact');
          }}>Nhập từng phần</button>
        </div>
        <div className="split-list">
          {eligible.map(member => <div className="split-row" aria-label={'Phần chia dự kiến của ' + nameOf(data, member.id)} key={member.id}>
            <label><input type="checkbox" checked={selected.includes(member.id)} onChange={e =>
              setSelected(e.target.checked ? [...selected, member.id] : selected.filter(id => id !== member.id))
            } /><Avatar member={member} /> {nameOf(data, member.id)}{!active.some(person => person.id === member.id) && <small>{groupEqual ? 'Đã rời nhóm' : 'Ngừng dùng'}</small>}</label>
            {selected.includes(member.id) && (mode === 'equal'
              ? <strong><span className="split-caption">Phải chịu </span><Amount value={shares[member.id]} /></strong>
              : <input className="split-input" aria-label={'Phần chia của ' + nameOf(data, member.id)} aria-invalid={invalid.includes(member.id)} inputMode="numeric" placeholder="0"
                value={exact[member.id] ?? ''}
                onChange={e => enterMoney(member.id, e.target.value, value => setExact(current => ({ ...current, [member.id]: value })))} />
            )}
          </div>)}
        </div>
        {mode === 'equal' && ids.length > 0 && total > 0 && Number.isSafeInteger(total) && <p className="inline-note" aria-live="polite">
          {money(total)} chia đều {ids.length} người. Tổng phần chia {money(assigned)}.
          {total % ids.length !== 0 && ' Phần lẻ được phân bổ theo thứ tự thành viên cố định; chênh lệch tối đa 1đ.'}
        </p>}
        {mode === 'exact' && <p className={'inline-note ' + (difference ? 'error' : 'positive')} aria-live="polite">
          Đã chia {money(assigned)} / {money(total)}. {difference > 0 ? 'Còn thiếu ' + money(difference) : difference < 0 ? 'Vượt ' + money(-difference) : 'Tổng phần chia đã khớp.'}
        </p>}
      </fieldset>}
      <section className="card field-card" aria-label="Ảnh hóa đơn của khoản chi">
        <h2>Ảnh hóa đơn <span className="optional">(tùy chọn)</span></h2>
        <p>Tối đa 3 ảnh JPG, PNG hoặc WebP, mỗi ảnh tối đa 5 MiB.</p>
        <input type="file" accept={receiptTypes.join(',')} multiple hidden disabled={reading || disabled} ref={filePicker} onChange={attach} aria-label="Tệp ảnh hóa đơn" />
        <input type="file" accept={receiptTypes.join(',')} capture="environment" hidden disabled={reading || disabled} ref={cameraPicker} onChange={attach} aria-label="Máy ảnh hóa đơn" />
        {receipts.length > 0 && <div className="receipt-grid">{receipts.map(receipt => <div key={receipt.id} className="receipt-item">
          <PaymentImage receipt={receipt} actions={receiptActions} label={receipt.name} onOpen={() => setImage(receipt)} />
          <button type="button" className="icon-button receipt-remove" disabled={reading || disabled} aria-label={'Bỏ ảnh ' + receipt.name} onClick={() => void removeReceipt(receipt)}><X size={18} aria-hidden /></button>
        </div>)}</div>}
        {receipts.length < 3 && (!data.remote || receiptActions) && <div className="button-pair">
          <button type="button" className="secondary-button" disabled={reading || disabled} onClick={() => filePicker.current?.click()}><ImagePlus size={18} aria-hidden /> Tải ảnh hóa đơn</button>
          <button type="button" className="secondary-button" disabled={reading || disabled} onClick={() => cameraPicker.current?.click()}><Camera size={18} aria-hidden /> Chụp ảnh</button>
        </div>}
        {data.remote && !receiptActions && <p role="status">Cần kết nối mạng để tải ảnh hóa đơn.</p>}
        {reading && <p role="status">{progress}</p>}
        {receiptError && <p className="error" role="alert">{receiptError}</p>}
        {receiptError && receiptActions && retryFile.current.length > 0 &&
          <button type="button" className="secondary-button" disabled={reading || disabled} onClick={() => void addImages(retryFile.current)}>Thử tải ảnh lại</button>}
      </section>
      <details className="card optional-fields" open={!data.remote}>
        <summary>Thêm thông tin</summary>
        <div className="field-card">
        <div className="field-pair">
          <label>Ngày chi<input name="date" type="date" value={fields.date} onChange={event => setFields({ ...fields, date: event.target.value })} required /></label>
          <label>Danh mục<CategorySelect value={fields.category} onChange={category => setFields({ ...fields, category })} remote={Boolean(data.remote)} /></label>
        </div>
        <label><span>Ghi chú <span className="optional">(tùy chọn)</span></span><textarea name="note" value={fields.note} onChange={event => setFields({ ...fields, note: event.target.value })} maxLength={1000} rows={2} /></label>
        </div>
      </details>
      {error && <p className="inline-note error" role="alert">{error}</p>}
      <div className="form-action"><button className="primary-button" disabled={reading || disabled || conflict}><Check size={19} aria-hidden /> Lưu khoản chi{total > 0 && ' · ' + money(total)}</button></div>
    </form>
    {image && <Dialog title="Ảnh hóa đơn" onClose={() => setImage(null)}><PaymentImage receipt={image} actions={receiptActions} label={image.name} /></Dialog>}
    {outsideDate && <Dialog title="Ngày chi nằm ngoài ngày của chuyến" onClose={() => setOutsideDate(undefined)}>
      <p>Khoản chi ngày {dateLabel(outsideDate.date)} sẽ được ghi vào chuyến {data.trip.name}.</p>
      <div className="button-pair">
        <button className="secondary-button" onClick={() => setOutsideDate(undefined)}>Kiểm tra lại</button>
        <button className="primary-button" disabled={disabled || conflict} onClick={() => persist(outsideDate)}>Lưu với ngày này</button>
      </div>
    </Dialog>}
  </div>;
}

export function ExpenseDetail({ data, expense, update, receiptActions }: { data: Demo; expense: Expense; update: UpdateTrip; receiptActions?: ReceiptActions }) {
  const [voiding, setVoiding] = useState(false);
  const [image, setImage] = useState<Receipt | null>(null);
  const [error, setError] = useState('');
  const receipts = expense.receipts ?? [];
  const shares = expenseShares(data, expense);
  function voidExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason')).trim();
    if (!reason) { setError('Nhập lý do hủy khoản chi.'); return; }
    update(record({ ...data, expenses: data.expenses.map(entry => entry.id === expense.id ? { ...entry, voided: true, voidReason: reason } : entry) },
      'Hủy khoản chi', expense.title + ' · ' + money(expense.amount), '#khoan-chi/' + expense.id),
    { type: 'void-expense', expense, reason }, () => setVoiding(false));
  }

  return <div className="form-page detail-page">
    <PageTitle title="Chi tiết khoản chi" back={tripHref(data, 'chi-tieu')} />
    <section className="card field-card detail-summary">
      <CategoryIcon category={expense.category} />
      <h2>{expense.title}</h2><strong><Amount value={expense.amount} /></strong>
      <p>{nameOf(data, expense.payer)} đã trả · {dateLabel(expense.date)}</p>
      <span className={'tag ' + (expense.voided ? '' : 'mint')}>{expense.voided ? 'Đã hủy' : categories[expense.category]}</span>
      {expense.note && <p className="expense-note"><ReceiptText size={17} aria-hidden /> {expense.note}</p>}
      {expense.voidReason && <p>Lý do hủy: {expense.voidReason}</p>}
      <p>{expense.createdBy && 'Được tạo bởi ' + nameOf(data, expense.createdBy)}{expense.editedBy && ' · Sửa lần cuối bởi ' + nameOf(data, expense.editedBy)}</p>
    </section>
    <section className="card field-card" aria-label="Ảnh hóa đơn của khoản chi">
      <h2><ReceiptText size={18} aria-hidden /> Ảnh hóa đơn <span className="tag">{receipts.length}/3 ảnh</span></h2>
      {receipts.length ? <>
        <p>Bấm vào ảnh để xem hóa đơn.</p>
        <div className="receipt-grid">{receipts.map(receipt => <PaymentImage key={receipt.id} receipt={receipt} actions={receiptActions} label={receipt.name} onOpen={() => setImage(receipt)} />)}</div>
      </> : <p>Khoản chi này chưa có ảnh hóa đơn.</p>}
      {canEditExpense(data, expense) && <a className="secondary-button" href={tripHref(data, 'sua-khoan-chi', expense.id)}>
        <ImagePlus size={18} aria-hidden /> {receipts.length ? 'Quản lý ảnh hóa đơn' : 'Thêm ảnh hóa đơn'}
      </a>}
    </section>
    {!expense.voided && <ShareRepaymentQrs data={data} expense={expense} actions={receiptActions} context={'Khoản chi: ' + expense.title} />}
    <section>
      <div className="section-heading"><h2>Mỗi người phải chịu</h2><span className="tag">{expense.mode === 'equal' ? 'Chia đều' : 'Theo số tiền'}</span></div>
      {!shares && <p className="inline-note error" role="alert">Chưa đủ dữ liệu phần chia. Tải lại khoản chi để kiểm tra.</p>}
      <div className="card rows">{data.members.filter(member => shares && Object.hasOwn(shares, member.id)).map(member =>
        <div key={member.id} className="list-row" aria-label={'Phần phải chịu của ' + nameOf(data, member.id)}><Avatar member={member} /><span className="row-text"><strong>{nameOf(data, member.id)}{member.id === viewerOf(data) && ' (bạn)'}</strong><span>{member.id === expense.payer ? 'Người đã ứng tiền' : 'Phần được chia'}</span></span>
          <strong className="row-end"><Amount value={shares![member.id]} /></strong></div>
      )}</div>
      {data.remote?.sharingMode === 'group-equal' && expense.sharingScope !== 'selected' && <p className="inline-note">Khoản cũ vẫn chia đều cho các thành viên đang được tính trong nhóm. Phần lẻ của các khoản cũ được cân bằng trên tổng chi.</p>}
      <a className="text-button" href={tripHref(data, 'so-du')}>Xem số tiền còn cần trả / được nhận</a>
    </section>
    {canEditExpense(data, expense) && <div className="button-pair">
      <a className="secondary-button" href={tripHref(data, 'sua-khoan-chi', expense.id)}><Pencil size={17} aria-hidden /> Sửa khoản chi</a>
      <button className="danger-button" onClick={() => { setError(''); setVoiding(true); }}><Trash2 size={17} aria-hidden /> Hủy khoản chi</button>
    </div>}
    {voiding && <Dialog title="Hủy khoản chi?" onClose={() => setVoiding(false)}>
      <p>{nameOf(data, expense.payer)} đã trả {money(expense.amount)} cho khoản này. Số dư của nhóm sẽ được tính lại.</p>
      <form className="field-card dialog-fields" onSubmit={voidExpense}>
        <label>Lý do hủy<input name="reason" maxLength={300} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="button-pair"><button type="button" className="secondary-button" onClick={() => setVoiding(false)}>Quay lại</button><button className="danger-button">Xác nhận hủy</button></div>
      </form>
    </Dialog>}
    {image && <Dialog title="Ảnh hóa đơn" onClose={() => setImage(null)}><PaymentImage receipt={image} actions={receiptActions} label={image.name} /></Dialog>}
  </div>;
}
