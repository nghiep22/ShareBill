import type { UserRecord } from 'firebase-admin/auth';
import { Timestamp } from 'firebase-admin/firestore';
import { createUserDocument } from '../database/user.js';
import { db } from '../firebase.js';
import { ApiError } from '../http.js';

export type UserProfile = { uid: string; email: string | null; displayName: string; status: 'active' };

function toProfile(uid: string, value: FirebaseFirestore.DocumentData, identity: UserRecord): UserProfile {
  if (value.status !== 'active' || identity.disabled) {
    throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
  }
  const displayName = typeof value.displayName === 'string' && value.displayName.trim()
    ? value.displayName : identity.displayName?.trim() || identity.email?.split('@')[0] || 'Người dùng';
  const email = typeof value.email === 'string' ? value.email : identity.email ?? null;
  return { uid, email, displayName, status: 'active' };
}

/** Creates only missing profiles. Existing, including legacy, fields are never overwritten. */
export function ensureUserProfileDocument(
  tx: FirebaseFirestore.Transaction, snapshot: FirebaseFirestore.DocumentSnapshot, identity: UserRecord, now: Timestamp,
): FirebaseFirestore.DocumentData {
  const existing = snapshot.data();
  if (identity.disabled || (existing && existing.status !== 'active')) {
    throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
  }
  if (existing) return existing;
  const document = createUserDocument(identity, now);
  tx.create(snapshot.ref, document);
  return document;
}

export async function bootstrapUserProfile(identity: UserRecord): Promise<UserProfile> {
  const store = db();
  const ref = store.doc(`users/${identity.uid}`);
  return store.runTransaction(async tx => {
    const document = ensureUserProfileDocument(tx, await tx.get(ref), identity, Timestamp.now());
    return toProfile(identity.uid, document, identity);
  });
}

/** Read only: callers may offer the bootstrap endpoint when a profile is missing. */
export async function readUserProfile(identity: UserRecord): Promise<UserProfile> {
  const snapshot = await db().doc(`users/${identity.uid}`).get();
  if (!snapshot.exists) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Hồ sơ chưa được tạo.');
  return toProfile(identity.uid, snapshot.data()!, identity);
}
