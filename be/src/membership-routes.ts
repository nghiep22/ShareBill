import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from './firebase.js';
import { ApiError, operationKey, requireUser, requireVersion, sendOperationResult } from './http.js';
import { membershipActionInput, transferOwnerInput } from './schemas.js';
import { createOperationDocument, readOperationResult, readOperationSnapshot } from './database/operation.js';
import { auditActorName, createAuditEvent } from './database/audit.js';
import { membershipSchema, tripRefSchema, tripSchema, uid as uidSchema } from './database/integrity-schemas.js';
import { requireConsistentIdentity } from './services/memberships.js';
import { increment, readTripActor, requireOwner, requireWritable } from './services/trip-access.js';
import { enrollGroupMember, isGroupEqual, projectGroup, readGroupLedger, writeGroupBalances } from './services/group-sharing.js';

const tripParams = z.strictObject({ tripId: z.uuid() });
const memberParams = z.strictObject({ tripId: z.uuid(), uid: uidSchema });
function parse<T>(schema: z.ZodType<T>, value: unknown, path = false): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(path ? 404 : 422, path ? 'NOT_FOUND' : 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ.');
  return result.data;
}
function memberAudit(member: FirebaseFirestore.DocumentSnapshot) {
  return { id: member.id, role: member.get('role'), status: member.get('status'),
    participantId: member.get('participantId'), version: member.get('version') };
}

export async function registerMembershipRoutes(app: FastifyInstance) {
  app.get('/api/v1/trips/:tripId/members', async request => {
    const uid = await requireUser(request), { tripId } = parse(tripParams, request.params, true);
    const store = db(), tripRef = store.doc(`trips/${tripId}`);
    return store.runTransaction(async tx => {
      const { trip } = await readTripActor(tx, tripRef, uid);
      const [participants, members] = await Promise.all([
        tx.get(tripRef.collection('participants').limit(50)), tx.get(tripRef.collection('memberships').limit(50)),
      ]);
      const profiles = members.empty ? [] : await tx.getAll(...members.docs.map(doc => store.doc(`users/${doc.id}`)));
      const names = new Map(profiles.map(doc => [doc.id, auditActorName(doc.get('displayName'))]));
      return { data: { participants: participants.docs.map(doc => ({ id: doc.id, displayName: doc.get('displayName'),
        status: doc.get('status'), linkedUid: doc.get('linkedUid'), version: doc.get('version') })),
      memberships: members.docs.map(doc => ({ uid: doc.id, displayName: names.get(doc.id) ?? null, role: doc.get('role'), status: doc.get('status'),
        participantId: doc.get('participantId'), version: doc.get('version'),
        joinedAt: doc.get('joinedAt').toDate().toISOString(), removedAt: doc.get('removedAt')?.toDate().toISOString() ?? null })),
      revision: trip.get('revision'), ledgerVersion: trip.get('ledgerVersion') } };
    }, { readOnly: true });
  });

  for (const action of ['remove', 'restore'] as const) {
    app.post(`/api/v1/trips/:tripId/memberships/:uid/${action}`, async (request, reply) => {
      const uid = await requireUser(request), key = operationKey(request);
      const { tripId, uid: targetUid } = parse(memberParams, request.params, true);
      const input = parse(membershipActionInput, request.body), expectedVersion = requireVersion(request.headers['if-match']);
      const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/memberships/${targetUid}/${action}`,
        body: input, ifMatch: expectedVersion };
      const store = db(), tripRef = store.doc(`trips/${tripId}`), targetRef = tripRef.collection('memberships').doc(targetUid);
      const opRef = store.doc(`users/${uid}/operations/${key}`), auditId = randomUUID();
      const result = await store.runTransaction(async tx => {
        const [{ trip, member, user }, op, target, targetProfile] = await Promise.all([
          readTripActor(tx, tripRef, uid), readOperationSnapshot(tx, opRef), tx.get(targetRef), tx.get(store.doc(`users/${targetUid}`)),
        ]);
        const replay = readOperationResult(op.data(), command, uid, tripId);
        if (replay) return { outcome: replay, replayed: true };
        requireOwner(trip, member);
        if (action === 'restore') requireWritable(trip);
        if (!target.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thành viên.');
        if (targetUid === trip.get('ownerUid') || target.get('role') === 'owner') {
          throw new ApiError(422, 'OWNER_MEMBERSHIP_REQUIRED', 'Không thể gỡ hoặc khôi phục chủ chuyến bằng thao tác này.');
        }
        if (target.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Thành viên đã thay đổi.');
        if (target.get('status') !== (action === 'remove' ? 'active' : 'removed')) {
          throw new ApiError(409, 'INVALID_MEMBERSHIP_STATE', 'Thành viên đã ở trạng thái này.');
        }
        if (action === 'restore') {
          if (targetProfile.get('status') !== 'active') throw new ApiError(409, 'TARGET_USER_UNAVAILABLE', 'Tài khoản chưa sẵn sàng.');
          await requireConsistentIdentity(tx, tripRef, targetUid, target.get('participantId'));
        }
        const now = Timestamp.now(), revision = increment(trip.get('revision'));
        let ledgerVersion = trip.get('ledgerVersion');
        const group = isGroupEqual(trip) && trip.get('status') === 'active' ? await readGroupLedger(tx, trip) : undefined;
        const person = group && action === 'restore' && !target.get('participantId') ?
          enrollGroupMember(group, targetUid, auditActorName(targetProfile.get('displayName')) ?? 'Thành viên', uid, now) : undefined;
        const personId = person?.participantId ?? target.get('participantId') as string | null;
        if (group && (!personId || (action === 'remove') !== group.ids.includes(personId))) {
          throw new ApiError(409, 'GROUP_SHARING_INVARIANT_FAILED', 'Thành viên chia tiền chưa đồng nhất.');
        }
        const groupIds = group && personId ? action === 'remove' ? group.ids.filter(id => id !== personId) : [...group.ids, personId].sort() : undefined;
        const rows = group && groupIds ? projectGroup(group, trip.get('totalExpenseMinor'), groupIds) : undefined;
        if (group) ledgerVersion += 1;
        const patch = { status: action === 'remove' ? 'removed' : 'active', version: increment(expectedVersion),
          ...(person && { participantId: person.participantId }),
          removedAt: action === 'remove' ? now : null, updatedAt: now };
        if (!membershipSchema.safeParse({ ...target.data(), ...patch }).success) {
          throw new ApiError(409, 'MEMBERSHIP_INVARIANT_FAILED', 'Dữ liệu thành viên chưa hợp lệ.');
        }
        tx.update(targetRef, patch);
        if (person) {
          tx.create(tripRef.collection('participants').doc(person.participantId), person.participant);
          tx.create(tripRef.collection('participantLinks').doc(targetUid), person.link);
        }
        const restoredPerson = group && action === 'restore' && personId ? group.participants.get(personId) : undefined;
        if (restoredPerson?.status === 'inactive') tx.update(tripRef.collection('participants').doc(restoredPerson.id), {
          status: 'active', version: increment(restoredPerson.version), updatedAt: now,
        });
        if (rows) writeGroupBalances(tx, trip, rows, now);
        tx.set(store.doc(`users/${targetUid}/tripRefs/${tripId}`), tripRefSchema.parse({ schemaVersion: 1,
          tripId, status: patch.status, joinedAt: target.get('joinedAt'), updatedAt: now }));
        tx.update(tripRef, { revision, ledgerVersion, ...(group && { equalParticipantIds: groupIds, participantCount: group.participants.size }), updatedAt: now });
        tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
        const before = memberAudit(target), after = { ...before, status: patch.status, version: patch.version, participantId: personId };
        tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
          eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'),
          action: action === 'remove' ? 'membership.removed' : 'membership.restored', entityType: 'membership',
          entityId: targetUid, before, after, reason: input.reason, revision, ledgerVersion, operationKey: key, createdAt: now,
        }));
        const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'membership', resourceId: targetUid,
          httpStatus: 200, responseSnapshot: { data: { uid: targetUid, role: target.get('role'), status: patch.status,
            participantId: personId, version: patch.version }, meta: { revision, ledgerVersion } }, committedAt: now });
        tx.create(opRef, outcome);
        return { outcome, replayed: false };
      });
      return sendOperationResult(reply, result);
    });
  }

  app.post('/api/v1/trips/:tripId/transfer-owner', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId } = parse(tripParams, request.params, true), input = parse(transferOwnerInput, request.body);
    const expectedVersion = requireVersion(request.headers['if-match']);
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/transfer-owner`,
      body: input, ifMatch: expectedVersion };
    const store = db(), tripRef = store.doc(`trips/${tripId}`), opRef = store.doc(`users/${uid}/operations/${key}`);
    const targetRef = tripRef.collection('memberships').doc(input.uid), auditId = randomUUID();
    const result = await store.runTransaction(async tx => {
      const [{ trip, member, user }, op, target, profile] = await Promise.all([
        readTripActor(tx, tripRef, uid), readOperationSnapshot(tx, opRef), tx.get(targetRef), tx.get(store.doc(`users/${input.uid}`)),
      ]);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      requireOwner(trip, member); requireWritable(trip);
      if (trip.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Chuyến đi đã thay đổi.');
      if (input.uid === uid || !target.exists || target.get('status') !== 'active' || target.get('role') !== 'member' ||
          !z.uuid().safeParse(target.get('participantId')).success || profile.get('status') !== 'active') {
        throw new ApiError(422, 'INVALID_OWNER_TARGET', 'Chủ chuyến mới phải là thành viên đang hoạt động và đã liên kết người tham gia.');
      }
      await requireConsistentIdentity(tx, tripRef, input.uid, target.get('participantId'));
      await requireConsistentIdentity(tx, tripRef, uid, member.get('participantId'));
      const now = Timestamp.now(), revision = increment(trip.get('revision')), ledgerVersion = trip.get('ledgerVersion');
      const patch = { ownerUid: input.uid, version: increment(expectedVersion), revision, updatedAt: now };
      const oldPatch = { role: 'member', version: increment(member.get('version')), updatedAt: now };
      const newPatch = { role: 'owner', version: increment(target.get('version')), updatedAt: now };
      if (!tripSchema.safeParse({ ...trip.data(), ...patch }).success ||
          !membershipSchema.safeParse({ ...member.data(), ...oldPatch }).success ||
          !membershipSchema.safeParse({ ...target.data(), ...newPatch }).success) {
        throw new ApiError(409, 'OWNER_INVARIANT_FAILED', 'Dữ liệu chủ chuyến chưa hợp lệ.');
      }
      tx.update(tripRef, patch);
      tx.update(member.ref, oldPatch); tx.update(targetRef, newPatch);
      tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
      const before = { id: tripId, ownerUid: uid, version: expectedVersion };
      const after = { id: tripId, ownerUid: input.uid, version: patch.version };
      tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
        eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'), action: 'trip.owner_transferred',
        entityType: 'trip', entityId: tripId, before, after, reason: input.reason,
        revision, ledgerVersion, operationKey: key, createdAt: now,
      }));
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'trip', resourceId: tripId,
        httpStatus: 200, responseSnapshot: { data: after, meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });
}
