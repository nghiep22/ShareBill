'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CircleCheck, LogOut, Plus, ReceiptText, RefreshCw, Scale, Users, WalletCards } from 'lucide-react';

const remoteApi = 'https://sharebill-api-staging.vercel.app';
const sessionKey = 'sharebill-live-session-v1';
const formatMoney = (value: number) => `${new Intl.NumberFormat('vi-VN').format(value)}đ`;
const localToday = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

type Session = { accessToken: string; refreshToken: string; expiresAt: number; user: { displayName: string; email: string } };
type Trip = { id: string; name: string; myParticipantId: string; role: string; totalExpenseMinor: number; participantCount: number };
type Participant = { id: string; displayName: string; status: string };
type Expense = { id: string; title: string; amountMinor: number; payerParticipantId: string; occurredOn: string; category: string; status: string };
type Overview = { trip: Trip; participants: Participant[]; balances: { participantId: string; netMinor: number }[]; ledgerVersion: number };
type Transfer = { fromParticipantId: string; toParticipantId: string; amountMinor: number };
type Settlement = Transfer & { id: string; status: 'pending' | 'confirmed' | 'cancelled' | 'void'; version: number; occurredOn: string };

function readSession(): Session | null {
  try {
    const value = sessionStorage.getItem(sessionKey);
    return value ? JSON.parse(value) as Session : null;
  } catch { return null; }
}

async function request<T>(path: string, body?: unknown, token?: string, key?: string, ifMatch?: number): Promise<T> {
  let response: Response;
  try {
    const api = ['localhost', '127.0.0.1'].includes(window.location.hostname) ? 'http://localhost:3001' : remoteApi;
    response = await fetch(`${api}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(ifMatch ? { 'If-Match': `"${ifMatch}"` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch { throw new Error('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.'); }
  const result = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(result?.error?.message || 'Yêu cầu chưa thành công. Thử lại sau.');
  if (result?.data === undefined) throw new Error('Máy chủ trả về dữ liệu không hợp lệ.');
  return result.data;
}

export function LiveWorkspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [suggestions, setSuggestions] = useState<Transfer[]>([]);
  const [screen, setScreen] = useState<'login' | 'register' | 'list' | 'create-trip' | 'trip' | 'create-expense'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pendingTrip = useRef<{ payload: string; key: string } | null>(null);
  const pendingExpense = useRef<{ payload: string; key: string } | null>(null);
  const settlementKeys = useRef<Record<string, string>>({});

  const saveSession = useCallback((value: Session | null) => {
    setSession(value);
    try {
      if (value) sessionStorage.setItem(sessionKey, JSON.stringify(value));
      else sessionStorage.removeItem(sessionKey);
    } catch { /* Private browsing can block session storage. */ }
  }, []);

  const token = useCallback(async (): Promise<string> => {
    if (!session) throw new Error('Vui lòng đăng nhập lại.');
    if (Date.now() < session.expiresAt - 60_000) return session.accessToken;
    try {
      const fresh = await request<{ accessToken: string; refreshToken: string; expiresIn: number; user: Session['user'] }>(
        '/api/v1/auth/refresh', { refreshToken: session.refreshToken },
      );
      const next = { ...fresh, expiresAt: Date.now() + fresh.expiresIn * 1000 };
      saveSession(next);
      return next.accessToken;
    } catch {
      saveSession(null);
      setScreen('login');
      throw new Error('Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.');
    }
  }, [session, saveSession]);

  const loadTrips = useCallback(async (authToken: string) => {
    const result = await request<{ items: Trip[] }>('/api/v1/trips', undefined, authToken);
    setTrips(result.items);
  }, []);

  const loadTrip = useCallback(async (tripId: string, authToken: string) => {
    const [nextOverview, nextExpenses, nextSettlements, nextSuggestions] = await Promise.all([
      request<Overview>(`/api/v1/trips/${tripId}/overview`, undefined, authToken),
      request<{ items: Expense[] }>(`/api/v1/trips/${tripId}/expenses`, undefined, authToken),
      request<{ items: Settlement[] }>(`/api/v1/trips/${tripId}/settlements`, undefined, authToken),
      request<{ suggestions: Transfer[] }>(`/api/v1/trips/${tripId}/settlement-suggestions`, undefined, authToken),
    ]);
    setOverview(nextOverview);
    setExpenses(nextExpenses.items);
    setSettlements(nextSettlements.items);
    setSuggestions(nextSuggestions.suggestions);
    setSelected(tripId);
    setScreen('trip');
  }, []);

  useEffect(() => {
    const saved = readSession();
    if (!saved) { setReady(true); return; }
    setSession(saved);
    setScreen('list');
    void (async () => {
      try {
        let accessToken = saved.accessToken;
        if (Date.now() >= saved.expiresAt - 60_000) {
          let fresh;
          try {
            fresh = await request<{ accessToken: string; refreshToken: string; expiresIn: number; user: Session['user'] }>(
              '/api/v1/auth/refresh', { refreshToken: saved.refreshToken },
            );
          } catch (cause) {
            if (cause instanceof Error && cause.message.includes('hết hạn')) {
              saveSession(null); setScreen('login');
            }
            throw cause;
          }
          accessToken = fresh.accessToken;
          saveSession({ ...fresh, expiresAt: Date.now() + fresh.expiresIn * 1000 });
        }
        await loadTrips(accessToken);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Không tải được chuyến đi.');
      } finally { setReady(true); }
    })();
  }, [loadTrips, saveSession]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Có lỗi xảy ra.'); }
    finally { setBusy(false); }
  }

  function signOut() {
    saveSession(null);
    setTrips([]); setOverview(null); setExpenses([]); setSettlements([]); setSuggestions([]); setSelected(null);
    setScreen('login'); setError('');
  }

  function authSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const email = String(values.get('email')).trim();
    const password = String(values.get('password'));
    void run(async () => {
      const result = await request<{ accessToken: string; refreshToken: string; expiresIn: number; user: Session['user'] }>(
        `/api/v1/auth/${screen}`, screen === 'register'
          ? { email, password, displayName: String(values.get('displayName')).trim() }
          : { email, password },
      );
      saveSession({ ...result, expiresAt: Date.now() + result.expiresIn * 1000 });
      await loadTrips(result.accessToken);
      setScreen('list');
    });
  }

  function createTrip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name')).trim();
    const ownerName = String(values.get('ownerName')).trim();
    if (!name || !ownerName) return;
    const payload = JSON.stringify({ name, ownerName });
    if (pendingTrip.current?.payload !== payload) pendingTrip.current = { payload, key: crypto.randomUUID() };
    const key = pendingTrip.current.key;
    void run(async () => {
      const authToken = await token();
      const created = await request<{ id: string }>('/api/v1/trips', { name, ownerName }, authToken, key);
      pendingTrip.current = null;
      setScreen('list');
      await loadTrips(authToken);
      await loadTrip(created.id, authToken);
    });
  }

  function createExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !overview) return;
    const values = new FormData(event.currentTarget);
    const amountMinor = Number(values.get('amount'));
    const participantIds = values.getAll('participantIds').map(String);
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || !participantIds.length) {
      setError('Nhập số tiền và chọn ít nhất một người để chia.'); return;
    }
    const body = {
      title: String(values.get('title')).trim(), amountMinor,
      payerParticipantId: String(values.get('payerParticipantId')),
      splitMethod: 'equal', split: { participantIds },
      occurredOn: String(values.get('occurredOn')),
      category: String(values.get('category')), note: String(values.get('note')).trim() || null,
      receiptIds: [],
    };
    const payload = JSON.stringify(body);
    if (pendingExpense.current?.payload !== payload) pendingExpense.current = { payload, key: crypto.randomUUID() };
    const key = pendingExpense.current.key;
    void run(async () => {
      const authToken = await token();
      await request(`/api/v1/trips/${selected}/expenses`, body, authToken, key);
      pendingExpense.current = null;
      setScreen('trip');
      await loadTrip(selected, authToken);
      await loadTrips(authToken);
    });
  }

  function addParticipant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const displayName = String(new FormData(form).get('displayName')).trim();
    if (!displayName) return;
    void run(async () => {
      const authToken = await token();
      await request(`/api/v1/trips/${selected}/participants`, { displayName }, authToken, crypto.randomUUID());
      form.reset();
      await loadTrip(selected, authToken);
      await loadTrips(authToken);
    });
  }

  function proposeSettlement(transfer: Transfer) {
    if (!selected || !overview) return;
    const body = { ...transfer, occurredOn: localToday(), note: null, basedOnLedgerVersion: overview.ledgerVersion };
    const operation = `propose:${selected}:${JSON.stringify(body)}`;
    const key = settlementKeys.current[operation] ??= crypto.randomUUID();
    void run(async () => {
      const authToken = await token();
      try {
        await request(`/api/v1/trips/${selected}/settlements`, body, authToken, key);
        delete settlementKeys.current[operation];
      } catch (cause) {
        await loadTrip(selected, authToken).catch(() => {});
        throw cause;
      }
      await loadTrip(selected, authToken);
    });
  }

  function confirmSettlement(item: Settlement) {
    if (!selected || !overview || !window.confirm('Xác nhận khoản tiền này đã được người nhận nhận? Số dư của nhóm sẽ được cập nhật.')) return;
    const body = { basedOnLedgerVersion: overview.ledgerVersion };
    const operation = `confirm:${selected}:${item.id}:${item.version}:${body.basedOnLedgerVersion}`;
    const key = settlementKeys.current[operation] ??= crypto.randomUUID();
    void run(async () => {
      const authToken = await token();
      try {
        await request(`/api/v1/trips/${selected}/settlements/${item.id}/confirm`, body, authToken, key, item.version);
        delete settlementKeys.current[operation];
      } catch (cause) {
        await loadTrip(selected, authToken).catch(() => {});
        throw cause;
      }
      await loadTrip(selected, authToken);
    });
  }

  const current = trips.find(trip => trip.id === selected);
  const participants = overview?.participants.filter(item => item.status === 'active') ?? [];
  const nameOf = (id: string) => participants.find(item => item.id === id)?.displayName ?? 'Thành viên';
  const pending = settlements.filter(item => item.status === 'pending');
  const reserved = new Set(pending.flatMap(item => [item.fromParticipantId, item.toParticipantId]));
  const availableSuggestions = suggestions.filter(item => !reserved.has(item.fromParticipantId) && !reserved.has(item.toParticipantId));
  return <div className="live-app">
    <header className="app-header live-header">
      <a className="brand" href="/"><span className="brand-icon"><WalletCards size={23} aria-hidden /></span><strong>Share<span>Bill</span></strong></a>
      {session && <button className="icon-button" type="button" onClick={signOut} aria-label="Đăng xuất"><LogOut size={21} /></button>}
    </header>
    <main className="main live-main">
      {!ready ? <p role="status">Đang tải dữ liệu…</p> : <>
        {error && <p className="inline-note error" role="alert">{error}</p>}
        {(screen === 'login' || screen === 'register') && <section className="card live-panel">
          <span className="tag">Dữ liệu đồng bộ qua Firebase</span>
          <h1>{screen === 'login' ? 'Chào mừng trở lại' : 'Tạo tài khoản ShareBill'}</h1>
          <p className="muted">Lưu chuyến đi và khoản chi để xem trên các thiết bị của bạn.</p>
          <form className="form-stack" onSubmit={authSubmit}>
            {screen === 'register' && <label>Tên hiển thị<input name="displayName" autoComplete="name" required maxLength={80} /></label>}
            <label>Email<input name="email" type="email" autoComplete="email" required /></label>
            <label>Mật khẩu<input name="password" type="password" autoComplete={screen === 'login' ? 'current-password' : 'new-password'} minLength={screen === 'register' ? 8 : 1} required /></label>
            <button className="primary-button" disabled={busy}>{busy ? 'Đang xử lý…' : screen === 'login' ? 'Đăng nhập' : 'Đăng ký'}</button>
          </form>
          <button className="text-button" onClick={() => { setError(''); setScreen(screen === 'login' ? 'register' : 'login'); }}>
            {screen === 'login' ? 'Chưa có tài khoản? Đăng ký' : 'Đã có tài khoản? Đăng nhập'}
          </button>
          <a className="text-button" href="/demo/">Xem bản dùng thử</a>
        </section>}
        {screen === 'list' && <>
          <div className="live-heading"><div><p className="muted">Xin chào, {session?.user.displayName}</p><h1>Chuyến đi của bạn</h1></div>
            <button className="primary-button compact" onClick={() => setScreen('create-trip')}><Plus size={18} /> Tạo chuyến đi</button></div>
          {trips.length ? trips.map(trip => <button key={trip.id} className="card live-trip-row" disabled={busy} onClick={() => void run(async () => loadTrip(trip.id, await token()))}>
            <strong>{trip.name}</strong><span className="muted">{trip.participantCount} thành viên · {formatMoney(trip.totalExpenseMinor)}</span>
          </button>) : <div className="card live-panel"><p>Chưa có chuyến đi nào. Tạo chuyến đi đầu tiên để bắt đầu chia tiền.</p></div>}
          {trips.length >= 20 && <p className="muted">Hiển thị 20 chuyến đi gần nhất.</p>}
          <a className="text-button" href="/demo/">Xem bản dùng thử Đà Lạt</a>
        </>}
        {screen === 'create-trip' && <section className="card live-panel">
          <button className="text-button" onClick={() => setScreen('list')}><ArrowLeft size={17} /> Chuyến đi</button>
          <h1>Tạo chuyến đi</h1>
          <form className="form-stack" onSubmit={createTrip}>
            <label>Tên chuyến đi<input name="name" placeholder="Ví dụ: Đà Lạt cuối tuần" maxLength={100} required /></label>
            <label>Tên của bạn trong chuyến đi<input name="ownerName" defaultValue={session?.user.displayName} maxLength={80} required /></label>
            <button className="primary-button" disabled={busy}>{busy ? 'Đang lưu…' : 'Tạo chuyến đi'}</button>
          </form>
        </section>}
        {(screen === 'trip' || screen === 'create-expense') && current && overview && <>
          <button className="text-button" onClick={() => { setScreen('list'); setError(''); }}><ArrowLeft size={17} /> Tất cả chuyến đi</button>
          <div className="live-heading"><div><p className="muted">Chuyến đi</p><h1>{current.name}</h1></div>
            {screen === 'trip' && <button className="icon-button" aria-label="Tải lại" disabled={busy} onClick={() => void run(async () => loadTrip(current.id, await token()))}><RefreshCw size={19} /></button>}</div>
          {screen === 'trip' ? <>
            <div className="summary-grid"><div className="summary-card"><span className="summary-label">Tổng chi tiêu</span><strong>{formatMoney(overview.trip.totalExpenseMinor)}</strong></div>
              <div className="summary-card"><span className="summary-label">Số dư của bạn</span><strong>{formatMoney(overview.balances.find(item => item.participantId === current.myParticipantId)?.netMinor ?? 0)}</strong></div></div>
            <button className="primary-button" onClick={() => setScreen('create-expense')}><Plus size={20} /> Thêm khoản chi</button>
            <section className="card live-panel"><h2><ReceiptText size={19} /> Khoản chi gần đây</h2>
              {expenses.length ? expenses.map(item => <div className="live-line" key={item.id}><div><strong>{item.title}</strong><span className="muted">{participants.find(p => p.id === item.payerParticipantId)?.displayName} đã trả · {item.occurredOn}{item.status === 'void' ? ' · Đã hủy' : ''}</span></div><strong>{formatMoney(item.amountMinor)}</strong></div>) : <p className="muted">Chưa có khoản chi.</p>}
              {expenses.length >= 30 && <p className="muted">Hiển thị 30 khoản chi gần nhất.</p>}
            </section>
            <section className="card live-panel"><h2><Users size={19} /> Thành viên và số dư</h2>
              {participants.map(item => <div className="live-line" key={item.id}><strong>{item.displayName}</strong><span>{formatMoney(overview.balances.find(b => b.participantId === item.id)?.netMinor ?? 0)}</span></div>)}
              {current.role === 'owner' && <form className="form-stack" onSubmit={addParticipant}>
                <label>Thêm thành viên vào chuyến đi<input name="displayName" maxLength={80} placeholder="Tên thành viên" required /></label>
                <button className="secondary-button" disabled={busy}><Plus size={17} /> Thêm người</button>
              </form>}
            </section>
            <section className="card live-panel"><h2><Scale size={19} /> Quyết toán</h2>
              {pending.length > 0 && <><p className="muted">Khoản chuyển chờ xác nhận. Số dư chỉ thay đổi khi xác nhận đã nhận tiền.</p>
                {pending.map(item => <div className="live-settlement" key={item.id}>
                  <div className="live-transfer"><strong>{nameOf(item.fromParticipantId)} <ArrowRight size={14} aria-hidden /> {nameOf(item.toParticipantId)}</strong><strong>{formatMoney(item.amountMinor)}</strong></div>
                  {(current.role === 'owner' || current.myParticipantId === item.toParticipantId) && <button className="secondary-button" disabled={busy} onClick={() => confirmSettlement(item)}><CircleCheck size={17} /> {current.role === 'owner' && current.myParticipantId !== item.toParticipantId ? 'Xác nhận thay người nhận' : 'Xác nhận đã nhận tiền'}</button>}
                </div>)}</>}
              {availableSuggestions.length > 0 && <><p className="muted">Gợi ý dựa trên số dư hiện tại:</p>
                {availableSuggestions.map(item => <div className="live-settlement" key={`${item.fromParticipantId}-${item.toParticipantId}`}>
                  <div className="live-transfer"><strong>{nameOf(item.fromParticipantId)} <ArrowRight size={14} aria-hidden /> {nameOf(item.toParticipantId)}</strong><strong>{formatMoney(item.amountMinor)}</strong></div>
                  {(current.role === 'owner' || current.myParticipantId === item.fromParticipantId) && <button className="secondary-button" disabled={busy} onClick={() => proposeSettlement(item)}>Ghi nhận đã chuyển tiền</button>}
                </div>)}</>}
              {pending.length === 0 && availableSuggestions.length === 0 && <p className="muted">Các thành viên đã cân bằng.</p>}
              {settlements.filter(item => item.status === 'confirmed').length > 0 && <div className="live-history"><h3>Đã xác nhận</h3>{settlements.filter(item => item.status === 'confirmed').map(item =>
                <div className="live-line" key={item.id}><span>{nameOf(item.fromParticipantId)} → {nameOf(item.toParticipantId)}</span><strong>{formatMoney(item.amountMinor)}</strong></div>)}</div>}
              {settlements.length >= 30 && <p className="muted">Hiển thị 30 khoản chuyển gần nhất.</p>}
            </section>
          </> : <section className="card live-panel">
            <button className="text-button" onClick={() => setScreen('trip')}><ArrowLeft size={17} /> Về chuyến đi</button>
            <h2>Thêm khoản chi</h2>
            <form className="form-stack" onSubmit={createExpense}>
              <label>Tên khoản chi<input name="title" maxLength={120} placeholder="Ví dụ: Ăn tối" required /></label>
              <label>Số tiền (VNĐ)<input name="amount" type="number" min="1" step="1" inputMode="numeric" required /></label>
              <label>Người trả<select name="payerParticipantId" defaultValue={current.myParticipantId}>{participants.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
              <fieldset className="live-fieldset"><legend>Chia đều cho</legend>{participants.map(p => <label key={p.id}><input type="checkbox" name="participantIds" value={p.id} defaultChecked /> {p.displayName}</label>)}</fieldset>
              <label>Ngày chi<input name="occurredOn" type="date" defaultValue={localToday()} required /></label>
              <label>Danh mục<select name="category" defaultValue="food"><option value="food">Ăn uống</option><option value="transport">Di chuyển</option><option value="stay">Lưu trú</option><option value="tickets">Vé</option><option value="shopping">Mua sắm</option><option value="other">Khác</option></select></label>
              <label>Ghi chú<textarea name="note" rows={2} maxLength={1000} /></label>
              <button className="primary-button" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu khoản chi'}</button>
            </form>
          </section>}
        </>}
      </>}
    </main>
  </div>;
}
