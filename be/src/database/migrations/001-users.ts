import { Timestamp } from 'firebase-admin/firestore';
import { auth } from '../../firebase.js';
import { createUserDocument, userDocumentSchema } from '../user.js';
import { scanCollection, type Migration } from './runner.js';

export const usersMigration: Migration = {
  id: 'DBM-001-users', revision: '1',
  scan: (store, pageSize) => scanCollection(store.collection('users'), pageSize),
  async plan(_store, ref, _now) {
    const snapshot = await ref.get();
    if (!snapshot.exists) return { guards: [{ ref, updateTime: null }], changes: [], issues: [] };
    const guards = [{ ref, updateTime: snapshot.updateTime ?? null }];
    let identity;
    try { identity = await auth().getUser(ref.id); }
    catch (error) {
      if ((error as { code?: string })?.code !== 'auth/user-not-found') throw error;
      return { guards, changes: [], issues: [{ code: 'AUTH_IDENTITY_MISSING', path: ref.path }] };
    }
    const stored = snapshot.data()!;
    const createdAt = stored.createdAt instanceof Timestamp ? stored.createdAt : snapshot.createTime;
    const updatedAt = stored.updatedAt instanceof Timestamp ? stored.updatedAt : snapshot.updateTime;
    if (!createdAt || !updatedAt) return { guards, changes: [], issues: [{ code: 'TIMESTAMP_UNAVAILABLE', path: ref.path }] };
    const defaults = createUserDocument(identity, createdAt);
    const email = stored.email === undefined ? defaults.email : stored.email;
    const desiredAuthDisabled = stored.desiredAuthDisabled === undefined
      ? stored.status === 'disabled' || identity.disabled : stored.desiredAuthDisabled;
    const fields = {
      ...defaults, emailLower: typeof email === 'string' ? email.toLowerCase() : null,
      status: identity.disabled ? 'disabled' : 'active',
      desiredAuthDisabled,
      authSyncStatus: identity.disabled === desiredAuthDisabled ? 'synced' : 'pending',
      createdAt, updatedAt,
    };
    const merged = { ...fields, ...stored };
    const parsed = userDocumentSchema.safeParse(merged);
    if (!parsed.success) return { guards, changes: [], issues: [{ code: 'UNRESOLVED_LEGACY_PROFILE', path: ref.path,
      fields: [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || '$'))] }] };
    const missing = Object.fromEntries(Object.entries(fields).filter(([field]) => stored[field] === undefined));
    return { guards, changes: Object.keys(missing).length ? [{ ref, data: missing }] : [], issues: [] };
  },
};
