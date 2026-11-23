import type { FastifyInstance } from 'fastify';
import { isGroupEqual, projectGroup, readGroupLedger, writeGroupBalances } from './services/group-sharing.js';
import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from './firebase.js';
import { ApiError, operationKey, requireTripAccess, requireUser, requireVersion, sendOperationResult } from './http.js';
import { expenseDelta, applyBalanceDelta, applyExpenseTotals, type Balance, type Share, type ExpenseCategory } from './domain/money.js';
import { suggestSettlements, applySettlement } from './domain/settlement.js';
import { settlementInput, settlementDocumentSchema, createSettlementDocument, confirmationChanges } from './database/settlement.js';
import { createAuditEvent } from './database/audit.js';
import { createOperationDocument, readOperationResult, readOperationSnapshot } from './database/operation.js';
import { applyReceiptAttachments, planReceiptAttachments } from './services/receipt-attachments.js';

const confirmInput = z.strictObject({ basedOnLedgerVersion: z.number().int().min(0) });
const voidInput = z.strictObject({ reason: z.string().trim().min(1).max(300) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ.');
  return result.data;
}
function ids(value: unknown): { tripId: string; id?: string } {
  const p = value as { tripId: string; id?: string };
  if (!z.uuid().safeParse(p.tripId).success || (p.id && !z.uuid().safeParse(p.id).success)) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy dữ liệu.');
  return p;
}
function ensureMember(member: FirebaseFirestore.DocumentSnapshot, trip: FirebaseFirestore.DocumentSnapshot, user: FirebaseFirestore.DocumentSnapshot) {
  requireTripAccess(member, trip);
  if (user.get('status') === 'disabled') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
}
function ensureWritable(trip: FirebaseFirestore.DocumentSnapshot) {
  if (trip.get('status') !== 'active' || trip.get('moderationStatus') !== 'normal') throw new ApiError(409, 'TRIP_NOT_WRITABLE', 'Chuyến đi đang khóa thao tác.');
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
      const [member, trip, balanceQuery, pendingQuery] = await Promise.all([
        tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)),
        tx.get(store.doc(`trips/${tripId}`)),
        tx.get(store.collection(`trips/${tripId}/balances`)),
        tx.get(store.collection(`trips/${tripId}/settlements`).where('status', '==', 'pending')),
      ]);
      if (!member.exists || member.get('status') !== 'active' || !trip.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
      const balances = balanceQuery.docs.map(s => s.data() as Balance);
      return { data: { ledgerVersion: trip.get('ledgerVersion'), revision: trip.get('revision'),
        suggestions: suggestSettlements(balances), pendingTransfers: pendingQuery.docs.map(item => ({
          fromParticipantId: item.get('fromParticipantId'), toParticipantId: item.get('toParticipantId'), amountMinor: item.get('amountMinor'),
        })) } };
    }, { readOnly: true });
  });

  app.post('/api/v1/trips/:tripId/settlements', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId } = ids(request.params);
    const body = parse(settlementInput, request.body);
    if (body.fromParticipantId === body.toParticipantId) throw new ApiError(422, 'VALIDATION_ERROR', 'Hai người phải khác nhau.');
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/settlements`, body };
    const settlementId = randomUUID(), store = db();
    const auditEventId = randomUUID();
    const receiptAuditIds = Array.from({ length: 3 }, () => randomUUID());
    const result = await store.runTransaction(async tx => {
      const opRef = store.doc(`users/${uid}/operations/${key}`), tripRef = store.doc(`trips/${tripId}`);
      const [op, trip, member, user, fromParticipant, toParticipant, fromBalanceSnap, toBalanceSnap] = await Promise.all([
        readOperationSnapshot(tx, opRef), tx.get(tripRef), tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)), tx.get(store.doc(`users/${uid}`)),
        tx.get(store.doc(`trips/${tripId}/participants/${body.fromParticipantId}`)), tx.get(store.doc(`trips/${tripId}/participants/${body.toParticipantId}`)),
        tx.get(store.doc(`trips/${tripId}/balances/${body.fromParticipantId}`)), tx.get(store.doc(`trips/${tripId}/balances/${body.toParticipantId}`)),
      ]);
      ensureMember(member, trip, user);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      ensureWritable(trip);
      if (member.get('role') !== 'owner' && member.get('participantId') !== body.fromParticipantId) throw new ApiError(403, 'FORBIDDEN', 'Bạn không thể ghi trả nợ cho người này.');
      if (body.receiptIds?.length && member.get('participantId') !== body.fromParticipantId) {
        throw new ApiError(403, 'FORBIDDEN', 'Chỉ người chuyển được gửi ảnh chuyển khoản của mình.');
      }
      if (!fromParticipant.exists || !toParticipant.exists) throw new ApiError(422, 'INVALID_PARTICIPANTS', 'Người tham gia không hợp lệ.');
      if (trip.get('ledgerVersion') !== body.basedOnLedgerVersion) throw new ApiError(409, 'LEDGER_CHANGED', 'Số dư đã thay đổi. Hãy kiểm tra lại.');
      const [from, to] = balancesFrom([fromBalanceSnap, toBalanceSnap]);
      if (!from || !to || from.netMinor >= 0 || to.netMinor <= 0 || body.amountMinor > Math.min(-from.netMinor, to.netMinor)) throw new ApiError(422, 'SETTLEMENT_EXCEEDS_BALANCE', 'Số tiền trả vượt số nợ hiện tại.');
      if (trip.get('settlementCountAllTime') >= 2000) throw new ApiError(422, 'TRIP_LIMIT_REACHED', 'Chuyến đi đã đạt giới hạn lượt trả nợ.');
      const pending = await tx.get(tripRef.collection('settlements').where('status', '==', 'pending'));
      if (pending.docs.some(item => item.get('fromParticipantId') === body.fromParticipantId && item.get('toParticipantId') === body.toParticipantId)) {
        throw new ApiError(409, 'PAYMENT_ALREADY_PENDING', 'Khoản chuyển này đã được ghi nhận và đang chờ xác nhận. Hãy kiểm tra lịch sử chuyển tiền.');
      }
      const now = Timestamp.now(), revision = trip.get('revision') + 1;
      const receiptPlans = await planReceiptAttachments(tx, tripRef, settlementId, uid, body.receiptIds ?? [], [], now, 'attachedSettlementId');
      const document = createSettlementDocument({ id: settlementId, body, actorUid: uid, now });
      const response = { id: settlementId, ...body, receiptIds: document.receiptIds, currency: 'VND', status: 'pending', version: 1 };
      tx.create(store.doc(`trips/${tripId}/settlements/${settlementId}`), document);
      applyReceiptAttachments(tx, tripRef, receiptPlans, { uid, displayName: user.get('displayName'), key,
        auditIds: receiptAuditIds, revision, ledgerVersion: trip.get('ledgerVersion'), now });
      if (fromParticipant.get('hasLedgerReferences') !== true) {
        tx.update(store.doc(`trips/${tripId}/participants/${body.fromParticipantId}`), { hasLedgerReferences: true, updatedAt: now });
      }
      if (toParticipant.get('hasLedgerReferences') !== true) {
        tx.update(store.doc(`trips/${tripId}/participants/${body.toParticipantId}`), { hasLedgerReferences: true, updatedAt: now });
      }
      tx.update(tripRef, { settlementCountAllTime: FieldValue.increment(1), pendingSettlementCount: FieldValue.increment(1), revision, updatedAt: now });
      tx.update(store.doc(`trips/${tripId}/signals/current`), { revision, ledgerVersion: trip.get('ledgerVersion'), updatedAt: now });
      tx.create(store.doc(`trips/${tripId}/auditEvents/${auditEventId}`), createAuditEvent({
        eventId: auditEventId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'),
        action: 'settlement.created', entityType: 'settlement', entityId: settlementId,
        before: null, after: { id: settlementId, fromParticipantId: body.fromParticipantId,
          toParticipantId: body.toParticipantId, amountMinor: body.amountMinor,
          basedOnLedgerVersion: body.basedOnLedgerVersion, status: 'pending', version: 1,
          confirmationMode: null }, reason: null,
        revision, ledgerVersion: trip.get('ledgerVersion'), operationKey: key, createdAt: now,
      }));
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'settlement', resourceId: settlementId,
        httpStatus: 200, responseSnapshot: { data: response, meta: { revision } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });

  app.post('/api/v1/trips/:tripId/settlements/:id/confirm', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId, id } = ids(request.params);
    if (!id) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt trả nợ.');
    const body = parse(confirmInput, request.body), expectedVersion = requireVersion(request.headers['if-match']);
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/settlements/${id}/confirm`, body, ifMatch: expectedVersion };
    const store = db();
    const auditEventId = randomUUID();
    const result = await store.runTransaction(async tx => {
      const opRef = store.doc(`users/${uid}/operations/${key}`), tripRef = store.doc(`trips/${tripId}`), settlementRef = store.doc(`trips/${tripId}/settlements/${id}`);
      const [op, trip, member, user, settlement] = await Promise.all([
        readOperationSnapshot(tx, opRef), tx.get(tripRef), tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)), tx.get(store.doc(`users/${uid}`)), tx.get(settlementRef),
      ]);
      ensureMember(member, trip, user);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      ensureWritable(trip);
      if (!settlement.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt trả nợ.');
      if (settlement.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Lượt trả nợ đã thay đổi.');
      if (settlement.get('status') !== 'pending') throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Lượt trả nợ không còn chờ xác nhận.');
      const owner = member.get('role') === 'owner';
      const recipient = member.get('participantId') === settlement.get('toParticipantId') && (owner || settlement.get('createdBy') !== uid);
      if ((settlement.get('receiptIds') as string[] | undefined)?.length && !recipient) {
        throw new ApiError(403, 'FORBIDDEN', 'Chỉ người nhận được xác nhận đã nhận khoản chuyển có ảnh.');
      }
      if (!owner && !recipient) throw new ApiError(403, 'FORBIDDEN', 'Chỉ người nhận xác nhận đã nhận tiền.');
      if (body.basedOnLedgerVersion !== trip.get('ledgerVersion')) throw new ApiError(409, 'LEDGER_CHANGED', 'Số dư đã thay đổi. Hãy kiểm tra lại.');
      const fromId = settlement.get('fromParticipantId') as string, toId = settlement.get('toParticipantId') as string, amount = settlement.get('amountMinor') as number;
      const [fromSnap, toSnap] = await Promise.all([tx.get(store.doc(`trips/${tripId}/balances/${fromId}`)), tx.get(store.doc(`trips/${tripId}/balances/${toId}`))]);
      const [from, to] = balancesFrom([fromSnap, toSnap]);
      if (!from || !to || from.netMinor >= 0 || to.netMinor <= 0 || amount > Math.min(-from.netMinor, to.netMinor)) throw new ApiError(422, 'SETTLEMENT_EXCEEDS_BALANCE', 'Số dư hiện tại không còn đủ cho lượt trả này.');
      const now = Timestamp.now(), revision = trip.get('revision') + 1, ledgerVersion = trip.get('ledgerVersion') + 1;
      const mode = recipient ? 'recipient' as const : 'owner_on_behalf' as const;
      const response = { id, status: 'confirmed', version: expectedVersion + 1, confirmationMode: mode };
      const changes = confirmationChanges({ actorUid: uid, mode, version: expectedVersion, now });
      const beforeAudit = { id, fromParticipantId: fromId, toParticipantId: toId, amountMinor: amount,
        basedOnLedgerVersion: settlement.get('basedOnLedgerVersion'), status: 'pending',
        version: expectedVersion, confirmationMode: settlement.get('confirmationMode') ?? null };
      if (settlement.get('schemaVersion') === 1 && !settlementDocumentSchema.safeParse({ ...settlement.data(), ...changes }).success) {
        throw new ApiError(409, 'SETTLEMENT_INVARIANT_FAILED', 'Lượt trả nợ chưa sẵn sàng.');
      }
      tx.set(store.doc(`trips/${tripId}/balances/${fromId}`), { ...applySettlement(from, 'from', amount, 1), updatedAt: now });
      tx.set(store.doc(`trips/${tripId}/balances/${toId}`), { ...applySettlement(to, 'to', amount, 1), updatedAt: now });
      tx.update(settlementRef, changes);
      tx.update(tripRef, { pendingSettlementCount: FieldValue.increment(-1), revision, ledgerVersion, updatedAt: now });
      tx.update(store.doc(`trips/${tripId}/signals/current`), { revision, ledgerVersion, updatedAt: now });
      tx.create(store.doc(`trips/${tripId}/auditEvents/${auditEventId}`), createAuditEvent({
        eventId: auditEventId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'),
        action: 'settlement.confirmed', entityType: 'settlement', entityId: id,
        before: beforeAudit, after: { ...beforeAudit, status: 'confirmed', version: expectedVersion + 1,
          confirmationMode: mode }, reason: null,
        revision, ledgerVersion, operationKey: key, createdAt: now,
      }));
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'settlement', resourceId: id,
        httpStatus: 200, responseSnapshot: { data: response, meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });

  app.post('/api/v1/trips/:tripId/expenses/:id/void', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId, id } = ids(request.params);
    if (!id) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy khoản chi.');
    const body = parse(voidInput, request.body), expectedVersion = requireVersion(request.headers['if-match']);
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/expenses/${id}/void`, body, ifMatch: expectedVersion };
    const store = db();
    const auditEventId = randomUUID();
    const result = await store.runTransaction(async tx => {
      const opRef = store.doc(`users/${uid}/operations/${key}`), tripRef = store.doc(`trips/${tripId}`), expenseRef = store.doc(`trips/${tripId}/expenses/${id}`);
      const [op, trip, member, user, expense] = await Promise.all([readOperationSnapshot(tx, opRef), tx.get(tripRef), tx.get(store.doc(`trips/${tripId}/memberships/${uid}`)), tx.get(store.doc(`users/${uid}`)), tx.get(expenseRef)]);
      ensureMember(member, trip, user);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
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
      const beforeAudit = { id, amountMinor: amount, payerParticipantId: payer, shares,
        status: 'active', version: expectedVersion };
      let totals;
      try { totals = applyExpenseTotals(trip.get('totalExpenseMinor'), trip.get('categoryTotalsMinor'),
        expense.get('category') as ExpenseCategory, amount, -1); }
      catch { throw new ApiError(409, 'PROJECTION_INVARIANT_FAILED', 'Thống kê chuyến chưa sẵn sàng.'); }
      const deltas = expenseDelta(amount, payer, shares, -1);
      const group = isGroupEqual(trip) ? await readGroupLedger(tx, trip) : undefined;
      const groupBalances = group ? projectGroup(group, totals.totalExpenseMinor, group.ids, new Map([[payer, -amount]])) : undefined;
      const snaps = group ? [] : await Promise.all([...deltas.keys()].map(pid => tx.get(store.doc(`trips/${tripId}/balances/${pid}`))));
      const balances = balancesFrom(snaps);
      const now = Timestamp.now(), revision = trip.get('revision') + 1, ledgerVersion = trip.get('ledgerVersion') + 1;
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(ledgerVersion)) {
        throw new ApiError(409, 'PROJECTION_INVARIANT_FAILED', 'Phiên bản chuyến chưa sẵn sàng.');
      }
      const response = { id, status: 'void', version: expectedVersion + 1 };
      if (groupBalances) writeGroupBalances(tx, trip, groupBalances, now);
      else [...deltas].forEach(([pid, delta], index) => tx.set(store.doc(`trips/${tripId}/balances/${pid}`),
        { ...applyBalanceDelta(balances[index]!, delta), updatedAt: now }));
      tx.update(expenseRef, { status: 'void', version: expectedVersion + 1, voidReason: body.reason, voidedBy: uid, voidedAt: now, updatedBy: uid, updatedAt: now });
      tx.update(tripRef, { activeExpenseCount: activeExpenseCount - 1, ...totals, revision, ledgerVersion, updatedAt: now });
      tx.update(store.doc(`trips/${tripId}/signals/current`), { revision, ledgerVersion, updatedAt: now });
      tx.create(store.doc(`trips/${tripId}/auditEvents/${auditEventId}`), createAuditEvent({
        eventId: auditEventId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'),
        action: 'expense.voided', entityType: 'expense', entityId: id,
        before: beforeAudit, after: { ...beforeAudit, status: 'void', version: expectedVersion + 1 },
        reason: body.reason, revision, ledgerVersion, operationKey: key, createdAt: now,
      }));
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'expense', resourceId: id,
        httpStatus: 200, responseSnapshot: { data: response, meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });
}
