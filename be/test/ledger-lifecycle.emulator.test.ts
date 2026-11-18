import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { db } from '../src/firebase.js';
import { checkDatabase } from '../src/database/check-integrity.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) { process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill'; process.env.FIREBASE_WEB_API_KEY ??= 'demo'; }
type Identity = { accessToken: string; user: { uid: string } };

describe.skipIf(!enabled)('S09 ledger editing and trip lifecycle', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { app = await buildApp(Fastify({ logger: false })); });
  afterAll(async () => { await app?.close(); });
  async function register(name = 'Khách'): Promise<Identity> {
    const result = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
      email: `s09-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: name,
    } });
    expect(result.statusCode).toBe(201);
    return result.json().data;
  }
  function send(method: 'POST' | 'PATCH', path: string, payload: object, actor: Identity, version?: number, key = randomUUID()) {
    return app.inject({ method, url: path, payload, headers: { authorization: `Bearer ${actor.accessToken}`,
      'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': `"${version}"` }) } });
  }
  function get(path: string, actor: Identity) {
    return app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${actor.accessToken}` } });
  }
  async function fixture(linked = false) {
    const owner = await register('An');
    const response = await send('POST', '/api/v1/trips', { name: 'Đà Lạt', ownerName: 'An' }, owner);
    expect(response.statusCode).toBe(200);
    const { id, ownerParticipantId } = response.json().data;
    const path = `/api/v1/trips/${id}`, trip = db().doc(`trips/${id}`);
    const participants: string[] = [];
    for (const displayName of ['Bình', 'Chi']) {
      const person = await send('POST', `${path}/participants`, { displayName }, owner);
      expect(person.statusCode).toBe(200);
      participants.push(person.json().data.id);
    }
    const accounts: Identity[] = [];
    if (linked) {
      const invitation = await send('POST', `${path}/invites`, {}, owner);
      for (const [i, name] of ['Bình', 'Chi'].entries()) {
        const person = await register(name);
        expect((await send('POST', '/api/v1/invites/accept', { token: invitation.json().data.token }, person)).statusCode).toBe(200);
        expect((await send('POST', `${path}/memberships/${person.user.uid}/link`,
          { participantId: participants[i], reason: 'Xác nhận' }, owner, 1)).statusCode).toBe(200);
        accounts.push(person);
      }
    }
    return { owner, id: id as string, path, trip, a: ownerParticipantId as string, b: participants[0]!, c: participants[1]!,
      binh: accounts[0], chi: accounts[1] };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const metadata = { occurredOn: '2026-12-20', category: 'food', title: 'Ăn tối' };
  function equal(amountMinor: number, payerParticipantId: string, ids: string[]) {
    return { amountMinor, payerParticipantId, splitMethod: 'equal', split: { participantIds: ids } };
  }
  function exact(amountMinor: number, payerParticipantId: string, shares: [string, number][]) {
    return { amountMinor, payerParticipantId, splitMethod: 'exact',
      split: { shares: shares.map(([participantId, amountMinor]) => ({ participantId, amountMinor })) } };
  }
  async function expense(f: Fixture, payload: object, actor = f.owner) {
    const result = await send('POST', `${f.path}/expenses`, { ...metadata, ...payload }, actor);
    expect(result.statusCode, result.body).toBe(200);
    return result.json().data.id as string;
  }
  async function seedMoney(f: Fixture) {
    const e1 = await expense(f, { ...equal(900_000, f.a, [f.a, f.b, f.c]), title: 'Khách sạn', category: 'stay' });
    const e2 = await expense(f, exact(180_000, f.b, [[f.a, 120_000], [f.b, 60_000]]));
    const e3 = await expense(f, { ...exact(90_000, f.c, [[f.b, 60_000], [f.c, 30_000]]), category: 'transport' });
    return { e1, e2, e3 };
  }
  async function balances(f: Fixture) { return (await f.trip.collection('balances').get()).docs.map(doc => doc.data()); }
  async function pending(f: Fixture, fromId: string, amountMinor: number, actor = f.owner) {
    const result = await send('POST', `${f.path}/settlements`, { fromParticipantId: fromId, toParticipantId: f.a,
      amountMinor, occurredOn: '2026-12-20', basedOnLedgerVersion: (await f.trip.get()).get('ledgerVersion') }, actor);
    expect(result.statusCode, result.body).toBe(200);
    return result.json().data.id as string;
  }
  async function confirm(f: Fixture, id: string) {
    const result = await send('POST', `${f.path}/settlements/${id}/confirm`,
      { basedOnLedgerVersion: (await f.trip.get()).get('ledgerVersion') }, f.owner, 1);
    expect(result.statusCode, result.body).toBe(200);
    return result;
  }
  async function clean(f: Fixture) {
    expect((await checkDatabase(db(), { tripId: f.id, pageSize: 20 })).issues).toEqual([]);
  }

  it('protects pending settlement identities when linking or unlinking and preserves the confirmation role', async () => {
    const f = await fixture(true), binh = f.binh!;
    await seedMoney(f);
    const path = `${f.path}/memberships/${binh.user.uid}/link`;
    const link = (participantId: string | null, version: number) =>
      send('POST', path, { participantId, reason: 'Cập nhật tài khoản' }, f.owner, version);
    const settlement = await pending(f, f.b, 120_000, binh);
    expect((await link(null, 2)).json().error.code).toBe('PENDING_SETTLEMENTS_FOR_PARTICIPANT');
    const confirmed = await confirm(f, settlement);
    expect(confirmed.json().data.confirmationMode).toBe('recipient');
    expect((await link(null, 2)).statusCode).toBe(200);
    const next = await pending(f, f.b, 50_000);
    expect((await link(f.b, 3)).json().error.code).toBe('PENDING_SETTLEMENTS_FOR_PARTICIPANT');
    expect((await send('POST', `${f.path}/settlements/${next}/cancel`, {}, f.owner, 1)).statusCode).toBe(200);
    expect((await link(f.b, 3)).statusCode).toBe(200);
    await clean(f);
  }, 30_000);

  it('serializes a participant unlink against a pending settlement create', async () => {
    const f = await fixture(true), binh = f.binh!;
    await seedMoney(f);
    const [unlinked, created] = await Promise.all([
      send('POST', `${f.path}/memberships/${binh.user.uid}/link`, { participantId: null, reason: 'Đổi người sử dụng' }, f.owner, 2),
      send('POST', `${f.path}/settlements`, { fromParticipantId: f.b, toParticipantId: f.a, amountMinor: 120000,
        occurredOn: '2026-12-20', basedOnLedgerVersion: 3 }, binh),
    ]);
    expect([unlinked.statusCode, created.statusCode].sort()).toEqual(created.statusCode === 200 ? [200, 409] : [200, 403]);
    const member = await f.trip.collection('memberships').doc(binh.user.uid).get();
    expect(member.get('participantId')).toBe(created.statusCode === 200 ? f.b : null);
    await clean(f);
  }, 30_000);

  it('edits money, payer, category and split using old/new contributions and preserves all-time counts', async () => {
    const f = await fixture(), { e1, e2 } = await seedMoney(f);
    const response = await send('PATCH', `${f.path}/expenses/${e2}`, {
      ...exact(210_000, f.c, [[f.a, 140_000], [f.b, 70_000]]), category: 'tickets',
    }, f.owner, 1);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect((await f.trip.get()).data()).toMatchObject({ totalExpenseMinor: 1_200_000, expenseCountAllTime: 3,
      activeExpenseCount: 3, ledgerVersion: 4, categoryTotalsMinor: { stay: 900_000, food: 0, tickets: 210_000, transport: 90_000 } });
    expect(await balances(f)).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: f.a, paidMinor: 900_000, owedMinor: 440_000, netMinor: 460_000 }),
      expect.objectContaining({ participantId: f.b, paidMinor: 0, owedMinor: 430_000, netMinor: -430_000 }),
      expect.objectContaining({ participantId: f.c, paidMinor: 300_000, owedMinor: 330_000, netMinor: -30_000 }),
    ]));
    expect((await send('PATCH', `${f.path}/participants/${f.c}`, { status: 'inactive' }, f.owner, 1)).statusCode).toBe(200);
    const changed = await send('PATCH', `${f.path}/expenses/${e1}`, exact(600_000, f.b, [[f.b, 600_000]]), f.owner, 1);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await balances(f)).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: f.a, paidMinor: 0, owedMinor: 140_000, netMinor: -140_000 }),
      expect.objectContaining({ participantId: f.b, paidMinor: 600_000, owedMinor: 730_000, netMinor: -130_000 }),
      expect.objectContaining({ participantId: f.c, paidMinor: 300_000, owedMinor: 30_000, netMinor: 270_000 }),
    ]));
    expect((await send('POST', `${f.path}/expenses/${e1}/void`, { reason: 'Nhập nhầm' }, f.owner, 2)).statusCode).toBe(200);
    expect((await f.trip.get()).data()).toMatchObject({ totalExpenseMinor: 300_000, expenseCountAllTime: 3,
      activeExpenseCount: 2, ledgerVersion: 6, categoryTotalsMinor: { stay: 0, tickets: 210_000, transport: 90_000 } });
    expect((await send('PATCH', `${f.path}/expenses/${e1}`, { title: 'Không thể sửa' }, f.owner, 3)).json().error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await f.trip.collection('participants').doc(f.c).get()).get('hasLedgerReferences')).toBe(true);
    await clean(f);
  }, 30_000);

  it('keeps balances and ledger version unchanged for metadata/category edits, including inactive participants', async () => {
    const f = await fixture(), { e1 } = await seedMoney(f), before = await balances(f);
    expect((await send('PATCH', `${f.path}/participants/${f.b}`, { status: 'inactive' }, f.owner, 1)).statusCode).toBe(200);
    const path = `${f.path}/expenses/${e1}`, key = randomUUID(), input = { title: 'Khách sạn mới', note: 'Đổi ghi chú' };
    const updated = await send('PATCH', path, input, f.owner, 1, key);
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().meta.ledgerVersion).toBe(3);
    expect((await send('PATCH', path, { category: 'food', occurredOn: '2026-12-21' }, f.owner, 2)).statusCode).toBe(200);
    expect((await f.trip.get()).data()).toMatchObject({ ledgerVersion: 3, totalExpenseMinor: 1_170_000,
      categoryTotalsMinor: { stay: 0, food: 1_080_000, transport: 90_000 } });
    expect(await balances(f)).toEqual(before);
    const replay = await send('PATCH', path, input, f.owner, 1, key);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().data).toEqual(updated.json().data);
    expect((await f.trip.collection('expenses').doc(e1).get()).get('version')).toBe(3);
    expect((await send('PATCH', path, equal(900_000, f.a, [f.a, f.b, f.c]), f.owner, 3)).json().error.code).toBe('INVALID_PARTICIPANTS');
    for (const invalid of [{}, { amountMinor: 100 }, { status: 'void' }, { currency: 'USD' }, { createdBy: f.owner.user.uid },
      { ...equal(100, f.a, [f.a]), splitMethod: 'exact' }, { ...equal(100, f.a, [f.a, f.a]) },
      exact(100, f.a, [[f.a, 99]])]) {
      expect((await send('PATCH', path, invalid, f.owner, 3)).statusCode).toBe(422);
    }
    expect((await send('PATCH', path, { receiptIds: [randomUUID()] }, f.owner, 3)).json().error.code).toBe('NOT_FOUND');
    expect((await f.trip.get()).get('ledgerVersion')).toBe(3);
    const audit = await f.trip.collection('auditEvents').where('action', '==', 'expense.updated').get();
    expect(audit.size).toBe(2);
    expect(audit.docs.some(doc => doc.get('before').category === 'stay' && doc.get('after').category === 'food')).toBe(true);
    expect((await send('PATCH', `${f.path}/participants/${f.b}`, { status: 'active' }, f.owner, 2)).statusCode).toBe(200);
    expect((await send('PATCH', path, equal(900_000, f.a, [f.c, f.b, f.a]), f.owner, 3)).json().meta.ledgerVersion).toBe(3);
    const currentShares = (await f.trip.collection('expenses').doc(e1).get()).get('shares') as { participantId: string; amountMinor: number }[];
    const sameMoney = exact(900_000, f.a, currentShares.map(share => [share.participantId, share.amountMinor]));
    expect((await send('PATCH', path, sameMoney, f.owner, 4)).json().meta.ledgerVersion).toBe(3);
    expect(await balances(f)).toEqual(before);
    await clean(f);
  }, 30_000);

  it('checks creator/owner rights and serializes competing expense versions without double contributions', async () => {
    const f = await fixture(true), outsider = await register(), id = await expense(f, equal(1_000, f.a, [f.a, f.b]), f.binh!);
    const path = `${f.path}/expenses/${id}`;
    expect((await send('PATCH', path, { note: 'Thử' }, outsider, 1)).statusCode).toBe(404);
    expect((await send('PATCH', path, { note: 'Thử' }, f.chi!, 1)).statusCode).toBe(403);
    expect((await send('PATCH', path, { note: 'Thử' }, f.binh!)).statusCode).toBe(428);
    expect((await send('PATCH', path, { note: 'Người tạo' }, f.binh!, 1)).statusCode).toBe(200);
    const keys = [randomUUID(), randomUUID()], inputs = [equal(1_200, f.b, [f.a, f.b]), equal(1_400, f.c, [f.a, f.c])];
    const results = await Promise.all(inputs.map((input, i) => send('PATCH', path, input, f.owner, 2, keys[i])));
    expect(results.map(row => row.statusCode).sort()).toEqual([200, 409]);
    const index = results.findIndex(row => row.statusCode === 200);
    expect((await f.trip.get()).data()).toMatchObject({ ledgerVersion: 2, activeExpenseCount: 1, expenseCountAllTime: 1,
      totalExpenseMinor: inputs[index]!.amountMinor });
    expect((await send('PATCH', path, inputs[index]!, f.owner, 3, keys[index])).json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await db().doc(`users/${f.binh!.user.uid}`).update({ status: 'disabled' });
    expect((await send('PATCH', path, { note: 'Đã khóa' }, f.binh!, 3)).statusCode).toBe(403);
    await db().doc(`users/${f.binh!.user.uid}`).update({ status: 'active' });
    await clean(f);
  }, 30_000);

  it('keeps confirmed repayments unchanged when an expense edit changes who owes money', async () => {
    const f = await fixture(), { e2 } = await seedMoney(f);
    const settlementId = await pending(f, f.b, 240_000);
    await confirm(f, settlementId);
    const original = (await f.trip.collection('settlements').doc(settlementId).get()).data();
    expect((await send('PATCH', `${f.path}/expenses/${e2}`, exact(210_000, f.b, [[f.a, 140_000], [f.b, 70_000]]), f.owner, 1)).statusCode).toBe(200);
    expect(await balances(f)).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: f.a, netMinor: 220_000, receivedMinor: 240_000 }),
      expect.objectContaining({ participantId: f.b, netMinor: 20_000, sentMinor: 240_000 }),
      expect.objectContaining({ participantId: f.c, netMinor: -240_000 }),
    ]));
    expect((await f.trip.collection('settlements').doc(settlementId).get()).data()).toEqual(original);
    const suggestions = await get(`${f.path}/settlement-suggestions`, f.owner);
    expect(suggestions.json().data.suggestions.reduce((sum: number, row: { amountMinor: number }) => sum + row.amountMinor, 0)).toBe(240_000);
    await clean(f);
  }, 30_000);

  it('cancels pending requests only for creator/owner, with preserved money and safe retry', async () => {
    const f = await fixture(true); await seedMoney(f);
    const id = await pending(f, f.b, 120_000, f.binh!), path = `${f.path}/settlements/${id}/cancel`, before = await balances(f);
    expect((await send('POST', path, {}, f.chi!, 1)).statusCode).toBe(403);
    expect((await send('POST', path, {}, f.binh!)).statusCode).toBe(428);
    const key = randomUUID(), result = await send('POST', path, {}, f.binh!, 1, key);
    expect(result.json().data).toMatchObject({ status: 'cancelled', version: 2, confirmationMode: null });
    expect((await send('POST', path, {}, f.binh!, 1, key)).headers['idempotency-replayed']).toBe('true');
    expect((await send('POST', path, {}, f.owner, 2)).json().error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await send('POST', `${f.path}/settlements/${id}/confirm`, { basedOnLedgerVersion: 3 }, f.owner, 2)).statusCode).toBe(409);
    const second = await pending(f, f.b, 120_000, f.binh!);
    expect((await send('POST', `${f.path}/settlements/${second}/cancel`, {}, f.owner, 1)).statusCode).toBe(200);
    expect((await f.trip.get()).data()).toMatchObject({ pendingSettlementCount: 0, settlementCountAllTime: 2, ledgerVersion: 3 });
    expect(await balances(f)).toEqual(before);
    expect((await get(`${f.path}/settlements?status=cancelled`, f.owner)).json().data.items).toHaveLength(2);
    await clean(f);
  }, 30_000);

  it('allows only one of confirm or cancel to win for the same pending version', async () => {
    const f = await fixture(true); await seedMoney(f);
    const id = await pending(f, f.b, 120_000, f.binh!);
    const [confirmed, cancelled] = await Promise.all([
      send('POST', `${f.path}/settlements/${id}/confirm`, { basedOnLedgerVersion: 3 }, f.owner, 1),
      send('POST', `${f.path}/settlements/${id}/cancel`, {}, f.binh!, 1),
    ]);
    expect([confirmed.statusCode, cancelled.statusCode].sort()).toEqual([200, 409]);
    expect((await f.trip.get()).data()).toMatchObject({ pendingSettlementCount: 0, settlementCountAllTime: 1,
      ledgerVersion: confirmed.statusCode === 200 ? 4 : 3 });
    const row = await f.trip.collection('settlements').doc(id).get();
    expect(row.get('version')).toBe(2);
    expect(row.get('status')).toBe(confirmed.statusCode === 200 ? 'confirmed' : 'cancelled');
    await clean(f);
  }, 30_000);

  it('voids a confirmed partial repayment once, preserving confirmation history and other repayments', async () => {
    const f = await fixture(true); await seedMoney(f);
    const first = await pending(f, f.b, 120_000, f.binh!); await confirm(f, first);
    const second = await pending(f, f.c, 240_000, f.chi!); await confirm(f, second);
    const firstRef = f.trip.collection('settlements').doc(first), before = (await firstRef.get()).data()!;
    const otherBefore = (await f.trip.collection('settlements').doc(second).get()).data();
    const path = `${f.path}/settlements/${first}/void`, payload = { reason: 'Ghi nhầm chuyển tiền' };
    expect((await send('POST', path, payload, f.binh!, 2)).statusCode).toBe(403);
    expect((await send('POST', path, { reason: ' ' }, f.owner, 2)).statusCode).toBe(422);
    expect((await send('POST', path, payload, f.owner, 1)).json().error.code).toBe('VERSION_CONFLICT');
    const key = randomUUID(), results = await Promise.all([
      send('POST', path, payload, f.owner, 2, key), send('POST', path, payload, f.owner, 2, key),
    ]);
    expect(results.map(row => row.statusCode)).toEqual([200, 200]);
    expect(results.filter(row => row.headers['idempotency-replayed'] === 'true')).toHaveLength(1);
    expect((await firstRef.get()).data()).toMatchObject({ status: 'void', version: 3, voidReason: payload.reason,
      confirmedBy: before.confirmedBy, confirmedAt: before.confirmedAt, confirmationMode: before.confirmationMode,
      basedOnLedgerVersion: before.basedOnLedgerVersion, voidedBy: f.owner.user.uid });
    expect(await balances(f)).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: f.a, netMinor: 240_000, receivedMinor: 240_000 }),
      expect.objectContaining({ participantId: f.b, netMinor: -240_000, sentMinor: 0 }),
      expect.objectContaining({ participantId: f.c, netMinor: 0, sentMinor: 240_000 }),
    ]));
    expect((await f.trip.get()).data()).toMatchObject({ totalExpenseMinor: 1_170_000, ledgerVersion: 6,
      settlementCountAllTime: 2, pendingSettlementCount: 0 });
    expect((await f.trip.collection('settlements').doc(second).get()).data()).toEqual(otherBefore);
    expect((await send('POST', path, payload, f.owner, 3)).json().error.code).toBe('INVALID_STATE_TRANSITION');
    await clean(f);
  }, 30_000);

  it('archives only a balanced trip without pending requests, then reopens without reviving old invites', async () => {
    const f = await fixture(true), outsider = await register(), { e1 } = await seedMoney(f);
    const archivePath = `${f.path}/archive`, reopenPath = `${f.path}/reopen`;
    expect((await send('POST', archivePath, {}, outsider, 1)).statusCode).toBe(404);
    expect((await send('POST', archivePath, {}, f.binh!, 1)).statusCode).toBe(403);
    expect((await send('POST', archivePath, {}, f.owner)).statusCode).toBe(428);
    expect((await send('POST', archivePath, {}, f.owner, 1)).json().error.code).toBe('TRIP_NOT_BALANCED');
    const cancelledId = await pending(f, f.b, 240_000);
    expect((await send('POST', archivePath, {}, f.owner, 1)).json().error.code).toBe('PENDING_SETTLEMENTS');
    expect((await send('POST', `${f.path}/settlements/${cancelledId}/cancel`, {}, f.owner, 1)).statusCode).toBe(200);
    const first = await pending(f, f.b, 240_000); await confirm(f, first);
    const second = await pending(f, f.c, 240_000); await confirm(f, second);
    const invitation = await send('POST', `${f.path}/invites`, {}, f.owner);
    const token = invitation.json().data.token;
    const rootBefore = (await f.trip.get()).data()!, key = randomUUID(), moneyBefore = await balances(f);
    const archived = await send('POST', archivePath, {}, f.owner, 1, key);
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.headers.etag).toBe('"2"');
    expect(archived.json().data).toMatchObject({ status: 'archived', version: 2, inviteEpoch: 2, archivedAt: expect.any(String) });
    expect((await f.trip.get()).get('ledgerVersion')).toBe(rootBefore.ledgerVersion);
    expect((await send('POST', archivePath, {}, f.owner, 1, key)).headers['idempotency-replayed']).toBe('true');
    expect((await send('POST', archivePath, {}, f.owner, 2)).json().error.code).toBe('INVALID_STATE_TRANSITION');
    const blocked = [
      send('PATCH', `${f.path}/expenses/${e1}`, { note: 'Đã khóa' }, f.owner, 1),
      send('POST', `${f.path}/expenses`, { ...metadata, ...equal(100, f.a, [f.a]) }, f.owner),
      send('POST', `${f.path}/settlements/${first}/void`, { reason: 'Thử' }, f.owner, 2),
      send('POST', `${f.path}/invites`, {}, f.owner),
      send('PATCH', f.path, { name: 'Đã khóa' }, f.owner, 2),
    ];
    for (const result of await Promise.all(blocked)) expect(result.json().error.code).toBe('TRIP_NOT_WRITABLE');
    expect((await get(`${f.path}/overview`, f.owner)).statusCode).toBe(200);
    expect((await postToken('preview', token, outsider)).statusCode).toBe(404);
    expect((await postToken('accept', token, outsider)).statusCode).toBe(404);
    expect((await send('POST', reopenPath, {}, f.binh!, 2)).statusCode).toBe(403);
    await f.trip.update({ moderationStatus: 'suspended' });
    expect((await send('POST', reopenPath, {}, f.owner, 2)).json().error.code).toBe('TRIP_NOT_WRITABLE');
    await f.trip.update({ moderationStatus: 'normal' });
    const reopenKey = randomUUID(), reopened = await send('POST', reopenPath, {}, f.owner, 2, reopenKey);
    expect(reopened.json().data).toMatchObject({ status: 'active', version: 3, archivedAt: null, inviteEpoch: 2 });
    expect((await send('POST', reopenPath, {}, f.owner, 2, reopenKey)).headers['idempotency-replayed']).toBe('true');
    expect((await send('POST', archivePath, {}, f.owner, 1, key)).headers['idempotency-replayed']).toBe('true');
    expect((await f.trip.get()).get('status')).toBe('active');
    expect((await postToken('accept', token, outsider)).statusCode).toBe(404);
    expect(await balances(f)).toEqual(moneyBefore);
    await expense(f, equal(1, f.a, [f.a]));
    const fresh = await send('POST', `${f.path}/invites`, {}, f.owner);
    expect((await postToken('accept', fresh.json().data.token, outsider)).statusCode).toBe(200);
    await clean(f);
  }, 30_000);
  function postToken(action: 'preview' | 'accept', token: string, actor: Identity) {
    return send('POST', `/api/v1/invites/${action}`, { token }, actor);
  }

  it('serializes archive against a financial create so no expense can enter an archived ledger', async () => {
    const f = await fixture();
    const [archived, created] = await Promise.all([
      send('POST', `${f.path}/archive`, {}, f.owner, 1),
      send('POST', `${f.path}/expenses`, { ...metadata, ...equal(100, f.a, [f.a, f.b]) }, f.owner),
    ]);
    expect([archived.statusCode, created.statusCode].sort()).toEqual([200, 409]);
    const root = (await f.trip.get()).data()!;
    expect(root.status).toBe(archived.statusCode === 200 ? 'archived' : 'active');
    expect(root.expenseCountAllTime).toBe(archived.statusCode === 200 ? 0 : 1);
    await clean(f);
  }, 30_000);

  it('checks actual pending rows and complete, consistent balances before archiving', async () => {
    const f = await fixture(), id = await expense(f, equal(1_000, f.a, [f.a, f.b]));
    const pendingId = await pending(f, f.b, 500);
    expect((await send('PATCH', `${f.path}/expenses/${id}`, equal(1_000, f.a, [f.a]), f.owner, 1)).statusCode).toBe(200);
    await f.trip.update({ pendingSettlementCount: 0 });
    expect((await send('POST', `${f.path}/archive`, {}, f.owner, 1)).json().error.code).toBe('PENDING_SETTLEMENTS');
    await f.trip.update({ pendingSettlementCount: 1 });
    expect((await send('POST', `${f.path}/settlements/${pendingId}/cancel`, {}, f.owner, 1)).statusCode).toBe(200);
    const balanceRef = f.trip.collection('balances').doc(f.b), original = (await balanceRef.get()).data()!;
    await balanceRef.delete();
    expect((await send('POST', `${f.path}/archive`, {}, f.owner, 1)).json().error.code).toBe('PROJECTION_INVARIANT_FAILED');
    await balanceRef.set({ ...original, owedMinor: 1 });
    expect((await send('POST', `${f.path}/archive`, {}, f.owner, 1)).json().error.code).toBe('PROJECTION_INVARIANT_FAILED');
    await balanceRef.set(original);
    expect((await send('POST', `${f.path}/archive`, {}, f.owner, 1)).statusCode).toBe(200);
    await clean(f);
  }, 30_000);
});
