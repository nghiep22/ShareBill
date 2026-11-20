import { describe, expect, it } from 'vitest';
import { equalGroupBalances, splitGroupTotal, zeroBalance } from '../src/domain/money.js';

describe('equal trip total sharing', () => {
  it('allocates the remainder once across the group, including zero and aggregate totals above one expense cap', () => {
    expect(splitGroupTotal(4, ['c', 'a', 'b']).map(row => row.amountMinor)).toEqual([2, 1, 1]);
    expect(splitGroupTotal(0, ['a', 'b']).map(row => row.amountMinor)).toEqual([0, 0]);
    expect(splitGroupTotal(2_000_000_000_001, ['b', 'a']).map(row => row.amountMinor)).toEqual([1_000_000_000_001, 1_000_000_000_000]);
  });
  it('retains advances and confirmed transfers when a third member joins', () => {
    const rows = [{ ...zeroBalance('a'), paidMinor: 300, owedMinor: 150, receivedMinor: 50, netMinor: 100 },
      { ...zeroBalance('b'), owedMinor: 150, sentMinor: 50, netMinor: -100 }, zeroBalance('c')];
    const next = equalGroupBalances(rows, 300, ['a', 'b', 'c']);
    expect(next.map(row => row.owedMinor)).toEqual([100, 100, 100]);
    expect(next.map(row => row.netMinor)).toEqual([150, -50, -100]);
    expect(next[0]!.receivedMinor).toBe(50);
    expect(next[1]!.sentMinor).toBe(50);
  });
  it('only charges active account participants, keeping historical outsiders advances intact', () => {
    const rows = [{ ...zeroBalance('old'), paidMinor: 2100000, owedMinor: 2100000 }, zeroBalance('aaa'), zeroBalance('owner'), zeroBalance('duplicate')];
    const next = equalGroupBalances(rows, 2100000, ['aaa', 'owner']);
    expect(next.map(row => [row.participantId, row.owedMinor, row.netMinor])).toEqual([
      ['old', 0, 2100000], ['aaa', 1050000, -1050000], ['owner', 1050000, -1050000], ['duplicate', 0, 0],
    ]);
  });
  it.each([{ ids: [] }, { ids: ['a', 'a'] }, { ids: ['missing'] }])('rejects an invalid membership set $ids', ({ ids }) => {
    expect(() => equalGroupBalances([{ ...zeroBalance('a'), paidMinor: 10 }], 10, ids)).toThrow();
  });
  it('rejects inconsistent totals and negative advances', () => {
    expect(() => equalGroupBalances([zeroBalance('a')], 10, ['a'])).toThrow();
    expect(() => equalGroupBalances([zeroBalance('a')], 0, ['a'], new Map([['a', -1]]))).toThrow();
  });
});
