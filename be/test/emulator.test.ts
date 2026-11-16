import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { auth, db } from '../src/firebase.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);

describe.skipIf(!enabled)('Firebase emulator API flow', () => {
  it('creates a trip, splits an expense once, and protects it from outsiders', async () => {
    const app = await buildApp();
    const suffix = randomUUID();
    const email = `sharebill-${suffix}@example.test`;
    const password = `LocalTest-${suffix}!`;
    await auth().createUser({ email, password });
    const signIn = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    expect(signIn.ok).toBe(true);
    const { idToken } = await signIn.json() as { idToken: string };
    const headers = { authorization: `Bearer ${idToken}`, 'idempotency-key': randomUUID() };
    const created = await app.inject({ method: 'POST', url: '/api/v1/trips', headers, payload: { name: 'Đà Lạt', ownerName: 'An' } });
    expect(created.statusCode).toBe(200);
    const { id: tripId, ownerParticipantId } = created.json().data;
    const replay = await app.inject({ method: 'POST', url: '/api/v1/trips', headers, payload: { name: 'Đà Lạt', ownerName: 'An' } });
    expect(replay.json().data.id).toBe(tripId);
    expect(replay.json().meta.replayed).toBe(true);
    const member = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/participants`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { displayName: 'Bình' } });
    expect(member.statusCode).toBe(200);
    const secondParticipantId = member.json().data.id;
    const expenseHeaders = { ...headers, 'idempotency-key': randomUUID() };
    const expensePayload = { title: 'Khách sạn', amountMinor: 101, payerParticipantId: ownerParticipantId, splitMethod: 'equal', split: { participantIds: [secondParticipantId, ownerParticipantId] }, occurredOn: '2026-12-20', category: 'stay', note: null };
    const expense = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/expenses`, headers: expenseHeaders, payload: expensePayload });
    expect(expense.statusCode).toBe(200);
    expect(expense.json().data.shares.reduce((sum: number, s: { amountMinor: number }) => sum + s.amountMinor, 0)).toBe(101);
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/expenses`, headers: expenseHeaders, payload: expensePayload });
    expect(duplicate.json().meta.replayed).toBe(true);
    const overview = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/overview`, headers: { authorization: `Bearer ${idToken}` } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().data.trip.totalExpenseMinor).toBe(101);
    expect(overview.json().data.balances.reduce((sum: number, b: { netMinor: number }) => sum + b.netMinor, 0)).toBe(0);
    expect((await db().collection(`trips/${tripId}/expenses`).get()).size).toBe(1);
    const unauthorized = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/overview` });
    expect(unauthorized.statusCode).toBe(401);
    await app.close();
  }, 30_000);
});
