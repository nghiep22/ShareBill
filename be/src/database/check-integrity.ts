import { FieldPath } from 'firebase-admin/firestore';
import { z } from 'zod';
import { EXPENSE_CATEGORIES, validateExact } from '../domain/money.js';
import { auditEventSchema } from './audit.js';
import { expenseDocumentSchema } from './expense.js';
import {
  balanceSchema, entityId, expenseLedgerSchema, membershipSchema, participantLinkSchema, participantSchema,
  receiptSchema, settlementLedgerSchema, signalSchema, tripRefSchema, tripSchema, uid,
} from './integrity-schemas.js';
import { operationDocumentSchema } from './operation.js';
import { reconcileLedger, type LedgerExpense, type LedgerSettlement } from './reconcile.js';
import { settlementDocumentSchema } from './settlement.js';
import { userDocumentSchema } from './user.js';

type Snapshot = FirebaseFirestore.DocumentSnapshot;
type Documents = Map<string, FirebaseFirestore.QueryDocumentSnapshot>;
type Store = FirebaseFirestore.Firestore;

export type IntegrityIssue = {
  code: string;
  path: string;
  fields?: string[];
  relatedPath?: string;
  diff?: { expected: number; actual: number | null };
};

const MAX_LEDGER_ROWS = 2000;
const SCAN_ATTEMPTS = 2;
const balanceFields = ['paidMinor', 'owedMinor', 'sentMinor', 'receivedMinor', 'netMinor'] as const;

async function* pages(query: FirebaseFirestore.Query, pageSize: number, maxRows = Infinity) {
  const ordered = query.orderBy(FieldPath.documentId());
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let remaining = maxRows;
  while (remaining > 0) {
    const limit = Math.min(remaining, pageSize);
    const page = await (cursor ? ordered.startAfter(cursor) : ordered).limit(limit).get();
    if (page.empty) return;
    yield page.docs;
    if (page.size < limit) return;
    remaining -= page.size;
    cursor = page.docs.at(-1);
  }
}

function reportSchema(
  snapshot: Snapshot, schema: z.ZodType, issues: IntegrityIssue[], idField?: string, legacy = snapshot.get('schemaVersion') === undefined,
) {
  const result = schema.safeParse(snapshot.data());
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map(issue => issue.path.join('.') || '$'))];
    issues.push({ code: legacy ? 'LEGACY_SCHEMA' : 'INVALID_SCHEMA', path: snapshot.ref.path, fields });
  }
  if (idField && typeof snapshot.get(idField) === 'string' && snapshot.get(idField) !== snapshot.id) {
    issues.push({ code: 'DOCUMENT_ID_MISMATCH', path: snapshot.ref.path, fields: [idField] });
  }
}

function compareNumber(snapshot: Snapshot, field: string, expected: number, issues: IntegrityIssue[]) {
  const actual = snapshot.get(field);
  if (actual !== expected) {
    issues.push({ code: 'PROJECTION_MISMATCH', path: snapshot.ref.path, fields: [field],
      diff: { expected, actual: typeof actual === 'number' && Number.isSafeInteger(actual) ? actual : null } });
  }
}

async function readDocuments(
  collection: FirebaseFirestore.CollectionReference, pageSize: number, issues: IntegrityIssue[], schema: z.ZodType, idField?: string,
  maxDocuments = Infinity,
) {
  const documents: Documents = new Map();
  for await (const page of pages(collection, pageSize, maxDocuments + 1)) {
    for (const snapshot of page) {
      if (documents.size === maxDocuments) {
        issues.push({ code: 'SCAN_LIMIT_EXCEEDED', path: collection.path });
        return { documents, complete: false };
      }
      documents.set(snapshot.id, snapshot);
      reportSchema(snapshot, schema, issues, idField);
    }
  }
  return { documents, complete: true };
}

async function checkMemberships(
  store: Store, trip: Snapshot, pageSize: number, issues: IntegrityIssue[], members: Documents,
  participants: Documents, links: Documents, validateProfiles: boolean,
) {
  const owners = [...members.values()].filter(member => member.get('role') === 'owner' && member.get('status') === 'active');
  if (trip.get('sharingMode') === 'group-equal' && trip.get('status') === 'active') {
    const expected = [...members.values()].filter(member => member.get('status') === 'active').map(member => member.get('participantId')).sort();
    const stored = trip.get('equalParticipantIds');
    if (!Array.isArray(stored) || expected.some(id => !id) || JSON.stringify([...stored].sort()) !== JSON.stringify(expected)) {
      issues.push({ code: 'GROUP_MEMBERSHIP_MISMATCH', path: trip.ref.path, fields: ['equalParticipantIds'] });
    }
  }
  if (owners.length !== 1 || owners[0]?.id !== trip.get('ownerUid') ||
      !entityId.safeParse(owners[0]?.get('participantId')).success) {
    issues.push({ code: 'OWNER_INVARIANT_FAILED', path: trip.ref.path, fields: ['ownerUid'] });
  }

  for (const member of members.values()) {
    const participantId = member.get('participantId');
    if (participantId == null) continue;
    if (participants.get(participantId)?.get('linkedUid') !== member.id || links.get(member.id)?.get('participantId') !== participantId) {
      issues.push({ code: 'PARTICIPANT_LINK_MISMATCH', path: member.ref.path, fields: ['participantId'] });
    }
  }
  for (const participant of participants.values()) {
    const linkedUid = participant.get('linkedUid');
    if (linkedUid != null && members.get(linkedUid)?.get('participantId') !== participant.id) {
      issues.push({ code: 'PARTICIPANT_LINK_MISMATCH', path: participant.ref.path, fields: ['linkedUid'] });
    }
  }
  for (const link of links.values()) {
    if (!members.has(link.id) || members.get(link.id)?.get('participantId') !== link.get('participantId')) {
      issues.push({ code: 'PARTICIPANT_LINK_MISMATCH', path: link.ref.path, fields: ['participantId'] });
    }
  }

  const memberList = [...members.values()];
  for (let offset = 0; offset < memberList.length; offset += pageSize) {
    const refs = memberList.slice(offset, offset + pageSize).flatMap(member =>
      [store.doc(`users/${member.id}`), store.doc(`users/${member.id}/tripRefs/${trip.id}`)]);
    for (const snapshot of await store.getAll(...refs)) {
      if (snapshot.ref.parent.id === 'users') {
        if (!snapshot.exists) issues.push({ code: 'MEMBER_PROFILE_MISSING', path: snapshot.ref.path });
        else if (validateProfiles) reportSchema(snapshot, userDocumentSchema, issues);
      } else {
        const member = members.get(snapshot.ref.parent.parent!.id)!;
        if (!snapshot.exists) issues.push({ code: 'TRIP_REF_MISSING', path: snapshot.ref.path, relatedPath: member.ref.path });
        else {
          reportSchema(snapshot, tripRefSchema, issues, 'tripId');
          if (snapshot.get('status') !== member.get('status')) {
            issues.push({ code: 'TRIP_REF_STATUS_MISMATCH', path: snapshot.ref.path, relatedPath: member.ref.path, fields: ['status'] });
          }
        }
      }
    }
  }
}

function checkReceipts(trip: Snapshot, expenses: Documents, receipts: Documents, issues: IntegrityIssue[]) {
  for (const expense of expenses.values()) {
    const ids: unknown = expense.get('receiptIds');
    if (!Array.isArray(ids)) continue;
    for (const receiptId of new Set(ids)) {
      if (!entityId.safeParse(receiptId).success) continue;
      const receipt = receipts.get(receiptId);
      const relatedPath = `${trip.ref.path}/receipts/${receiptId}`;
      if (!receipt) issues.push({ code: 'RECEIPT_MISSING', path: expense.ref.path, relatedPath, fields: ['receiptIds'] });
      else if (receipt.get('tripId') !== trip.id || receipt.get('status') !== 'attached' || receipt.get('attachedExpenseId') !== expense.id) {
        issues.push({ code: 'RECEIPT_CLAIM_MISMATCH', path: expense.ref.path, relatedPath, fields: ['receiptIds'] });
      }
    }
  }
  for (const receipt of receipts.values()) {
    if (receipt.get('tripId') !== trip.id) {
      issues.push({ code: 'RECEIPT_TRIP_MISMATCH', path: receipt.ref.path, fields: ['tripId'] });
    }
    const expenseId = receipt.get('attachedExpenseId');
    const refs: unknown = expenses.get(expenseId)?.get('receiptIds');
    const attached = receipt.get('status') === 'attached';
    if (attached ? !Array.isArray(refs) || !refs.includes(receipt.id) : expenseId != null) {
      issues.push({ code: 'RECEIPT_CLAIM_MISMATCH', path: receipt.ref.path, fields: ['attachedExpenseId'] });
    }
  }
}

function checkLedger(
  trip: Snapshot, participants: Documents, expenses: Documents, settlements: Documents, balances: Documents,
  complete: boolean, issues: IntegrityIssue[],
) {
  const expenseRows: LedgerExpense[] = [];
  const settlementRows: LedgerSettlement[] = [];
  const referencedParticipants = new Set<string>();
  const checkReferences = (snapshot: Snapshot, ids: string[]) => {
    let valid = true;
    for (const id of new Set(ids)) {
      referencedParticipants.add(id);
      if (!participants.has(id)) {
        issues.push({ code: 'LEDGER_PARTICIPANT_MISSING', path: snapshot.ref.path, relatedPath: `${trip.ref.path}/participants/${id}` });
        valid = false;
      }
    }
    return valid;
  };
  for (const expense of expenses.values()) {
    const result = expenseLedgerSchema.safeParse(expense.data());
    if (!result.success) {
      issues.push({ code: 'INVALID_LEDGER_RECORD', path: expense.ref.path, fields: result.error.issues.map(issue => issue.path.join('.')) });
      continue;
    }
    const { payerParticipantId, amountMinor, shares } = result.data;
    const referencesValid = checkReferences(expense, [payerParticipantId, ...shares.map(share => share.participantId)]);
    try { validateExact(amountMinor, shares); }
    catch {
      issues.push({ code: 'INVALID_EXPENSE_SHARES', path: expense.ref.path, fields: ['shares'] });
      continue;
    }
    if (referencesValid) expenseRows.push(result.data);
  }
  for (const settlement of settlements.values()) {
    const result = settlementLedgerSchema.safeParse(settlement.data());
    if (!result.success) {
      issues.push({ code: 'INVALID_LEDGER_RECORD', path: settlement.ref.path, fields: result.error.issues.map(issue => issue.path.join('.')) });
      continue;
    }
    if (checkReferences(settlement, [result.data.fromParticipantId, result.data.toParticipantId])) settlementRows.push(result.data);
  }
  for (const participant of participants.values()) {
    if (!balances.has(participant.id)) {
      issues.push({ code: 'BALANCE_MISSING', path: `${trip.ref.path}/balances/${participant.id}`, relatedPath: participant.ref.path });
    }
    if (referencedParticipants.has(participant.id) && participant.get('hasLedgerReferences') === false) {
      issues.push({ code: 'LEDGER_REFERENCE_FLAG_MISSING', path: participant.ref.path, fields: ['hasLedgerReferences'] });
    }
  }
  for (const balance of balances.values()) {
    if (!participants.has(balance.id)) issues.push({ code: 'BALANCE_ORPHAN', path: balance.ref.path });
  }

  if (!complete || expenseRows.length !== expenses.size || settlementRows.length !== settlements.size) {
    issues.push({ code: 'RECONCILIATION_SKIPPED', path: trip.ref.path });
    return;
  }
  const equalIds = trip.get('sharingMode') === 'group-equal' ? trip.get('equalParticipantIds') : undefined;
  if (trip.get('sharingMode') === 'group-equal' && (!Array.isArray(equalIds) || !equalIds.length || equalIds.length > 50 ||
      new Set(equalIds).size !== equalIds.length || equalIds.some(id => !participants.has(id)))) {
    issues.push({ code: 'GROUP_SHARING_INVARIANT_FAILED', path: trip.ref.path, fields: ['equalParticipantIds'] });
    return;
  }
  const result = reconcileLedger(participants.keys(), expenseRows, settlementRows, equalIds);
  for (const [field, value] of Object.entries(result.counts)) compareNumber(trip, field, value, issues);
  compareNumber(trip, 'totalExpenseMinor', result.totalExpenseMinor, issues);
  for (const category of EXPENSE_CATEGORIES) {
    compareNumber(trip, `categoryTotalsMinor.${category}`, result.categoryTotalsMinor[category], issues);
  }
  for (const [id, expected] of result.balances) {
    const balance = balances.get(id);
    if (balance) for (const field of balanceFields) compareNumber(balance, field, expected[field], issues);
  }
}

async function checkAudit(store: Store, trip: Snapshot, pageSize: number, issues: IntegrityIssue[]) {
  for await (const page of pages(trip.ref.collection('auditEvents'), pageSize)) {
    const operationRefs = new Map<string, FirebaseFirestore.DocumentReference>();
    for (const event of page) {
      reportSchema(event, auditEventSchema, issues, 'eventId');
      const actor = uid.safeParse(event.get('actorUid'));
      const key = entityId.safeParse(event.get('operationKey'));
      if (actor.success && key.success) {
        const ref = store.doc(`users/${actor.data}/operations/${key.data}`);
        operationRefs.set(ref.path, ref);
      }
    }
    if (!operationRefs.size) continue;
    for (const snapshot of await store.getAll(...operationRefs.values())) {
      if (!snapshot.exists) issues.push({ code: 'AUDIT_OPERATION_MISSING', path: snapshot.ref.path });
      else {
        reportSchema(snapshot, operationDocumentSchema, issues, undefined, snapshot.get('canonicalPath') === undefined);
        if (snapshot.get('canonicalPath') !== undefined &&
            (snapshot.get('actorUid') !== snapshot.ref.parent.parent!.id || snapshot.get('tripId') !== trip.id)) {
          issues.push({ code: 'AUDIT_OPERATION_SCOPE_MISMATCH', path: snapshot.ref.path, relatedPath: trip.ref.path });
        }
      }
    }
  }
}

async function inspectTrip(store: Store, trip: Snapshot, pageSize: number, validateProfiles: boolean): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  reportSchema(trip, tripSchema, issues, 'id');
  const collection = (name: string, schema: z.ZodType, idField?: string, max?: number) =>
    readDocuments(trip.ref.collection(name), pageSize, issues, schema, idField, max);
  const [members, links, participants, balances, receipts, expenses, settlements, signal] = await Promise.all([
    collection('memberships', membershipSchema, 'uid'), collection('participantLinks', participantLinkSchema, 'uid'),
    collection('participants', participantSchema, 'id'), collection('balances', balanceSchema, 'participantId'),
    collection('receipts', receiptSchema), collection('expenses', expenseDocumentSchema, 'id', MAX_LEDGER_ROWS),
    collection('settlements', settlementDocumentSchema, 'id', MAX_LEDGER_ROWS), trip.ref.collection('signals').doc('current').get(),
  ]);
  compareNumber(trip, 'participantCount', participants.documents.size, issues);
  compareNumber(trip, 'membershipCountAllTime', members.documents.size, issues);

  if (!signal.exists) issues.push({ code: 'SIGNAL_MISSING', path: signal.ref.path });
  else {
    reportSchema(signal, signalSchema, issues);
    for (const field of ['revision', 'ledgerVersion']) {
      const expected = trip.get(field);
      if (Number.isSafeInteger(expected)) compareNumber(signal, field, expected, issues);
    }
  }

  await checkMemberships(store, trip, pageSize, issues, members.documents, participants.documents, links.documents, validateProfiles);
  // An over-limit expense query cannot prove that a receipt's expense is missing.
  if (expenses.complete) checkReceipts(trip, expenses.documents, receipts.documents, issues);
  checkLedger(trip, participants.documents, expenses.documents, settlements.documents, balances.documents,
    expenses.complete && settlements.complete, issues);
  await checkAudit(store, trip, pageSize, issues);
  return issues;
}

async function checkTrip(store: Store, ref: FirebaseFirestore.DocumentReference, pageSize: number, validateProfiles: boolean) {
  for (let attempt = 0; attempt < SCAN_ATTEMPTS; attempt++) {
    const before = await ref.get();
    if (!before.exists) return { checked: false, issues: [{ code: 'TRIP_NOT_FOUND', path: ref.path }] };
    const issues = await inspectTrip(store, before, pageSize, validateProfiles);
    const after = await ref.get();
    // All trip writers update the root in their transaction. updateTime also detects a root write without a version bump.
    const versionsChanged = ['revision', 'ledgerVersion'].some(field => {
      const initial = before.get(field);
      return Number.isSafeInteger(initial) && initial !== after.get(field);
    });
    if (!versionsChanged && after.updateTime && before.updateTime?.isEqual(after.updateTime)) {
      return { checked: true, issues };
    }
  }
  return { checked: false, issues: [{ code: 'TRIP_CHANGED_DURING_SCAN', path: ref.path }] };
}

export async function checkDatabase(store: Store, { tripId, pageSize }: { tripId?: string; pageSize: number }) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('pageSize must be between 1 and 100.');
  if (tripId !== undefined && !entityId.safeParse(tripId).success) throw new Error('tripId must be a UUID.');
  const issues: IntegrityIssue[] = [];
  let tripsScanned = 0, tripsChecked = 0, projectProfilesChecked = 0;
  async function runTrip(ref: FirebaseFirestore.DocumentReference) {
    tripsScanned++;
    const result = await checkTrip(store, ref, pageSize, tripId !== undefined);
    if (result.checked) tripsChecked++;
    for (const issue of result.issues) issues.push(issue);
  }

  if (tripId !== undefined) await runTrip(store.collection('trips').doc(tripId));
  else {
    for await (const page of pages(store.collection('users'), pageSize)) {
      for (const user of page) {
        projectProfilesChecked++;
        reportSchema(user, userDocumentSchema, issues);
      }
    }
    for await (const page of pages(store.collection('trips'), pageSize)) {
      for (const trip of page) await runTrip(trip.ref);
    }
  }
  issues.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
    (a.fields?.join('.') ?? '').localeCompare(b.fields?.join('.') ?? ''));
  return { summary: { tripsScanned, tripsChecked, projectProfilesChecked, issueCount: issues.length }, issues };
}
