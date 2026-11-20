import { Timestamp } from 'firebase-admin/firestore';
import { entityId, membershipSchema, participantLinkSchema, participantSchema, tripRefSchema, tripSchema } from '../integrity-schemas.js';
import { scanCollection, type Guard, type Migration, type MigrationIssue, type Mutation, type Plan } from './runner.js';

const missing = (stored: FirebaseFirestore.DocumentData, defaults: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(defaults).filter(([key]) => stored[key] === undefined));
const issue = (code: string, path: string, fields?: string[]): MigrationIssue => ({ code, path, ...(fields ? { fields } : {}) });

export const tripsMigration: Migration = {
  id: 'DBM-002-trips', revision: '1',
  scan: (store, pageSize) => scanCollection(store.collection('trips'), pageSize),
  async plan(_store, ref): Promise<Plan> {
    const trip = await ref.get();
    if (!trip.exists) return { guards: [{ ref, updateTime: null }], changes: [], issues: [] };
    const members = await ref.collection('memberships').get();
    const guards: Guard[] = [{ ref, updateTime: trip.updateTime ?? null },
      ...members.docs.map(doc => ({ ref: doc.ref, updateTime: doc.updateTime ?? null }))];
    const owners = members.docs.filter(doc => doc.get('role') === 'owner' && doc.get('status') === 'active');
    const ownerUid = trip.get('ownerUid');
    if (owners.length !== 1 || owners[0]?.id !== ownerUid || !entityId.safeParse(owners[0]?.get('participantId')).success) {
      return { guards, changes: [], issues: [issue('OWNER_INVARIANT_FAILED', ref.path)] };
    }
    const stored = trip.data()!;
    const defaults: Record<string, unknown> = {
      schemaVersion: 1, destination: null, note: null, startDate: null, endDate: null,
      timezone: 'Asia/Ho_Chi_Minh', currency: 'VND', currencyExponent: 0,
      createdBy: ownerUid, moderationStatus: 'normal', moderationVersion: 1,
      moderationReason: null, moderatedAt: null, moderatedBy: null, inviteEpoch: 1,
      archivedAt: stored.status === 'active' ? null : undefined,
      createdAt: trip.createTime, updatedAt: trip.updateTime,
    };
    const patch = missing(stored, defaults);
    const merged = { ...stored, ...patch };
    // Projection metadata is handled by DBM-005; do not manufacture financial counters here.
    const required = ['id', 'name', 'status', 'version', 'revision', 'ledgerVersion', 'archivedAt'];
    const absent = required.filter(field => merged[field] === undefined);
    if (absent.length) return { guards, changes: [], issues: [issue('TRIP_SOURCE_INCOMPLETE', ref.path, absent)] };
    if (merged.id !== ref.id || (merged.status !== 'active' && merged.status !== 'archived')) {
      return { guards, changes: [], issues: [issue('TRIP_SOURCE_CONFLICT', ref.path)] };
    }
    // If the current document already has projection fields, validate the whole result before applying.
    if (['participantCount', 'categoryTotalsMinor', 'totalExpenseMinor'].every(field => merged[field] !== undefined) &&
        !tripSchema.safeParse(merged).success) {
      return { guards, changes: [], issues: [issue('TRIP_SCHEMA_CONFLICT', ref.path)] };
    }
    return { guards, changes: Object.keys(patch).length ? [{ ref, data: patch }] : [], issues: [] };
  },
};

export const linksMigration: Migration = {
  id: 'DBM-003-links', revision: '1',
  scan: (store, pageSize) => scanCollection(store.collection('trips'), pageSize),
  async plan(store, ref): Promise<Plan> {
    const trip = await ref.get();
    if (!trip.exists) return { guards: [{ ref, updateTime: null }], changes: [], issues: [] };
    if (!entityId.safeParse(ref.id).success) return { guards: [{ ref, updateTime: trip.updateTime ?? null }],
      changes: [], issues: [issue('TRIP_ID_CONFLICT', ref.path)] };
    const [members, participants, links] = await Promise.all([
      ref.collection('memberships').get(), ref.collection('participants').get(), ref.collection('participantLinks').get(),
    ]);
    const [expenseRows, settlementRows] = await Promise.all([
      ref.collection('expenses').get(), ref.collection('settlements').get(),
    ]);
    if (expenseRows.size + settlementRows.size > 200) return {
      guards: [{ ref, updateTime: trip.updateTime ?? null }], changes: [],
      issues: [issue('TRIP_LEDGER_TOO_LARGE_FOR_LINK_MIGRATION', ref.path)],
    };
    const referenced = new Set<string>();
    for (const expense of expenseRows.docs) {
      const payer = expense.get('payerParticipantId');
      if (typeof payer === 'string') referenced.add(payer);
      for (const share of expense.get('shares') ?? []) if (typeof share?.participantId === 'string') referenced.add(share.participantId);
    }
    for (const settlement of settlementRows.docs) {
      for (const id of [settlement.get('fromParticipantId'), settlement.get('toParticipantId')]) {
        if (typeof id === 'string') referenced.add(id);
      }
    }
    const all = [trip, ...members.docs, ...participants.docs, ...links.docs,
      ...expenseRows.docs, ...settlementRows.docs];
    const guards: Guard[] = all.map(doc => ({ ref: doc.ref, updateTime: doc.updateTime ?? null }));
    const issues: MigrationIssue[] = [];
    const changes: Mutation[] = [];
    const participantById = new Map(participants.docs.map(doc => [doc.id, doc]));
    const memberById = new Map(members.docs.map(doc => [doc.id, doc]));
    const linkById = new Map(links.docs.map(doc => [doc.id, doc]));
    const claimed = new Set<string>();
    const now = trip.updateTime ?? Timestamp.now();
    for (const member of members.docs) {
      const data = member.data();
      const participantId = data.participantId;
      if (data.uid !== undefined && data.uid !== member.id) {
        issues.push(issue('MEMBERSHIP_ID_CONFLICT', member.ref.path)); continue;
      }
      if (data.status !== 'active' && data.status !== 'removed') {
        issues.push(issue('MEMBERSHIP_STATUS_CONFLICT', member.ref.path)); continue;
      }
      if (data.status === 'removed') {
        if (linkById.has(member.id)) issues.push(issue('REMOVED_MEMBERSHIP_LINK_CONFLICT', member.ref.path));
        if (participantId != null) {
          issues.push(issue('REMOVED_MEMBERSHIP_LINK_UNRESOLVED', member.ref.path)); continue;
        }
        const patch = missing(data, { schemaVersion: 1, uid: member.id, version: 1,
          joinedAt: member.createTime, updatedAt: member.updateTime });
        if (!membershipSchema.safeParse({ ...data, ...patch }).success) issues.push(issue('MEMBERSHIP_SOURCE_INCOMPLETE', member.ref.path));
        else if (Object.keys(patch).length) changes.push({ ref: member.ref, data: patch });
        const tripRef = store.doc(`users/${member.id}/tripRefs/${ref.id}`);
        const tripRefSnapshot = await tripRef.get();
        guards.push({ ref: tripRef, updateTime: tripRefSnapshot.updateTime ?? null });
        if (!tripRefSnapshot.exists) changes.push({ ref: tripRef, create: true,
          data: tripRefSchema.parse({ schemaVersion: 1, tripId: ref.id, status: 'removed',
            joinedAt: data.joinedAt ?? member.createTime, updatedAt: member.updateTime }) });
        else {
          if (tripRefSnapshot.get('status') !== 'removed') issues.push(issue('TRIP_REF_STATUS_CONFLICT', tripRef.path));
          if (tripRefSnapshot.get('tripId') !== undefined && tripRefSnapshot.get('tripId') !== ref.id) {
            issues.push(issue('TRIP_REF_ID_CONFLICT', tripRef.path));
          }
          const refPatch = missing(tripRefSnapshot.data()!, { schemaVersion: 1, tripId: ref.id,
            joinedAt: data.joinedAt ?? member.createTime, updatedAt: tripRefSnapshot.updateTime });
          if (!tripRefSchema.safeParse({ ...tripRefSnapshot.data(), ...refPatch }).success) issues.push(issue('TRIP_REF_SOURCE_INCOMPLETE', tripRef.path));
          else if (Object.keys(refPatch).length) changes.push({ ref: tripRef, data: refPatch });
        }
        continue;
      }
      if (!entityId.safeParse(participantId).success || claimed.has(participantId)) {
        issues.push(issue('PARTICIPANT_LINK_CONFLICT', member.ref.path)); continue;
      }
      claimed.add(participantId);
      const participant = participantById.get(participantId);
      if (!participant || (participant.get('linkedUid') !== undefined && participant.get('linkedUid') !== member.id)) {
        issues.push(issue('PARTICIPANT_LINK_CONFLICT', member.ref.path)); continue;
      }
      const existingLink = linkById.get(member.id);
      if (existingLink && existingLink.get('participantId') !== participantId) {
        issues.push(issue('PARTICIPANT_LINK_CONFLICT', existingLink.ref.path)); continue;
      }
      if (existingLink) {
        if (existingLink.get('uid') !== undefined && existingLink.get('uid') !== member.id) {
          issues.push(issue('PARTICIPANT_LINK_CONFLICT', existingLink.ref.path)); continue;
        }
        const patch = missing(existingLink.data(), { schemaVersion: 1, uid: member.id,
          updatedAt: existingLink.updateTime });
        if (!participantLinkSchema.safeParse({ ...existingLink.data(), ...patch }).success) {
          issues.push(issue('PARTICIPANT_LINK_SOURCE_INCOMPLETE', existingLink.ref.path));
        } else if (Object.keys(patch).length) changes.push({ ref: existingLink.ref, data: patch });
      }
      const memberPatch = missing(data, { schemaVersion: 1, uid: member.id, version: 1,
        joinedAt: member.createTime, updatedAt: member.updateTime,
        removedAt: data.status === 'removed' ? member.updateTime : null });
      if (!membershipSchema.safeParse({ ...data, ...memberPatch }).success) issues.push(issue('MEMBERSHIP_SOURCE_INCOMPLETE', member.ref.path));
      else if (Object.keys(memberPatch).length) changes.push({ ref: member.ref, data: memberPatch });
      const participantData = participant.data();
      if (participantData.id !== undefined && participantData.id !== participant.id) {
        issues.push(issue('PARTICIPANT_ID_CONFLICT', participant.ref.path)); continue;
      }
      const participantPatch = missing(participantData, { schemaVersion: 1, id: participant.id, linkedUid: member.id,
        status: 'active', version: 1, hasLedgerReferences: referenced.has(participant.id), createdBy: trip.get('ownerUid'),
        createdAt: participant.createTime, updatedAt: participant.updateTime });
      if (!participantSchema.safeParse({ ...participantData, ...participantPatch }).success) issues.push(issue('PARTICIPANT_SOURCE_INCOMPLETE', participant.ref.path));
      else if (Object.keys(participantPatch).length) changes.push({ ref: participant.ref, data: participantPatch });
      if (!existingLink && data.status === 'active') {
        const linkRef = ref.collection('participantLinks').doc(member.id);
        changes.push({ ref: linkRef, data: participantLinkSchema.parse({ schemaVersion: 1, uid: member.id, participantId, updatedAt: now }), create: true });
        guards.push({ ref: linkRef, updateTime: null });
      }
      const tripRef = store.doc(`users/${member.id}/tripRefs/${ref.id}`);
      const tripRefSnapshot = await tripRef.get();
      guards.push({ ref: tripRef, updateTime: tripRefSnapshot.updateTime ?? null });
      if (!tripRefSnapshot.exists) {
        const document = tripRefSchema.parse({ schemaVersion: 1, tripId: ref.id, status: data.status,
          joinedAt: data.joinedAt ?? member.createTime, updatedAt: now });
        changes.push({ ref: tripRef, data: document, create: true });
      } else {
        if (tripRefSnapshot.get('status') !== data.status) issues.push(issue('TRIP_REF_STATUS_CONFLICT', tripRef.path));
        if (tripRefSnapshot.get('tripId') !== undefined && tripRefSnapshot.get('tripId') !== ref.id) {
          issues.push(issue('TRIP_REF_ID_CONFLICT', tripRef.path));
        }
        const patch = missing(tripRefSnapshot.data()!, { schemaVersion: 1, tripId: ref.id,
          joinedAt: data.joinedAt ?? member.createTime, updatedAt: tripRefSnapshot.updateTime });
        if (!tripRefSchema.safeParse({ ...tripRefSnapshot.data(), ...patch }).success) issues.push(issue('TRIP_REF_SOURCE_INCOMPLETE', tripRef.path));
        else if (Object.keys(patch).length) changes.push({ ref: tripRef, data: patch });
      }
    }
    for (const participant of participants.docs) {
      const linkedUid = participant.get('linkedUid');
      if (linkedUid && memberById.get(linkedUid)?.get('participantId') !== participant.id) {
        issues.push(issue('PARTICIPANT_LINK_CONFLICT', participant.ref.path));
      }
    }
    for (const link of links.docs) {
      if (!memberById.has(link.id) || memberById.get(link.id)?.get('participantId') !== link.get('participantId')) {
        issues.push(issue('PARTICIPANT_LINK_CONFLICT', link.ref.path));
      }
    }
    // Unlinked participants still need v1 metadata, but their creator cannot be guessed if missing.
    for (const participant of participants.docs.filter(doc => !claimed.has(doc.id) && doc.get('linkedUid') == null)) {
      const data = participant.data();
      if (data.id !== undefined && data.id !== participant.id) {
        issues.push(issue('PARTICIPANT_ID_CONFLICT', participant.ref.path)); continue;
      }
      const patch = missing(data, { schemaVersion: 1, id: participant.id, linkedUid: null, status: 'active', version: 1,
        hasLedgerReferences: referenced.has(participant.id),
        createdAt: participant.createTime, updatedAt: participant.updateTime });
      if (!participantSchema.safeParse({ ...data, ...patch }).success) issues.push(issue('PARTICIPANT_SOURCE_INCOMPLETE', participant.ref.path));
      else if (Object.keys(patch).length) changes.push({ ref: participant.ref, data: patch });
    }
    return { guards, changes, issues };
  },
};
