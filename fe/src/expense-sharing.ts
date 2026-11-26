import { sharingMembers, splitEqually, type Demo, type Expense, type Transfer } from './model';

/** Legacy whole-group expenses keep their existing dynamic group allocation. */
export function expenseShares(data: Demo, expense: Expense): Record<string, number> | undefined {
  const shares = data.remote?.sharingMode === 'group-equal' && expense.sharingScope !== 'selected'
    ? splitEqually(expense.amount, sharingMembers(data).map(person => person.id)) : expense.shares;
  const entries = Object.entries(shares);
  if (!Number.isSafeInteger(expense.amount) || expense.amount < 1 || !entries.length || entries.length > 50 ||
      entries.some(([id, amount]) => !data.members.some(person => person.id === id) || !Number.isSafeInteger(amount) || amount < 0) ||
      entries.reduce((sum, [, amount]) => sum + BigInt(amount), BigInt(0)) !== BigInt(expense.amount)) return;
  return shares;
}

export function expenseRepayments(data: Demo, expense: Expense): Transfer[] | undefined {
  const shares = expenseShares(data, expense);
  if (!shares || !data.members.some(person => person.id === expense.payer)) return;
  return Object.entries(shares).filter(([id, amount]) => id !== expense.payer && amount > 0)
    .map(([from, amount]) => ({ from, to: expense.payer, amount }));
}
