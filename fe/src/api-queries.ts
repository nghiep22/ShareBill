'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, type Page, type ShareBillApi } from './api-client';

function canKeepData(error: unknown) {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500 || error.status === 429);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Chưa tải được dữ liệu.';
}

export function useApiRead<T>(api: ShareBillApi, path: string | undefined, epoch: number, body?: object, prepareGroupSharing = false) {
  const bodyString = body && JSON.stringify(body);
  const key = path + ':' + (bodyString ?? '');
  const [result, setResult] = useState<{ key: string; epoch: number; data?: T; error?: string; status?: number; loadedAt?: number }>();

  useEffect(() => {
    if (!path) { setResult(undefined); return; }
    let valid = true;
    const load = async () => {
      let data = await api.read<T>(path, bodyString ? JSON.parse(bodyString) : undefined);
      const trip = (data as { trip?: { sharingMode?: string; status?: string; moderationStatus?: string } }).trip;
      if (prepareGroupSharing && trip && trip.sharingMode === undefined && trip.status === 'active' && trip.moderationStatus === 'normal') {
        await api.write(path.replace(/\/overview$/, '/share-equally'), {});
        data = await api.read<T>(path);
      }
      return data;
    };
    load().then(
      data => { if (valid) setResult({ key, epoch, data, loadedAt: Date.now() }); },
      cause => {
        if (valid) setResult(previous => ({
          key, epoch, data: previous?.key === key && canKeepData(cause) ? previous.data : undefined,
          loadedAt: previous?.key === key && canKeepData(cause) ? previous.loadedAt : undefined,
          error: errorMessage(cause), status: cause instanceof ApiError ? cause.status : undefined,
        }));
      },
    );
    return () => { valid = false; };
  }, [api, path, epoch, bodyString, key, prepareGroupSharing]);

  const visible = path && result?.key === key ? result : undefined;
  return { data: visible?.data, error: visible?.error, status: visible?.status, loadedAt: visible?.loadedAt,
    loading: Boolean(path && visible?.epoch !== epoch) };
}

export function useApiPage<T>(api: ShareBillApi, path: string | undefined, query: Record<string, string | undefined>, epoch: number) {
  const filter = JSON.stringify(query);
  const key = path + ':' + filter;
  const [result, setResult] = useState<{ key: string; epoch: number; page?: Page<T>; error?: string; notice?: string }>();
  const [paging, setPaging] = useState(false);
  const pagingGate = useRef(false);
  const sequence = useRef(0);

  useEffect(() => {
    const current = ++sequence.current;
    setPaging(false);
    pagingGate.current = false;
    if (!path) { setResult(undefined); return; }
    api.page<T>(path, JSON.parse(filter)).then(
      page => { if (sequence.current === current) setResult({ key, epoch, page }); },
      cause => {
        if (sequence.current === current) setResult(previous => ({
          key, epoch, page: previous?.key === key && canKeepData(cause) ? previous.page : undefined, error: errorMessage(cause),
        }));
      },
    );
    return () => { sequence.current++; };
  }, [api, path, filter, key, epoch]);

  const visible = path && result?.key === key ? result : undefined;
  const currentPage = visible?.page;
  const settled = visible?.epoch === epoch;
  async function loadMore() {
    if (!path || !currentPage?.nextCursor || !settled || pagingGate.current) return;
    const current = sequence.current;
    pagingGate.current = true;
    setPaging(true);
    try {
      const next = await api.page<T>(path, JSON.parse(filter), currentPage.nextCursor);
      if (sequence.current === current) setResult({ key, epoch, page: { ...next, items: [...currentPage.items, ...next.items] } });
    } catch (cause) {
      if (sequence.current !== current) return;
      if (cause instanceof ApiError && cause.code === 'CURSOR_STALE') {
        try {
          const page = await api.page<T>(path, JSON.parse(filter));
          if (sequence.current === current) setResult({ key, epoch, page, notice: 'Danh sách vừa thay đổi. Đã tải lại từ đầu.' });
        } catch (retry) {
          if (sequence.current === current) setResult({ key, epoch, error: retry instanceof Error ? retry.message : 'Chưa tải được danh sách.' });
        }
      } else {
        const unavailable = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
        setResult({ key, epoch, page: unavailable ? undefined : currentPage, error: cause instanceof Error ? cause.message : 'Chưa tải được danh sách.' });
      }
    } finally {
      if (sequence.current === current) { pagingGate.current = false; setPaging(false); }
    }
  }

  return {
    items: currentPage?.items ?? [], error: visible?.error, notice: visible?.notice,
    loading: Boolean(path && (!settled || paging)), more: currentPage?.nextCursor ? loadMore : undefined,
  };
}
