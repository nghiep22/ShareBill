import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { settlementInput, settlementDocumentSchema, createSettlementDocument, confirmationChanges } from '../src/database/settlement.js';

describe('settlement document v1', () => {
  it('starts pending with explicit nullable fields and retains the creation ledger version', () => {
    const fromParticipantId = randomUUID(), toParticipantId = randomUUID();
    const body = settlementInput.parse({ fromParticipantId, toParticipantId, amountMinor: 100,
      occurredOn: '2026-12-20', basedOnLedgerVersion: 3 });
    const now = Timestamp.now();
    const document = createSettlementDocument({ id: randomUUID(), body, actorUid: 'owner-uid', now });
    expect(settlementDocumentSchema.safeParse(document).success).toBe(true);
    expect(document).toMatchObject({ schemaVersion: 1, currency: 'VND', note: null,
      status: 'pending', basedOnLedgerVersion: 3, version: 1, createdAt: now, updatedAt: now,
      confirmedBy: null, confirmedAt: null, confirmationMode: null,
      cancelledBy: null, cancelledAt: null, voidedBy: null, voidedAt: null, voidReason: null });
    const later = Timestamp.fromMillis(now.toMillis() + 1_000);
    const changes = confirmationChanges({ actorUid: 'owner-uid', mode: 'owner_on_behalf', version: 1, now: later });
    expect(changes).not.toHaveProperty('basedOnLedgerVersion');
    const confirmed = { ...document, ...changes };
    expect(settlementDocumentSchema.safeParse(confirmed).success).toBe(true);
    expect(confirmed).toMatchObject({ status: 'confirmed', version: 2, basedOnLedgerVersion: 3,
      confirmedBy: 'owner-uid', confirmedAt: later, confirmationMode: 'owner_on_behalf' });
    const recipientConfirmation = confirmationChanges({ actorUid: 'recipient-uid', mode: 'recipient', version: 1, now: later });
    expect(settlementDocumentSchema.safeParse({ ...document, ...recipientConfirmation }).success).toBe(true);
    expect(settlementDocumentSchema.safeParse({ ...document, confirmationMode: 'recipient' }).success).toBe(false);
    expect(settlementDocumentSchema.safeParse({ ...document, fromParticipantId: toParticipantId }).success).toBe(false);
  });
});
