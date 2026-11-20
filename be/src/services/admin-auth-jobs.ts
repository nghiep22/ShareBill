import { randomUUID } from 'node:crypto';
import { FieldPath, Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';

const leaseMs = 120_000;
const maximumAttempts = 5;
type AuthGateway = Pick<Auth, 'updateUser' | 'revokeRefreshTokens'>;
type Claim = { uid: string; owner: string; job: DocumentReference; lease: DocumentReference };

/** Reconciles the latest desired state while holding the per-user lease. */
async function processJob(store: Firestore, gateway: AuthGateway, job: DocumentReference) {
  const owner = randomUUID(), now = Timestamp.now();
  const claim = await store.runTransaction(async tx => {
    const snapshot = await tx.get(job);
    if (!snapshot.exists || !['queued', 'running'].includes(snapshot.get('status')) ||
      snapshot.get('availableAt').toMillis() > now.toMillis()) return;
    const uid = snapshot.get('uid') as string, profile = store.doc(`users/${uid}`), lease = store.doc(`adminAuthLeases/${uid}`);
    const [user, held] = await Promise.all([tx.get(profile), tx.get(lease)]);
    if (held.exists && held.get('leaseUntil').toMillis() > now.toMillis()) return;
    if (!user.exists || user.get('moderationVersion') !== snapshot.get('moderationVersion')) {
      tx.update(job, { status: 'superseded', completedAt: now, updatedAt: now });
      return;
    }
    if (snapshot.get('attempts') >= maximumAttempts) {
      tx.update(job, { status: 'failed', lastErrorCode: 'AUTH_SYNC_ATTEMPTS_EXHAUSTED', updatedAt: now });
      tx.update(user.ref, { status: 'disabled', authSyncStatus: 'failed', updatedAt: now });
      return;
    }
    const leaseUntil = Timestamp.fromMillis(now.toMillis() + leaseMs);
    tx.set(lease, { uid, jobId: job.id, owner, leaseUntil, updatedAt: now });
    tx.update(job, { status: 'running', attempts: snapshot.get('attempts') + 1,
      availableAt: leaseUntil, leaseOwner: owner, leaseUntil, updatedAt: now });
    return { uid, owner, job, lease } satisfies Claim;
  });
  if (!claim) return false;
  // A command can change the desired state during the external call. Each pass rereads it.
  try {
    for (let pass = 0; pass < 5; pass++) {
      const target = await store.runTransaction(async tx => {
        const [held, user] = await Promise.all([tx.get(claim.lease), tx.get(store.doc(`users/${claim.uid}`))]);
        if (held.get('owner') !== owner || !user.exists) return;
        const leaseUntil = Timestamp.fromMillis(Date.now() + leaseMs);
        tx.update(claim.lease, { leaseUntil, updatedAt: Timestamp.now() });
        tx.update(job, { leaseUntil, availableAt: leaseUntil });
        return { disabled: user.get('desiredAuthDisabled') as boolean, version: user.get('moderationVersion') as number };
      });
      if (!target) { await reconcileAfterLostLease(store, claim); return true; }
      await gateway.updateUser(claim.uid, { disabled: target.disabled });
      if (target.disabled) await gateway.revokeRefreshTokens(claim.uid);
      const done = await store.runTransaction(async tx => {
        const [held, user] = await Promise.all([tx.get(claim.lease), tx.get(store.doc(`users/${claim.uid}`))]);
        if (held.get('owner') !== owner) return 'lost';
        if (user.get('moderationVersion') !== target.version || user.get('desiredAuthDisabled') !== target.disabled) return 'changed';
        const completedAt = Timestamp.now();
        tx.update(user.ref, { status: target.disabled ? 'disabled' : 'active', authSyncStatus: 'synced', updatedAt: completedAt });
        tx.update(job, { status: 'succeeded', appliedModerationVersion: target.version,
          lastErrorCode: null, leaseOwner: null, leaseUntil: null, completedAt, updatedAt: completedAt });
        tx.delete(claim.lease);
        return 'done';
      });
      if (done === 'done') return true;
      if (done === 'lost') { await reconcileAfterLostLease(store, claim); return true; }
    }
    throw new Error('State changed repeatedly');
  } catch {
    await store.runTransaction(async tx => {
      const [held, user, snapshot] = await Promise.all([tx.get(claim.lease), tx.get(store.doc(`users/${claim.uid}`)), tx.get(job)]);
      if (held.get('owner') !== owner) return;
      const failed = snapshot.get('attempts') >= maximumAttempts, now = Timestamp.now();
      const availableAt = Timestamp.fromMillis(now.toMillis() + Math.min(60_000, 1000 * 2 ** snapshot.get('attempts')));
      tx.update(job, { status: failed ? 'failed' : 'queued', lastErrorCode: 'AUTH_SYNC_FAILED', availableAt,
        leaseOwner: null, leaseUntil: null, updatedAt: now });
      if (user.exists) tx.update(user.ref, { status: 'disabled', authSyncStatus: failed ? 'failed' : 'pending', updatedAt: now });
      tx.delete(claim.lease);
    });
    // A late completion may have lost its lease while changing Auth.
    if ((await claim.lease.get()).get('owner') !== owner) await reconcileAfterLostLease(store, claim);
    return true;
  }
}

async function reconcileAfterLostLease(store: Firestore, claim: Claim) {
  await store.runTransaction(async tx => {
    const [user, job] = await Promise.all([tx.get(store.doc(`users/${claim.uid}`)), tx.get(claim.job)]);
    if (!user.exists || job.get('status') === 'queued' || job.get('status') === 'failed') return;
    const now = Timestamp.now();
    if (job.get('status') === 'running' && job.get('leaseOwner') === claim.owner) {
      tx.update(job.ref, { status: 'superseded', leaseOwner: null, leaseUntil: null, completedAt: now, updatedAt: now });
    }
    tx.create(store.collection('adminAuthJobs').doc(), {
      schemaVersion: 1, uid: claim.uid, desiredDisabled: user.get('desiredAuthDisabled'), moderationVersion: user.get('moderationVersion'),
      status: 'queued', attempts: 0, availableAt: now, leaseOwner: null, leaseUntil: null, lastErrorCode: null,
      createdBy: 'auth-reconciler', createdAt: now, updatedAt: now, completedAt: null,
    });
    tx.update(user.ref, { status: 'disabled', authSyncStatus: 'pending', updatedAt: now });
  });
}

export async function drainAdminAuthJobs(store: Firestore, gateway: AuthGateway, limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid limit');
  let processed = 0;
  for (const status of ['queued', 'running']) {
    const snapshots = await store.collection('adminAuthJobs').where('status', '==', status)
      .where('availableAt', '<=', Timestamp.now()).orderBy('availableAt').limit(limit - processed).get();
    for (const job of snapshots.docs) if (await processJob(store, gateway, job.ref)) processed++;
    if (processed >= limit) break;
  }
  return { processed };
}

/** A bounded sweep detects late Auth effects after an expired worker lease or upstream timeout. */
export async function reconcileAdminAuth(store: Firestore, gateway: Pick<Auth, 'getUser'>, limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid limit');
  const checkpoint = store.doc('adminAuthReconciliation/current'), cursor = (await checkpoint.get()).get('lastUid');
  let query = store.collection('users').orderBy(FieldPath.documentId());
  if (typeof cursor === 'string') query = query.startAfter(cursor);
  const snapshots = await query.limit(limit).get();
  let queued = 0, errors = 0;
  for (const profile of snapshots.docs) {
    if (profile.get('authSyncStatus') !== 'synced') continue;
    try {
      const actual = await gateway.getUser(profile.id), desired = profile.get('desiredAuthDisabled');
      if (actual.disabled === desired) continue;
      const created = await store.runTransaction(async tx => {
        const current = await tx.get(profile.ref);
        if (current.get('moderationVersion') !== profile.get('moderationVersion') ||
          current.get('desiredAuthDisabled') !== desired || current.get('authSyncStatus') !== 'synced') return false;
        const now = Timestamp.now();
        tx.create(store.collection('adminAuthJobs').doc(), {
          schemaVersion: 1, uid: profile.id, desiredDisabled: desired, moderationVersion: current.get('moderationVersion'),
          status: 'queued', attempts: 0, availableAt: now, leaseOwner: null, leaseUntil: null, lastErrorCode: null,
          createdBy: 'auth-reconciler', createdAt: now, updatedAt: now, completedAt: null,
        });
        tx.update(profile.ref, { status: 'disabled', authSyncStatus: 'pending', updatedAt: now });
        return true;
      });
      if (created) queued++;
    } catch { errors++; }
  }
  await checkpoint.set({ lastUid: snapshots.size < limit ? null : snapshots.docs.at(-1)!.id, updatedAt: Timestamp.now() });
  return { scanned: snapshots.size, queued, errors };
}
