import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from './firebase.js';
import { ApiError, operationKey, requireUser, requireVersion, sendOperationResult } from './http.js';
import { inviteInput, inviteTokenInput } from './schemas.js';
import { createOperationDocument, readOperationResult, readOperationSnapshot } from './database/operation.js';
import { auditActorName, createAuditEvent } from './database/audit.js';
import { membershipSchema, tripRefSchema } from './database/integrity-schemas.js';
import { cursorValue, decodeCursor, encodeCursor, timestampPoint, type CursorScope } from './http/cursor.js';
import { inviteDocumentSchema, inviteDto, inviteLookupSchema, inviteTokenHash, newInviteToken,
  resolveInvite, unavailableInvite, type InviteDocument } from './services/invites.js';
import { increment, readTripActor, requireActiveProfile, requireOwner, requireWritable } from './services/trip-access.js';

const tripParams = z.strictObject({ tripId: z.uuid() });
const inviteParams = z.strictObject({ tripId: z.uuid(), id: z.uuid() });
const listQuery = z.strictObject({ cursor: z.string().optional(), limit: z.string().regex(/^[1-9][0-9]*$/)
  .refine(value => Number(value) <= 50).optional() });
function parse<T>(schema: z.ZodType<T>, value: unknown, path = false): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(path ? 404 : 422, path ? 'NOT_FOUND' : 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ.');
  return parsed.data;
}
function inviteAudit(id: string, data: InviteDocument) {
  return { id, maxUses: data.maxUses, usedCount: data.usedCount, expiresAt: data.expiresAt.toDate().toISOString(),
    revokedAt: data.revokedAt?.toDate().toISOString() ?? null, version: data.version };
}

export async function registerInviteRoutes(app: FastifyInstance) {
  app.post('/api/v1/trips/:tripId/invites', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId } = parse(tripParams, request.params, true), input = parse(inviteInput, request.body);
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/invites`, body: input };
    const store = db(), tripRef = store.doc(`trips/${tripId}`), opRef = store.doc(`users/${uid}/operations/${key}`);
    const id = randomUUID(), auditId = randomUUID(), token = newInviteToken();
    const result = await store.runTransaction(async tx => {
      const [{ trip, member, user }, op] = await Promise.all([readTripActor(tx, tripRef, uid), readOperationSnapshot(tx, opRef)]);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      requireOwner(trip, member); requireWritable(trip);
      const now = Timestamp.now(), revision = increment(trip.get('revision')), ledgerVersion = trip.get('ledgerVersion');
      const data = inviteDocumentSchema.parse({ schemaVersion: 1, createdBy: uid, createdAt: now,
        expiresAt: Timestamp.fromMillis(now.toMillis() + input.expiresInDays * 86_400_000),
        maxUses: input.maxUses, usedCount: 0, revokedAt: null, version: 1, epoch: trip.get('inviteEpoch') });
      tx.create(tripRef.collection('invites').doc(id), data);
      tx.create(store.doc(`inviteTokens/${inviteTokenHash(token)}`), inviteLookupSchema.parse({
        schemaVersion: 1, tripId, inviteId: id, expiresAt: data.expiresAt, createdAt: now,
      }));
      tx.update(tripRef, { revision, updatedAt: now });
      tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
      tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
        eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'), action: 'invite.created',
        entityType: 'invite', entityId: id, before: null, after: inviteAudit(id, data), reason: null,
        revision, ledgerVersion, operationKey: key, createdAt: now,
      }));
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'invite', resourceId: id,
        httpStatus: 201, responseSnapshot: { data: { ...inviteDto(id, data, data.epoch), tokenAvailable: false,
          message: 'Token chỉ trả một lần. Nếu mất link, hãy thu hồi lời mời này và tạo lời mời mới.' },
        meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    // The stored operation always contains the safe response. Add the capability only after a new commit.
    if (!result.replayed) {
      const { message: _message, ...safeData } = result.outcome.responseSnapshot.data;
      result.outcome = { ...result.outcome, responseSnapshot: { ...result.outcome.responseSnapshot,
        data: { ...safeData, tokenAvailable: true, token } } };
    }
    return sendOperationResult(reply, result);
  });

  app.get('/api/v1/trips/:tripId/invites', async request => {
    const uid = await requireUser(request), { tripId } = parse(tripParams, request.params, true);
    const input = parse(listQuery, request.query), limit = Number(input.limit ?? 50), store = db();
    const tripRef = store.doc(`trips/${tripId}`);
    const scope: CursorScope = { kind: 'invites', uid, tripId, filters: {}, sort: 'createdAt' };
    return store.runTransaction(async tx => {
      const { trip, member } = await readTripActor(tx, tripRef, uid);
      requireOwner(trip, member);
      const revision = trip.get('revision'), point = input.cursor ? decodeCursor(input.cursor, scope, revision) : null;
      let query = tripRef.collection('invites').orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
      if (point) query = query.startAfter(cursorValue(point.value), point.id);
      const page = await tx.get(query.limit(limit + 1)), selected = page.docs.slice(0, limit), last = selected.at(-1);
      return { data: { items: selected.map(doc => inviteDto(doc.id, inviteDocumentSchema.parse(doc.data()), trip.get('inviteEpoch'))),
        nextCursor: page.size > limit && last ? encodeCursor(scope, revision, timestampPoint(last.get('createdAt'), last.id)) : null } };
    }, { readOnly: true });
  });

  app.post('/api/v1/trips/:tripId/invites/:id/revoke', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId, id } = parse(inviteParams, request.params, true), expectedVersion = requireVersion(request.headers['if-match']);
    const input = parse(z.strictObject({}), request.body);
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/invites/${id}/revoke`,
      body: input, ifMatch: expectedVersion };
    const store = db(), tripRef = store.doc(`trips/${tripId}`), inviteRef = tripRef.collection('invites').doc(id);
    const opRef = store.doc(`users/${uid}/operations/${key}`), auditId = randomUUID();
    const result = await store.runTransaction(async tx => {
      const [{ trip, member, user }, op, invite] = await Promise.all([
        readTripActor(tx, tripRef, uid), readOperationSnapshot(tx, opRef), tx.get(inviteRef),
      ]);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      requireOwner(trip, member); // Revocation remains available on archived/suspended trips.
      if (!invite.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lời mời.');
      const data = inviteDocumentSchema.parse(invite.data());
      if (data.version !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Lời mời đã thay đổi.');
      if (data.revokedAt) throw new ApiError(409, 'INVITE_ALREADY_REVOKED', 'Lời mời đã được thu hồi.');
      const now = Timestamp.now(), revision = increment(trip.get('revision')), ledgerVersion = trip.get('ledgerVersion');
      const updated = { ...data, revokedAt: now, version: increment(data.version) };
      tx.update(inviteRef, { revokedAt: now, version: updated.version });
      tx.update(tripRef, { revision, updatedAt: now });
      tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
      tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
        eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'), action: 'invite.revoked',
        entityType: 'invite', entityId: id, before: inviteAudit(id, data), after: inviteAudit(id, updated), reason: null,
        revision, ledgerVersion, operationKey: key, createdAt: now,
      }));
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'invite', resourceId: id,
        httpStatus: 200, responseSnapshot: { data: inviteDto(id, updated, trip.get('inviteEpoch')),
          meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });

  app.post('/api/v1/invites/preview', async request => {
    const uid = await requireUser(request), { token } = parse(inviteTokenInput, request.body), store = db();
    return store.runTransaction(async tx => {
      requireActiveProfile(await tx.get(store.doc(`users/${uid}`)));
      const { trip, data } = await resolveInvite(tx, store, token);
      if (data.usedCount >= data.maxUses) {
        const member = await tx.get(trip.ref.collection('memberships').doc(uid));
        if (member.get('status') !== 'active') return unavailableInvite();
        return { data: { trip: { id: trip.id, name: trip.get('name') }, alreadyMember: true,
          inviter: { displayName: null }, expiresAt: data.expiresAt.toDate().toISOString() } };
      }
      const inviter = await tx.get(store.doc(`users/${data.createdBy}`));
      return { data: { trip: { id: trip.id, name: trip.get('name') },
        inviter: { displayName: auditActorName(inviter.get('displayName')) }, expiresAt: data.expiresAt.toDate().toISOString() } };
    }, { readOnly: true });
  });

  app.post('/api/v1/invites/accept', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request), input = parse(inviteTokenInput, request.body);
    const command = { method: request.method, canonicalPath: '/api/v1/invites/accept', body: input };
    const store = db(), opRef = store.doc(`users/${uid}/operations/${key}`), auditId = randomUUID();
    const result = await store.runTransaction(async tx => {
      const [op, user] = await Promise.all([readOperationSnapshot(tx, opRef), tx.get(store.doc(`users/${uid}`))]);
      requireActiveProfile(user);
      const replay = readOperationResult(op.data(), command, uid);
      if (replay) {
        await readTripActor(tx, store.doc(`trips/${replay.tripId}`), uid);
        return { outcome: replay, replayed: true };
      }
      const { trip, tripRef, invite, data } = await resolveInvite(tx, store, input.token);
      const memberRef = tripRef.collection('memberships').doc(uid), member = await tx.get(memberRef);
      if (member.exists && member.get('status') !== 'active') {
        throw new ApiError(409, 'MEMBERSHIP_REMOVED', 'Bạn đã bị gỡ khỏi chuyến. Hãy nhờ chủ chuyến khôi phục quyền.');
      }
      const now = Timestamp.now(), ledgerVersion = trip.get('ledgerVersion');
      let revision = trip.get('revision');
      if (!member.exists) {
        if (data.usedCount >= data.maxUses) return unavailableInvite();
        const count = trip.get('membershipCountAllTime');
        if (!Number.isSafeInteger(count) || count < 1 || count >= 50) {
          throw new ApiError(409, 'MEMBERSHIP_LIMIT_REACHED', 'Chuyến đã đủ 50 tài khoản từng tham gia.');
        }
        const newMember = membershipSchema.parse({ schemaVersion: 1, uid, role: 'member', status: 'active',
          participantId: null, version: 1, joinedAt: now, updatedAt: now, removedAt: null });
        revision = increment(revision);
        tx.create(memberRef, newMember);
        tx.set(store.doc(`users/${uid}/tripRefs/${trip.id}`), tripRefSchema.parse({
          schemaVersion: 1, tripId: trip.id, status: 'active', joinedAt: now, updatedAt: now,
        }));
        tx.update(invite.ref, { usedCount: data.usedCount + 1, version: increment(data.version) });
        tx.update(tripRef, { membershipCountAllTime: count + 1, revision, updatedAt: now });
        tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
        tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
          eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'), action: 'membership.joined',
          entityType: 'membership', entityId: uid, before: null,
          after: { id: uid, role: 'member', status: 'active', participantId: null, version: 1 }, reason: null,
          revision, ledgerVersion, operationKey: key, createdAt: now,
        }));
      }
      const outcome = createOperationDocument(command, { actorUid: uid, tripId: trip.id,
        resourceType: 'membership', resourceId: uid, httpStatus: 200,
        responseSnapshot: { data: { tripId: trip.id, uid, status: member.exists ? 'already-member' : 'joined',
          participantId: member.exists ? member.get('participantId') : null, version: member.exists ? member.get('version') : 1 },
        meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });
}
