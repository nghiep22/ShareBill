'use client';

import { useEffect, useRef, useState } from 'react';
import { canWrite, memberFor, viewerOf, type Demo, type Receipt } from './model';
import type { ReceiptActions, UpdateTrip } from './trip-command';

export function PaymentImage({ receipt, actions, label, onOpen }: { receipt: Receipt; actions?: ReceiptActions; label: string; onOpen?: () => void }) {
  const [image, setImage] = useState<{ src?: string; error?: string }>({});
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let current = true;
    setImage({});
    if (receipt.src) setImage({ src: receipt.src });
    else if (actions) actions.view(receipt.id).then(src => { if (current) setImage({ src }); }, cause => {
      if (current) setImage({ error: cause instanceof Error ? cause.message : 'Chưa mở được ảnh.' });
    });
    else setImage({ error: 'Cần kết nối mạng để xem ảnh.' });
    return () => { current = false; };
  }, [receipt.id, receipt.src, actions, attempt]);
  return <div className="payment-image">
    {image.src && <>{onOpen ? <button type="button" className="receipt-thumb" aria-label={'Xem ảnh ' + label} onClick={onOpen}>
      <img src={image.src} alt={label} referrerPolicy="no-referrer" onError={() => setImage({ error: 'Ảnh đã hết hạn hoặc chưa tải được. Bấm thử lại để mở ảnh mới.' })} />
    </button> : <><img src={image.src} alt={label} referrerPolicy="no-referrer" onError={() => setImage({ error: 'Ảnh đã hết hạn hoặc chưa tải được. Bấm thử lại để mở ảnh mới.' })} />
      <a className="text-button" href={image.src} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Mở ảnh để lưu hoặc phóng to</a></>}</>}
    {!image.src && !image.error && <p role="status">Đang tải {label.toLocaleLowerCase('vi')}…</p>}
    {image.error && <><p className="error" role="alert">{image.error}</p><button type="button" className="secondary-button" onClick={() => retry(value => value + 1)}>Thử mở ảnh lại</button></>}
  </div>;
}

export function PaymentImagePicker({ receipt, onChange, actions, label, busy, onBusy, disabled }: {
  receipt?: Receipt; onChange: (receipt?: Receipt) => void; actions: ReceiptActions; label: string;
  busy: boolean; onBusy: (busy: boolean) => void; disabled?: boolean;
}) {
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const file = useRef<File | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  async function upload(selected: File) {
    if (locked.current || disabled) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type) || selected.size === 0 || selected.size > 5 * 1024 * 1024) {
      setError('Chọn ảnh JPG, PNG hoặc WebP, tối đa 5 MiB.'); return;
    }
    locked.current = true; file.current = selected; onBusy(true); setError('');
    try {
      const next = await actions.upload(selected, setProgress);
      onChange(next); file.current = null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa tải được ảnh.'); }
    finally { locked.current = false; onBusy(false); }
  }
  return <div className="field-card payment-picker">
    <label>{label}<input ref={picker} hidden type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled || busy || Boolean(receipt)} onChange={event => {
      const selected = event.target.files?.[0]; event.target.value = ''; if (selected) void upload(selected);
    }} /></label>
    {!receipt && <button type="button" className="secondary-button" disabled={disabled || busy} onClick={() => picker.current?.click()}>Chọn ảnh</button>}
    {receipt && <p className="payment-file-name" title={receipt.name}>Đã tải: {receipt.name}</p>}
    <small>JPG, PNG hoặc WebP, tối đa 5 MiB.</small>
    {busy && <p role="status">{progress}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {error && file.current && <button type="button" className="secondary-button" disabled={busy || disabled} onClick={() => void upload(file.current!)}>Thử tải ảnh lại</button>}
    {receipt && <><PaymentImage receipt={receipt} actions={actions} label={label} />
      <button type="button" className="text-button" disabled={busy || disabled} onClick={async () => {
        if (locked.current) return;
        locked.current = true; onBusy(true); setError('');
        try { await actions.discard(receipt); onChange(undefined); }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa bỏ được ảnh.'); }
        finally { locked.current = false; onBusy(false); }
      }}>Bỏ ảnh đã chọn</button></>}
  </div>;
}

export function PaymentQrCard({ data, update, actions, disabled }: { data: Demo; update: UpdateTrip; actions?: ReceiptActions; disabled?: boolean }) {
  const member = memberFor(data, viewerOf(data));
  const [editing, setEditing] = useState(false);
  const [receipt, setReceipt] = useState<Receipt>();
  const [busy, setBusy] = useState(false);
  if (!data.remote || !member) return null;
  const writable = canWrite(data) && member.uid === data.remote.actorUid && actions;
  return <section className="card field-card" aria-label="QR nhận tiền của bạn">
    <h2>QR nhận tiền của bạn</h2>
    {member.paymentQrReceiptId && !editing && <PaymentImage receipt={{ id: member.paymentQrReceiptId, name: 'QR nhận tiền' }} actions={actions} label="QR nhận tiền của bạn" />}
    {!member.paymentQrReceiptId && !editing && <p>Bạn chưa thêm QR nhận tiền.</p>}
    {writable && !editing && <button className="secondary-button" disabled={disabled} onClick={() => setEditing(true)}>{member.paymentQrReceiptId ? 'Đổi QR nhận tiền' : 'Thêm QR nhận tiền'}</button>}
    {writable && editing && <>
      <PaymentImagePicker receipt={receipt} onChange={setReceipt} actions={actions} label="Ảnh QR nhận tiền" busy={busy} onBusy={setBusy} disabled={disabled} />
      <div className="button-pair"><button className="secondary-button" disabled={busy || disabled} onClick={() => setEditing(false)}>Đóng</button>
        <button className="primary-button" disabled={!receipt || busy || disabled} onClick={() => { if (receipt) update(data, { type: 'save-payment-qr', member, receipt }, () => { setEditing(false); setReceipt(undefined); }); }}>Lưu QR nhận tiền</button></div>
    </>}
  </section>;
}
