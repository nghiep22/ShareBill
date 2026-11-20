import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { ApiError } from '../http.js';

/** Restore/transfer may retain an identity only when all three stored directions agree. */
export async function requireConsistentIdentity(tx: Transaction, tripRef: DocumentReference,
  uid: string, participantId: string | null) {
  const [link, participant] = await Promise.all([
    tx.get(tripRef.collection('participantLinks').doc(uid)),
    participantId ? tx.get(tripRef.collection('participants').doc(participantId)) : Promise.resolve(null),
  ]);
  if (participantId ? !participant?.exists || participant.get('linkedUid') !== uid ||
      link.get('uid') !== uid || link.get('participantId') !== participantId : link.exists) {
    throw new ApiError(409, 'LINK_INVARIANT_FAILED', 'Liên kết hiện tại không đồng nhất. Chủ chuyến cần xử lý liên kết.');
  }
}
