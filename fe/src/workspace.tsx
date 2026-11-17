'use client';

import { CalendarDays, LayoutGrid, ReceiptText, Scale, Settings2, Users, WalletCards } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Balances, Expenses, Members, Overview } from './dashboard';
import { ExpenseDetail, ExpenseForm } from './expense';
import { initialDemo, me, memberFor, type Demo } from './model';
import { Invite, Itinerary, Settings } from './trip';
import { Avatar, PageTitle } from './ui';

const tabs = [
  { id: 'tong-quan', label: 'Tổng quan', Icon: LayoutGrid },
  { id: 'chi-tieu', label: 'Chi tiêu', Icon: ReceiptText },
  { id: 'so-du', label: 'Số dư', Icon: Scale },
  { id: 'thanh-vien', label: 'Thành viên', Icon: Users },
];
const extra = [
  { id: 'lich-trinh', label: 'Lịch trình', Icon: CalendarDays },
  { id: 'cai-dat', label: 'Cài đặt', Icon: Settings2 },
];
const storageKey = 'sharebill-demo-v1';

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function Brand() {
  return <a className="brand" href="#tong-quan" aria-label="ShareBill, về tổng quan">
    <span className="brand-icon"><WalletCards size={23} strokeWidth={2.1} aria-hidden /></span><strong>Share<span>Bill</span></strong>
  </a>;
}

function Navigation({ desktop, active }: { desktop?: boolean; active: string }) {
  return <nav className={desktop ? 'side-nav' : 'bottom-nav'} aria-label={desktop ? 'Điều hướng chuyến đi' : 'Điều hướng chính'}>
    {(desktop ? [...tabs, ...extra] : tabs).map(({ id, label, Icon }) =>
      <a key={id} href={`#${id}`} aria-current={active === id ? 'page' : undefined}>
        <span className="nav-icon"><Icon size={21} strokeWidth={active === id ? 2.3 : 1.8} aria-hidden /></span><span>{label}</span>
      </a>)}
  </nav>;
}

export function Workspace() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash.slice(1), () => '');
  const [route = '', id] = hash.split('/');
  const selectedExpense = route === 'khoan-chi' || route === 'sua-khoan-chi';
  const form = route === 'them-khoan-chi' || route === 'sua-khoan-chi';
  const active = selectedExpense || form ? 'chi-tieu' : route || 'tong-quan';
  const [data, setData] = useState<Demo>(initialDemo);
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const main = useRef<HTMLElement>(null);
  const lastHash = useRef(hash);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as Demo;
        if (parsed.trip && Array.isArray(parsed.members) && Array.isArray(parsed.expenses) &&
            Array.isArray(parsed.plans) && Array.isArray(parsed.settlements)) setData(parsed);
      }
    } catch {
      setStorageError(true);
    } finally {
      setLoaded(true);
    }
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (lastHash.current === hash) return;
    lastHash.current = hash;
    window.scrollTo(0, 0);
    main.current?.focus({ preventScroll: true });
  }, [hash]);

  function update(next: Demo) {
    setData(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }

  const expense = data.expenses.find(item => item.id === id);
  let content: React.ReactNode;
  if (!loaded && active !== 'tong-quan') {
    content = <p role="status" className="empty">Đang mở chuyến đi…</p>;
  } else {
    switch (route) {
      case 'chi-tieu': content = <Expenses data={data} />; break;
      case 'so-du': content = <Balances data={data} update={update} />; break;
      case 'thanh-vien': content = <Members data={data} update={update} />; break;
      case 'lich-trinh': content = <Itinerary data={data} update={update} />; break;
      case 'cai-dat': content = <Settings data={data} update={update} />; break;
      case 'loi-moi':
      case 'tham-gia': content = <Invite key={route} data={data} preview={route === 'tham-gia'} />; break;
      case 'them-khoan-chi':
      case 'sua-khoan-chi':
      case 'khoan-chi':
        if (selectedExpense && !expense) content = <PageTitle title="Không tìm thấy khoản chi" back="#chi-tieu" />;
        else if (form) content = <ExpenseForm key={hash} data={data} expense={expense} update={update} />;
        else if (expense) content = <ExpenseDetail key={expense.id} data={data} expense={expense} update={update} />;
        break;
      default: content = <Overview data={data} />;
    }
  }

  return <div className={`workspace ${form ? 'workspace-form' : ''}`}>
    <aside className="sidebar">
      <Brand />
      <p className="sidebar-trip">{data.trip.name}</p>
      <Navigation desktop active={active} />
      <div className="sidebar-footer"><Avatar member={memberFor(data, me)} /><div><strong>{memberFor(data, me)?.name}</strong><span>Bản xem thử</span></div></div>
    </aside>
    <div className="app">
      <header className="app-header">
        <div className="mobile-brand"><Brand /></div>
        <div className="app-breadcrumb"><span>Chuyến đi</span><span aria-hidden>/</span><strong>{data.trip.name}</strong></div>
        <div className="header-actions">
          <a className="tag demo-tag" href="/">Dữ liệu thật</a>
          <a className="icon-button" href="#lich-trinh" aria-label="Lịch trình" aria-current={route === 'lich-trinh' ? 'page' : undefined}><CalendarDays size={21} aria-hidden /></a>
          <a className="icon-button" href="#cai-dat" aria-label="Cài đặt chuyến đi" aria-current={route === 'cai-dat' ? 'page' : undefined}><Settings2 size={22} aria-hidden /></a>
        </div>
      </header>
      <main className={`main ${active === 'tong-quan' ? 'main-overview' : ''}`} tabIndex={-1} ref={main}>
        {storageError && <p className="inline-note error" role="status">Trình duyệt chưa lưu được dữ liệu xem thử trên thiết bị.</p>}
        {content}
      </main>
    </div>
    {!form && <Navigation active={active} />}
  </div>;
}
