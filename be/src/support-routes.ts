import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { createOperationDocument, readOperationResult, readOperationSnapshot } from './database/operation.js';
import { db } from './firebase.js';
import { ApiError, operationKey, requireTripAccess, requireUser, sendOperationResult } from './http.js';
import { cursorValue, decodeCursor, encodeCursor, timestampPoint, type CursorScope } from './http/cursor.js';
import { requireActiveProfile } from './services/trip-access.js';

const path = '/api/v1/support-tickets';
const category = z.enum(['usability', 'balance', 'receipt', 'account', 'other']);
const dailyLimit = 5;
const maxPageSize = 25;
const input = z.strictObject({
  category,
  message: z.string().trim().min(10).max(2000),
  tripId: z.uuid().nullable().default(null),
});
export const ticketFields = z.object({
  schemaVersion: z.literal(1), createdBy: z.string().min(1), tripId: z.uuid().nullable(),
  category, message: z.string().min(10).max(2000), status: z.enum(['open', 'in_progress', 'resolved']),
  version: z.int().positive(), createdAt: z.instanceof(Timestamp), updatedAt: z.instanceof(Timestamp),
  resolvedAt: z.instanceof(Timestamp).nullable(),
});
const listQuery = z.strictObject({
  cursor: z.string().optional(),
  limit: z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.int().min(1).max(maxPageSize)).optional(),
});
const countSchema = z.int().min(0).max(dailyLimit);

function missingTicket(): never {
  throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy báo cáo.');
}

function readTicket(snapshot: FirebaseFirestore.DocumentSnapshot, uid: string) {
  if (!snapshot.exists || snapshot.get('createdBy') !== uid) missingTicket();
  const parsed = ticketFields.safeParse(snapshot.data());
  if (!parsed.success) throw new ApiError(409, 'TICKET_INVARIANT_FAILED', 'Báo cáo chưa sẵn sàng.');
  return parsed.data;
}

function summary(id: string, ticket: z.infer<typeof ticketFields>) {
  return {
    id, tripId: ticket.tripId, category: ticket.category, status: ticket.status,
    createdAt: ticket.createdAt.toDate().toISOString(), updatedAt: ticket.updatedAt.toDate().toISOString(),
  };
}

function quotaWindow(now: Timestamp) {
  const dayMs = 86_400_000;
  const vietnamOffsetMs = 7 * 60 * 60 * 1000;
  const start = Math.floor((now.toMillis() + vietnamOffsetMs) / dayMs) * dayMs - vietnamOffsetMs;
  return { start, end: start + dayMs };
}

export async function registerSupportRoutes(app: FastifyInstance) {
  app.post(path, async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const parsed = input.safeParse(request.body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Chọn loại lỗi và nhập mô tả từ 10 đến 2.000 ký tự.');
    const command = { method: request.method, canonicalPath: path, body: parsed.data };
    const { tripId, ...fields } = parsed.data, id = randomUUID();
    const store = db(), profile = store.doc(`users/${uid}`), opRef = profile.collection('operations').doc(key);
    const tripRef = tripId ? store.doc(`trips/${tripId}`) : null;
    const now = Timestamp.now(), window = quotaWindow(now);
    const subjectHash = createHash('sha256').update(uid).digest('hex');
    const limitId = createHash('sha256').update(`support-ticket/${subjectHash}/${window.start}`).digest('hex');
    const rate = store.doc(`rateLimits/${limitId}`);
    const result = await store.runTransaction(async tx => {
      const [op, user] = await Promise.all([readOperationSnapshot(tx, opRef), tx.get(profile)]);
      requireActiveProfile(user);
      const replay = readOperationResult(op.data(), command, uid);
      if (replay) return { outcome: replay, replayed: true };
      if (tripRef) {
        const [trip, member] = await Promise.all([tx.get(tripRef), tx.get(tripRef.collection('memberships').doc(uid))]);
        requireTripAccess(member, trip);
      }
      const quota = await tx.get(rate);
      const parsedCount = countSchema.safeParse(quota.exists ? quota.get('count') : 0);
      if (!parsedCount.success) throw new ApiError(409, 'TICKET_QUOTA_INVARIANT_FAILED', 'Chưa kiểm tra được lượt báo lỗi.');
      if (parsedCount.data >= dailyLimit) throw new ApiError(429, 'SUPPORT_TICKET_LIMIT', 'Bạn đã gửi 5 báo cáo hôm nay. Hãy thử lại vào ngày mai theo giờ Việt Nam.');
      const ticket = ticketFields.parse({
        ...fields, tripId, schemaVersion: 1, createdBy: uid, status: 'open', version: 1, createdAt: now, updatedAt: now, resolvedAt: null,
      });
      const outcome = createOperationDocument(command, {
        actorUid: uid, tripId: null, resourceType: 'supportTicket', resourceId: id, httpStatus: 201, committedAt: now,
        responseSnapshot: { data: summary(id, ticket), meta: {} },
      });
      tx.create(store.doc(`supportTickets/${id}`), ticket);
      tx.set(rate, {
        schemaVersion: 1, scope: 'support-ticket', subjectHash,
        windowStart: Timestamp.fromMillis(window.start), expiresAt: Timestamp.fromMillis(window.end), count: parsedCount.data + 1,
      });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });

  app.get(path, async request => {
    const uid = await requireUser(request);
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) throw new ApiError(400, 'INVALID_QUERY', 'Tham số danh sách báo cáo không hợp lệ.');
    const { cursor, limit = maxPageSize } = parsed.data, store = db();
    const scope: CursorScope = { kind: 'supportTickets', uid, sort: 'createdAt', filters: {} };
    const point = cursor ? decodeCursor(cursor, scope, null) : null;
    return store.runTransaction(async tx => {
      requireActiveProfile(await tx.get(store.doc(`users/${uid}`)));
      let query = store.collection('supportTickets').where('createdBy', '==', uid).orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
      if (point) query = query.startAfter(cursorValue(point.value), point.id);
      const page = await tx.get(query.limit(limit + 1));
      const selected = page.docs.slice(0, limit);
      const rows = selected.map(doc => ({ id: doc.id, ticket: readTicket(doc, uid) }));
      const last = rows.at(-1);
      return { data: {
        items: rows.map(row => summary(row.id, row.ticket)),
        nextCursor: page.size > limit && last ? encodeCursor(scope, null, timestampPoint(last.ticket.createdAt, last.id)) : null,
      } };
    }, { readOnly: true });
  });

  app.get<{ Params: { id: string } }>(path + '/:id', async request => {
    const uid = await requireUser(request), id = z.uuid().safeParse(request.params.id);
    if (!id.success) missingTicket();
    const store = db();
    return store.runTransaction(async tx => {
      const [user, snapshot] = await Promise.all([
        tx.get(store.doc(`users/${uid}`)), tx.get(store.doc(`supportTickets/${id.data}`)),
      ]);
      requireActiveProfile(user);
      const ticket = readTicket(snapshot, uid);
      return { data: { ...summary(id.data, ticket), message: ticket.message } };
    }, { readOnly: true });
  });
}
