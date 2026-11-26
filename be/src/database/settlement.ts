import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

export const settlementInput = z.strictObject({
  fromParticipantId: z.uuid(),
  toParticipantId: z.uuid(),
  amountMinor: z.number().int().min(1).max(1_000_000_000_000).safe(),
  occurredOn: z.iso.date(),
  note: z.string().trim().max(1000).nullable().default(null),
  basedOnLedgerVersion: z.number().int().nonnegative().safe(),
  receiptIds: z.array(z.uuid()).max(3).refine(ids => new Set(ids).size === ids.length).optional(),
});

export const settlementDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  fromParticipantId: z.uuid(),
  toParticipantId: z.uuid(),
  amountMinor: z.number().int().min(1).max(1_000_000_000_000).safe(),
  currency: z.literal('VND'),
  occurredOn: z.iso.date(),
  note: z.string().max(1000).nullable(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'void']),
  basedOnLedgerVersion: z.number().int().nonnegative().safe(),
  receiptIds: z.array(z.uuid()).max(3).refine(ids => new Set(ids).size === ids.length).default([]),
  version: z.number().int().min(1).safe(),
  createdBy: z.string().min(1),
  createdAt: z.instanceof(Timestamp),
  updatedAt: z.instanceof(Timestamp),
  confirmedBy: z.string().min(1).nullable(),
  confirmedAt: z.instanceof(Timestamp).nullable(),
  confirmationMode: z.enum(['recipient', 'owner_on_behalf']).nullable(),
  cancelledBy: z.string().min(1).nullable(),
  cancelledAt: z.instanceof(Timestamp).nullable(),
  voidedBy: z.string().min(1).nullable(),
  voidedAt: z.instanceof(Timestamp).nullable(),
  voidReason: z.string().min(1).max(300).nullable(),
}).superRefine((value, context) => {
  const hasConfirmation = Boolean(value.confirmedBy && value.confirmedAt && value.confirmationMode);
  const hasCancellation = Boolean(value.cancelledBy && value.cancelledAt);
  const hasVoid = Boolean(value.voidedBy && value.voidedAt && value.voidReason);
  const hasAnyConfirmation = Boolean(value.confirmedBy || value.confirmedAt || value.confirmationMode);
  const hasAnyCancellation = Boolean(value.cancelledBy || value.cancelledAt);
  const hasAnyVoid = Boolean(value.voidedBy || value.voidedAt || value.voidReason);
  const valid = value.fromParticipantId !== value.toParticipantId &&
    value.updatedAt.toMillis() >= value.createdAt.toMillis() &&
    (value.status === 'pending' ? !hasAnyConfirmation && !hasAnyCancellation && !hasAnyVoid :
      value.status === 'confirmed' ? hasConfirmation && !hasAnyCancellation && !hasAnyVoid :
        value.status === 'cancelled' ? hasCancellation && !hasAnyConfirmation && !hasAnyVoid :
          hasConfirmation && hasVoid && !hasAnyCancellation);
  if (!valid) context.addIssue({ code: 'custom', message: 'invalid settlement state', path: ['status'] });
});

export type SettlementDocument = z.infer<typeof settlementDocumentSchema>;

export function createSettlementDocument(input: {
  id: string;
  body: z.infer<typeof settlementInput>;
  actorUid: string;
  now: Timestamp;
}): SettlementDocument {
  const { id, body, actorUid, now } = input;
  return settlementDocumentSchema.parse({
    schemaVersion: 1, id, fromParticipantId: body.fromParticipantId,
    toParticipantId: body.toParticipantId, amountMinor: body.amountMinor, currency: 'VND',
    occurredOn: body.occurredOn, note: body.note, status: 'pending',
    basedOnLedgerVersion: body.basedOnLedgerVersion, version: 1,
    receiptIds: body.receiptIds ?? [],
    createdBy: actorUid, createdAt: now, updatedAt: now,
    confirmedBy: null, confirmedAt: null, confirmationMode: null,
    cancelledBy: null, cancelledAt: null,
    voidedBy: null, voidedAt: null, voidReason: null,
  });
}

export function confirmationChanges(input: {
  actorUid: string;
  mode: 'recipient' | 'owner_on_behalf';
  version: number;
  now: Timestamp;
}) {
  return {
    status: 'confirmed' as const,
    version: input.version + 1,
    confirmedBy: input.actorUid,
    confirmedAt: input.now,
    confirmationMode: input.mode,
    updatedAt: input.now,
  };
}
