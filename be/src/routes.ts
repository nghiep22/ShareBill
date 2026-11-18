import type { FastifyInstance } from 'fastify';
import { planReceiptAttachments, applyReceiptAttachments } from './services/receipt-attachments.js';
import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { auth, db } from './firebase.js';
import { ApiError, operationKey, requireTripAccess, requireUser, sendOperationResult } from './http.js';
import { tripInput, participantInput, expenseInput } from './schemas.js';
import { splitEqual, validateExact, expenseDelta, applyBalanceDelta, applyExpenseTotals, type Balance } from './domain/money.js';
import { ensureUserProfileDocument } from './services/user-profile.js';
import { createTripDocuments } from './database/trip.js';
import { createParticipantDocuments } from './database/participant.js';
import { createExpenseDocument } from './database/expense.js';
import { createAuditEvent } from './database/audit.js';
import { createOperationDocument, readOperationResult, readOperationSnapshot } from './database/operation.js';
import { readTripActor } from './services/trip-access.js';

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ.');
  return result.data;
}

function params(value: unknown): { tripId: string } {
  const result = z.strictObject({ tripId: z.uuid() }).safeParse(value);
  if (!result.success) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
  return result.data;
}
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', service: 'sharebill-be' }));

  app.post('/api/v1/trips', async (request, reply) => {
    const uid = await requireUser(request);
    const key = operationKey(request);
    const body = parse(tripInput, request.body);
    const identity = await auth().getUser(uid);
    const command = { method: request.method, canonicalPath: '/api/v1/trips', body };
    const tripId = randomUUID();
    const participantId = randomUUID();
    const auditEventId = randomUUID();
    const store = db();
    const opRef = store.doc(`users/${uid}/operations/${key}`);
    const result = await store.runTransaction(async tx => {
      const [op, user] = await Promise.all([readOperationSnapshot(tx, opRef), tx.get(store.doc(`users/${uid}`))]);
      if (identity.disabled || (user.exists && user.get('status') !== 'active')) {
        throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
      }
      const replay = readOperationResult(op.data(), command, uid);
      if (replay) {
        if (!replay.tripId) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
        const [member, trip] = await Promise.all([
          tx.get(store.doc(`trips/${replay.tripId}/memberships/${uid}`)), tx.get(store.doc(`trips/${replay.tripId}`)),
        ]);
        requireTripAccess(member, trip);
        return { outcome: replay, replayed: true };
      }
      const now = Timestamp.now();
      const profile = ensureUserProfileDocument(tx, user, identity, now);
      const initial = createTripDocuments({
        ...body, tripId, participantId, auditEventId, ownerUid: uid,
        actorDisplayNameSnapshot: profile.displayName, operationKey: key, now,
      });
      tx.create(store.doc(`trips/${tripId}`), initial.trip);
      tx.create(store.doc(`trips/${tripId}/memberships/${uid}`), initial.membership);
      tx.create(store.doc(`trips/${tripId}/participants/${participantId}`), initial.participant);
      tx.create(store.doc(`trips/${tripId}/participantLinks/${uid}`), initial.participantLink);
      tx.create(store.doc(`trips/${tripId}/balances/${participantId}`), initial.balance);
      tx.create(store.doc(`trips/${tripId}/signals/current`), initial.signal);
      tx.create(store.doc(`users/${uid}/tripRefs/${tripId}`), initial.tripRef);
      tx.create(store.doc(`trips/${tripId}/auditEvents/${auditEventId}`), initial.audit);
      const response = { id: tripId, name: body.name, ownerParticipantId: participantId, currency: 'VND', version: 1 };
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'trip', resourceId: tripId,
        httpStatus: 200, responseSnapshot: { data: response, meta: {} }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });

  app.get('/api/v1/trips/:tripId/signal', async request => {
    const uid = await requireUser(request), { tripId } = params(request.params);
    const store = db(), tripRef = store.doc(`trips/${tripId}`);
    return store.runTransaction(async tx => {
      const { trip } = await readTripActor(tx, tripRef, uid);
      return { data: { revision: trip.get('revision') } };
    }, { readOnly: true });
  });

  app.get('/api/v1/trips/:tripId/overview', async request => {
    const uid = await requireUser(request);
    const { tripId } = params(request.params);
    const store = db();
    return store.runTransaction(async tx => {
      const { trip } = await readTripActor(tx, store.doc(`trips/${tripId}`), uid);
      const [participants, balances] = await Promise.all([
        tx.get(store.collection(`trips/${tripId}/participants`)),
        tx.get(store.collection(`trips/${tripId}/balances`)),
      ]);
      return { data: {
        trip: { ...trip.data(), createdAt: trip.get('createdAt')?.toDate?.().toISOString() ?? null, updatedAt: trip.get('updatedAt')?.toDate?.().toISOString() ?? null },
        participants: participants.docs.map(x => ({ ...x.data(), createdAt: x.get('createdAt')?.toDate?.().toISOString() ?? null })),
        balances: balances.docs.map(x => x.data()),
        revision: trip.get('revision'), ledgerVersion: trip.get('ledgerVersion'),
      } };
    }, { readOnly: true });
  });

  app.post('/api/v1/trips/:tripId/participants', async (request, reply) => {
    const uid = await requireUser(request);
    const key = operationKey(request);
    const { tripId } = params(request.params);
    const body = parse(participantInput, request.body);
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/participants`, body };
    const participantId = randomUUID();
    const auditEventId = randomUUID();
    const store = db();
    const result = await store.runTransaction(async tx => {
      const opRef = store.doc(`users/${uid}/operations/${key}`);
      const tripRef = store.doc(`trips/${tripId}`);
      const [op, member, trip, user] = await Promise.all([
        readOperationSnapshot(tx, opRef), tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)), tx.get(tripRef), tx.get(store.doc(`users/${uid}`)),
      ]);
      requireTripAccess(member, trip);
      if (user.get('status') === 'disabled') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      if (member.get('role') !== 'owner') throw new ApiError(403, 'FORBIDDEN', 'Chỉ chủ nhóm có thể thêm người.');
      if (trip.get('status') !== 'active' || trip.get('moderationStatus') !== 'normal') throw new ApiError(409, 'TRIP_NOT_WRITABLE', 'Chuyến đi đang khóa thao tác.');
      if (trip.get('participantCount') >= 50) throw new ApiError(422, 'TRIP_LIMIT_REACHED', 'Chuyến đi đã đủ 50 người.');
      const now = Timestamp.now();
      const revision = trip.get('revision') + 1;
      const response = { id: participantId, displayName: body.displayName, status: 'active', version: 1 };
      const initial = createParticipantDocuments({
        participantId, displayName: body.displayName, createdBy: uid, linkedUid: null, now,
      });
      tx.create(store.doc(`trips/${tripId}/participants/${participantId}`), initial.participant);
      tx.create(store.doc(`trips/${tripId}/balances/${participantId}`), initial.balance);
      tx.create(store.doc(`trips/${tripId}/auditEvents/${auditEventId}`), createAuditEvent({
        eventId: auditEventId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'),
        action: 'participant.created', entityType: 'participant', entityId: participantId,
        before: null, after: { id: participantId, displayName: body.displayName, linkedUid: null,
          status: 'active', version: 1 }, reason: null,
        revision, ledgerVersion: trip.get('ledgerVersion'), operationKey: key, createdAt: now,
      }));
      tx.update(tripRef, { participantCount: FieldValue.increment(1), revision, updatedAt: now });
      tx.update(store.doc(`trips/${tripId}/signals/current`), { revision, ledgerVersion: trip.get('ledgerVersion'), updatedAt: now });
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'participant', resourceId: participantId,
        httpStatus: 200, responseSnapshot: { data: response, meta: { revision } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });

  app.post('/api/v1/trips/:tripId/expenses', async (request, reply) => {
    const uid = await requireUser(request);
    const key = operationKey(request);
    const { tripId } = params(request.params);
    const body = parse(expenseInput, request.body);
    let shares;
    try { shares = body.splitMethod === 'equal' ? splitEqual(body.amountMinor, body.split.participantIds) : validateExact(body.amountMinor, body.split.shares); }
    catch (error) { throw new ApiError(422, error instanceof Error ? error.message : 'INVALID_SPLIT', 'Cách chia tiền chưa hợp lệ.'); }
    // Empty receiptIds was absent from requests before D05; preserve their operation hash.
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/expenses`, body,
      legacyBody: { ...body, receiptIds: undefined } };
    const expenseId = randomUUID();
    const auditEventId = randomUUID();
    const receiptAuditIds = Array.from({ length: 3 }, () => randomUUID());
    const store = db();
    const result = await store.runTransaction(async tx => {
      const opRef = store.doc(`users/${uid}/operations/${key}`);
      const tripRef = store.doc(`trips/${tripId}`);
      const participantIds = [...new Set([body.payerParticipantId, ...shares.map(x => x.participantId)])];
      const [op, trip, member, user, ...participantSnaps] = await Promise.all([
        readOperationSnapshot(tx, opRef), tx.get(tripRef), tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)), tx.get(store.doc(`users/${uid}`)),
        ...participantIds.map(id => tx.get(store.doc(`trips/${tripId}/participants/${id}`))),
      ]);
      requireTripAccess(member, trip);
      if (user.get('status') === 'disabled') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      if (trip.get('status') !== 'active' || trip.get('moderationStatus') !== 'normal') throw new ApiError(409, 'TRIP_NOT_WRITABLE', 'Chuyến đi đang khóa thao tác.');
      const expenseCount = trip.get('expenseCountAllTime'), activeExpenseCount = trip.get('activeExpenseCount');
      if (!Number.isSafeInteger(expenseCount) || !Number.isSafeInteger(activeExpenseCount) ||
          expenseCount < 0 || activeExpenseCount < 0 || activeExpenseCount > expenseCount) {
        throw new ApiError(409, 'PROJECTION_INVARIANT_FAILED', 'Số đếm chuyến chưa sẵn sàng.');
      }
      if (expenseCount >= 2000) throw new ApiError(422, 'TRIP_LIMIT_REACHED', 'Chuyến đi đã đạt giới hạn khoản chi.');
      if (participantSnaps.some(p => !p.exists || p.get('status') !== 'active')) throw new ApiError(422, 'INVALID_PARTICIPANTS', 'Có người chưa thuộc chuyến đi hoặc đã ngừng tham gia.');
      let totals;
      try { totals = applyExpenseTotals(trip.get('totalExpenseMinor'), trip.get('categoryTotalsMinor'), body.category, body.amountMinor, 1); }
      catch { throw new ApiError(409, 'PROJECTION_INVARIANT_FAILED', 'Thống kê chuyến chưa sẵn sàng.'); }
      const deltas = expenseDelta(body.amountMinor, body.payerParticipantId, shares, 1);
      const balanceSnaps = await Promise.all([...deltas.keys()].map(id => tx.get(store.doc(`trips/${tripId}/balances/${id}`))));
      if (balanceSnaps.some(snapshot => !snapshot.exists)) throw new ApiError(409, 'PROJECTION_INVARIANT_FAILED', 'Số dư chuyến chưa sẵn sàng.');
      const now = Timestamp.now();
      const nextBalances = [...deltas].map(([, delta], index) => ({
        ...applyBalanceDelta(balanceSnaps[index]!.data() as Balance, delta), updatedAt: now,
      }));
      const revision = trip.get('revision') + 1;
      const ledgerVersion = trip.get('ledgerVersion') + 1;
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(ledgerVersion)) {
        throw new ApiError(409, 'PROJECTION_INVARIANT_FAILED', 'Phiên bản chuyến chưa sẵn sàng.');
      }
      const document = createExpenseDocument({ id: expenseId, body, shares, actorUid: uid, now });
      const receiptPlans = await planReceiptAttachments(tx, tripRef, expenseId, uid, body.receiptIds, [], now);
      const response = { id: expenseId, ...body, currency: 'VND', splitInput: body.split, shares, status: 'active', version: 1 };
      tx.create(store.doc(`trips/${tripId}/expenses/${expenseId}`), document);
      applyReceiptAttachments(tx, tripRef, receiptPlans, { uid, displayName: user.get('displayName'), key,
        auditIds: receiptAuditIds, revision, ledgerVersion, now });
      nextBalances.forEach(b => tx.set(store.doc(`trips/${tripId}/balances/${b.participantId}`), b));
      participantSnaps.forEach((snapshot, index) => {
        if (snapshot?.get('hasLedgerReferences') !== true) {
          tx.update(store.doc(`trips/${tripId}/participants/${participantIds[index]}`), { hasLedgerReferences: true, updatedAt: now });
        }
      });
      tx.update(tripRef, { expenseCountAllTime: expenseCount + 1, activeExpenseCount: activeExpenseCount + 1,
        ...totals, revision, ledgerVersion, updatedAt: now });
      tx.update(store.doc(`trips/${tripId}/signals/current`), { revision, ledgerVersion, updatedAt: now });
      tx.create(store.doc(`trips/${tripId}/auditEvents/${auditEventId}`), createAuditEvent({
        eventId: auditEventId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'),
        action: 'expense.created', entityType: 'expense', entityId: expenseId, before: null,
        after: { id: expenseId, amountMinor: body.amountMinor, payerParticipantId: body.payerParticipantId,
          shares, status: 'active', version: 1 }, reason: null,
        revision, ledgerVersion, operationKey: key, createdAt: now,
      }));
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'expense', resourceId: expenseId,
        httpStatus: 200, responseSnapshot: { data: response, meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });
}
