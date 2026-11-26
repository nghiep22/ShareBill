import { createHash, randomUUID } from 'node:crypto';
import { Firestore, Timestamp, type DocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { expenseDocumentSchema } from '../database/expense.js';
import { balanceSchema, membershipSchema, participantLinkSchema, participantSchema, signalSchema, tripSchema, uid } from '../database/integrity-schemas.js';
import { reconcileLedger } from '../database/reconcile.js';
import { settlementDocumentSchema } from '../database/settlement.js';
import { increment } from './trip-access.js';

const maximumPlanBytes = 2 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const record = z.record(z.string(), z.unknown());
const snapshotSchema = z.strictObject({ path: z.string(), data: record.nullable(), updateTime: z.tuple([z.number().int(), z.number().int()]).nullable() });
const changeSchema = z.strictObject({ path: z.string(), before: record.nullable(), after: record });
const planSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('projection_repair'), id: z.uuid(),
  projectId: z.string(), databaseId: z.string(), emulatorHost: z.string(), tripId: z.uuid(),
  createdAt: z.iso.datetime(), expectedRevision: z.number().int().positive().safe(),
  expectedLedgerVersion: z.number().int().nonnegative().safe(), maintenance: z.boolean(),
  snapshot: z.array(snapshotSchema).max(4203), changes: z.array(changeSchema).max(103), digest: hashSchema,
});
export type ProjectionRepairPlan = z.infer<typeof planSchema>;
export type ProjectionRepairScope = { projectId: string; databaseId?: string };
export class ProjectionRepairError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function fail(code: string): never { throw new ProjectionRepairError(code); }

/** Exact timestamps and stable object keys make direct source writes detectable, even without a root revision bump. */
function encode(value: unknown): unknown {
  if (value instanceof Timestamp) return { $timestamp: [value.seconds, value.nanoseconds] };
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, encode((value as Record<string, unknown>)[key])]));
  }
  return fail('REPAIR_UNSUPPORTED_VALUE');
}
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(encode(value))).digest('hex'); }
function stored(snapshot: DocumentSnapshot): z.infer<typeof snapshotSchema> {
  return { path: snapshot.ref.path, data: snapshot.exists ? encode(snapshot.data()) as Record<string, unknown> : null,
    updateTime: snapshot.updateTime ? [snapshot.updateTime.seconds, snapshot.updateTime.nanoseconds] : null };
}

/** The first release deliberately accepts only a loopback Emulator and demo project, at both CLI and service boundaries. */
export function requireRepairScope(projectId: string, emulatorHost = process.env.FIRESTORE_EMULATOR_HOST) {
  if (!/^demo-[a-z0-9][a-z0-9-]*$/.test(projectId) || !emulatorHost ||
      !/^(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}$/.test(emulatorHost) || Number(emulatorHost.slice(emulatorHost.lastIndexOf(':') + 1)) > 65535 ||
      process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== projectId) fail('REPAIR_EMULATOR_REQUIRED');
  return emulatorHost;
}

async function withStore<T>(scope: ProjectionRepairScope, run: (store: Firestore, host: string) => Promise<T>) {
  const host = requireRepairScope(scope.projectId), databaseId = scope.databaseId ?? '(default)';
  if (databaseId !== '(default)' && !/^[a-z][a-z0-9-]{3,62}$/.test(databaseId)) fail('REPAIR_INVALID_SCOPE');
  // Pin the actual client to the validated loopback host; an injected cloud client cannot bypass the scope guard.
  const store = new Firestore({ projectId: scope.projectId, databaseId, host, ssl: false });
  try { return await run(store, host); } finally { await store.terminate(); }
}

async function readState(tx: Transaction, store: Firestore, tripId: string) {
  const tripRef = store.doc('trips/' + tripId);
  const [trip, signal, people, members, links, balances, expenses, settlements] = await Promise.all([
    tx.get(tripRef), tx.get(tripRef.collection('signals').doc('current')),
    tx.get(tripRef.collection('participants').limit(51)), tx.get(tripRef.collection('memberships').limit(51)),
    tx.get(tripRef.collection('participantLinks').limit(51)), tx.get(tripRef.collection('balances').limit(51)),
    tx.get(tripRef.collection('expenses').limit(2001)), tx.get(tripRef.collection('settlements').limit(2001)),
  ]);
  if (!trip.exists) fail('REPAIR_TRIP_NOT_FOUND');
  if (!people.size || !members.size || [people, members, links, balances].some(page => page.size > 50) ||
      expenses.size > 2000 || settlements.size > 2000) fail('REPAIR_LIMIT_EXCEEDED');
  const parse = <T>(schema: z.ZodType<T>, doc: DocumentSnapshot, idField: string) => {
    const result = schema.safeParse(doc.data());
    if (!result.success || doc.get(idField) !== doc.id) return fail('REPAIR_INVALID_SOURCE');
    return { ...result.data, documentId: doc.id };
  };
  const participants = people.docs.map(doc => parse(participantSchema, doc, 'id'));
  const memberships = members.docs.map(doc => parse(membershipSchema, doc, 'uid'));
  const participantLinks = links.docs.map(doc => parse(participantLinkSchema, doc, 'uid'));
  const owners = memberships.filter(member => member.role === 'owner' && member.status === 'active');
  if (owners.length !== 1 || owners[0]!.uid !== trip.get('ownerUid') || !owners[0]!.participantId) fail('REPAIR_INVALID_IDENTITY');
  for (const member of memberships) {
    const person = participants.find(person => person.id === member.participantId);
    const link = participantLinks.find(link => link.uid === member.uid);
    if (member.participantId ? !person || person.linkedUid !== member.uid || link?.participantId !== person.id : link) fail('REPAIR_INVALID_IDENTITY');
  }
  if (participants.some(person => person.linkedUid && !memberships.some(member => member.uid === person.linkedUid && member.participantId === person.id)) ||
      participantLinks.some(link => !memberships.some(member => member.uid === link.uid && member.participantId === link.participantId))) fail('REPAIR_INVALID_IDENTITY');
  const ids = new Set(participants.map(person => person.id));
  if (balances.docs.some(doc => !ids.has(doc.id))) fail('REPAIR_ORPHAN_BALANCE');
  const referenced = new Set<string>();
  const reference = (values: string[]) => { for (const id of values) { if (!ids.has(id)) fail('REPAIR_MISSING_PARTICIPANT'); referenced.add(id); } };
  const expenseRows = expenses.docs.map(doc => {
    const row = parse(expenseDocumentSchema, doc, 'id');
    reference([row.payerParticipantId, ...row.shares.map(share => share.participantId)]);
    return row;
  });
  const settlementRows = settlements.docs.map(doc => {
    const row = parse(settlementDocumentSchema, doc, 'id');
    reference([row.fromParticipantId, row.toParticipantId]);
    return row;
  });
  const equalIds = trip.get('sharingMode') === 'group-equal' ? trip.get('equalParticipantIds') as string[] : undefined;
  if (trip.get('sharingMode') === 'group-equal') {
    if (!Array.isArray(equalIds) || !equalIds.length || new Set(equalIds).size !== equalIds.length ||
        equalIds.some(id => !participants.some(person => person.id === id && person.status === 'active' && person.linkedUid))) fail('REPAIR_INVALID_GROUP');
    const activeIds = memberships.filter(member => member.status === 'active').map(member => member.participantId);
    if (trip.get('status') === 'active' && JSON.stringify([...equalIds].sort()) !== JSON.stringify(activeIds.sort())) fail('REPAIR_INVALID_GROUP');
  }
  let expected;
  try { expected = reconcileLedger(ids, expenseRows, settlementRows, equalIds); }
  catch { return fail('REPAIR_INVALID_SOURCE'); }
  const rootPatch = { ...expected.counts, totalExpenseMinor: expected.totalExpenseMinor, categoryTotalsMinor: expected.categoryTotalsMinor,
    participantCount: participants.length, membershipCountAllTime: memberships.length };
  if (!tripSchema.safeParse({ ...trip.data(), ...rootPatch }).success || trip.get('id') !== trip.id) fail('REPAIR_INVALID_SOURCE');
  const changes: z.infer<typeof changeSchema>[] = [];
  const add = (doc: DocumentSnapshot, after: Record<string, unknown>) => {
    const fields = Object.keys(after), before = doc.exists ? Object.fromEntries(fields.map(field => [field, doc.get(field) ?? null])) : null;
    if (digest(before) !== digest(after)) changes.push({ path: doc.ref.path, before, after });
  };
  add(trip, rootPatch);
  for (const [id, row] of expected.balances) {
    const doc = balances.docs.find(doc => doc.id === id) ?? await tx.get(tripRef.collection('balances').doc(id));
    const projection = { schemaVersion: 1, ...row, ...(doc.get('allocatedOwedMinor') !== undefined && row.allocatedOwedMinor === undefined && { allocatedOwedMinor: 0 }) };
    add(doc, projection);
    // Timestamp/type errors in a projection can be repaired without trusting its financial values.
    if (doc.exists && !balanceSchema.safeParse(doc.data()).success) {
      const change = changes.find(change => change.path === doc.ref.path);
      const before = encode(doc.data()) as Record<string, unknown>;
      if (change) change.before = before;
      else changes.push({ path: doc.ref.path, before, after: projection });
    }
  }
  for (const person of people.docs) if (referenced.has(person.id) && !person.get('hasLedgerReferences')) add(person, { hasLedgerReferences: true });
  add(signal, { schemaVersion: 1, revision: trip.get('revision'), ledgerVersion: trip.get('ledgerVersion') });
  if (signal.exists && !signalSchema.safeParse(signal.data()).success) {
    const change = changes.find(change => change.path === signal.ref.path);
    const before = encode(signal.data()) as Record<string, unknown>;
    if (change) change.before = before;
    else changes.push({ path: signal.ref.path, before, after: { schemaVersion: 1, revision: trip.get('revision'), ledgerVersion: trip.get('ledgerVersion') } });
  }
  if (changes.length) {
    const versions = { version: increment(trip.get('version')), revision: increment(trip.get('revision')),
      ledgerVersion: trip.get('ledgerVersion') + 1 };
    if (!Number.isSafeInteger(versions.ledgerVersion)) fail('REPAIR_INVALID_SOURCE');
    const root = changes.find(change => change.path === trip.ref.path);
    if (root) {
      root.before = { ...root.before, ...Object.fromEntries(Object.keys(versions).map(field => [field, trip.get(field)])) };
      root.after = { ...root.after, ...versions };
    } else changes.push({ path: trip.ref.path, before: Object.fromEntries(Object.keys(versions).map(field => [field, trip.get(field)])), after: versions });
    const signalChange = changes.find(change => change.path === signal.ref.path);
    const after = { schemaVersion: 1, revision: versions.revision, ledgerVersion: versions.ledgerVersion };
    if (signalChange) signalChange.after = after;
    else changes.push({ path: signal.ref.path, before: { schemaVersion: signal.get('schemaVersion'), revision: signal.get('revision'), ledgerVersion: signal.get('ledgerVersion') }, after });
  }
  const snapshot = [trip, signal, ...people.docs, ...members.docs, ...links.docs, ...balances.docs, ...expenses.docs, ...settlements.docs]
    .map(stored).sort((a, b) => a.path.localeCompare(b.path));
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { trip, snapshot, changes };
}

export async function prepareProjectionRepair(scope: ProjectionRepairScope, tripId: string): Promise<ProjectionRepairPlan> {
  if (!z.uuid().safeParse(tripId).success) fail('REPAIR_INVALID_SCOPE');
  return withStore(scope, async (store, host) => {
    const state = await store.runTransaction(tx => readState(tx, store, tripId), { readOnly: true });
    const content = { schemaVersion: 1 as const, kind: 'projection_repair' as const, id: randomUUID(),
      projectId: scope.projectId, databaseId: store.databaseId, emulatorHost: host, tripId, createdAt: new Date().toISOString(),
      expectedRevision: state.trip.get('revision') as number, expectedLedgerVersion: state.trip.get('ledgerVersion') as number,
      maintenance: state.trip.get('moderationStatus') === 'suspended', snapshot: state.snapshot, changes: state.changes };
    const plan = { ...content, digest: digest(content) };
    if (Buffer.byteLength(JSON.stringify(plan)) > maximumPlanBytes) fail('REPAIR_LIMIT_EXCEEDED');
    return planSchema.parse(plan);
  });
}

export function parseProjectionRepairPlan(value: unknown): ProjectionRepairPlan {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > maximumPlanBytes) fail('REPAIR_INVALID_PLAN');
  const result = planSchema.safeParse(value);
  if (!result.success) fail('REPAIR_INVALID_PLAN');
  const { digest: expected, ...content } = result.data;
  if (digest(content) !== expected) fail('REPAIR_INVALID_PLAN');
  return result.data;
}

export async function applyProjectionRepair(scope: ProjectionRepairScope, value: unknown, actorUid: string, reason: string) {
  const plan = parseProjectionRepairPlan(value);
  return withStore(scope, async (store, host) => {
    if (plan.projectId !== scope.projectId || plan.databaseId !== store.databaseId || plan.emulatorHost !== host) fail('REPAIR_SCOPE_MISMATCH');
    if (!uid.safeParse(actorUid).success || !reason.trim() || reason.length > 300) fail('REPAIR_INVALID_ACTOR');
    const jobRef = store.doc('maintenanceJobs/projection-repair-' + plan.id);
    const commandHash = digest({ digest: plan.digest, actorUid, reason });
    return store.runTransaction(async tx => {
      const [job, grant, profile] = await Promise.all([tx.get(jobRef), tx.get(store.doc('platformAdmins/' + actorUid)), tx.get(store.doc('users/' + actorUid))]);
      if (grant.get('uid') !== actorUid || grant.get('role') !== 'platform_admin' || grant.get('status') !== 'active' || profile.get('status') !== 'active') fail('REPAIR_ADMIN_REQUIRED');
      if (job.exists) {
        if (job.get('commandHash') !== commandHash || job.get('status') !== 'succeeded') fail('REPAIR_KEY_REUSED');
        return { jobId: job.id, replayed: true, changedDocuments: job.get('resultSummary.changedDocuments') as number };
      }
      const state = await readState(tx, store, plan.tripId);
      if (digest(state.snapshot) !== digest(plan.snapshot) || digest(state.changes) !== digest(plan.changes) ||
          state.trip.get('revision') !== plan.expectedRevision || state.trip.get('ledgerVersion') !== plan.expectedLedgerVersion) fail('REPAIR_PLAN_STALE');
      if (state.trip.get('moderationStatus') !== 'suspended' || !plan.maintenance) fail('REPAIR_MAINTENANCE_REQUIRED');
      if (!state.changes.length) return { jobId: null, replayed: false, changedDocuments: 0 };
      const now = Timestamp.now();
      for (const change of state.changes) {
        const ref = store.doc(change.path);
        if (ref.parent.id === 'balances' || ref.parent.id === 'signals') tx.set(ref, { ...change.after, updatedAt: now });
        else tx.update(ref, { ...change.after, updatedAt: now });
      }
      const resultSummary = { changedDocuments: state.changes.length };
      tx.create(jobRef, { schemaVersion: 1, kind: 'projection_repair', status: 'succeeded', tripId: plan.tripId,
        actorUid, reason, commandHash, planDigest: plan.digest, backupRef: 'sha256:' + digest(plan.snapshot),
        expectedRevision: plan.expectedRevision, expectedLedgerVersion: plan.expectedLedgerVersion,
        attempts: 1, resultSummary, createdAt: now, updatedAt: now, completedAt: now });
      tx.create(store.doc('adminAuditEvents/' + plan.id), { schemaVersion: 1, actorUid, targetType: 'trip', targetId: plan.tripId,
        action: 'trip.projections_repaired', before: { revision: plan.expectedRevision, ledgerVersion: plan.expectedLedgerVersion },
        after: { id: plan.tripId, revision: state.trip.get('revision') + 1, ledgerVersion: state.trip.get('ledgerVersion') + 1, ...resultSummary },
        reason, operationKey: plan.id, requestId: 'projection-repair-' + plan.id, createdAt: now });
      return { jobId: jobRef.id, replayed: false, ...resultSummary };
    });
  });
}
