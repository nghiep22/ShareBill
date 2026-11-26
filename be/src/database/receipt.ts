import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { receiptSchema } from './integrity-schemas.js';
import { ApiError } from '../http.js';

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
export const MAX_PROCESSED_BYTES = 2 * 1024 * 1024;
export const DAY_MS = 86_400_000;
export const LEASE_MS = 2 * 60_000;
export const DISCARD_GRACE_MS = 7 * DAY_MS;
export const receiptIntentInput = z.strictObject({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  bytes: z.int().min(1).max(MAX_RECEIPT_BYTES),
});
export type ReceiptDocument = z.infer<typeof receiptSchema>;
export function stagingPrefix(tripId: string, uid: string, id: string) {
  return `receipt-staging/${tripId}/${uid}/${id}/`;
}
export function processedPrefix(tripId: string, id: string) { return `receipt-processed/${tripId}/${id}/`; }
export function readReceipt(snapshot: FirebaseFirestore.DocumentSnapshot, tripId: string): ReceiptDocument {
  if (!snapshot.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy ảnh hóa đơn.');
  const parsed = receiptSchema.safeParse(snapshot.data());
  if (!parsed.success || parsed.data.tripId !== tripId ||
      parsed.data.stagingPath !== `${stagingPrefix(tripId, parsed.data.uploaderUid, snapshot.id)}original` ||
      parsed.data.processedPath !== null && (!parsed.data.processingAttemptId ||
        parsed.data.processedPath !== `${processedPrefix(tripId, snapshot.id)}${parsed.data.processingAttemptId}.jpg`)) {
    throw new ApiError(409, 'RECEIPT_INVARIANT_FAILED', 'Dữ liệu ảnh hóa đơn chưa hợp lệ.');
  }
  return parsed.data;
}
export function createReceiptDocument(tripId: string, uid: string, id: string,
  contentType: ReceiptDocument['declaredContentType'], now: Timestamp): ReceiptDocument {
  return receiptSchema.parse({ schemaVersion: 1, tripId, uploaderUid: uid, status: 'awaiting_upload',
    declaredContentType: contentType, maxBytes: MAX_RECEIPT_BYTES, expiresAt: Timestamp.fromMillis(now.toMillis() + 15 * 60_000),
    stagingPath: `${stagingPrefix(tripId, uid, id)}original`, stagingGeneration: null,
    processedPath: null, processedGeneration: null, bytes: null, width: null, height: null, attachedExpenseId: null,
    processingLeaseUntil: null, processingAttemptId: null, processingOperationKey: null, processingRequestHash: null,
    processingBaseVersion: null, version: 1, createdAt: now, updatedAt: now,
    discardedAt: null, cleanupAfter: null, storageDeletedAt: null });
}
export function receiptDto(id: string, data: ReceiptDocument) {
  return { id, tripId: data.tripId, status: data.status, version: data.version, contentType: data.declaredContentType,
    expiresAt: data.expiresAt.toDate().toISOString(), bytes: data.bytes, width: data.width, height: data.height,
    attachedExpenseId: data.attachedExpenseId, attachedSettlementId: data.attachedSettlementId, attachedParticipantId: data.attachedParticipantId };
}
export function receiptAudit(id: string, data: ReceiptDocument) {
  return { id, status: data.status, version: data.version, attachedExpenseId: data.attachedExpenseId,
    attachedSettlementId: data.attachedSettlementId, attachedParticipantId: data.attachedParticipantId };
}
