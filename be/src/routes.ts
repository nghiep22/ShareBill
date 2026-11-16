import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from './firebase.js';
import { ApiError, operationKey, requireUser } from './http.js';
import { tripInput, participantInput, expenseInput } from './schemas.js';
import { splitEqual, validateExact, expenseDelta, applyBalanceDelta, type Balance } from './domain/money.js';

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ.');
  return result.data;
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function params(value: unknown): { tripId: string } {
  const result = z.strictObject({ tripId: z.uuid() }).safeParse(value);
  if (!result.success) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
  return result.data;
}
function zeroBalance(participantId: string): Balance {
  return { participantId, paidMinor: 0, owedMinor: 0, sentMinor: 0, receivedMinor: 0, netMinor: 0 };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', service: 'sharebill-be' }));

  app.post('/api/v1/trips', async request => {
    const uid = await requireUser(request);
    const key = operationKey(request);
    const body = parse(tripInput, request.body);
    const requestHash = hash(body);
    const tripId = randomUUID();
    const participantId = randomUUID();
    const store = db();
    const opRef = store.doc(`users/${uid}/operations/${key}`);
    return store.runTransaction(async tx => {
      const op = await tx.get(opRef);
      if (op.exists) {
        if (op.get('requestHash') !== requestHash || op.get('path') !== '/api/v1/trips') throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Mã yêu cầu đã được dùng.');
        return { data: op.get('response'), meta: { replayed: true } };
      }
      const userRef = store.doc(`users/${uid}`);
      const userSnap = await tx.get(userRef);
      if (userSnap.exists && userSnap.get('status') === 'disabled') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
      const now = FieldValue.serverTimestamp();
      const trip = {
        id: tripId, name: body.name, ownerUid: uid, status: 'active', moderationStatus: 'normal', currency: 'VND',
        version: 1, revision: 1, ledgerVersion: 0, participantCount: 1, membershipCountAllTime: 1,
        expenseCountAllTime: 0, activeExpenseCount: 0, settlementCountAllTime: 0, pendingSettlementCount: 0,
        totalExpenseMinor: 0, createdAt: now, updatedAt: now,
      };
      tx.set(store.doc(`trips/${tripId}`), trip);
      tx.set(store.doc(`trips/${tripId}/memberships/${uid}`), { uid, role: 'owner', status: 'active', participantId, version: 1, joinedAt: now });
      tx.set(store.doc(`trips/${tripId}/participants/${participantId}`), { id: participantId, displayName: body.ownerName, linkedUid: uid, status: 'active', version: 1, createdAt: now });
      tx.set(store.doc(`trips/${tripId}/balances/${participantId}`), zeroBalance(participantId));
      tx.set(store.doc(`trips/${tripId}/signals/current`), { revision: 1, ledgerVersion: 0, updatedAt: now });
      tx.set(store.doc(`users/${uid}/tripRefs/${tripId}`), { tripId, status: 'active', joinedAt: now });
      if (!userSnap.exists) tx.set(userRef, { status: 'active', createdAt: now, updatedAt: now });
      const response = { id: tripId, name: body.name, ownerParticipantId: participantId, currency: 'VND', version: 1 };
      tx.set(opRef, { requestHash, path: '/api/v1/trips', response, committedAt: now });
      return { data: response, meta: { replayed: false } };
    });
  });

  app.get('/api/v1/trips/:tripId/overview', async request => {
    const uid = await requireUser(request);
    const { tripId } = params(request.params);
    const store = db();
    return store.runTransaction(async tx => {
      const membership = await tx.get(store.doc(`trips/${tripId}/memberships/${uid}`));
      if (!membership.exists || membership.get('status') !== 'active') throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
      const trip = await tx.get(store.doc(`trips/${tripId}`));
      if (!trip.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
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

  app.post('/api/v1/trips/:tripId/participants', async request => {
    const uid = await requireUser(request);
    const key = operationKey(request);
    const { tripId } = params(request.params);
    const body = parse(participantInput, request.body);
    const path = `/api/v1/trips/${tripId}/participants`;
    const requestHash = hash(body);
    const participantId = randomUUID();
    const store = db();
    return store.runTransaction(async tx => {
      const opRef = store.doc(`users/${uid}/operations/${key}`);
      const tripRef = store.doc(`trips/${tripId}`);
      const [op, member, trip, user] = await Promise.all([
        tx.get(opRef), tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)), tx.get(tripRef), tx.get(store.doc(`users/${uid}`)),
      ]);
      if (!member.exists || member.get('status') !== 'active' || !trip.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
      if (user.get('status') === 'disabled') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
      if (op.exists) {
        if (op.get('requestHash') !== requestHash || op.get('path') !== path) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Mã yêu cầu đã được dùng.');
        return { data: op.get('response'), meta: { replayed: true } };
      }
      if (member.get('role') !== 'owner') throw new ApiError(403, 'FORBIDDEN', 'Chỉ chủ nhóm có thể thêm người.');
      if (trip.get('status') !== 'active' || trip.get('moderationStatus') !== 'normal') throw new ApiError(409, 'TRIP_NOT_WRITABLE', 'Chuyến đi đang khóa thao tác.');
      if (trip.get('participantCount') >= 50) throw new ApiError(422, 'TRIP_LIMIT_REACHED', 'Chuyến đi đã đủ 50 người.');
      const now = FieldValue.serverTimestamp();
      const revision = trip.get('revision') + 1;
      const response = { id: participantId, displayName: body.displayName, status: 'active', version: 1 };
      tx.set(store.doc(`trips/${tripId}/participants/${participantId}`), { ...response, linkedUid: null, createdAt: now });
      tx.set(store.doc(`trips/${tripId}/balances/${participantId}`), zeroBalance(participantId));
      tx.update(tripRef, { participantCount: FieldValue.increment(1), revision, updatedAt: now });
      tx.set(store.doc(`trips/${tripId}/signals/current`), { revision, ledgerVersion: trip.get('ledgerVersion'), updatedAt: now });
      tx.set(opRef, { path, requestHash, response, tripId, committedAt: now });
      return { data: response, meta: { revision, replayed: false } };
    });
  });

  app.post('/api/v1/trips/:tripId/expenses', async request => {
    const uid = await requireUser(request);
    const key = operationKey(request);
    const { tripId } = params(request.params);
    const body = parse(expenseInput, request.body);
    let shares;
    try { shares = body.splitMethod === 'equal' ? splitEqual(body.amountMinor, body.split.participantIds) : validateExact(body.amountMinor, body.split.shares); }
    catch (error) { throw new ApiError(422, error instanceof Error ? error.message : 'INVALID_SPLIT', 'Cách chia tiền chưa hợp lệ.'); }
    const path = `/api/v1/trips/${tripId}/expenses`;
    const requestHash = hash(body);
    const expenseId = randomUUID();
    const store = db();
    return store.runTransaction(async tx => {
      const opRef = store.doc(`users/${uid}/operations/${key}`);
      const tripRef = store.doc(`trips/${tripId}`);
      const participantIds = [...new Set([body.payerParticipantId, ...shares.map(x => x.participantId)])];
      const [op, trip, member, user, ...participantSnaps] = await Promise.all([
        tx.get(opRef), tx.get(tripRef), tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)), tx.get(store.doc(`users/${uid}`)),
        ...participantIds.map(id => tx.get(store.doc(`trips/${tripId}/participants/${id}`))),
      ]);
      if (!member.exists || member.get('status') !== 'active' || !trip.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
      if (user.get('status') === 'disabled') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
      if (op.exists) {
        if (op.get('requestHash') !== requestHash || op.get('path') !== path) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Mã yêu cầu đã được dùng.');
        return { data: op.get('response'), meta: { replayed: true } };
      }
      if (trip.get('status') !== 'active' || trip.get('moderationStatus') !== 'normal') throw new ApiError(409, 'TRIP_NOT_WRITABLE', 'Chuyến đi đang khóa thao tác.');
      if (trip.get('expenseCountAllTime') >= 2000) throw new ApiError(422, 'TRIP_LIMIT_REACHED', 'Chuyến đi đã đạt giới hạn khoản chi.');
      if (participantSnaps.some(p => !p.exists || p.get('status') !== 'active')) throw new ApiError(422, 'INVALID_PARTICIPANTS', 'Có người chưa thuộc chuyến đi hoặc đã ngừng tham gia.');
      const deltas = expenseDelta(body.amountMinor, body.payerParticipantId, shares, 1);
      const balanceSnaps = await Promise.all([...deltas.keys()].map(id => tx.get(store.doc(`trips/${tripId}/balances/${id}`))));
      const nextBalances = [...deltas].map(([id, delta], index) => applyBalanceDelta((balanceSnaps[index]?.data() as Balance | undefined) ?? zeroBalance(id), delta));
      if (!Number.isSafeInteger(trip.get('totalExpenseMinor') + body.amountMinor)) throw new ApiError(422, 'UNSAFE_AMOUNT', 'Tổng tiền vượt giới hạn.');
      const now = FieldValue.serverTimestamp();
      const revision = trip.get('revision') + 1;
      const ledgerVersion = trip.get('ledgerVersion') + 1;
      const response = { id: expenseId, ...body, shares, status: 'active', version: 1 };
      tx.set(store.doc(`trips/${tripId}/expenses/${expenseId}`), { ...response, createdBy: uid, createdAt: now, updatedAt: now });
      nextBalances.forEach(b => tx.set(store.doc(`trips/${tripId}/balances/${b.participantId}`), b));
      tx.update(tripRef, { expenseCountAllTime: FieldValue.increment(1), activeExpenseCount: FieldValue.increment(1), totalExpenseMinor: FieldValue.increment(body.amountMinor), revision, ledgerVersion, updatedAt: now });
      tx.set(store.doc(`trips/${tripId}/signals/current`), { revision, ledgerVersion, updatedAt: now });
      tx.set(store.doc(`trips/${tripId}/auditEvents/${expenseId}`), { actorUid: uid, action: 'expense.created', expenseId, amountMinor: body.amountMinor, shares, createdAt: now });
      tx.set(opRef, { path, requestHash, response, tripId, committedAt: now });
      return { data: response, meta: { revision, ledgerVersion, replayed: false } };
    });
  });
}
