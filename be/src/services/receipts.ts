import { createHash, randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../firebase.js';
import { ApiError } from '../http.js';
import { createAuditEvent, type AuditAction } from '../database/audit.js';
import { createOperationDocument, operationRequestHash, readOperationResult, readOperationSnapshot, type OperationCommand } from '../database/operation.js';
import { createReceiptDocument, DAY_MS, DISCARD_GRACE_MS, LEASE_MS, MAX_RECEIPT_BYTES, processedPrefix,
  readReceipt, receiptAudit, receiptDto, receiptIntentInput, type ReceiptDocument } from '../database/receipt.js';
import { increment, readTripActor, requireWritable } from './trip-access.js';
import { processReceiptImage, type ReceiptImageProcessor } from './receipt-image.js';
import { CloudReceiptStorage, type ReceiptStorage } from './receipt-storage.js';
import { VercelReceiptStorage } from './vercel-receipt-storage.js';

type Trip = FirebaseFirestore.DocumentSnapshot;
function denied(): never { throw new ApiError(403, 'FORBIDDEN', 'Bạn không thể thao tác ảnh này.'); }
function inProgress(): never { throw new ApiError(409, 'PROCESSING_IN_PROGRESS', 'Ảnh đang được xử lý. Hãy thử lại cùng mã yêu cầu sau khi lease hết.'); }
function superseded(): never { throw new ApiError(409, 'PROCESSING_SUPERSEDED', 'Lần xử lý này không còn quyền hoàn tất.'); }
function reused(): never { throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Mã yêu cầu đã được dùng cho nội dung khác.'); }
function bump(tx: FirebaseFirestore.Transaction, trip: Trip, now: Timestamp) {
  const revision = increment(trip.get('revision')), ledgerVersion = trip.get('ledgerVersion') as number;
  tx.update(trip.ref, { revision, updatedAt: now });
  tx.update(trip.ref.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
  return { revision, ledgerVersion };
}
function audit(tx: FirebaseFirestore.Transaction, trip: Trip, uid: string, displayName: unknown, key: string,
  auditId: string, action: AuditAction, id: string, before: ReceiptDocument | null, after: ReceiptDocument,
  meta: { revision: number; ledgerVersion: number }, now: Timestamp) {
  tx.create(trip.ref.collection('auditEvents').doc(auditId), createAuditEvent({ eventId: auditId, actorUid: uid,
    actorDisplayNameSnapshot: displayName, action, entityType: 'receipt', entityId: id,
    before: before ? receiptAudit(id, before) : null, after: receiptAudit(id, after), reason: null,
    ...meta, operationKey: key, createdAt: now }));
}
function paths(tripId: string, uid: string, id: string, key: string) {
  const store = db(), tripRef = store.doc(`trips/${tripId}`);
  return { store, tripRef, receiptRef: tripRef.collection('receipts').doc(id), opRef: store.doc(`users/${uid}/operations/${key}`),
    workflowRef: store.doc(`users/${uid}/receiptWorkflows/${key}`) };
}
export class ReceiptService {
  constructor(public storage: ReceiptStorage = process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID ? new VercelReceiptStorage() : new CloudReceiptStorage(),
    public imageProcessor: ReceiptImageProcessor = processReceiptImage) {}

  async createIntent(tripId: string, uid: string, key: string, input: z.infer<typeof receiptIntentInput>) {
    const id = randomUUID(), auditId = randomUUID(), { store, tripRef, opRef } = paths(tripId, uid, id, key);
    const command = { method: 'POST', canonicalPath: `/api/v1/trips/${tripId}/receipts/upload-intents`, body: input };
    const result = await store.runTransaction(async tx => {
      const [{ trip, user }, op] = await Promise.all([readTripActor(tx, tripRef, uid), readOperationSnapshot(tx, opRef)]);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      requireWritable(trip);
      let receipt: ReceiptDocument, receiptId: string = id;
      if (replay) {
        receiptId = z.uuid().parse(replay.responseSnapshot.data.id);
        receipt = readReceipt(await tx.get(tripRef.collection('receipts').doc(receiptId)), tripId);
        if (receipt.uploaderUid !== uid) return denied();
      } else receipt = createReceiptDocument(tripId, uid, id, input.contentType, Timestamp.now());
      if (receipt.status !== 'awaiting_upload' || receipt.expiresAt.toMillis() <= Date.now()) {
        throw new ApiError(409, 'UPLOAD_INTENT_EXPIRED', 'Lượt upload không còn hiệu lực. Hãy tạo lượt mới.');
      }
      const window = Math.floor(Date.now() / 3_600_000);
      const quotaId = createHash('sha256').update(`receipt-policy:${tripId}:${uid}:${window}`).digest('hex');
      const quotaRef = store.doc(`rateLimits/${quotaId}`), quota = await tx.get(quotaRef);
      const used = quota.exists ? quota.get('count') as number : 0;
      if (!Number.isSafeInteger(used) || used < 0 || used >= 10) {
        throw new ApiError(429, 'RECEIPT_UPLOAD_LIMIT', 'Bạn đã cấp đủ 10 lượt upload trong giờ này cho chuyến.');
      }
      const now = Timestamp.now();
      tx.set(quotaRef, { count: used + 1, expiresAt: Timestamp.fromMillis((window + 2) * 3_600_000) });
      if (replay) return { outcome: replay, replayed: true, receipt, id: receiptId };
      const meta = bump(tx, trip, now);
      tx.create(tripRef.collection('receipts').doc(id), receipt);
      audit(tx, trip, uid, user.get('displayName'), key, auditId, 'receipt.created', id, null, receipt, meta, now);
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'receipt', resourceId: id,
        httpStatus: 201, responseSnapshot: { data: receiptDto(id, receipt), meta }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false, receipt, id };
    });
    try {
      const policy = await this.storage.uploadPolicy(result.receipt.stagingPath, result.receipt.declaredContentType,
        MAX_RECEIPT_BYTES, Math.min(Date.now() + 5 * 60_000, result.receipt.expiresAt.toMillis()));
      return { ...result, outcome: { ...result.outcome, responseSnapshot: { ...result.outcome.responseSnapshot,
        data: { ...result.outcome.responseSnapshot.data, upload: policy } } } };
    } catch { throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Chưa cấp được quyền upload. Hãy retry cùng mã yêu cầu.'); }
  }

  async finalize(tripId: string, id: string, uid: string, key: string, expectedVersion: number) {
    const command: OperationCommand = { method: 'POST', canonicalPath: `/api/v1/trips/${tripId}/receipts/${id}/finalize`,
      body: {}, ifMatch: expectedVersion };
    const hash = operationRequestHash(command), attemptId = randomUUID(), auditId = randomUUID();
    const { store, tripRef, receiptRef, opRef, workflowRef } = paths(tripId, uid, id, key);
    const claim = await store.runTransaction(async tx => {
      const [{ trip }, op, snapshot, workflow] = await Promise.all([
        readTripActor(tx, tripRef, uid), tx.get(opRef), tx.get(receiptRef), tx.get(workflowRef),
      ]);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { result: { outcome: replay, replayed: true } };
      requireWritable(trip);
      const receipt = readReceipt(snapshot, tripId);
      if (receipt.uploaderUid !== uid) return denied();
      if (workflow.exists && workflow.get('requestHash') !== hash) return reused();
      if (workflow.exists && receipt.processingOperationKey !== key) return superseded();
      const continuation = workflow.exists && receipt.processingOperationKey === key;
      if (!continuation && receipt.version !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Ảnh đã thay đổi.');
      if (continuation && receipt.processingRequestHash !== hash) return reused();
      const now = Timestamp.now();
      if (receipt.status === 'processing' && receipt.processingLeaseUntil && receipt.processingLeaseUntil.toMillis() > now.toMillis()) return inProgress();
      if (receipt.status !== 'awaiting_upload' && receipt.status !== 'processing') {
        throw new ApiError(409, 'RECEIPT_NOT_FINALIZABLE', 'Ảnh không còn chờ xử lý. Nếu ảnh lỗi, hãy tạo lượt upload mới.');
      }
      if (receipt.status === 'awaiting_upload' && receipt.expiresAt.toMillis() <= now.toMillis() ||
          receipt.createdAt.toMillis() + DAY_MS <= now.toMillis()) {
        throw new ApiError(409, 'UPLOAD_INTENT_EXPIRED', 'Lượt upload đã hết hạn xử lý.');
      }
      const changes = { status: 'processing' as const, version: increment(receipt.version), updatedAt: now,
        processingAttemptId: attemptId, processingLeaseUntil: Timestamp.fromMillis(now.toMillis() + LEASE_MS),
        processingOperationKey: key, processingRequestHash: hash, processingBaseVersion: expectedVersion };
      tx.update(receiptRef, changes);
      tx.set(workflowRef, { requestHash: hash, tripId, receiptId: id, baseVersion: expectedVersion, attemptId,
        state: 'processing', leaseUntil: changes.processingLeaseUntil, updatedAt: now });
      bump(tx, trip, now);
      return { receipt: { ...receipt, ...changes } };
    });
    if (claim.result) return claim.result;
    const receipt = claim.receipt!;
    try {
      const source = await this.storage.metadata(receipt.stagingPath);
      if (!source.bytes || source.bytes > MAX_RECEIPT_BYTES || source.contentType !== receipt.declaredContentType) {
        throw new ApiError(422, 'INVALID_RECEIPT_IMAGE', 'Dung lượng hoặc loại ảnh upload không hợp lệ.');
      }
      const bytes = await this.storage.read(source.path, source.generation, MAX_RECEIPT_BYTES);
      if (bytes.length !== source.bytes) throw new ApiError(409, 'STORAGE_GENERATION_CHANGED', 'Ảnh upload đã thay đổi.');
      const processed = await this.imageProcessor(bytes, receipt.declaredContentType);
      const output = await this.storage.write(`${processedPrefix(tripId, id)}${attemptId}.jpg`, processed.buffer);
      const result = await store.runTransaction(async tx => {
        const [{ trip, user }, op, snapshot, workflow] = await Promise.all([
          readTripActor(tx, tripRef, uid), tx.get(opRef), tx.get(receiptRef), tx.get(workflowRef),
        ]);
        const replay = readOperationResult(op.data(), command, uid, tripId);
        if (replay) return { outcome: replay, replayed: true };
        requireWritable(trip);
        const current = readReceipt(snapshot, tripId), now = Timestamp.now();
        if (current.uploaderUid !== uid || current.status !== 'processing' || current.processingAttemptId !== attemptId ||
            current.processingOperationKey !== key || current.processingRequestHash !== hash || workflow.get('attemptId') !== attemptId ||
            !current.processingLeaseUntil || current.processingLeaseUntil.toMillis() <= now.toMillis()) return superseded();
        const changes = { status: 'ready' as const, version: increment(current.version), updatedAt: now,
          stagingGeneration: source.generation, processedPath: output.path, processedGeneration: output.generation,
          bytes: output.bytes, width: processed.width, height: processed.height, processingLeaseUntil: null };
        const ready = { ...current, ...changes }, meta = bump(tx, trip, now);
        tx.update(receiptRef, changes);
        tx.update(workflowRef, { state: 'committed', updatedAt: now });
        audit(tx, trip, uid, user.get('displayName'), key, auditId, 'receipt.finalized', id, current, ready, meta, now);
        const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'receipt', resourceId: id,
          httpStatus: 200, responseSnapshot: { data: receiptDto(id, ready), meta }, committedAt: now });
        tx.create(opRef, outcome);
        return { outcome, replayed: false };
      });
      try { await this.storage.delete(source.path, source.generation); }
      catch {
        await store.doc(`maintenanceJobs/receipt-staging-${tripId}-${id}`).set({ kind: 'receipt_staging_cleanup', status: 'pending',
          receiptPath: receiptRef.path, updatedAt: Timestamp.now() });
      }
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        await store.runTransaction(async tx => {
          const snapshot = await tx.get(receiptRef), trip = await tx.get(tripRef), current = readReceipt(snapshot, tripId);
          if (current.status !== 'processing' || current.processingAttemptId !== attemptId ||
              !current.processingLeaseUntil || current.processingLeaseUntil.toMillis() <= Date.now()) return;
          const now = Timestamp.now();
          tx.update(receiptRef, { status: 'failed', version: increment(current.version), updatedAt: now,
            processingLeaseUntil: null, cleanupAfter: now });
          tx.update(workflowRef, { state: 'failed', updatedAt: now });
          bump(tx, trip, now);
        });
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'RECEIPT_PROCESSING_FAILED', 'Xử lý ảnh tạm thời thất bại. Hãy retry cùng mã yêu cầu sau khi lease hết.');
    }
  }

  async viewUrl(tripId: string, id: string, uid: string) {
    const store = db(), tripRef = store.doc(`trips/${tripId}`);
    const receipt = await store.runTransaction(async tx => {
      await readTripActor(tx, tripRef, uid);
      const data = readReceipt(await tx.get(tripRef.collection('receipts').doc(id)), tripId);
      if (data.status !== 'attached' && !(data.status === 'ready' && data.uploaderUid === uid)) return denied();
      if (!data.processedPath || !data.processedGeneration || data.storageDeletedAt) throw new ApiError(409, 'RECEIPT_NOT_READY', 'Ảnh chưa sẵn sàng.');
      if (data.status === 'attached') {
        const collection = data.attachedSettlementId ? 'settlements' : data.attachedParticipantId ? 'participants' : 'expenses';
        const targetId = data.attachedSettlementId ?? data.attachedParticipantId ?? data.attachedExpenseId!;
        const target = await tx.get(tripRef.collection(collection).doc(targetId));
        const claimed = collection === 'participants' ? target.get('paymentQrReceiptId') === id :
          Array.isArray(target.get('receiptIds')) && target.get('receiptIds').includes(id);
        if (!target.exists || !claimed) throw new ApiError(409, 'RECEIPT_CLAIM_CONFLICT', 'Liên kết ảnh không hợp lệ.');
        if (collection === 'participants' && target.get('linkedUid') !== data.uploaderUid) return denied();
        if (collection === 'settlements') {
          const membership = await tx.get(tripRef.collection('memberships').doc(uid));
          if (![target.get('fromParticipantId'), target.get('toParticipantId')].includes(membership.get('participantId'))) return denied();
        }
      }
      return data;
    }, { readOnly: true });
    const expiresAt = Date.now() + 60_000;
    try { return { id, url: await this.storage.viewUrl(receipt.processedPath!, receipt.processedGeneration!, expiresAt),
      expiresAt: new Date(expiresAt).toISOString() }; }
    catch { throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Chưa cấp được quyền xem ảnh.'); }
  }

  async discard(tripId: string, id: string, uid: string, key: string, expectedVersion: number) {
    const command = { method: 'POST', canonicalPath: `/api/v1/trips/${tripId}/receipts/${id}/discard`, body: {}, ifMatch: expectedVersion };
    const { store, tripRef, receiptRef, opRef } = paths(tripId, uid, id, key), auditId = randomUUID();
    return store.runTransaction(async tx => {
      const [{ trip, member, user }, op, snapshot] = await Promise.all([readTripActor(tx, tripRef, uid), readOperationSnapshot(tx, opRef), tx.get(receiptRef)]);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      requireWritable(trip);
      const receipt = readReceipt(snapshot, tripId);
      if (receipt.uploaderUid !== uid && member.get('role') !== 'owner') return denied();
      if (receipt.version !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Ảnh đã thay đổi.');
      if (receipt.status === 'attached') throw new ApiError(409, 'RECEIPT_ATTACHED', 'Ảnh đang được sử dụng và không thể xóa trực tiếp.');
      if (receipt.status === 'discarded') throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Ảnh đã được loại bỏ.');
      const now = Timestamp.now(), changes = { status: 'discarded' as const, version: increment(receipt.version), updatedAt: now,
        discardedAt: now, cleanupAfter: Timestamp.fromMillis(now.toMillis() + DISCARD_GRACE_MS), processingLeaseUntil: null };
      const discarded = { ...receipt, ...changes }, meta = bump(tx, trip, now);
      tx.update(receiptRef, changes);
      audit(tx, trip, uid, user.get('displayName'), key, auditId, 'receipt.discarded', id, receipt, discarded, meta, now);
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'receipt', resourceId: id,
        httpStatus: 200, responseSnapshot: { data: receiptDto(id, discarded), meta }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
  }
}
