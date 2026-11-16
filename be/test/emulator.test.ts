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
    const tripList = await app.inject({ method: 'GET', url: '/api/v1/trips', headers: { authorization: `Bearer ${idToken}` } });
    expect(tripList.json().data.items.some((trip: { id: string }) => trip.id === tripId)).toBe(true);
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
    const expenseList = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/expenses`, headers: { authorization: `Bearer ${idToken}` } });
    expect(expenseList.json().data.items).toHaveLength(1);
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/expenses`, headers: expenseHeaders, payload: expensePayload });
    expect(duplicate.json().meta.replayed).toBe(true);
    const overview = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/overview`, headers: { authorization: `Bearer ${idToken}` } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().data.trip.totalExpenseMinor).toBe(101);
    expect(overview.json().data.balances.reduce((sum: number, b: { netMinor: number }) => sum + b.netMinor, 0)).toBe(0);
    expect((await db().collection(`trips/${tripId}/expenses`).get()).size).toBe(1);
    const suggestions = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/settlement-suggestions`, headers: { authorization: `Bearer ${idToken}` } });
    expect(suggestions.statusCode).toBe(200);
    const suggestion = suggestions.json().data.suggestions[0];
    expect(suggestion.amountMinor).toBeGreaterThan(0);
    const pending = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/settlements`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { ...suggestion, occurredOn: '2026-12-20', note: null, basedOnLedgerVersion: 1 } });
    expect(pending.statusCode).toBe(200);
    const settlementId = pending.json().data.id;
    const settlementList = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/settlements`, headers: { authorization: `Bearer ${idToken}` } });
    expect(settlementList.json().data.items).toHaveLength(1);
    const beforeConfirm = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/overview`, headers: { authorization: `Bearer ${idToken}` } });
    expect(beforeConfirm.json().data.balances).toEqual(overview.json().data.balances);
    const confirm = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/settlements/${settlementId}/confirm`, headers: { ...headers, 'idempotency-key': randomUUID(), 'if-match': '"1"' }, payload: { basedOnLedgerVersion: 1 } });
    expect(confirm.statusCode).toBe(200);
    const settled = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/overview`, headers: { authorization: `Bearer ${idToken}` } });
    expect(settled.json().data.balances.every((b: { netMinor: number }) => b.netMinor === 0)).toBe(true);
    const voided = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/expenses/${expense.json().data.id}/void`, headers: { ...headers, 'idempotency-key': randomUUID(), 'if-match': '"1"' }, payload: { reason: 'Nhập nhầm khoản chi' } });
    expect(voided.statusCode).toBe(200);
    const afterVoid = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/overview`, headers: { authorization: `Bearer ${idToken}` } });
    expect(afterVoid.json().data.trip.totalExpenseMinor).toBe(0);
    expect(afterVoid.json().data.balances.reduce((sum: number, b: { netMinor: number }) => sum + b.netMinor, 0)).toBe(0);
    const unauthorized = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/overview` });
    expect(unauthorized.statusCode).toBe(401);
    const outsiderEmail = `sharebill-outsider-${suffix}@example.test`;
    await auth().createUser({ email: outsiderEmail, password });
    const outsiderSignIn = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: outsiderEmail, password, returnSecureToken: true }),
    });
    const outsiderToken = ((await outsiderSignIn.json()) as { idToken: string }).idToken;
    const outsider = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/overview`, headers: { authorization: `Bearer ${outsiderToken}` } });
    expect(outsider.statusCode).toBe(404);
    await app.close();
  }, 30_000);
});
