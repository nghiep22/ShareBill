'use client';

import { Clipboard, Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { prepareInviteQrShare, QrShareActions, type PreparedQrShare } from './qr-share';

export function InviteShare({ url, group, expiresAt }: { url: string; group: string; expiresAt: string }) {
  const [prepared, setPrepared] = useState<PreparedQrShare>();
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(() => Date.parse(expiresAt) <= Date.now());
  const locked = useRef(false);

  useEffect(() => {
    const remaining = Date.parse(expiresAt) - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  useEffect(() => {
    let current = true;
    setPrepared(undefined); setFailed(false);
    if (!expired) void prepareInviteQrShare(url, group, expiresAt).then(result => {
      if (current) setPrepared(result);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [url, group, expiresAt, expired, attempt]);

  async function shareLink() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setNotice('');
    try {
      const data = { title: 'Mời vào chuyến đi ' + group, text: 'Mời bạn tham gia chuyến đi ' + group + ' trên ShareBill.', url };
      if (!navigator.share || (navigator.canShare && !navigator.canShare(data))) {
        setNotice('Thiết bị chưa hỗ trợ chia sẻ liên kết trực tiếp. Sao chép liên kết rồi mở Zalo để dán và gửi.'); return;
      }
      // Keep native sharing in the click handler, before any asynchronous work.
      await navigator.share(data);
      setNotice('Đã mở chia sẻ liên kết. Chọn Zalo và cuộc trò chuyện muốn mời.');
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setNotice('Chưa chia sẻ được liên kết. Sao chép liên kết rồi mở Zalo để gửi.');
    } finally { locked.current = false; setBusy(false); }
  }

  if (expired) return <p role="status">Lời mời đã hết hạn. Hãy tạo liên kết mới để chia sẻ.</p>;
  return <>
    <label>Đường dẫn tham gia<input value={url} readOnly onFocus={event => event.currentTarget.select()} /></label>
    <button type="button" className="primary-button" onClick={async () => {
      try { await navigator.clipboard.writeText(url); setNotice('Đã sao chép liên kết. Mở Zalo để dán và gửi.'); }
      catch { setNotice('Chọn đường dẫn bên trên để sao chép rồi dán vào Zalo.'); }
    }}><Clipboard size={18} aria-hidden /> Sao chép liên kết</button>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void shareLink()}><Share2 size={18} aria-hidden /> Chia sẻ liên kết qua Zalo</button>
    <a className="text-button" href="https://chat.zalo.me/" target="_blank" rel="noopener noreferrer">Mở Zalo để gửi liên kết</a>
    {notice && <p role="status">{notice}</p>}
    <h3>QR tham gia chuyến đi</h3>
    <p>Quét QR bằng camera điện thoại hoặc Zalo để mở lời mời. Đăng nhập rồi xác nhận tham gia chuyến đi.</p>
    {prepared ? <div className="payment-image invite-qr">
      <img src={prepared.src} alt={'QR mời tham gia chuyến đi ' + group} width={900} height={1120} />
      <QrShareActions prepared={prepared} />
    </div> : failed ? <>
      <p role="status">Chưa tạo được QR lời mời. Bạn vẫn có thể sao chép hoặc chia sẻ liên kết bên trên.</p>
      <button type="button" className="text-button" onClick={() => retry(value => value + 1)}>Thử tạo QR lời mời lại</button>
    </> : <p role="status">Đang tạo QR lời mời…</p>}
  </>;
}
