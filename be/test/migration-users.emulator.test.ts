import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { auth, db } from '../src/firebase.js';
import { usersMigration } from '../src/database/migrations/001-users.js';
import { runMigration, type Migration } from '../src/database/migrations/runner.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) { process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill'; process.env.FIREBASE_WEB_API_KEY ??= 'demo'; }

describe.skipIf(!enabled)('DBM-001 profile migration', () => {
  it('dry-runs, checkpoints, resumes, preserves disabled status and blocks a competing lease', async () => {
    const store = db();
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const refs = ids.map(id => store.collection('users').doc(id));
    await auth().createUser({ uid: ids[0], email: `${ids[0]}@example.test`, displayName: 'An' });
    await auth().createUser({ uid: ids[1], email: `${ids[1]}@example.test`, displayName: 'Bình', disabled: true });
    await refs[0]!.set({ displayName: 'An', email: `${ids[0]}@example.test`, status: 'active' });
    await refs[1]!.set({ displayName: 'Bình', email: `${ids[1]}@example.test`, status: 'disabled', moderationVersion: 3 });
    await refs[2]!.set({ displayName: 'Đã mất Auth', status: 'active' });
    const migration: Migration = { ...usersMigration, id: `DBM-001-test-${randomUUID()}`,
      scan: async function* () { for (const ref of refs) yield { key: ref.path, ref }; } };
    const job = store.collection('schemaMigrations').doc(migration.id);
    const options = { projectId: 'demo-sharebill', pageSize: 1 };
    await expect(runMigration(store, migration, { ...options, projectId: 'wrong-project', apply: true }))
      .rejects.toThrow('project');

    const before = (await Promise.all(refs.map(ref => ref.get()))).map(s => s.updateTime?.toMillis());
    const dry = await runMigration(store, migration, { ...options, apply: false });
    expect(dry).toMatchObject({ dryRun: true, processed: 3, changed: 2, failed: 1, completed: false });
    expect(dry.issues).toEqual([{ code: 'AUTH_IDENTITY_MISSING', path: refs[2]!.path }]);
    expect((await job.get()).exists).toBe(false);
    expect((await Promise.all(refs.map(ref => ref.get()))).map(s => s.updateTime?.toMillis())).toEqual(before);

    const partial = await runMigration(store, migration, { ...options, apply: true, maxDocuments: 1 });
    expect(partial).toMatchObject({ processed: 1, changed: 1, completed: false });
    expect((await job.get()).get('cursor')).toBe(refs[0]!.path);
    await job.update({ leaseOwner: 'other-runner', leaseUntil: Timestamp.fromMillis(Date.now() + 60_000) });
    await expect(runMigration(store, migration, { ...options, apply: true })).rejects.toThrow('lease');
    await job.update({ leaseOwner: null, leaseUntil: null });

    const resumed = await runMigration(store, migration, { ...options, apply: true });
    expect(resumed).toMatchObject({ resumedFrom: refs[0]!.path, processed: 3, changed: 2, failed: 1, completed: false });
    const disabled = (await refs[1]!.get()).data()!;
    expect(disabled).toMatchObject({ status: 'disabled', moderationVersion: 3, desiredAuthDisabled: true, schemaVersion: 1 });
    expect((await refs[2]!.get()).get('schemaVersion')).toBeUndefined();
    expect((await job.get()).get('status')).toBe('failed');

    await auth().createUser({ uid: ids[2], email: `${ids[2]}@example.test`, displayName: 'Chi' });
    const complete = await runMigration(store, migration, { ...options, apply: true });
    expect(complete).toMatchObject({ failed: 0, completed: true });
    const done = (await refs[0]!.get()).updateTime?.toMillis();
    const rerun = await runMigration(store, migration, { ...options, apply: true });
    expect(rerun).toMatchObject({ completed: true, changed: 1 });
    expect((await refs[0]!.get()).updateTime?.toMillis()).toBe(done);

    let interrupt = true;
    const crashing: Migration = { ...usersMigration, id: `DBM-001-crash-${randomUUID()}`,
      scan: async function* () { for (const ref of refs) yield { key: ref.path, ref }; },
      plan: async (firebaseStore, ref, now) => {
        if (ref.path === refs[1]!.path && interrupt) throw new Error('Simulated interruption');
        return usersMigration.plan(firebaseStore, ref, now);
      } };
    await expect(runMigration(store, crashing, { ...options, apply: true })).rejects.toThrow('Simulated interruption');
    const crashJob = store.collection('schemaMigrations').doc(crashing.id);
    expect((await crashJob.get()).data()).toMatchObject({ status: 'interrupted', cursor: refs[0]!.path,
      processed: 1 });
    interrupt = false;
    const afterCrash = await runMigration(store, crashing, { ...options, apply: true });
    expect(afterCrash).toMatchObject({ resumedFrom: refs[0]!.path, processed: 3, completed: true });
  }, 30_000);
});
