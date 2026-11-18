'use client';

import { useEffect, useRef, useState } from 'react';
import { Balances, Expenses, Overview, Settlements } from './dashboard';
import { ExpenseDetail, ExpenseForm } from './expense';
import { initialWorkspace, loadWorkspace, resetWorkspace, saveWorkspace, WorkspaceChanged, type LocalWorkspace } from './local-workspace';
import { Members } from './members';
import { newId, record, type Demo } from './model';
import { Account, ActivityScreen, CreateTrip, Offline, SignIn, Support, Trips } from './screens';
import { Invite, Itinerary, Join, Settings } from './trip';
import { PageTitle } from './ui';
import type { UpdateTrip } from './trip-command';

import { useHash, WorkspaceShell } from './workspace-shell';

export function Workspace() {
  const hash = useHash();
  const [route = 'tong-quan', id] = (hash || 'tong-quan').split('/');
  const selectedExpense = route === 'khoan-chi' || route === 'sua-khoan-chi';
  const form = route === 'them-khoan-chi' || route === 'sua-khoan-chi';
  const [state, setState] = useState<LocalWorkspace>(initialWorkspace);
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState<'failed' | 'changed'>();
  const writes = useRef(Promise.resolve());
  const persistedVersion = useRef<string | undefined>(undefined);

  async function refreshWorkspace() {
    await writes.current;
    try {
      const saved = await loadWorkspace();
      persistedVersion.current = saved.revision;
      setState(saved);
      setStorageError(undefined);
    } catch {
      setStorageError('failed');
    }
  }

  useEffect(() => {
    let mounted = true;
    loadWorkspace().then(saved => {
      if (mounted) {
        persistedVersion.current = saved.revision;
        setState(saved);
      }
    })
      .catch(() => { if (mounted) setStorageError('failed'); })
      .finally(() => { if (mounted) setLoaded(true); });
    return () => { mounted = false; };
  }, []);

  function commit(next: LocalWorkspace) {
    setState(next);
    const snapshot = { ...next, revision: newId() };
    writes.current = writes.current.then(async () => {
      try {
        await saveWorkspace(snapshot, persistedVersion.current);
        persistedVersion.current = snapshot.revision;
        setStorageError(undefined);
      } catch (error) {
        setStorageError(error instanceof WorkspaceChanged ? 'changed' : 'failed');
      }
    });
  }

  const data = state.trips[state.selected] ?? initialWorkspace.trips[initialWorkspace.selected];
  const update: UpdateTrip = (next, _command, onSaved) => {
    commit({ ...state, trips: { ...state.trips, [state.selected]: next } });
    onSaved?.();
  };
  const expense = data.expenses.find(item => item.id === id);
  let content: React.ReactNode;

  if (!loaded) {
    content = <p role="status" className="empty">Đang mở ShareBill…</p>;
  } else {
    switch (route) {
      case 'chuyen-di':
        content = <Trips state={state} onOpen={key => { commit({ ...state, selected: key }); window.location.hash = 'tong-quan'; }} />;
        break;
      case 'tao-chuyen':
        content = <CreateTrip profile={state.profile} onCreate={(trip, name) => {
          const key = newId();
          const ownerId = newId();
          const next = record({ trip, ownerId, viewerId: ownerId, members: [{ id: ownerId, name, tone: 0, linked: true }], expenses: [], settlements: [], plans: [] }, 'Tạo chuyến đi', trip.name);
          commit({ ...state, selected: key, trips: { ...state.trips, [key]: next } });
          window.location.hash = 'tong-quan';
        }} />;
        break;
      case 'dang-nhap':
      case 'dang-ky':
        content = <SignIn key={route} registering={route === 'dang-ky'} onSubmit={profile => {
          commit({ ...state, profile });
          window.location.hash = 'chuyen-di';
        }} />;
        break;
      case 'tai-khoan':
        content = <Account profile={state.profile} onSignOut={() => commit({ ...state, profile: undefined })}
          onReset={async () => {
            await writes.current;
            const snapshot = { ...initialWorkspace, revision: newId() };
            await resetWorkspace(snapshot, persistedVersion.current);
            persistedVersion.current = snapshot.revision;
            setState(snapshot);
            setStorageError(undefined);
            window.location.hash = 'tong-quan';
          }} />;
        break;
      case 'tro-giup':
        content = <Support reports={state.reports ?? []} onReport={report => commit({ ...state, reports: [report, ...(state.reports ?? [])] })} />;
        break;
      case 'ngoai-tuyen': content = <Offline />; break;
      case 'chi-tieu': content = <Expenses data={data} />; break;
      case 'so-du': content = <Balances data={data} update={update} />; break;
      case 'quyet-toan': content = <Settlements data={data} update={update} />; break;
      case 'thanh-vien': content = <Members data={data} update={update} />; break;
      case 'lich-trinh': content = <Itinerary data={data} update={update} />; break;
      case 'hoat-dong': content = <ActivityScreen data={data} />; break;
      case 'cai-dat': content = <Settings data={data} update={update} />; break;
      case 'loi-moi': content = <Invite data={data} update={update} />; break;
      case 'tham-gia':
        content = <Join key={hash} state={state} token={id} onJoin={(key, next) => {
          commit({ ...state, selected: key, trips: { ...state.trips, [key]: next } });
          window.history.replaceState(null, '', '#tong-quan');
          window.dispatchEvent(new Event('hashchange'));
        }} />;
        break;
      case 'them-khoan-chi':
      case 'sua-khoan-chi':
      case 'khoan-chi':
        if (selectedExpense && !expense) content = <PageTitle title="Không tìm thấy khoản chi" back="#chi-tieu" />;
        else if (form) content = <ExpenseForm key={hash} data={data} expense={expense} update={update} />;
        else if (expense) content = <ExpenseDetail key={expense.id} data={data} expense={expense} update={update} />;
        break;
      case 'tong-quan': content = <Overview data={data} />; break;
      default: content = <PageTitle title="Không tìm thấy màn hình" back="#tong-quan" />;
    }
  }

  return <WorkspaceShell hash={hash} route={route} data={data} profileName={state.profile?.name} preview>
    {storageError && <div className="inline-note error workspace-notice" role="status">
      {storageError === 'changed' ? <>Dữ liệu đã thay đổi ở tab khác. <button className="text-button" onClick={() => void refreshWorkspace()}>Mở bản mới nhất</button></>
        : <>Trình duyệt chưa lưu được dữ liệu trên thiết bị. <button className="text-button" onClick={() => commit(state)}>Thử lưu lại</button></>}
    </div>}
    {content}
  </WorkspaceShell>;
}
