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
export async function bootstrapUserProfile(identity: UserRecord): Promise<UserProfile> {
  if (identity.disabled) throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
  const store = db();
  const ref = store.doc(`users/${identity.uid}`);
  return store.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) return toProfile(identity.uid, snapshot.data()!, identity);
    const document = createUserDocument(identity, Timestamp.now());
    tx.create(ref, document);
    return toProfile(identity.uid, document, identity);
  });
}

/** Read only: callers may offer the bootstrap endpoint when a profile is missing. */
export async function readUserProfile(identity: UserRecord): Promise<UserProfile> {
  const snapshot = await db().doc(`users/${identity.uid}`).get();
  if (!snapshot.exists) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Hồ sơ chưa được tạo.');
  return toProfile(identity.uid, snapshot.data()!, identity);
}
