import { Timestamp } from 'firebase-admin/firestore';
import { EXPENSE_CATEGORIES } from '../../domain/money.js';
import { expenseLedgerSchema, settlementLedgerSchema, tripSchema, balanceSchema, signalSchema } from '../integrity-schemas.js';
import { reconcileLedger } from '../reconcile.js';
import { scanCollection, type Migration, type MigrationIssue, type Plan } from './runner.js';

export const projectionsMigration: Migration = {
  id: 'DBM-005-projections', revision: '1',
  scan: (store, pageSize) => scanCollection(store.collection('trips'), pageSize),
  async plan(_store, ref): Promise<Plan> {
    const [trip, participantRows, membershipRows, expenseRows, settlementRows, balanceRows, signal] = await Promise.all([
      ref.get(), ref.collection('participants').get(), ref.collection('memberships').get(),
      ref.collection('expenses').get(), ref.collection('settlements').get(), ref.collection('balances').get(),
      ref.collection('signals').doc('current').get(),
    ]);
    const all = [trip, ...participantRows.docs, ...membershipRows.docs, ...expenseRows.docs,
      ...settlementRows.docs, ...balanceRows.docs, signal];
    const guards = all.map(doc => ({ ref: doc.ref, updateTime: doc.updateTime ?? null }));
    if (!trip.exists) return { guards, changes: [], issues: [] };
    const issues: MigrationIssue[] = [];
    const expenses = expenseRows.docs.map(doc => expenseLedgerSchema.safeParse(doc.data()));
    const settlements = settlementRows.docs.map(doc => settlementLedgerSchema.safeParse(doc.data()));
    if (expenses.some(result => !result.success) || settlements.some(result => !result.success)) {
      return { guards, changes: [], issues: [{ code: 'INVALID_LEDGER_RECORD', path: ref.path }] };
    }
    const participantIds = participantRows.docs.map(doc => doc.id);
    const allIds = new Set(participantIds);
    if (expenses.some(result => result.success && (!allIds.has(result.data.payerParticipantId) ||
        result.data.shares.some(share => !allIds.has(share.participantId)))) ||
        settlements.some(result => result.success && (!allIds.has(result.data.fromParticipantId) || !allIds.has(result.data.toParticipantId)))) {
      return { guards, changes: [], issues: [{ code: 'LEDGER_PARTICIPANT_MISSING', path: ref.path }] };
    }
    let projection;
    try { projection = reconcileLedger(participantIds,
      expenses.map(result => result.data!), settlements.map(result => result.data!)); }
    catch { return { guards, changes: [], issues: [{ code: 'INVALID_LEDGER_RECORD', path: ref.path }] }; }
    const expected: Record<string, number> = {
      participantCount: participantIds.length, membershipCountAllTime: membershipRows.size,
      ...projection.counts, totalExpenseMinor: projection.totalExpenseMinor,
    };
    for (const category of EXPENSE_CATEGORIES) expected[`categoryTotalsMinor.${category}`] = projection.categoryTotalsMinor[category];
    const tripData = trip.data()!;
    const tripPatch: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(expected)) {
      const [parent, child] = field.split('.');
      const actual = child ? tripData[parent!]?.[child] : tripData[field];
      if (actual === undefined) {
        if (child) {
          tripPatch.categoryTotalsMinor ??= { ...tripData.categoryTotalsMinor };
          (tripPatch.categoryTotalsMinor as Record<string, number>)[child] = value;
        } else tripPatch[field] = value;
      } else if (actual !== value) issues.push({ code: 'PROJECTION_MISMATCH', path: ref.path, fields: [field] });
    }
    const changes: Plan['changes'] = [];
    for (const participantId of participantIds) {
      const balance = balanceRows.docs.find(doc => doc.id === participantId);
      if (!balance) { issues.push({ code: 'BALANCE_MISSING', path: `${ref.path}/balances/${participantId}` }); continue; }
      const expectedBalance = projection.balances.get(participantId)!;
      const stored = balance.data();
      for (const field of ['paidMinor', 'owedMinor', 'sentMinor', 'receivedMinor', 'netMinor'] as const) {
        if (stored[field] !== expectedBalance[field]) issues.push({ code: 'PROJECTION_MISMATCH', path: balance.ref.path, fields: [field] });
      }
      const patch = Object.fromEntries(Object.entries({ schemaVersion: 1, participantId,
        updatedAt: balance.updateTime }).filter(([field]) => stored[field] === undefined));
      if (!balanceSchema.safeParse({ ...stored, ...patch }).success) issues.push({ code: 'BALANCE_SCHEMA_UNRESOLVED', path: balance.ref.path });
      else if (Object.keys(patch).length) changes.push({ ref: balance.ref, data: patch });
    }
    const rootPatch = { ...tripPatch, ...(tripData.schemaVersion === undefined ? { schemaVersion: 1 } : {}) };
    const mergedTrip = { ...tripData, ...rootPatch };
    if (!tripSchema.safeParse(mergedTrip).success) issues.push({ code: 'TRIP_SCHEMA_UNRESOLVED', path: ref.path });
    if (Object.keys(rootPatch).length) changes.push({ ref, data: rootPatch });
    if (!signal.exists) {
      if (!Number.isSafeInteger(tripData.revision) || !Number.isSafeInteger(tripData.ledgerVersion)) issues.push({ code: 'SIGNAL_SOURCE_UNAVAILABLE', path: signal.ref.path });
      else changes.push({ ref: signal.ref, create: true, data: { schemaVersion: 1, revision: tripData.revision,
        ledgerVersion: tripData.ledgerVersion, updatedAt: trip.updateTime ?? Timestamp.now() } });
    } else {
      const stored = signal.data()!;
      if (stored.revision !== tripData.revision || stored.ledgerVersion !== tripData.ledgerVersion) {
        issues.push({ code: 'SIGNAL_MISMATCH', path: signal.ref.path });
      }
      const patch = Object.fromEntries(Object.entries({ schemaVersion: 1, updatedAt: signal.updateTime })
        .filter(([field]) => stored[field] === undefined));
      if (!signalSchema.safeParse({ ...stored, ...patch }).success) issues.push({ code: 'SIGNAL_SCHEMA_UNRESOLVED', path: signal.ref.path });
      else if (Object.keys(patch).length) changes.push({ ref: signal.ref, data: patch });
    }
    return { guards, changes, issues };
  },
};
