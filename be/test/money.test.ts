import { describe, expect, it } from 'vitest';
import { splitEqual, validateExact, expenseDelta, applyBalanceDelta } from '../src/domain/money.js';

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
});
