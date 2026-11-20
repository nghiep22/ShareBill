import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from './firebase.js';
import { ApiError, operationKey, requireUser, sendOperationResult } from './http.js';
import { auditActorName, createAuditEvent } from './database/audit.js';
import { createOperationDocument, readOperationResult, readOperationSnapshot } from './database/operation.js';
import { increment, readTripActor, requireWritable } from './services/trip-access.js';
import { enrollGroupMember, isGroupEqual, projectGroup, readGroupLedger, readGroupMemberships, writeGroupBalances } from './services/group-sharing.js';

export async function registerGroupSharingRoutes(app: FastifyInstance) {
  app.post('/api/v1/trips/:tripId/share-equally', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const params = z.strictObject({ tripId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy nhóm.');
    if (!z.strictObject({}).safeParse(request.body).success) throw new ApiError(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ.');
    const { tripId } = params.data, store = db(), tripRef = store.doc(`trips/${tripId}`);
    const opRef = store.doc(`users/${uid}/operations/${key}`), auditId = randomUUID();
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/share-equally`, body: {} };
    const result = await store.runTransaction(async tx => {
      const [{ trip, user }, op] = await Promise.all([readTripActor(tx, tripRef, uid), readOperationSnapshot(tx, opRef)]);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      requireWritable(trip);
      const now = Timestamp.now();
      let revision = trip.get('revision') as number, ledgerVersion = trip.get('ledgerVersion') as number;
      if (!isGroupEqual(trip)) {
        const [state, members, links] = await Promise.all([
          readGroupLedger(tx, trip), readGroupMemberships(tx, trip), tx.get(tripRef.collection('participantLinks').limit(51)),
        ]);
        const linkByUid = new Map(links.docs.map(doc => [doc.id, doc]));
        const active = members.filter(member => member.status === 'active');
        const profiles = await tx.getAll(...active.map(member => store.doc(`users/${member.uid}`)));
        const created = [], reactivated = [], ids: string[] = [];
        for (const [index, member] of active.entries()) {
          if (member.participantId) {
            const person = state.participants.get(member.participantId), link = linkByUid.get(member.uid);
            if (!person || person.linkedUid !== member.uid || link?.get('participantId') !== person.id || link.get('uid') !== member.uid) {
              throw new ApiError(409, 'LINK_INVARIANT_FAILED', 'Liên kết thành viên chưa đồng nhất.');
            }
            ids.push(person.id);
            if (person.status !== 'active') {
              state.participants.set(person.id, { ...person, status: 'active' });
              reactivated.push(person);
            }
          } else {
            if (linkByUid.has(member.uid)) throw new ApiError(409, 'LINK_INVARIANT_FAILED', 'Liên kết thành viên chưa đồng nhất.');
            const next = enrollGroupMember(state, member.uid, auditActorName(profiles[index]?.get('displayName')) ?? 'Thành viên', uid, now);
            ids.push(next.participantId);
            created.push({ member, next });
          }
        }
        const rows = projectGroup(state, trip.get('totalExpenseMinor'), ids);
        revision = increment(revision); ledgerVersion += 1;
        if (!Number.isSafeInteger(ledgerVersion)) throw new ApiError(409, 'PROJECTION_INVARIANT_FAILED', 'Phiên bản sổ tiền chưa sẵn sàng.');
        for (const { member, next } of created) {
          tx.create(tripRef.collection('participants').doc(next.participantId), next.participant);
          tx.create(tripRef.collection('participantLinks').doc(member.uid), next.link);
          tx.update(member.ref, { participantId: next.participantId, version: increment(member.version), updatedAt: now });
        }
        for (const person of reactivated) tx.update(tripRef.collection('participants').doc(person.id), { status: 'active', version: increment(person.version), updatedAt: now });
        writeGroupBalances(tx, trip, rows, now);
        tx.update(tripRef, { sharingMode: 'group-equal', equalParticipantIds: ids.sort(), participantCount: state.participants.size,
          version: increment(trip.get('version')), revision, ledgerVersion, updatedAt: now });
        tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
        tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
          eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'), action: 'trip.sharing_equal', entityType: 'trip', entityId: tripId,
          before: { id: tripId, sharingMode: trip.get('sharingMode') ?? null, equalParticipantIds: [] },
          after: { id: tripId, sharingMode: 'group-equal', equalParticipantIds: ids.sort() }, reason: null,
          revision, ledgerVersion, operationKey: key, createdAt: now,
        }));
      }
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'trip', resourceId: tripId,
        httpStatus: 200, responseSnapshot: { data: { id: tripId, sharingMode: 'group-equal' }, meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });
}
