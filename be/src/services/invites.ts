import { createHash, randomBytes } from 'node:crypto';
import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { ApiError } from '../http.js';

export const inviteDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1), createdBy: z.string().min(1).max(128).regex(/^[^/]+$/),
  createdAt: z.instanceof(Timestamp), expiresAt: z.instanceof(Timestamp),
  maxUses: z.int().min(1).max(20), usedCount: z.int().nonnegative(),
  revokedAt: z.instanceof(Timestamp).nullable(), version: z.int().positive(), epoch: z.int().positive(),
}).refine(value => value.usedCount <= value.maxUses && value.expiresAt.toMillis() > value.createdAt.toMillis());
export const inviteLookupSchema = z.strictObject({
  schemaVersion: z.literal(1), tripId: z.uuid(), inviteId: z.uuid(),
  expiresAt: z.instanceof(Timestamp), createdAt: z.instanceof(Timestamp),
});
export type InviteDocument = z.infer<typeof inviteDocumentSchema>;

export function inviteTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function newInviteToken(): string { return randomBytes(32).toString('base64url'); }
export function unavailableInvite(): never {
  throw new ApiError(404, 'INVITE_UNAVAILABLE', 'Lời mời không còn hiệu lực hoặc không tồn tại.');
}

/** Resolves and validates the capability without storing or returning its raw token. */
export async function resolveInvite(tx: Transaction, store: FirebaseFirestore.Firestore, token: string) {
  const lookup = inviteLookupSchema.safeParse((await tx.get(store.doc(`inviteTokens/${inviteTokenHash(token)}`))).data());
  if (!lookup.success) return unavailableInvite();
  const tripRef = store.doc(`trips/${lookup.data.tripId}`);
  const [trip, invite] = await Promise.all([
    tx.get(tripRef), tx.get(tripRef.collection('invites').doc(lookup.data.inviteId)),
  ]);
  const parsed = inviteDocumentSchema.safeParse(invite.data());
  // Recheck time on each attempt rather than using the original request time.
  const now = Date.now();
  if (!trip.exists || !parsed.success || lookup.data.expiresAt.toMillis() <= now ||
      lookup.data.expiresAt.toMillis() !== parsed.data.expiresAt.toMillis() || parsed.data.expiresAt.toMillis() <= now ||
      parsed.data.revokedAt !== null || parsed.data.epoch !== trip.get('inviteEpoch') ||
      trip.get('status') !== 'active' || trip.get('moderationStatus') !== 'normal') return unavailableInvite();
  return { trip, tripRef, invite, data: parsed.data };
}

export function inviteDto(id: string, data: InviteDocument, epoch: number, now = Date.now()) {
  return { id, createdBy: data.createdBy, createdAt: data.createdAt.toDate().toISOString(),
    expiresAt: data.expiresAt.toDate().toISOString(), maxUses: data.maxUses, usedCount: data.usedCount,
    revokedAt: data.revokedAt?.toDate().toISOString() ?? null, version: data.version,
    status: data.revokedAt ? 'revoked' : data.epoch !== epoch ? 'invalidated' :
      data.expiresAt.toMillis() <= now ? 'expired' : data.usedCount >= data.maxUses ? 'exhausted' : 'active' };
}
