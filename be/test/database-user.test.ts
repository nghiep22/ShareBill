import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { createUserDocument, userDocumentSchema } from '../src/database/user.js';

const createdAt = Timestamp.fromMillis(1_700_000_000_000);

describe('user document v1', () => {
  it('creates a complete profile from trusted Auth identity without credentials', () => {
    const doc = createUserDocument({ uid: 'firebase-user', email: '  An@Example.Test  ', displayName: '  An  ' }, createdAt);
    expect(doc).toEqual({
      schemaVersion: 1, displayName: 'An', email: 'An@Example.Test', emailLower: 'an@example.test',
      status: 'active', moderationVersion: 1, desiredAuthDisabled: false, authSyncStatus: 'synced',
      disabledReason: null, disabledAt: null, disabledBy: null, createdAt, updatedAt: createdAt,
    });
    expect(JSON.stringify(doc)).not.toMatch(/password|token/i);
  });

  it('accepts a disabled profile without replacing its moderation state', () => {
    const active = createUserDocument({ uid: 'firebase-user', email: 'an@example.test' }, createdAt);
    const disabled = { ...active, status: 'disabled', moderationVersion: 3, desiredAuthDisabled: true,
      authSyncStatus: 'pending', disabledReason: 'Khóa bởi quản trị viên', disabledAt: createdAt, disabledBy: 'admin-uid' };
    expect(userDocumentSchema.parse(disabled)).toEqual(disabled);
    expect(active.status).toBe('active');
  });

  it('rejects invalid fields and inconsistent profile data', () => {
    const valid = createUserDocument({ uid: 'firebase-user', email: 'an@example.test' }, createdAt);
    expect(userDocumentSchema.safeParse({ ...valid, status: 'other' }).success).toBe(false);
    expect(userDocumentSchema.safeParse({ ...valid, emailLower: 'someone@example.test' }).success).toBe(false);
    expect(userDocumentSchema.safeParse({ ...valid, moderationVersion: 0 }).success).toBe(false);
    expect(userDocumentSchema.safeParse({ ...valid, password: 'secret' }).success).toBe(false);
    expect(userDocumentSchema.safeParse({ ...valid, updatedAt: Timestamp.fromMillis(createdAt.toMillis() - 1) }).success).toBe(false);
    expect(() => createUserDocument({ uid: '../another-user' }, createdAt)).toThrow('Invalid Firebase UID');
  });

  it('supports an Auth identity without an email', () => {
    const doc = createUserDocument({ uid: 'firebase-user' }, createdAt);
    expect(doc).toMatchObject({ email: null, emailLower: null, displayName: 'Người dùng' });
  });
});
