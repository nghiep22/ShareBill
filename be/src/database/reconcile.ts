import { z } from 'zod';
import { applyBalanceDelta, applyExpenseTotals, equalGroupBalances, expenseDelta, EXPENSE_CATEGORIES, zeroBalance } from '../domain/money.js';
import { applySettlement } from '../domain/settlement.js';
import type { expenseLedgerSchema, settlementLedgerSchema } from './integrity-schemas.js';

export type LedgerExpense = z.infer<typeof expenseLedgerSchema>;
export type LedgerSettlement = z.infer<typeof settlementLedgerSchema>;

export function reconcileLedger(participantIds: Iterable<string>, expenses: LedgerExpense[], settlements: LedgerSettlement[], equalParticipantIds?: string[]) {
  const balances = new Map(Array.from(participantIds, id => [id, zeroBalance(id)]));
  const categoryTotalsMinor = Object.fromEntries(EXPENSE_CATEGORIES.map(category => [category, 0])) as
    Record<(typeof EXPENSE_CATEGORIES)[number], number>;
  let totals = { totalExpenseMinor: 0, categoryTotalsMinor };
  let activeExpenseCount = 0;
  let pendingSettlementCount = 0;

  for (const expense of expenses) {
    if (expense.status !== 'active') continue;
    activeExpenseCount++;
    totals = applyExpenseTotals(totals.totalExpenseMinor, totals.categoryTotalsMinor, expense.category, expense.amountMinor, 1);
    for (const [id, delta] of expenseDelta(expense.amountMinor, expense.payerParticipantId, expense.shares, 1)) {
      balances.set(id, applyBalanceDelta(balances.get(id)!, delta));
    }
    if (expense.sharingScope === 'selected') for (const share of expense.shares) {
      const row = balances.get(share.participantId)!;
      balances.set(share.participantId, { ...row, allocatedOwedMinor: (row.allocatedOwedMinor ?? 0) + share.amountMinor });
    }
  }
  for (const settlement of settlements) {
    if (settlement.status === 'pending') pendingSettlementCount++;
    if (settlement.status !== 'confirmed') continue;
    const { fromParticipantId, toParticipantId, amountMinor } = settlement;
    balances.set(fromParticipantId, applySettlement(balances.get(fromParticipantId)!, 'from', amountMinor, 1));
    balances.set(toParticipantId, applySettlement(balances.get(toParticipantId)!, 'to', amountMinor, 1));
  }
  return {
    balances: equalParticipantIds ? new Map(equalGroupBalances([...balances.values()], totals.totalExpenseMinor, equalParticipantIds).map(row => [row.participantId, row])) : balances, ...totals,
    counts: { expenseCountAllTime: expenses.length, activeExpenseCount, settlementCountAllTime: settlements.length, pendingSettlementCount },
  };
}
