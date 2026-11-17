import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { db } from '../src/firebase.js';
import { checkDatabase } from '../src/database/check-integrity.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) { process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill'; process.env.FIREBASE_WEB_API_KEY ??= 'demo'; }

describe.skipIf(!enabled)('S07 trip and participant management', () => {
  it('updates metadata and participant status with owner rights, version checks and preserved ledger', async () => {
    const app = await buildApp(Fastify({ logger: false }));
    try {
      async function register(name: string) {
        const result = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
          email: `s07-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: name,
        } });
        expect(result.statusCode).toBe(201);
        return result.json().data;
      }
      const owner = await register('An'), member = await register('Bình'), outsider = await register('Ngoài nhóm');
      async function send(method: 'POST' | 'PATCH', path: string, payload: object, token = owner.accessToken,
        version?: number, key = randomUUID()) {
        return app.inject({ method, url: path, payload, headers: { authorization: `Bearer ${token}`,
          'idempotency-key': key, ...(version ? { 'if-match': `"${version}"` } : {}) } });
      }
      const created = await send('POST', '/api/v1/trips', { name: 'Đi chơi', ownerName: 'An' });
      const { id: tripId, ownerParticipantId } = created.json().data;
      const trip = db().doc(`trips/${tripId}`);
      const guest = await send('POST', `/api/v1/trips/${tripId}/participants`, { displayName: 'Bình' });
      const participantId = guest.json().data.id as string;
      const expense = await send('POST', `/api/v1/trips/${tripId}/expenses`, {
        title: 'Ăn tối', amountMinor: 120, payerParticipantId: ownerParticipantId,
        splitMethod: 'equal', split: { participantIds: [ownerParticipantId, participantId] },
        occurredOn: '2026-12-20', category: 'food', note: null,
      });
      expect(expense.statusCode, expense.body).toBe(200);
      const originalExpense = (await trip.collection('expenses').doc(expense.json().data.id).get()).data();
      const originalBalance = (await trip.collection('balances').doc(participantId).get()).data();
      const ledgerVersion = (await trip.get()).get('ledgerVersion');
      const metadataPath = `/api/v1/trips/${tripId}`;
      const version = (await trip.get()).get('version');
      const key = randomUUID();
      const input = { name: 'Đà Lạt', destination: 'Lâm Đồng', startDate: '2026-12-20',
        endDate: '2026-12-22', timezone: 'Asia/Ho_Chi_Minh' };
      const changed = await send('PATCH', metadataPath, input, owner.accessToken, version, key);
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.headers.etag).toBe(`"${version + 1}"`);
      expect((await trip.get()).data()).toMatchObject({ name: 'Đà Lạt', destination: 'Lâm Đồng',
        ledgerVersion, version: version + 1 });
      const replay = await send('PATCH', metadataPath, input, owner.accessToken, version, key);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.json().data).toEqual(changed.json().data);
      const stale = await send('PATCH', metadataPath, { name: 'Khác' }, owner.accessToken, version);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('VERSION_CONFLICT');
      const invalidDate = await send('PATCH', metadataPath, { endDate: '2026-12-01' },
        owner.accessToken, version + 1);
      expect(invalidDate.statusCode).toBe(422);
      const invalidTimezone = await send('PATCH', metadataPath, { timezone: 'Moon/Ocean' },
        owner.accessToken, version + 1);
      expect(invalidTimezone.statusCode).toBe(422);
      const missingVersion = await send('PATCH', metadataPath, { name: 'Thiếu phiên bản' });
      expect(missingVersion.statusCode).toBe(428);
      const badField = await send('PATCH', metadataPath, { currency: 'USD' }, owner.accessToken, version + 1);
      expect(badField.statusCode).toBe(422);
      const outside = await send('PATCH', metadataPath, { name: 'Lộ thông tin' }, outsider.accessToken, version + 1);
      expect(outside.statusCode).toBe(404);

      const now = Timestamp.now(), batch = db().batch();
      batch.create(trip.collection('memberships').doc(member.user.uid), { schemaVersion: 1, uid: member.user.uid,
        role: 'member', status: 'active', participantId: null, version: 1, joinedAt: now, updatedAt: now, removedAt: null });
      batch.create(db().doc(`users/${member.user.uid}/tripRefs/${tripId}`), { schemaVersion: 1, tripId,
        status: 'active', joinedAt: now, updatedAt: now });
      batch.update(trip, { membershipCountAllTime: 2 });
      await batch.commit();
      const memberDenied = await send('PATCH', metadataPath, { name: 'Không được' }, member.accessToken, version + 1);
      expect(memberDenied.statusCode).toBe(403);

      const participantRef = trip.collection('participants').doc(participantId);
      const participantPath = `/api/v1/trips/${tripId}/participants/${participantId}`;
      const inactive = await send('PATCH', participantPath, { displayName: 'Bình mới', status: 'inactive' },
        owner.accessToken, 1);
      expect(inactive.statusCode, inactive.body).toBe(200);
      const staleParticipant = await send('PATCH', participantPath, { displayName: 'Tên cũ' }, owner.accessToken, 1);
      expect(staleParticipant.statusCode).toBe(409);
      expect((await participantRef.get()).data()).toMatchObject({ displayName: 'Bình mới', status: 'inactive', version: 2 });
      const expenseDenied = await send('POST', `/api/v1/trips/${tripId}/expenses`, {
        title: 'Món mới', amountMinor: 100, payerParticipantId: ownerParticipantId,
        splitMethod: 'equal', split: { participantIds: [ownerParticipantId, participantId] },
        occurredOn: '2026-12-21', category: 'food', note: null,
      });
      expect(expenseDenied.statusCode).toBe(422);
      expect((await trip.collection('expenses').doc(expense.json().data.id).get()).data()).toEqual(originalExpense);
      expect((await trip.collection('balances').doc(participantId).get()).data()).toEqual(originalBalance);
      expect((await trip.get()).get('ledgerVersion')).toBe(ledgerVersion);
      const competingVersion = (await trip.get()).get('version');
      const competing = await Promise.all([
        send('PATCH', metadataPath, { note: 'Kế hoạch A' }, owner.accessToken, competingVersion),
        send('PATCH', metadataPath, { note: 'Kế hoạch B' }, owner.accessToken, competingVersion),
      ]);
      expect(competing.filter(result => result.statusCode === 200)).toHaveLength(1);
      expect(competing.filter(result => result.statusCode === 409)).toHaveLength(1);
      expect((await checkDatabase(db(), { tripId, pageSize: 20 })).issues).toEqual([]);
    } finally { await app.close(); }
  }, 30_000);

  it('keeps three-way links unique under concurrent claims and handles removed memberships', async () => {
    const app = await buildApp(Fastify({ logger: false }));
    try {
      async function register() {
        const result = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
          email: `s07-link-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: 'Member',
        } });
        return result.json().data;
      }
      const owner = await register(), a = await register(), b = await register();
      const headers = { authorization: `Bearer ${owner.accessToken}` };
      async function post(url: string, payload: object) {
        const response = await app.inject({ method: 'POST', url, payload,
          headers: { ...headers, 'idempotency-key': randomUUID() } });
        expect(response.statusCode, response.body).toBe(200);
        return response.json().data;
      }
      const tripData = await post('/api/v1/trips', { name: 'Liên kết', ownerName: 'An' });
      const tripId = tripData.id as string, trip = db().doc(`trips/${tripId}`);
      const p1 = (await post(`/api/v1/trips/${tripId}/participants`, { displayName: 'Một' })).id as string;
      const p2 = (await post(`/api/v1/trips/${tripId}/participants`, { displayName: 'Hai' })).id as string;
      const now = Timestamp.now(), batch = db().batch();
      for (const user of [a, b]) {
        batch.create(trip.collection('memberships').doc(user.user.uid), { schemaVersion: 1, uid: user.user.uid,
          role: 'member', status: 'active', participantId: null, version: 1,
          joinedAt: now, updatedAt: now, removedAt: null });
        batch.create(db().doc(`users/${user.user.uid}/tripRefs/${tripId}`), { schemaVersion: 1,
          tripId, status: 'active', joinedAt: now, updatedAt: now });
      }
      batch.update(trip, { membershipCountAllTime: 3 });
      await batch.commit();
      const link = (uid: string, participantId: string | null, version: number, key = randomUUID()) =>
        app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/memberships/${uid}/link`,
          payload: { participantId, reason: 'Gắn đúng người' },
          headers: { ...headers, 'idempotency-key': key, 'if-match': `"${version}"` } });
      const otherTrip = await post('/api/v1/trips', { name: 'Chuyến khác', ownerName: 'An' });
      const crossTrip = await link(a.user.uid, otherTrip.ownerParticipantId, 1);
      expect(crossTrip.statusCode).toBe(409);
      const ownerUnlink = await link(owner.user.uid, null, 1);
      expect(ownerUnlink.statusCode).toBe(422);
      const keys = { [a.user.uid]: randomUUID(), [b.user.uid]: randomUUID() };
      const claims = await Promise.all([link(a.user.uid, p1, 1, keys[a.user.uid]),
        link(b.user.uid, p1, 1, keys[b.user.uid])]);
      expect(claims.filter(result => result.statusCode === 200)).toHaveLength(1);
      expect(claims.filter(result => result.statusCode === 409)).toHaveLength(1);
      const winner = claims[0]!.statusCode === 200 ? a.user.uid : b.user.uid;
      const loser = winner === a.user.uid ? b.user.uid : a.user.uid;
      const replay = await link(winner, p1, 1, keys[winner]);
      expect(replay.statusCode).toBe(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      const reused = await link(winner, p2, 1, keys[winner]);
      expect(reused.statusCode).toBe(409);
      expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await trip.collection('participants').doc(p1).get()).get('linkedUid')).toBe(winner);
      expect((await trip.collection('participantLinks').doc(winner).get()).get('participantId')).toBe(p1);
      const oldLedger = (await trip.get()).get('ledgerVersion');
      const move = await link(winner, p2, 2);
      expect(move.statusCode, move.body).toBe(200);
      expect((await trip.collection('participants').doc(p1).get()).get('linkedUid')).toBeNull();
      expect((await trip.collection('participants').doc(p2).get()).get('linkedUid')).toBe(winner);
      expect((await trip.collection('participantLinks').doc(winner).get()).get('participantId')).toBe(p2);
      const sameTarget = await link(loser, p2, 1);
      expect(sameTarget.statusCode).toBe(409);
      const stale = await link(winner, p1, 2);
      expect(stale.statusCode).toBe(409);
      await trip.collection('memberships').doc(winner).update({ status: 'removed', removedAt: now });
      await db().doc(`users/${winner}/tripRefs/${tripId}`).update({ status: 'removed' });
      const removedCannotClaim = await link(winner, p1, 3);
      expect(removedCannotClaim.statusCode).toBe(409);
      const unlink = await link(winner, null, 3);
      expect(unlink.statusCode, unlink.body).toBe(200);
      expect((await trip.collection('participants').doc(p2).get()).get('linkedUid')).toBeNull();
      expect((await trip.collection('participantLinks').doc(winner).get()).exists).toBe(false);
      expect((await trip.collection('memberships').doc(winner).get()).get('participantId')).toBeNull();
      const linked = await link(loser, p1, 1);
      expect(linked.statusCode, linked.body).toBe(200);
      const p3 = (await post(`/api/v1/trips/${tripId}/participants`, { displayName: 'Ba' })).id as string;
      const p4 = (await post(`/api/v1/trips/${tripId}/participants`, { displayName: 'Bốn' })).id as string;
      const sameUidClaims = await Promise.all([link(loser, p3, 2), link(loser, p4, 2)]);
      expect(sameUidClaims.filter(response => response.statusCode === 200)).toHaveLength(1);
      expect(sameUidClaims.filter(response => response.statusCode === 409)).toHaveLength(1);
      const chosen = (await trip.collection('memberships').doc(loser).get()).get('participantId');
      expect([p3, p4]).toContain(chosen);
      expect((await trip.collection('participantLinks').doc(loser).get()).get('participantId')).toBe(chosen);
      expect((await trip.collection('participants').doc(p1).get()).get('linkedUid')).toBeNull();
      expect((await trip.collection('participants').doc(chosen).get()).get('linkedUid')).toBe(loser);
      expect((await trip.get()).get('ledgerVersion')).toBe(oldLedger);
      expect((await checkDatabase(db(), { tripId, pageSize: 20 })).issues).toEqual([]);
      const audit = await trip.collection('auditEvents').get();
      expect(audit.docs.map(doc => doc.get('action'))).toContain('participant.unlinked');
      expect(audit.docs.map(doc => doc.get('action'))).toContain('participant.linked');
      const activity = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/activity`, headers });
      expect(activity.statusCode).toBe(200);
      expect(activity.json().data.items.some((event: { action: string; reason: string | null }) =>
        event.action === 'participant.unlinked' && event.reason === 'Gắn đúng người')).toBe(true);
    } finally { await app.close(); }
  }, 30_000);
});
