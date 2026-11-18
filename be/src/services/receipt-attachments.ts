import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { ApiError } from '../http.js';
import { createAuditEvent } from '../database/audit.js';
import { DISCARD_GRACE_MS, readReceipt, receiptAudit, type ReceiptDocument } from '../database/receipt.js';

type AttachmentPlan = { ref: DocumentReference; before: ReceiptDocument; after: ReceiptDocument;
  patch: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>; action: 'receipt.attached' | 'receipt.discarded' };

export async function planReceiptAttachments(tx: Transaction, tripRef: DocumentReference, expenseId: string,
  actorUid: string, receiptIds: string[], previousIds: string[], now: Timestamp) {
  if (receiptIds.length > 3 || new Set(receiptIds).size !== receiptIds.length) {
    throw new ApiError(422, 'INVALID_RECEIPTS', 'Chọn tối đa ba ảnh khác nhau.');
  }
  const ids = [...new Set([...previousIds, ...receiptIds])];
  const snapshots = await Promise.all(ids.map(id => tx.get(tripRef.collection('receipts').doc(id))));
  return snapshots.flatMap<AttachmentPlan>(snapshot => {
    const before = readReceipt(snapshot, tripRef.id), keep = receiptIds.includes(snapshot.id), wasAttached = previousIds.includes(snapshot.id);
    if (wasAttached) {
      if (before.status !== 'attached' || before.attachedExpenseId !== expenseId) {
        throw new ApiError(409, 'RECEIPT_CLAIM_CONFLICT', 'Liên kết ảnh không còn hợp lệ.');
      }
      if (keep) return [];
      const patch = { status: 'discarded' as const, attachedExpenseId: null, version: before.version + 1,
        discardedAt: now, cleanupAfter: Timestamp.fromMillis(now.toMillis() + DISCARD_GRACE_MS), updatedAt: now };
      return [{ ref: snapshot.ref, before, after: { ...before, ...patch }, patch, action: 'receipt.discarded' as const }];
    }
    if (before.status !== 'ready' || before.uploaderUid !== actorUid || !before.processedPath || !before.processedGeneration ||
        before.attachedExpenseId !== null || before.storageDeletedAt !== null) {
      throw new ApiError(409, 'RECEIPT_NOT_ATTACHABLE', 'Ảnh chưa sẵn sàng, đã được dùng hoặc không do bạn upload.');
    }
    const patch = { status: 'attached' as const, attachedExpenseId: expenseId, version: before.version + 1, updatedAt: now };
    return [{ ref: snapshot.ref, before, after: { ...before, ...patch }, patch, action: 'receipt.attached' as const }];
  });
}
export function applyReceiptAttachments(tx: Transaction, tripRef: DocumentReference,
  plans: AttachmentPlan[],
  context: { uid: string; displayName: unknown; key: string; auditIds: string[]; revision: number; ledgerVersion: number; now: Timestamp }) {
  plans.forEach((plan, i) => {
    tx.update(plan.ref, plan.patch);
    const id = context.auditIds[i]!;
    tx.create(tripRef.collection('auditEvents').doc(id), createAuditEvent({ eventId: id, actorUid: context.uid,
      actorDisplayNameSnapshot: context.displayName, action: plan.action, entityType: 'receipt', entityId: plan.ref.id,
      before: receiptAudit(plan.ref.id, plan.before), after: receiptAudit(plan.ref.id, plan.after), reason: null,
      revision: context.revision, ledgerVersion: context.ledgerVersion, operationKey: context.key, createdAt: context.now }));
  });
}
