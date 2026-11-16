import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { createExpenseDocument, expenseDocumentSchema, expenseReadData } from '../src/database/expense.js';
import { splitEqual } from '../src/domain/money.js';
import { expenseInput } from '../src/schemas.js';

describe('expense document v1', () => {
  it('stores canonical split input, computed shares, and complete active defaults', () => {
    const payerParticipantId = randomUUID();
    const otherParticipantId = randomUUID();
    const actorUid = 'firebase-owner';
    const now = Timestamp.now();
    const body = expenseInput.parse({ title: 'Khách sạn', amountMinor: 101, payerParticipantId,
      splitMethod: 'equal', split: { participantIds: [otherParticipantId, payerParticipantId] },
      occurredOn: '2026-12-20', category: 'stay', note: null });
    if (body.splitMethod !== 'equal') throw new Error('Unexpected split method');
    const shares = splitEqual(body.amountMinor, body.split.participantIds);
    const document = createExpenseDocument({ id: randomUUID(), body, shares, actorUid, now });
    expect(expenseDocumentSchema.safeParse(document).success).toBe(true);
    expect(document).toMatchObject({ schemaVersion: 1, currency: 'VND', amountMinor: 101,
      splitInput: body.split, shares, receiptIds: [], createdBy: actorUid, updatedBy: actorUid,
      createdAt: now, updatedAt: now, status: 'active', version: 1,
      voidedAt: null, voidedBy: null, voidReason: null });
    expect('split' in document).toBe(false);
    expect(shares.map(share => share.amountMinor).sort((a, b) => a - b)).toEqual([50, 51]);
    expect(expenseDocumentSchema.safeParse({ ...document, shares: [{ ...shares[0], amountMinor: 1 }, shares[1] ] }).success).toBe(false);
    expect(expenseDocumentSchema.safeParse({ ...document, currency: 'USD' }).success).toBe(false);
  });

  it('maps legacy split for reads without changing the stored record', () => {
    const legacy = { id: randomUUID(), split: { participantIds: [randomUUID()] }, shares: [] };
    const result = expenseReadData(legacy);
    expect(result.splitInput).toEqual(legacy.split);
    expect(legacy).not.toHaveProperty('splitInput');
    const canonical = { ...legacy, splitInput: { shares: [] } };
    expect(expenseReadData(canonical)).toBe(canonical);
  });
});
