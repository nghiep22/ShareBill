import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { checkDatabase } from '../src/database/check-integrity.js';
import { db } from '../src/firebase.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) {
  process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill';
  process.env.FIREBASE_WEB_API_KEY ??= 'demo';
}
const runFile = promisify(execFile);

async function makeLedger() {
  process.env.FIREBASE_WEB_API_KEY ??= 'demo';
  const app = await buildApp();
  try {
    const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
      email: `checker-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: 'An',
    } });
    expect(registered.statusCode).toBe(201);
    const { accessToken, user } = registered.json().data;
    async function post(url: string, payload: object, version?: number) {
      const response = await app.inject({ method: 'POST', url, payload,
        headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': randomUUID(),
          ...(version === undefined ? {} : { 'if-match': `"${version}"` }) } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    }

    const created = await post('/api/v1/trips', { name: 'Đối soát', sharingMode: 'per-expense', ownerName: 'An' });
    const tripId = created.data.id as string;
    const owner = created.data.ownerParticipantId as string;
    const base = `/api/v1/trips/${tripId}`;
    const guest = (await post(`${base}/participants`, { displayName: 'Bình' })).data.id as string;
    const occurredOn = '2026-12-20';
    const expensePayload = { title: 'Không in ghi chú này', note: 'private-note-checker', payerParticipantId: owner,
      splitMethod: 'equal', split: { participantIds: [owner, guest] }, occurredOn, category: 'food' };
    const expense = await post(`${base}/expenses`, { ...expensePayload, amountMinor: 120 });
    const toVoid = await post(`${base}/expenses`, { ...expensePayload, amountMinor: 30 });
    const voided = await post(`${base}/expenses/${toVoid.data.id}/void`, { reason: 'Nhập nhầm' }, 1);
    const settlement = { fromParticipantId: guest, toParticipantId: owner, occurredOn };
    const beforeConfirm = voided.meta.ledgerVersion as number;
    const proposal = await post(`${base}/settlements`, { ...settlement, amountMinor: 20, basedOnLedgerVersion: beforeConfirm });
    const confirmed = await post(`${base}/settlements/${proposal.data.id}/confirm`, { basedOnLedgerVersion: beforeConfirm }, 1);
    await post(`${base}/settlements`, { ...settlement, amountMinor: 10, basedOnLedgerVersion: confirmed.meta.ledgerVersion });

    const store = db();
    return { store, tripId, owner, guest, ownerUid: user.uid as string,
      trip: store.doc(`trips/${tripId}`), expenseId: expense.data.id as string };
  } finally {
    await app.close();
  }
}

async function fingerprint(...roots: FirebaseFirestore.DocumentReference[]) {
  async function read(ref: FirebaseFirestore.DocumentReference): Promise<string[]> {
    const snapshot = await ref.get();
    const children = await Promise.all((await ref.listCollections()).map(collection => collection.listDocuments()));
    const nested = await Promise.all(children.flat().map(child => read(child)));
    return [`${ref.path}:${snapshot.updateTime?.seconds}:${snapshot.updateTime?.nanoseconds}`, ...nested.flat()];
  }
  return (await Promise.all(roots.map(ref => read(ref)))).flat().sort();
}

describe.skipIf(!enabled)('read-only database checker', () => {
  it('reconciles multiple pages and reports precise differences without changing documents', async () => {
    const { store, trip, tripId, owner, ownerUid, guest } = await makeLedger();
    const balance = trip.collection('balances').doc(owner);
    const scope = { tripId, pageSize: 1 };
    const clean = await checkDatabase(store, scope);
    expect(clean.issues).toEqual([]);
    expect(clean.summary).toMatchObject({ tripsScanned: 1, tripsChecked: 1, issueCount: 0 });
    expect((await balance.get()).data()).toMatchObject({ receivedMinor: 20, netMinor: 40 });
    expect((await trip.collection('balances').doc(guest).get()).data()).toMatchObject({ sentMinor: 20, netMinor: -40 });

    const command = ['--import', 'tsx', 'scripts/check-database.ts', '--project', process.env.FIREBASE_PROJECT_ID!, '--trip', tripId, '--page-size', '1'];
    const env = { ...process.env, METADATA_SERVER_DETECTION: 'none' };
    const cleanOutput = await runFile(process.execPath, command, { env });
    expect(JSON.parse(cleanOutput.stdout)).toMatchObject({ tripId, target: 'emulator', summary: { issueCount: 0 } });

    const batch = store.batch();
    batch.update(balance, { receivedMinor: 30, netMinor: 30 });
    batch.update(trip, { totalExpenseMinor: 150, 'categoryTotalsMinor.food': 150, pendingSettlementCount: 0 });
    batch.update(trip.collection('signals').doc('current'), { ledgerVersion: 0 });
    await batch.commit();
    const user = store.doc(`users/${ownerUid}`);
    const before = await fingerprint(trip, user);
    const report = await checkDatabase(store, scope);
    expect(report.issues).toHaveLength(6);
    expect(report.issues).toEqual(expect.arrayContaining([
      { code: 'PROJECTION_MISMATCH', path: balance.path, fields: ['receivedMinor'], diff: { expected: 20, actual: 30 } },
      { code: 'PROJECTION_MISMATCH', path: trip.path, fields: ['categoryTotalsMinor.food'], diff: { expected: 120, actual: 150 } },
      { code: 'PROJECTION_MISMATCH', path: trip.path, fields: ['pendingSettlementCount'], diff: { expected: 1, actual: 0 } },
    ]));
    expect(await fingerprint(trip, user)).toEqual(before);
    expect(JSON.stringify(report)).not.toContain('private-note-checker');

    const output = await runFile(process.execPath, command, { env }).catch((error: { code: unknown; stdout: string; stderr: string }) => error);
    expect(output).toMatchObject({ code: 1, stderr: '' });
    expect(JSON.parse(output.stdout)).toMatchObject({ tripId, target: 'emulator', summary: { issueCount: 6 } });
    await expect(runFile(process.execPath, [...command, '--page-size', '0'], { env })).rejects.toMatchObject({ code: 2 });
  }, 40_000);

  it('reports broken owner, participant links, ledger references, schemas and receipt claims', async () => {
    const { store, trip, tripId, ownerUid, guest, expenseId } = await makeLedger();
    const expense = trip.collection('expenses').doc(expenseId);
    const receipt = trip.collection('receipts').doc(randomUUID());
    const missingReceipt = randomUUID();
    const otherOwner = trip.collection('memberships').doc(randomUUID());
    const missingParticipant = randomUUID();
    const batch = store.batch();
    batch.delete(trip.collection('participantLinks').doc(ownerUid));
    batch.delete(trip.collection('balances').doc(guest));
    batch.set(otherOwner, { role: 'owner', status: 'active', participantId: guest });
    batch.set(receipt, { schemaVersion: 1, tripId: randomUUID(), status: 'ready', attachedExpenseId: expenseId });
    batch.update(expense, { payerParticipantId: missingParticipant, receiptIds: [receipt.id, missingReceipt] });
    await batch.commit();

    const report = await checkDatabase(store, { tripId, pageSize: 2 });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'OWNER_INVARIANT_FAILED', path: trip.path }),
      expect.objectContaining({ code: 'LEGACY_SCHEMA', path: otherOwner.path, fields: expect.arrayContaining(['schemaVersion', 'uid']) }),
      expect.objectContaining({ code: 'INVALID_SCHEMA', path: receipt.path }),
      expect.objectContaining({ code: 'PARTICIPANT_LINK_MISMATCH', path: `${trip.path}/memberships/${ownerUid}` }),
      expect.objectContaining({ code: 'BALANCE_MISSING', path: `${trip.path}/balances/${guest}` }),
      expect.objectContaining({ code: 'RECEIPT_MISSING', path: expense.path, relatedPath: `${trip.path}/receipts/${missingReceipt}` }),
      expect.objectContaining({ code: 'RECEIPT_CLAIM_MISMATCH', path: expense.path, relatedPath: receipt.path }),
      expect.objectContaining({ code: 'LEDGER_PARTICIPANT_MISSING', path: expense.path, relatedPath: `${trip.path}/participants/${missingParticipant}` }),
      { code: 'RECONCILIATION_SKIPPED', path: trip.path },
    ]));
    expect(report.issues.some(issue => issue.fields?.includes('totalExpenseMinor'))).toBe(false);
  }, 30_000);

  it('discards an unstable paginated read and never publishes a tentative difference', async () => {
    const { store, trip, tripId } = await makeLedger();
    const firstPage = trip.collection('expenses').orderBy(FieldPath.documentId()).limit(1);
    const queryPrototype = Object.getPrototypeOf(firstPage) as FirebaseFirestore.Query;
    const read = queryPrototype.get;
    const scope = { tripId, pageSize: 1 };
    await trip.update({ totalExpenseMinor: 151 });
    let firstPages = 0;
    let keepChanging = false;
    const spy = vi.spyOn(queryPrototype, 'get').mockImplementation(async function (this: FirebaseFirestore.Query) {
      const page = await read.call(this);
      if (this.isEqual(firstPage)) {
        firstPages++;
        if (firstPages === 1 || keepChanging) {
          const now = Timestamp.now();
          const changes = { revision: FieldValue.increment(1), updatedAt: now,
            ...(keepChanging ? {} : { ledgerVersion: FieldValue.increment(1) }) };
          const batch = store.batch();
          batch.update(trip, { ...changes, totalExpenseMinor: 120 });
          batch.update(trip.collection('signals').doc('current'), changes);
          await batch.commit();
        }
      }
      return page;
    });
    try {
      expect((await checkDatabase(store, scope)).issues).toEqual([]);
      expect(firstPages).toBe(2);
      keepChanging = true;
      const report = await checkDatabase(store, scope);
      expect(firstPages).toBe(4);
      expect(report.summary).toMatchObject({ tripsScanned: 1, tripsChecked: 0, issueCount: 1 });
      expect(report.issues).toEqual([{ code: 'TRIP_CHANGED_DURING_SCAN', path: trip.path }]);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});
