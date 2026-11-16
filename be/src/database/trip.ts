import { Timestamp } from 'firebase-admin/firestore';
import { createParticipantDocuments } from './participant.js';

const categories = ['food', 'transport', 'stay', 'tickets', 'shopping', 'other'] as const;

export type TripCreateData = {
  tripId: string;
  participantId: string;
  auditEventId: string;
  ownerUid: string;
  ownerName: string;
  name: string;
  operationKey: string;
  now: Timestamp;
};

/** Documents created together when the first owner starts a trip. */
export function createTripDocuments(input: TripCreateData) {
  const { tripId, participantId, auditEventId, ownerUid, ownerName, name, operationKey, now } = input;
  const categoryTotalsMinor = Object.fromEntries(categories.map(category => [category, 0])) as Record<(typeof categories)[number], number>;
  const trip = {
    schemaVersion: 1, id: tripId, name, destination: null, note: null, startDate: null, endDate: null,
    timezone: 'Asia/Ho_Chi_Minh', currency: 'VND', currencyExponent: 0,
    ownerUid, createdBy: ownerUid, status: 'active', moderationStatus: 'normal', moderationVersion: 1,
    moderationReason: null, moderatedAt: null, moderatedBy: null, inviteEpoch: 1,
    version: 1, revision: 1, ledgerVersion: 0, participantCount: 1, membershipCountAllTime: 1,
    expenseCountAllTime: 0, activeExpenseCount: 0, settlementCountAllTime: 0, pendingSettlementCount: 0,
    totalExpenseMinor: 0, categoryTotalsMinor, createdAt: now, updatedAt: now, archivedAt: null,
  } as const;
  const membership = {
    schemaVersion: 1, uid: ownerUid, role: 'owner', status: 'active', participantId,
    version: 1, joinedAt: now, updatedAt: now, removedAt: null,
  } as const;
  const { participant, balance } = createParticipantDocuments({
    participantId, displayName: ownerName, createdBy: ownerUid, linkedUid: ownerUid, now,
  });
  const participantLink = { schemaVersion: 1, uid: ownerUid, participantId, updatedAt: now } as const;
  const signal = { schemaVersion: 1, revision: 1, ledgerVersion: 0, updatedAt: now } as const;
  const tripRef = { schemaVersion: 1, tripId, status: 'active', joinedAt: now, updatedAt: now } as const;
  const audit = {
    schemaVersion: 1, eventId: auditEventId, actorUid: ownerUid, actorDisplayNameSnapshot: ownerName,
    action: 'trip.created', entityType: 'trip', entityId: tripId, before: null,
    after: { name, ownerUid, status: 'active', version: 1 }, reason: null,
    revision: 1, ledgerVersion: 0, operationKey, createdAt: now,
  } as const;
  return { trip, membership, participant, participantLink, balance, signal, tripRef, audit };
}
