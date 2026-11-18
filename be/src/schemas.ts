import { z } from 'zod';

const timezoneInput = z.string().trim().min(1).max(80).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
});

export const tripInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  ownerName: z.string().trim().min(1).max(80),
  destination: z.string().trim().min(1).max(150).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  startDate: z.iso.date().nullable().optional(),
  endDate: z.iso.date().nullable().optional(),
  timezone: timezoneInput.optional(),
}).refine(value => Boolean(value.startDate) === Boolean(value.endDate) &&
  (!value.startDate || !value.endDate || value.startDate <= value.endDate));

export const participantInput = z.strictObject({
  displayName: z.string().trim().min(1).max(80),
});

export const tripUpdateInput = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  destination: z.string().trim().min(1).max(150).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  startDate: z.iso.date().nullable().optional(),
  endDate: z.iso.date().nullable().optional(),
  timezone: timezoneInput.optional(),
}).refine(value => Object.keys(value).length > 0);

export const participantUpdateInput = z.strictObject({
  displayName: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).refine(value => Object.keys(value).length > 0);

export const participantLinkInput = z.strictObject({
  participantId: z.uuid().nullable(),
  reason: z.string().trim().min(1).max(300),
});

export const inviteInput = z.strictObject({
  expiresInDays: z.int().min(1).max(7).default(7),
  maxUses: z.int().min(1).max(20).default(20),
});
export const inviteTokenInput = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const membershipActionInput = z.strictObject({ reason: z.string().trim().min(1).max(300) });
export const transferOwnerInput = z.strictObject({
  uid: z.string().min(1).max(128).regex(/^[^/]+$/),
  reason: z.string().trim().min(1).max(300),
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
    receiptIds: z.array(z.uuid()).max(3).refine(ids => new Set(ids).size === ids.length).default([]),
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
    receiptIds: z.array(z.uuid()).max(3).refine(ids => new Set(ids).size === ids.length).default([]),
  }),
]);

export const expenseUpdateInput = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  occurredOn: z.iso.date().optional(),
  category: z.enum(['food', 'transport', 'stay', 'tickets', 'shopping', 'other']).optional(),
  receiptIds: z.array(z.uuid()).max(3).refine(ids => new Set(ids).size === ids.length).optional(),
  amountMinor: money.optional(),
  payerParticipantId: z.uuid().optional(),
  splitMethod: z.enum(['equal', 'exact']).optional(),
  split: z.union([
    z.strictObject({ participantIds: z.array(z.uuid()).min(1).max(50) }),
    z.strictObject({ shares: z.array(z.strictObject({ participantId: z.uuid(),
      amountMinor: z.number().int().nonnegative().safe() })).min(1).max(50) }),
  ]).optional(),
}).superRefine((value, context) => {
  if (!Object.keys(value).length) context.addIssue({ code: 'custom', message: 'empty patch' });
  const block = [value.amountMinor, value.payerParticipantId, value.splitMethod, value.split];
  if (block.some(field => field !== undefined) && block.some(field => field === undefined)) {
    context.addIssue({ code: 'custom', message: 'send the entire financial block', path: ['split'] });
  }
  if (value.split && (value.splitMethod === 'equal') !== ('participantIds' in value.split)) {
    context.addIssue({ code: 'custom', message: 'split does not match splitMethod', path: ['split'] });
  }
});
