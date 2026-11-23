'use client';

import { useEffect, useState } from 'react';
import type { Receipt } from './model';
import { PaymentImage } from './payments';
import type { ReceiptActions } from './trip-command';
import { withVietQrAmount } from './vietqr';
import { prepareQrShare, QrShareActions, type PreparedQrShare, type QrShareInfo } from './qr-share';

async function readQr(src: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(src, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('IMAGE_UNAVAILABLE');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.src = url;
    await image.decode();
    if (signal.aborted || !image.naturalWidth || image.naturalWidth * image.naturalHeight > 4_000_000) throw new Error('IMAGE_UNAVAILABLE');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('IMAGE_UNAVAILABLE');
    context.drawImage(image, 0, 0);
    const { default: jsQR } = await import('jsqr');
    const code = jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    if (!code) throw new Error('QR_UNREADABLE');
    return code.data;
  } finally { URL.revokeObjectURL(url); }
}

export function TransferQr({ receipt, actions, amount, label, shareInfo }: { receipt: Receipt; actions?: ReceiptActions; amount: number; label: string; shareInfo?: QrShareInfo }) {
  const [result, setResult] = useState<{ source: string; amount: number; shareKey: string; src?: string; shared?: PreparedQrShare; failed?: boolean }>();
  const [attempt, retry] = useState(0);
  const source = receipt.id + ':' + (receipt.src ?? '');
  const shareKey = JSON.stringify(shareInfo ?? null);
  useEffect(() => {
    let current = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20_000);
    async function generate() {
      try {
        const original = receipt.src ?? await actions?.view(receipt.id);
        if (!original || !current) throw new Error('IMAGE_UNAVAILABLE');
        const payload = withVietQrAmount(await readQr(original, controller.signal), amount);
        const { default: qr } = await import('qrcode');
        const src = await qr.toDataURL(payload, { width: 512, margin: 4, errorCorrectionLevel: 'M' });
        const shared = shareInfo ? await prepareQrShare(src, shareInfo, amount) : undefined;
        if (current) setResult({ source, amount, shareKey, src, shared });
      } catch { if (current) setResult({ source, amount, shareKey, failed: true }); }
      finally { clearTimeout(timeout); }
    }
    setResult(undefined); void generate();
    return () => { current = false; controller.abort(); clearTimeout(timeout); };
  }, [receipt.id, receipt.src, source, actions, amount, shareKey, attempt]);
  // Never show a previous recipient's QR while the current image/amount is loading.
  const active = result?.source === source && result.amount === amount && result.shareKey === shareKey ? result : undefined;
  if (active?.failed) return <div className="field-card">
    <p role="status">Chưa tạo được QR có sẵn số tiền từ ảnh này. Bạn có thể dùng QR gốc bên dưới và nhập đúng số tiền cần chuyển trong ứng dụng ngân hàng.</p>
    <PaymentImage receipt={receipt} actions={actions} label={label} />
    <button type="button" className="text-button" onClick={() => retry(value => value + 1)}>Thử tạo QR lại</button>
  </div>;
  return <div className={'payment-image transfer-qr' + (shareInfo ? ' transfer-qr-share' : '')}>
    {!active?.src ? <p role="status">Đang tạo QR có sẵn số tiền…</p> : <>
      <img src={active.shared?.src ?? active.src} alt={label} width={active.shared ? 900 : 512} height={active.shared ? 1400 : 512} />
      {active.shared ? <QrShareActions key={source + amount + shareKey} prepared={active.shared} /> : <a className="primary-button compact" href={active.src} download={'sharebill-' + amount + '.png'}>Tải QR có sẵn số tiền</a>}
      <details className="payment-help"><summary>Cách quét QR trong ngân hàng</summary><p>QR đã kèm tài khoản người nhận và {new Intl.NumberFormat('vi-VN').format(amount)}đ. Tải ảnh, mở ứng dụng ngân hàng → Quét QR → Chọn ảnh từ thư viện.</p></details>
    </>}
  </div>;
}
