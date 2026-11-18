import type { FastifyInstance } from 'fastify';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from './firebase.js';
import { ApiError, requireTripAccess, requireUser } from './http.js';
import { decodeCursor, encodeCursor, cursorValue, timestampPoint, type CursorScope } from './http/cursor.js';
import { expenseReadData } from './database/expense.js';
import { auditEventSchema } from './database/audit.js';
import { operationDocumentSchema } from './database/operation.js';
import { requireActiveProfile } from './services/trip-access.js';

const idSchema = z.strictObject({ tripId: z.uuid(), id: z.uuid().optional() });
const keySchema = z.strictObject({ key: z.uuid() });
const tripQuery = z.strictObject({ status: z.enum(['active', 'archived']).optional(),
  cursor: z.string().optional(), limit: z.string().optional() });
const expenseQuery = z.strictObject({ status: z.enum(['active', 'void']).optional(),
  category: z.enum(['food', 'transport', 'stay', 'tickets', 'shopping', 'other']).optional(),
  payer: z.uuid().optional(), from: z.iso.date().optional(), to: z.iso.date().optional(),
  cursor: z.string().optional(), limit: z.string().optional() });
const settlementQuery = z.strictObject({ status: z.enum(['pending', 'confirmed', 'cancelled', 'void']).optional(),
  cursor: z.string().optional(), limit: z.string().optional() });
const activityQuery = z.strictObject({ cursor: z.string().optional(), limit: z.string().optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'INVALID_QUERY', 'Tham số truy vấn không hợp lệ.');
  return result.data;
}
function parsePath<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy dữ liệu.');
  return result.data;
}
function pageSize(value: string | undefined, max: number): number {
  if (value === undefined) return max;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max) {
    throw new ApiError(400, 'INVALID_LIMIT', `Mỗi trang có tối đa ${max} bản ghi.`);
  }
  return Number(value);
}
function dto(snapshot: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> {
  const result: Record<string, unknown> = { ...snapshot.data() };
  for (const key of ['createdAt', 'updatedAt', 'voidedAt', 'confirmedAt', 'cancelledAt']) {
    if (result[key] instanceof Timestamp) result[key] = result[key].toDate().toISOString();
  }
  return result;
}
function activityDto(snapshot: FirebaseFirestore.QueryDocumentSnapshot) {
  const raw = snapshot.data();
  const parsed = auditEventSchema.safeParse(raw);
  if (!parsed.success) return { eventId: snapshot.id, action: 'legacy', actorUid: null,
    actorDisplayNameSnapshot: null, entityType: null, entityId: null, reason: null,
    revision: null, ledgerVersion: null,
    createdAt: raw.createdAt instanceof Timestamp ? raw.createdAt.toDate().toISOString() : null };
  const event = parsed.data;
  const amount = (value: unknown) => value && typeof value === 'object' && 'amountMinor' in value && typeof value.amountMinor === 'number'
    ? value.amountMinor : null;
  return { eventId: snapshot.id, action: event.action, actorUid: event.actorUid,
    actorDisplayNameSnapshot: event.actorDisplayNameSnapshot, entityType: event.entityType,
    entityId: event.entityId, reason: event.reason, revision: event.revision,
    ledgerVersion: event.ledgerVersion, createdAt: event.createdAt.toDate().toISOString(),
    amountBeforeMinor: amount(event.before), amountAfterMinor: amount(event.after) };
}
function scope(kind: CursorScope['kind'], uid: string, sort: string,
  filters: Record<string, string | null>, tripId?: string): CursorScope {
  return { kind, uid, tripId, sort, filters };
}
async function access(tx: FirebaseFirestore.Transaction, store: FirebaseFirestore.Firestore,
  uid: string, tripId: string) {
  const [member, trip] = await Promise.all([
    tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)), tx.get(store.doc(`trips/${tripId}`)),
  ]);
  requireTripAccess(member, trip);
  return trip;
}
function nextCursor(docs: FirebaseFirestore.QueryDocumentSnapshot[], limit: number,
  cursorScope: CursorScope, revision: number | null, sort: string): string | null {
  if (docs.length <= limit) return null;
  const last = docs[limit - 1]!;
  const value = last.get(sort);
  if (typeof value !== 'string' && !(value instanceof Timestamp)) {
    throw new ApiError(409, 'CURSOR_SOURCE_INVALID', 'Không thể phân trang bản ghi cũ.');
  }
  return encodeCursor(cursorScope, revision,
    typeof value === 'string' ? { id: last.id, value } : timestampPoint(value, last.id));
}

export async function registerReadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/trips', async request => {
    const uid = await requireUser(request), store = db();
    const query = parse(tripQuery, request.query);
    const limit = pageSize(query.limit, 20);
    const cursorScope = scope('trips', uid, 'joinedAt', { status: query.status ?? null });
    const point = query.cursor ? decodeCursor(query.cursor, cursorScope, null) : null;
    let refs: FirebaseFirestore.Query = store.collection(`users/${uid}/tripRefs`)
      .where('status', '==', 'active').orderBy('joinedAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (point) refs = refs.startAfter(cursorValue(point.value), point.id);
    const page = await refs.limit(limit + 1).get();
    const selected = page.docs.slice(0, limit);
    const items = await Promise.all(selected.map(async ref => {
      if (!z.uuid().safeParse(ref.id).success) return null;
      const [trip, member] = await Promise.all([
        store.doc(`trips/${ref.id}`).get(), store.doc(`trips/${ref.id}/memberships/${uid}`).get(),
      ]);
      if (!trip.exists || !member.exists || member.get('status') !== 'active' ||
          query.status && trip.get('status') !== query.status) return null;
      return { ...dto(trip), role: member.get('role'), myParticipantId: member.get('participantId') };
    }));
    return { data: { items: items.filter(Boolean), nextCursor: nextCursor(page.docs, limit, cursorScope, null, 'joinedAt') } };
  });

  app.get('/api/v1/trips/:tripId/expenses', async request => {
    const uid = await requireUser(request), { tripId } = parsePath(idSchema, request.params), store = db();
    const input = parse(expenseQuery, request.query);
    if (input.category && input.payer || (input.category || input.payer) && !input.status ||
        input.from && input.to && input.from > input.to) {
      throw new ApiError(422, 'UNSUPPORTED_FILTERS', 'Bộ lọc khoản chi chưa được hỗ trợ.');
    }
    const limit = pageSize(input.limit, 50);
    const cursorScope = scope('expenses', uid, 'occurredOn', {
      status: input.status ?? null, category: input.category ?? null, payer: input.payer ?? null,
      from: input.from ?? null, to: input.to ?? null,
    }, tripId);
    return store.runTransaction(async tx => {
      const trip = await access(tx, store, uid, tripId);
      const revision = trip.get('revision') as number;
      const point = input.cursor ? decodeCursor(input.cursor, cursorScope, revision) : null;
      let query: FirebaseFirestore.Query = store.collection(`trips/${tripId}/expenses`);
      if (input.status) query = query.where('status', '==', input.status);
      if (input.category) query = query.where('category', '==', input.category);
      if (input.payer) query = query.where('payerParticipantId', '==', input.payer);
      if (input.from) query = query.where('occurredOn', '>=', input.from);
      if (input.to) query = query.where('occurredOn', '<=', input.to);
      query = query.orderBy('occurredOn', 'desc').orderBy(FieldPath.documentId(), 'desc');
      if (point) query = query.startAfter(cursorValue(point.value), point.id);
      const page = await tx.get(query.limit(limit + 1));
      return { data: { items: page.docs.slice(0, limit).map(doc => expenseReadData(dto(doc))),
        nextCursor: nextCursor(page.docs, limit, cursorScope, revision, 'occurredOn') } };
    }, { readOnly: true });
  });

  app.get('/api/v1/trips/:tripId/expenses/:id', async (request, reply) => {
    const uid = await requireUser(request), { tripId, id } = parsePath(idSchema, request.params), store = db();
    return store.runTransaction(async tx => {
      await access(tx, store, uid, tripId);
      const expense = await tx.get(store.doc(`trips/${tripId}/expenses/${id}`));
      if (!expense.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy khoản chi.');
      if (Number.isSafeInteger(expense.get('version'))) reply.header('ETag', `"${expense.get('version')}"`);
      return { data: expenseReadData(dto(expense)) };
    }, { readOnly: true });
  });

  app.get('/api/v1/trips/:tripId/settlements', async request => {
    const uid = await requireUser(request), { tripId } = parsePath(idSchema, request.params), store = db();
    const input = parse(settlementQuery, request.query), limit = pageSize(input.limit, 50);
    const cursorScope = scope('settlements', uid, 'createdAt', { status: input.status ?? null }, tripId);
    return store.runTransaction(async tx => {
      const trip = await access(tx, store, uid, tripId), revision = trip.get('revision') as number;
      const point = input.cursor ? decodeCursor(input.cursor, cursorScope, revision) : null;
      let query: FirebaseFirestore.Query = store.collection(`trips/${tripId}/settlements`);
      if (input.status) query = query.where('status', '==', input.status);
      query = query.orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
      if (point) query = query.startAfter(cursorValue(point.value), point.id);
      const page = await tx.get(query.limit(limit + 1));
      return { data: { items: page.docs.slice(0, limit).map(dto),
        nextCursor: nextCursor(page.docs, limit, cursorScope, revision, 'createdAt') } };
    }, { readOnly: true });
  });

  app.get('/api/v1/trips/:tripId/activity', async request => {
    const uid = await requireUser(request), { tripId } = parsePath(idSchema, request.params), store = db();
    const input = parse(activityQuery, request.query), limit = pageSize(input.limit, 50);
    const cursorScope = scope('activity', uid, 'createdAt', {}, tripId);
    return store.runTransaction(async tx => {
      const trip = await access(tx, store, uid, tripId), revision = trip.get('revision') as number;
      const point = input.cursor ? decodeCursor(input.cursor, cursorScope, revision) : null;
      let query: FirebaseFirestore.Query = store.collection(`trips/${tripId}/auditEvents`)
        .orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
      if (point) query = query.startAfter(cursorValue(point.value), point.id);
      const page = await tx.get(query.limit(limit + 1));
      return { data: { items: page.docs.slice(0, limit).map(activityDto),
        nextCursor: nextCursor(page.docs, limit, cursorScope, revision, 'createdAt') } };
    }, { readOnly: true });
  });

  app.get('/api/v1/operations/:key', async request => {
    const uid = await requireUser(request), { key } = parsePath(keySchema, request.params), store = db();
    const operation = await store.doc(`users/${uid}/operations/${key}`).get();
    if (!operation.exists) throw new ApiError(404, 'OPERATION_UNKNOWN', 'Chưa tìm thấy kết quả; hãy thử lại bằng khóa cũ.');
    const value = operation.data()!;
    if (value.canonicalPath !== undefined && !operationDocumentSchema.safeParse(value).success) {
      throw new ApiError(409, 'OPERATION_RESULT_UNAVAILABLE', 'Không thể xác định kết quả thao tác.');
    }
    if (value.resourceType === 'supportTicket') {
      const ticketId = z.uuid().safeParse(value.resourceId);
      if (!ticketId.success || value.tripId !== null || !(value.committedAt instanceof Timestamp)) {
        throw new ApiError(409, 'OPERATION_RESULT_UNAVAILABLE', 'Không thể xác định báo cáo của thao tác.');
      }
      if (value.actorUid !== uid) throw new ApiError(404, 'OPERATION_UNKNOWN', 'Không tìm thấy thao tác.');
      await store.runTransaction(async tx => {
        const [profile, ticket] = await Promise.all([tx.get(store.doc(`users/${uid}`)), tx.get(store.doc(`supportTickets/${ticketId.data}`))]);
        requireActiveProfile(profile);
        if (!ticket.exists || ticket.get('createdBy') !== uid) throw new ApiError(404, 'OPERATION_UNKNOWN', 'Không tìm thấy thao tác.');
      }, { readOnly: true });
      return { data: { status: 'completed', tripId: null, resourceType: 'supportTicket', resourceId: ticketId.data,
        committedAt: value.committedAt.toDate().toISOString() } };
    }
    const tripId = value.tripId ?? (value.path === '/api/v1/trips' ? value.response?.id : null);
    if (!z.uuid().safeParse(tripId).success) throw new ApiError(409, 'OPERATION_RESULT_UNAVAILABLE', 'Không thể xác định chuyến của thao tác.');
    await store.runTransaction(async tx => { await access(tx, store, uid, tripId); }, { readOnly: true });
    if (value.actorUid !== undefined && value.actorUid !== uid) throw new ApiError(404, 'OPERATION_UNKNOWN', 'Không tìm thấy thao tác.');
    const resourceId = value.resourceId ?? value.response?.id;
    const resourceSchema = value.resourceType === 'membership' ? z.string().min(1).max(128).regex(/^[^/]+$/) : z.uuid();
    if (!resourceSchema.safeParse(resourceId).success) throw new ApiError(409, 'OPERATION_RESULT_UNAVAILABLE', 'Không thể xác định kết quả thao tác.');
    const path: unknown = value.canonicalPath ?? value.path;
    if (typeof path !== 'string' || !(value.committedAt instanceof Timestamp)) {
      throw new ApiError(409, 'OPERATION_RESULT_UNAVAILABLE', 'Không thể xác định kết quả thao tác.');
    }
    const resourceType = value.resourceType ?? (path === '/api/v1/trips' ? 'trip' :
      /\/expenses(?:\/|$)/.test(path) ? 'expense' : /\/settlements(?:\/|$)/.test(path) ? 'settlement' :
        path.endsWith('/participants') ? 'participant' : null);
    if (!resourceType) throw new ApiError(409, 'OPERATION_RESULT_UNAVAILABLE', 'Không thể xác định kết quả thao tác.');
    return { data: { status: 'completed', tripId, resourceType, resourceId,
      committedAt: value.committedAt.toDate().toISOString() } };
  });
}
