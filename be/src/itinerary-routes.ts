import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { auditActorName, createAuditEvent, type AuditAction } from './database/audit.js';
import { createOperationDocument, readOperationResult, readOperationSnapshot } from './database/operation.js';
import { db } from './firebase.js';
import { ApiError, operationKey, requireUser, requireVersion, sendOperationResult } from './http.js';
import { increment, readTripActor, requireOwner, requireWritable } from './services/trip-access.js';

const maxActivities = 100;
const maxSuggestions = 100;
const tripParams = z.strictObject({ tripId: z.uuid() });
const title = z.string().trim().min(1).max(100);
const activityFields = z.strictObject({
  title,
  day: z.iso.date(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  place: z.string().trim().max(150),
  note: z.string().trim().max(500),
});
const activity = activityFields.extend({ id: z.uuid(), suggestionId: z.uuid().nullable() });
const suggestion = z.strictObject({
  id: z.uuid(), title, author: z.string().min(1).max(80).nullable(), status: z.enum(['pending', 'scheduled', 'declined']),
});
const itinerarySchema = z.strictObject({
  schemaVersion: z.literal(1), version: z.int().positive(),
  activities: z.array(activity).max(maxActivities), suggestions: z.array(suggestion).max(maxSuggestions),
  updatedAt: z.instanceof(Timestamp),
});
const commandInput = z.discriminatedUnion('action', [
  activityFields.extend({ action: z.literal('add-activity'), suggestionId: z.uuid().optional() }),
  activityFields.extend({ action: z.literal('edit-activity'), id: z.uuid() }),
  z.strictObject({ action: z.literal('remove-activity'), id: z.uuid() }),
  z.strictObject({ action: z.literal('suggest'), title }),
  z.strictObject({ action: z.literal('decline-suggestion'), id: z.uuid() }),
]);
type Input = z.infer<typeof commandInput>;
type Itinerary = Omit<z.infer<typeof itinerarySchema>, 'schemaVersion' | 'updatedAt'>;
type Status = 'scheduled' | 'removed' | 'pending' | 'declined';

function readItinerary(snapshot: FirebaseFirestore.DocumentSnapshot): Itinerary {
  if (!snapshot.exists) return { version: 1, activities: [], suggestions: [] };
  const parsed = itinerarySchema.safeParse(snapshot.data());
  if (!parsed.success) throw new ApiError(409, 'ITINERARY_INVARIANT_FAILED', 'Lịch trình chưa sẵn sàng.');
  const { version, activities, suggestions } = parsed.data;
  return { version, activities, suggestions };
}

function applyChange(current: Itinerary, input: Input, newId: string, author: string | null) {
  const activities = [...current.activities];
  const suggestions = [...current.suggestions];
  const version = increment(current.version);

  function change(id: string, action: AuditAction, status: Status, previous?: Status) {
    return {
      next: { version, activities, suggestions }, action, id,
      before: previous ? { id, version: current.version, status: previous } : null,
      after: { id, version, status },
    };
  }

  function pendingSuggestion(id: string) {
    const index = suggestions.findIndex(item => item.id === id);
    const item = suggestions[index];
    if (!item) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy đề xuất.');
    if (item.status !== 'pending') throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Đề xuất này đã được xử lý.');
    return { index, item };
  }

  switch (input.action) {
    case 'add-activity': {
      if (activities.length >= maxActivities) throw new ApiError(422, 'ITINERARY_LIMIT', 'Lịch trình đã đủ 100 hoạt động.');
      const { action: _action, suggestionId, ...fields } = input;
      if (suggestionId) {
        const { index, item } = pendingSuggestion(suggestionId);
        suggestions[index] = { ...item, status: 'scheduled' };
      }
      activities.push({ ...fields, id: newId, suggestionId: suggestionId ?? null });
      return change(newId, 'itinerary.activity_added', 'scheduled');
    }
    case 'edit-activity':
    case 'remove-activity': {
      const index = activities.findIndex(item => item.id === input.id);
      const item = activities[index];
      if (!item) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hoạt động.');
      if (input.action === 'edit-activity') {
        const { action: _action, ...fields } = input;
        activities[index] = { ...item, ...fields };
        return change(item.id, 'itinerary.activity_updated', 'scheduled', 'scheduled');
      }
      activities.splice(index, 1);
      const ideaIndex = suggestions.findIndex(idea => idea.id === item.suggestionId && idea.status === 'scheduled');
      if (ideaIndex !== -1) suggestions[ideaIndex] = { ...suggestions[ideaIndex]!, status: 'pending' };
      return change(item.id, 'itinerary.activity_removed', 'removed', 'scheduled');
    }
    case 'suggest':
      if (suggestions.length >= maxSuggestions) throw new ApiError(422, 'ITINERARY_LIMIT', 'Chuyến đã đủ 100 đề xuất.');
      suggestions.unshift({ id: newId, title: input.title, author, status: 'pending' });
      return change(newId, 'itinerary.suggestion_created', 'pending');
    case 'decline-suggestion': {
      const { index, item } = pendingSuggestion(input.id);
      suggestions[index] = { ...item, status: 'declined' };
      return change(item.id, 'itinerary.suggestion_declined', 'declined', 'pending');
    }
  }
}

export async function registerItineraryRoutes(app: FastifyInstance) {
  const path = '/api/v1/trips/:tripId/itinerary';
  app.get(path, async (request, reply) => {
    const uid = await requireUser(request);
    const params = tripParams.safeParse(request.params);
    if (!params.success) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
    const store = db(), tripRef = store.doc(`trips/${params.data.tripId}`);
    const result = await store.runTransaction(async tx => {
      const [, snapshot] = await Promise.all([readTripActor(tx, tripRef, uid), tx.get(tripRef.collection('itinerary').doc('current'))]);
      return readItinerary(snapshot);
    }, { readOnly: true });
    reply.header('ETag', `"${result.version}"`);
    return { data: result };
  });

  app.post(path, async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const params = tripParams.safeParse(request.params);
    if (!params.success) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
    const parsed = commandInput.safeParse(request.body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Thông tin hoạt động hoặc đề xuất chưa hợp lệ.');
    const { tripId } = params.data, input = parsed.data, version = requireVersion(request.headers['if-match']);
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/itinerary`, body: input, ifMatch: version };
    const store = db(), tripRef = store.doc(`trips/${tripId}`), itineraryRef = tripRef.collection('itinerary').doc('current');
    const opRef = store.doc(`users/${uid}/operations/${key}`), newId = randomUUID(), auditId = randomUUID();
    const result = await store.runTransaction(async tx => {
      const [actor, snapshot, op] = await Promise.all([
        readTripActor(tx, tripRef, uid), tx.get(itineraryRef), readOperationSnapshot(tx, opRef),
      ]);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      if (input.action !== 'suggest') requireOwner(actor.trip, actor.member);
      requireWritable(actor.trip);
      const current = readItinerary(snapshot);
      if (current.version !== version) throw new ApiError(409, 'VERSION_CONFLICT', 'Lịch trình đã thay đổi.');
      const now = Timestamp.now(), revision = increment(actor.trip.get('revision')), ledgerVersion = actor.trip.get('ledgerVersion');
      const displayName = actor.user.get('displayName');
      const change = applyChange(current, input, newId, auditActorName(displayName));
      const outcome = createOperationDocument(command, {
        actorUid: uid, tripId, resourceType: 'itinerary', resourceId: change.id, httpStatus: 200, committedAt: now,
        responseSnapshot: { data: { id: change.id, version: change.next.version }, meta: { revision, ledgerVersion } },
      });
      tx.set(itineraryRef, itinerarySchema.parse({ ...change.next, schemaVersion: 1, updatedAt: now }));
      tx.update(tripRef, { revision, updatedAt: now });
      tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
      tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
        eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: displayName, action: change.action, entityType: 'itinerary',
        entityId: change.id, before: change.before, after: change.after, reason: null, revision, ledgerVersion, operationKey: key, createdAt: now,
      }));
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });
}
