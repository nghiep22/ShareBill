import { createHash } from 'node:crypto';
import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { expenseInput, participantInput, tripInput } from '../../schemas.js';
import { settlementInput } from '../settlement.js';
import { createOperationDocument, operationDocumentSchema } from '../operation.js';
import { type Migration, type Plan } from './runner.js';

async function* operations(store: FirebaseFirestore.Firestore, pageSize: number) {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  const query = store.collectionGroup('operations').orderBy(FieldPath.documentId());
  for (;;) {
    const page = await (cursor ? query.startAfter(cursor) : query).limit(pageSize).get();
    for (const doc of page.docs) yield { key: doc.ref.path, ref: doc.ref };
    if (page.size < pageSize) return;
    cursor = page.docs.at(-1);
  }
}

function candidate(path: string, response: Record<string, unknown>, ownerName?: string) {
  if (path === '/api/v1/trips') return tripInput.safeParse({ name: response.name, ownerName });
  if (/\/participants$/.test(path)) return participantInput.safeParse({ displayName: response.displayName });
  if (/\/expenses$/.test(path)) return expenseInput.safeParse({
    title: response.title, amountMinor: response.amountMinor, payerParticipantId: response.payerParticipantId,
    splitMethod: response.splitMethod, split: response.split ?? response.splitInput,
    occurredOn: response.occurredOn, category: response.category, note: response.note,
    receiptIds: response.receiptIds,
  });
  if (/\/settlements$/.test(path)) return settlementInput.safeParse({
    fromParticipantId: response.fromParticipantId, toParticipantId: response.toParticipantId,
    amountMinor: response.amountMinor, occurredOn: response.occurredOn, note: response.note,
    basedOnLedgerVersion: response.basedOnLedgerVersion,
  });
  return null;
}

export const operationsMigration: Migration = {
  id: 'DBM-006-operations', revision: '1', scan: operations,
  async plan(store, ref): Promise<Plan> {
    const snapshot = await ref.get();
    if (!snapshot.exists) return { guards: [{ ref, updateTime: null }], changes: [], issues: [] };
    const guards = [{ ref, updateTime: snapshot.updateTime ?? null }];
    const data = snapshot.data()!;
    if (data.canonicalPath !== undefined) {
      return { guards, changes: [], issues: operationDocumentSchema.safeParse(data).success ? [] :
        [{ code: 'OPERATION_SCHEMA_INVALID', path: ref.path }] };
    }
    const path = data.path;
    const response = data.response;
    const tripMatch = typeof path === 'string' ? /^\/api\/v1\/trips\/([0-9a-f-]+)\/(participants|expenses|settlements)$/.exec(path) : null;
    const tripId = path === '/api/v1/trips' ? response?.id : tripMatch?.[1];
    if (!z.uuid().safeParse(tripId).success || !z.uuid().safeParse(response?.id).success ||
        !response || typeof response !== 'object' || Array.isArray(response) || !tripMatch && path !== '/api/v1/trips') {
      return { guards, changes: [], issues: [], exceptions: [{ code: 'LEGACY_OPERATION_RETAINED', path: ref.path }] };
    }
    let ownerName: string | undefined;
    if (path === '/api/v1/trips') {
      const participantId = response.ownerParticipantId;
      if (typeof participantId === 'string' && z.uuid().safeParse(participantId).success) {
        const owner = await store.doc(`trips/${tripId}/participants/${participantId}`).get();
        guards.push({ ref: owner.ref, updateTime: owner.updateTime ?? null });
        ownerName = owner.get('displayName');
      }
    }
    const parsed = candidate(path, response as Record<string, unknown>, ownerName);
    if (!parsed?.success) return { guards, changes: [], issues: [], exceptions: [{ code: 'LEGACY_OPERATION_RETAINED', path: ref.path }] };
    const body = parsed.data as Record<string, unknown>;
    const originalHash = data.requestHash;
    const oldBodies = [body, { ...body, receiptIds: undefined }];
    const validHash = oldBodies.some(value => createHash('sha256').update(JSON.stringify(value)).digest('hex') === originalHash);
    if (!validHash) return { guards, changes: [], issues: [], exceptions: [{ code: 'LEGACY_OPERATION_RETAINED', path: ref.path }] };
    const type = path === '/api/v1/trips' ? 'trip' : tripMatch![2] === 'expenses' ? 'expense' :
      tripMatch![2] === 'participants' ? 'participant' : 'settlement';
    const document = createOperationDocument({ method: 'POST', canonicalPath: path, body }, {
      actorUid: ref.parent.parent!.id, tripId, resourceType: type as 'trip' | 'participant' | 'expense' | 'settlement',
      resourceId: response.id, httpStatus: 200, responseSnapshot: { data: response, meta: {} },
      committedAt: data.committedAt instanceof Timestamp ? data.committedAt : snapshot.updateTime!,
    });
    return { guards, changes: [{ ref, data: { ...document, path: FieldValue.delete(), response: FieldValue.delete() } }], issues: [] };
  },
};
