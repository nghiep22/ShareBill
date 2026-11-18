import type { DocumentReference, DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { ApiError, requireTripAccess } from '../http.js';

export async function readTripActor(tx: Transaction, tripRef: DocumentReference, uid: string) {
  const store = tripRef.firestore;
  const [trip, member, user] = await Promise.all([
    tx.get(tripRef), tx.get(tripRef.collection('memberships').doc(uid)), tx.get(store.doc(`users/${uid}`)),
  ]);
  requireTripAccess(member, trip);
  requireActiveProfile(user);
  return { trip, member, user };
}
export function requireActiveProfile(user: DocumentSnapshot) {
  if (!user.exists || user.get('status') !== 'active') {
    throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản chưa sẵn sàng hoặc đang tạm khóa.');
  }
}
export function requireOwner(trip: DocumentSnapshot, member: DocumentSnapshot) {
  if (trip.get('ownerUid') !== member.id || member.get('role') !== 'owner') {
    throw new ApiError(403, 'FORBIDDEN', 'Chỉ chủ chuyến được thực hiện.');
  }
}
export function requireWritable(trip: DocumentSnapshot) {
  if (trip.get('status') !== 'active' || trip.get('moderationStatus') !== 'normal') {
    throw new ApiError(409, 'TRIP_NOT_WRITABLE', 'Chuyến đi đang khóa thao tác.');
  }
}
export function increment(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new ApiError(409, 'TRIP_INVARIANT_FAILED', 'Phiên bản dữ liệu không hợp lệ.');
  }
  return value + 1;
}
