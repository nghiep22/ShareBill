import { describe, expect, it } from 'vitest';
import { financialSnapshot, transferLimit, validSuggestions } from '../../fe/src/finance-view.js';
import { parseMoney, parsePositiveMoney } from '../../fe/src/money-input.js';
import { splitEqually, type Demo } from '../../fe/src/model.js';
import { splitEqual } from '../src/domain/money.js';

function fixture(): Demo {
  return { trip: { name: 'Money fixture', place: '', start: '', end: '', closed: false },
    members: ['a', 'b', 'c'].map((id, tone) => ({ id, name: id, tone })), expenses: [], settlements: [], plans: [],
    remote: { tripId: 'fixture', actorUid: 'user', owner: true, writable: true, suspended: false, version: 1,
      ledgerVersion: 1, participantCount: 3, expenseCount: 1, pendingCount: 0, total: 100000, suggestionsReady: true,
      balances: [
        { participantId: 'a', paidMinor: 100000, owedMinor: 33334, sentMinor: 0, receivedMinor: 10000, netMinor: 56666 },
        { participantId: 'b', paidMinor: 0, owedMinor: 33333, sentMinor: 10000, receivedMinor: 0, netMinor: -23333 },
        { participantId: 'c', paidMinor: 0, owedMinor: 33333, sentMinor: 0, receivedMinor: 0, netMinor: -33333 },
      ], suggestions: [{ from: 'b', to: 'a', amount: 23333 }, { from: 'c', to: 'a', amount: 33333 }] } };
}

describe('money views', () => {
  it('accepts group totals and rejects a valid-looking old per-expense allocation in group mode', () => {
    const data = fixture();
    data.remote!.sharingMode = 'group-equal'; data.remote!.equalParticipantIds = ['c', 'a', 'b'];
    expect(financialSnapshot(data).complete).toBe(true);
    for (const row of data.remote!.balances) {
      row.owedMinor = row.participantId === 'a' ? 100000 : 0;
      row.netMinor = row.paidMinor - row.owedMinor + row.sentMinor - row.receivedMinor;
    }
    expect(financialSnapshot(data).complete).toBe(false);
  });
  it.each([{ ids: undefined }, { ids: [] }, { ids: ['a', 'a'] }, { ids: ['outside'] }])('requires a complete group membership set $ids', ({ ids }) => {
    const data = fixture(); data.remote!.sharingMode = 'group-equal'; data.remote!.equalParticipantIds = ids;
    expect(financialSnapshot(data).complete).toBe(false);
  });
  it('keeps the full owed share separate from remaining debt after partial confirmed transfers', () => {
    const state = financialSnapshot(fixture());
    expect(state.complete).toBe(true);
    expect(state.lines.b!.owedMinor).toBe(33333);
    expect(state.net.b).toBe(-23333);
    expect(state.balanced).toBe(false);
  });
  it('uses the complete server snapshot even when the expense page is empty or filtered', () => {
    const data = fixture();
    expect(data.expenses).toEqual([]);
    expect(financialSnapshot(data).lines.a!.paidMinor).toBe(100000);
    expect(validSuggestions(data)).toEqual(data.remote!.suggestions);
  });
  it.each(['missing', 'duplicate', 'foreign', 'counter', 'noninteger', 'equation', 'total', 'transfers', 'negative', 'empty-count'])(
    'does not display balance conclusions for an inconsistent snapshot: %s', kind => {
      const data = fixture(), remote = data.remote!;
      if (kind === 'missing') remote.balances.pop();
      if (kind === 'duplicate') remote.balances[2] = { ...remote.balances[1]! };
      if (kind === 'foreign') remote.balances[2]!.participantId = 'outsider';
      if (kind === 'counter') remote.participantCount = 4;
      if (kind === 'noninteger') remote.balances[0]!.owedMinor = 33.33;
      if (kind === 'equation') remote.balances[1]!.netMinor++;
      if (kind === 'total') remote.total++;
      if (kind === 'transfers') { remote.balances[0]!.receivedMinor++; remote.balances[0]!.netMinor--; }
      if (kind === 'negative') remote.balances[0]!.paidMinor = -1;
      if (kind === 'empty-count') remote.expenseCount = 0;
      expect(financialSnapshot(data)).toMatchObject({ complete: false, balanced: false, net: {} });
      expect(validSuggestions(data)).toEqual([]);
    });
  it('requires both zero net for every member and no pending requests before archive', () => {
    const data = fixture();
    data.remote!.balances = data.remote!.balances.map(row => ({ ...row, paidMinor: row.owedMinor, sentMinor: 0, receivedMinor: 0, netMinor: 0 }));
    expect(financialSnapshot(data).balanced).toBe(true);
    data.remote!.pendingCount = 1;
    expect(financialSnapshot(data).balanced).toBe(false);
    data.remote!.balances = [];
    expect(financialSnapshot(data).balanced).toBe(false);
  });
  it.each(['stale', 'partial', 'overpay', 'wrong-pair', 'zero'])(
    'does not present invalid/incomplete transfer suggestions: %s', kind => {
      const data = fixture(), remote = data.remote!;
      if (kind === 'stale') remote.suggestionsReady = false;
      if (kind === 'partial') remote.suggestions.pop();
      if (kind === 'overpay') remote.suggestions[0]!.amount++;
      if (kind === 'wrong-pair') remote.suggestions[0]!.to = 'c';
      if (kind === 'zero') remote.suggestions[0]!.amount = 0;
      expect(validSuggestions(data)).toEqual([]);
    });
  it('matches equal-split server rounding for 1đ, 100.000đ and maximum VND values', () => {
    const ids = ['a', 'b', 'c'];
    for (const amount of [1, 2, 100000, 1_000_000_000_000]) {
      const expected = Object.fromEntries(splitEqual(amount, ids).map(row => [row.participantId, row.amountMinor]));
      expect(splitEqually(amount, ids)).toEqual(expected);
      expect(splitEqually(amount, [...ids].reverse())).toEqual(expected);
      expect(Object.values(expected).reduce((sum, value) => sum + value, 0)).toBe(amount);
      expect(Math.max(...Object.values(expected)) - Math.min(...Object.values(expected))).toBeLessThanOrEqual(1);
    }
  });
});

describe('VND inputs', () => {
  it('caps a single repayment at the API limit even when accumulated trip debt is larger', () => {
    expect(transferLimit(-2_000_000_000_000, 2_000_000_000_000)).toBe(1_000_000_000_000);
    expect(transferLimit(-30000, 20000)).toBe(20000);
  });
  it('does not offer a transfer for invalid or reversed balance roles', () => {
    expect(transferLimit(100, -100)).toBe(0);
    expect(transferLimit(NaN, 100)).toBe(0);
  });
  it.each([['10.000', 10000], ['10,000', 10000], [' 10000 ', 10000], ['1', 1], ['1.000.000.000.000', 1e12]])('parses %s as %i whole VND', (text, expected) => {
    expect(parsePositiveMoney(String(text))).toBe(expected);
  });
  it.each(['', '0', '-1', '1.5', '1,5', '1e5', '1.000,00', '12.34', 'NaN', 'Infinity', '1000000000001'])('rejects ambiguous/invalid money: %s', text => {
    expect(parsePositiveMoney(text)).toBeUndefined();
  });
  it('allows an empty editing field without treating it as a payment', () => { expect(parseMoney('')).toBe(''); });
});
