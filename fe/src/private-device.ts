import type { TripOverview } from './api-data';
import type { Category } from './model';
import { baseUrl } from './api-client';

export type ExpenseDraft = {
  fields: { title: string; date: string; category: Category; note: string };
  amount: string; payer: string; mode: 'equal' | 'exact'; selected: string[];
  exact: Record<string, string>;
};
type PrivateRecord = { uid: string; tripId: string; kind: 'overview' | 'expense-new'; at: number };
export type DeviceScope = { uid: string; tripId: string };
const maxAge = 24 * 60 * 60_000;
const storage = 'data';

export const preferenceKey = (uid: string) => 'sharebill-trusted-device:' + encodeURIComponent(baseUrl()) + ':' + uid;
export function trustedDevice(uid: string) {
  try { return localStorage.getItem(preferenceKey(uid)) === '1'; } catch { return false; }
}

export function setTrustedDevice(uid: string, enabled: boolean) {
  if (enabled) localStorage.setItem(preferenceKey(uid), '1');
  else localStorage.removeItem(preferenceKey(uid));
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('sharebill-private-v1:' + baseUrl(), 1);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore(storage, { keyPath: ['uid', 'tripId', 'kind'] });
      store.createIndex('account', 'uid');
      store.createIndex('trip', ['uid', 'tripId']);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function transaction(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void) {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storage, mode);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      try { run(tx.objectStore(storage)); }
      catch (cause) { tx.abort(); reject(cause); }
    });
  } finally { db.close(); }
}

async function get<T>(scope: DeviceScope, kind: PrivateRecord['kind']) {
  if (!trustedDevice(scope.uid)) return;
  let entry: (PrivateRecord & { value: T }) | undefined;
  await transaction('readonly', store => {
    const request = store.get([scope.uid, scope.tripId, kind]);
    request.onsuccess = () => { entry = request.result; };
  });
  if (entry && Date.now() - entry.at >= maxAge) {
    await transaction('readwrite', store => { store.delete([scope.uid, scope.tripId, kind]); });
    return;
  }
  return entry && trustedDevice(scope.uid) ? entry : undefined;
}

async function put<T>(scope: DeviceScope, kind: PrivateRecord['kind'], value: T, at = Date.now()) {
  if (!trustedDevice(scope.uid)) return;
  await transaction('readwrite', store => {
    if (trustedDevice(scope.uid)) store.put({ ...scope, kind, at, value });
  });
}

export function clearDeviceData(uid: string, tripId?: string) {
  return transaction('readwrite', store => {
    const cursor = tripId ? store.index('trip').openCursor(IDBKeyRange.only([uid, tripId]))
      : store.index('account').openCursor(IDBKeyRange.only(uid));
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (entry) { entry.delete(); entry.continue(); }
    };
  });
}

export function saveTripSnapshot(scope: DeviceScope, value: TripOverview, at: number) {
  // Persist only display fields needed to review balances and draft an expense.
  const { id, name, startDate, endDate, status, ownerUid, moderationStatus, version, ledgerVersion,
    timezone, participantCount, activeExpenseCount, totalExpenseMinor, pendingSettlementCount,
    myParticipantId, sharingMode, equalParticipantIds } = value.trip;
  return put(scope, 'overview', {
    trip: {
      id, name, startDate, endDate, status, ownerUid, moderationStatus, version, ledgerVersion, timezone,
      participantCount, activeExpenseCount, totalExpenseMinor, pendingSettlementCount, destination: null, note: null,
      myParticipantId, sharingMode, equalParticipantIds,
    },
    participants: value.participants.map(({ id, displayName, status, linkedUid, version }) =>
      ({ id, displayName, status, linkedUid: linkedUid === scope.uid || linkedUid === ownerUid ? linkedUid : null, version })),
    balances: value.balances.map(({ participantId, paidMinor, owedMinor, sentMinor, receivedMinor, netMinor }) =>
      ({ participantId, paidMinor, owedMinor, sentMinor, receivedMinor, netMinor })),
  } satisfies TripOverview, at);
}

export async function getTripSnapshot(scope: DeviceScope) {
  const snapshot = await get<TripOverview>(scope, 'overview');
  // Older app versions omitted the sharing mode. Do not guess it for an open trip.
  if (snapshot?.value.trip.status === 'active' && snapshot.value.trip.sharingMode === undefined) return;
  return snapshot;
}
export const getExpenseDraft = (scope: DeviceScope) => get<ExpenseDraft>(scope, 'expense-new');
export const saveExpenseDraft = (scope: DeviceScope, draft: ExpenseDraft) => put(scope, 'expense-new', draft);
export const clearExpenseDraft = (scope: DeviceScope) =>
  transaction('readwrite', store => { store.delete([scope.uid, scope.tripId, 'expense-new']); });
