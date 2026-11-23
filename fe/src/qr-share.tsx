'use client';

import { useRef, useState } from 'react';
import { money } from './model';

export type QrShareInfo = { group: string; from: string; to: string; context?: string; url: string };
export type PreparedQrShare = { src: string; file: File; text: string };

function drawLines(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineHeight: number, limit = 2) {
  const words = Array.from(text.replace(/\s+/g, ' ').trim());
  const lines: string[] = []; let line = '';
  for (const character of words) {
    if (ctx.measureText(line + character).width > width && line) { lines.push(line.trim()); line = ''; }
    line += character;
  }
  if (line) lines.push(line.trim());
  lines.slice(0, limit).forEach((value, index) => {
    let label = value;
    if (index === limit - 1 && lines.length > limit) {
      while (label && ctx.measureText(label + '…').width > width) label = label.slice(0, -1);
      label += '…';
    }
    ctx.fillText(label, x, y + index * lineHeight);
  });
}

/** One bank QR per PNG, with the payer and amount printed outside its quiet zone. */
export async function prepareQrShare(qrSrc: string, info: QrShareInfo, amount: number): Promise<PreparedQrShare> {
  await document.fonts.ready;
  const image = new Image(); image.src = qrSrc; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 1400;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Chưa tạo được ảnh chia sẻ.');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 900, 1400);
  ctx.fillStyle = '#006c62'; ctx.fillRect(0, 0, 900, 138);
  ctx.fillStyle = '#ffffff'; ctx.font = '700 40px sans-serif'; ctx.fillText('ShareBill', 56, 62);
  ctx.font = '24px sans-serif'; drawLines(ctx, info.group, 56, 105, 788, 30, 1);
  ctx.fillStyle = '#14243a'; ctx.font = '600 27px sans-serif';
  drawLines(ctx, info.context ?? 'Quyết toán chi tiêu của nhóm', 56, 188, 788, 36);
  ctx.fillStyle = '#53647a'; ctx.font = '22px sans-serif'; ctx.fillText('NGƯỜI CHUYỂN', 56, 278);
  ctx.fillStyle = '#14243a'; ctx.font = '600 32px sans-serif'; drawLines(ctx, info.from, 56, 324, 788, 38);
  ctx.fillStyle = '#53647a'; ctx.font = '22px sans-serif'; ctx.fillText('NGƯỜI NHẬN', 56, 410);
  ctx.fillStyle = '#14243a'; ctx.font = '600 32px sans-serif'; drawLines(ctx, info.to, 56, 456, 788, 38);
  ctx.fillStyle = '#53647a'; ctx.font = '24px sans-serif'; ctx.fillText('SỐ TIỀN CẦN CHUYỂN', 56, 548);
  ctx.fillStyle = '#006c62'; ctx.font = '700 64px sans-serif'; ctx.fillText(money(amount), 56, 626);
  ctx.imageSmoothingEnabled = false; ctx.drawImage(image, 194, 650, 512, 512);
  ctx.fillStyle = '#53647a'; ctx.font = '22px sans-serif';
  ctx.fillText('Quét ảnh bằng ứng dụng ngân hàng.', 56, 1210);
  ctx.font = '20px sans-serif';
  ctx.fillText('Số còn nợ đã trừ tiền ứng và các khoản đã xác nhận.', 56, 1250);
  ctx.fillText('Đối chiếu số dư hiện tại trong ShareBill trước khi chuyển.', 56, 1284);
  ctx.font = '18px sans-serif';
  ctx.fillText('Tạo lúc ' + new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }), 56, 1344);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Chưa tạo được ảnh chia sẻ.')), 'image/png'));
  const safeName = info.from.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'thanh-vien';
  return { src: canvas.toDataURL('image/png'), file: new File([blob], 'sharebill-' + safeName + '-' + amount + '.png', { type: 'image/png' }),
    text: [info.group, info.context, info.from + ' chuyển ' + money(amount) + ' cho ' + info.to + '.',
      'Số còn nợ hiện tại, đã trừ tiền ứng và các khoản đã xác nhận.', 'Kiểm tra số dư trước khi chuyển: ' + info.url].filter(Boolean).join('\n') };
}

export function QrShareActions({ prepared }: { prepared: PreparedQrShare }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const locked = useRef(false);
  async function share() {
    if (locked.current) return;
    const data: ShareData = { files: [prepared.file], title: 'ShareBill · QR chuyển tiền', text: prepared.text };
    if (!navigator.share || !navigator.canShare?.({ files: data.files })) {
      setMessage('Thiết bị chưa hỗ trợ chia sẻ ảnh trực tiếp. Bấm Tải ảnh gửi Zalo rồi chọn ảnh trong nhóm Zalo.'); return;
    }
    locked.current = true; setBusy(true); setMessage('');
    try { await navigator.share(data); setMessage('Đã mở chia sẻ ảnh. Kiểm tra nhóm nhận trong Zalo.'); }
    catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setMessage('Chưa chia sẻ được ảnh. Bạn có thể tải ảnh rồi gửi vào nhóm Zalo.');
    } finally { locked.current = false; setBusy(false); }
  }
  return <div className="qr-share-actions">
    <button type="button" className="primary-button" disabled={busy} onClick={() => void share()}>Chia sẻ ảnh</button>
    <a className="secondary-button" href={prepared.src} download={prepared.file.name}>Tải ảnh gửi Zalo</a>
    <button type="button" className="text-button" onClick={async () => {
      try { await navigator.clipboard.writeText(prepared.text); setMessage('Đã sao chép nội dung. Dán vào nhóm Zalo cùng ảnh QR.'); }
      catch { setManualCopy(true); setMessage('Chọn và sao chép nội dung bên dưới để gửi cùng ảnh QR.'); }
    }}>Sao chép nội dung gửi nhóm</button>
    <p>Chọn Zalo và nhóm cần gửi trong bảng chia sẻ. Nếu không thấy Zalo, tải ảnh rồi đính kèm trong nhóm.</p>
    {message && <p role="status">{message}</p>}
    {manualCopy && <label>Nội dung gửi nhóm Zalo<textarea readOnly value={prepared.text} rows={6} /></label>}
  </div>;
}
