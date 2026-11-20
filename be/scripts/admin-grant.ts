import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { deleteApp, getApps } from 'firebase-admin/app';
import { Timestamp } from 'firebase-admin/firestore';
import { auth, db } from '../src/firebase.js';
import { bootstrapUserProfile } from '../src/services/user-profile.js';

try {
  const { values } = parseArgs({ options: { project: { type: 'string' }, uid: { type: 'string' },
    operator: { type: 'string' }, apply: { type: 'boolean', default: false }, revoke: { type: 'boolean', default: false } } });
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (!values.project || !values.uid || !values.operator || values.uid.includes('/') ||
      process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== values.project ||
      values.project.startsWith('demo-') && !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Invalid project/environment');
  process.env.FIREBASE_PROJECT_ID = values.project;
  const identity = await auth().getUser(values.uid);
  if (identity.disabled || !identity.emailVerified || !identity.providerData.some(provider => provider.providerId === 'google.com')) {
    throw new Error('A verified Google identity is required');
  }
  const store = db(), grant = store.doc(`platformAdmins/${values.uid}`);
  if (values.apply) {
    await bootstrapUserProfile(identity);
    await store.runTransaction(async tx => {
      const prior = await tx.get(grant), now = Timestamp.now();
      const version = (prior.get('version') ?? 0) + 1;
      const status = values.revoke ? 'disabled' : 'active';
      tx.set(grant, { uid: values.uid, role: 'platform_admin', status, version, grantedBy: values.operator, grantedAt: now });
      tx.create(store.collection('adminAuditEvents').doc(), { schemaVersion: 1, actorUid: values.operator,
        targetType: 'user', targetId: values.uid, action: 'admin.' + (values.revoke ? 'revoked' : 'granted'),
        before: { status: prior.get('status') ?? null }, after: { status, version },
        reason: 'Quy trình operator', requestId: null, operationKey: null, createdAt: now });
    });
  }
  process.stdout.write(JSON.stringify({ project: values.project, uid: values.uid, apply: values.apply, revoke: values.revoke }) + '\n');
} catch {
  process.stderr.write('Admin grant failed. Check project, verified Google identity and operator arguments.\n');
  process.exitCode = 1;
} finally { await Promise.all(getApps().map(app => deleteApp(app))); }
