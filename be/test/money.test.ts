import { describe, expect, it } from 'vitest';
import { splitEqual, validateExact, expenseDelta, expenseChangeDelta, zeroBalance, applyBalanceDelta, applyExpenseTotals, EXPENSE_CATEGORIES } from '../src/domain/money.js';
import { applySettlement } from '../src/domain/settlement.js';

describe('money invariants', () => {
  it('splits the remainder by stable participant ID', () => {
    expect(splitEqual(100000, ['p_C', 'p_A', 'p_B'])).toEqual([
      { participantId: 'p_A', amountMinor: 33334 },
      { participantId: 'p_B', amountMinor: 33333 },
      { participantId: 'p_C', amountMinor: 33333 },
    ]);
  });
  it('rejects an exact split that does not add up', () => {
    expect(() => validateExact(100, [{ participantId: 'p_A', amountMinor: 99 }])).toThrow('SPLIT_TOTAL_MISMATCH');
  });
  it('counts a payer who also owes a share once', () => {
    const delta = expenseDelta(100, 'p_A', splitEqual(100, ['p_A', 'p_B']), 1);
    expect(delta.get('p_A')).toEqual({ paidMinor: 100, owedMinor: 50, netMinor: 50 });
    const next = applyBalanceDelta({ participantId: 'p_A', paidMinor: 0, owedMinor: 0, sentMinor: 0, receivedMinor: 0, netMinor: 0 }, delta.get('p_A')!);
    expect(next.netMinor).toBe(50);
  });
  it('keeps category totals equal to active expenses across create and void', () => {
    const zero = Object.fromEntries(EXPENSE_CATEGORIES.map(category => [category, 0]));
    const first = applyExpenseTotals(0, zero, 'stay', 101, 1);
    const second = applyExpenseTotals(first.totalExpenseMinor, first.categoryTotalsMinor, 'food', 20, 1);
    const voided = applyExpenseTotals(second.totalExpenseMinor, second.categoryTotalsMinor, 'stay', 101, -1);
    expect(voided).toEqual({ totalExpenseMinor: 20,
      categoryTotalsMinor: { food: 20, transport: 0, stay: 0, tickets: 0, shopping: 0, other: 0 } });
    expect(() => applyExpenseTotals(0, zero, 'stay', 1, -1)).toThrow('EXPENSE_TOTALS_INVARIANT_FAILED');
    expect(() => applyExpenseTotals(10, zero, 'stay', 1, 1)).toThrow('EXPENSE_TOTALS_INVARIANT_FAILED');
    const nearLimit = { ...zero, stay: Number.MAX_SAFE_INTEGER };
    expect(() => applyExpenseTotals(Number.MAX_SAFE_INTEGER, nearLimit, 'stay', 1, 1)).toThrow('EXPENSE_TOTALS_INVARIANT_FAILED');
  });
  it('does not let a reversed expense make paid or owed negative', () => {
    expect(() => applyBalanceDelta({ participantId: 'p_A', paidMinor: 0, owedMinor: 0,
      sentMinor: 0, receivedMinor: 0, netMinor: 0 },
    { paidMinor: -1, owedMinor: 0, netMinor: -1 })).toThrow('BALANCE_INVARIANT_FAILED');
  });
  it('replacing a contribution matches a fresh ledger and can reverse back with repayment history preserved', () => {
    const previous = { amountMinor: 101, payerParticipantId: 'an', shares: splitEqual(101, ['an', 'binh', 'chi']) };
    const next = { amountMinor: 203, payerParticipantId: 'chi', shares: validateExact(203,
      [{ participantId: 'an', amountMinor: 0 }, { participantId: 'binh', amountMinor: 203 }]) };
    for (const id of ['an', 'binh', 'chi']) {
      const starting = { ...zeroBalance(id), sentMinor: 5, receivedMinor: 2, netMinor: 3 };
      const oldBalance = applyBalanceDelta(starting, expenseDelta(101, 'an', previous.shares, 1).get(id)!);
      const replacement = applyBalanceDelta(oldBalance, expenseChangeDelta(previous, next).get(id)!);
      const fresh = applyBalanceDelta(starting, expenseDelta(203, 'chi', next.shares, 1).get(id)!);
      expect(replacement).toEqual(fresh);
      expect(applyBalanceDelta(replacement, expenseChangeDelta(next, previous).get(id)!)).toEqual(oldBalance);
    }
  });
  it('does not allow a repayment reversal to make transfer totals negative', () => {
    expect(() => applySettlement(zeroBalance('an'), 'from', 1, -1)).toThrow('BALANCE_INVARIANT_FAILED');
    expect(() => applySettlement(zeroBalance('an'), 'to', 1, -1)).toThrow('BALANCE_INVARIANT_FAILED');
  });
});
