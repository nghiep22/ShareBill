export type Share = { participantId: string; amountMinor: number };
export const EXPENSE_CATEGORIES = ['food', 'transport', 'stay', 'tickets', 'shopping', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type Balance = {
  participantId: string;
  paidMinor: number;
  owedMinor: number;
  sentMinor: number;
  receivedMinor: number;
  netMinor: number;
};

export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

export function zeroBalance(participantId: string): Balance {
  return { participantId, paidMinor: 0, owedMinor: 0, sentMinor: 0, receivedMinor: 0, netMinor: 0 };
}

export function applyExpenseTotals(
  totalExpenseMinor: unknown,
  categoryTotalsMinor: unknown,
  category: ExpenseCategory,
  amountMinor: number,
  sign: 1 | -1,
): { totalExpenseMinor: number; categoryTotalsMinor: Record<ExpenseCategory, number> } {
  if (!Number.isSafeInteger(totalExpenseMinor) || (totalExpenseMinor as number) < 0 ||
      !categoryTotalsMinor || typeof categoryTotalsMinor !== 'object' || Array.isArray(categoryTotalsMinor) ||
      !EXPENSE_CATEGORIES.includes(category)) throw new Error('EXPENSE_TOTALS_INVARIANT_FAILED');
  const stored = categoryTotalsMinor as Record<string, unknown>;
  if (Object.keys(stored).length !== EXPENSE_CATEGORIES.length ||
      EXPENSE_CATEGORIES.some(name => !Number.isSafeInteger(stored[name]) || (stored[name] as number) < 0) ||
      EXPENSE_CATEGORIES.reduce((sum, name) => sum + BigInt(stored[name] as number), 0n) !== BigInt(totalExpenseMinor as number)) {
    throw new Error('EXPENSE_TOTALS_INVARIANT_FAILED');
  }
  assertAmount(amountMinor);
  const nextTotal = (totalExpenseMinor as number) + sign * amountMinor;
  const nextCategory = (stored[category] as number) + sign * amountMinor;
  if (!Number.isSafeInteger(nextTotal) || !Number.isSafeInteger(nextCategory) || nextTotal < 0 || nextCategory < 0) {
    throw new Error('EXPENSE_TOTALS_INVARIANT_FAILED');
  }
  return {
    totalExpenseMinor: nextTotal,
    categoryTotalsMinor: Object.fromEntries(EXPENSE_CATEGORIES.map(name =>
      [name, name === category ? nextCategory : stored[name]])) as Record<ExpenseCategory, number>,
  };
}

export function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_MINOR) {
    throw new Error('INVALID_AMOUNT');
  }
}

export function splitEqual(amount: number, participantIds: string[]): Share[] {
  assertAmount(amount);
  return splitGroupTotal(amount, participantIds);
}

/** Aggregate trip totals can exceed the cap of one expense; the remainder is allocated once for the entire group. */
export function splitGroupTotal(amount: number, participantIds: string[]): Share[] {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('INVALID_AMOUNT');
  const ids = [...participantIds].sort();
  if (ids.length === 0 || ids.length > 50 || new Set(ids).size !== ids.length) {
    throw new Error('INVALID_PARTICIPANTS');
  }
  const total = BigInt(amount);
  const count = BigInt(ids.length);
  const base = total / count;
  const remainder = total % count;
  return ids.map((participantId, index) => ({
    participantId,
    amountMinor: Number(base + (BigInt(index) < remainder ? 1n : 0n)),
  }));
}

export function equalGroupBalances(rows: Balance[], total: number, participantIds: string[], paidDeltas = new Map<string, number>()): Balance[] {
  const ids = new Set(rows.map(row => row.participantId));
  if (ids.size !== rows.length || participantIds.some(id => !ids.has(id)) || [...paidDeltas.keys()].some(id => !ids.has(id))) throw new Error('BALANCE_INVARIANT_FAILED');
  const owed = new Map(splitGroupTotal(total, participantIds).map(row => [row.participantId, row.amountMinor]));
  const next = rows.map(row => {
    const paidMinor = row.paidMinor + (paidDeltas.get(row.participantId) ?? 0), owedMinor = owed.get(row.participantId) ?? 0;
    const value = { ...row, paidMinor, owedMinor, netMinor: paidMinor - owedMinor + row.sentMinor - row.receivedMinor };
    return applyBalanceDelta(value, { paidMinor: 0, owedMinor: 0, netMinor: 0 });
  });
  if (next.reduce((sum, row) => sum + BigInt(row.paidMinor), 0n) !== BigInt(total) ||
      next.reduce((sum, row) => sum + BigInt(row.sentMinor) - BigInt(row.receivedMinor), 0n) !== 0n) throw new Error('BALANCE_INVARIANT_FAILED');
  return next;
}

export function validateExact(amount: number, shares: Share[]): Share[] {
  assertAmount(amount);
  if (shares.length === 0 || shares.length > 50 || new Set(shares.map(s => s.participantId)).size !== shares.length) {
    throw new Error('INVALID_SHARES');
  }
  let sum = 0n;
  for (const share of shares) {
    if (!Number.isSafeInteger(share.amountMinor) || share.amountMinor < 0) throw new Error('INVALID_SHARES');
    sum += BigInt(share.amountMinor);
  }
  if (sum !== BigInt(amount)) throw new Error('SPLIT_TOTAL_MISMATCH');
  return [...shares].sort((a, b) => a.participantId.localeCompare(b.participantId, 'en'));
}

export function expenseDelta(amount: number, payerParticipantId: string, shares: Share[], sign: 1 | -1): Map<string, { paidMinor: number; owedMinor: number; netMinor: number }> {
  const deltas = new Map<string, { paidMinor: number; owedMinor: number; netMinor: number }>();
  function get(id: string) {
    let item = deltas.get(id);
    if (!item) { item = { paidMinor: 0, owedMinor: 0, netMinor: 0 }; deltas.set(id, item); }
    return item;
  }
  const payer = get(payerParticipantId);
  payer.paidMinor += sign * amount;
  payer.netMinor += sign * amount;
  for (const share of shares) {
    const item = get(share.participantId);
    item.owedMinor += sign * share.amountMinor;
    item.netMinor -= sign * share.amountMinor;
  }
  if ([...deltas.values()].reduce((n, d) => n + d.netMinor, 0) !== 0) throw new Error('BALANCE_INVARIANT_FAILED');
  return deltas;
}

export function applyBalanceDelta(balance: Balance, delta: { paidMinor: number; owedMinor: number; netMinor: number }): Balance {
  const next = {
    ...balance,
    paidMinor: balance.paidMinor + delta.paidMinor,
    owedMinor: balance.owedMinor + delta.owedMinor,
    netMinor: balance.netMinor + delta.netMinor,
  };
  if (Object.values(next).some(value => typeof value === 'number' && !Number.isSafeInteger(value)) ||
      [next.paidMinor, next.owedMinor, next.sentMinor, next.receivedMinor].some(value => value < 0) ||
      next.netMinor !== next.paidMinor - next.owedMinor + next.sentMinor - next.receivedMinor) {
    throw new Error('BALANCE_INVARIANT_FAILED');
  }
  return next;
}

export type ExpenseContribution = { amountMinor: number; payerParticipantId: string; shares: Share[] };

/** Combine both contributions before applying any balance, including overlapping payer/share IDs. */
export function expenseChangeDelta(previous: ExpenseContribution, next: ExpenseContribution) {
  const deltas = expenseDelta(previous.amountMinor, previous.payerParticipantId, previous.shares, -1);
  for (const [id, value] of expenseDelta(next.amountMinor, next.payerParticipantId, next.shares, 1)) {
    const old = deltas.get(id) ?? { paidMinor: 0, owedMinor: 0, netMinor: 0 };
    deltas.set(id, { paidMinor: old.paidMinor + value.paidMinor,
      owedMinor: old.owedMinor + value.owedMinor, netMinor: old.netMinor + value.netMinor });
  }
  return deltas;
}
