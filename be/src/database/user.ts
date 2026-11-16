import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

const userEmail = z.email().max(254);

/** Schema of a complete v1 app profile. Legacy documents are migrated separately. */
export const userDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  displayName: z.string().trim().min(1).max(80),
  email: userEmail.nullable(),
  emailLower: userEmail.nullable(),
  status: z.enum(['active', 'disabled']),
  moderationVersion: z.number().int().min(1),
  desiredAuthDisabled: z.boolean(),
  authSyncStatus: z.enum(['synced', 'pending', 'failed']),
  disabledReason: z.string().min(1).max(500).nullable(),
  disabledAt: z.instanceof(Timestamp).nullable(),
  disabledBy: z.string().min(1).nullable(),
  createdAt: z.instanceof(Timestamp),
  updatedAt: z.instanceof(Timestamp),
}).superRefine((value, context) => {
  if (value.emailLower !== (value.email?.toLowerCase() ?? null)) {
    context.addIssue({ code: 'custom', path: ['emailLower'], message: 'emailLower must match email' });
  }
  if (value.updatedAt.toMillis() < value.createdAt.toMillis()) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt must not precede createdAt' });
  }
});

export type UserDocument = z.infer<typeof userDocumentSchema>;

/** Only trusted Firebase Auth data may be passed to this factory. */
export type AuthIdentity = {
  uid: string;
  email?: string | null;
  displayName?: string | null;
};

export function createUserDocument(identity: AuthIdentity, now: Timestamp): UserDocument {
  if (!identity.uid || identity.uid.includes('/')) throw new Error('Invalid Firebase UID');
  const email = identity.email?.trim() || null;
  const displayName = identity.displayName?.trim() || email?.split('@')[0] || 'Người dùng';
  return userDocumentSchema.parse({
    schemaVersion: 1,
    displayName,
    email,
    emailLower: email?.toLowerCase() ?? null,
    status: 'active',
    moderationVersion: 1,
    desiredAuthDisabled: false,
    authSyncStatus: 'synced',
    disabledReason: null,
    disabledAt: null,
    disabledBy: null,
    createdAt: now,
    updatedAt: now,
  });
}
