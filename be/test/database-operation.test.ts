import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { expect, it } from 'vitest';
import { createOperationDocument, readOperationResult } from '../src/database/operation.js';

it('canonicalizes nested object keys and binds the command to its method, path, body and version', () => {
  const tripId = randomUUID(), resourceId = randomUUID();
  const actorUid = 'actor';
  const command = { method: 'POST', canonicalPath: `/api/v1/trips/${tripId}/expenses/${resourceId}/void`,
    body: { split: { shares: [{ participantId: 'an', amountMinor: 10 }, { participantId: 'binh', amountMinor: 20 }] } },
    ifMatch: 1 };
  const stored = createOperationDocument(command, { actorUid, tripId, resourceType: 'expense', resourceId,
    httpStatus: 200, responseSnapshot: { data: { id: resourceId, version: 2 }, meta: { revision: 4 } },
    committedAt: Timestamp.now() });
  const reordered = { ...command, body: { split: { shares: [{ amountMinor: 10, participantId: 'an' },
    { amountMinor: 20, participantId: 'binh' }] } } };
  expect(readOperationResult(stored, reordered, actorUid, tripId)).toEqual(stored);
  const conflicts = [
    { ...command, method: 'PATCH' },
    { ...command, canonicalPath: `${command.canonicalPath}-other` },
    { ...command, ifMatch: 2 },
    { ...command, body: { split: { shares: [...command.body.split.shares].reverse() } } },
  ];
  for (const conflict of conflicts) {
    expect(() => readOperationResult(stored, conflict, actorUid, tripId))
      .toThrow(expect.objectContaining({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' }));
  }
});
