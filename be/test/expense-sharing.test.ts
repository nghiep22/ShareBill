import { describe, expect, it } from 'vitest';
import { expenseRepayments, expenseShares } from '../../fe/src/expense-sharing.js';
import { financialSnapshot } from '../../fe/src/finance-view.js';
import type { Demo, Expense } from '../../fe/src/model.js';

const data = (): Demo => ({ trip: { name: 'Trip', place: '', start: '', end: '', closed: false },
  members: ['a', 'b', 'c'].map((id, tone) => ({ id, name: id, tone })), expenses: [], settlements: [], plans: [],
  remote: { tripId: 'trip', actorUid: 'user', owner: true, writable: true, suspended: false, version: 1, ledgerVersion: 1,
    sharingMode: 'group-equal', equalParticipantIds: ['a', 'b', 'c'], participantCount: 3, expenseCount: 1, pendingCount: 0,
    total: 700000, balances: [], suggestions: [], suggestionsReady: false } });
const bill = (): Expense => ({ id: 'bill', title: 'Vé', payer: 'a', amount: 700000, mode: 'equal', sharingScope: 'selected',
  shares: { a: 350000, b: 350000 }, date: '2026-11-26', category: 'other', note: '' });
describe('expense-scoped sharing', () => {
  it('uses the selected bill participants before trip-wide suggestions have loaded', () => {
    expect(expenseShares(data(), bill())).toEqual({ a: 350000, b: 350000 });
    expect(expenseRepayments(data(), bill())).toEqual([{ from: 'b', to: 'a', amount: 350000 }]);
  });
  it('keeps legacy group display shared across current members without changing its record', () => {
    const expense = bill(); delete expense.sharingScope;
    expect(Object.values(expenseShares(data(), expense)!)).toEqual([233334, 233333, 233333]);
    expect(expense.shares).toEqual({ a: 350000, b: 350000 });
  });
  it('allows the payer outside the split and omits zero shares from QR', () => {
    expect(expenseRepayments(data(), { ...bill(), shares: { b: 700000, c: 0 } })).toEqual([{ from: 'b', to: 'a', amount: 700000 }]);
  });
  it.each([{ b: 600000 }, { a: 350000, outside: 350000 }, { a: 350000.5, b: 349999.5 }] as Record<string, number>[])('rejects invalid bill shares %#', shares => {
    expect(expenseRepayments(data(), { ...bill(), shares })).toBeUndefined();
  });
  it('validates fixed selected shares and a member who owes none of this expense', () => {
    const state = data();
    state.remote!.balances = [
      { participantId: 'a', paidMinor: 700000, owedMinor: 350000, allocatedOwedMinor: 350000, sentMinor: 0, receivedMinor: 0, netMinor: 350000 },
      { participantId: 'b', paidMinor: 0, owedMinor: 350000, allocatedOwedMinor: 350000, sentMinor: 0, receivedMinor: 0, netMinor: -350000 },
      { participantId: 'c', paidMinor: 0, owedMinor: 0, sentMinor: 0, receivedMinor: 0, netMinor: 0 },
    ];
    expect(financialSnapshot(state).complete).toBe(true);
    state.remote!.balances[0]!.allocatedOwedMinor = 350001;
    expect(financialSnapshot(state).complete).toBe(false);
  });
});
