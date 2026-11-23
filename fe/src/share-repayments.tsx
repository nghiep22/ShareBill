'use client';

import { useState } from 'react';
import { financialSnapshot, validSuggestions } from './finance-view';
import { canWrite, memberFor, nameOf, type Demo } from './model';
import type { ReceiptActions } from './trip-command';
import { TransferQr } from './transfer-qr';
import { Amount, Dialog } from './ui';
import { tripHref } from './workspace-route';

export function ShareRepaymentQrs({ data, actions, context, disabled }: { data: Demo; actions?: ReceiptActions; context?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  if (!data.remote || !canWrite(data)) return null;
  const finance = financialSnapshot(data), ready = finance.complete && data.remote.suggestionsReady === true && !disabled;
  const transfers = ready ? validSuggestions(data) : [];
  const pending = data.remote.pendingTransfers ?? [];
  const blocked = (from: string, to: string) => pending.some(item => item.from === from && item.to === to);
  const chosen = transfers.find(item => item.from + '/' + item.to === selected && !blocked(item.from, item.to));
  const receiver = chosen && memberFor(data, chosen.to);
  return <>
    <button type="button" className="secondary-button compact" disabled={disabled} onClick={() => { setSelected(''); setOpen(true); }}>Chia sẻ QR qua Zalo</button>
    {open && <Dialog title="QR trả tiền cho từng người" onClose={() => setOpen(false)} summary={chosen && <section className="payment-amount share-chosen">
      <span>Số tiền còn cần chuyển</span><strong><Amount value={chosen.amount} /></strong><span>{nameOf(data, chosen.from)} → {nameOf(data, chosen.to)}</span>
    </section>} footer={<div className="button-pair">
      {chosen && <button type="button" className="secondary-button" onClick={() => setSelected('')}>Chọn người khác</button>}
      <button type="button" className="secondary-button" onClick={() => setOpen(false)}>Xong</button>
    </div>}>
      {context && <p className="payment-caption">{context}</p>}
      {!chosen && <p>Chọn người cần trả. QR dùng số còn nợ hiện tại, đã trừ tiền ứng và các khoản đã xác nhận.</p>}
      {!ready ? <p role="status">Đang cập nhật số tiền cần chuyển. Chờ đồng bộ hoặc mở lại sau khi làm mới dữ liệu.</p> : chosen ? <>
        {receiver?.paymentQrReceiptId ? <TransferQr key={chosen.from + '/' + chosen.to} receipt={{ id: receiver.paymentQrReceiptId, name: 'QR người nhận' }} actions={actions}
          amount={chosen.amount} label={'QR ' + nameOf(data, chosen.from) + ' chuyển cho ' + nameOf(data, chosen.to)}
          shareInfo={{ group: data.trip.name, from: nameOf(data, chosen.from), to: nameOf(data, chosen.to), context,
            url: new URL(tripHref(data, 'so-du'), window.location.origin + '/').href }} />
          : <p role="status">{nameOf(data, chosen.to)} chưa thêm QR nhận tiền. Người nhận cần vào Thành viên → QR nhận tiền của bạn để tải QR ngân hàng.</p>}
      </> : transfers.length ? <div className="share-recipient-list">{transfers.map(item => <section className="field-card share-recipient" key={item.from + '/' + item.to} aria-label={'Khoản cần trả của ' + nameOf(data, item.from)}>
        <strong>{nameOf(data, item.from)} → {nameOf(data, item.to)}</strong><Amount value={item.amount} />
        {blocked(item.from, item.to) ? <>
          <p>Cặp này có khoản đang chờ xác nhận. Xử lý khoản cũ trước khi chia sẻ QR yêu cầu chuyển thêm.</p>
          <a className="text-button" href={tripHref(data, 'quyet-toan') + '?status=pending'}>Xem khoản đang chờ</a>
        </> : <button type="button" className="secondary-button" onClick={() => setSelected(item.from + '/' + item.to)}>Tạo QR cho {nameOf(data, item.from)}</button>}
      </section>)}</div> : <p>Nhóm hiện không còn khoản cần chuyển để tạo QR.</p>}
      <details className="payment-help"><summary>Cách tính tiền và gửi QR</summary><p>QR dùng số còn nợ hiện tại của cả nhóm, đã trừ tiền ứng và các khoản đã xác nhận. Chia sẻ QR chưa ghi nhận đã chuyển tiền. Người chuyển vẫn cần gửi bill sau khi chuyển.</p></details>
    </Dialog>}
  </>;
}
