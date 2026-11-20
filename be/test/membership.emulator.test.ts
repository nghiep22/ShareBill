import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { db } from '../src/firebase.js';
import { checkDatabase } from '../src/database/check-integrity.js';
import { createUserDocument } from '../src/database/user.js';
import { inviteTokenHash } from '../src/services/invites.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) { process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill'; process.env.FIREBASE_WEB_API_KEY ??= 'demo'; }
type Identity = { accessToken: string; user: { uid: string; displayName: string } };

describe.skipIf(!enabled)('S08 invites and membership lifecycle', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const logs: string[] = [];
  beforeAll(async () => {
    app = await buildApp(Fastify({ logger: { stream: { write: (line: string) => { logs.push(line); } } } }));
  });
  afterAll(async () => { await app?.close(); });
  async function register(name = 'Thành viên'): Promise<Identity> {
    const result = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
      email: `s08-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: name,
    } });
    expect(result.statusCode).toBe(201);
    return result.json().data;
  }
  function post(path: string, payload: object, actor: Identity, version?: number, key = randomUUID()) {
    return app.inject({ method: 'POST', url: path, payload, headers: { authorization: `Bearer ${actor.accessToken}`,
      'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': `"${version}"` }) } });
  }
  function get(path: string, actor: Identity) {
    return app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${actor.accessToken}` } });
  }
  async function fixture() {
    const owner = await register('An');
    const response = await post('/api/v1/trips', { name: 'Đà Lạt', sharingMode: 'per-expense', ownerName: 'An' }, owner);
    expect(response.statusCode).toBe(200);
    const { id, ownerParticipantId } = response.json().data;
    const path = `/api/v1/trips/${id}`, trip = db().doc(`trips/${id}`);
    return { owner, id: id as string, ownerParticipantId: ownerParticipantId as string, path, trip };
  }
  async function invite(f: Awaited<ReturnType<typeof fixture>>, maxUses = 20) {
    const result = await post(`${f.path}/invites`, { maxUses }, f.owner);
    expect(result.statusCode, result.body).toBe(201);
    return result.json().data as { id: string; token: string; version: number };
  }
  async function join(f: Awaited<ReturnType<typeof fixture>>, actor: Identity) {
    const invitation = await invite(f);
    const key = randomUUID(), response = await post('/api/v1/invites/accept', { token: invitation.token }, actor, undefined, key);
    expect(response.statusCode, response.body).toBe(200);
    return { invitation, key };
  }
  async function link(f: Awaited<ReturnType<typeof fixture>>, actor: Identity) {
    const participant = await post(`${f.path}/participants`, { displayName: 'Người đi cùng' }, f.owner);
    expect(participant.statusCode).toBe(200);
    const id = participant.json().data.id as string;
    const response = await post(`${f.path}/memberships/${actor.user.uid}/link`,
      { participantId: id, reason: 'Xác nhận danh tính' }, f.owner, 1);
    expect(response.statusCode, response.body).toBe(200);
    return id;
  }

  it('returns each raw capability once, keeps storage/logs safe and paginates owner-only lists', async () => {
    const f = await fixture(), outsider = await register(), key = randomUUID();
    const create = () => post(`${f.path}/invites`, {}, f.owner, undefined, key);
    const results = await Promise.all([create(), create()]);
    expect(results.map(result => result.statusCode)).toEqual([201, 201]);
    const original = results.find(result => result.json().data.tokenAvailable)!, replay = results.find(result => !result.json().data.tokenAvailable)!;
    const data = original.json().data;
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(data).toMatchObject({ maxUses: 20, usedCount: 0, version: 1 });
    expect(Date.parse(data.expiresAt) - Date.parse(data.createdAt)).toBe(7 * 86_400_000);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().data).toMatchObject({ id: data.id, tokenAvailable: false, message: expect.any(String) });
    expect(replay.body).not.toContain(data.token);
    const stored = await f.trip.collection('invites').get();
    expect(stored.size).toBe(1);
    const op = await db().doc(`users/${f.owner.user.uid}/operations/${key}`).get();
    const lookup = await db().doc(`inviteTokens/${inviteTokenHash(data.token)}`).get();
    expect(lookup.exists).toBe(true);
    expect(lookup.data()).toMatchObject({ tripId: f.id, inviteId: data.id });
    const audit = await f.trip.collection('auditEvents').get();
    expect(JSON.stringify([stored.docs.map(doc => doc.data()), op.data(), lookup.data(), audit.docs.map(doc => doc.data())]))
      .not.toContain(data.token);
    expect((await get(`/api/v1/operations/${key}`, f.owner)).json().data.resourceType).toBe('invite');
    const preview = await post('/api/v1/invites/preview', { token: data.token }, outsider);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data).toEqual({ trip: { id: f.id, name: 'Đà Lạt', sharingMode: 'per-expense' }, inviter: { displayName: 'An' }, expiresAt: data.expiresAt });
    expect((await f.trip.collection('invites').doc(data.id).get()).get('usedCount')).toBe(0);
    const unauthenticated = await app.inject({ method: 'POST', url: '/api/v1/invites/preview', payload: { token: data.token } });
    expect(unauthenticated.statusCode).toBe(401);
    for (const payload of [{ expiresInDays: 0 }, { expiresInDays: 8 }, { expiresInDays: 1.5 }, { maxUses: 0 }, { maxUses: 21 }, { role: 'owner' }]) {
      expect((await post(`${f.path}/invites`, payload, f.owner)).statusCode).toBe(422);
    }
    expect((await post(`${f.path}/invites`, {}, outsider)).statusCode).toBe(404);
    expect((await get(`${f.path}/invites`, outsider)).statusCode).toBe(404);
    await join(f, outsider);
    expect((await post(`${f.path}/invites`, {}, outsider)).statusCode).toBe(403);
    expect((await get(`${f.path}/invites`, outsider)).statusCode).toBe(403);
    await invite(f); await invite(f);
    const first = await get(`${f.path}/invites?limit=2`, f.owner);
    expect(first.json().data.items).toHaveLength(2);
    const cursor = first.json().data.nextCursor;
    const second = await get(`${f.path}/invites?limit=2&cursor=${cursor}`, f.owner);
    expect(new Set([...first.json().data.items, ...second.json().data.items].map(row => row.id)).size).toBe(4);
    expect(second.json().data.nextCursor).toBeNull();
    expect(first.body + second.body).not.toContain(data.token);
    expect((await get(`${f.path}/invites?limit=51`, f.owner)).statusCode).toBe(422);
    await invite(f);
    expect((await get(`${f.path}/invites?limit=2&cursor=${cursor}`, f.owner)).json().error.code).toBe('CURSOR_STALE');
    expect((await post(`${f.path}/invites`, { maxUses: 1 }, f.owner, undefined, key)).json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(logs.join('')).not.toContain(data.token);
    expect((await checkDatabase(db(), { tripId: f.id, pageSize: 20 })).issues).toEqual([]);
  }, 30_000);

  it('serializes the last invitation use, deduplicates joins and replays safely after revoke', async () => {
    const f = await fixture(), people = await Promise.all([register(), register()]), invitation = await invite(f, 1);
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all(people.map((person, i) => post('/api/v1/invites/accept', { token: invitation.token }, person, undefined, keys[i])));
    expect(results.map(row => row.statusCode).sort()).toEqual([200, 404]);
    const index = results.findIndex(row => row.statusCode === 200), winner = people[index]!, loser = people[1 - index]!;
    const joined = results[index]!.json().data;
    expect(joined).toMatchObject({ status: 'joined', participantId: null, version: 1 });
    expect((await f.trip.get()).data()).toMatchObject({ membershipCountAllTime: 2, participantCount: 1, ledgerVersion: 0 });
    expect((await f.trip.collection('invites').doc(invitation.id).get()).data()).toMatchObject({ usedCount: 1, version: 2 });
    expect((await f.trip.collection('memberships').doc(loser.user.uid).get()).exists).toBe(false);
    expect((await db().doc(`users/${loser.user.uid}/tripRefs/${f.id}`).get()).exists).toBe(false);
    expect((await db().doc(`users/${loser.user.uid}/operations/${keys[1 - index]}`).get()).exists).toBe(false);
    const before = (await f.trip.get()).data();
    const preview = await post('/api/v1/invites/preview', { token: invitation.token }, winner);
    expect(preview.json().data).toMatchObject({ alreadyMember: true, trip: { id: f.id } });
    expect((await post('/api/v1/invites/preview', { token: invitation.token }, loser)).statusCode).toBe(404);
    const again = await post('/api/v1/invites/accept', { token: invitation.token }, winner);
    expect(again.json().data.status).toBe('already-member');
    expect((await f.trip.get()).data()).toEqual(before);
    const lookup = await get(`/api/v1/operations/${keys[index]}`, winner);
    expect(lookup.json().data).toMatchObject({ resourceType: 'membership', resourceId: winner.user.uid });
    const revokePath = `${f.path}/invites/${invitation.id}/revoke`;
    expect((await post(revokePath, {}, f.owner)).statusCode).toBe(428);
    expect((await post(revokePath, {}, f.owner, 1)).json().error.code).toBe('VERSION_CONFLICT');
    expect((await post(revokePath, {}, winner, 2)).statusCode).toBe(403);
    const revokeKey = randomUUID(), revoked = await post(revokePath, {}, f.owner, 2, revokeKey);
    expect(revoked.json().data.status).toBe('revoked');
    expect((await post(revokePath, {}, f.owner, 2, revokeKey)).headers['idempotency-replayed']).toBe('true');
    expect((await post(revokePath, {}, f.owner, 3)).json().error.code).toBe('INVITE_ALREADY_REVOKED');
    const replay = await post('/api/v1/invites/accept', { token: invitation.token }, winner, undefined, keys[index]);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().data).toEqual(joined);
    expect((await post('/api/v1/invites/preview', { token: invitation.token }, winner)).statusCode).toBe(404);
    expect((await post('/api/v1/invites/accept', { token: invitation.token }, loser)).statusCode).toBe(404);
    expect((await checkDatabase(db(), { tripId: f.id, pageSize: 20 })).issues).toEqual([]);
  }, 30_000);

  it('rejects expired, revoked, invalidated and locked invitations without consuming uses', async () => {
    const f = await fixture(), person = await register(), invitation = await invite(f);
    const inviteRef = f.trip.collection('invites').doc(invitation.id), baseline = (await inviteRef.get()).data()!;
    const lookupRef = db().doc(`inviteTokens/${inviteTokenHash(invitation.token)}`), lookup = (await lookupRef.get()).data()!;
    const states = [
      { invite: { createdAt: Timestamp.fromMillis(Date.now() - 10_000), expiresAt: Timestamp.fromMillis(Date.now() - 1) } },
      { invite: { revokedAt: Timestamp.now() } }, { trip: { inviteEpoch: 2 } },
      { trip: { status: 'archived' } }, { trip: { moderationStatus: 'suspended' } },
      { lookup: { expiresAt: Timestamp.fromMillis(Date.now() - 1) } },
    ];
    for (const state of states) {
      await inviteRef.set({ ...baseline, ...state.invite });
      await lookupRef.set({ ...lookup, ...state.lookup });
      await f.trip.update({ status: 'active', moderationStatus: 'normal', inviteEpoch: 1, ...state.trip });
      for (const endpoint of ['preview', 'accept']) {
        const response = await post(`/api/v1/invites/${endpoint}`, { token: invitation.token }, person);
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json().error.code).toBe('INVITE_UNAVAILABLE');
      }
      expect((await inviteRef.get()).get('usedCount')).toBe(0);
    }
    expect((await post('/api/v1/invites/accept', { token: 'a'.repeat(43) }, person)).statusCode).toBe(404);
    expect((await post('/api/v1/invites/accept', { token: invitation.token, participantId: f.ownerParticipantId }, person)).statusCode).toBe(422);
    await db().doc(`users/${person.user.uid}`).update({ status: 'disabled' });
    expect((await post('/api/v1/invites/preview', { token: invitation.token }, person)).statusCode).toBe(403);
    expect((await post('/api/v1/invites/accept', { token: invitation.token }, person)).statusCode).toBe(403);
    expect((await f.trip.collection('memberships').doc(person.user.uid).get()).exists).toBe(false);
    expect(logs.join('')).not.toContain(invitation.token);
  }, 30_000);

  it('removes access with an unchanged ledger and restores the same membership and identity', async () => {
    const f = await fixture(), person = await register(), { invitation, key: joinKey } = await join(f, person);
    const participantId = await link(f, person), memberRef = f.trip.collection('memberships').doc(person.user.uid);
    const joinedAt = (await memberRef.get()).get('joinedAt');
    const expense = await post(`${f.path}/expenses`, { title: 'Ăn tối', amountMinor: 101,
      payerParticipantId: f.ownerParticipantId, splitMethod: 'equal', split: { participantIds: [f.ownerParticipantId, participantId] },
      occurredOn: '2026-12-20', category: 'food' }, person);
    expect(expense.statusCode, expense.body).toBe(200);
    const money = (await f.trip.collection('balances').get()).docs.map(doc => doc.data());
    const participantBefore = (await f.trip.collection('participants').doc(participantId).get()).data();
    const rootBefore = (await f.trip.get()).data()!;
    const removePath = `${f.path}/memberships/${person.user.uid}/remove`, restorePath = `${f.path}/memberships/${person.user.uid}/restore`;
    expect((await post(`${f.path}/memberships/${f.owner.user.uid}/remove`, { reason: 'Thử' }, f.owner, 1)).statusCode).toBe(422);
    expect((await post(removePath, { reason: 'Thử' }, person, 2)).statusCode).toBe(403);
    const removeKey = randomUUID(), removed = await post(removePath, { reason: 'Kết thúc cộng tác' }, f.owner, 2, removeKey);
    expect(removed.json().data).toMatchObject({ status: 'removed', participantId, version: 3 });
    expect((await post(removePath, { reason: 'Kết thúc cộng tác' }, f.owner, 2, removeKey)).headers['idempotency-replayed']).toBe('true');
    for (const suffix of ['/overview', '/members', '/expenses', '/settlements', '/activity']) {
      expect((await get(`${f.path}${suffix}`, person)).statusCode).toBe(404);
    }
    expect((await get(`/api/v1/operations/${joinKey}`, person)).statusCode).toBe(404);
    expect((await post('/api/v1/invites/accept', { token: invitation.token }, person)).json().error.code).toBe('MEMBERSHIP_REMOVED');
    expect((await post('/api/v1/invites/accept', { token: invitation.token }, person, undefined, joinKey)).statusCode).toBe(404);
    const tripRef = db().doc(`users/${person.user.uid}/tripRefs/${f.id}`);
    expect((await tripRef.get()).get('status')).toBe('removed');
    await tripRef.update({ status: 'active' }); // A stale list projection never grants access.
    expect((await get('/api/v1/trips', person)).json().data.items).toEqual([]);
    const restoreKey = randomUUID(), restored = await post(restorePath, { reason: 'Cho phép quay lại' }, f.owner, 3, restoreKey);
    expect(restored.json().data).toMatchObject({ status: 'active', participantId, version: 4 });
    const revision = (await f.trip.get()).get('revision');
    expect((await post(restorePath, { reason: 'Cho phép quay lại' }, f.owner, 3, restoreKey)).headers['idempotency-replayed']).toBe('true');
    expect((await f.trip.get()).get('revision')).toBe(revision);
    expect((await memberRef.get()).get('joinedAt')).toEqual(joinedAt);
    expect((await tripRef.get()).get('joinedAt')).toEqual(joinedAt);
    expect((await f.trip.get()).data()).toMatchObject({ membershipCountAllTime: rootBefore.membershipCountAllTime,
      participantCount: rootBefore.participantCount, ledgerVersion: rootBefore.ledgerVersion, totalExpenseMinor: rootBefore.totalExpenseMinor });
    expect((await f.trip.collection('balances').get()).docs.map(doc => doc.data())).toEqual(money);
    expect((await f.trip.collection('participants').doc(participantId).get()).data()).toEqual(participantBefore);
    const members = await get(`${f.path}/members`, person);
    expect(members.statusCode).toBe(200);
    const membership = members.json().data.memberships.find((item: { uid: string }) => item.uid === person.user.uid);
    expect(membership).toMatchObject({ version: 4, displayName: person.user.displayName });
    expect(membership).not.toHaveProperty('email');
    expect((await post(`${f.path}/memberships/never-joined/restore`, { reason: 'Thử' }, f.owner, 1)).statusCode).toBe(404);
    expect((await checkDatabase(db(), { tripId: f.id, pageSize: 20 })).issues).toEqual([]);
  }, 30_000);

  it('validates retained links on restore and permits revoking access on locked trips', async () => {
    const f = await fixture(), person = await register();
    await join(f, person);
    const participantId = await link(f, person), invitation = await invite(f);
    const removePath = `${f.path}/memberships/${person.user.uid}/remove`, restorePath = `${f.path}/memberships/${person.user.uid}/restore`;
    await f.trip.update({ status: 'archived', moderationStatus: 'suspended' });
    expect((await post(`${f.path}/invites/${invitation.id}/revoke`, {}, f.owner, 1)).statusCode).toBe(200);
    expect((await post(removePath, { reason: 'Thu hồi truy cập' }, f.owner, 2)).statusCode).toBe(200);
    expect((await post(restorePath, { reason: 'Khôi phục' }, f.owner, 3)).json().error.code).toBe('TRIP_NOT_WRITABLE');
    await f.trip.update({ status: 'active', moderationStatus: 'normal' });
    await f.trip.collection('participants').doc(participantId).update({ linkedUid: null });
    expect((await post(restorePath, { reason: 'Khôi phục' }, f.owner, 3)).json().error.code).toBe('LINK_INVARIANT_FAILED');
    await f.trip.collection('participants').doc(participantId).update({ linkedUid: person.user.uid });
    expect((await post(`${f.path}/memberships/${person.user.uid}/link`, { participantId: null, reason: 'Gỡ danh tính cũ' }, f.owner, 3)).statusCode).toBe(200);
    const restored = await post(restorePath, { reason: 'Quay lại chưa liên kết' }, f.owner, 4);
    expect(restored.json().data).toMatchObject({ participantId: null, version: 5 });
    expect((await checkDatabase(db(), { tripId: f.id, pageSize: 20 })).issues).toEqual([]);
  }, 30_000);

  it('serializes the last all-time membership slot and restores without consuming another slot', async () => {
    const f = await fixture(), people = await Promise.all([register(), register()]);
    const now = Timestamp.now(), batch = db().batch();
    for (let i = 0; i < 48; i++) {
      const uid = `synthetic-${randomUUID()}`;
      batch.create(db().doc(`users/${uid}`), createUserDocument({ uid, displayName: 'Khách cũ' }, now));
      batch.create(f.trip.collection('memberships').doc(uid), { schemaVersion: 1, uid, role: 'member',
        status: 'removed', participantId: null, version: 1, joinedAt: now, updatedAt: now, removedAt: now });
      batch.create(db().doc(`users/${uid}/tripRefs/${f.id}`), { schemaVersion: 1, tripId: f.id, status: 'removed', joinedAt: now, updatedAt: now });
    }
    batch.update(f.trip, { membershipCountAllTime: 49 });
    await batch.commit();
    const invitation = await invite(f);
    const results = await Promise.all(people.map(person => post('/api/v1/invites/accept', { token: invitation.token }, person)));
    expect(results.map(row => row.statusCode).sort()).toEqual([200, 409]);
    expect(results.find(row => row.statusCode === 409)!.json().error.code).toBe('MEMBERSHIP_LIMIT_REACHED');
    const winner = people[results.findIndex(row => row.statusCode === 200)]!;
    expect((await f.trip.get()).get('membershipCountAllTime')).toBe(50);
    expect((await f.trip.collection('invites').doc(invitation.id).get()).get('usedCount')).toBe(1);
    expect((await post(`${f.path}/memberships/${winner.user.uid}/remove`, { reason: 'Tạm dừng' }, f.owner, 1)).statusCode).toBe(200);
    expect((await post(`${f.path}/memberships/${winner.user.uid}/restore`, { reason: 'Quay lại' }, f.owner, 2)).statusCode).toBe(200);
    expect((await f.trip.get()).get('membershipCountAllTime')).toBe(50);
    expect((await checkDatabase(db(), { tripId: f.id, pageSize: 10 })).issues).toEqual([]);
  }, 30_000);

  it('keeps one linked owner under competing transfers and checks current access on replay', async () => {
    const f = await fixture(), people = await Promise.all([register('Bình'), register('Chi')]);
    for (const person of people) await join(f, person);
    const path = `${f.path}/transfer-owner`;
    expect((await post(path, { uid: people[0]!.user.uid, reason: 'Bàn giao' }, f.owner, 1)).json().error.code).toBe('INVALID_OWNER_TARGET');
    for (const person of people) await link(f, person);
    const firstUid = people[0]!.user.uid;
    expect((await post(path, { uid: firstUid, reason: 'Bàn giao' }, f.owner)).statusCode).toBe(428);
    expect((await post(`${f.path}/memberships/${firstUid}/remove`, { reason: 'Tạm gỡ' }, f.owner, 2)).statusCode).toBe(200);
    expect((await post(path, { uid: firstUid, reason: 'Bàn giao' }, f.owner, 1)).json().error.code).toBe('INVALID_OWNER_TARGET');
    expect((await post(`${f.path}/memberships/${firstUid}/restore`, { reason: 'Quay lại' }, f.owner, 3)).statusCode).toBe(200);
    await db().doc(`users/${firstUid}`).update({ status: 'disabled' });
    expect((await post(path, { uid: firstUid, reason: 'Bàn giao' }, f.owner, 1)).json().error.code).toBe('INVALID_OWNER_TARGET');
    await db().doc(`users/${firstUid}`).update({ status: 'active' });
    const money = (await f.trip.collection('balances').get()).docs.map(doc => doc.data());
    const keys = [randomUUID(), randomUUID()], payloads = people.map(person => ({ uid: person.user.uid, reason: 'Bàn giao' }));
    expect((await post(path, payloads[0]!, f.owner, 2)).json().error.code).toBe('VERSION_CONFLICT');
    const results = await Promise.all(payloads.map((payload, i) => post(path, payload, f.owner, 1, keys[i])));
    expect(results.filter(row => row.statusCode === 200)).toHaveLength(1);
    expect(results.filter(row => row.statusCode === 403)).toHaveLength(1);
    const index = results.findIndex(row => row.statusCode === 200), winner = people[index]!;
    expect((await f.trip.get()).data()).toMatchObject({ ownerUid: winner.user.uid, version: 2, ledgerVersion: 0 });
    const owners = (await f.trip.collection('memberships').get()).docs.filter(doc => doc.get('role') === 'owner');
    expect(owners.map(doc => doc.id)).toEqual([winner.user.uid]);
    expect(owners[0]!.get('status')).toBe('active');
    expect((await f.trip.collection('balances').get()).docs.map(doc => doc.data())).toEqual(money);
    expect((await post(`${f.path}/invites`, {}, f.owner)).statusCode).toBe(403);
    const replay = await post(path, payloads[index]!, f.owner, 1, keys[index]);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const oldOwner = await f.trip.collection('memberships').doc(f.owner.user.uid).get();
    expect((await post(`${f.path}/memberships/${f.owner.user.uid}/remove`, { reason: 'Hoàn tất bàn giao' }, winner, oldOwner.get('version'))).statusCode).toBe(200);
    expect((await post(path, payloads[index]!, f.owner, 1, keys[index])).statusCode).toBe(404);
    expect((await checkDatabase(db(), { tripId: f.id, pageSize: 20 })).issues).toEqual([]);
  }, 30_000);

  it('serializes removal against a member financial mutation and denies every later write', async () => {
    const f = await fixture(), person = await register();
    await join(f, person);
    const payload = { title: 'Chi cạnh tranh', amountMinor: 99, payerParticipantId: f.ownerParticipantId,
      splitMethod: 'equal', split: { participantIds: [f.ownerParticipantId] }, occurredOn: '2026-12-20', category: 'food' };
    const expenseKey = randomUUID(), removeKey = randomUUID();
    const [expense, removed] = await Promise.all([
      post(`${f.path}/expenses`, payload, person, undefined, expenseKey),
      post(`${f.path}/memberships/${person.user.uid}/remove`, { reason: 'Thu hồi quyền' }, f.owner, 1, removeKey),
    ]);
    expect(removed.statusCode, removed.body).toBe(200);
    expect([200, 404]).toContain(expense.statusCode);
    if (expense.statusCode === 200) {
      expect(expense.json().meta.revision).toBeLessThan(removed.json().meta.revision);
    } else {
      expect((await db().doc(`users/${person.user.uid}/operations/${expenseKey}`).get()).exists).toBe(false);
    }
    expect((await post(`${f.path}/expenses`, payload, person)).statusCode).toBe(404);
    expect((await post(`${f.path}/expenses`, payload, person, undefined, expenseKey)).statusCode).toBe(404);
    expect((await checkDatabase(db(), { tripId: f.id, pageSize: 20 })).issues).toEqual([]);
  }, 30_000);
});
