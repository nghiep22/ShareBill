import type { z } from 'zod';
import { ApiError } from '../http.js';
import type { expenseUpdateInput } from '../schemas.js';
import { splitEqual, validateExact } from '../domain/money.js';
import type { ExpenseDocument } from '../database/expense.js';

export function planExpenseEdit(previous: ExpenseDocument, input: z.infer<typeof expenseUpdateInput>) {
  const { split, ...fields } = input;
  let shares = previous.shares;
  if (split && input.amountMinor !== undefined) {
    try {
      shares = 'participantIds' in split ? splitEqual(input.amountMinor, split.participantIds) :
        validateExact(input.amountMinor, split.shares);
    } catch (error) {
      throw new ApiError(422, error instanceof Error ? error.message : 'INVALID_SPLIT', 'Cách chia tiền chưa hợp lệ.');
    }
  }
  const patch = { ...fields, ...(split ? { splitInput: split, shares } : {}) };
  const next = { ...previous, ...patch };
  const financialChanged = previous.amountMinor !== next.amountMinor || previous.payerParticipantId !== next.payerParticipantId ||
    previous.shares.length !== next.shares.length || previous.shares.some((share, i) =>
      share.participantId !== next.shares[i]?.participantId || share.amountMinor !== next.shares[i]?.amountMinor);
  return { patch, next, financialChanged, hasFinancialBlock: split !== undefined };
}

export function expenseEditAudit(data: ExpenseDocument) {
  return { id: data.id, title: data.title, note: data.note, occurredOn: data.occurredOn, category: data.category,
    amountMinor: data.amountMinor, payerParticipantId: data.payerParticipantId, shares: data.shares,
    splitMethod: data.splitMethod, splitInput: data.splitInput, receiptIds: data.receiptIds, status: data.status, version: data.version };
}
