import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { db } from '../src/firebase.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) { process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill'; process.env.FIREBASE_WEB_API_KEY ??= 'demo'; }

describe.skipIf(!enabled)('paginated read API', () => {
  it('pages over 20 trips, tied timestamps, filtered roots and stale membership refs', async () => {
    const app = await buildApp(Fastify({ logger: false }));
    try {
      const register = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
        email: `pages-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: 'An',
      } });
      const { accessToken, user } = register.json().data;
      const headers = { authorization: `Bearer ${accessToken}` };
      const ids: string[] = [];
      for (let i = 0; i < 23; i++) {
        const result = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: {
          ...headers, 'idempotency-key': randomUUID(),
        }, payload: { name: `Chuyến ${i}`, ownerName: 'An' } });
        expect(result.statusCode, result.body).toBe(200);
        ids.push(result.json().data.id);
      }
      const store = db(), tied = Timestamp.now();
      const batch = store.batch();
      for (const id of ids) batch.update(store.doc(`users/${user.uid}/tripRefs/${id}`), { joinedAt: tied });
      const sorted = [...ids].sort().reverse();
      for (const id of sorted.slice(0, 5)) batch.update(store.doc(`trips/${id}`), { status: 'archived', archivedAt: tied });
      batch.update(store.doc(`trips/${sorted[5]}/memberships/${user.uid}`), { status: 'removed' });
      await batch.commit();

      const first = await app.inject({ method: 'GET', url: '/api/v1/trips?status=active&limit=5', headers });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().data.items).toEqual([]);
      expect(first.json().data.nextCursor).toBeTypeOf('string');
      const seen = new Set<string>();
      let cursor: string | null = first.json().data.nextCursor;
      while (cursor) {
        const page = await app.inject({ method: 'GET',
          url: `/api/v1/trips?status=active&limit=5&cursor=${encodeURIComponent(cursor)}`, headers });
        expect(page.statusCode, page.body).toBe(200);
        for (const trip of page.json().data.items) {
          expect(seen.has(trip.id)).toBe(false);
          seen.add(trip.id);
        }
        cursor = page.json().data.nextCursor;
      }
      expect(seen.size).toBe(17);
      expect(seen.has(sorted[5]!)).toBe(false);
      const wrongFilter = await app.inject({ method: 'GET',
        url: `/api/v1/trips?status=archived&cursor=${encodeURIComponent(first.json().data.nextCursor)}`, headers });
      expect(wrongFilter.statusCode).toBe(400);
      expect(wrongFilter.json().error.code).toBe('INVALID_CURSOR');
    } finally { await app.close(); }
  }, 60_000);

  it('pages finance and activity, rejects stale cursors and limits operation lookup by current access', async () => {
    const app = await buildApp(Fastify({ logger: false }));
    try {
      const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
        email: `finance-pages-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: 'An',
      } });
      const { accessToken, user } = registered.json().data;
      const headers = { authorization: `Bearer ${accessToken}` };
      const createKey = randomUUID();
      async function post(url: string, payload: object, key = randomUUID()) {
        const response = await app.inject({ method: 'POST', url, payload,
          headers: { ...headers, 'idempotency-key': key } });
        expect(response.statusCode, response.body).toBe(200);
        return response.json().data;
      }
      const trip = await post('/api/v1/trips', { name: 'Phân trang', ownerName: 'An' }, createKey);
      const tripId = trip.id as string, owner = trip.ownerParticipantId as string;
      const guest = (await post(`/api/v1/trips/${tripId}/participants`, { displayName: 'Bình' })).id as string;
      const expenseIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const expense = await post(`/api/v1/trips/${tripId}/expenses`, {
          title: `Món ${i}`, amountMinor: 100, payerParticipantId: owner,
          splitMethod: 'equal', split: { participantIds: [owner, guest] },
          occurredOn: '2026-12-20', category: i % 2 ? 'transport' : 'food', note: null,
        });
        expenseIds.push(expense.id);
      }
      const root = db().doc(`trips/${tripId}`);
      const ledgerVersion = (await root.get()).get('ledgerVersion');
      const settlementIds: string[] = [];
      for (let i = 0; i < 32; i++) {
        const settlement = await post(`/api/v1/trips/${tripId}/settlements`, {
          fromParticipantId: guest, toParticipantId: owner, amountMinor: 10,
          occurredOn: '2026-12-20', note: null, basedOnLedgerVersion: ledgerVersion,
        });
        settlementIds.push(settlement.id);
      }
      const tied = Timestamp.now(), batch = db().batch();
      for (const id of settlementIds) batch.update(root.collection('settlements').doc(id), { createdAt: tied });
      await batch.commit();
      async function collect(path: string, limit: number) {
        const seen = new Set<string>();
        let cursor: string | null = null;
        do {
          const url: string = `${path}${path.includes('?') ? '&' : '?'}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const page: Awaited<ReturnType<typeof app.inject>> = await app.inject({ method: 'GET', url, headers });
          expect(page.statusCode, page.body).toBe(200);
          for (const item of page.json().data.items) {
            const id = item.id ?? item.eventId;
            expect(seen.has(id)).toBe(false);
            seen.add(id);
          }
          cursor = page.json().data.nextCursor;
        } while (cursor);
        return seen;
      }
      expect((await collect(`/api/v1/trips/${tripId}/expenses`, 2)).size).toBe(5);
      expect((await collect(`/api/v1/trips/${tripId}/settlements?status=pending`, 7)).size).toBe(32);
      const pendingFirst = await app.inject({ method: 'GET',
        url: `/api/v1/trips/${tripId}/settlements?status=pending&limit=2`, headers });
      const settlementCursor = pendingFirst.json().data.nextCursor;
      const filtered = await app.inject({ method: 'GET',
        url: `/api/v1/trips/${tripId}/expenses?status=active&category=food&from=2026-12-20&to=2026-12-20`, headers });
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(filtered.json().data.items).toHaveLength(3);
      const payerFilter = await app.inject({ method: 'GET',
        url: `/api/v1/trips/${tripId}/expenses?status=active&payer=${owner}`, headers });
      expect(payerFilter.statusCode, payerFilter.body).toBe(200);
      expect(payerFilter.json().data.items).toHaveLength(5);
      const badFilter = await app.inject({ method: 'GET',
        url: `/api/v1/trips/${tripId}/expenses?category=food&payer=${owner}`, headers });
      expect(badFilter.statusCode).toBe(422);
      const badLimit = await app.inject({ method: 'GET',
        url: `/api/v1/trips/${tripId}/expenses?limit=51`, headers });
      expect(badLimit.statusCode).toBe(400);
      const first = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/expenses?limit=2`, headers });
      const cursor = first.json().data.nextCursor;
      await post(`/api/v1/trips/${tripId}/expenses`, { title: 'Món mới', amountMinor: 100,
        payerParticipantId: owner, splitMethod: 'equal', split: { participantIds: [owner, guest] },
        occurredOn: '2026-12-21', category: 'food', note: null });
      const stale = await app.inject({ method: 'GET',
        url: `/api/v1/trips/${tripId}/expenses?limit=2&cursor=${encodeURIComponent(cursor)}`, headers });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('CURSOR_STALE');
      const confirm = await app.inject({ method: 'POST',
        url: `/api/v1/trips/${tripId}/settlements/${settlementIds[0]}/confirm`,
        headers: { ...headers, 'idempotency-key': randomUUID(), 'if-match': '"1"' },
        payload: { basedOnLedgerVersion: (await root.get()).get('ledgerVersion') } });
      expect(confirm.statusCode, confirm.body).toBe(200);
      const settlementStale = await app.inject({ method: 'GET',
        url: `/api/v1/trips/${tripId}/settlements?status=pending&limit=2&cursor=${encodeURIComponent(settlementCursor)}`, headers });
      expect(settlementStale.statusCode).toBe(409);
      expect(settlementStale.json().error.code).toBe('CURSOR_STALE');

      const legacyEvent = root.collection('auditEvents').doc(randomUUID());
      await legacyEvent.set({ action: 'internal-secret', createdAt: Timestamp.now(),
        adminNote: 'internal-secret', token: 'never-return-this' });
      const auditRows = await root.collection('auditEvents').get();
      const tiedAudit = db().batch();
      for (const event of auditRows.docs) tiedAudit.update(event.ref, { createdAt: tied });
      await tiedAudit.commit();
      const activity = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/activity?limit=2`, headers });
      expect(activity.statusCode, activity.body).toBe(200);
      expect(activity.body).not.toContain('internal-secret');
      expect(activity.body).not.toContain('never-return-this');
      expect((await collect(`/api/v1/trips/${tripId}/activity`, 7)).size).toBe(42);

      const operation = await app.inject({ method: 'GET', url: `/api/v1/operations/${createKey}`, headers });
      expect(operation.statusCode, operation.body).toBe(200);
      expect(operation.json().data).toMatchObject({ status: 'completed', tripId, resourceType: 'trip', resourceId: tripId });
      expect(operation.body).not.toContain('ownerName');
      const unknown = await app.inject({ method: 'GET', url: `/api/v1/operations/${randomUUID()}`, headers });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('OPERATION_UNKNOWN');
      const another = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
        email: `other-pages-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: 'Người khác',
      } });
      const foreignKey = await app.inject({ method: 'GET', url: `/api/v1/operations/${createKey}`,
        headers: { authorization: `Bearer ${another.json().data.accessToken}` } });
      expect(foreignKey.statusCode).toBe(404);
      const legacyKey = randomUUID();
      await db().doc(`users/${user.uid}/operations/${legacyKey}`).set({
        path: `/api/v1/trips/${tripId}/expenses`, requestHash: '0'.repeat(64),
        response: { id: expenseIds[0] }, tripId, committedAt: Timestamp.now(),
      });
      const legacy = await app.inject({ method: 'GET', url: `/api/v1/operations/${legacyKey}`, headers });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json().data.resourceId).toBe(expenseIds[0]);
      const incompleteKey = randomUUID();
      await db().doc(`users/${user.uid}/operations/${incompleteKey}`).set({
        path: `/api/v1/trips/${tripId}/expenses`, tripId, committedAt: Timestamp.now(),
      });
      const incomplete = await app.inject({ method: 'GET', url: `/api/v1/operations/${incompleteKey}`, headers });
      expect(incomplete.statusCode).toBe(409);
      expect(incomplete.json().error.code).toBe('OPERATION_RESULT_UNAVAILABLE');
      await root.collection('memberships').doc(user.uid).update({ status: 'removed' });
      const lost = await app.inject({ method: 'GET', url: `/api/v1/operations/${createKey}`, headers });
      expect(lost.statusCode).toBe(404);
      const noActivity = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/activity`, headers });
      expect(noActivity.statusCode).toBe(404);
    } finally { await app.close(); }
  }, 60_000);
});
