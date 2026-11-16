import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { auth, db } from '../src/firebase.js';
import { userDocumentSchema } from '../src/database/user.js';
import { createTripDocuments } from '../src/database/trip.js';
import { Timestamp } from 'firebase-admin/firestore';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);

describe.skipIf(!enabled)('Firebase emulator API flow', () => {
  it('rolls back every initial trip document when its transaction fails', async () => {
    const tripId = randomUUID();
    const participantId = randomUUID();
    const auditEventId = randomUUID();
    const ownerUid = randomUUID();
    const key = randomUUID();
    const store = db();
    const initial = createTripDocuments({ tripId, participantId, auditEventId, ownerUid,
      ownerName: 'An', name: 'Chuyến lỗi', operationKey: key, now: Timestamp.now() });
    const entries = [
      [`trips/${tripId}`, initial.trip],
      [`trips/${tripId}/memberships/${ownerUid}`, initial.membership],
      [`trips/${tripId}/participants/${participantId}`, initial.participant],
      [`trips/${tripId}/participantLinks/${ownerUid}`, initial.participantLink],
      [`trips/${tripId}/balances/${participantId}`, initial.balance],
      [`trips/${tripId}/signals/current`, initial.signal],
      [`users/${ownerUid}/tripRefs/${tripId}`, initial.tripRef],
      [`trips/${tripId}/auditEvents/${auditEventId}`, initial.audit],
      [`users/${ownerUid}/operations/${key}`, { response: { id: tripId } }],
    ] as const;
    await expect(store.runTransaction(async tx => {
      for (const [path, document] of entries) tx.create(store.doc(path), document);
      throw new Error('simulated write failure');
    })).rejects.toThrow('simulated write failure');
    const snapshots = await Promise.all(entries.map(([path]) => store.doc(path).get()));
    expect(snapshots.every(snapshot => !snapshot.exists)).toBe(true);
  }, 30_000);

  it('registers, logs in, refreshes JWT, and rejects invalid or disabled sessions', async () => {
    process.env.FIREBASE_WEB_API_KEY = 'demo';
    const app = await buildApp();
    const email = `auth-${randomUUID()}@example.test`;
    const password = 'TestPassword-123!';
    const payload = { email, password, displayName: 'An' };
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { ...payload, password: 'short' } });
    expect(invalid.statusCode).toBe(422);
    const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload });
    expect(registered.statusCode).toBe(201);
    expect(registered.headers['cache-control']).toBe('no-store');
    const session = registered.json().data;
    expect(session.accessToken.split('.')).toHaveLength(3);
    expect(session.refreshToken).toBeTruthy();
    expect(session.user).toMatchObject({ email, displayName: 'An' });
    const profile = (await db().doc(`users/${session.user.uid}`).get()).data();
    expect(userDocumentSchema.safeParse(profile).success).toBe(true);
    expect(profile).toMatchObject({ status: 'active', schemaVersion: 1, displayName: 'An' });
    const trip = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': randomUUID() }, payload: { name: 'Huế', ownerName: 'An' } });
    expect(trip.statusCode).toBe(200);
    const duplicate = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload });
    expect(duplicate.statusCode).toBe(409);
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'wrong-password' } });
    expect(wrong.statusCode).toBe(401);
    const loggedIn = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: email.toUpperCase(), password } });
    expect(loggedIn.statusCode).toBe(200);
    expect(loggedIn.json().data.user.displayName).toBe('An');
    const refreshed = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: session.refreshToken } });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().data.accessToken).toBeTruthy();
    const badRefresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: 'invalid' } });
    expect(badRefresh.statusCode).toBe(401);
    await db().doc(`users/${session.user.uid}`).update({ status: 'disabled', moderationVersion: 7, desiredAuthDisabled: true });
    const disabledLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    expect(disabledLogin.statusCode).toBe(403);
    const disabledRefresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: session.refreshToken } });
    expect(disabledRefresh.statusCode).toBe(403);
    expect((await db().doc(`users/${session.user.uid}`).get()).data()).toMatchObject({ status: 'disabled', moderationVersion: 7, desiredAuthDisabled: true, displayName: 'An' });
    await app.close();
  }, 30_000);

  it('bootstraps SDK users and direct Auth users without accepting profile fields from the client', async () => {
    const app = await buildApp();
    const password = 'TestPassword-123!';
    const signIn = async (email: string) => {
      const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      expect(response.ok).toBe(true);
      return ((await response.json()) as { idToken: string }).idToken;
    };

    const sdkEmail = `sdk-${randomUUID()}@example.test`;
    const sdk = await auth().createUser({ email: sdkEmail, password, displayName: 'Tên từ Auth' });
    const sdkToken = await signIn(sdkEmail);
    const sdkHeaders = { authorization: `Bearer ${sdkToken}` };
    const missing = await app.inject({ method: 'GET', url: '/api/v1/me', headers: sdkHeaders });
    expect(missing.statusCode).toBe(404);
    const forbiddenInput = await app.inject({ method: 'POST', url: '/api/v1/me/bootstrap', headers: sdkHeaders, payload: { status: 'active', role: 'admin' } });
    expect(forbiddenInput.statusCode).toBe(422);
    expect((await db().doc(`users/${sdk.uid}`).get()).exists).toBe(false);
    const bootstrapped = await app.inject({ method: 'POST', url: '/api/v1/me/bootstrap', headers: sdkHeaders });
    expect(bootstrapped.statusCode).toBe(200);
    expect(bootstrapped.headers['cache-control']).toBe('no-store');
    expect(bootstrapped.json().data).toMatchObject({ uid: sdk.uid, email: sdkEmail, displayName: 'Tên từ Auth', status: 'active' });
    expect(userDocumentSchema.safeParse((await db().doc(`users/${sdk.uid}`).get()).data()).success).toBe(true);
    const read = await app.inject({ method: 'GET', url: '/api/v1/me', headers: sdkHeaders });
    expect(read.json().data.displayName).toBe('Tên từ Auth');
    await db().doc(`users/${sdk.uid}`).update({ displayName: 'Tên đã sửa', moderationVersion: 5 });
    const repeated = await app.inject({ method: 'POST', url: '/api/v1/me/bootstrap', headers: sdkHeaders });
    expect(repeated.json().data.displayName).toBe('Tên đã sửa');
    expect((await db().doc(`users/${sdk.uid}`).get()).get('moderationVersion')).toBe(5);

    const directEmail = `direct-${randomUUID()}@example.test`;
    const direct = await auth().createUser({ email: directEmail, password });
    const directToken = await signIn(directEmail);
    const created = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: { authorization: `Bearer ${directToken}`, 'idempotency-key': randomUUID() }, payload: { name: 'Sa Pa', ownerName: 'An' } });
    expect(created.statusCode).toBe(200);
    expect(userDocumentSchema.safeParse((await db().doc(`users/${direct.uid}`).get()).data()).success).toBe(true);

    const legacyEmail = `legacy-${randomUUID()}@example.test`;
    const legacy = await auth().createUser({ email: legacyEmail, password });
    const legacyDoc = { status: 'active', createdAt: new Date('2025-01-01T00:00:00.000Z'), updatedAt: new Date('2025-01-01T00:00:00.000Z') };
    await db().doc(`users/${legacy.uid}`).create(legacyDoc);
    const legacyLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: legacyEmail, password } });
    expect(legacyLogin.statusCode).toBe(200);
    expect(legacyLogin.json().data.user).toMatchObject({ uid: legacy.uid, displayName: legacyEmail.split('@')[0] });
    expect((await db().doc(`users/${legacy.uid}`).get()).data()).toEqual(expect.objectContaining({ status: 'active' }));
    expect((await db().doc(`users/${legacy.uid}`).get()).get('schemaVersion')).toBeUndefined();
    await app.close();
  }, 30_000);

  it('creates a trip, splits an expense once, and protects it from outsiders', async () => {
    const app = await buildApp();
    const suffix = randomUUID();
    const email = `sharebill-${suffix}@example.test`;
    const password = `LocalTest-${suffix}!`;
    const ownerIdentity = await auth().createUser({ email, password });
    const signIn = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    expect(signIn.ok).toBe(true);
    const { idToken } = await signIn.json() as { idToken: string };
    const headers = { authorization: `Bearer ${idToken}`, 'idempotency-key': randomUUID() };
    const created = await app.inject({ method: 'POST', url: '/api/v1/trips', headers, payload: { name: 'Đà Lạt', ownerName: 'An' } });
    expect(created.statusCode).toBe(200);
    const { id: tripId, ownerParticipantId } = created.json().data;
    const store = db();
    const [tripDoc, ownerDoc, participantDoc, linkDoc, balanceDoc, signalDoc, refDoc, auditQuery, operationDoc] = await Promise.all([
      store.doc(`trips/${tripId}`).get(), store.doc(`trips/${tripId}/memberships/${ownerIdentity.uid}`).get(),
      store.doc(`trips/${tripId}/participants/${ownerParticipantId}`).get(),
      store.doc(`trips/${tripId}/participantLinks/${ownerIdentity.uid}`).get(),
      store.doc(`trips/${tripId}/balances/${ownerParticipantId}`).get(), store.doc(`trips/${tripId}/signals/current`).get(),
      store.doc(`users/${ownerIdentity.uid}/tripRefs/${tripId}`).get(),
      store.collection(`trips/${tripId}/auditEvents`).get(),
      store.doc(`users/${ownerIdentity.uid}/operations/${headers['idempotency-key']}`).get(),
    ]);
    const ownerUid = ownerIdentity.uid;
    expect([tripDoc, ownerDoc, participantDoc, linkDoc, balanceDoc, signalDoc, refDoc, operationDoc].every(doc => doc.exists)).toBe(true);
    expect(auditQuery.size).toBe(1);
    expect(tripDoc.data()).toMatchObject({ schemaVersion: 1, ownerUid, createdBy: ownerUid, name: 'Đà Lạt',
      timezone: 'Asia/Ho_Chi_Minh', currency: 'VND', currencyExponent: 0, inviteEpoch: 1,
      moderationVersion: 1, participantCount: 1, membershipCountAllTime: 1,
      categoryTotalsMinor: { food: 0, transport: 0, stay: 0, tickets: 0, shopping: 0, other: 0 },
      totalExpenseMinor: 0, revision: 1, ledgerVersion: 0, archivedAt: null });
    expect(ownerDoc.data()).toMatchObject({ schemaVersion: 1, uid: ownerUid, role: 'owner', status: 'active', participantId: ownerParticipantId, removedAt: null });
    expect(participantDoc.data()).toMatchObject({ schemaVersion: 1, id: ownerParticipantId, linkedUid: ownerUid, createdBy: ownerUid, hasLedgerReferences: false });
    expect(linkDoc.data()).toMatchObject({ schemaVersion: 1, uid: ownerUid, participantId: ownerParticipantId });
    expect(balanceDoc.data()).toMatchObject({ schemaVersion: 1, participantId: ownerParticipantId, netMinor: 0 });
    expect(signalDoc.data()).toMatchObject({ revision: 1, ledgerVersion: 0 });
    expect(refDoc.data()).toMatchObject({ tripId, status: 'active' });
    expect(auditQuery.docs[0]?.data()).toMatchObject({ action: 'trip.created', actorUid: ownerUid, entityId: tripId, operationKey: headers['idempotency-key'] });
    const createdAt = tripDoc.get('createdAt').toMillis();
    for (const doc of [ownerDoc, participantDoc, refDoc, auditQuery.docs[0]!]) expect(doc.get('createdAt')?.toMillis?.() ?? doc.get('joinedAt')?.toMillis()).toBe(createdAt);
    const tripCountBeforeReplay = (await store.collection('trips').get()).size;
    const tripList = await app.inject({ method: 'GET', url: '/api/v1/trips', headers: { authorization: `Bearer ${idToken}` } });
    expect(tripList.json().data.items.some((trip: { id: string }) => trip.id === tripId)).toBe(true);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/trips', headers, payload: { name: 'Đà Lạt', ownerName: 'An' } });
    expect(replay.json().data.id).toBe(tripId);
    expect(replay.json().meta.replayed).toBe(true);
    const reused = await app.inject({ method: 'POST', url: '/api/v1/trips', headers, payload: { name: 'Chuyến khác', ownerName: 'An' } });
    expect(reused.statusCode).toBe(409);
    expect((await store.collection('trips').get()).size).toBe(tripCountBeforeReplay);
    expect((await store.collection(`trips/${tripId}/auditEvents`).get()).size).toBe(1);
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
