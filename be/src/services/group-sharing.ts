import { randomUUID } from 'node:crypto';
import { Timestamp, type DocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { balanceSchema, membershipSchema, participantSchema } from '../database/integrity-schemas.js';
import { createParticipantDocuments } from '../database/participant.js';
import { equalGroupBalances, type Balance } from '../domain/money.js';
import { ApiError } from '../http.js';

export const isGroupEqual = (trip: DocumentSnapshot) => trip.get('sharingMode') === 'group-equal';
function invariant(): never { throw new ApiError(409, 'GROUP_SHARING_INVARIANT_FAILED', 'Dữ liệu chia đều của nhóm chưa đồng nhất.'); }

/** Read at most 50 people and their projection. Never scan or rewrite expense history. */
export async function readGroupLedger(tx: Transaction, trip: DocumentSnapshot) {
  const [people, balances] = await Promise.all([
    tx.get(trip.ref.collection('participants').limit(51)), tx.get(trip.ref.collection('balances').limit(51)),
  ]);
  if (people.size > 50 || people.size !== trip.get('participantCount') || balances.size !== people.size) return invariant();
  const participants = new Map(people.docs.map(doc => {
    const value = participantSchema.safeParse(doc.data());
    if (!value.success || value.data.id !== doc.id) return invariant();
    return [doc.id, value.data] as const;
  }));
  const rows = balances.docs.map(doc => {
    const value = balanceSchema.safeParse(doc.data());
    if (!value.success || value.data.participantId !== doc.id || !participants.has(doc.id) ||
        value.data.netMinor !== value.data.paidMinor - value.data.owedMinor + value.data.sentMinor - value.data.receivedMinor) return invariant();
    return value.data;
  });
  const total = trip.get('totalExpenseMinor');
  if (!Number.isSafeInteger(total) || total < 0 || rows.reduce((sum, row) => sum + BigInt(row.paidMinor), 0n) !== BigInt(total) ||
      rows.reduce((sum, row) => sum + BigInt(row.owedMinor), 0n) !== BigInt(total) ||
      rows.reduce((sum, row) => sum + BigInt(row.sentMinor) - BigInt(row.receivedMinor), 0n) !== 0n) return invariant();
  const ids = isGroupEqual(trip) ? trip.get('equalParticipantIds') as string[] : [];
  if (isGroupEqual(trip)) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || new Set(ids).size !== ids.length ||
        ids.some(id => !participants.has(id) || participants.get(id)!.status !== 'active' || !participants.get(id)!.linkedUid)) return invariant();
    const expected = equalGroupBalances(rows, total, ids);
    if (expected.some((row, index) => row.owedMinor !== rows[index]!.owedMinor)) return invariant();
  }
  return { participants, rows, ids };
}
export type GroupLedger = Awaited<ReturnType<typeof readGroupLedger>>;

export function projectGroup(state: GroupLedger, total: number, ids = state.ids, paidDeltas = new Map<string, number>(), allocatedDeltas = new Map<string, number>()) {
  try { return equalGroupBalances(state.rows, total, ids, paidDeltas, allocatedDeltas); } catch { return invariant(); }
}

export function allocatedExpenseDelta(previous?: { sharingScope?: string; shares: { participantId: string; amountMinor: number }[] }, next?: { sharingScope?: string; shares: { participantId: string; amountMinor: number }[] }) {
  const result = new Map<string, number>();
  for (const [expense, sign] of [[previous, -1], [next, 1]] as const) if (expense?.sharingScope === 'selected') {
    for (const share of expense.shares) result.set(share.participantId, (result.get(share.participantId) ?? 0) + sign * share.amountMinor);
  }
  return result;
}
export function writeGroupBalances(tx: Transaction, trip: DocumentSnapshot, rows: Balance[], now: Timestamp) {
  for (const row of rows) tx.set(trip.ref.collection('balances').doc(row.participantId), { schemaVersion: 1, ...row, updatedAt: now });
}

/** Assign a new identity, never infer identity from a display name. Caller writes after every read has finished. */
export function enrollGroupMember(state: GroupLedger, uid: string, displayName: string, createdBy: string, now: Timestamp) {
  if (state.participants.size >= 50) throw new ApiError(422, 'TRIP_LIMIT_REACHED', 'Nhóm đã đạt giới hạn 50 người, gồm cả tên lưu trong lịch sử.');
  const participantId = randomUUID();
  const initial = createParticipantDocuments({ participantId, displayName, linkedUid: uid, createdBy, now });
  state.participants.set(participantId, initial.participant);
  state.rows.push({ ...initial.balance, schemaVersion: 1 });
  return { participantId, ...initial,
    link: { schemaVersion: 1, uid, participantId, updatedAt: now } };
}

export async function readGroupMemberships(tx: Transaction, trip: DocumentSnapshot) {
  const members = await tx.get(trip.ref.collection('memberships').limit(51));
  if (members.size > 50 || members.size !== trip.get('membershipCountAllTime')) return invariant();
  return members.docs.map(doc => {
    const value = membershipSchema.safeParse(doc.data());
    if (!value.success || value.data.uid !== doc.id) return invariant();
    return { ref: doc.ref, ...value.data };
  });
}
