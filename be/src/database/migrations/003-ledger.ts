import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { validateExact } from '../../domain/money.js';
import { expenseDocumentSchema } from '../expense.js';
import { settlementDocumentSchema } from '../settlement.js';
import { type Migration, type Plan } from './runner.js';

async function* scanGroup(store: FirebaseFirestore.Firestore, name: string, pageSize: number) {
  // Firestore collection group order uses the full document path for __name__.
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  const query = store.collectionGroup(name).orderBy(FieldPath.documentId());
  for (;;) {
    const page = await (cursor ? query.startAfter(cursor) : query).limit(pageSize).get();
    for (const doc of page.docs) yield { key: `${name}/${doc.ref.path}`, ref: doc.ref };
    if (page.size < pageSize) return;
    cursor = page.docs.at(-1);
  }
}

export const ledgerMigration: Migration = {
  id: 'DBM-004-ledger', revision: '1',
  async *scan(store, pageSize) {
    yield* scanGroup(store, 'expenses', pageSize);
    yield* scanGroup(store, 'settlements', pageSize);
  },
  async plan(store, ref): Promise<Plan> {
    const snapshot = await ref.get();
    if (!snapshot.exists) return { guards: [{ ref, updateTime: null }], changes: [], issues: [] };
    const tripRef = ref.parent.parent!;
    const trip = await tripRef.get();
    const guards = [{ ref, updateTime: snapshot.updateTime ?? null }, { ref: tripRef, updateTime: trip.updateTime ?? null }];
    if (!trip.exists) return { guards, changes: [], issues: [{ code: 'TRIP_MISSING', path: ref.path }] };
    const data = snapshot.data()!;
    if (data.id !== undefined && data.id !== ref.id) {
      return { guards, changes: [], issues: [{ code: 'LEDGER_ID_CONFLICT', path: ref.path }] };
    }
    if (trip.get('currency') !== undefined && trip.get('currency') !== 'VND') {
      return { guards, changes: [], issues: [{ code: 'LEDGER_CURRENCY_UNRESOLVED', path: ref.path }] };
    }
    if (ref.parent.id === 'expenses') {
      const ids = [data.payerParticipantId, ...(Array.isArray(data.shares) ? data.shares.map((s: { participantId?: unknown }) => s.participantId) : [])];
      const participantRefs = ids.filter((id: unknown): id is string => typeof id === 'string')
        .map(id => tripRef.collection('participants').doc(id));
      if (!participantRefs.length || ids.some((id: unknown) => typeof id !== 'string')) {
        return { guards, changes: [], issues: [{ code: 'LEDGER_PARTICIPANT_MISSING', path: ref.path }] };
      }
      const participants = await store.getAll(...participantRefs);
      guards.push(...participants.map(p => ({ ref: p.ref, updateTime: p.updateTime ?? null })));
      if (ids.some((id: unknown) => typeof id !== 'string') || participants.some(p => !p.exists)) {
        return { guards, changes: [], issues: [{ code: 'LEDGER_PARTICIPANT_MISSING', path: ref.path }] };
      }
      try { validateExact(data.amountMinor, data.shares); }
      catch { return { guards, changes: [], issues: [{ code: 'INVALID_EXPENSE_SHARES', path: ref.path }] }; }
      const splitInput = data.splitInput ?? data.split;
      const receiptClaims = await tripRef.collection('receipts').where('attachedExpenseId', '==', ref.id).get();
      guards.push(...receiptClaims.docs.map(claim => ({ ref: claim.ref, updateTime: claim.updateTime ?? null })));
      const defaults = {
        schemaVersion: 1, id: ref.id, currency: 'VND', note: null,
        splitInput, receiptIds: receiptClaims.docs.map(doc => doc.id),
        createdAt: snapshot.createTime, updatedAt: snapshot.updateTime,
        voidedAt: data.status === 'active' ? null : undefined,
        voidedBy: data.status === 'active' ? null : undefined,
        voidReason: data.status === 'active' ? null : undefined,
      };
      const patch = Object.fromEntries(Object.entries(defaults).filter(([field]) => data[field] === undefined));
      const merged = { ...data, ...patch };
      delete merged.split;
      const parsed = expenseDocumentSchema.safeParse(merged);
      if (!parsed.success) return { guards, changes: [], issues: [{ code: 'UNRESOLVED_LEGACY_EXPENSE', path: ref.path,
        fields: [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || '$'))] }] };
      if (data.split !== undefined) patch.split = FieldValue.delete();
      return { guards, changes: Object.keys(patch).length ? [{ ref, data: patch }] : [], issues: [] };
    }
    const ids = [data.fromParticipantId, data.toParticipantId];
    const participantRefs = ids.filter((id: unknown): id is string => typeof id === 'string')
      .map(id => tripRef.collection('participants').doc(id));
    if (participantRefs.length !== 2) return { guards, changes: [], issues: [{ code: 'LEDGER_PARTICIPANT_MISSING', path: ref.path }] };
    const participants = await store.getAll(...participantRefs);
    guards.push(...participants.map(p => ({ ref: p.ref, updateTime: p.updateTime ?? null })));
    if (ids.some((id: unknown) => typeof id !== 'string') || participants.some(p => !p.exists)) {
      return { guards, changes: [], issues: [{ code: 'LEDGER_PARTICIPANT_MISSING', path: ref.path }] };
    }
    const pending = data.status === 'pending';
    const defaults = {
      schemaVersion: 1, id: ref.id, currency: 'VND', note: null,
      createdAt: snapshot.createTime, updatedAt: snapshot.updateTime,
      confirmedBy: pending ? null : undefined, confirmedAt: pending ? null : undefined,
      confirmationMode: pending ? null : undefined,
      cancelledBy: data.status === 'cancelled' ? undefined : null,
      cancelledAt: data.status === 'cancelled' ? undefined : null,
      voidedBy: data.status === 'void' ? undefined : null,
      voidedAt: data.status === 'void' ? undefined : null,
      voidReason: data.status === 'void' ? undefined : null,
    };
    const patch = Object.fromEntries(Object.entries(defaults).filter(([field]) => data[field] === undefined));
    const parsed = settlementDocumentSchema.safeParse({ ...data, ...patch });
    if (!parsed.success) return { guards, changes: [], issues: [{ code: 'UNRESOLVED_LEGACY_SETTLEMENT', path: ref.path,
      fields: [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || '$'))] }] };
    return { guards, changes: Object.keys(patch).length ? [{ ref, data: patch }] : [], issues: [] };
  },
};
