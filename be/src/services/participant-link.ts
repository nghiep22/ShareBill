import type { Transaction, DocumentSnapshot, DocumentReference } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { ApiError } from '../http.js';

export type ParticipantLinkPlan = {
  previous: DocumentSnapshot | null;
  target: DocumentSnapshot | null;
  memberChanges: { participantId: string | null; version: number; updatedAt: Timestamp };
  previousChanges: { linkedUid: null; version: number; updatedAt: Timestamp } | null;
  targetChanges: { linkedUid: string; version: number; updatedAt: Timestamp } | null;
  linkRef: DocumentReference;
};

/** Reads all three identity directions before any write in the caller's transaction. */
export async function planParticipantLink(input: {
  tx: Transaction; tripRef: DocumentReference; member: DocumentSnapshot;
  targetUid: string; participantId: string | null; now: Timestamp;
}): Promise<ParticipantLinkPlan> {
  const { tx, tripRef, member, targetUid, participantId, now } = input;
  const oldId = member.get('participantId') as string | null;
  const linkRef = tripRef.collection('participantLinks').doc(targetUid);
  const previousRef = oldId ? tripRef.collection('participants').doc(oldId) : null;
  const targetRef = participantId ? tripRef.collection('participants').doc(participantId) : null;
  const [link, previous, target] = await Promise.all([
    tx.get(linkRef), previousRef ? tx.get(previousRef) : Promise.resolve(null),
    targetRef && targetRef.path !== previousRef?.path ? tx.get(targetRef) : Promise.resolve(null),
  ]);
  if (participantId === oldId) throw new ApiError(409, 'LINK_UNCHANGED', 'Liên kết đã ở trạng thái này.');
  if (oldId ? !link.exists || link.get('uid') !== targetUid || link.get('participantId') !== oldId ||
      !previous?.exists || previous.get('linkedUid') !== targetUid : link.exists) {
    throw new ApiError(409, 'LINK_INVARIANT_FAILED', 'Liên kết hiện tại không đồng nhất.');
  }
  if (participantId && (!target?.exists || target.get('linkedUid') !== null)) {
    throw new ApiError(409, 'PARTICIPANT_ALREADY_LINKED', 'Người này đã được liên kết hoặc không tồn tại.');
  }
  const version = member.get('version');
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ApiError(409, 'LINK_INVARIANT_FAILED', 'Phiên bản liên kết không hợp lệ.');
  }
  return {
    previous, target, linkRef,
    memberChanges: { participantId, version: version + 1, updatedAt: now },
    previousChanges: previous ? { linkedUid: null, version: previous.get('version') + 1, updatedAt: now } : null,
    targetChanges: target ? { linkedUid: targetUid, version: target.get('version') + 1, updatedAt: now } : null,
  };
}
