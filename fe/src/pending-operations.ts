export type PendingOperation = { key: string; fingerprint: string; startedAt: number };

const prefix = 'sharebill-pending-operations-v1:';

export function pendingStorageKey(origin: string, uid: string) {
  return prefix + encodeURIComponent(origin) + ':' + encodeURIComponent(uid);
}

export function readPending(storageKey: string): PendingOperation[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is PendingOperation => Boolean(item &&
      typeof item.key === 'string' && /^[\da-f-]{36}$/i.test(item.key) &&
      typeof item.fingerprint === 'string' && /^[\da-f]{64}$/.test(item.fingerprint) && Number.isFinite(item.startedAt)));
  } catch {
    return [];
  }
}

export function writePending(storageKey: string, entries: PendingOperation[]) {
  try {
    if (entries.length) sessionStorage.setItem(storageKey, JSON.stringify(entries));
    else sessionStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

export async function requestFingerprint(value: unknown) {
  if (!crypto.subtle) return undefined;
  const canonical = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  try {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { return undefined; }
}
