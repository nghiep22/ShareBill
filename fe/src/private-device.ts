import type { TripOverview } from './api-data';
import { baseUrl } from './api-client';
import { isExpenseDraft, isTripSnapshot, readPrivateRecord, type DeviceScope, type ExpenseDraft, type PrivateRecord } from './private-record';

export type { DeviceScope, ExpenseDraft } from './private-record';
const ioTimeout = 5_000;
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
    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(cause);
    };
    const timer = setTimeout(() => fail(new Error('Private storage timed out')), ioTimeout);
    let open: IDBOpenDBRequest;
    try { open = indexedDB.open('sharebill-private-v1:' + baseUrl(), 1); }
    catch (cause) { fail(cause); return; }
    open.onupgradeneeded = () => {
      if (settled) { open.transaction?.abort(); return; }
      const store = open.result.createObjectStore(storage, { keyPath: ['uid', 'tripId', 'kind'] });
      store.createIndex('account', 'uid');
      store.createIndex('trip', ['uid', 'tripId']);
    };
    open.onsuccess = () => {
      const db = open.result;
      if (settled) { db.close(); return; }
      settled = true;
      clearTimeout(timer);
      db.onversionchange = () => db.close();
      resolve(db);
    };
    open.onerror = () => fail(open.error);
    open.onblocked = () => fail(new Error('Private storage is blocked'));
  });
}

async function transaction(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void) {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storage, mode);
      const timer = setTimeout(() => {
        try { tx.abort(); } catch { /* The transaction may already have finished. */ }
        reject(new Error('Private storage timed out'));
      }, ioTimeout);
      tx.oncomplete = () => { clearTimeout(timer); resolve(); };
      tx.onabort = () => { clearTimeout(timer); reject(tx.error); };
      try { run(tx.objectStore(storage)); }
      catch (cause) { clearTimeout(timer); tx.abort(); reject(cause); }
    });
  } finally { db.close(); }
}

async function get<T>(scope: DeviceScope, kind: PrivateRecord<T>['kind'], valid: (value: unknown) => value is T) {
  if (!trustedDevice(scope.uid)) return;
  let entry: PrivateRecord<T> | undefined;
  // Validate and discard in one transaction, so another tab's newer save cannot be deleted.
  await transaction('readwrite', store => {
    const request = store.get([scope.uid, scope.tripId, kind]);
    request.onsuccess = () => {
      entry = readPrivateRecord(request.result, scope, kind, valid);
      if (request.result !== undefined && !entry) store.delete([scope.uid, scope.tripId, kind]);
    };
  });
  return entry && trustedDevice(scope.uid) ? entry : undefined;
}

async function put<T>(scope: DeviceScope, kind: PrivateRecord<T>['kind'], value: T, at = Date.now()) {
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

export const getTripSnapshot = (scope: DeviceScope) => get(scope, 'overview', (value): value is TripOverview => isTripSnapshot(value, scope));
export const getExpenseDraft = (scope: DeviceScope) => get(scope, 'expense-new', isExpenseDraft);
export const saveExpenseDraft = (scope: DeviceScope, draft: ExpenseDraft) => put(scope, 'expense-new', draft);
export const clearExpenseDraft = (scope: DeviceScope) =>
  transaction('readwrite', store => { store.delete([scope.uid, scope.tripId, 'expense-new']); });
