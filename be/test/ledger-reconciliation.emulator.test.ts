import { randomUUID } from 'node:crypto';
import { Firestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { createTripDocuments } from '../src/database/trip.js';
import { createUserDocument } from '../src/database/user.js';
import { createOperationDocument } from '../src/database/operation.js';
import { checkDatabase } from '../src/database/check-integrity.js';
import { reconciliationJobId, runLedgerReconciliation } from '../src/services/ledger-reconciliation.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
// A named Emulator database isolates whole-project sweep tests from developer data and other suites.
const store = enabled ? new Firestore({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'demo-sharebill', databaseId: 'reconcile-' + randomUUID() }) : undefined;
const clean = () => ({ summary: { tripsScanned: 1, tripsChecked: 1, projectProfilesChecked: 0, issueCount: 0 }, issues: [] });
afterAll(async () => { await store?.terminate(); });

async function fixture() {
  const tripId = randomUUID(), participantId = randomUUID(), ownerUid = randomUUID(), operationKey = randomUUID(), now = Timestamp.now();
  const input = { tripId, participantId, ownerUid, operationKey, auditEventId: randomUUID(), now, name: 'Private fixture trip', sharingMode: 'per-expense' as const, ownerName: 'Private fixture owner' };
  const docs = createTripDocuments(input), trip = store!.doc('trips/' + tripId), batch = store!.batch();
  batch.create(trip, docs.trip);
  for (const [path, value] of Object.entries({ ['memberships/' + ownerUid]: docs.membership, ['participants/' + participantId]: docs.participant,
    ['participantLinks/' + ownerUid]: docs.participantLink, ['balances/' + participantId]: docs.balance,
    'signals/current': docs.signal, ['auditEvents/' + input.auditEventId]: docs.audit })) batch.create(trip.collection(path.split('/')[0]!).doc(path.split('/')[1]!), value);
  batch.create(store!.doc('users/' + ownerUid), createUserDocument({ uid: ownerUid, displayName: 'Fixture', email: 'private-fixture@example.test' }, now));
  batch.create(store!.doc('users/' + ownerUid + '/tripRefs/' + tripId), docs.tripRef);
  batch.create(store!.doc('users/' + ownerUid + '/operations/' + operationKey), createOperationDocument({ method: 'POST', canonicalPath: '/api/v1/trips', body: { name: input.name, sharingMode: 'per-expense', ownerName: input.ownerName } },
    { actorUid: ownerUid, tripId, resourceId: tripId, resourceType: 'trip', httpStatus: 200, responseSnapshot: { data: { id: tripId }, meta: {} }, committedAt: now }));
  await batch.commit();
  return { tripId, trip, ownerUid, participantId, job: store!.doc('maintenanceJobs/' + reconciliationJobId(tripId)) };
}

async function fingerprint(ref: FirebaseFirestore.DocumentReference): Promise<string[]> {
  const snapshot = await ref.get();
  const children = (await Promise.all((await ref.listCollections()).map(collection => collection.listDocuments()))).flat();
  return [ref.path + ':' + snapshot.updateTime?.toMillis() + ':' + JSON.stringify(snapshot.data()), ...(await Promise.all(children.map(fingerprint))).flat()].sort();
}

describe.skipIf(!enabled)('S19 bounded ledger reconciliation', () => {
  it('checks actual source data, records a clean summary and does not mutate trip/user documents', async () => {
    const f = await fixture(), user = store!.doc('users/' + f.ownerUid);
    expect((await checkDatabase(store!, { tripId: f.tripId, pageSize: 1 })).summary.issueCount).toBe(0);
    const before = [...await fingerprint(f.trip), ...await fingerprint(user)];
    const result = await runLedgerReconciliation(store!, { tripId: f.tripId, pageSize: 1 });
    expect(result).toMatchObject({ processed: 1, status: 'succeeded', resultSummary: { tripsScanned: 1, tripsChecked: 1, issueCount: 0, scanErrors: 0 } });
    expect([...await fingerprint(f.trip), ...await fingerprint(user)]).toEqual(before);
    expect((await runLedgerReconciliation(store!, { tripId: f.tripId })).skipped).toBe('not-due');
    expect(JSON.stringify((await f.job.get()).data())).not.toMatch(/private-fixture|Private fixture/);
  });

  it('reports projection differences without repairing balances, source ledger or signal', async () => {
    const f = await fixture();
    await f.trip.collection('balances').doc(f.participantId).update({ netMinor: 13 });
    const before = await fingerprint(f.trip);
    const result = await runLedgerReconciliation(store!, { tripId: f.tripId });
    expect(result).toMatchObject({ status: 'failed', resultSummary: { tripsWithIssues: 1, scanErrors: 0 } });
    if ('resultSummary' in result) expect(result.resultSummary!.issueCount).toBeGreaterThan(0);
    expect((await f.job.get()).get('lastErrorCode')).toBe('RECONCILE_ISSUES_FOUND');
    expect(await fingerprint(f.trip)).toEqual(before);
    expect((await f.job.get()).data()).not.toHaveProperty('issues');
  });

  it('skips duplicate triggers, reclaims a crashed lease and rejects a stale worker commit', async () => {
    const f = await fixture();
    let time = Date.now(), start!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const slow = runLedgerReconciliation(store!, { tripId: f.tripId }, { now: () => time,
      check: async () => { start(); await gate; return clean(); } });
    const stale = expect(slow).rejects.toThrow('RECONCILE_LEASE_LOST');
    await started;
    expect((await runLedgerReconciliation(store!, { tripId: f.tripId }, { now: () => time })).skipped).toBe('lease-held');
    time += 120_001;
    expect(await runLedgerReconciliation(store!, { tripId: f.tripId }, { now: () => time, check: async () => clean() })).toMatchObject({ status: 'succeeded' });
    const saved = (await f.job.get()).data();
    resume(); await stale;
    expect((await f.job.get()).data()).toEqual(saved);
  });

  it('will not publish a result after its own lease expires even before a replacement arrives', async () => {
    const f = await fixture(); let time = Date.now();
    await expect(runLedgerReconciliation(store!, { tripId: f.tripId }, { now: () => time,
      check: async () => { time += 120_001; return clean(); } })).rejects.toThrow('RECONCILE_LEASE_LOST');
    expect((await f.job.get()).data()).toMatchObject({ status: 'running', checkpoint: null, resultSummary: { tripsChecked: 0 } });
  });

  it('retries transient failures three times at most, keeps the same checkpoint and never stores upstream text', async () => {
    const f = await fixture(); let time = Date.now();
    const dependency = { now: () => time, check: async () => { throw new Error('private-fixture-token-and-note'); } };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await runLedgerReconciliation(store!, { tripId: f.tripId }, dependency);
      expect(result).toMatchObject({ processed: 1, status: attempt < 3 ? 'queued' : 'failed' });
      const data = (await f.job.get()).data()!;
      expect(data.checkpoint).toBe(attempt < 3 ? null : f.tripId);
      expect(data.retryCount).toBe(attempt < 3 ? attempt : 0);
      expect(data.resultSummary.scanErrors).toBe(attempt < 3 ? 0 : 1);
      expect(JSON.stringify(data)).not.toContain('private-fixture');
      if (attempt < 3) expect((await runLedgerReconciliation(store!, { tripId: f.tripId }, dependency)).skipped).toBe('not-due');
      time += 5_001;
    }
  });

  it('recovers a transient failure, clears its error and starts a new cycle only after cooldown', async () => {
    const f = await fixture(); let time = Date.now();
    await runLedgerReconciliation(store!, { tripId: f.tripId }, { now: () => time, check: async () => { throw new Error('temporary'); } });
    const cycle = (await f.job.get()).get('cycle');
    time += 5_001;
    expect(await runLedgerReconciliation(store!, { tripId: f.tripId }, { now: () => time, check: async () => clean() })).toMatchObject({ status: 'succeeded' });
    expect((await f.job.get()).get('lastErrorCode')).toBeNull();
    time += 15 * 60_000 + 1;
    await runLedgerReconciliation(store!, { tripId: f.tripId }, { now: () => time, check: async () => clean() });
    expect((await f.job.get()).get('cycle')).not.toBe(cycle);
    expect((await f.job.get()).get('resultSummary.tripsChecked')).toBe(1);
  });

  it('pages a whole-project sweep without missing or double-counting trips', async () => {
    const expected = (await store!.collection('trips').orderBy('__name__').get()).docs.map(doc => doc.id), seen: string[] = [];
    let time = Date.now();
    for (let batch = 0; batch <= expected.length; batch++) {
      const result = await runLedgerReconciliation(store!, { limit: 2 }, { now: () => time,
        check: async (_store, scope) => { seen.push(scope.tripId!); return clean(); } });
      expect(result.processed).toBeLessThanOrEqual(2);
      if ('status' in result && result.status === 'succeeded') break;
      time++;
    }
    expect(seen).toEqual(expected);
    expect((await store!.doc('maintenanceJobs/ledger-reconcile-all').get()).get('resultSummary.tripsChecked')).toBe(expected.length);
  });

  it('keeps a deleted retry target and does not skip the last root when it fills a batch slot', async () => {
    const f = await fixture(); let time = Date.now() + 20 * 60_000;
    const global = store!.doc('maintenanceJobs/ledger-reconcile-all');
    await global.delete();
    await runLedgerReconciliation(store!, { limit: 1 }, { now: () => time, check: async () => { throw new Error('retry'); } });
    const retry = (await global.get()).get('retryTripId') as string;
    await store!.doc('trips/' + retry).delete();
    const remaining = (await store!.collection('trips').orderBy('__name__').get()).docs.map(doc => doc.id);
    const seen: string[] = [];
    time += 5_001;
    for (let batch = 0; batch < remaining.length + 2; batch++) {
      const result = await runLedgerReconciliation(store!, { limit: 1 }, { now: () => time,
        check: async (_store, scope) => { seen.push(scope.tripId!); return clean(); } });
      if ('status' in result && result.status === 'succeeded') break;
      time++;
    }
    expect(seen).toEqual([retry, ...remaining]);
    await f.trip.delete();
  });

  it('rejects malformed limits, paths and a conflicting persisted scope without scanning', async () => {
    await expect(runLedgerReconciliation(store!, { limit: 0 })).rejects.toThrow();
    await expect(runLedgerReconciliation(store!, { limit: 11 })).rejects.toThrow();
    await expect(runLedgerReconciliation(store!, { tripId: '../private' })).rejects.toThrow();
    const f = await fixture();
    await runLedgerReconciliation(store!, { tripId: f.tripId }, { check: async () => clean() });
    await f.job.update({ tripId: randomUUID() });
    await expect(runLedgerReconciliation(store!, { tripId: f.tripId })).rejects.toThrow('scope mismatch');
  });
});
