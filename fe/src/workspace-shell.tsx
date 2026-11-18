'use client';

import {
  CalendarDays, ChevronDown, ChevronRight, CircleHelp, History, LayoutGrid, Luggage,
  ReceiptText, RefreshCw, Scale, Settings2, UserRound, Users, WalletCards, WifiOff,
} from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { isOwner, memberFor, viewerOf, type Demo } from './model';
import { Avatar, Dialog } from './ui';
import { tripHref } from './workspace-route';

const tabs = [
  { id: 'tong-quan', label: 'Tổng quan', Icon: LayoutGrid },
  { id: 'chi-tieu', label: 'Chi tiêu', Icon: ReceiptText },
  { id: 'so-du', label: 'Số dư', Icon: Scale },
  { id: 'thanh-vien', label: 'Thành viên', Icon: Users },
];
const extra = [
  { id: 'lich-trinh', label: 'Lịch trình', Icon: CalendarDays },
  { id: 'hoat-dong', label: 'Hoạt động', Icon: History },
  { id: 'cai-dat', label: 'Cài đặt chuyến đi', Icon: Settings2 },
];

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function subscribeNetwork(listener: () => void) {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

export function useHash() {
  return useSyncExternalStore(subscribe, () => window.location.hash.slice(1), () => '');
}

export function useOnline() {
  return useSyncExternalStore(subscribeNetwork, () => navigator.onLine, () => true);
}

export function useServiceWorker() {
  const [waiting, setWaiting] = useState<ServiceWorkerRegistration>();
  useEffect(() => {
    let active = true;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null | undefined;
    const check = () => {
      if (active && registration?.waiting && navigator.serviceWorker.controller) setWaiting(registration);
    };
    const found = () => {
      installing?.removeEventListener('statechange', check);
      installing = registration?.installing;
      installing?.addEventListener('statechange', check);
    };
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').then(value => {
        if (!active) return;
        registration = value;
        registration.addEventListener('updatefound', found);
        check();
      }).catch(() => {});
    }
    return () => {
      active = false;
      registration?.removeEventListener('updatefound', found);
      installing?.removeEventListener('statechange', check);
    };
  }, []);
  return waiting ? () => {
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    waiting.waiting?.postMessage({ type: 'ACTIVATE_UPDATE' });
  } : undefined;
}

function Brand({ target }: { target: string }) {
  return <a className="brand" href={target} aria-label="ShareBill, về trang chính">
    <span className="brand-icon"><WalletCards size={23} strokeWidth={2.1} aria-hidden /></span><strong>Share<span>Bill</span></strong>
  </a>;
}

function Navigation({ desktop, active, data }: { desktop?: boolean; active: string; data: Demo }) {
  return <nav className={desktop ? 'side-nav' : 'bottom-nav'} aria-label={desktop ? 'Điều hướng chuyến đi' : 'Điều hướng chính'}>
    {(desktop ? [...tabs, ...extra] : tabs).map(({ id, label, Icon }) =>
      <a key={id} href={tripHref(data, id)} aria-current={active === id ? 'page' : undefined}>
        <span className="nav-icon"><Icon size={20} strokeWidth={active === id ? 2.3 : 1.8} aria-hidden /></span><span>{label}</span>
      </a>)}
  </nav>;
}

export function WorkspaceShell({ hash, route, data, profileName, preview, publicPage, refresh, children }: {
  hash: string; route: string; data?: Demo; profileName?: string; preview?: boolean; publicPage?: boolean; refresh?: () => void; children: ReactNode;
}) {
  const form = route === 'them-khoan-chi' || route === 'sua-khoan-chi';
  const active = route === 'khoan-chi' || form ? 'chi-tieu' : route === 'quyet-toan' ? 'so-du' : route;
  const viewer = data && memberFor(data, viewerOf(data));
  const online = useOnline();
  const activateUpdate = useServiceWorker();
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const main = useRef<HTMLElement>(null);
  const lastHash = useRef(hash);
  const home = data ? tripHref(data, 'tong-quan') : publicPage ? '#dang-nhap' : '#chuyen-di';

  useEffect(() => {
    if (lastHash.current === hash) return;
    lastHash.current = hash;
    window.scrollTo(0, 0);
    main.current?.focus({ preventScroll: true });
  }, [hash]);

  return <div className={'workspace' + (form ? ' workspace-form' : '') + (publicPage ? ' workspace-public' : '')}>
    {!publicPage && <aside className="sidebar">
      <Brand target={home} />
      <a className="trip-switcher" href="#chuyen-di" aria-current={route === 'chuyen-di' ? 'page' : undefined}>
        <span className="tile-icon"><Luggage size={19} aria-hidden /></span>
        <span><small>Chuyến đi của tôi</small><strong>{data?.trip.name ?? 'Danh sách chuyến đi'}</strong></span><ChevronDown size={17} aria-hidden />
      </a>
      {data && <Navigation desktop active={active} data={data} />}
      <a className="sidebar-help" href="#tro-giup" aria-current={route === 'tro-giup' ? 'page' : undefined}><CircleHelp size={19} aria-hidden /> Trợ giúp</a>
      <a className="sidebar-footer" href="#tai-khoan">
        {viewer ? <Avatar member={viewer} /> : <span className="avatar"><UserRound size={17} aria-hidden /></span>}
        <div><strong>{profileName ?? viewer?.name ?? 'Tài khoản'}</strong><span>{data && (isOwner(data) ? 'Chủ chuyến' : 'Thành viên')}{preview && ' · Bản xem thử'}</span></div><ChevronRight size={17} aria-hidden />
      </a>
    </aside>}
    <div className="app">
      <header className="app-header">
        <div className={publicPage ? undefined : 'mobile-brand'}><Brand target={home} /></div>
        {!publicPage && <div className="app-breadcrumb"><a href="#chuyen-di">Chuyến đi</a>{data && <><ChevronRight size={15} aria-hidden /><strong>{data.trip.name}</strong></>}</div>}
        <div className="header-actions">
          {preview && <span className="tag mint preview-tag"><span /> Bản xem thử</span>}
          {publicPage ? <a className="secondary-button compact" href="/demo/">Xem bản mẫu</a> : <>
            <a className="icon-button mobile-trips" href="#chuyen-di" aria-label="Danh sách chuyến đi"><Luggage size={21} aria-hidden /></a>
            {data && <a className="icon-button" href={tripHref(data, 'hoat-dong')} aria-label="Hoạt động chuyến đi" aria-current={route === 'hoat-dong' ? 'page' : undefined}><History size={21} aria-hidden /></a>}
            {refresh && <button className="icon-button refresh-button" onClick={refresh} aria-label="Làm mới dữ liệu"><RefreshCw size={19} aria-hidden /></button>}
            <a className="icon-button" href="#tai-khoan" aria-label="Tài khoản"><UserRound size={21} aria-hidden /></a>
          </>}
        </div>
      </header>
      <main className={'main' + (active === 'tong-quan' && data ? ' main-overview' : '')} tabIndex={-1} ref={main}>
        {!online && (preview ? <a className="inline-note workspace-notice" href="#ngoai-tuyen"><WifiOff size={17} aria-hidden /> Ngoại tuyến · Dữ liệu trên thiết bị</a>
          : <p className="inline-note workspace-notice" role="status"><WifiOff size={17} aria-hidden /> Ngoại tuyến · Cần kết nối mạng để đồng bộ</p>)}
        {activateUpdate && <p className="inline-note workspace-notice" role="status">Có phiên bản ShareBill mới.
          <button className="text-button" onClick={() => setConfirmUpdate(true)}>Cập nhật</button></p>}
        {children}
      </main>
    </div>
    {!publicPage && !form && data && <Navigation active={active} data={data} />}
    {confirmUpdate && <Dialog title="Cập nhật ShareBill?" onClose={() => setConfirmUpdate(false)}>
      <p>Trang sẽ tải lại. Hãy lưu nội dung đang nhập trước khi cập nhật. Bản nháp đã lưu trên thiết bị tin cậy có thể mở lại.</p>
      <div className="button-pair"><button className="secondary-button" onClick={() => setConfirmUpdate(false)}>Để sau</button>
        <button className="primary-button" onClick={activateUpdate}>Tải phiên bản mới</button></div>
    </Dialog>}
  </div>;
}
