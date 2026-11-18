import type { FastifyInstance } from 'fastify';
import { planReceiptAttachments, applyReceiptAttachments } from './services/receipt-attachments.js';
import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from './firebase.js';
import { ApiError, operationKey, requireUser, requireVersion, sendOperationResult } from './http.js';
import { expenseUpdateInput } from './schemas.js';
import { expenseDocumentSchema } from './database/expense.js';
import { settlementDocumentSchema, type SettlementDocument } from './database/settlement.js';
import { balanceSchema, tripSchema } from './database/integrity-schemas.js';
import { createAuditEvent } from './database/audit.js';
import { createOperationDocument, readOperationResult, readOperationSnapshot } from './database/operation.js';
import { applyBalanceDelta, applyExpenseTotals, expenseChangeDelta } from './domain/money.js';
import { applySettlement } from './domain/settlement.js';
import { expenseEditAudit, planExpenseEdit } from './services/expense-edit.js';
import { increment, readTripActor, requireOwner, requireWritable } from './services/trip-access.js';

const tripParams = z.strictObject({ tripId: z.uuid() });
const entityParams = z.strictObject({ tripId: z.uuid(), id: z.uuid() });
const emptyInput = z.strictObject({});
const voidInput = z.strictObject({ reason: z.string().trim().min(1).max(300) });
function parse<T>(schema: z.ZodType<T>, value: unknown, path = false): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(path ? 404 : 422, path ? 'NOT_FOUND' : 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ.');
  return result.data;
}
function invariant(): never {
  throw new ApiError(409, 'PROJECTION_INVARIANT_FAILED', 'Dữ liệu sổ tiền chưa đồng nhất.');
}
function count(trip: FirebaseFirestore.DocumentSnapshot, field: string): number {
  const value = trip.get(field);
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) return invariant();
  return value;
}
function balance(snapshot: FirebaseFirestore.DocumentSnapshot) {
  const value = balanceSchema.safeParse(snapshot.data());
  if (!value.success || value.data.participantId !== snapshot.id ||
      value.data.netMinor !== value.data.paidMinor - value.data.owedMinor + value.data.sentMinor - value.data.receivedMinor) return invariant();
  return value.data;
}
function settlementAudit(data: SettlementDocument) {
  return { id: data.id, fromParticipantId: data.fromParticipantId, toParticipantId: data.toParticipantId,
    amountMinor: data.amountMinor, basedOnLedgerVersion: data.basedOnLedgerVersion,
    status: data.status, version: data.version, confirmationMode: data.confirmationMode };
}
function tripState(trip: FirebaseFirestore.DocumentSnapshot) {
  return { id: trip.id, status: trip.get('status'), version: trip.get('version'), inviteEpoch: trip.get('inviteEpoch'),
    archivedAt: (trip.get('archivedAt') as Timestamp | null)?.toDate().toISOString() ?? null };
}

export async function registerLedgerRoutes(app: FastifyInstance) {
  app.patch('/api/v1/trips/:tripId/expenses/:id', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const { tripId, id } = parse(entityParams, request.params, true), input = parse(expenseUpdateInput, request.body);
    const expectedVersion = requireVersion(request.headers['if-match']);
    const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/expenses/${id}`,
      body: input, ifMatch: expectedVersion };
    const store = db(), tripRef = store.doc(`trips/${tripId}`), opRef = store.doc(`users/${uid}/operations/${key}`);
    const expenseRef = tripRef.collection('expenses').doc(id), auditId = randomUUID();
    const receiptAuditIds = Array.from({ length: 6 }, () => randomUUID());
    const result = await store.runTransaction(async tx => {
      const [{ trip, member, user }, op, expense] = await Promise.all([
        readTripActor(tx, tripRef, uid), readOperationSnapshot(tx, opRef), tx.get(expenseRef),
      ]);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      requireWritable(trip);
      if (!expense.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy khoản chi.');
      if (member.get('role') !== 'owner' && expense.get('createdBy') !== uid) throw new ApiError(403, 'FORBIDDEN', 'Bạn không thể sửa khoản chi này.');
      if (expense.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Khoản chi đã thay đổi.');
      if (expense.get('status') !== 'active') throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Khoản chi đã hủy.');
      const parsed = expenseDocumentSchema.safeParse(expense.data());
      if (!parsed.success || parsed.data.id !== id) throw new ApiError(409, 'EXPENSE_INVARIANT_FAILED', 'Khoản chi cần được kiểm tra dữ liệu trước khi sửa.');
      const previous = parsed.data, plan = planExpenseEdit(previous, input);
      const now = Timestamp.now(), revision = increment(trip.get('revision'));
      const ledgerVersion = count(trip, 'ledgerVersion') + (plan.financialChanged ? 1 : 0);
      const changes = { ...plan.patch, version: increment(expectedVersion), updatedAt: now, updatedBy: uid };
      const next = expenseDocumentSchema.safeParse({ ...previous, ...changes });
      if (!next.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Khoản chi chưa hợp lệ.');
      const newIds = [...new Set([next.data.payerParticipantId, ...next.data.shares.map(share => share.participantId)])];
      const participants = plan.hasFinancialBlock ? await Promise.all(newIds.map(personId =>
        tx.get(tripRef.collection('participants').doc(personId)))) : [];
      if (participants.some(doc => !doc.exists || doc.get('status') !== 'active')) {
        throw new ApiError(422, 'INVALID_PARTICIPANTS', 'Có người không thuộc chuyến hoặc đã ngừng chia.');
      }
      const deltas: ReturnType<typeof expenseChangeDelta> = plan.financialChanged ? expenseChangeDelta(previous, next.data) : new Map();
      const balances = await Promise.all([...deltas.keys()].map(personId => tx.get(tripRef.collection('balances').doc(personId))));
      let nextBalances, totals;
      try {
        nextBalances = balances.map(doc => ({ ...applyBalanceDelta(balance(doc), deltas.get(doc.id)!), updatedAt: now }));
        if (previous.amountMinor !== next.data.amountMinor || previous.category !== next.data.category) {
          const reversed = applyExpenseTotals(trip.get('totalExpenseMinor'), trip.get('categoryTotalsMinor'), previous.category, previous.amountMinor, -1);
          totals = applyExpenseTotals(reversed.totalExpenseMinor, reversed.categoryTotalsMinor, next.data.category, next.data.amountMinor, 1);
        }
      } catch { return invariant(); }
      const receiptPlans = input.receiptIds ? await planReceiptAttachments(tx, tripRef, id, uid, input.receiptIds, previous.receiptIds, now) : [];
      tx.update(expenseRef, changes);
      applyReceiptAttachments(tx, tripRef, receiptPlans, { uid, displayName: user.get('displayName'), key,
        auditIds: receiptAuditIds, revision, ledgerVersion, now });
      for (const value of nextBalances) tx.set(tripRef.collection('balances').doc(value.participantId), value);
      for (const person of participants) if (person.get('hasLedgerReferences') !== true) {
        tx.update(person.ref, { hasLedgerReferences: true, updatedAt: now });
      }
      tx.update(tripRef, { ...totals, revision, ledgerVersion, updatedAt: now });
      tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
      tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
        eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'), action: 'expense.updated',
        entityType: 'expense', entityId: id, before: expenseEditAudit(previous), after: expenseEditAudit(next.data), reason: null,
        revision, ledgerVersion, operationKey: key, createdAt: now,
      }));
      const response = { ...expenseEditAudit(next.data), currency: next.data.currency };
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'expense', resourceId: id,
        httpStatus: 200, responseSnapshot: { data: response, meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });

  for (const action of ['cancel', 'void'] as const) {
    app.post(`/api/v1/trips/:tripId/settlements/:id/${action}`, async (request, reply) => {
      const uid = await requireUser(request), key = operationKey(request);
      const { tripId, id } = parse(entityParams, request.params, true);
      const input = action === 'void' ? parse(voidInput, request.body) : parse(emptyInput, request.body);
      const expectedVersion = requireVersion(request.headers['if-match']);
      const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/settlements/${id}/${action}`,
        body: input, ifMatch: expectedVersion };
      const store = db(), tripRef = store.doc(`trips/${tripId}`), settlementRef = tripRef.collection('settlements').doc(id);
      const opRef = store.doc(`users/${uid}/operations/${key}`), auditId = randomUUID();
      const result = await store.runTransaction(async tx => {
        const [{ trip, member, user }, op, settlement] = await Promise.all([
          readTripActor(tx, tripRef, uid), readOperationSnapshot(tx, opRef), tx.get(settlementRef),
        ]);
        const replay = readOperationResult(op.data(), command, uid, tripId);
        if (replay) return { outcome: replay, replayed: true };
        requireWritable(trip);
        if (!settlement.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt trả nợ.');
        if (action === 'void') requireOwner(trip, member);
        else if (member.get('role') !== 'owner' && settlement.get('createdBy') !== uid) {
          throw new ApiError(403, 'FORBIDDEN', 'Chỉ người tạo hoặc chủ chuyến được hủy đề nghị.');
        }
        if (settlement.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Lượt trả nợ đã thay đổi.');
        if (settlement.get('status') !== (action === 'cancel' ? 'pending' : 'confirmed')) {
          throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Lượt trả nợ không ở trạng thái phù hợp.');
        }
        const parsed = settlementDocumentSchema.safeParse(settlement.data());
        if (!parsed.success || parsed.data.id !== id) throw new ApiError(409, 'SETTLEMENT_INVARIANT_FAILED', 'Lượt trả nợ cần được kiểm tra dữ liệu.');
        const previous = parsed.data, now = Timestamp.now(), revision = increment(trip.get('revision'));
        const ledgerVersion = count(trip, 'ledgerVersion') + (action === 'void' ? 1 : 0);
        const pendingCount = count(trip, 'pendingSettlementCount');
        if (pendingCount > count(trip, 'settlementCountAllTime') || action === 'cancel' && pendingCount < 1) return invariant();
        const reason = 'reason' in input ? input.reason as string : null;
        const changes = { version: increment(expectedVersion), updatedAt: now,
          ...(action === 'cancel' ? { status: 'cancelled', cancelledBy: uid, cancelledAt: now } :
            { status: 'void', voidedBy: uid, voidedAt: now, voidReason: reason }) };
        const updated = settlementDocumentSchema.safeParse({ ...previous, ...changes });
        if (!updated.success) throw new ApiError(409, 'SETTLEMENT_INVARIANT_FAILED', 'Lượt trả nợ chưa hợp lệ.');
        const nextBalances = [];
        if (action === 'void') {
          const snaps = await Promise.all([previous.fromParticipantId, previous.toParticipantId].map(personId =>
            tx.get(tripRef.collection('balances').doc(personId))));
          try {
            nextBalances.push({ ...applySettlement(balance(snaps[0]!), 'from', previous.amountMinor, -1), updatedAt: now },
              { ...applySettlement(balance(snaps[1]!), 'to', previous.amountMinor, -1), updatedAt: now });
          } catch { return invariant(); }
        }
        for (const value of nextBalances) tx.set(tripRef.collection('balances').doc(value.participantId), value);
        tx.update(settlementRef, changes);
        tx.update(tripRef, { pendingSettlementCount: pendingCount - (action === 'cancel' ? 1 : 0), revision, ledgerVersion, updatedAt: now });
        tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
        tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
          eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'),
          action: action === 'cancel' ? 'settlement.cancelled' : 'settlement.voided', entityType: 'settlement', entityId: id,
          before: settlementAudit(previous), after: settlementAudit(updated.data), reason,
          revision, ledgerVersion, operationKey: key, createdAt: now,
        }));
        const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'settlement', resourceId: id,
          httpStatus: 200, responseSnapshot: { data: { id, status: updated.data.status, version: updated.data.version,
            confirmationMode: updated.data.confirmationMode }, meta: { revision, ledgerVersion } }, committedAt: now });
        tx.create(opRef, outcome);
        return { outcome, replayed: false };
      });
      return sendOperationResult(reply, result);
    });
  }

  for (const action of ['archive', 'reopen'] as const) {
    app.post(`/api/v1/trips/:tripId/${action}`, async (request, reply) => {
      const uid = await requireUser(request), key = operationKey(request);
      const { tripId } = parse(tripParams, request.params, true), input = parse(emptyInput, request.body);
      const expectedVersion = requireVersion(request.headers['if-match']);
      const command = { method: request.method, canonicalPath: `/api/v1/trips/${tripId}/${action}`, body: input, ifMatch: expectedVersion };
      const store = db(), tripRef = store.doc(`trips/${tripId}`), opRef = store.doc(`users/${uid}/operations/${key}`), auditId = randomUUID();
      const result = await store.runTransaction(async tx => {
        const [{ trip, member, user }, op] = await Promise.all([readTripActor(tx, tripRef, uid), readOperationSnapshot(tx, opRef)]);
        const replay = readOperationResult(op.data(), command, uid, tripId);
        if (replay) return { outcome: replay, replayed: true };
        requireOwner(trip, member);
        if (trip.get('moderationStatus') !== 'normal') throw new ApiError(409, 'TRIP_NOT_WRITABLE', 'Chuyến đi đang khóa thao tác.');
        if (trip.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Chuyến đi đã thay đổi.');
        if (trip.get('status') !== (action === 'archive' ? 'active' : 'archived')) {
          throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Chuyến đi không ở trạng thái phù hợp.');
        }
        if (action === 'archive') {
          const [balances, participants, pending] = await Promise.all([
            tx.get(tripRef.collection('balances').limit(51)), tx.get(tripRef.collection('participants').limit(51)),
            tx.get(tripRef.collection('settlements').where('status', '==', 'pending').limit(1)),
          ]);
          if (balances.size !== trip.get('participantCount') || participants.size !== balances.size || participants.size > 50 ||
              participants.docs.some(person => !balances.docs.some(row => row.id === person.id))) return invariant();
          if (count(trip, 'pendingSettlementCount') !== 0 || !pending.empty) {
            throw new ApiError(409, 'PENDING_SETTLEMENTS', 'Còn đề nghị trả nợ đang chờ. Hãy xác nhận hoặc hủy trước khi chốt.');
          }
          if (balances.docs.some(row => balance(row).netMinor !== 0)) {
            throw new ApiError(409, 'TRIP_NOT_BALANCED', 'Còn số dư chưa quyết toán. Hãy đưa số dư từng người về 0 trước khi chốt.');
          }
        }
        const now = Timestamp.now(), revision = increment(trip.get('revision')), ledgerVersion = count(trip, 'ledgerVersion');
        const patch = { status: action === 'archive' ? 'archived' : 'active', archivedAt: action === 'archive' ? now : null,
          inviteEpoch: action === 'archive' ? increment(trip.get('inviteEpoch')) : trip.get('inviteEpoch'),
          version: increment(expectedVersion), revision, updatedAt: now };
        if (!tripSchema.safeParse({ ...trip.data(), ...patch }).success) return invariant();
        const before = tripState(trip), after = { id: tripId, status: patch.status, archivedAt: patch.archivedAt?.toDate().toISOString() ?? null,
          inviteEpoch: patch.inviteEpoch, version: patch.version };
        tx.update(tripRef, patch);
        tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
        tx.create(tripRef.collection('auditEvents').doc(auditId), createAuditEvent({
          eventId: auditId, actorUid: uid, actorDisplayNameSnapshot: user.get('displayName'),
          action: action === 'archive' ? 'trip.archived' : 'trip.reopened', entityType: 'trip', entityId: tripId,
          before, after, reason: null, revision, ledgerVersion, operationKey: key, createdAt: now,
        }));
        const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'trip', resourceId: tripId,
          httpStatus: 200, responseSnapshot: { data: after, meta: { revision, ledgerVersion } }, committedAt: now });
        tx.create(opRef, outcome);
        return { outcome, replayed: false };
      });
      return sendOperationResult(reply, result);
    });
  }
}
