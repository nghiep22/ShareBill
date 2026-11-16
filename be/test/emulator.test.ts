import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { auth, db } from '../src/firebase.js';
import { userDocumentSchema } from '../src/database/user.js';
import { createTripDocuments } from '../src/database/trip.js';
import { expenseDocumentSchema } from '../src/database/expense.js';
import { settlementDocumentSchema } from '../src/database/settlement.js';
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

  it('creates unlinked participants with zero balances and stops at 50 without orphan records', async () => {
    const app = await buildApp();
    const email = `participants-${randomUUID()}@example.test`;
    const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
      payload: { email, password: 'TestPassword-123!', displayName: 'An' } });
    expect(registered.statusCode).toBe(201);
    const { accessToken, user } = registered.json().data;
    const authorization = `Bearer ${accessToken}`;
    const created = await app.inject({ method: 'POST', url: '/api/v1/trips',
      headers: { authorization, 'idempotency-key': randomUUID() }, payload: { name: 'Đà Nẵng', ownerName: 'An' } });
    expect(created.statusCode).toBe(200);
    const tripId = created.json().data.id as string;
    const url = `/api/v1/trips/${tripId}/participants`;
    const firstKey = randomUUID();
    const firstPayload = { displayName: 'Người 01' };
    const first = await app.inject({ method: 'POST', url,
      headers: { authorization, 'idempotency-key': firstKey }, payload: firstPayload });
    expect(first.statusCode).toBe(200);
    const firstId = first.json().data.id as string;
    const store = db();
    const [participant, balance, tripAfterFirst, signalAfterFirst] = await Promise.all([
      store.doc(`trips/${tripId}/participants/${firstId}`).get(),
      store.doc(`trips/${tripId}/balances/${firstId}`).get(),
      store.doc(`trips/${tripId}`).get(), store.doc(`trips/${tripId}/signals/current`).get(),
    ]);
    expect(participant.data()).toMatchObject({ schemaVersion: 1, id: firstId, displayName: 'Người 01',
      linkedUid: null, status: 'active', version: 1, hasLedgerReferences: false, createdBy: user.uid });
    expect(balance.data()).toMatchObject({ schemaVersion: 1, participantId: firstId,
      paidMinor: 0, owedMinor: 0, sentMinor: 0, receivedMinor: 0, netMinor: 0 });
    expect(participant.get('createdAt').toMillis()).toBe(participant.get('updatedAt').toMillis());
    expect(balance.get('updatedAt').toMillis()).toBe(participant.get('createdAt').toMillis());
    expect(tripAfterFirst.get('participantCount')).toBe(2);
    expect(tripAfterFirst.get('revision')).toBe(2);
    expect(signalAfterFirst.get('schemaVersion')).toBe(1);
    expect(signalAfterFirst.get('revision')).toBe(2);

    const replay = await app.inject({ method: 'POST', url,
      headers: { authorization, 'idempotency-key': firstKey }, payload: firstPayload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(firstId);
    expect(replay.json().meta.replayed).toBe(true);
    expect((await store.doc(`trips/${tripId}`).get()).get('participantCount')).toBe(2);

    for (let number = 2; number <= 49; number++) {
      const added = await app.inject({ method: 'POST', url,
        headers: { authorization, 'idempotency-key': randomUUID() },
        payload: { displayName: `Người ${String(number).padStart(2, '0')}` } });
      expect(added.statusCode).toBe(200);
    }
    const countAtLimit = await store.doc(`trips/${tripId}`).get();
    expect(countAtLimit.get('participantCount')).toBe(50);
    expect(countAtLimit.get('revision')).toBe(50);
    const failedKey = randomUUID();
    const blocked = await app.inject({ method: 'POST', url,
      headers: { authorization, 'idempotency-key': failedKey }, payload: { displayName: 'Người 50' } });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('TRIP_LIMIT_REACHED');
    const replayAtLimit = await app.inject({ method: 'POST', url,
      headers: { authorization, 'idempotency-key': firstKey }, payload: firstPayload });
    expect(replayAtLimit.statusCode).toBe(200);
    expect(replayAtLimit.json().data.id).toBe(firstId);
    expect(replayAtLimit.json().meta.replayed).toBe(true);
    const reusedKey = await app.inject({ method: 'POST', url,
      headers: { authorization, 'idempotency-key': firstKey }, payload: { displayName: 'Tên khác' } });
    expect(reusedKey.statusCode).toBe(409);
    const [people, balances, memberships, links, failedOperation, tripAtLimit] = await Promise.all([
      store.collection(`trips/${tripId}/participants`).get(), store.collection(`trips/${tripId}/balances`).get(),
      store.collection(`trips/${tripId}/memberships`).get(), store.collection(`trips/${tripId}/participantLinks`).get(),
      store.doc(`users/${user.uid}/operations/${failedKey}`).get(), store.doc(`trips/${tripId}`).get(),
    ]);
    expect(people.size).toBe(50);
    expect(balances.size).toBe(50);
    expect(people.docs.map(doc => doc.id).sort()).toEqual(balances.docs.map(doc => doc.id).sort());
    expect(people.docs.every(doc => doc.get('schemaVersion') === 1 && doc.get('hasLedgerReferences') === false)).toBe(true);
    expect(balances.docs.every(doc => doc.get('schemaVersion') === 1 && doc.get('netMinor') === 0)).toBe(true);
    expect(memberships.size).toBe(1);
    expect(links.size).toBe(1);
    expect(failedOperation.exists).toBe(false);
    expect(tripAtLimit.get('participantCount')).toBe(50);
    expect(tripAtLimit.get('membershipCountAllTime')).toBe(1);
    expect(tripAtLimit.get('revision')).toBe(50);
    await app.close();
  }, 60_000);

  it('keeps a settlement creation ledger version through pending, confirm, and retry', async () => {
    const app = await buildApp();
    const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
      payload: { email: `settlement-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: 'An' } });
    expect(registered.statusCode).toBe(201);
    const { accessToken, user } = registered.json().data;
    const authorization = `Bearer ${accessToken}`;
    const created = await app.inject({ method: 'POST', url: '/api/v1/trips',
      headers: { authorization, 'idempotency-key': randomUUID() }, payload: { name: 'Hội An', ownerName: 'An' } });
    expect(created.statusCode).toBe(200);
    const { id: tripId, ownerParticipantId } = created.json().data;
    const participant = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/participants`,
      headers: { authorization, 'idempotency-key': randomUUID() }, payload: { displayName: 'Bình' } });
    expect(participant.statusCode).toBe(200);
    const guestId = participant.json().data.id as string;
    const store = db();
    const expenseUrl = `/api/v1/trips/${tripId}/expenses`;
    const expensePayload = (amountMinor: number) => ({ title: 'Ăn uống', amountMinor,
      payerParticipantId: ownerParticipantId, splitMethod: 'equal',
      split: { participantIds: [ownerParticipantId, guestId] }, occurredOn: '2026-12-20', category: 'food' });
    const firstExpense = await app.inject({ method: 'POST', url: expenseUrl,
      headers: { authorization, 'idempotency-key': randomUUID() }, payload: expensePayload(100) });
    expect(firstExpense.statusCode).toBe(200);
    await Promise.all([ownerParticipantId, guestId].map(id =>
      store.doc(`trips/${tripId}/participants/${id}`).update({ hasLedgerReferences: false })));
    const balanceBefore = (await store.collection(`trips/${tripId}/balances`).get()).docs.map(doc => doc.data());
    const settlementUrl = `/api/v1/trips/${tripId}/settlements`;
    const pendingHeaders = { authorization, 'idempotency-key': randomUUID() };
    const pendingPayload = { fromParticipantId: guestId, toParticipantId: ownerParticipantId,
      amountMinor: 10, occurredOn: '2026-12-20', basedOnLedgerVersion: 1 };
    const pending = await app.inject({ method: 'POST', url: settlementUrl,
      headers: pendingHeaders, payload: pendingPayload });
    expect(pending.statusCode).toBe(200);
    const settlementId = pending.json().data.id as string;
    const pendingDoc = await store.doc(`trips/${tripId}/settlements/${settlementId}`).get();
    expect(settlementDocumentSchema.safeParse(pendingDoc.data()).success).toBe(true);
    expect(pendingDoc.data()).toMatchObject({ schemaVersion: 1, currency: 'VND', note: null,
      basedOnLedgerVersion: 1, status: 'pending', version: 1,
      confirmedBy: null, confirmedAt: null, confirmationMode: null,
      cancelledBy: null, cancelledAt: null, voidedBy: null, voidedAt: null, voidReason: null });
    expect(pendingDoc.get('createdAt').toMillis()).toBe(pendingDoc.get('updatedAt').toMillis());
    expect((await store.collection(`trips/${tripId}/balances`).get()).docs.map(doc => doc.data())).toEqual(balanceBefore);
    expect((await store.doc(`trips/${tripId}`).get()).get('ledgerVersion')).toBe(1);
    const pendingList = await app.inject({ method: 'GET', url: settlementUrl,
      headers: { authorization } });
    expect(pendingList.json().data.items[0]).toMatchObject({ id: settlementId,
      currency: 'VND', status: 'pending', basedOnLedgerVersion: 1, confirmedAt: null, confirmationMode: null });
    for (const id of [ownerParticipantId, guestId]) {
      expect((await store.doc(`trips/${tripId}/participants/${id}`).get()).get('hasLedgerReferences')).toBe(true);
    }
    const pendingReplay = await app.inject({ method: 'POST', url: settlementUrl,
      headers: pendingHeaders, payload: pendingPayload });
    expect(pendingReplay.json().meta.replayed).toBe(true);
    expect(pendingReplay.json().data.id).toBe(settlementId);
    expect((await store.collection(`trips/${tripId}/settlements`).get()).size).toBe(1);
    const secondExpense = await app.inject({ method: 'POST', url: expenseUrl,
      headers: { authorization, 'idempotency-key': randomUUID() }, payload: expensePayload(20) });
    expect(secondExpense.statusCode).toBe(200);
    expect((await store.doc(`trips/${tripId}`).get()).get('ledgerVersion')).toBe(2);
    const staleConfirm = await app.inject({ method: 'POST', url: `${settlementUrl}/${settlementId}/confirm`,
      headers: { authorization, 'idempotency-key': randomUUID(), 'if-match': '"1"' },
      payload: { basedOnLedgerVersion: 1 } });
    expect(staleConfirm.statusCode).toBe(409);
    expect(staleConfirm.json().error.code).toBe('LEDGER_CHANGED');
    expect((await store.doc(`trips/${tripId}/settlements/${settlementId}`).get()).get('status')).toBe('pending');
    const confirmHeaders = { authorization, 'idempotency-key': randomUUID(), 'if-match': '"1"' };
    const confirm = await app.inject({ method: 'POST', url: `${settlementUrl}/${settlementId}/confirm`,
      headers: confirmHeaders, payload: { basedOnLedgerVersion: 2 } });
    expect(confirm.statusCode).toBe(200);
    const confirmedDoc = await store.doc(`trips/${tripId}/settlements/${settlementId}`).get();
    expect(settlementDocumentSchema.safeParse(confirmedDoc.data()).success).toBe(true);
    expect(confirmedDoc.data()).toMatchObject({ status: 'confirmed', version: 2,
      basedOnLedgerVersion: 1, confirmedBy: user.uid, confirmationMode: 'owner_on_behalf' });
    expect(confirmedDoc.get('confirmedAt').toMillis()).toBe(confirmedDoc.get('updatedAt').toMillis());
    const confirmedList = await app.inject({ method: 'GET', url: settlementUrl,
      headers: { authorization } });
    expect(confirmedList.json().data.items[0]).toMatchObject({ id: settlementId,
      status: 'confirmed', basedOnLedgerVersion: 1, confirmationMode: 'owner_on_behalf' });
    expect(new Date(confirmedList.json().data.items[0].confirmedAt).getTime()).toBe(confirmedDoc.get('confirmedAt').toMillis());
    const confirmedTrip = await store.doc(`trips/${tripId}`).get();
    expect(confirmedTrip.data()).toMatchObject({ settlementCountAllTime: 1,
      pendingSettlementCount: 0, ledgerVersion: 3 });
    const guestBalance = await store.doc(`trips/${tripId}/balances/${guestId}`).get();
    const ownerBalance = await store.doc(`trips/${tripId}/balances/${ownerParticipantId}`).get();
    expect(guestBalance.get('sentMinor')).toBe(10);
    expect(ownerBalance.get('receivedMinor')).toBe(10);
    const confirmReplay = await app.inject({ method: 'POST', url: `${settlementUrl}/${settlementId}/confirm`,
      headers: confirmHeaders, payload: { basedOnLedgerVersion: 2 } });
    expect(confirmReplay.statusCode).toBe(200);
    expect(confirmReplay.json().meta.replayed).toBe(true);
    expect((await store.doc(`trips/${tripId}`).get()).get('ledgerVersion')).toBe(3);
    expect((await store.doc(`trips/${tripId}/balances/${guestId}`).get()).get('sentMinor')).toBe(10);
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
    const assertProjection = async (total: number, category: string, activeCount: number, ledgerVersion: number) => {
      const [root, signal, balanceQuery] = await Promise.all([
        store.doc(`trips/${tripId}`).get(), store.doc(`trips/${tripId}/signals/current`).get(),
        store.collection(`trips/${tripId}/balances`).get(),
      ]);
      const balances = balanceQuery.docs.map(doc => doc.data() as Record<string, unknown>);
      const sum = (field: string) => balances.reduce((value, balance) => value + BigInt(balance[field] as number), 0n);
      expect(root.get('totalExpenseMinor')).toBe(total);
      expect(root.get('activeExpenseCount')).toBe(activeCount);
      expect(root.get('ledgerVersion')).toBe(ledgerVersion);
      expect(root.get('categoryTotalsMinor')).toEqual({ food: 0, transport: 0, stay: 0,
        tickets: 0, shopping: 0, other: 0, [category]: total });
      expect(sum('paidMinor')).toBe(BigInt(total));
      expect(sum('owedMinor')).toBe(BigInt(total));
      expect(sum('sentMinor')).toBe(sum('receivedMinor'));
      expect(sum('netMinor')).toBe(0n);
      expect(balances.every(balance => balance.schemaVersion === 1 && balance.updatedAt instanceof Timestamp)).toBe(true);
      expect(signal.data()).toMatchObject({ schemaVersion: 1, revision: root.get('revision'), ledgerVersion });
    };
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
    const expenseId = expense.json().data.id as string;
    const storedExpense = await store.doc(`trips/${tripId}/expenses/${expenseId}`).get();
    const expenseOperation = await store.doc(`users/${ownerUid}/operations/${expenseHeaders['idempotency-key']}`).get();
    expect(expenseOperation.get('requestHash')).toBe(createHash('sha256').update(JSON.stringify(expensePayload)).digest('hex'));
    expect(expenseDocumentSchema.safeParse(storedExpense.data()).success).toBe(true);
    expect(storedExpense.data()).toMatchObject({ schemaVersion: 1, currency: 'VND', splitInput: expensePayload.split,
      receiptIds: [], createdBy: ownerUid, updatedBy: ownerUid,
      voidedAt: null, voidedBy: null, voidReason: null });
    expect(storedExpense.get('split')).toBeUndefined();
    const expenseDetail = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/expenses/${expenseId}`,
      headers: { authorization: `Bearer ${idToken}` } });
    expect(expenseDetail.json().data.splitInput).toEqual(expensePayload.split);
    const expenseList = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/expenses`, headers: { authorization: `Bearer ${idToken}` } });
    expect(expenseList.json().data.items).toHaveLength(1);
    await assertProjection(101, 'stay', 1, 1);
    const [ownerAfterExpense, secondAfterExpense] = await Promise.all([
      store.doc(`trips/${tripId}/participants/${ownerParticipantId}`).get(),
      store.doc(`trips/${tripId}/participants/${secondParticipantId}`).get(),
    ]);
    expect(ownerAfterExpense.get('hasLedgerReferences')).toBe(true);
    expect(secondAfterExpense.get('hasLedgerReferences')).toBe(true);
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
    await assertProjection(101, 'stay', 1, 1);
    const settlementId = pending.json().data.id;
    const settlementList = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/settlements`, headers: { authorization: `Bearer ${idToken}` } });
    expect(settlementList.json().data.items).toHaveLength(1);
    const beforeConfirm = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/overview`, headers: { authorization: `Bearer ${idToken}` } });
    expect(beforeConfirm.json().data.balances).toEqual(overview.json().data.balances);
    const confirm = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/settlements/${settlementId}/confirm`, headers: { ...headers, 'idempotency-key': randomUUID(), 'if-match': '"1"' }, payload: { basedOnLedgerVersion: 1 } });
    expect(confirm.statusCode).toBe(200);
    const settled = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/overview`, headers: { authorization: `Bearer ${idToken}` } });
    expect(settled.json().data.balances.every((b: { netMinor: number }) => b.netMinor === 0)).toBe(true);
    await assertProjection(101, 'stay', 1, 2);
    const voidHeaders = { ...headers, 'idempotency-key': randomUUID(), 'if-match': '"1"' };
    const voided = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/expenses/${expenseId}/void`,
      headers: voidHeaders, payload: { reason: 'Nhập nhầm khoản chi' } });
    expect(voided.statusCode).toBe(200);
    await assertProjection(0, 'stay', 0, 3);
    const voidReplay = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/expenses/${expenseId}/void`,
      headers: voidHeaders, payload: { reason: 'Nhập nhầm khoản chi' } });
    expect(voidReplay.statusCode).toBe(200);
    expect(voidReplay.json().meta.replayed).toBe(true);
    await assertProjection(0, 'stay', 0, 3);
    const voidedExpense = await store.doc(`trips/${tripId}/expenses/${expenseId}`).get();
    expect(expenseDocumentSchema.safeParse(voidedExpense.data()).success).toBe(true);
    expect(voidedExpense.data()).toMatchObject({ status: 'void', version: 2, voidedBy: ownerUid,
      updatedBy: ownerUid, voidReason: 'Nhập nhầm khoản chi', splitInput: expensePayload.split });
    const afterVoid = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/overview`, headers: { authorization: `Bearer ${idToken}` } });
    expect(afterVoid.json().data.trip.totalExpenseMinor).toBe(0);
    expect(afterVoid.json().data.balances.reduce((sum: number, b: { netMinor: number }) => sum + b.netMinor, 0)).toBe(0);
    expect((await store.doc(`trips/${tripId}/participants/${secondParticipantId}`).get()).get('hasLedgerReferences')).toBe(true);
    const exactPayload = { ...expensePayload, title: 'Vé', splitMethod: 'exact',
      split: { shares: [{ participantId: ownerParticipantId, amountMinor: 1 },
        { participantId: secondParticipantId, amountMinor: 100 }] }, category: 'tickets', receiptIds: [] };
    const exact = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/expenses`,
      headers: { ...headers, 'idempotency-key': randomUUID() }, payload: exactPayload });
    expect(exact.statusCode).toBe(200);
    const exactDoc = await store.doc(`trips/${tripId}/expenses/${exact.json().data.id}`).get();
    expect(expenseDocumentSchema.safeParse(exactDoc.data()).success).toBe(true);
    expect(exactDoc.get('splitInput')).toEqual(exactPayload.split);
    expect(exactDoc.get('shares').reduce((sum: number, share: { amountMinor: number }) => sum + share.amountMinor, 0)).toBe(101);
    await assertProjection(101, 'tickets', 1, 4);
    const receiptAttempt = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/expenses`,
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { ...exactPayload, receiptIds: [randomUUID()] } });
    expect(receiptAttempt.statusCode).toBe(422);
    expect(receiptAttempt.json().error.code).toBe('RECEIPTS_UNAVAILABLE');
    const legacyId = randomUUID();
    const legacyTime = Timestamp.now();
    const legacySplit = { participantIds: [ownerParticipantId] };
    await store.doc(`trips/${tripId}/expenses/${legacyId}`).create({ id: legacyId, title: 'Khoản chi cũ',
      amountMinor: 25, payerParticipantId: ownerParticipantId, splitMethod: 'equal', split: legacySplit,
      shares: [{ participantId: ownerParticipantId, amountMinor: 25 }], occurredOn: '2026-12-19',
      category: 'food', note: null, status: 'active', version: 1, createdBy: ownerUid,
      createdAt: legacyTime, updatedAt: legacyTime });
    const legacyDetail = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/expenses/${legacyId}`,
      headers: { authorization: `Bearer ${idToken}` } });
    expect(legacyDetail.statusCode).toBe(200);
    expect(legacyDetail.json().data).toMatchObject({ split: legacySplit, splitInput: legacySplit,
      shares: [{ participantId: ownerParticipantId, amountMinor: 25 }] });
    const mixedList = await app.inject({ method: 'GET', url: `/api/v1/trips/${tripId}/expenses`,
      headers: { authorization: `Bearer ${idToken}` } });
    expect(mixedList.json().data.items).toHaveLength(3);
    expect(mixedList.json().data.items.find((item: { id: string }) => item.id === legacyId).splitInput).toEqual(legacySplit);
    await store.doc(`trips/${tripId}/balances/${secondParticipantId}`).delete();
    const revisionBeforeFailure = (await store.doc(`trips/${tripId}`).get()).get('revision');
    const missingBalanceKey = randomUUID();
    const missingBalance = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/expenses`,
      headers: { ...headers, 'idempotency-key': missingBalanceKey }, payload: expensePayload });
    expect(missingBalance.statusCode).toBe(409);
    expect(missingBalance.json().error.code).toBe('PROJECTION_INVARIANT_FAILED');
    expect((await store.collection(`trips/${tripId}/expenses`).get()).size).toBe(3);
    expect((await store.doc(`trips/${tripId}`).get()).get('revision')).toBe(revisionBeforeFailure);
    expect((await store.doc(`users/${ownerUid}/operations/${missingBalanceKey}`).get()).exists).toBe(false);
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
