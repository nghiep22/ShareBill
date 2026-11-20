import { describe, expect, it, vi } from 'vitest';
import { decodeCursor, encodeCursor, cursorValue, timestampPoint, type CursorScope } from '../src/http/cursor.js';
import { Timestamp } from 'firebase-admin/firestore';

describe('signed list cursor', () => {
  const scope: CursorScope = { kind: 'expenses', uid: 'owner', tripId: 'trip-one',
    filters: { status: 'active', category: 'food' }, sort: 'occurredOn' };
  it('roundtrips a tied sort value with its document ID', () => {
    vi.stubEnv('CURSOR_SIGNING_SECRET', 'unit-test-cursor-signing-secret-123456');
    const first = encodeCursor(scope, 7, { value: '2026-12-20', id: 'expense-z' });
    const second = encodeCursor(scope, 7, { value: '2026-12-20', id: 'expense-a' });
    expect(decodeCursor(first, scope, 7)).toEqual({ value: '2026-12-20', id: 'expense-z' });
    expect(decodeCursor(second, scope, 7).id).toBe('expense-a');
    const time = new Timestamp(1_800_000_000, 123_456_789);
    expect(cursorValue(decodeCursor(encodeCursor({ ...scope, sort: 'createdAt' }, 7,
      timestampPoint(time, 'event-1')), { ...scope, sort: 'createdAt' }, 7).value)).toEqual(time);
    vi.unstubAllEnvs();
  });
  it('rejects tampering, oversized cursors, changed filters and stale revisions', () => {
    vi.stubEnv('CURSOR_SIGNING_SECRET', 'unit-test-cursor-signing-secret-123456');
    const token = encodeCursor(scope, 7, { value: '2026-12-20', id: 'expense-z' });
    expect(() => decodeCursor(`${token}x`, scope, 7)).toThrow();
    expect(() => decodeCursor('a'.repeat(2049), scope, 7)).toThrow();
    expect(() => decodeCursor(token, { ...scope, tripId: 'trip-two' }, 7)).toThrow();
    expect(() => decodeCursor(token, { ...scope, uid: 'another-user' }, 7)).toThrow();
    expect(() => decodeCursor(token, { ...scope, filters: { status: 'void', category: 'food' } }, 7)).toThrow();
    expect(() => decodeCursor(token, scope, 8)).toThrowError(/thay đổi/i);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
    const expiring = encodeCursor(scope, 7, { value: '2026-12-20', id: 'expense-z' });
    vi.setSystemTime(new Date('2026-11-18T00:00:01Z'));
    expect(() => decodeCursor(expiring, scope, 7)).toThrow();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
});
