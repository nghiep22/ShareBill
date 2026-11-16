import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

const tripSnapshot = z.strictObject({
  id: z.uuid(), name: z.string().min(1).max(100), ownerUid: z.string().min(1),
  status: z.literal('active'), version: z.number().int().min(1).safe(),
});
const participantSnapshot = z.strictObject({
  id: z.uuid(), displayName: z.string().min(1).max(80), linkedUid: z.string().min(1).nullable(),
  status: z.literal('active'), version: z.number().int().min(1).safe(),
});
const shareSnapshot = z.strictObject({ participantId: z.uuid(), amountMinor: z.number().int().nonnegative().safe() });
const expenseSnapshot = z.strictObject({
  id: z.uuid(), amountMinor: z.number().int().min(1).safe(), payerParticipantId: z.uuid(),
  shares: z.array(shareSnapshot).min(1).max(50),
  status: z.enum(['active', 'void']), version: z.number().int().min(1).safe(),
});
const settlementSnapshot = z.strictObject({
  id: z.uuid(), fromParticipantId: z.uuid(), toParticipantId: z.uuid(),
  amountMinor: z.number().int().min(1).safe(), basedOnLedgerVersion: z.number().int().nonnegative().safe(),
  status: z.enum(['pending', 'confirmed']), version: z.number().int().min(1).safe(),
  confirmationMode: z.enum(['recipient', 'owner_on_behalf']).nullable(),
});

const specs = {
  'trip.created': { entityType: 'trip', before: z.null(), after: tripSnapshot, reason: z.null() },
  'participant.created': { entityType: 'participant', before: z.null(), after: participantSnapshot, reason: z.null() },
  'expense.created': { entityType: 'expense', before: z.null(), after: expenseSnapshot, reason: z.null() },
  'expense.voided': { entityType: 'expense', before: expenseSnapshot, after: expenseSnapshot,
    reason: z.string().min(1).max(300) },
  'settlement.created': { entityType: 'settlement', before: z.null(), after: settlementSnapshot, reason: z.null() },
  'settlement.confirmed': { entityType: 'settlement', before: settlementSnapshot, after: settlementSnapshot,
    reason: z.null() },
} as const;

const actions = ['trip.created', 'participant.created', 'expense.created', 'expense.voided',
  'settlement.created', 'settlement.confirmed'] as const;
export type AuditAction = (typeof actions)[number];

export const auditEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.uuid(),
  actorUid: z.string().min(1),
  actorDisplayNameSnapshot: z.string().min(1).max(80).nullable(),
  action: z.enum(actions),
  entityType: z.enum(['trip', 'participant', 'expense', 'settlement']),
  entityId: z.uuid(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()),
  reason: z.string().min(1).max(500).nullable(),
  revision: z.number().int().min(1).safe(),
  ledgerVersion: z.number().int().nonnegative().safe(),
  operationKey: z.uuid(),
  createdAt: z.instanceof(Timestamp),
}).superRefine((event, context) => {
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
  entityType: 'trip' | 'participant' | 'expense' | 'settlement';
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
  if (input.action === 'trip.created' && typeof after.name === 'string') after.name = redactAuditText(after.name);
  if (input.action === 'participant.created' && typeof after.displayName === 'string') {
    after.displayName = redactAuditText(after.displayName);
  }
  return auditEventSchema.parse({ ...input, schemaVersion: 1,
    actorDisplayNameSnapshot: auditActorName(input.actorDisplayNameSnapshot),
    after, reason: input.reason === null ? null : redactAuditText(input.reason) });
}
