import { Timestamp } from 'firebase-admin/firestore';
import type { Balance } from '../domain/money.js';

export type ParticipantCreateData = {
  participantId: string;
  displayName: string;
  createdBy: string;
  linkedUid: string | null;
  now: Timestamp;
};

/** A participant and their initial balance must be committed together. */
export function createParticipantDocuments(input: ParticipantCreateData) {
  const { participantId, displayName, createdBy, linkedUid, now } = input;
  const participant = {
    schemaVersion: 1, id: participantId, displayName, linkedUid,
    status: 'active', version: 1, hasLedgerReferences: false, createdBy,
    createdAt: now, updatedAt: now,
  } as const;
  const balance: Balance & { schemaVersion: 1; updatedAt: Timestamp } = {
    schemaVersion: 1, participantId, paidMinor: 0, owedMinor: 0, sentMinor: 0, receivedMinor: 0,
    netMinor: 0, updatedAt: now,
  };
  return { participant, balance };
}
