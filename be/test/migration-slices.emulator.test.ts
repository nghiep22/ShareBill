import { createHash, randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { db } from '../src/firebase.js';
import { tripsMigration, linksMigration } from '../src/database/migrations/002-trips-links.js';
import { ledgerMigration } from '../src/database/migrations/003-ledger.js';
import { projectionsMigration } from '../src/database/migrations/004-projection-metadata.js';
import { operationsMigration } from '../src/database/migrations/005-operations.js';
import { auditBaselineMigration } from '../src/database/migrations/006-audit-baseline.js';
import { runMigration, type Migration } from '../src/database/migrations/runner.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) { process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill'; process.env.FIREBASE_WEB_API_KEY ??= 'demo'; }

describe.skipIf(!enabled)('legacy trip migration slices', () => {
  it('fills only verified metadata and preserves money, operations and original audit', async () => {
    const app = await buildApp();
    const store = db();
    try {
      const authResponse = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
        email: `migration-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: 'An',
      } });
      expect(authResponse.statusCode).toBe(201);
      const { accessToken, user } = authResponse.json().data;
      async function post(path: string, payload: object) {
        const response = await app.inject({ method: 'POST', url: path, payload,
          headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': randomUUID() } });
        expect(response.statusCode, response.body).toBe(200);
        return response.json().data;
      }
      const tripData = await post('/api/v1/trips', { name: 'Migration local', sharingMode: 'per-expense', ownerName: 'An' });
      const tripId = tripData.id as string;
      const owner = tripData.ownerParticipantId as string;
      const trip = store.doc(`trips/${tripId}`);
      const guest = (await post(`/api/v1/trips/${tripId}/participants`, { displayName: 'Bình' })).id as string;
      const expenseBody = { title: 'Bữa trưa', amountMinor: 120, payerParticipantId: owner,
        splitMethod: 'equal', split: { participantIds: [owner, guest] }, occurredOn: '2026-12-20',
        category: 'food', note: null };
      const expenseData = await post(`/api/v1/trips/${tripId}/expenses`, expenseBody);
      const expense = trip.collection('expenses').doc(expenseData.id);
      const settlementData = await post(`/api/v1/trips/${tripId}/settlements`, {
        fromParticipantId: guest, toParticipantId: owner, amountMinor: 10, occurredOn: '2026-12-20',
        note: null, basedOnLedgerVersion: 1,
      });
      const settlement = trip.collection('settlements').doc(settlementData.id);
      const balance = trip.collection('balances').doc(owner);
      const signal = trip.collection('signals').doc('current');
      const link = trip.collection('participantLinks').doc(user.uid);
      const participant = trip.collection('participants').doc(owner);
      const legacyKey = randomUUID();
      const legacyOperation = store.doc(`users/${user.uid}/operations/${legacyKey}`);
      const oldBody = { ...expenseBody };
      const legacyAudit = trip.collection('auditEvents').doc(randomUUID());
      const original = {
        expense: (await expense.get()).data()!, settlement: (await settlement.get()).data()!,
        balance: (await balance.get()).data()!, trip: (await trip.get()).data()!,
      };
      const batch = store.batch();
      batch.update(trip, { destination: FieldValue.delete(), note: FieldValue.delete(), schemaVersion: FieldValue.delete() });
      batch.update(participant, { schemaVersion: FieldValue.delete(), hasLedgerReferences: FieldValue.delete(),
        linkedUid: FieldValue.delete() });
      batch.delete(link);
      batch.update(expense, { schemaVersion: FieldValue.delete(), currency: FieldValue.delete(),
        splitInput: FieldValue.delete(), split: expenseBody.split, receiptIds: FieldValue.delete(),
        voidedAt: FieldValue.delete(), voidedBy: FieldValue.delete(), voidReason: FieldValue.delete() });
      batch.update(settlement, { schemaVersion: FieldValue.delete(), currency: FieldValue.delete(),
        confirmedBy: FieldValue.delete(), confirmedAt: FieldValue.delete(), confirmationMode: FieldValue.delete(),
        cancelledBy: FieldValue.delete(), cancelledAt: FieldValue.delete(), voidedBy: FieldValue.delete(),
        voidedAt: FieldValue.delete(), voidReason: FieldValue.delete() });
      batch.update(balance, { schemaVersion: FieldValue.delete(), updatedAt: FieldValue.delete() });
      batch.update(signal, { schemaVersion: FieldValue.delete(), updatedAt: FieldValue.delete() });
      batch.create(legacyOperation, { path: `/api/v1/trips/${tripId}/expenses`,
        requestHash: createHash('sha256').update(JSON.stringify(oldBody)).digest('hex'),
        response: expenseData, tripId, committedAt: original.expense.createdAt });
      batch.create(legacyAudit, { action: 'expense.created', entityId: expense.id, createdAt: original.expense.createdAt });
      await batch.commit();
      const replayBefore = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/expenses`,
        payload: expenseBody, headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': legacyKey } });
      expect(replayBefore.statusCode, replayBefore.body).toBe(200);
      expect(replayBefore.json().data.id).toBe(expense.id);

      const refs = [trip, expense, settlement, legacyOperation];
      const scoped = (migration: Migration, targets: FirebaseFirestore.DocumentReference[]): Migration => ({
        ...migration, id: `${migration.id}-test-${randomUUID()}`,
        scan: async function* () { for (const ref of targets) yield { key: ref.path, ref }; },
      });
      const stages = [
        scoped(tripsMigration, [trip]), scoped(linksMigration, [trip]),
        scoped(ledgerMigration, [expense, settlement]), scoped(projectionsMigration, [trip]),
        scoped(operationsMigration, [legacyOperation]), scoped(auditBaselineMigration, [trip]),
      ];
      const dry = await Promise.all(stages.map(stage => runMigration(store, stage,
        { projectId: 'demo-sharebill', apply: false, pageSize: 1 })));
      expect(dry.filter((_, index) => index !== 3).every(report => report.failed === 0)).toBe(true);
      expect(dry[3]?.issues).toEqual([{ code: 'TRIP_SCHEMA_UNRESOLVED', path: trip.path }]);
      expect((await expense.get()).get('schemaVersion')).toBeUndefined();
      for (const stage of stages) {
        const report = await runMigration(store, stage, { projectId: 'demo-sharebill', apply: true, pageSize: 1 });
        expect(report.issues).toEqual([]);
        expect(report.completed).toBe(true);
      }
      expect((await trip.get()).get('schemaVersion')).toBe(1);
      expect((await link.get()).get('participantId')).toBe(owner);
      await link.update({ schemaVersion: FieldValue.delete(), updatedAt: FieldValue.delete() });
      const linkMetadata = await runMigration(store, scoped(linksMigration, [trip]),
        { projectId: 'demo-sharebill', apply: true, pageSize: 1 });
      expect(linkMetadata).toMatchObject({ completed: true, failed: 0 });
      expect((await link.get()).get('schemaVersion')).toBe(1);
      expect((await participant.get()).get('hasLedgerReferences')).toBe(true);
      expect((await participant.get()).get('linkedUid')).toBe(user.uid);
      expect((await expense.get()).data()).toMatchObject({ schemaVersion: 1, currency: 'VND',
        splitInput: expenseBody.split, amountMinor: original.expense.amountMinor, shares: original.expense.shares });
      expect((await expense.get()).get('split')).toBeUndefined();
      expect((await settlement.get()).data()).toMatchObject({ schemaVersion: 1, currency: 'VND',
        amountMinor: original.settlement.amountMinor, status: original.settlement.status });
      expect((await balance.get()).data()).toMatchObject({ schemaVersion: 1, paidMinor: original.balance.paidMinor,
        owedMinor: original.balance.owedMinor, netMinor: original.balance.netMinor });
      expect((await trip.get()).get('totalExpenseMinor')).toBe(original.trip.totalExpenseMinor);
      expect((await legacyOperation.get()).get('canonicalPath')).toBe(`/api/v1/trips/${tripId}/expenses`);
      expect((await legacyOperation.get()).get('responseSnapshot.data.id')).toBe(expense.id);
      const replayAfter = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/expenses`,
        payload: expenseBody, headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': legacyKey } });
      expect(replayAfter.statusCode, replayAfter.body).toBe(200);
      expect(replayAfter.json().data.id).toBe(expense.id);
      expect((await trip.collection('expenses').get()).size).toBe(1);
      expect((await legacyAudit.get()).data()).toEqual({ action: 'expense.created', entityId: expense.id,
        createdAt: original.expense.createdAt });
      expect((await trip.collection('migrationBaselines').doc('DBM-007-audit').get()).get('legacyEventPaths')).toContain(legacyAudit.path);
      const second = await runMigration(store, stages[2]!, { projectId: 'demo-sharebill', apply: true, pageSize: 1 });
      expect(second).toMatchObject({ completed: true, changed: 2 });
      const auditAgain = await runMigration(store, scoped(auditBaselineMigration, [trip]),
        { projectId: 'demo-sharebill', apply: true, pageSize: 1 });
      expect(auditAgain).toMatchObject({ completed: true, changed: 0 });
      expect(auditAgain.exceptions).toContainEqual({ code: 'LEGACY_AUDIT_EVENT', path: legacyAudit.path });

      const unresolvedOperation = store.doc(`users/${user.uid}/operations/${randomUUID()}`);
      await unresolvedOperation.set({ path: `/api/v1/trips/${tripId}/expenses`, requestHash: '0'.repeat(64),
        tripId, committedAt: original.expense.createdAt });
      const retained = await runMigration(store, scoped(operationsMigration, [unresolvedOperation]),
        { projectId: 'demo-sharebill', apply: true, pageSize: 1 });
      expect(retained).toMatchObject({ completed: true, changed: 0, failed: 0 });
      expect(retained.exceptions).toEqual([{ code: 'LEGACY_OPERATION_RETAINED', path: unresolvedOperation.path }]);
      expect((await unresolvedOperation.get()).get('canonicalPath')).toBeUndefined();

      await expense.update({ shares: [{ participantId: owner, amountMinor: 1 }] });
      const invalidShares = await runMigration(store, scoped(ledgerMigration, [expense]),
        { projectId: 'demo-sharebill', apply: true, pageSize: 1 });
      expect(invalidShares).toMatchObject({ completed: false, changed: 0, failed: 1 });
      expect(invalidShares.issues).toContainEqual({ code: 'INVALID_EXPENSE_SHARES', path: expense.path });
      expect((await expense.get()).get('shares')).toEqual([{ participantId: owner, amountMinor: 1 }]);
      await expense.update({ shares: original.expense.shares });

      await trip.update({ totalExpenseMinor: original.trip.totalExpenseMinor + 1 });
      const mismatch = await runMigration(store, scoped(projectionsMigration, [trip]),
        { projectId: 'demo-sharebill', apply: true, pageSize: 1 });
      expect(mismatch).toMatchObject({ completed: false, changed: 0, failed: 1 });
      expect(mismatch.issues).toContainEqual({ code: 'PROJECTION_MISMATCH', path: trip.path,
        fields: ['totalExpenseMinor'] });
      expect((await trip.get()).get('totalExpenseMinor')).toBe(original.trip.totalExpenseMinor + 1);
      await trip.update({ totalExpenseMinor: original.trip.totalExpenseMinor });

      await balance.update({ paidMinor: original.balance.paidMinor + 1 });
      await signal.update({ ledgerVersion: original.trip.ledgerVersion + 1 });
      const projectionConflicts = await runMigration(store, scoped(projectionsMigration, [trip]),
        { projectId: 'demo-sharebill', apply: false, pageSize: 1 });
      expect(projectionConflicts.issues).toContainEqual({ code: 'PROJECTION_MISMATCH', path: balance.path,
        fields: ['paidMinor'] });
      expect(projectionConflicts.issues).toContainEqual({ code: 'SIGNAL_MISMATCH', path: signal.path });
      await balance.update({ paidMinor: original.balance.paidMinor });
      await signal.update({ ledgerVersion: original.trip.ledgerVersion });

      await expense.update({ status: 'void', schemaVersion: FieldValue.delete(),
        voidedAt: original.expense.createdAt, voidedBy: user.uid, voidReason: 'test' });
      await settlement.update({ status: 'confirmed', schemaVersion: FieldValue.delete(),
        confirmedAt: original.settlement.createdAt, confirmedBy: user.uid, confirmationMode: 'recipient' });
      const states = await runMigration(store, scoped(ledgerMigration, [expense, settlement]),
        { projectId: 'demo-sharebill', apply: true, pageSize: 1 });
      expect(states).toMatchObject({ completed: true, failed: 0 });
      expect((await expense.get()).data()).toMatchObject({ status: 'void', amountMinor: original.expense.amountMinor,
        shares: original.expense.shares, voidedBy: user.uid });
      expect((await settlement.get()).data()).toMatchObject({ status: 'confirmed',
        amountMinor: original.settlement.amountMinor, confirmedBy: user.uid });
      await expense.update({ status: original.expense.status, voidedAt: null, voidedBy: null, voidReason: null });
      await settlement.update({ status: original.settlement.status, confirmedAt: null,
        confirmedBy: null, confirmationMode: null });

      const extra = trip.collection('participants').doc(randomUUID());
      await extra.set({ ...(await participant.get()).data(), id: extra.id });
      const linkConflict = await runMigration(store, scoped(linksMigration, [trip]),
        { projectId: 'demo-sharebill', apply: false, pageSize: 1 });
      expect(linkConflict.issues).toContainEqual({ code: 'PARTICIPANT_LINK_CONFLICT', path: extra.path });
      await extra.delete();

      const removedUid = `removed-${randomUUID()}`;
      const removed = trip.collection('memberships').doc(removedUid);
      const removedRef = store.doc(`users/${removedUid}/tripRefs/${tripId}`);
      await removed.set({ schemaVersion: 1, uid: removedUid, role: 'member', status: 'removed',
        participantId: null, version: 1, joinedAt: original.trip.createdAt,
        updatedAt: original.trip.createdAt, removedAt: original.trip.createdAt });
      const removedReport = await runMigration(store, scoped(linksMigration, [trip]),
        { projectId: 'demo-sharebill', apply: true, pageSize: 1 });
      expect(removedReport).toMatchObject({ completed: true });
      expect((await removedRef.get()).get('status')).toBe('removed');
      expect(refs.every(Boolean)).toBe(true);
    } finally { await app.close(); }
  }, 30_000);
});
