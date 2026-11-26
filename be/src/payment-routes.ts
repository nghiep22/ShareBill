import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from './firebase.js';
import { ApiError, operationKey, requireUser, requireVersion, sendOperationResult } from './http.js';
import { createOperationDocument, readOperationResult, readOperationSnapshot } from './database/operation.js';
import { applyReceiptAttachments, planReceiptAttachments } from './services/receipt-attachments.js';
import { increment, readTripActor, requireWritable } from './services/trip-access.js';

const params = z.strictObject({ tripId: z.uuid(), id: z.uuid() });
const body = z.strictObject({ receiptId: z.uuid().nullable() });

export async function registerPaymentRoutes(app: FastifyInstance) {
  app.patch('/api/v1/trips/:tripId/participants/:id/payment-qr', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request);
    const path = params.safeParse(request.params), input = body.safeParse(request.body);
    if (!path.success) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thành viên.');
    if (!input.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Chọn ảnh QR hợp lệ.');
    const { tripId, id } = path.data, expectedVersion = requireVersion(request.headers['if-match']);
    const command = { method: 'PATCH', canonicalPath: `/api/v1/trips/${tripId}/participants/${id}/payment-qr`,
      body: input.data, ifMatch: expectedVersion };
    const store = db(), tripRef = store.doc(`trips/${tripId}`), personRef = tripRef.collection('participants').doc(id);
    const opRef = store.doc(`users/${uid}/operations/${key}`), auditIds = [randomUUID(), randomUUID()];
    const result = await store.runTransaction(async tx => {
      const [{ trip, member, user }, person, op] = await Promise.all([
        readTripActor(tx, tripRef, uid), tx.get(personRef), readOperationSnapshot(tx, opRef),
      ]);
      const replay = readOperationResult(op.data(), command, uid, tripId);
      if (replay) return { outcome: replay, replayed: true };
      requireWritable(trip);
      if (!person.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thành viên.');
      if (member.get('participantId') !== id || person.get('linkedUid') !== uid) {
        throw new ApiError(403, 'FORBIDDEN', 'Bạn chỉ được cập nhật QR nhận tiền của mình.');
      }
      if (person.get('version') !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'Thông tin thành viên đã thay đổi. Hãy tải lại.');
      const now = Timestamp.now(), previous = person.get('paymentQrReceiptId') as string | undefined;
      const plans = await planReceiptAttachments(tx, tripRef, id, uid, input.data.receiptId ? [input.data.receiptId] : [],
        previous ? [previous] : [], now, 'attachedParticipantId');
      const revision = increment(trip.get('revision')), ledgerVersion = trip.get('ledgerVersion') as number;
      applyReceiptAttachments(tx, tripRef, plans, { uid, displayName: user.get('displayName'), key, auditIds, revision, ledgerVersion, now });
      const response = { id, paymentQrReceiptId: input.data.receiptId, version: increment(expectedVersion) };
      tx.update(personRef, { paymentQrReceiptId: response.paymentQrReceiptId, version: response.version, updatedAt: now });
      tx.update(tripRef, { revision, updatedAt: now });
      tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
      const outcome = createOperationDocument(command, { actorUid: uid, tripId, resourceType: 'participant', resourceId: id,
        httpStatus: 200, responseSnapshot: { data: response, meta: { revision, ledgerVersion } }, committedAt: now });
      tx.create(opRef, outcome);
      return { outcome, replayed: false };
    });
    return sendOperationResult(reply, result);
  });
}
