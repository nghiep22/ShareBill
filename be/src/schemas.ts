import { z } from 'zod';

export const tripInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  ownerName: z.string().trim().min(1).max(80),
});

export const participantInput = z.strictObject({
  displayName: z.string().trim().min(1).max(80),
});

const money = z.number().int().min(1).max(1_000_000_000_000);
const id = z.string().min(1).max(128);

export const expenseInput = z.discriminatedUnion('splitMethod', [
  z.strictObject({
    title: z.string().trim().min(1).max(120),
    amountMinor: money,
    payerParticipantId: id,
    splitMethod: z.literal('equal'),
    split: z.strictObject({ participantIds: z.array(id).min(1).max(50) }),
    occurredOn: z.iso.date(),
    category: z.enum(['food', 'transport', 'stay', 'tickets', 'shopping', 'other']),
    note: z.string().trim().max(1000).nullable().default(null),
    receiptIds: z.array(z.uuid()).max(3).default([]),
  }),
  z.strictObject({
    title: z.string().trim().min(1).max(120),
    amountMinor: money,
    payerParticipantId: id,
    splitMethod: z.literal('exact'),
    split: z.strictObject({ shares: z.array(z.strictObject({ participantId: id, amountMinor: z.number().int().min(0) })).min(1).max(50) }),
    occurredOn: z.iso.date(),
    category: z.enum(['food', 'transport', 'stay', 'tickets', 'shopping', 'other']),
    note: z.string().trim().max(1000).nullable().default(null),
    receiptIds: z.array(z.uuid()).max(3).default([]),
  }),
]);
