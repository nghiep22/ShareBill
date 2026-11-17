import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from './firebase.js';
import { ApiError, operationKey, requireTripAccess, requireUser, requireVersion, sendOperationResult } from './http.js';
import { tripUpdateInput, participantUpdateInput, participantLinkInput } from './schemas.js';
import { tripSchema, participantSchema, membershipSchema } from './database/integrity-schemas.js';
import { createAuditEvent } from './database/audit.js';
import { createOperationDocument, readOperationResult } from './database/operation.js';
import { planParticipantLink } from './services/participant-link.js';

const tripParams = z.strictObject({ tripId: z.uuid() });
const participantParams = z.strictObject({ tripId: z.uuid(), id: z.uuid() });
const membershipParams = z.strictObject({ tripId: z.uuid(), uid: z.string().min(1).max(128).regex(/^[^/]+$/) });
function params<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy dữ liệu.');
  return result.data;
}
function body<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ.');
  return result.data;
}
function writable(trip: FirebaseFirestore.DocumentSnapshot) {
  if (trip.get('status') !== 'active' || trip.get('moderationStatus') !== 'normal') {
    throw new ApiError(409, 'TRIP_NOT_WRITABLE', 'Chuyến đi đang khóa thao tác.');
  }
}
function owner(member: FirebaseFirestore.DocumentSnapshot) {
  if (member.get('role') !== 'owner') throw new ApiError(403, 'FORBIDDEN', 'Chỉ chủ chuyến được thực hiện.');
}
function participantAudit(snapshot: FirebaseFirestore.DocumentSnapshot) {
  return { id: snapshot.id, displayName: snapshot.get('displayName'),
    linkedUid: snapshot.get('linkedUid'), status: snapshot.get('status'), version: snapshot.get('version') };
}
function metadata(snapshot: FirebaseFirestore.DocumentSnapshot) {
  return { id: snapshot.id, name: snapshot.get('name'), destination: snapshot.get('destination'),
    note: snapshot.get('note'), startDate: snapshot.get('startDate'), endDate: snapshot.get('endDate'),
    timezone: snapshot.get('timezone'), status: snapshot.get('status'), version: snapshot.get('version') };
}
function nextRevision(trip: FirebaseFirestore.DocumentSnapshot): number {
  const revision = trip.get('revision');
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new ApiError(409, 'TRIP_INVARIANT_FAILED', 'Phiên bản chuyến không hợp lệ.');
  }
  return revision + 1;
}

export async function registerManagementRoutes(app: FastifyInstance) {
  app.patch('/api/v1/trips/:tripId', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId } = params(tripParams, request.params);
    const input = body(tripUpdateInput, request.body), expectedVersion = requireVersion(request.headers['if-match']);
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}`, body: input, ifMatch: expectedVersion };
    const store = db(), tripRef = store.doc(`trips/${tripId}`), opRef = store.doc(`users/${uid}/operations/${key}`);
    const auditId = randomUUID();
    const result = await store.runTransaction(async tx => {
      const [op, trip, member, user] = await Promise.all([
        tx.get(opRef), tx.get(tripRef), tx.get(tripRef.collection('memberships').doc(uid)), tx.get(store.doc(`users/${uid}`)),
      ]);
      requireTripAccess(member, trip);
      if (user.get('status') !== 'active') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      owner(member); writable(trip);
      if (trip.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Chuyến đi đã thay đổi.');
      const start = input.startDate === undefined ? trip.get('startDate') : input.startDate;
      const end = input.endDate === undefined ? trip.get('endDate') : input.endDate;
      if (start && end && start > end) throw new ApiError(422, 'INVALID_DATE_RANGE', 'Ngày kết thúc phải sau ngày bắt đầu.');
      const now = Timestamp.now(), revision = nextRevision(trip), ledgerVersion = trip.get('ledgerVersion');
      const patch = { ...input, version: expectedVersion + 1, revision, updatedAt: now };
      if (!tripSchema.safeParse({ ...trip.data(), ...patch }).success) {
        throw new ApiError(409, 'TRIP_INVARIANT_FAILED', 'Dữ liệu chuyến chưa hợp lệ.');
      }
      const response = { ...metadata(trip), ...input, version: expectedVersion + 1 };
      tx.update(tripRef, patch);
      tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
      tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
        eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'),
        action: 'trip.updated', entityType: 'trip', entityId: tripId,
        before: metadata(trip), after: response, reason: null, revision, ledgerVersion,
        operationKey: key, createdAt: now,
      }));
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'trip', resourceId: tripId,
        httpStatus: 200, responseSnapshot: { data: response, meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });

  app.patch('/api/v1/trips/:tripId/participants/:id', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId, id } = params(participantParams, request.params);
    const input = body(participantUpdateInput, request.body), expectedVersion = requireVersion(request.headers['if-match']);
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/participants/${id}`,
      body: input, ifMatch: expectedVersion };
    const store = db(), tripRef = store.doc(`trips/${tripId}`), participantRef = tripRef.collection('participants').doc(id);
    const opRef = store.doc(`users/${uid}/operations/${key}`), auditId = randomUUID();
    const result = await store.runTransaction(async tx => {
      const [op, trip, member, user, participant] = await Promise.all([
        tx.get(opRef), tx.get(tripRef), tx.get(tripRef.collection('memberships').doc(uid)),
        tx.get(store.doc(`users/${uid}`)), tx.get(participantRef),
      ]);
      requireTripAccess(member, trip);
      if (user.get('status') !== 'active') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      owner(member); writable(trip);
      if (!participant.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy người tham gia.');
      if (participant.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Người tham gia đã thay đổi.');
      const now = Timestamp.now(), revision = nextRevision(trip), ledgerVersion = trip.get('ledgerVersion');
      const patch = { ...input, version: expectedVersion + 1, updatedAt: now };
      if (!participantSchema.safeParse({ ...participant.data(), ...patch }).success) {
        throw new ApiError(409, 'PARTICIPANT_INVARIANT_FAILED', 'Dữ liệu người tham gia chưa hợp lệ.');
      }
      const before = participantAudit(participant), response = { ...before, ...input, version: expectedVersion + 1 };
      tx.update(participantRef, patch);
      tx.update(tripRef, { revision, updatedAt: now });
      tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
      tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
        eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'),
        action: 'participant.updated', entityType: 'participant', entityId: id,
        before, after: response, reason: null, revision, ledgerVersion, operationKey: key, createdAt: now,
      }));
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'participant', resourceId: id,
        httpStatus: 200, responseSnapshot: { data: response, meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });

  app.post('/api/v1/trips/:tripId/memberships/:uid/link', async (request, reply) => {
    const actorUid = await requireUser(request), key = operationKey(request);
    const { tripId, uid: targetUid } = params(membershipParams, request.params);
    const input = body(participantLinkInput, request.body), expectedVersion = requireVersion(request.headers['if-match']);
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/memberships/${targetUid}/link`,
      body: input, ifMatch: expectedVersion };
    const store = db(), tripRef = store.doc(`trips/${tripId}`), opRef = store.doc(`users/${actorUid}/operations/${key}`);
    const targetMemberRef = tripRef.collection('memberships').doc(targetUid);
    const result = await store.runTransaction(async tx => {
      const [op, trip, actor, targetMember, user, targetProfile] = await Promise.all([
        tx.get(opRef), tx.get(tripRef), tx.get(tripRef.collection('memberships').doc(actorUid)),
        tx.get(targetMemberRef), tx.get(store.doc(`users/${actorUid}`)), tx.get(store.doc(`users/${targetUid}`)),
      ]);
      requireTripAccess(actor, trip);
      if (user.get('status') !== 'active') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
      const replay = readOperationResult(op.data(), command, actorUid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      owner(actor); writable(trip);
      if (!targetMember.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thành viên.');
      if (targetMember.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Liên kết đã thay đổi.');
      if (targetUid === trip.get('ownerUid')) throw new ApiError(422, 'OWNER_LINK_REQUIRED', 'Không thể đổi liên kết chủ chuyến.');
      if (input.participantId && targetMember.get('status') !== 'active') {
        throw new ApiError(409, 'MEMBERSHIP_REMOVED', 'Thành viên đã bị gỡ quyền.');
      }
      if (input.participantId && (!targetProfile.exists || targetProfile.get('status') !== 'active')) {
        throw new ApiError(409, 'TARGET_USER_UNAVAILABLE', 'Tài khoản nhận liên kết chưa sẵn sàng.');
      }
      const now = Timestamp.now(), revision = nextRevision(trip), ledgerVersion = trip.get('ledgerVersion');
      const plan = await planParticipantLink({ tx, tripRef, member: targetMember, targetUid,
        participantId: input.participantId, now });
      if (!membershipSchema.safeParse({ ...targetMember.data(), ...plan.memberChanges }).success ||
          plan.previous && !participantSchema.safeParse({ ...plan.previous.data(), ...plan.previousChanges }).success ||
          plan.target && !participantSchema.safeParse({ ...plan.target.data(), ...plan.targetChanges }).success) {
        throw new ApiError(409, 'LINK_INVARIANT_FAILED', 'Liên kết chưa hợp lệ.');
      }
      const oldId = targetMember.get('participantId') as string | null;
      const auditIds = { old: randomUUID(), target: randomUUID() };
      if (plan.previous && plan.previousChanges) {
        tx.update(plan.previous.ref, plan.previousChanges);
        const before = participantAudit(plan.previous);
        tx.create(tripRef.collection('auditEvents').doc(auditIds.old), createAuditEvent({
          eventId: auditIds.old, actorUid, actorDisplayNameSnapshot: user.get('displayName'),
          action: 'participant.unlinked', entityType: 'participant', entityId: oldId!,
          before, after: { ...before, linkedUid: null, version: before.version + 1 },
          reason: input.reason, revision, ledgerVersion, operationKey: key, createdAt: now,
        }));
      }
      if (plan.target && plan.targetChanges && input.participantId) {
        tx.update(plan.target.ref, plan.targetChanges);
        const before = participantAudit(plan.target);
        tx.create(tripRef.collection('auditEvents').doc(auditIds.target), createAuditEvent({
          eventId: auditIds.target, actorUid, actorDisplayNameSnapshot: user.get('displayName'),
          action: 'participant.linked', entityType: 'participant', entityId: input.participantId,
          before, after: { ...before, linkedUid: targetUid, version: before.version + 1 },
          reason: input.reason, revision, ledgerVersion, operationKey: key, createdAt: now,
        }));
      }
      tx.update(targetMemberRef, plan.memberChanges);
      if (input.participantId) tx.set(plan.linkRef, { schemaVersion: 1, uid: targetUid,
        participantId: input.participantId, updatedAt: now });
      else tx.delete(plan.linkRef);
      tx.update(tripRef, { revision, updatedAt: now });
      tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
      const resourceId = input.participantId ?? oldId;
      if (!resourceId) throw new ApiError(409, 'LINK_INVARIANT_FAILED', 'Liên kết chưa hợp lệ.');
      const response = { uid: targetUid, participantId: input.participantId, version: expectedVersion + 1 };
      const outcome = createOperationDocument(command, { actorUid, tripId, resourceType: 'participant', resourceId,
        httpStatus: 200, responseSnapshot: { data: response, meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });
}
