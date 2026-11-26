import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isExpenseDraft, isTripSnapshot, readPrivateRecord, type ExpenseDraft } from '../../fe/src/private-record.js';
import { getExpenseDraft, saveExpenseDraft } from '../../fe/src/private-device.js';

const scope = { uid: 'account-a', tripId: 'trip-a' };
const now = 1_795_000_000_000;
function overview() {
  return {
    trip: { id: scope.tripId, name: 'Offline group', destination: null, note: null, startDate: null, endDate: null,
      status: 'active', ownerUid: scope.uid, moderationStatus: 'normal', version: 1, ledgerVersion: 1,
      participantCount: 2, activeExpenseCount: 1, totalExpenseMinor: 100001, pendingSettlementCount: 0,
      timezone: 'Asia/Ho_Chi_Minh', sharingMode: 'group-equal', equalParticipantIds: ['a', 'b'], myParticipantId: 'a' },
    participants: ['a', 'b'].map(id => ({ id, displayName: id, status: 'active', linkedUid: id === 'a' ? scope.uid : null, version: 1 })),
    balances: [
      { participantId: 'a', paidMinor: 100001, owedMinor: 50001, sentMinor: 0, receivedMinor: 0, netMinor: 50000 },
      { participantId: 'b', paidMinor: 0, owedMinor: 50000, sentMinor: 0, receivedMinor: 0, netMinor: -50000 },
    ],
  };
}
const draft = (): ExpenseDraft => ({ fields: { title: '', date: '', category: 'other', note: '' },
  amount: '', payer: '', mode: 'equal', selected: [], exact: {} });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('private cache validation', () => {
  it('accepts a complete group snapshot with rounding and a partial draft', () => {
    expect(isTripSnapshot(overview(), scope)).toBe(true);
    expect(isExpenseDraft(draft())).toBe(true);
  });
  it.each([
    ['missing participants', (value: ReturnType<typeof overview>) => { Object.assign(value, { participants: null }); }],
    ['wrong trip', (value: ReturnType<typeof overview>) => { value.trip.id = 'another-trip'; }],
    ['invalid timezone', (value: ReturnType<typeof overview>) => { value.trip.timezone = 'Unknown/Zone'; }],
    ['invalid date', (value: ReturnType<typeof overview>) => { Object.assign(value.trip, { startDate: '2026-02-30', endDate: '2026-03-01' }); }],
    ['legacy active sharing mode', (value: ReturnType<typeof overview>) => { Reflect.deleteProperty(value.trip, 'sharingMode'); }],
    ['duplicate participants', (value: ReturnType<typeof overview>) => { value.participants[1]!.id = 'a'; }],
    ['fractional money', (value: ReturnType<typeof overview>) => { value.balances[0]!.paidMinor += 0.5; }],
    ['inconsistent group allocation', (value: ReturnType<typeof overview>) => { value.balances[0]!.owedMinor = 100001; value.balances[0]!.netMinor = 0; value.balances[1]!.owedMinor = 0; value.balances[1]!.netMinor = 0; }],
    ['unrelated viewer', (value: ReturnType<typeof overview>) => { value.trip.myParticipantId = 'outside'; }],
  ] as const)('rejects a snapshot with %s', (_name, change) => {
    const value = overview(); change(value);
    expect(isTripSnapshot(value, scope)).toBe(false);
  });
  it('keeps compatible archived per-expense history without a sharing mode', () => {
    const value = overview(); value.trip.status = 'archived'; Reflect.deleteProperty(value.trip, 'sharingMode');
    expect(isTripSnapshot(value, scope)).toBe(true);
  });
  it.each([
    null, {}, { ...draft(), fields: null }, { ...draft(), selected: ['a', 'a'] },
    { ...draft(), fields: { ...draft().fields, category: 'unknown' } },
    { ...draft(), fields: { ...draft().fields, date: '2026-02-30' } },
    { ...draft(), amount: '1e9' }, { ...draft(), exact: { a: 123 } },
  ])('ignores a malformed draft %#', value => { expect(isExpenseDraft(value)).toBe(false); });
  it.each([
    { uid: 'another-account' }, { tripId: 'another-trip' }, { kind: 'overview' },
    { at: NaN }, { at: Infinity }, { at: -1 }, { at: now + 1 }, { at: now - 24 * 60 * 60_000 },
  ])('rejects an unrelated or expired cache envelope %#', change => {
    const entry = { ...scope, kind: 'expense-new', at: now, value: draft(), ...change };
    expect(readPrivateRecord(entry, scope, 'expense-new', isExpenseDraft, now)).toBeUndefined();
  });
  it('accepts data just inside the 24-hour limit', () => {
    const entry = { ...scope, kind: 'expense-new', at: now - 24 * 60 * 60_000 + 1, value: draft() };
    expect(readPrivateRecord(entry, scope, 'expense-new', isExpenseDraft, now)).toBe(entry);
  });
});

describe('unavailable or stalled IndexedDB', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('NEXT_PUBLIC_SHAREBILL_API_URL', 'http://localhost:3001');
    vi.stubGlobal('localStorage', { getItem: () => '1' });
  });
  function database() {
    const get = vi.fn(() => ({}));
    const tx: { objectStore: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>; oncomplete?: () => void; onabort?: () => void } = {
      objectStore: vi.fn(() => ({ get, put: vi.fn() })), abort: vi.fn(),
    };
    const db = { close: vi.fn(), transaction: vi.fn(() => tx) };
    const open: { result: typeof db; transaction: { abort: ReturnType<typeof vi.fn> }; onsuccess?: () => void; onblocked?: () => void; onupgradeneeded?: () => void } = {
      result: db, transaction: { abort: vi.fn() },
    };
    vi.stubGlobal('indexedDB', { open: vi.fn(() => open) });
    return { db, tx, open };
  }
  it('stops waiting for an open request and closes any connection that arrives late', async () => {
    const { open, db } = database();
    const reading = getExpenseDraft(scope);
    const rejected = expect(reading).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    open.onupgradeneeded?.();
    expect(open.transaction.abort).toHaveBeenCalledOnce();
    open.onsuccess?.();
    expect(db.close).toHaveBeenCalledOnce();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports a blocked open immediately and releases a later connection', async () => {
    const { open, db } = database();
    const reading = getExpenseDraft(scope);
    const rejected = expect(reading).rejects.toThrow('blocked');
    open.onblocked?.();
    await rejected;
    open.onsuccess?.();
    expect(db.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts a stalled transaction and closes its database', async () => {
    const { open, tx, db } = database();
    const reading = getExpenseDraft(scope);
    const rejected = expect(reading).rejects.toThrow('timed out');
    open.onsuccess?.();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(tx.abort).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('propagates a quota error without leaving a timer or connection open', async () => {
    const { open, tx, db } = database();
    tx.objectStore.mockReturnValue({ put: () => { throw new DOMException('Full', 'QuotaExceededError'); } });
    const saving = saveExpenseDraft(scope, draft());
    const rejected = expect(saving).rejects.toMatchObject({ name: 'QuotaExceededError' });
    open.onsuccess?.();
    await rejected;
    expect(tx.abort).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
