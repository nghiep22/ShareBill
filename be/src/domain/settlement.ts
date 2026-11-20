import { assertAmount, type Balance } from './money.js';

export type Suggestion = { fromParticipantId: string; toParticipantId: string; amountMinor: number };

export function suggestSettlements(balances: Balance[]): Suggestion[] {
  const total = balances.reduce((sum, balance) => sum + BigInt(balance.netMinor), 0n);
  if (total !== 0n) throw new Error('BALANCE_INVARIANT_FAILED');
  const debtors = balances.filter(b => b.netMinor < 0)
    .map(b => ({ id: b.participantId, left: -b.netMinor }))
    .sort((a, b) => b.left - a.left || a.id.localeCompare(b.id, 'en'));
  const creditors = balances.filter(b => b.netMinor > 0)
    .map(b => ({ id: b.participantId, left: b.netMinor }))
    .sort((a, b) => b.left - a.left || a.id.localeCompare(b.id, 'en'));
  const result: Suggestion[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i]!, creditor = creditors[j]!;
    const amountMinor = Math.min(debtor.left, creditor.left);
    result.push({ fromParticipantId: debtor.id, toParticipantId: creditor.id, amountMinor });
    debtor.left -= amountMinor;
    creditor.left -= amountMinor;
    if (debtor.left === 0) i++;
    if (creditor.left === 0) j++;
  }
  return result;
}

export function applySettlement(balance: Balance, role: 'from' | 'to', amountMinor: number, sign: 1 | -1): Balance {
  assertAmount(amountMinor);
  const next = role === 'from'
    ? { ...balance, sentMinor: balance.sentMinor + sign * amountMinor, netMinor: balance.netMinor + sign * amountMinor }
    : { ...balance, receivedMinor: balance.receivedMinor + sign * amountMinor, netMinor: balance.netMinor - sign * amountMinor };
  if (!Number.isSafeInteger(next.netMinor) || !Number.isSafeInteger(next.sentMinor) || !Number.isSafeInteger(next.receivedMinor) ||
      next.sentMinor < 0 || next.receivedMinor < 0 ||
      next.netMinor !== next.paidMinor - next.owedMinor + next.sentMinor - next.receivedMinor) {
    throw new Error('BALANCE_INVARIANT_FAILED');
  }
  return next;
}
