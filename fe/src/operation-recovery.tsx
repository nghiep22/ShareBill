'use client';

import { useState, useSyncExternalStore } from 'react';
import { ApiError, type CompletedOperation, type ShareBillApi } from './api-client';
import type { PendingOperation } from './pending-operations';
import { tripRoute } from './workspace-route';

const noOperations: PendingOperation[] = [];

function resultLink(result: CompletedOperation) {
  if (result.resourceType === 'supportTicket') return '#tro-giup/' + result.resourceId;
  if (!result.tripId) return '#chuyen-di';
  const screens: Record<string, string> = {
    expense: 'khoan-chi', settlement: 'quyet-toan', itinerary: 'lich-trinh',
    participant: 'thanh-vien', membership: 'thanh-vien', invite: 'loi-moi',
  };
  return '#' + tripRoute(result.tripId, screens[result.resourceType] ?? 'tong-quan',
    result.resourceType === 'expense' ? result.resourceId : undefined);
}

export function PendingOperations({ api, busy }: { api: ShareBillApi; busy: boolean }) {
  const entries = useSyncExternalStore(api.subscribePending, api.pending, () => noOperations);
  const persistent = useSyncExternalStore(api.subscribePending, api.recoveryPersisted, () => true);
  const [checking, setChecking] = useState('');
  const [result, setResult] = useState<{ key: string; data: CompletedOperation }>();
  const [message, setMessage] = useState('');

  async function check(key: string) {
    setChecking(key);
    setResult(undefined);
    setMessage('');
    try {
      const data = await api.checkOperation(key);
      setResult({ key, data });
      setMessage('Máy chủ đã lưu thao tác này.');
    } catch (cause) {
      setMessage(cause instanceof ApiError && cause.code === 'OPERATION_UNKNOWN'
        ? 'Máy chủ chưa xác nhận kết quả. Bạn có thể gửi lại cùng nội dung trong tab này.'
        : cause instanceof Error ? cause.message : 'Chưa tra được kết quả.');
    } finally {
      setChecking('');
    }
  }

  if ((!entries.length || busy) && persistent) return null;
  return <section className="inline-note" aria-label="Khôi phục thao tác">
    {!persistent && <p>Tab này chỉ theo dõi thao tác trong bộ nhớ. Hãy giữ tab mở khi đang chờ kết quả.</p>}
    {entries.length > 0 && !busy && <details>
      <summary>{entries.length} thao tác chưa rõ kết quả</summary>
      <p>Kiểm tra kết quả trước khi nhập lại giao dịch.</p>
      {entries.map(entry => <div className="workspace-notice" key={entry.key}>
        <time dateTime={new Date(entry.startedAt).toISOString()}>{new Date(entry.startedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</time>
        {result?.key === entry.key ? <a className="text-button" href={resultLink(result.data)} onClick={() => {
          api.acknowledgeOperation(entry.key);
          setResult(undefined);
          setMessage('');
        }}>Mở kết quả đã lưu</a> : <button className="text-button" disabled={Boolean(checking)} onClick={() => void check(entry.key)}>
          {checking === entry.key ? 'Đang kiểm tra…' : 'Kiểm tra kết quả'}
        </button>}
      </div>)}
      {message && <p role="status">{message}</p>}
    </details>}
  </section>;
}
