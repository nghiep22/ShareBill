import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FieldPath, Timestamp, type DocumentSnapshot, type Query, type Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { createOperationDocument, readOperationResult } from './database/operation.js';
import { db } from './firebase.js';
import { ApiError, operationKey, requireVersion, sendOperationResult } from './http.js';
import { cursorValue, decodeCursor, encodeCursor, timestampPoint, type CursorScope } from './http/cursor.js';
import { adminIdentity, requireAdmin } from './services/admin-access.js';
import { increment } from './services/trip-access.js';
import { ticketFields } from './support-routes.js';
import { uid as uidSchema } from './database/integrity-schemas.js';
import { reconciliationSummary } from './services/ledger-reconciliation.js';

const root = '/api/admin/v1';
const statuses = ticketFields.shape.status;
const filter = { cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(25) };
const supportFilter = z.strictObject({ ...filter, status: statuses.default('open') });
const userFilter = z.strictObject({ ...filter, status: z.enum(['active', 'disabled']).optional(), email: z.email().optional(), uid: z.string().optional() });
const tripFilter = z.strictObject({ ...filter, status: z.enum(['active', 'archived']).optional(), moderationStatus: z.enum(['normal', 'suspended']).optional(), tripId: z.uuid().optional() });
const auditType = z.enum(['user', 'trip', 'support']);
const auditFilter = z.strictObject({ ...filter, targetType: auditType.optional(), from: z.iso.date().optional(), to: z.iso.date().optional() });
const reason = z.string().trim().min(10).max(500);

function input<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Kiểm tra trường bắt buộc và độ dài nội dung.');
  return parsed.data;
}
function missing(): never {
  throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy dữ liệu quản trị.');
}
function idOf(value: string, type: 'uid' | 'uuid' = 'uuid') {
  if (type === 'uuid' ? !z.uuid().safeParse(value).success : !uidSchema.safeParse(value).success) missing();
  return value;
}
const dateOf = (value: unknown) => value instanceof Timestamp ? value.toDate().toISOString() : null;

async function read<T>(request: FastifyRequest, execute: (tx: Transaction, uid: string) => Promise<T>) {
  const uid = await adminIdentity(request);
  const data = await db().runTransaction(async tx => {
    await requireAdmin(tx, uid);
    return execute(tx, uid);
  }, { readOnly: true });
  return { data };
}

async function page<T>(tx: Transaction, source: Query, scope: CursorScope, options: { cursor?: string; limit: number },
  dto: (doc: DocumentSnapshot) => T) {
  const { cursor, limit } = options, order = scope.sort;
  let query = source.orderBy(order, 'desc').orderBy(FieldPath.documentId(), 'desc');
  if (cursor) {
    const point = decodeCursor(cursor, scope, null);
    query = query.startAfter(cursorValue(point.value), point.id);
  }
  const snapshots = await tx.get(query.limit(limit + 1));
  const docs = snapshots.docs.slice(0, limit), last = docs.at(-1);
  return { items: docs.map(dto), nextCursor: snapshots.size > limit && last
    ? encodeCursor(scope, null, timestampPoint(last.get(order), last.id)) : null };
}

function ticketSummary(doc: DocumentSnapshot) {
  if (!doc.exists) missing();
  const ticket = input(ticketFields, doc.data());
  return { id: doc.id, category: ticket.category, createdBy: ticket.createdBy, tripId: ticket.tripId, status: ticket.status,
    version: ticket.version, createdAt: dateOf(ticket.createdAt), updatedAt: dateOf(ticket.updatedAt) };
}
function userSummary(doc: DocumentSnapshot) {
  if (!doc.exists) missing();
  return { id: doc.id, name: doc.get('displayName') ?? null, email: doc.get('email') ?? null, status: doc.get('status'),
    moderationVersion: doc.get('moderationVersion') ?? 1, authSyncStatus: doc.get('authSyncStatus') ?? 'synced', createdAt: dateOf(doc.get('createdAt')) };
}
function tripSummary(doc: DocumentSnapshot) {
  if (!doc.exists) missing();
  return { id: doc.id, name: doc.get('name'), ownerUid: doc.get('ownerUid'), status: doc.get('status'), moderationStatus: doc.get('moderationStatus'),
    moderationVersion: doc.get('moderationVersion') ?? 1, participantCount: doc.get('participantCount'),
    expenseCount: doc.get('activeExpenseCount'), settlementCount: doc.get('settlementCountAllTime'), createdAt: dateOf(doc.get('createdAt')) };
}
function auditSummary(doc: DocumentSnapshot) {
  return { id: doc.id, action: doc.get('action'), targetId: doc.get('targetId'), targetType: doc.get('targetType'),
    actorUid: doc.get('actorUid'), reason: doc.get('reason'), requestId: doc.get('requestId'), createdAt: dateOf(doc.get('createdAt')) };
}
function noteSummary(doc: DocumentSnapshot) {
  return { id: doc.id, note: doc.get('note'), actorUid: doc.get('actorUid'), createdAt: dateOf(doc.get('createdAt')) };
}

type Change = {
  targetType: 'user' | 'trip' | 'support'; action: string; reason: string;
  before: Record<string, unknown>; after: { id: string; version: number } & Record<string, unknown>;
};

async function write(request: FastifyRequest, reply: FastifyReply, canonicalPath: string, body: Record<string, unknown>,
  change: (tx: Transaction, version: number, now: Timestamp, uid: string) => Promise<Change>) {
  const uid = await adminIdentity(request, true), key = operationKey(request);
  const version = requireVersion(request.headers['if-match']), store = db(), now = Timestamp.now();
  const command = { method: request.method, canonicalPath, body, ifMatch: version };
  const operation = store.doc(`adminOperations/${uid}/keys/${key}`), audit = store.collection('adminAuditEvents').doc();
  const result = await store.runTransaction(async tx => {
    await requireAdmin(tx, uid);
    const replay = readOperationResult((await tx.get(operation)).data(), command, uid);
    if (replay) return { outcome: replay, replayed: true };
    const { targetType, action, reason, before, after } = await change(tx, version, now, uid);
    const outcome = createOperationDocument(command, {
      actorUid: uid, tripId: null, resourceType: targetType === 'user' ? 'adminUser' : targetType === 'support' ? 'supportTicket' : 'trip', resourceId: after.id,
      httpStatus: after.jobId ? 202 : 200, responseSnapshot: { data: after, meta: {} }, committedAt: now,
    });
    tx.create(audit, { schemaVersion: 1, actorUid: uid, targetType, targetId: after.id, action,
      before, after, reason, operationKey: key, requestId: request.id, createdAt: now });
    tx.create(operation, outcome);
    return { outcome, replayed: false };
  });
  return sendOperationResult(reply, result);
}

function matchVersion(actual: number, expected: number) {
  if (actual !== expected) throw new ApiError(409, 'VERSION_CONFLICT', 'Dữ liệu đã thay đổi. Hãy tải lại trước khi lưu.');
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get(root + '/me', request => read(request, async (_tx, uid) => ({ uid, role: 'platform_admin' })));

  app.get(root + '/dashboard', async request => {
    const uid = await adminIdentity(request);
    const store = db();
    return store.runTransaction(async tx => {
      await requireAdmin(tx, uid);
      const [users, trips, support, failures, authFailures, tickets, activity] = await Promise.all([
        tx.get(store.collection('users').where('status', '==', 'active').count()),
        tx.get(store.collection('trips').where('status', '==', 'active').count()),
        tx.get(store.collection('supportTickets').where('status', 'in', ['open', 'in_progress']).count()),
        tx.get(store.collection('maintenanceJobs').where('status', '==', 'failed').count()),
        tx.get(store.collection('adminAuthJobs').where('status', '==', 'failed').count()),
        tx.get(store.collection('supportTickets').orderBy('createdAt', 'desc').limit(5)),
        tx.get(store.collection('adminAuditEvents').orderBy('createdAt', 'desc').limit(5)),
      ]);
      return { data: { users: users.data().count, trips: trips.data().count, support: support.data().count,
        failures: failures.data().count + authFailures.data().count, tickets: tickets.docs.map(ticketSummary), activity: activity.docs.map(auditSummary), updatedAt: new Date().toISOString() } };
    }, { readOnly: true });
  });

  app.get(root + '/users', request => read(request, async (tx, uid) => {
    const opts = input(userFilter, request.query);
    const source = db().collection('users');
    if (opts.uid) {
      const doc = await tx.get(source.doc(idOf(opts.uid, 'uid')));
      return { items: doc.exists ? [userSummary(doc)] : [], nextCursor: null };
    }
    if (opts.email) {
      const exact = await tx.get(source.where('emailLower', '==', opts.email.toLowerCase()).limit(10));
      return { items: exact.docs.map(userSummary), nextCursor: null };
    }
    const query = opts.status ? source.where('status', '==', opts.status) : source;
    return page(tx, query, { kind: 'adminUsers', uid, sort: 'createdAt', filters: { status: opts.status ?? null } }, opts, userSummary);
  }));
  app.get<{ Params: { uid: string } }>(root + '/users/:uid', request => read(request, async tx => {
    const doc = await tx.get(db().doc(`users/${idOf(request.params.uid, 'uid')}`));
    return { ...userSummary(doc), disabledReason: doc.get('disabledReason') ?? null };
  }));
  app.get<{ Params: { uid: string } }>(root + '/users/:uid/trips', request => read(request, async (tx, uid) => {
    const target = idOf(request.params.uid, 'uid'), opts = input(z.strictObject(filter), request.query);
    const refs = await page(tx, db().collection(`users/${target}/tripRefs`), {
      kind: 'adminTrips', uid, sort: 'joinedAt', filters: { user: target },
    }, opts, doc => doc.id);
    const docs = await Promise.all(refs.items.map(id => tx.get(db().doc(`trips/${id}`))));
    return { items: docs.filter(doc => doc.exists).map(tripSummary), nextCursor: refs.nextCursor };
  }));
  for (const [action, desiredDisabled] of [['disable', true], ['enable', false]] as const) {
    app.post<{ Params: { uid: string } }>(root + '/users/:uid/' + action, (request, reply) => {
      const target = idOf(request.params.uid, 'uid'), body = input(z.strictObject({ reason }), request.body), jobId = randomUUID();
      return write(request, reply, `${root}/users/${target}/${action}`, body, async (tx, expected, now, actorUid) => {
        const [profile, grant] = await Promise.all([tx.get(db().doc(`users/${target}`)), tx.get(db().doc(`platformAdmins/${target}`))]);
        const before = userSummary(profile);
        if (target === actorUid || grant.get('status') === 'active') throw new ApiError(403, 'ADMIN_TARGET_PROTECTED', 'Tài khoản quản trị cần xử lý qua quy trình operator.');
        matchVersion(before.moderationVersion, expected);
        if (profile.get('desiredAuthDisabled') === desiredDisabled && profile.get('authSyncStatus') !== 'failed') {
          throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Tài khoản đã có trạng thái hoặc yêu cầu này.');
        }
        const version = increment(expected);
        tx.update(profile.ref, { status: 'disabled', desiredAuthDisabled: desiredDisabled, moderationVersion: version, authSyncStatus: 'pending',
          disabledReason: body.reason, disabledAt: now, disabledBy: actorUid, updatedAt: now });
        tx.create(db().doc(`adminAuthJobs/${jobId}`), { schemaVersion: 1, uid: target, desiredDisabled, moderationVersion: version,
          status: 'queued', attempts: 0, availableAt: now, leaseOwner: null, leaseUntil: null, lastErrorCode: null,
          createdBy: actorUid, createdAt: now, updatedAt: now, completedAt: null });
        return { targetType: 'user', action: 'user.' + action, reason: body.reason, before: { status: before.status, version: expected },
          after: { id: target, version, jobId, status: 'disabled', authSyncStatus: 'pending' } };
      });
    });
  }

  app.get(root + '/trips', request => read(request, async (tx, uid) => {
    const opts = input(tripFilter, request.query), source = db().collection('trips');
    if (opts.tripId) {
      const doc = await tx.get(source.doc(opts.tripId));
      return { items: doc.exists ? [tripSummary(doc)] : [], nextCursor: null };
    }
    if (opts.status && opts.moderationStatus) throw new ApiError(422, 'VALIDATION_ERROR', 'Chọn một bộ lọc chuyến đi.');
    const query = opts.status ? source.where('status', '==', opts.status)
      : opts.moderationStatus ? source.where('moderationStatus', '==', opts.moderationStatus) : source;
    return page(tx, query, { kind: 'adminTrips', uid, sort: 'createdAt',
      filters: { status: opts.status ?? null, moderationStatus: opts.moderationStatus ?? null } }, opts, tripSummary);
  }));
  app.get<{ Params: { id: string } }>(root + '/trips/:id', request => read(request, async tx => {
    const doc = await tx.get(db().doc(`trips/${idOf(request.params.id)}`));
    return { ...tripSummary(doc), moderationReason: doc.get('moderationReason') ?? null };
  }));

  for (const [action, status] of [['suspend', 'suspended'], ['resume', 'normal']] as const) {
    app.post<{ Params: { id: string } }>(root + '/trips/:id/' + action, (request, reply) => {
      const id = idOf(request.params.id), body = input(z.strictObject({ reason }), request.body);
      return write(request, reply, `${root}/trips/${id}/${action}`, body, async (tx, expected, now, uid) => {
        const trip = await tx.get(db().doc(`trips/${id}`)), before = tripSummary(trip);
        matchVersion(before.moderationVersion, expected);
        if (before.moderationStatus === status) throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Chuyến đã ở trạng thái này.');
        const version = increment(expected), revision = increment(trip.get('revision'));
        tx.update(trip.ref, { moderationStatus: status, moderationVersion: version, moderationReason: body.reason,
          moderatedAt: now, moderatedBy: uid, revision, updatedAt: now });
        tx.update(trip.ref.collection('signals').doc('current'), { revision, updatedAt: now });
        return { targetType: 'trip', action: 'trip.' + action, reason: body.reason, before: { moderationStatus: before.moderationStatus, version: expected },
          after: { id, moderationStatus: status, version } };
      });
    });
  }

  app.get(root + '/support', request => read(request, async (tx, uid) => {
    const opts = input(supportFilter, request.query);
    return page(tx, db().collection('supportTickets').where('status', '==', opts.status),
      { kind: 'adminSupport', uid, sort: 'updatedAt', filters: { status: opts.status } }, opts, ticketSummary);
  }));
  app.get<{ Params: { id: string } }>(root + '/support/:id', request => read(request, async (tx, uid) => {
    const id = idOf(request.params.id), doc = await tx.get(db().doc(`supportTickets/${id}`)), summary = ticketSummary(doc);
    const [author, trip, notes] = await Promise.all([
      tx.get(db().doc(`users/${summary.createdBy}`)),
      summary.tripId ? tx.get(db().doc(`trips/${summary.tripId}`)) : null,
      page(tx, doc.ref.collection('internalNotes'), { kind: 'adminNotes', uid, sort: 'createdAt', filters: { ticket: id } },
        { limit: 25 }, noteSummary),
    ]);
    return { ...summary, author: author.get('displayName') ?? null, trip: trip?.get('name') ?? null,
      message: doc.get('message'), notes: notes.items, notesCursor: notes.nextCursor };
  }));
  app.get<{ Params: { id: string } }>(root + '/support/:id/notes', request => read(request, async (tx, uid) => {
    const id = idOf(request.params.id), opts = input(z.strictObject(filter), request.query);
    const ticket = await tx.get(db().doc(`supportTickets/${id}`));
    if (!ticket.exists) missing();
    return page(tx, ticket.ref.collection('internalNotes'), { kind: 'adminNotes', uid, sort: 'createdAt', filters: { ticket: id } }, opts, noteSummary);
  }));
  app.patch<{ Params: { id: string } }>(root + '/support/:id', (request, reply) => {
    const id = idOf(request.params.id), body = input(z.strictObject({ status: statuses, reason }), request.body);
    return write(request, reply, `${root}/support/${id}`, body, async (tx, expected, now) => {
      const ticket = await tx.get(db().doc(`supportTickets/${id}`)), before = ticketSummary(ticket);
      matchVersion(before.version, expected);
      if (before.status === body.status) throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Báo lỗi đã ở trạng thái này.');
      const version = increment(expected);
      tx.update(ticket.ref, { status: body.status, version, updatedAt: now, resolvedAt: body.status === 'resolved' ? now : null });
      return { targetType: 'support', action: 'ticket.status_updated', reason: body.reason,
        before: { status: before.status, version: expected }, after: { id, status: body.status, version } };
    });
  });
  app.post<{ Params: { id: string } }>(root + '/support/:id/notes', (request, reply) => {
    const id = idOf(request.params.id), noteId = randomUUID();
    const body = input(z.strictObject({ note: z.string().trim().min(1).max(2000) }), request.body);
    return write(request, reply, `${root}/support/${id}/notes`, body, async (tx, expected, now, uid) => {
      const ticket = await tx.get(db().doc(`supportTickets/${id}`)), before = ticketSummary(ticket);
      matchVersion(before.version, expected);
      const version = increment(expected);
      tx.create(ticket.ref.collection('internalNotes').doc(noteId), { actorUid: uid, note: body.note, createdAt: now });
      tx.update(ticket.ref, { version, updatedAt: now });
      return { targetType: 'support', action: 'ticket.note_added', reason: 'Thêm ghi chú nội bộ',
        before: { version: expected }, after: { id, version, noteId } };
    });
  });

  app.get(root + '/activity', request => read(request, async (tx, uid) => {
    const opts = input(auditFilter, request.query);
    const end = opts.to ? Date.parse(opts.to + 'T00:00:00Z') + 86_400_000 : Date.now();
    const start = opts.from ? Date.parse(opts.from + 'T00:00:00Z') : end - 31 * 86_400_000;
    if (end <= start || end - start > 31 * 86_400_000) throw new ApiError(422, 'VALIDATION_ERROR', 'Chọn khoảng tối đa 31 ngày.');
    let query = db().collection('adminAuditEvents') as Query;
    if (opts.targetType) query = query.where('targetType', '==', opts.targetType);
    query = query.where('createdAt', '>=', Timestamp.fromMillis(start)).where('createdAt', '<', Timestamp.fromMillis(end));
    return page(tx, query, { kind: 'adminAudit', uid, sort: 'createdAt',
      filters: { targetType: opts.targetType ?? null, from: opts.from ?? null, to: opts.to ?? null } }, opts, auditSummary);
  }));
  app.get(root + '/system', request => read(request, async tx => {
    const [jobs, maintenance] = await Promise.all([
      tx.get(db().collection('adminAuthJobs').orderBy('updatedAt', 'desc').limit(25)),
      tx.get(db().collection('maintenanceJobs').orderBy('updatedAt', 'desc').limit(25)),
    ]);
    return { environment: process.env.FIRESTORE_EMULATOR_HOST ? 'EMULATOR' : process.env.APP_ENVIRONMENT === 'production' ? 'PRODUCTION' : 'STAGING',
      release: process.env.RELEASE_COMMIT ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      jobs: jobs.docs.map(jobSummary), maintenance: maintenance.docs.map(jobSummary) };
  }));
  app.get<{ Params: { id: string } }>(root + '/jobs/:id', request => read(request, async tx => {
    const doc = await tx.get(db().doc(`adminAuthJobs/${idOf(request.params.id)}`));
    if (!doc.exists) missing();
    return jobSummary(doc);
  }));
  app.get<{ Params: { key: string } }>(root + '/operations/:key', request => read(request, async (tx, uid) => {
    const doc = await tx.get(db().doc(`adminOperations/${uid}/keys/${idOf(request.params.key)}`));
    if (!doc.exists) throw new ApiError(404, 'OPERATION_UNKNOWN', 'Chưa xác nhận được thao tác này.');
    return { status: 'completed', ...doc.get('responseSnapshot').data };
  }));
}

function jobSummary(doc: DocumentSnapshot) {
  return { id: doc.id, uid: doc.get('uid') ?? null, status: doc.get('status'), attempts: doc.get('attempts') ?? 0,
    moderationVersion: doc.get('moderationVersion') ?? null, lastErrorCode: doc.get('lastErrorCode') ?? null, updatedAt: dateOf(doc.get('updatedAt')),
    ...(doc.get('kind') === 'ledger_reconcile' && { kind: 'ledger_reconcile', resultSummary: reconciliationSummary(doc.get('resultSummary')) }) };
}
