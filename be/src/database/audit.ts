import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

const tripSnapshot = z.strictObject({
  id: z.uuid(), name: z.string().min(1).max(100), ownerUid: z.string().min(1),
  status: z.literal('active'), version: z.number().int().min(1).safe(),
});
const tripMetadataSnapshot = z.strictObject({
  id: z.uuid(), name: z.string().min(1).max(100), destination: z.string().max(150).nullable(),
  note: z.string().max(1000).nullable(), startDate: z.iso.date().nullable(), endDate: z.iso.date().nullable(),
  timezone: z.string().min(1), status: z.enum(['active', 'archived']),
  version: z.number().int().min(1).safe(),
});
const participantSnapshot = z.strictObject({
  id: z.uuid(), displayName: z.string().min(1).max(80), linkedUid: z.string().min(1).nullable(),
  status: z.enum(['active', 'inactive']), version: z.number().int().min(1).safe(),
});
const shareSnapshot = z.strictObject({ participantId: z.uuid(), amountMinor: z.number().int().nonnegative().safe() });
const expenseSnapshot = z.strictObject({
  id: z.uuid(), amountMinor: z.number().int().min(1).safe(), payerParticipantId: z.uuid(),
  shares: z.array(shareSnapshot).min(1).max(50),
  sharingScope: z.literal('selected').optional(),
  status: z.enum(['active', 'void']), version: z.number().int().min(1).safe(),
});
const expenseEditSnapshot = expenseSnapshot.extend({
  title: z.string().min(1).max(120), note: z.string().max(1000).nullable(), occurredOn: z.iso.date(),
  category: z.enum(['food', 'transport', 'stay', 'tickets', 'shopping', 'other']),
  splitMethod: z.enum(['equal', 'exact']),
  splitInput: z.union([z.strictObject({ participantIds: z.array(z.uuid()).min(1).max(50) }),
    z.strictObject({ shares: z.array(shareSnapshot).min(1).max(50) })]),
  receiptIds: z.array(z.uuid()).max(3),
});
const settlementSnapshot = z.strictObject({
  id: z.uuid(), fromParticipantId: z.uuid(), toParticipantId: z.uuid(),
  amountMinor: z.number().int().min(1).safe(), basedOnLedgerVersion: z.number().int().nonnegative().safe(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'void']), version: z.number().int().min(1).safe(),
  confirmationMode: z.enum(['recipient', 'owner_on_behalf']).nullable(),
});
const membershipSnapshot = z.strictObject({
  id: z.string().min(1).max(128).regex(/^[^/]+$/), role: z.enum(['owner', 'member']),
  status: z.enum(['active', 'removed']), participantId: z.uuid().nullable(), version: z.int().positive(),
});
const inviteSnapshot = z.strictObject({
  id: z.uuid(), maxUses: z.int().min(1).max(20), usedCount: z.int().nonnegative(),
  expiresAt: z.iso.datetime(), revokedAt: z.iso.datetime().nullable(), version: z.int().positive(),
});
const ownerSnapshot = z.strictObject({ id: z.uuid(), ownerUid: z.string().min(1), version: z.int().positive() });
const tripStateSnapshot = z.strictObject({ id: z.uuid(), status: z.enum(['active', 'archived']),
  archivedAt: z.iso.datetime().nullable(), inviteEpoch: z.int().positive(), version: z.int().positive() });
const receiptSnapshot = z.strictObject({ id: z.uuid(), status: z.enum(['awaiting_upload', 'processing', 'ready', 'attached', 'discarded', 'failed']),
  version: z.int().positive(), attachedExpenseId: z.uuid().nullable(),
  attachedSettlementId: z.uuid().nullable().optional(), attachedParticipantId: z.uuid().nullable().optional() });
const itinerarySnapshot = z.strictObject({
  id: z.uuid(), version: z.int().positive(), status: z.enum(['scheduled', 'removed', 'pending', 'declined']),
});
const reason = z.string().min(1).max(300);

const specs = {
  'trip.sharing_equal': { entityType: 'trip',
    before: z.strictObject({ id: z.uuid(), sharingMode: z.enum(['group-equal', 'per-expense']).nullable(), equalParticipantIds: z.array(z.uuid()).max(50) }),
    after: z.strictObject({ id: z.uuid(), sharingMode: z.literal('group-equal'), equalParticipantIds: z.array(z.uuid()).min(1).max(50) }), reason: z.null() },
  'trip.created': { entityType: 'trip', before: z.null(), after: tripSnapshot, reason: z.null() },
  'trip.updated': { entityType: 'trip', before: tripMetadataSnapshot, after: tripMetadataSnapshot, reason: z.null() },
  'trip.owner_transferred': { entityType: 'trip', before: ownerSnapshot, after: ownerSnapshot, reason },
  'trip.archived': { entityType: 'trip', before: tripStateSnapshot, after: tripStateSnapshot, reason: z.null() },
  'trip.reopened': { entityType: 'trip', before: tripStateSnapshot, after: tripStateSnapshot, reason: z.null() },
  'membership.joined': { entityType: 'membership', before: z.null(), after: membershipSnapshot, reason: z.null() },
  'membership.removed': { entityType: 'membership', before: membershipSnapshot, after: membershipSnapshot, reason },
  'membership.restored': { entityType: 'membership', before: membershipSnapshot, after: membershipSnapshot, reason },
  'invite.created': { entityType: 'invite', before: z.null(), after: inviteSnapshot, reason: z.null() },
  'invite.revoked': { entityType: 'invite', before: inviteSnapshot, after: inviteSnapshot, reason: z.null() },
  'participant.created': { entityType: 'participant', before: z.null(), after: participantSnapshot, reason: z.null() },
  'participant.updated': { entityType: 'participant', before: participantSnapshot, after: participantSnapshot, reason: z.null() },
  'participant.linked': { entityType: 'participant', before: participantSnapshot, after: participantSnapshot,
    reason: z.string().min(1).max(300) },
  'participant.unlinked': { entityType: 'participant', before: participantSnapshot, after: participantSnapshot,
    reason: z.string().min(1).max(300) },
  'expense.created': { entityType: 'expense', before: z.null(), after: expenseSnapshot, reason: z.null() },
  'expense.updated': { entityType: 'expense', before: expenseEditSnapshot, after: expenseEditSnapshot, reason: z.null() },
  'expense.voided': { entityType: 'expense', before: expenseSnapshot, after: expenseSnapshot,
    reason: z.string().min(1).max(300) },
  'settlement.created': { entityType: 'settlement', before: z.null(), after: settlementSnapshot, reason: z.null() },
  'settlement.confirmed': { entityType: 'settlement', before: settlementSnapshot, after: settlementSnapshot,
    reason: z.null() },
  'settlement.cancelled': { entityType: 'settlement', before: settlementSnapshot, after: settlementSnapshot, reason: z.null() },
  'settlement.voided': { entityType: 'settlement', before: settlementSnapshot, after: settlementSnapshot, reason },
  'receipt.created': { entityType: 'receipt', before: z.null(), after: receiptSnapshot, reason: z.null() },
  'receipt.finalized': { entityType: 'receipt', before: receiptSnapshot, after: receiptSnapshot, reason: z.null() },
  'receipt.attached': { entityType: 'receipt', before: receiptSnapshot, after: receiptSnapshot, reason: z.null() },
  'receipt.discarded': { entityType: 'receipt', before: receiptSnapshot, after: receiptSnapshot, reason: z.null() },
  'itinerary.activity_added': { entityType: 'itinerary', before: z.null(), after: itinerarySnapshot.extend({ status: z.literal('scheduled') }), reason: z.null() },
  'itinerary.activity_updated': { entityType: 'itinerary', before: itinerarySnapshot.extend({ status: z.literal('scheduled') }), after: itinerarySnapshot.extend({ status: z.literal('scheduled') }), reason: z.null() },
  'itinerary.activity_removed': { entityType: 'itinerary', before: itinerarySnapshot.extend({ status: z.literal('scheduled') }), after: itinerarySnapshot.extend({ status: z.literal('removed') }), reason: z.null() },
  'itinerary.suggestion_created': { entityType: 'itinerary', before: z.null(), after: itinerarySnapshot.extend({ status: z.literal('pending') }), reason: z.null() },
  'itinerary.suggestion_declined': { entityType: 'itinerary', before: itinerarySnapshot.extend({ status: z.literal('pending') }), after: itinerarySnapshot.extend({ status: z.literal('declined') }), reason: z.null() },
} as const;

const actions = ['trip.created', 'trip.updated', 'trip.sharing_equal', 'participant.created', 'participant.updated',
  'participant.linked', 'participant.unlinked', 'expense.created', 'expense.voided',
  'settlement.created', 'settlement.confirmed', 'trip.owner_transferred', 'membership.joined',
  'membership.removed', 'membership.restored', 'invite.created', 'invite.revoked',
  'expense.updated', 'settlement.cancelled', 'settlement.voided', 'trip.archived', 'trip.reopened',
  'receipt.created', 'receipt.finalized', 'receipt.attached', 'receipt.discarded', 'itinerary.activity_added',
  'itinerary.activity_updated', 'itinerary.activity_removed', 'itinerary.suggestion_created', 'itinerary.suggestion_declined'] as const;
export type AuditAction = (typeof actions)[number];

export const auditEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.uuid(),
  actorUid: z.string().min(1),
  actorDisplayNameSnapshot: z.string().min(1).max(80).nullable(),
  action: z.enum(actions),
  entityType: z.enum(['trip', 'participant', 'expense', 'settlement', 'membership', 'invite', 'receipt', 'itinerary']),
  entityId: z.string().min(1).max(128).regex(/^[^/]+$/),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()),
  reason: z.string().min(1).max(500).nullable(),
  revision: z.number().int().min(1).safe(),
  ledgerVersion: z.number().int().nonnegative().safe(),
  operationKey: z.uuid(),
  createdAt: z.instanceof(Timestamp),
}).superRefine((event, context) => {
  if (event.entityType !== 'membership' && !z.uuid().safeParse(event.entityId).success) {
    context.addIssue({ code: 'custom', message: 'invalid entity ID', path: ['entityId'] });
  }
  const spec = specs[event.action];
  if (event.entityType !== spec.entityType) {
    context.addIssue({ code: 'custom', message: 'action does not match entity', path: ['entityType'] });
  }
  if (!spec.before.safeParse(event.before).success) {
    context.addIssue({ code: 'custom', message: 'invalid before snapshot', path: ['before'] });
  }
  if (!spec.after.safeParse(event.after).success) {
    context.addIssue({ code: 'custom', message: 'invalid after snapshot', path: ['after'] });
  }
  if (!spec.reason.safeParse(event.reason).success) {
    context.addIssue({ code: 'custom', message: 'invalid reason', path: ['reason'] });
  }
  if (event.before && event.before.id !== event.entityId || event.after.id !== event.entityId) {
    context.addIssue({ code: 'custom', message: 'snapshot ID does not match entity', path: ['entityId'] });
  }
  if ((event.action === 'trip.created' || event.action === 'participant.created' || event.action === 'expense.created') &&
      (event.after.status !== 'active' || event.after.version !== 1) ||
      event.action === 'settlement.created' &&
      (event.after.status !== 'pending' || event.after.version !== 1 || event.after.confirmationMode !== null)) {
    context.addIssue({ code: 'custom', message: 'invalid created snapshot', path: ['after'] });
  }
  if (event.action === 'expense.voided' &&
      (event.before?.status !== 'active' || event.after.status !== 'void' ||
        event.after.version !== (event.before.version as number) + 1 ||
        event.before.amountMinor !== event.after.amountMinor ||
        event.before.payerParticipantId !== event.after.payerParticipantId ||
        JSON.stringify(event.before.shares) !== JSON.stringify(event.after.shares))) {
    context.addIssue({ code: 'custom', message: 'invalid expense transition', path: ['after'] });
  }
  if (event.action === 'settlement.confirmed' &&
      (event.before?.status !== 'pending' || event.after.status !== 'confirmed' ||
        event.after.version !== (event.before.version as number) + 1 ||
        event.before.fromParticipantId !== event.after.fromParticipantId ||
        event.before.toParticipantId !== event.after.toParticipantId ||
        event.before.amountMinor !== event.after.amountMinor ||
        event.before.basedOnLedgerVersion !== event.after.basedOnLedgerVersion ||
        event.before.confirmationMode !== null || event.after.confirmationMode === null)) {
    context.addIssue({ code: 'custom', message: 'invalid settlement transition', path: ['after'] });
  }
  if (event.action === 'trip.updated' && event.after.version !== (event.before?.version as number) + 1) {
    context.addIssue({ code: 'custom', message: 'invalid trip update', path: ['after'] });
  }
  if (event.action === 'expense.updated' && (event.before?.status !== 'active' || event.after.status !== 'active' ||
      event.after.version !== (event.before.version as number) + 1)) {
    context.addIssue({ code: 'custom', message: 'invalid expense update', path: ['after'] });
  }
  if (event.action === 'receipt.created' && (event.after.status !== 'awaiting_upload' || event.after.version !== 1 || event.after.attachedExpenseId !== null) ||
      event.action.startsWith('receipt.') && event.action !== 'receipt.created' &&
      (event.after.version !== (event.before?.version as number) + 1 ||
        event.action === 'receipt.finalized' && (event.before?.status !== 'processing' || event.after.status !== 'ready') ||
        event.action === 'receipt.attached' && (event.before?.status !== 'ready' || event.after.status !== 'attached' ||
          [event.after.attachedExpenseId, event.after.attachedSettlementId, event.after.attachedParticipantId].filter(Boolean).length !== 1) ||
        event.action === 'receipt.discarded' && event.after.status !== 'discarded')) {
    context.addIssue({ code: 'custom', message: 'invalid receipt transition', path: ['after'] });
  }
  if ((event.action === 'settlement.cancelled' || event.action === 'settlement.voided') &&
      (event.before?.status !== (event.action === 'settlement.cancelled' ? 'pending' : 'confirmed') ||
        event.after.status !== (event.action === 'settlement.cancelled' ? 'cancelled' : 'void') ||
        event.after.version !== (event.before.version as number) + 1 ||
        event.before.fromParticipantId !== event.after.fromParticipantId || event.before.toParticipantId !== event.after.toParticipantId ||
        event.before.amountMinor !== event.after.amountMinor || event.before.basedOnLedgerVersion !== event.after.basedOnLedgerVersion ||
        event.before.confirmationMode !== event.after.confirmationMode ||
        (event.action === 'settlement.cancelled' ? event.after.confirmationMode !== null : event.after.confirmationMode === null))) {
    context.addIssue({ code: 'custom', message: 'invalid settlement transition', path: ['after'] });
  }
  if ((event.action === 'trip.archived' || event.action === 'trip.reopened') &&
      (event.before?.status !== (event.action === 'trip.archived' ? 'active' : 'archived') ||
        event.after.status !== (event.action === 'trip.archived' ? 'archived' : 'active') ||
        event.after.version !== (event.before.version as number) + 1 ||
        event.after.inviteEpoch !== (event.before.inviteEpoch as number) + (event.action === 'trip.archived' ? 1 : 0) ||
        (event.action === 'trip.archived' ? event.after.archivedAt === null : event.after.archivedAt !== null))) {
    context.addIssue({ code: 'custom', message: 'invalid trip state transition', path: ['after'] });
  }
  if (event.action === 'trip.owner_transferred' &&
      (event.before?.ownerUid === event.after.ownerUid || event.after.version !== (event.before?.version as number) + 1)) {
    context.addIssue({ code: 'custom', message: 'invalid owner transfer', path: ['after'] });
  }
  if (event.action === 'membership.joined' && (event.after.role !== 'member' ||
      event.after.status !== 'active' || event.after.version !== 1)) {
    context.addIssue({ code: 'custom', message: 'invalid joined membership', path: ['after'] });
  }
  if ((event.action === 'membership.removed' || event.action === 'membership.restored') &&
      (event.before?.status !== (event.action === 'membership.removed' ? 'active' : 'removed') ||
        event.after.status !== (event.action === 'membership.removed' ? 'removed' : 'active') ||
        event.before.role !== 'member' || event.after.role !== 'member' ||
        (event.before.participantId !== event.after.participantId && !(event.action === 'membership.restored' && event.before.participantId === null)) ||
        event.after.version !== (event.before.version as number) + 1)) {
    context.addIssue({ code: 'custom', message: 'invalid membership transition', path: ['after'] });
  }
  if (event.action === 'invite.created' &&
      (event.after.usedCount !== 0 || event.after.revokedAt !== null || event.after.version !== 1) ||
      event.action === 'invite.revoked' && (event.before?.revokedAt !== null || event.after.revokedAt === null ||
        event.after.version !== (event.before?.version as number) + 1 ||
        event.before?.usedCount !== event.after.usedCount || event.before?.maxUses !== event.after.maxUses ||
        event.before?.expiresAt !== event.after.expiresAt)) {
    context.addIssue({ code: 'custom', message: 'invalid invite transition', path: ['after'] });
  }
  if ((event.action === 'participant.updated' || event.action === 'participant.linked' ||
      event.action === 'participant.unlinked') &&
      (event.after.version !== (event.before?.version as number) + 1 ||
        event.action === 'participant.linked' && (event.before?.linkedUid !== null || event.after.linkedUid === null) ||
        event.action === 'participant.unlinked' && (event.before?.linkedUid === null || event.after.linkedUid !== null))) {
    context.addIssue({ code: 'custom', message: 'invalid participant update', path: ['after'] });
  }
  if (event.entityType === 'itinerary' && event.before && event.after.version !== (event.before.version as number) + 1) {
    context.addIssue({ code: 'custom', message: 'invalid itinerary update', path: ['after'] });
  }
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

export function auditActorName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 80 &&
    !/@|https?:\/\/|\bBearer\b|\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/i.test(name) ? name : null;
}

function redactAuditText(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '[token]');
}

export function createAuditEvent(input: {
  eventId: string;
  actorUid: string;
  actorDisplayNameSnapshot: unknown;
  action: AuditAction;
  entityType: AuditEvent['entityType'];
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  reason: string | null;
  revision: number;
  ledgerVersion: number;
  operationKey: string;
  createdAt: Timestamp;
}): AuditEvent {
  const after = { ...input.after };
  const before = input.before === null ? null : { ...input.before };
  if (input.action === 'expense.updated') {
    for (const snapshot of [before, after]) if (snapshot) {
      for (const field of ['title', 'note']) if (typeof snapshot[field] === 'string') snapshot[field] = redactAuditText(snapshot[field]);
    }
  }
  if ((input.action === 'trip.created' || input.action === 'trip.updated') && typeof after.name === 'string') after.name = redactAuditText(after.name);
  if ((input.action === 'participant.created' || input.action === 'participant.updated' ||
      input.action === 'participant.linked' || input.action === 'participant.unlinked') && typeof after.displayName === 'string') {
    after.displayName = redactAuditText(after.displayName);
  }
  return auditEventSchema.parse({ ...input, schemaVersion: 1,
    actorDisplayNameSnapshot: auditActorName(input.actorDisplayNameSnapshot),
    before, after, reason: input.reason === null ? null : redactAuditText(input.reason) });
}
