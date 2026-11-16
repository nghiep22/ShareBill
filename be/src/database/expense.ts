import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { splitEqual, validateExact, type Share } from '../domain/money.js';
import { expenseInput } from '../schemas.js';

const shareSchema = z.strictObject({ participantId: z.uuid(), amountMinor: z.number().int().nonnegative().safe() });
const splitInputSchema = z.union([
  z.strictObject({ participantIds: z.array(z.uuid()).min(1).max(50) }),
  z.strictObject({ shares: z.array(shareSchema).min(1).max(50) }),
]);

export const expenseDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  title: z.string().min(1).max(120),
  note: z.string().max(1000).nullable(),
  amountMinor: z.number().int().min(1).max(1_000_000_000_000).safe(),
  currency: z.literal('VND'),
  payerParticipantId: z.uuid(),
  splitMethod: z.enum(['equal', 'exact']),
  splitInput: splitInputSchema,
  shares: z.array(shareSchema).min(1).max(50),
  occurredOn: z.iso.date(),
  category: z.enum(['food', 'transport', 'stay', 'tickets', 'shopping', 'other']),
  receiptIds: z.array(z.uuid()).max(3),
  status: z.enum(['active', 'void']),
  version: z.number().int().min(1),
  createdBy: z.string().min(1),
  updatedBy: z.string().min(1),
  createdAt: z.instanceof(Timestamp),
  updatedAt: z.instanceof(Timestamp),
  voidedAt: z.instanceof(Timestamp).nullable(),
  voidedBy: z.string().min(1).nullable(),
  voidReason: z.string().min(1).max(300).nullable(),
}).superRefine((value, context) => {
  if ((value.splitMethod === 'equal') !== ('participantIds' in value.splitInput)) {
    context.addIssue({ code: 'custom', message: 'splitInput does not match splitMethod', path: ['splitInput'] });
  }
  try {
    const expected = value.splitMethod === 'equal' && 'participantIds' in value.splitInput
      ? splitEqual(value.amountMinor, value.splitInput.participantIds)
      : value.splitMethod === 'exact' && 'shares' in value.splitInput
        ? validateExact(value.amountMinor, value.splitInput.shares)
        : null;
    if (!expected || expected.length !== value.shares.length ||
        expected.some((share, index) => share.participantId !== value.shares[index]?.participantId ||
          share.amountMinor !== value.shares[index]?.amountMinor)) {
      context.addIssue({ code: 'custom', message: 'shares do not match splitInput', path: ['shares'] });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid splitInput', path: ['splitInput'] });
  }
  if (new Set(value.receiptIds).size !== value.receiptIds.length) {
    context.addIssue({ code: 'custom', message: 'duplicate receipt ID', path: ['receiptIds'] });
  }
  if (value.status === 'active' && (value.voidedAt || value.voidedBy || value.voidReason)) {
    context.addIssue({ code: 'custom', message: 'active expense has void metadata', path: ['status'] });
  }
  if (value.status === 'void' && (!value.voidedAt || !value.voidedBy || !value.voidReason)) {
    context.addIssue({ code: 'custom', message: 'void expense lacks void metadata', path: ['status'] });
  }
});

export type ExpenseDocument = z.infer<typeof expenseDocumentSchema>;

export function createExpenseDocument(input: {
  id: string;
  body: z.infer<typeof expenseInput>;
  shares: Share[];
  actorUid: string;
  now: Timestamp;
}): ExpenseDocument {
  const { id, body, shares, actorUid, now } = input;
  return expenseDocumentSchema.parse({
    schemaVersion: 1, id, title: body.title, note: body.note, amountMinor: body.amountMinor,
    currency: 'VND', payerParticipantId: body.payerParticipantId, splitMethod: body.splitMethod,
    splitInput: body.split, shares, occurredOn: body.occurredOn, category: body.category,
    receiptIds: body.receiptIds, status: 'active', version: 1,
    createdBy: actorUid, updatedBy: actorUid, createdAt: now, updatedAt: now,
    voidedAt: null, voidedBy: null, voidReason: null,
  });
}

/** Expose the canonical edit input for legacy records that only stored `split`. */
export function expenseReadData(data: Record<string, unknown>): Record<string, unknown> {
  if (data.splitInput !== undefined || data.split === undefined) return data;
  return { ...data, splitInput: data.split };
}
