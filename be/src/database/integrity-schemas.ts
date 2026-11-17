import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { EXPENSE_CATEGORIES } from '../domain/money.js';
import { expenseDocumentSchema } from './expense.js';
import { settlementDocumentSchema } from './settlement.js';

const v1 = z.literal(1);
const version = z.int().positive();
const count = z.int().nonnegative();
const timestamp = z.instanceof(Timestamp);
const membershipStatus = z.enum(['active', 'removed']);
export const entityId = z.uuid();
export const uid = z.string().min(1).max(128).regex(/^[^/]+$/);

export const tripSchema = z.strictObject({
  schemaVersion: v1, id: entityId, name: z.string().min(1).max(100), destination: z.string().max(150).nullable(),
  note: z.string().max(1000).nullable(), startDate: z.iso.date().nullable(), endDate: z.iso.date().nullable(),
  timezone: z.string().refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }),
  currency: z.literal('VND'), currencyExponent: z.literal(0), ownerUid: uid, createdBy: uid,
  status: z.enum(['active', 'archived']), moderationStatus: z.enum(['normal', 'suspended']),
  moderationVersion: version, moderationReason: z.string().max(500).nullable(), moderatedAt: timestamp.nullable(), moderatedBy: uid.nullable(),
  inviteEpoch: version, version, revision: version, ledgerVersion: count,
  participantCount: version.max(50), membershipCountAllTime: version.max(50),
  expenseCountAllTime: count.max(2000), settlementCountAllTime: count.max(2000),
  activeExpenseCount: count, pendingSettlementCount: count, totalExpenseMinor: count,
  categoryTotalsMinor: z.record(z.enum(EXPENSE_CATEGORIES), count),
  createdAt: timestamp, updatedAt: timestamp, archivedAt: timestamp.nullable(),
}).refine(trip => !trip.startDate || !trip.endDate || trip.startDate <= trip.endDate, { path: ['endDate'] });

export const membershipSchema = z.strictObject({
  schemaVersion: v1, uid, role: z.enum(['owner', 'member']), status: membershipStatus,
  participantId: entityId.nullable(), version, joinedAt: timestamp, updatedAt: timestamp, removedAt: timestamp.nullable(),
}).refine(member => (member.status === 'removed') === (member.removedAt !== null), { path: ['removedAt'] });

export const participantSchema = z.strictObject({
  schemaVersion: v1, id: entityId, displayName: z.string().min(1).max(80), linkedUid: uid.nullable(),
  status: z.enum(['active', 'inactive']), version, hasLedgerReferences: z.boolean(), createdBy: uid,
  createdAt: timestamp, updatedAt: timestamp,
});

export const participantLinkSchema = z.strictObject({ schemaVersion: v1, uid, participantId: entityId, updatedAt: timestamp });
export const tripRefSchema = z.strictObject({
  schemaVersion: v1, tripId: entityId, status: membershipStatus, joinedAt: timestamp, updatedAt: timestamp,
});
export const balanceSchema = z.strictObject({
  schemaVersion: v1, participantId: entityId, paidMinor: count, owedMinor: count,
  sentMinor: count, receivedMinor: count, netMinor: z.int(), updatedAt: timestamp,
});
export const signalSchema = z.strictObject({ schemaVersion: v1, revision: version, ledgerVersion: count, updatedAt: timestamp });

export const receiptSchema = z.strictObject({
  schemaVersion: v1, tripId: entityId, uploaderUid: uid,
  status: z.enum(['awaiting_upload', 'processing', 'ready', 'attached', 'discarded', 'failed']),
  declaredContentType: z.enum(['image/jpeg', 'image/png', 'image/webp']), maxBytes: z.literal(5 * 1024 * 1024),
  expiresAt: timestamp, stagingPath: z.string().min(1), stagingGeneration: z.string().min(1).nullable(),
  processedPath: z.string().min(1).nullable(), processedGeneration: z.string().min(1).nullable(),
  bytes: version.nullable(), width: version.nullable(), height: version.nullable(),
  attachedExpenseId: entityId.nullable(), processingLeaseUntil: timestamp.nullable(), processingAttemptId: entityId.nullable(),
  processingOperationKey: entityId.nullable(), processingRequestHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  processingBaseVersion: version.nullable(), version, createdAt: timestamp, updatedAt: timestamp,
  discardedAt: timestamp.nullable(), cleanupAfter: timestamp.nullable(), storageDeletedAt: timestamp.nullable(),
});

// The financial fields also let the checker reconcile legacy documents that only lack metadata.
export const expenseLedgerSchema = z.object({
  amountMinor: expenseDocumentSchema.shape.amountMinor, status: expenseDocumentSchema.shape.status,
  payerParticipantId: expenseDocumentSchema.shape.payerParticipantId, shares: expenseDocumentSchema.shape.shares,
  category: expenseDocumentSchema.shape.category,
});
export const settlementLedgerSchema = z.object({
  amountMinor: settlementDocumentSchema.shape.amountMinor, status: settlementDocumentSchema.shape.status,
  fromParticipantId: settlementDocumentSchema.shape.fromParticipantId, toParticipantId: settlementDocumentSchema.shape.toParticipantId,
}).refine(settlement => settlement.fromParticipantId !== settlement.toParticipantId, { path: ['toParticipantId'] });
