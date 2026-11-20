import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Firestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDatabase } from '../src/database/check-integrity.js';
import { createExpenseDocument } from '../src/database/expense.js';
import { createOperationDocument } from '../src/database/operation.js';
import { createParticipantDocuments } from '../src/database/participant.js';
import { reconcileLedger } from '../src/database/reconcile.js';
import { confirmationChanges, createSettlementDocument } from '../src/database/settlement.js';
import { createTripDocuments } from '../src/database/trip.js';
import { createUserDocument } from '../src/database/user.js';
import { splitEqual } from '../src/domain/money.js';
import { applyProjectionRepair, prepareProjectionRepair } from '../src/services/projection-repair.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const scope = { projectId: process.env.FIREBASE_PROJECT_ID ?? 'demo-sharebill', databaseId: 'repair-' + randomUUID() };
const store = enabled ? new Firestore(scope) : undefined;
afterAll(async () => { await store?.terminate(); });

async function fixture(mode: 'per-expense' | 'group-equal' = 'group-equal', archived = false) {
  const tripId = randomUUID(), ownerUid = randomUUID(), participantId = randomUUID(), memberUid = randomUUID(), memberId = randomUUID();
  const key = randomUUID(), now = Timestamp.now(), trip = store!.doc('trips/' + tripId);
  const initial = createTripDocuments({ tripId, participantId, ownerUid, operationKey: key, auditEventId: randomUUID(),
    now, name: 'Private repair fixture', ownerName: 'Owner', sharingMode: mode });
  const other = createParticipantDocuments({ participantId: memberId, displayName: 'Member', linkedUid: memberUid, createdBy: ownerUid, now });
  const expense = createExpenseDocument({ id: randomUUID(), actorUid: ownerUid, now, body: {
    title: 'Private source expense', amountMinor: 100, payerParticipantId: participantId, category: 'food', occurredOn: '2026-11-20',
    note: 'Private source note', receiptIds: [], splitMethod: 'equal', split: { participantIds: [participantId, memberId] },
  }, shares: splitEqual(100, [participantId, memberId]) });
  const confirmed = { ...createSettlementDocument({ id: randomUUID(), actorUid: memberUid, now, body: {
    fromParticipantId: memberId, toParticipantId: participantId, amountMinor: archived ? 50 : 20, basedOnLedgerVersion: 1,
    occurredOn: '2026-11-20', note: null,
  } }), ...confirmationChanges({ actorUid: ownerUid, mode: 'recipient', version: 1, now }) };
  const pending = createSettlementDocument({ id: randomUUID(), actorUid: memberUid, now, body: {
    fromParticipantId: memberId, toParticipantId: participantId, amountMinor: 5, basedOnLedgerVersion: 2, occurredOn: '2026-11-20', note: null,
  } });
  const settlements = archived ? [confirmed] : [confirmed, pending];
  const expected = reconcileLedger([participantId, memberId], [expense], settlements, mode === 'group-equal' ? [participantId, memberId] : undefined);
  const batch = store!.batch();
  batch.create(trip, { ...initial.trip, ...expected.counts, totalExpenseMinor: expected.totalExpenseMinor, categoryTotalsMinor: expected.categoryTotalsMinor,
    participantCount: 2, membershipCountAllTime: 2, revision: 3, ledgerVersion: 2,
    ...(mode === 'group-equal' && { equalParticipantIds: [participantId, memberId].sort() }),
    moderationStatus: 'suspended', ...(archived && { status: 'archived', archivedAt: now }) });
  const children = {
    ['memberships/' + ownerUid]: initial.membership,
    ['memberships/' + memberUid]: { ...initial.membership, uid: memberUid, participantId: memberId, role: 'member',
      ...(archived && { status: 'removed', removedAt: now }) },
    ['participants/' + participantId]: { ...initial.participant, hasLedgerReferences: true },
    ['participants/' + memberId]: { ...other.participant, hasLedgerReferences: true },
    ['participantLinks/' + ownerUid]: initial.participantLink,
    ['participantLinks/' + memberUid]: { schemaVersion: 1, uid: memberUid, participantId: memberId, updatedAt: now },
    ['signals/current']: { ...initial.signal, revision: 3, ledgerVersion: 2 },
    ['auditEvents/' + initial.audit.eventId]: initial.audit,
    ['expenses/' + expense.id]: expense,
    ...Object.fromEntries(settlements.map(row => ['settlements/' + row.id, row])),
    ...Object.fromEntries([...expected.balances].map(([id, row]) => ['balances/' + id, { schemaVersion: 1, ...row, updatedAt: now }])),
  };
  for (const [path, value] of Object.entries(children)) batch.create(store!.doc(trip.path + '/' + path), value);
  for (const id of [ownerUid, memberUid]) {
    batch.create(store!.doc('users/' + id), createUserDocument({ uid: id, displayName: 'Private fixture' }, now));
    batch.create(store!.doc('users/' + id + '/tripRefs/' + tripId), { ...initial.tripRef, ...(archived && id === memberUid && { status: 'removed' }) });
  }
  batch.create(store!.doc('users/' + ownerUid + '/operations/' + key), createOperationDocument({ method: 'POST', canonicalPath: '/api/v1/trips', body: {} },
    { actorUid: ownerUid, tripId, resourceType: 'trip', resourceId: tripId, httpStatus: 200, responseSnapshot: { data: { id: tripId }, meta: {} }, committedAt: now }));
  batch.create(store!.doc('platformAdmins/' + ownerUid), { uid: ownerUid, role: 'platform_admin', status: 'active' });
  await batch.commit();
  const clean = async () => expect((await checkDatabase(store!, { tripId, pageSize: 2 })).issues).toEqual([]);
  return { tripId, trip, ownerUid, memberUid, participantId, memberId, expense, pending, clean,
    plan: () => prepareProjectionRepair(scope, tripId),
    corrupt: async () => {
      await trip.update({ totalExpenseMinor: 999, activeExpenseCount: 0, membershipCountAllTime: 9, 'categoryTotalsMinor.food': 999 });
      await trip.collection('balances').doc(memberId).delete();
      await trip.collection('balances').doc(participantId).update({ netMinor: 777, receivedMinor: 0, obsoleteProjectionField: 'Legacy projection field' });
      await trip.collection('participants').doc(memberId).update({ hasLedgerReferences: false });
      await trip.collection('signals').doc('current').delete();
    } };
}

async function source(f: Awaited<ReturnType<typeof fixture>>) {
  return Promise.all(['expenses', 'settlements', 'memberships', 'participantLinks', 'auditEvents'].map(async collection =>
    (await f.trip.collection(collection).get()).docs.map(doc => ({ path: doc.ref.path, time: doc.updateTime, data: doc.data() }))));
}

describe.skipIf(!enabled)('S19 controlled projection repair', () => {
  it.each(['group-equal', 'per-expense'] as const)('previews and repairs %s projections without changing source ledger or access', async mode => {
    const f = await fixture(mode); await f.clean(); await f.corrupt();
    const before = await source(f), root = (await f.trip.get()).data()!;
    const plan = await f.plan();
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.changes.find(change => change.path === f.trip.path + '/balances/' + f.participantId)?.before).toHaveProperty('obsoleteProjectionField');
    expect(await source(f)).toEqual(before);
    expect((await f.trip.get()).data()).toEqual(root);
    const result = await applyProjectionRepair(scope, JSON.parse(JSON.stringify(plan)), f.ownerUid, 'Repair synthetic projections');
    expect(result).toMatchObject({ replayed: false, changedDocuments: plan.changes.length });
    await f.clean();
    expect(await source(f)).toEqual(before);
    const repaired = await f.trip.get();
    expect(repaired.get('moderationStatus')).toBe('suspended');
    expect(repaired.get('revision')).toBe(root.revision + 1);
    expect(repaired.get('ledgerVersion')).toBe(root.ledgerVersion + 1);
    const job = await store!.doc('maintenanceJobs/' + result.jobId).get();
    expect(job.get('backupRef')).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(job.data())).not.toContain('Private source');
    expect((await store!.doc('adminAuditEvents/' + plan.id).get()).get('actorUid')).toBe(f.ownerUid);
    expect(await applyProjectionRepair(scope, plan, f.ownerUid, 'Repair synthetic projections')).toMatchObject({ replayed: true });
    expect((await f.trip.get()).updateTime).toEqual(repaired.updateTime);
    const unchanged = await f.plan();
    expect(unchanged.changes).toEqual([]);
    expect(await applyProjectionRepair(scope, unchanged, f.ownerUid, 'No correction needed')).toMatchObject({ jobId: null, changedDocuments: 0 });
    expect((await f.trip.get()).updateTime).toEqual(repaired.updateTime);
  });

  it('retains archived group shares after access removal, rather than charging the remaining member', async () => {
    const f = await fixture('group-equal', true); await f.corrupt();
    await applyProjectionRepair(scope, await f.plan(), f.ownerUid, 'Repair archived projections');
    await f.clean();
    const rows = await f.trip.collection('balances').get();
    expect(rows.docs.every(doc => doc.get('owedMinor') === 50 && doc.get('netMinor') === 0)).toBe(true);
  });

  it('rejects stale root versions and direct ledger writes without a version bump', async () => {
    for (const direct of [false, true]) {
      const f = await fixture(); await f.corrupt();
      const plan = await f.plan();
      if (direct) await f.trip.collection('expenses').doc(f.expense.id).update({ title: 'Changed after preview' });
      else await f.trip.update({ revision: plan.expectedRevision + 1 });
      const before = (await f.trip.get()).data();
      await expect(applyProjectionRepair(scope, plan, f.ownerUid, 'Attempt stale repair')).rejects.toMatchObject({ code: 'REPAIR_PLAN_STALE' });
      expect((await f.trip.get()).data()).toEqual(before);
      expect((await store!.doc('maintenanceJobs/projection-repair-' + plan.id).get()).exists).toBe(false);
    }
  });

  it('serializes competing plans, commits one correction, and rejects the other diff', async () => {
    const f = await fixture(); await f.corrupt();
    const plans = await Promise.all([f.plan(), f.plan()]);
    const results = await Promise.allSettled(plans.map(plan => applyProjectionRepair(scope, plan, f.ownerUid, 'Competing repair')));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'REPAIR_PLAN_STALE' } });
    await f.clean();
  }, 30000);

  it('preserves a concurrent root writer and never applies a diff against the writer\'s newer revision', async () => {
    const f = await fixture(); await f.corrupt();
    const plan = await f.plan();
    const [repair, writer] = await Promise.allSettled([
      applyProjectionRepair(scope, plan, f.ownerUid, 'Repair with concurrent writer'),
      store!.runTransaction(async tx => {
        const trip = await tx.get(f.trip);
        tx.update(f.trip, { note: 'Concurrent writer retained', revision: trip.get('revision') + 1, updatedAt: Timestamp.now() });
      }),
    ]);
    expect(writer.status).toBe('fulfilled');
    expect((await f.trip.get()).get('note')).toBe('Concurrent writer retained');
    if (repair.status === 'rejected') expect(repair.reason).toMatchObject({ code: 'REPAIR_PLAN_STALE' });
    else await f.clean();
  }, 30000);

  it('refuses normal trips, revoked operators, changed reason, scope mismatches and tampered plans', async () => {
    const f = await fixture(); await f.corrupt();
    await f.trip.update({ moderationStatus: 'normal' });
    const normal = await f.plan();
    await expect(applyProjectionRepair(scope, normal, f.ownerUid, 'Missing maintenance')).rejects.toMatchObject({ code: 'REPAIR_MAINTENANCE_REQUIRED' });
    await f.trip.update({ moderationStatus: 'suspended' });
    const plan = await f.plan();
    await expect(applyProjectionRepair(scope, { ...plan, tripId: randomUUID() }, f.ownerUid, 'Tampered scope')).rejects.toMatchObject({ code: 'REPAIR_INVALID_PLAN' });
    await expect(applyProjectionRepair({ ...scope, databaseId: 'another-database' }, plan, f.ownerUid, 'Wrong database')).rejects.toMatchObject({ code: 'REPAIR_SCOPE_MISMATCH' });
    await store!.doc('platformAdmins/' + f.ownerUid).update({ status: 'revoked' });
    await expect(applyProjectionRepair(scope, plan, f.ownerUid, 'Revoked operator')).rejects.toMatchObject({ code: 'REPAIR_ADMIN_REQUIRED' });
    await store!.doc('platformAdmins/' + f.ownerUid).update({ status: 'active' });
    await applyProjectionRepair(scope, plan, f.ownerUid, 'Original repair');
    await expect(applyProjectionRepair(scope, plan, f.ownerUid, 'Different intent')).rejects.toMatchObject({ code: 'REPAIR_KEY_REUSED' });
  });

  it('blocks invalid source, ambiguous links and orphan balances before producing a repair plan', async () => {
    for (const kind of ['source', 'link', 'orphan'] as const) {
      const f = await fixture();
      if (kind === 'source') await f.trip.collection('expenses').doc(f.expense.id).update({ amountMinor: 101 });
      if (kind === 'link') await f.trip.collection('participantLinks').doc(f.memberUid).update({ participantId: f.participantId });
      if (kind === 'orphan') await f.trip.collection('balances').doc(randomUUID()).set({ netMinor: 9 });
      await expect(f.plan()).rejects.toMatchObject({ code: kind === 'source' ? 'REPAIR_INVALID_SOURCE' : kind === 'link' ? 'REPAIR_INVALID_IDENTITY' : 'REPAIR_ORPHAN_BALANCE' });
    }
  });

  it('runs the CLI through a saved private plan, refuses overwriting that backup and verifies the repaired trip', async () => {
    const f = await fixture(); await f.corrupt();
    const directory = await mkdtemp(join(tmpdir(), 'sharebill-repair-')), file = join(directory, 'plan.json');
    const execute = promisify(execFile);
    const base = ['--import', 'tsx', 'scripts/repair-projections.ts', '--project', scope.projectId, '--database', scope.databaseId, '--trip', f.tripId];
    const options = { timeout: 20000, env: { ...process.env, FIREBASE_PROJECT_ID: scope.projectId } };
    try {
      const preview = await execute(process.execPath, [...base, '--plan-out', file], options);
      expect(JSON.parse(preview.stdout)).toMatchObject({ apply: false, planSaved: true, maintenance: true });
      expect(preview.stdout).not.toContain('Private source');
      const backup = await readFile(file, 'utf8');
      expect(backup).toContain('Private source note');
      await expect(execute(process.execPath, [...base, '--plan-out', file], options)).rejects.toMatchObject({ code: 2 });
      expect(await readFile(file, 'utf8')).toBe(backup);
      const applied = await execute(process.execPath, [...base, '--apply', '--plan', file, '--actor', f.ownerUid, '--reason', 'CLI rehearsal repair'], options);
      expect(JSON.parse(applied.stdout)).toMatchObject({ apply: true, replayed: false, verification: { tripsChecked: 1, issueCount: 0 } });
      expect(applied.stdout).not.toContain('Private source');
      await f.clean();
    } finally { await rm(file, { force: true }); await rmdir(directory); }
  }, 30000);
});
