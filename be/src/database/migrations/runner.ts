import { createHash, randomUUID } from 'node:crypto';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { getApps } from 'firebase-admin/app';

type Store = FirebaseFirestore.Firestore;
type Reference = FirebaseFirestore.DocumentReference;
export type MigrationIssue = { code: string; path: string; fields?: string[] };
export type Mutation = { ref: Reference; data: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>; create?: boolean };
export type Guard = { ref: Reference; updateTime: Timestamp | null };
export type Plan = { guards: Guard[]; changes: Mutation[]; issues: MigrationIssue[]; exceptions?: MigrationIssue[] };
export type Migration = {
  id: string;
  revision: string;
  scan: (store: Store, pageSize: number) => AsyncGenerator<{ key: string; ref: Reference }>;
  plan: (store: Store, ref: Reference, now: Timestamp) => Promise<Plan>;
};
export type MigrationReport = {
  id: string; dryRun: boolean; processed: number; changed: number; failed: number;
  resumedFrom: string | null; completed: boolean; issues: MigrationIssue[]; exceptions: MigrationIssue[];
};

const LEASE_MS = 90_000;
const checksum = (migration: Migration) => createHash('sha256').update(`${migration.id}:${migration.revision}`).digest('hex');

export async function* scanCollection(collection: FirebaseFirestore.CollectionReference, pageSize: number) {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  const query = collection.orderBy(FieldPath.documentId());
  for (;;) {
    const page = await (cursor ? query.startAfter(cursor) : query).limit(pageSize).get();
    for (const doc of page.docs) yield { key: doc.ref.path, ref: doc.ref };
    if (page.size < pageSize) return;
    cursor = page.docs.at(-1);
  }
}

export async function runMigration(store: Store, migration: Migration, options: {
  projectId: string; apply: boolean; pageSize: number; maxDocuments?: number;
}): Promise<MigrationReport> {
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) throw new Error('Invalid page size.');
  if (options.maxDocuments !== undefined && (!Number.isSafeInteger(options.maxDocuments) || options.maxDocuments < 1)) throw new Error('Invalid document limit.');
  if (options.apply && !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Applying migrations is limited to the local Firestore Emulator.');
  if (process.env.FIREBASE_PROJECT_ID !== options.projectId ||
      !getApps().some(app => app.options.projectId === options.projectId)) throw new Error('Migration project does not match the Firebase app.');
  const job = store.collection('schemaMigrations').doc(migration.id);
  const owner = randomUUID();
  const hash = checksum(migration);
  let cursor: string | null = null;
  let totalProcessed = 0;
  let totalFailed = 0;
  let totalChanged = 0;
  if (options.apply) {
    const state = await store.runTransaction(async tx => {
      const snapshot = await tx.get(job);
      const saved = snapshot.data();
      if (saved && (saved.projectId !== options.projectId || saved.checksum !== hash)) throw new Error('Migration project or checksum differs.');
      if (saved?.status === 'completed' || saved?.status === 'completed_with_exceptions') return {
        done: true, cursor: saved.cursor ?? null, processed: saved.processed ?? 0,
        failed: 0, changed: saved.changed ?? 0,
      };
      if (saved?.leaseUntil?.toMillis?.() > Date.now()) throw new Error('Migration lease is held by another runner.');
      const now = Timestamp.now();
      tx.set(job, { migrationId: migration.id, checksum: hash, projectId: options.projectId,
        releaseCommit: process.env.GITHUB_SHA ?? 'local-development',
        status: 'running', cursor: saved?.status === 'failed' ? null : saved?.cursor ?? null,
        processed: saved?.status === 'failed' ? 0 : saved?.processed ?? 0,
        changed: saved?.status === 'failed' ? 0 : saved?.changed ?? 0,
        failed: 0, exceptionCount: saved?.status === 'failed' ? 0 : saved?.exceptionCount ?? 0,
        leaseOwner: owner, leaseUntil: Timestamp.fromMillis(Date.now() + LEASE_MS),
        startedAt: saved?.startedAt ?? now, updatedAt: now, completedAt: null }, { merge: true });
      return { done: false, cursor: saved?.status === 'failed' ? null : saved?.cursor ?? null,
        processed: saved?.status === 'failed' ? 0 : saved?.processed ?? 0, failed: 0,
        changed: saved?.status === 'failed' ? 0 : saved?.changed ?? 0 };
    });
    cursor = state.cursor; totalProcessed = state.processed; totalChanged = state.changed;
    if (state.done) return { id: migration.id, dryRun: false, processed: totalProcessed, changed: totalChanged,
      failed: 0, resumedFrom: cursor, completed: true, issues: [], exceptions: [] };
  }
  const resumedFrom = cursor;
  const issues: MigrationIssue[] = [];
  const exceptions: MigrationIssue[] = [];
  let visited = 0;
  try {
    for await (const item of migration.scan(store, options.pageSize)) {
      if (cursor && item.key <= cursor) continue;
      if (options.maxDocuments && visited >= options.maxDocuments) break;
      visited++;
      const plan = await migration.plan(store, item.ref, Timestamp.now());
      if (options.apply) {
        await store.runTransaction(async tx => {
          const lock = await tx.get(job);
          if (lock.get('leaseOwner') !== owner || lock.get('status') !== 'running' ||
              lock.get('leaseUntil')?.toMillis?.() <= Date.now()) throw new Error('Migration lease lost.');
          const observed = await Promise.all(plan.guards.map(guard => tx.get(guard.ref)));
          for (let i = 0; i < plan.guards.length; i++) {
            const expected = plan.guards[i]!.updateTime;
            const actual = observed[i]!.updateTime;
            if (expected ? !actual?.isEqual(expected) : actual) throw new Error('Document changed during migration.');
          }
          const before = await Promise.all(plan.changes.map(change => tx.get(change.ref)));
          for (let i = 0; i < plan.changes.length; i++) {
            const change = plan.changes[i]!;
            if (change.create ? before[i]!.exists : !before[i]!.exists) throw new Error('Document changed during migration.');
          }
          if (!plan.issues.length) for (const change of plan.changes) {
            if (change.create) tx.create(change.ref, change.data);
            else tx.update(change.ref, change.data);
          }
          tx.update(job, { cursor: item.key, processed: totalProcessed + 1,
            changed: totalChanged + (plan.issues.length ? 0 : plan.changes.length),
            failed: totalFailed + Number(plan.issues.length > 0), updatedAt: Timestamp.now(),
            exceptionCount: (lock.get('exceptionCount') ?? 0) + (plan.exceptions?.length ?? 0),
            leaseUntil: Timestamp.fromMillis(Date.now() + LEASE_MS) });
        });
      }
      totalProcessed++;
      if (plan.issues.length) { totalFailed++; issues.push(...plan.issues); }
      else totalChanged += plan.changes.length;
      exceptions.push(...plan.exceptions ?? []);
      cursor = item.key;
    }
    const completed = !options.maxDocuments || visited < options.maxDocuments;
    if (options.apply) await store.runTransaction(async tx => {
      const lock = await tx.get(job);
      if (lock.get('leaseOwner') !== owner) throw new Error('Migration lease lost.');
      tx.update(job, { status: !completed ? 'running' : totalFailed ? 'failed' :
        lock.get('exceptionCount') ? 'completed_with_exceptions' : 'completed',
        cursor: completed && totalFailed ? null : cursor, leaseOwner: null, leaseUntil: null,
        failed: totalFailed, updatedAt: Timestamp.now(), completedAt: completed && !totalFailed ? Timestamp.now() : null });
    });
    return { id: migration.id, dryRun: !options.apply, processed: totalProcessed, changed: totalChanged,
      failed: totalFailed, resumedFrom, completed: completed && totalFailed === 0, issues, exceptions };
  } catch (error) {
    if (options.apply) await store.runTransaction(async tx => {
      const lock = await tx.get(job);
      if (lock.get('leaseOwner') === owner) tx.update(job, { leaseOwner: null, leaseUntil: null,
        status: 'interrupted', updatedAt: Timestamp.now() });
    }).catch(() => {});
    throw error;
  }
}
