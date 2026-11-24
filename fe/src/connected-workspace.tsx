'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, readSession, ShareBillApi, type Session } from './api-client';
import {
  activityFrom, expenseFrom, receiptActions, sendTripCommand, settlementFrom, transferFrom, tripBody, tripSnapshot,
  type ActivityDto, type ExpenseDto, type InvitePreview, type ItineraryDto, type Memberships, type SettlementDto, type TransferDto, type TripDto, type TripOverview,
} from './api-data';
import { useApiPage, useApiRead } from './api-queries';
import { HelpDesk } from './api-support';
import { InviteManager, JoinPreview, LiveAccount, MemberAccounts, type RunMutation } from './api-trip-screens';
import { Balances, Expenses, Overview, Settlements, type ExpenseFilters, type SettlementFilter } from './dashboard';
import { ExpenseDetail, ExpenseForm } from './expense';
import { Members } from './members';
import { categories, type Demo } from './model';
import { ActivityScreen, CreateTrip, SignIn, Trips } from './screens';
import { Itinerary, Settings } from './trip';
import type { UpdateTrip } from './trip-command';
import { MutationFeedback, PageTitle } from './ui';
import { useHash, useOnline, WorkspaceShell } from './workspace-shell';
import { isParticipantId, isTripScreen, readWorkspaceRoute, tripHref, tripRoute } from './workspace-route';
import { PendingOperations } from './operation-recovery';
import { financialSnapshot } from './finance-view';
import { clearDeviceData, clearExpenseDraft, getTripSnapshot, preferenceKey, saveTripSnapshot, setTrustedDevice, trustedDevice } from './private-device';

const invitePattern = /^[A-Za-z0-9_-]{43}$/;
const isExpenseDetail = (route: string) => route === 'khoan-chi' || route === 'sua-khoan-chi';

function replaceRoute(route: string) {
  window.history.replaceState(window.history.state, '', '#' + route);
  window.dispatchEvent(new Event('hashchange'));
}

function useMutation(hash: string, onCommit?: () => void) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ route: string; message: string; code?: string }>();
  const run: RunMutation = (operation, onSaved) => {
    if (locked.current) return;
    locked.current = true;
    const source = window.location.hash;
    setError(undefined);
    setBusy(true);
    void operation().then(result => {
      onCommit?.();
      if (window.location.hash === source) onSaved?.(result);
    }, (cause: unknown) => {
      if (cause instanceof ApiError && cause.code === 'PAYMENT_ALREADY_PENDING') onCommit?.();
      if (window.location.hash === source) {
        const message = cause instanceof Error ? cause.message : 'Chưa thực hiện được thao tác.';
        setError({ route: source.slice(1), code: cause instanceof ApiError ? cause.code : undefined, message: cause instanceof ApiError && ['VERSION_CONFLICT', 'LEDGER_CHANGED'].includes(cause.code ?? '')
          ? message + ' Đóng hộp thoại nếu đang mở, rồi tải lại để kiểm tra dữ liệu mới.' : message });
      }
    }).finally(() => {
      locked.current = false;
      setBusy(false);
    });
  };
  return { run, busy, error: error?.route === hash ? error.message : '', code: error?.route === hash ? error.code : undefined,
    clear: () => setError(undefined) };
}

export function ConnectedWorkspace() {
  const hash = useHash();
  const location = readWorkspaceRoute(hash);
  const route = location.route ?? '';
  const token = location.id;
  const [session, setSession] = useState<Session | null>(null);
  const [sessionProblem, setSessionProblem] = useState('');
  const [ready, setReady] = useState(false);
  const [api] = useState(() => new ShareBillApi(setSession, (uid, message) => {
    setSessionProblem(message);
    try { setTrustedDevice(uid, false); } catch { /* Storage is unavailable. */ }
    void clearDeviceData(uid).catch(() => {});
  }));
  const pendingInvite = useRef<string | undefined>(undefined);
  const auth = useMutation(hash);

  useEffect(() => {
    api.setSession(readSession());
    setReady(true);
  }, [api]);

  if (session && ready) {
    return <AuthenticatedWorkspace key={session.user.uid} session={session} api={api} hash={hash} onSignOut={() => {
      void clearDeviceData(session.user.uid).catch(() => {});
      try { setTrustedDevice(session.user.uid, false); } catch { /* Storage is unavailable. */ }
      setSessionProblem('');
      api.setSession(null);
      pendingInvite.current = undefined;
      auth.clear();
      replaceRoute('dang-nhap');
    }} />;
  }

  let content;
  if (!ready) {
    content = <p className="empty" role="status">Đang mở ShareBill…</p>;
  } else if (route === 'tham-gia') {
    const valid = token && invitePattern.test(token);
    content = <div className="form-page">
      <PageTitle title="Lời mời tham gia" back="#dang-nhap" />
      <section className="card field-card">
        <h2>{valid ? 'Đăng nhập để xem lời mời' : 'Liên kết không còn sử dụng được'}</h2>
        {valid && <div className="button-pair">
          <button className="primary-button" onClick={() => { pendingInvite.current = token; auth.clear(); replaceRoute('dang-nhap'); }}>Đăng nhập</button>
          <button className="secondary-button" onClick={() => { pendingInvite.current = token; auth.clear(); replaceRoute('dang-ky'); }}>Đăng ký</button>
        </div>}
      </section>
    </div>;
  } else {
    const registering = route === 'dang-ky';
    content = <SignIn key={route} registering={registering} onSubmit={(profile, password) => {
      auth.run(() => api.signIn(profile.email, password, registering ? profile.name : undefined), () => {
        const invite = pendingInvite.current;
        pendingInvite.current = undefined;
        setSessionProblem('');
        replaceRoute(invite ? 'tham-gia/' + invite : route === 'tro-giup' || location.tripId ? hash : 'chuyen-di');
      });
    }} />;
  }
  return <WorkspaceShell publicPage hash={hash} route={route} updateBusy={auth.busy}>
    {sessionProblem && <p className="inline-note error" role="alert">{sessionProblem}</p>}
    {auth.busy && <p className="inline-note" role="status">Đang xử lý…</p>}
    {auth.error && <p className="inline-note error" role="alert">{auth.error}</p>}
    {content}
  </WorkspaceShell>;
}

function selectedKey(uid: string) { return 'sharebill-selected-trip:' + uid; }
function readSelected(uid: string) {
  try { return sessionStorage.getItem(selectedKey(uid)) ?? ''; } catch { return ''; }
}

function expenseFilters(query: URLSearchParams): ExpenseFilters {
  const category = query.get('category') ?? '';
  const payer = query.get('payer') ?? '';
  const selectedCategory = category !== 'fun' && Object.hasOwn(categories, category) ? category : '';
  const selectedPayer = !selectedCategory && isParticipantId(payer) ? payer : '';
  const status = query.get('status');
  return { category: selectedCategory, payer: selectedPayer,
    status: status === 'voided' ? status : status === 'active' || selectedCategory || selectedPayer ? 'active' : 'all' };
}

function filterQuery({ category, payer, status }: ExpenseFilters) {
  const query = new URLSearchParams();
  if (status !== 'all') query.set('status', status);
  if (category) query.set('category', category);
  if (payer) query.set('payer', payer);
  return query.toString();
}

function AuthenticatedWorkspace({ session, api, hash, onSignOut }: { session: Session; api: ShareBillApi; hash: string; onSignOut: () => void }) {
  const uid = session.user.uid;
  const [lastSelected, setLastSelected] = useState(() => readSelected(uid));
  const [archived, setArchived] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [trust, setTrust] = useState(() => trustedDevice(uid));
  const [storageError, setStorageError] = useState(false);
  const [cached, setCached] = useState<{ tripId: string; value: TripOverview; at: number }>();
  const online = useOnline();
  const mutation = useMutation(hash, () => setEpoch(value => value + 1));
  const { route: rawRoute, id, tripId: routeTripId, query } = readWorkspaceRoute(hash);
  const screenPath = hash.split('?')[0];
  const lastScreenPath = useRef(screenPath);
  const route = !rawRoute || rawRoute === 'dang-nhap' || rawRoute === 'dang-ky' ? 'chuyen-di' : rawRoute;
  const selected = routeTripId ?? lastSelected;
  const filters = expenseFilters(query);
  const historyStatus = query.get('status');
  const historyFilter: SettlementFilter = historyStatus === 'confirmed' || historyStatus === 'cancelled' || historyStatus === 'void' ? historyStatus : 'pending';
  const canRefresh = ['chuyen-di', 'tong-quan', 'chi-tieu', 'khoan-chi', 'so-du', 'quyet-toan', 'hoat-dong', 'lich-trinh', 'tro-giup'].includes(route);
  const tripPath = selected && (isTripScreen(route) || (route === 'tro-giup' && id === 'chuyen')) ? '/trips/' + selected : undefined;
  const device = useMemo(() => trust && tripPath ? { uid, tripId: selected } : undefined, [trust, tripPath, uid, selected]);
  const wantsFinance = route === 'tong-quan' || route === 'so-du' || route === 'khoan-chi';
  const overview = useApiRead<TripOverview>(api, tripPath && tripPath + '/overview', epoch, undefined, true);
  const denied = overview.status === 404 || overview.status === 403 || overview.status === 401;
  const trips = useApiPage<TripDto>(api, route === 'chuyen-di' ? '/trips' : undefined, { status: archived ? 'archived' : 'active', limit: '20' }, epoch);
  const expenseList = useApiPage<ExpenseDto>(api, tripPath && (route === 'chi-tieu' || route === 'tong-quan') ? tripPath + '/expenses' : undefined,
    route === 'tong-quan' ? { status: 'active', limit: '3' } :
      { limit: '30', status: filters.status === 'all' ? undefined : filters.status === 'voided' ? 'void' : filters.status,
        category: filters.category, payer: filters.payer }, epoch);
  const detail = useApiRead<ExpenseDto>(api, tripPath && id && isExpenseDetail(route) ? tripPath + '/expenses/' + encodeURIComponent(id) : undefined, epoch);
  const transfers = useApiRead<{ ledgerVersion: number; revision: number; suggestions: TransferDto[]; pendingTransfers: TransferDto[] }>(api,
    tripPath && wantsFinance ? tripPath + '/settlement-suggestions' : undefined, epoch + (overview.data?.revision ?? 0));
  const history = useApiPage<SettlementDto>(api, tripPath && route === 'quyet-toan' ? tripPath + '/settlements' : undefined, { status: historyFilter, limit: '30' }, epoch);
  const members = useApiRead<Memberships>(api, tripPath && route === 'thanh-vien' ? tripPath + '/members' : undefined, epoch + (overview.data?.revision ?? 0));
  const itinerary = useApiRead<ItineraryDto>(api, tripPath && route === 'lich-trinh' ? tripPath + '/itinerary' : undefined, epoch);
  const historyActivity = useApiPage<ActivityDto>(api, tripPath && route === 'hoat-dong' ? tripPath + '/activity' : undefined, { limit: '30' }, epoch);
  const hasToken = route === 'tham-gia' && id && invitePattern.test(id);
  const invitation = useApiRead<InvitePreview>(api, hasToken ? '/invites/preview' : undefined, epoch, hasToken ? { token: id } : undefined);
  const attachments = useMemo(() => selected ? receiptActions(api, selected) : undefined, [api, selected]);

  useEffect(() => {
    if (!routeTripId) return;
    setLastSelected(routeTripId);
    try { sessionStorage.setItem(selectedKey(uid), routeTripId); } catch { /* URL still carries the trip. */ }
  }, [routeTripId, uid]);

  useEffect(() => {
    if (lastScreenPath.current === screenPath) return;
    lastScreenPath.current = screenPath;
    setEpoch(value => value + 1);
  }, [screenPath]);

  useEffect(() => {
    function revalidate() {
      if (!mutation.busy && document.visibilityState === 'visible') setEpoch(value => value + 1);
    }
    window.addEventListener('online', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      window.removeEventListener('online', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [mutation.busy]);

  useEffect(() => {
    function changed(event: StorageEvent) {
      if (event.key === preferenceKey(uid) || event.key === null) setTrust(trustedDevice(uid));
    }
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [uid]);

  useEffect(() => {
    if (!device || denied) return;
    let active = true;
    void getTripSnapshot(device).then(entry => {
      if (active) setCached(entry && { tripId: device.tripId, value: entry.value, at: entry.at });
    }, () => { if (active) setStorageError(true); });
    return () => { active = false; };
  }, [device, denied]);

  useEffect(() => {
    if (!device || !overview.data || overview.error || overview.loading || !overview.loadedAt) return;
    const value = overview.data, at = overview.loadedAt;
    void saveTripSnapshot(device, value, at).then(() => setCached({ tripId: device.tripId, value, at }), () => setStorageError(true));
  }, [device, overview.data, overview.error, overview.loading, overview.loadedAt]);

  useEffect(() => {
    if (denied && tripPath) {
      setCached(previous => previous?.tripId === selected ? undefined : previous);
      if (trust) void clearDeviceData(uid, selected).catch(() => setStorageError(true));
    }
  }, [denied, selected, tripPath, trust, uid]);

  const revision = overview.data?.revision;
  useEffect(() => {
    if (!online || !tripPath || mutation.busy || revision === undefined || overview.loading) return;
    let active = true;
    let checking = false;
    const timer = window.setInterval(async () => {
      if (checking || document.visibilityState !== 'visible') return;
      checking = true;
      try {
        const signal = await api.read<{ revision: number }>(tripPath + '/signal');
        if (active && signal.revision !== revision) setEpoch(value => value + 1);
      } catch (cause) {
        if (active && cause instanceof ApiError && [0, 401, 403, 404].includes(cause.status)) setEpoch(value => value + 1);
      } finally { checking = false; }
    }, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, mutation.busy, online, overview.loading, revision, tripPath]);

  function openTrip(tripId: string, replace = false) {
    const target = tripRoute(tripId, 'tong-quan');
    if (replace) replaceRoute(target);
    else window.location.hash = target;
  }

  const networkUnavailable = !online || overview.status === 0 || (overview.status ?? 0) >= 500;
  const offlineCache = device && cached?.tripId === selected && !denied &&
    !overview.data && networkUnavailable && session.expiresAt > Date.now() ? cached : undefined;
  const source = overview.data ?? offlineCache?.value;
  const data = source ? tripSnapshot(source, uid) : undefined;
  if (data?.remote && networkUnavailable && route !== 'them-khoan-chi') data.remote.writable = false;
  const expense = detail.data ? expenseFrom(detail.data) : undefined;
  const hasMatchingLedger = Boolean(data && transfers.data && transfers.data.ledgerVersion === data.remote?.ledgerVersion && transfers.data.revision === source?.revision);
  if (data) {
    data.expenses = expenseList.items.map(expenseFrom);
    data.settlements = history.items.map(settlementFrom);
    data.activity = historyActivity.items.flatMap(item => activityFrom(item, selected));
    if (data.remote) data.remote.expenseQuery = filterQuery(filters);
    if (itinerary.data) {
      data.remote!.itineraryVersion = itinerary.data.version;
      data.plans = itinerary.data.activities.map(plan => ({ ...plan, suggestionId: plan.suggestionId ?? undefined }));
      data.ideas = itinerary.data.suggestions.map(idea => ({
        id: idea.id, title: idea.title, by: '', author: idea.author ?? undefined,
        declined: idea.status === 'declined', scheduled: idea.status === 'scheduled',
      }));
    }
    if (transfers.data && hasMatchingLedger) {
      data.remote!.suggestions = transfers.data.suggestions.map(transferFrom);
      data.remote!.pendingTransfers = transfers.data.pendingTransfers.map(transferFrom);
      data.remote!.suggestionsReady = !transfers.loading && !transfers.error;
    }
  }

  const update: UpdateTrip = (_next, command, onSaved) => {
    if (!command || !data || !selected || overview.loading || networkUnavailable) return;
    mutation.run(async () => {
      const result = await sendTripCommand(api, selected, data, command);
      if (device && command.type === 'save-expense' && !command.previous) await clearExpenseDraft(device).catch(() => setStorageError(true));
      return result;
    }, result => onSaved?.(result.id));
  };

  function refresh() {
    mutation.clear();
    setEpoch(value => value + 1);
  }

  const tripsState = { selected, trips: Object.fromEntries(trips.items.map(trip => [trip.id, tripSnapshot({ trip, participants: [], balances: [] }, uid)])) };
  let content;
  if (route === 'chuyen-di') {
    content = <Trips state={tripsState} onOpen={openTrip} onStatus={setArchived} remoteArchived={archived} loading={trips.loading} onMore={trips.more} />;
  } else if (route === 'tao-chuyen') {
    content = <CreateTrip remote profile={{ name: session.user.displayName, email: session.user.email }} onCreate={(trip, ownerName) =>
      mutation.run(() => api.write<{ id: string }>('/trips', { ...tripBody(trip), ownerName }), result => openTrip(result.id))} />;
  } else if (route === 'tai-khoan') {
    content = <LiveAccount session={session} signOut={onSignOut} trusted={trust} onTrust={async enabled => {
      setStorageError(false);
      try {
        setTrustedDevice(uid, enabled);
        setTrust(enabled);
        if (!enabled) { setCached(undefined); await clearDeviceData(uid); }
      } catch { setStorageError(true); }
    }} />;
  } else if (route === 'tro-giup') {
    content = <HelpDesk api={api} epoch={epoch} segment={id} contextTrip={id === 'chuyen' && data ? { id: selected, name: data.trip.name } : undefined}
      loadingContext={id === 'chuyen' && overview.loading} run={mutation.run} busy={mutation.busy} onReload={refresh} />;
  } else if (route === 'tham-gia') {
    if (!hasToken || invitation.error) content = <div className="form-page">
      <PageTitle title="Lời mời tham gia" back="#chuyen-di" />
      <section className="card field-card"><p>{invitation.error ?? 'Liên kết không còn sử dụng được.'}</p></section>
    </div>;
    else if (invitation.data) content = <JoinPreview preview={invitation.data} onJoin={() => {
      if (invitation.data?.alreadyMember) openTrip(invitation.data.trip.id, true);
      else mutation.run(() => api.write<{ tripId: string }>('/invites/accept', { token: id }), result => openTrip(result.tripId, true));
    }} />;
    else content = <p role="status" className="empty">Đang kiểm tra lời mời…</p>;
  } else if (!data) {
    content = selected && overview.loading ? <p className="empty" role="status">Đang tải thông tin chuyến đi…</p>
      : <PageTitle title="Mở một chuyến đi để tiếp tục" back="#chuyen-di" />;
  } else if (offlineCache && !['tong-quan', 'them-khoan-chi', 'so-du'].includes(route)) {
    content = <PageTitle title="Màn hình này cần kết nối mạng" back={tripHref(data, 'tong-quan')} />;
  } else {
    switch (route) {
      case 'tong-quan':
        content = <Overview data={data} loadingExpenses={expenseList.loading} loadingTransfers={transfers.loading} />;
        break;
      case 'chi-tieu':
        content = <Expenses key={selected} data={data} filters={filters} onMore={expenseList.more} loading={expenseList.loading}
          onFilter={next => replaceRoute(tripRoute(selected, 'chi-tieu', undefined, filterQuery(next)))} />;
        break;
      case 'them-khoan-chi':
        content = <ExpenseForm key={selected} data={data} update={update} device={device}
          receiptActions={networkUnavailable ? undefined : attachments} disabled={networkUnavailable || overview.loading} />;
        break;
      case 'sua-khoan-chi':
      case 'khoan-chi':
        if (detail.loading && (route === 'khoan-chi' || !expense)) content = <p role="status" className="empty">Đang tải khoản chi…</p>;
        else if (!expense) content = <PageTitle title="Không tìm thấy khoản chi" back={tripHref(data, 'chi-tieu')} />;
        else content = route === 'sua-khoan-chi' ?
          <ExpenseForm data={data} expense={expense} key={selected + ':' + id} update={update} receiptActions={networkUnavailable ? undefined : attachments}
            disabled={networkUnavailable || detail.loading || Boolean(detail.error)} /> :
          <ExpenseDetail data={data} expense={expense} key={id} update={update} receiptActions={attachments} />;
        break;
      case 'so-du': content = <Balances data={data} update={update} loading={transfers.loading} disabled={overview.loading || mutation.busy} receiptActions={networkUnavailable ? undefined : attachments} />; break;
      case 'quyet-toan':
        content = <Settlements data={data} update={update} onMore={history.more} loading={history.loading} remoteFilter={historyFilter} disabled={overview.loading || mutation.busy}
          receiptActions={networkUnavailable ? undefined : attachments}
          onFilter={status => replaceRoute(tripRoute(selected, 'quyet-toan', undefined, 'status=' + status))} />;
        break;
      case 'thanh-vien':
        content = <Members key={selected + ':' + (id ?? '')} view={id} data={data} update={update} receiptActions={networkUnavailable ? undefined : attachments} disabled={overview.loading || mutation.busy} accounts={members.data ?
          <MemberAccounts data={data} accounts={members.data.memberships} tripId={selected} api={api} run={mutation.run} /> :
          <p role="status">Đang tải tài khoản…</p>} />;
        break;
      case 'cai-dat': content = <Settings data={data} key={selected} update={update} disabled={overview.loading || Boolean(overview.error)} />; break;
      case 'hoat-dong': content = <ActivityScreen data={data} onMore={historyActivity.more} loading={historyActivity.loading} />; break;
      case 'loi-moi': content = <InviteManager data={data} key={selected} tripId={selected} api={api} epoch={epoch} run={mutation.run} />; break;
      case 'lich-trinh':
        content = itinerary.data ? <Itinerary data={data} key={selected} update={update} loading={itinerary.loading} /> :
          <><PageTitle title="Lịch trình chuyến đi" back={tripHref(data, 'tong-quan')} />{itinerary.loading && <p role="status">Đang tải lịch trình…</p>}</>;
        break;
      default: content = <PageTitle title="Không tìm thấy màn hình" back="#chuyen-di" />;
    }
  }

  const tripError = !['chuyen-di', 'tai-khoan', 'tao-chuyen', 'tham-gia', 'tro-giup'].includes(route) ? overview.error : undefined;
  const readError = trips.error ?? tripError ?? expenseList.error ?? detail.error ?? transfers.error ?? history.error ?? members.error ?? historyActivity.error ?? itinerary.error;
  const notice = trips.notice ?? expenseList.notice ?? history.notice ?? historyActivity.notice;
  const staleSuggestions = wantsFinance && transfers.data && data && !hasMatchingLedger;
  const updating = Boolean(data && overview.loading);
  const pendingHelp = data && mutation.code === 'PENDING_SETTLEMENTS_FOR_PARTICIPANT'
    ? { label: 'Mở các khoản đang chờ xác nhận', href: tripHref(data, 'quyet-toan') } : undefined;
  return <WorkspaceShell hash={hash} route={route} data={data} profileName={session.user.displayName}
    refresh={canRefresh && !mutation.busy ? refresh : undefined} updateBusy={mutation.busy}>
    {mutation.busy && <div className="inline-note workspace-notice" role="status">Đang lưu trên máy chủ…</div>}
    {!mutation.busy && updating && <div className="inline-note workspace-notice" role="status">Đang cập nhật dữ liệu…</div>}
    {(mutation.error || readError || staleSuggestions) && <div className="inline-note error workspace-notice" role="alert">
      <span>{mutation.error || readError || 'Số dư vừa thay đổi. Tải lại để xem gợi ý mới.'}</span>
      <button className="text-button" disabled={mutation.busy} onClick={refresh}>Tải lại</button>
    </div>}
    {notice && <p className="inline-note workspace-notice" role="status">{notice}</p>}
    {data && !financialSnapshot(data).complete && <p className="inline-note error" role="alert"><span>Chưa đủ dữ liệu số dư để kết luận số tiền cần trả hoặc chốt chuyến. Tải lại dữ liệu để kiểm tra.</span><button className="text-button" disabled={mutation.busy} onClick={refresh}>Tải lại</button></p>}
    {storageError && <p className="inline-note error" role="status">Thiết bị gặp lỗi khi lưu hoặc xóa dữ liệu ngoại tuyến.</p>}
    {data && networkUnavailable && (offlineCache || overview.loadedAt) && <p className="inline-note" role="status">
      Dữ liệu đã tải trước đó lúc {new Date(offlineCache?.at ?? overview.loadedAt!).toLocaleString('vi-VN')}.
      {' Bạn có thể soạn nháp khoản chi trên thiết bị tin cậy.'}
    </p>}
    {data?.remote?.suspended && <p className="inline-note" role="status">Chuyến đang tạm khóa. Bạn vẫn có thể xem lịch sử.</p>}
    <PendingOperations api={api} busy={mutation.busy} />
    <MutationFeedback.Provider value={{ busy: mutation.busy || updating, offline: networkUnavailable, error: mutation.error, recovery: pendingHelp }}>
      {content}
    </MutationFeedback.Provider>
    {data && !networkUnavailable && overview.loadedAt && <p className="sync-caption">
      Đồng bộ lúc {new Date(overview.loadedAt).toLocaleString('vi-VN')}
    </p>}
  </WorkspaceShell>;
}
