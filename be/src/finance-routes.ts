import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from './firebase.js';
import { ApiError, operationKey, requireUser } from './http.js';
import { expenseDelta, applyBalanceDelta, applyExpenseTotals, type Balance, type Share, type ExpenseCategory } from './domain/money.js';
import { suggestSettlements, applySettlement } from './domain/settlement.js';
import { settlementInput, settlementDocumentSchema, createSettlementDocument, confirmationChanges } from './database/settlement.js';

const confirmInput = z.strictObject({ basedOnLedgerVersion: z.number().int().min(0) });
const voidInput = z.strictObject({ reason: z.string().trim().min(1).max(300) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ.');
  return result.data;
}
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function version(value: unknown): number {
  const parsed = typeof value === 'string' ? /^"([1-9][0-9]*)"$/.exec(value) : null;
  if (!parsed) throw new ApiError(428, 'PRECONDITION_REQUIRED', 'Hãy tải lại phiên bản mới nhất.');
  return Number(parsed[1]);
}
function ids(value: unknown): { tripId: string; id?: string } {
  const p = value as { tripId: string; id?: string };
  if (!z.uuid().safeParse(p.tripId).success || (p.id && !z.uuid().safeParse(p.id).success)) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy dữ liệu.');
  return p;
}
function ensureMember(member: FirebaseFirestore.DocumentSnapshot, trip: FirebaseFirestore.DocumentSnapshot, user: FirebaseFirestore.DocumentSnapshot) {
  if (!member.exists || member.get('status') !== 'active' || !trip.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
  if (user.get('status') === 'disabled') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
}
function ensureWritable(trip: FirebaseFirestore.DocumentSnapshot) {
  if (trip.get('status') !== 'active' || trip.get('moderationStatus') !== 'normal') throw new ApiError(409, 'TRIP_NOT_WRITABLE', 'Chuyến đi đang khóa thao tác.');
}
function operationResult(op: FirebaseFirestore.DocumentSnapshot, requestHash: string, path: string) {
  if (!op.exists) return null;
  if (op.get('requestHash') !== requestHash || op.get('path') !== path) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Mã yêu cầu đã được dùng.');
  return { data: op.get('response'), meta: { replayed: true } };
}
function balancesFrom(snaps: FirebaseFirestore.DocumentSnapshot[]): Balance[] {
  return snaps.map(s => {
    if (!s.exists) throw new ApiError(500, 'BALANCE_INVARIANT_FAILED', 'Số dư không đầy đủ.');
    return s.data() as Balance;
  });
}

export async function registerFinanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/trips/:tripId/settlement-suggestions', async request => {
    const uid = await requireUser(request);
    const { tripId } = ids(request.params);
    const store = db();
    return store.runTransaction(async tx => {
      const [member, trip, balanceQuery] = await Promise.all([
        tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)),
        tx.get(store.doc(`trips/${tripId}`)),
        tx.get(store.collection(`trips/${tripId}/balances`)),
      ]);
      if (!member.exists || member.get('status') !== 'active' || !trip.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
      const balances = balanceQuery.docs.map(s => s.data() as Balance);
      return { data: { ledgerVersion: trip.get('ledgerVersion'), suggestions: suggestSettlements(balances) } };
    }, { readOnly: true });
  });

  app.post('/api/v1/trips/:tripId/settlements', async request => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId } = ids(request.params);
    const body = parse(settlementInput, request.body);
    if (body.fromParticipantId === body.toParticipantId) throw new ApiError(422, 'VALIDATION_ERROR', 'Hai người phải khác nhau.');
    const path = `/api/v1/trips/${tripId}/settlements`, requestHash = digest(body), settlementId = randomUUID(), store = db();
    return store.runTransaction(async tx => {
      const opRef = store.doc(`users/${uid}/operations/${key}`), tripRef = store.doc(`trips/${tripId}`);
      const [op, trip, member, user, fromParticipant, toParticipant, fromBalanceSnap, toBalanceSnap] = await Promise.all([
        tx.get(opRef), tx.get(tripRef), tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)), tx.get(store.doc(`users/${uid}`)),
        tx.get(store.doc(`trips/${tripId}/participants/${body.fromParticipantId}`)), tx.get(store.doc(`trips/${tripId}/participants/${body.toParticipantId}`)),
        tx.get(store.doc(`trips/${tripId}/balances/${body.fromParticipantId}`)), tx.get(store.doc(`trips/${tripId}/balances/${body.toParticipantId}`)),
      ]);
      ensureMember(member, trip, user);
      const replay = operationResult(op, requestHash, path); if (replay) return replay;
      ensureWritable(trip);
      if (member.get('role') !== 'owner' && member.get('participantId') !== body.fromParticipantId) throw new ApiError(403, 'FORBIDDEN', 'Bạn không thể ghi trả nợ cho người này.');
      if (!fromParticipant.exists || !toParticipant.exists) throw new ApiError(422, 'INVALID_PARTICIPANTS', 'Người tham gia không hợp lệ.');
      if (trip.get('ledgerVersion') !== body.basedOnLedgerVersion) throw new ApiError(409, 'LEDGER_CHANGED', 'Số dư đã thay đổi. Hãy kiểm tra lại.');
      const [from, to] = balancesFrom([fromBalanceSnap, toBalanceSnap]);
      if (!from || !to || from.netMinor >= 0 || to.netMinor <= 0 || body.amountMinor > Math.min(-from.netMinor, to.netMinor)) throw new ApiError(422, 'SETTLEMENT_EXCEEDS_BALANCE', 'Số tiền trả vượt số nợ hiện tại.');
      if (trip.get('settlementCountAllTime') >= 2000) throw new ApiError(422, 'TRIP_LIMIT_REACHED', 'Chuyến đi đã đạt giới hạn lượt trả nợ.');
      const now = Timestamp.now(), revision = trip.get('revision') + 1;
      const document = createSettlementDocument({ id: settlementId, body, actorUid: uid, now });
      const response = { id: settlementId, ...body, currency: 'VND', status: 'pending', version: 1 };
      tx.create(store.doc(`trips/${tripId}/settlements/${settlementId}`), document);
      if (fromParticipant.get('hasLedgerReferences') !== true) {
        tx.update(store.doc(`trips/${tripId}/participants/${body.fromParticipantId}`), { hasLedgerReferences: true, updatedAt: now });
      }
      if (toParticipant.get('hasLedgerReferences') !== true) {
        tx.update(store.doc(`trips/${tripId}/participants/${body.toParticipantId}`), { hasLedgerReferences: true, updatedAt: now });
      }
      tx.update(tripRef, { settlementCountAllTime: FieldValue.increment(1), pendingSettlementCount: FieldValue.increment(1), revision, updatedAt: now });
      tx.update(store.doc(`trips/${tripId}/signals/current`), { revision, ledgerVersion: trip.get('ledgerVersion'), updatedAt: now });
      tx.set(store.doc(`trips/${tripId}/auditEvents/${randomUUID()}`), { actorUid: uid, action: 'settlement.created', entityId: settlementId, amountMinor: body.amountMinor, createdAt: now });
      tx.set(opRef, { path, requestHash, response, tripId, committedAt: now });
      return { data: response, meta: { revision, replayed: false } };
    });
  });

  app.post('/api/v1/trips/:tripId/settlements/:id/confirm', async request => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId, id } = ids(request.params);
    const body = parse(confirmInput, request.body), expectedVersion = version(request.headers['if-match']);
    const path = `/api/v1/trips/${tripId}/settlements/${id}/confirm`, requestHash = digest({ body, expectedVersion }), store = db();
    return store.runTransaction(async tx => {
      const opRef = store.doc(`users/${uid}/operations/${key}`), tripRef = store.doc(`trips/${tripId}`), settlementRef = store.doc(`trips/${tripId}/settlements/${id}`);
      const [op, trip, member, user, settlement] = await Promise.all([
        tx.get(opRef), tx.get(tripRef), tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)), tx.get(store.doc(`users/${uid}`)), tx.get(settlementRef),
      ]);
      ensureMember(member, trip, user);
      const replay = operationResult(op, requestHash, path); if (replay) return replay;
      ensureWritable(trip);
      if (!settlement.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt trả nợ.');
      if (settlement.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Lượt trả nợ đã thay đổi.');
      if (settlement.get('status') !== 'pending') throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Lượt trả nợ không còn chờ xác nhận.');
      const owner = member.get('role') === 'owner';
      if (!owner && (member.get('participantId') !== settlement.get('toParticipantId') || settlement.get('createdBy') === uid)) throw new ApiError(403, 'FORBIDDEN', 'Chỉ người nhận xác nhận đã nhận tiền.');
      if (body.basedOnLedgerVersion !== trip.get('ledgerVersion')) throw new ApiError(409, 'LEDGER_CHANGED', 'Số dư đã thay đổi. Hãy kiểm tra lại.');
      const fromId = settlement.get('fromParticipantId') as string, toId = settlement.get('toParticipantId') as string, amount = settlement.get('amountMinor') as number;
      const [fromSnap, toSnap] = await Promise.all([tx.get(store.doc(`trips/${tripId}/balances/${fromId}`)), tx.get(store.doc(`trips/${tripId}/balances/${toId}`))]);
      const [from, to] = balancesFrom([fromSnap, toSnap]);
      if (!from || !to || from.netMinor >= 0 || to.netMinor <= 0 || amount > Math.min(-from.netMinor, to.netMinor)) throw new ApiError(422, 'SETTLEMENT_EXCEEDS_BALANCE', 'Số dư hiện tại không còn đủ cho lượt trả này.');
      const now = Timestamp.now(), revision = trip.get('revision') + 1, ledgerVersion = trip.get('ledgerVersion') + 1;
      const mode = owner ? 'owner_on_behalf' as const : 'recipient' as const;
      const response = { id, status: 'confirmed', version: expectedVersion + 1, confirmationMode: mode };
      const changes = confirmationChanges({ actorUid: uid, mode, version: expectedVersion, now });
      if (settlement.get('schemaVersion') === 1 && !settlementDocumentSchema.safeParse({ ...settlement.data(), ...changes }).success) {
        throw new ApiError(409, 'SETTLEMENT_INVARIANT_FAILED', 'Lượt trả nợ chưa sẵn sàng.');
      }
      tx.set(store.doc(`trips/${tripId}/balances/${fromId}`), { ...applySettlement(from, 'from', amount, 1), updatedAt: now });
      tx.set(store.doc(`trips/${tripId}/balances/${toId}`), { ...applySettlement(to, 'to', amount, 1), updatedAt: now });
      tx.update(settlementRef, changes);
      tx.update(tripRef, { pendingSettlementCount: FieldValue.increment(-1), revision, ledgerVersion, updatedAt: now });
      tx.update(store.doc(`trips/${tripId}/signals/current`), { revision, ledgerVersion, updatedAt: now });
      tx.set(store.doc(`trips/${tripId}/auditEvents/${randomUUID()}`), { actorUid: uid, action: 'settlement.confirmed', entityId: id, amountMinor: amount, createdAt: now });
      tx.set(opRef, { path, requestHash, response, tripId, committedAt: now });
      return { data: response, meta: { revision, ledgerVersion, replayed: false } };
    });
  });

  app.post('/api/v1/trips/:tripId/expenses/:id/void', async request => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId, id } = ids(request.params);
    const body = parse(voidInput, request.body), expectedVersion = version(request.headers['if-match']);
    const path = `/api/v1/trips/${tripId}/expenses/${id}/void`, requestHash = digest({ body, expectedVersion }), store = db();
    return store.runTransaction(async tx => {
      const opRef = store.doc(`users/${uid}/operations/${key}`), tripRef = store.doc(`trips/${tripId}`), expenseRef = store.doc(`trips/${tripId}/expenses/${id}`);
      const [op, trip, member, user, expense] = await Promise.all([tx.get(opRef), tx.get(tripRef), tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)), tx.get(store.doc(`users/${uid}`)), tx.get(expenseRef)]);
      ensureMember(member, trip, user);
      const replay = operationResult(op, requestHash, path); if (replay) return replay;
      ensureWritable(trip);
      if (!expense.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy khoản chi.');
      if (expense.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Khoản chi đã thay đổi.');
      if (expense.get('status') !== 'active') throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Khoản chi đã hủy.');
      if (member.get('role') !== 'owner' && expense.get('createdBy') !== uid) throw new ApiError(403, 'FORBIDDEN', 'Bạn không thể hủy khoản chi này.');
      const expenseCount = trip.get('expenseCountAllTime'), activeExpenseCount = trip.get('activeExpenseCount');
      if (!Number.isSafeInteger(expenseCount) || !Number.isSafeInteger(activeExpenseCount) ||
          expenseCount < 1 || activeExpenseCount < 1 || activeExpenseCount > expenseCount) {
        throw new ApiError(409, 'PROJECTION_INVARIANT_FAILED', 'Số đếm chuyến chưa sẵn sàng.');
      }
      const amount = expense.get('amountMinor') as number, payer = expense.get('payerParticipantId') as string, shares = expense.get('shares') as Share[];
      let totals;
      try { totals = applyExpenseTotals(trip.get('totalExpenseMinor'), trip.get('categoryTotalsMinor'),
        expense.get('category') as ExpenseCategory, amount, -1); }
      catch { throw new ApiError(409, 'PROJECTION_INVARIANT_FAILED', 'Thống kê chuyến chưa sẵn sàng.'); }
      const deltas = expenseDelta(amount, payer, shares, -1);
      const snaps = await Promise.all([...deltas.keys()].map(pid => tx.get(store.doc(`trips/${tripId}/balances/${pid}`))));
      const balances = balancesFrom(snaps);
      const now = Timestamp.now(), revision = trip.get('revision') + 1, ledgerVersion = trip.get('ledgerVersion') + 1;
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(ledgerVersion)) {
        throw new ApiError(409, 'PROJECTION_INVARIANT_FAILED', 'Phiên bản chuyến chưa sẵn sàng.');
      }
      const response = { id, status: 'void', version: expectedVersion + 1 };
      [...deltas].forEach(([pid, delta], index) => tx.set(store.doc(`trips/${tripId}/balances/${pid}`),
        { ...applyBalanceDelta(balances[index]!, delta), updatedAt: now }));
      tx.update(expenseRef, { status: 'void', version: expectedVersion + 1, voidReason: body.reason, voidedBy: uid, voidedAt: now, updatedBy: uid, updatedAt: now });
      tx.update(tripRef, { activeExpenseCount: activeExpenseCount - 1, ...totals, revision, ledgerVersion, updatedAt: now });
      tx.update(store.doc(`trips/${tripId}/signals/current`), { revision, ledgerVersion, updatedAt: now });
      tx.set(store.doc(`trips/${tripId}/auditEvents/${randomUUID()}`), { actorUid: uid, action: 'expense.voided', entityId: id, amountMinor: amount, reason: body.reason, createdAt: now });
      tx.set(opRef, { path, requestHash, response, tripId, committedAt: now });
      return { data: response, meta: { revision, ledgerVersion, replayed: false } };
    });
  });
}
