import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { auditEventSchema, createAuditEvent } from '../src/database/audit.js';

describe('audit event v1', () => {
  it('accepts only action-specific snapshots and removes email-like actor names', () => {
    const tripId = randomUUID();
    const base = { eventId: randomUUID(), actorUid: 'owner-uid',
      actorDisplayNameSnapshot: 'owner@example.test', action: 'trip.created' as const,
      entityType: 'trip' as const, entityId: tripId, before: null,
      after: { id: tripId, name: 'Đà Lạt', ownerUid: 'owner-uid', status: 'active', version: 1 },
      reason: null, revision: 1, ledgerVersion: 0, operationKey: randomUUID(), createdAt: Timestamp.now() };
    const event = createAuditEvent(base);
    expect(auditEventSchema.safeParse(event).success).toBe(true);
    expect(event.actorDisplayNameSnapshot).toBeNull();
    expect(createAuditEvent({ ...base, actorDisplayNameSnapshot: 'Bearer abc.def.ghi' }).actorDisplayNameSnapshot).toBeNull();
    expect(JSON.stringify(event)).not.toContain('owner@example.test');
    expect(() => createAuditEvent({ ...base, after: { ...base.after, token: 'secret' } })).toThrow();
    expect(() => createAuditEvent({ ...base, entityType: 'expense' })).toThrow();
    const privateName = createAuditEvent({ ...base, after: { ...base.after,
      name: 'Đi cùng owner@example.test https://example.test/receipt?token=secret' } });
    expect(JSON.stringify(privateName)).not.toContain('owner@example.test');
    expect(JSON.stringify(privateName)).not.toContain('https://example.test');
  });

  it('requires before and after snapshots that preserve financial amounts', () => {
    const expenseId = randomUUID(), participantId = randomUUID();
    const before = { id: expenseId, amountMinor: 101, payerParticipantId: participantId,
      shares: [{ participantId, amountMinor: 101 }], status: 'active', version: 1 };
    const base = { eventId: randomUUID(), actorUid: 'owner-uid',
      actorDisplayNameSnapshot: 'An', action: 'expense.voided' as const,
      entityType: 'expense' as const, entityId: expenseId, before,
      after: { ...before, status: 'void', version: 2 }, reason: 'Nhập nhầm',
      revision: 3, ledgerVersion: 2, operationKey: randomUUID(), createdAt: Timestamp.now() };
    expect(auditEventSchema.safeParse(createAuditEvent(base)).success).toBe(true);
    expect(() => createAuditEvent({ ...base, after: { ...base.after, amountMinor: 100 } })).toThrow();
    expect(() => createAuditEvent({ ...base, before: null })).toThrow();
    const redacted = createAuditEvent({ ...base,
      reason: 'Sai do owner@example.test, xem https://example.test/receipt?token=secret Bearer abc.def.ghi' });
    expect(redacted.reason).not.toContain('owner@example.test');
    expect(redacted.reason).not.toContain('https://');
    expect(redacted.reason).not.toContain('abc.def.ghi');
  });
});
