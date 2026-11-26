import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { db } from '../src/firebase.js';
import { checkDatabase } from '../src/database/check-integrity.js';
import { splitGroupTotal } from '../src/domain/money.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) { process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill'; process.env.FIREBASE_WEB_API_KEY ??= 'demo'; }
type Identity = { accessToken: string; user: { uid: string; displayName: string } };
describe.skipIf(!enabled)('automatic equal group sharing', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { app = await buildApp(Fastify({ logger: false })); });
  afterAll(async () => { await app?.close(); });
  async function send(path: string, actor: Identity, body?: object, version?: number, method: 'GET' | 'POST' | 'PATCH' = body ? 'POST' : 'GET', key: string = randomUUID()) {
    return app.inject({ method, url: '/api/v1/' + path, ...(body && { payload: body }), headers: {
      authorization: 'Bearer ' + actor.accessToken, 'idempotency-key': key, ...(version !== undefined && { 'if-match': '"' + version + '"' }),
    } });
  }
  async function ok(path: string, actor: Identity, body?: object, version?: number, method?: 'GET' | 'POST' | 'PATCH', key?: string) {
    const response = await send(path, actor, body, version, method, key);
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json().data;
  }
  async function register(name: string): Promise<Identity> {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
      email: randomUUID() + '@example.test', password: 'GroupSharing-123!', displayName: name,
    } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().data;
  }
  async function fixture(legacy = false) {
    const owner = await register('okr'), trip = await ok('trips', owner, { name: 'Chia tổng chi', ownerName: 'okr', ...(legacy && { sharingMode: 'per-expense' }) });
    const root = 'trips/' + trip.id;
    const overview = () => ok(root + '/overview', owner);
    const expense = (amountMinor: number) => ok(root + '/expenses', owner, { title: 'Chi chung', category: 'other', amountMinor,
      payerParticipantId: trip.ownerParticipantId, occurredOn: '2026-11-19', splitMethod: 'equal', split: { participantIds: [trip.ownerParticipantId] } });
    const join = async (member: Identity, key = randomUUID()) => {
      const invite = await ok(root + '/invites', owner, {});
      const result = await ok('invites/accept', member, { token: invite.token }, undefined, 'POST', key);
      return { invite, result, key };
    };
    const clean = async () => expect((await checkDatabase(db(), { tripId: trip.id, pageSize: 3 })).issues).toEqual([]);
    return { owner, trip, root, overview, expense, join, clean };
  }

  it('keeps legacy allocations and selected expense shares separate across joins, edits and voids', async () => {
    const f = await fixture(), b = await register('Bình'), c = await register('Chi'), d = await register('Dũng');
    const pb = (await f.join(b)).result.participantId; await f.join(c);
    const legacy = await f.expense(300000), legacyBefore = (await db().doc(f.root + '/expenses/' + legacy.id).get()).data();
    const body = { title: 'Vé chỉ hai người', category: 'other', amountMinor: 700000, payerParticipantId: f.trip.ownerParticipantId,
      sharingScope: 'selected', occurredOn: '2026-11-26', splitMethod: 'equal', split: { participantIds: [f.trip.ownerParticipantId, pb] } };
    const key = randomUUID(), selected = await ok(f.root + '/expenses', f.owner, body, undefined, 'POST', key);
    expect(await ok(f.root + '/expenses', f.owner, body, undefined, 'POST', key)).toEqual(selected);
    let data = await f.overview();
    expect(data.trip.totalExpenseMinor).toBe(1000000);
    expect(data.balances.find((row: any) => row.participantId === pb)).toMatchObject({ owedMinor: 450000, allocatedOwedMinor: 350000 });
    const pd = (await f.join(d)).result.participantId;
    data = await f.overview();
    expect(data.balances.find((row: any) => row.participantId === pb).owedMinor).toBe(425000);
    expect(data.balances.find((row: any) => row.participantId === pd).owedMinor).toBe(75000);
    const oldClient = await send(f.root + '/expenses/' + selected.id, f.owner, { ...body, title: undefined, category: undefined,
      occurredOn: undefined, sharingScope: undefined }, 1, 'PATCH');
    expect(oldClient.statusCode).toBe(409); expect(oldClient.json().error.code).toBe('EXPENSE_SELECTION_REQUIRED');
    const ledger = data.trip.ledgerVersion;
    await ok(f.root + '/expenses/' + selected.id, f.owner, { title: 'Đổi tên giữ người chia' }, 1, 'PATCH');
    expect((await f.overview()).trip.ledgerVersion).toBe(ledger);
    await ok(f.root + '/expenses/' + selected.id, f.owner, { amountMinor: 600000, payerParticipantId: f.trip.ownerParticipantId,
      sharingScope: 'selected', splitMethod: 'exact', split: { shares: [{ participantId: pb, amountMinor: 600000 }] } }, 2, 'PATCH');
    data = await f.overview();
    expect(data.balances.find((row: any) => row.participantId === pb).owedMinor).toBe(675000);
    expect((await db().doc(f.root + '/expenses/' + legacy.id).get()).data()).toEqual(legacyBefore);
    await f.clean();
    await ok(f.root + '/expenses/' + selected.id + '/void', f.owner, { reason: 'Hủy khoản chọn riêng' }, 3);
    data = await f.overview();
    expect(data.balances.every((row: any) => row.owedMinor === 75000 && (row.allocatedOwedMinor ?? 0) === 0)).toBe(true);
    await f.clean();
  }, 30000);

  it('keeps a selected participant liable after removal and rejects invalid selections', async () => {
    const f = await fixture(), b = await register('Bình'), c = await register('Chi');
    const pb = (await f.join(b)).result.participantId; await f.join(c);
    const body = { title: 'Chia riêng', category: 'other', amountMinor: 700000, payerParticipantId: f.trip.ownerParticipantId,
      sharingScope: 'selected', occurredOn: '2026-11-26', splitMethod: 'equal', split: { participantIds: [f.trip.ownerParticipantId, pb] } };
    const expense = await ok(f.root + '/expenses', f.owner, body);
    await ok(f.root + '/memberships/' + b.user.uid + '/remove', f.owner, { reason: 'Rời nhóm' }, 1);
    let data = await f.overview();
    expect(data.balances.find((row: any) => row.participantId === pb)).toMatchObject({ owedMinor: 350000, netMinor: -350000 });
    expect((await send(f.root + '/expenses', f.owner, body)).statusCode).toBe(422);
    expect((await send(f.root + '/expenses', f.owner, { ...body, split: { participantIds: [randomUUID()] } })).statusCode).toBe(422);
    await ok(f.root + '/memberships/' + b.user.uid + '/restore', f.owner, { reason: 'Trở lại' }, 2);
    data = await f.overview(); expect(data.balances.find((row: any) => row.participantId === pb).owedMinor).toBe(350000);
    await ok(f.root + '/expenses/' + expense.id + '/void', f.owner, { reason: 'Hủy' }, 1);
    expect((await f.overview()).balances.every((row: any) => row.netMinor === 0 && row.owedMinor === 0)).toBe(true);
    await f.clean();
  });

  it('serializes a selected expense with a join without charging the new member', async () => {
    const f = await fixture(), b = await register('Bình');
    const invite = await ok(f.root + '/invites', f.owner, {});
    await Promise.all([ok('invites/accept', b, { token: invite.token }), ok(f.root + '/expenses', f.owner, { title: 'Chỉ chủ nhóm', category: 'other',
      amountMinor: 100001, payerParticipantId: f.trip.ownerParticipantId, sharingScope: 'selected', occurredOn: '2026-11-26',
      splitMethod: 'equal', split: { participantIds: [f.trip.ownerParticipantId] } })]);
    const data = await f.overview();
    expect(data.balances.find((row: any) => row.participantId !== f.trip.ownerParticipantId).owedMinor).toBe(0);
    expect(data.balances.find((row: any) => row.participantId === f.trip.ownerParticipantId).owedMinor).toBe(100001);
    await f.clean();
  });

  it('joining automatically links identity and redistributes all previous costs, including idempotent retries', async () => {
    const f = await fixture(), aaa = await register('aaa');
    await f.expense(2100000);
    const { invite, result, key } = await f.join(aaa);
    expect(result.participantId).toBeTruthy();
    expect(await ok('invites/accept', aaa, { token: invite.token }, undefined, 'POST', key)).toEqual(result);
    await ok('invites/accept', aaa, { token: invite.token });
    const data = await f.overview();
    expect(data.trip.sharingMode).toBe('group-equal');
    expect(data.trip.equalParticipantIds).toHaveLength(2);
    expect(data.participants).toHaveLength(2);
    expect(data.balances.find((row: any) => row.participantId === result.participantId)).toMatchObject({ owedMinor: 1050000, netMinor: -1050000 });
    expect(data.balances.find((row: any) => row.participantId === f.trip.ownerParticipantId)).toMatchObject({ paidMinor: 2100000, owedMinor: 1050000, netMinor: 1050000 });
    await f.clean();
  });

  it('uses the total remainder once and recomputes on edits, payer changes and voids', async () => {
    const f = await fixture(), aaa = await register('aaa'), bbb = await register('bbb');
    const a = await f.join(aaa); await f.join(bbb);
    const first = await f.expense(1), second = await f.expense(1);
    let data = await f.overview();
    const expected = new Map(splitGroupTotal(2, data.trip.equalParticipantIds).map(row => [row.participantId, row.amountMinor]));
    for (const row of data.balances) expect(row.owedMinor).toBe(expected.get(row.participantId));
    await ok(f.root + '/expenses/' + first.id + '/void', f.owner, { reason: 'Hủy chi' }, first.version);
    await ok(f.root + '/expenses/' + second.id, f.owner, { amountMinor: 120000, payerParticipantId: a.result.participantId,
      splitMethod: 'equal', split: { participantIds: [f.trip.ownerParticipantId] } }, second.version, 'PATCH');
    data = await f.overview();
    expect(data.balances.every((row: any) => row.owedMinor === 40000)).toBe(true);
    expect(data.balances.find((row: any) => row.participantId === a.result.participantId).paidMinor).toBe(120000);
    const latest = await ok(f.root + '/expenses/' + second.id, f.owner);
    await ok(f.root + '/expenses/' + second.id + '/void', f.owner, { reason: 'Hủy chi còn lại' }, latest.version);
    expect((await f.overview()).balances.every((row: any) => row.owedMinor === 0 && row.paidMinor === 0)).toBe(true);
    await f.clean();
  });

  it('preserves confirmed transfers when another member joins, leaves and is restored', async () => {
    const f = await fixture(), aaa = await register('aaa'), bbb = await register('bbb');
    const a = await f.join(aaa); await f.expense(300000);
    let data = await f.overview();
    const payment = await ok(f.root + '/settlements', aaa, { fromParticipantId: a.result.participantId, toParticipantId: f.trip.ownerParticipantId,
      amountMinor: 50000, occurredOn: '2026-11-19', note: null, basedOnLedgerVersion: data.trip.ledgerVersion });
    await ok(f.root + '/settlements/' + payment.id + '/confirm', f.owner, { basedOnLedgerVersion: data.trip.ledgerVersion }, payment.version);
    const b = await f.join(bbb);
    data = await f.overview();
    expect(data.balances.find((row: any) => row.participantId === a.result.participantId)).toMatchObject({ owedMinor: 100000, sentMinor: 50000, netMinor: -50000 });
    await ok(f.root + '/memberships/' + bbb.user.uid + '/remove', f.owner, { reason: 'Rời nhóm' }, 1);
    data = await f.overview();
    expect(data.trip.equalParticipantIds).toHaveLength(2);
    expect(data.balances.find((row: any) => row.participantId === a.result.participantId)).toMatchObject({ owedMinor: 150000, sentMinor: 50000, netMinor: -100000 });
    await ok(f.root + '/memberships/' + bbb.user.uid + '/restore', f.owner, { reason: 'Vào lại nhóm' }, 2);
    expect((await f.overview()).trip.equalParticipantIds).toContain(b.result.participantId);
    await f.clean();
  });

  it('upgrades an existing group and enrolls unlinked accounts without counting duplicate manual names', async () => {
    const f = await fixture(true), aaa = await register('aaa');
    const duplicate = await ok(f.root + '/participants', f.owner, { displayName: 'okr' });
    const expense = await f.expense(2100000);
    await f.join(aaa);
    await db().doc('trips/' + f.trip.id).update({ sharingMode: FieldValue.delete() });
    await ok(f.root + '/share-equally', aaa, {});
    await ok(f.root + '/share-equally', aaa, {});
    const data = await f.overview(), linked = data.participants.find((person: any) => person.linkedUid === aaa.user.uid);
    expect(data.trip.equalParticipantIds).toHaveLength(2);
    expect(data.participants).toHaveLength(3);
    expect(data.balances.find((row: any) => row.participantId === linked.id)).toMatchObject({ owedMinor: 1050000, netMinor: -1050000 });
    expect(data.balances.find((row: any) => row.participantId === duplicate.id).owedMinor).toBe(0);
    expect((await ok(f.root + '/expenses/' + expense.id, f.owner)).shares).toHaveLength(1);
    await f.clean();
  });

  it('serializes concurrent joins and expenses against the same total', async () => {
    const f = await fixture(), aaa = await register('aaa'), bbb = await register('bbb');
    await f.expense(2100000);
    const invite = await ok(f.root + '/invites', f.owner, { maxUses: 20 });
    await Promise.all([ok('invites/accept', aaa, { token: invite.token }), ok('invites/accept', bbb, { token: invite.token }), f.expense(900000)]);
    const data = await f.overview();
    expect(data.trip.totalExpenseMinor).toBe(3000000);
    expect(data.trip.equalParticipantIds).toHaveLength(3);
    expect(data.balances.every((row: any) => row.owedMinor === 1000000)).toBe(true);
    await f.clean();
  }, 30000);

  it('keeps an inactive historical payer when editing upgraded expenses and rejects a different outsider payer', async () => {
    const f = await fixture(true);
    const old = await ok(f.root + '/participants', f.owner, { displayName: 'Người ứng trước đây' });
    const other = await ok(f.root + '/participants', f.owner, { displayName: 'Tên ngoài nhóm' });
    const expense = await ok(f.root + '/expenses', f.owner, { title: 'Chi cũ', category: 'other', amountMinor: 120000,
      payerParticipantId: old.id, occurredOn: '2026-11-19', splitMethod: 'exact',
      split: { shares: [{ participantId: f.trip.ownerParticipantId, amountMinor: 120000 }] } });
    await ok(f.root + '/participants/' + old.id, f.owner, { status: 'inactive' }, old.version, 'PATCH');
    await ok(f.root + '/share-equally', f.owner, {});
    const before = await f.overview();
    await ok(f.root + '/expenses/' + expense.id, f.owner, { title: 'Sửa tên chi cũ' }, expense.version, 'PATCH');
    expect((await f.overview()).trip.ledgerVersion).toBe(before.trip.ledgerVersion);
    const body = { amountMinor: 180000, payerParticipantId: old.id, splitMethod: 'equal', split: { participantIds: [f.trip.ownerParticipantId] } };
    await ok(f.root + '/expenses/' + expense.id, f.owner, body, expense.version + 1, 'PATCH');
    const data = await f.overview();
    expect(data.balances.find((row: any) => row.participantId === old.id)).toMatchObject({ paidMinor: 180000, owedMinor: 0, netMinor: 180000 });
    expect(data.balances.find((row: any) => row.participantId === f.trip.ownerParticipantId)).toMatchObject({ owedMinor: 180000, netMinor: -180000 });
    expect((await send(f.root + '/expenses/' + expense.id, f.owner, { ...body, payerParticipantId: other.id }, expense.version + 2, 'PATCH')).json().error.code).toBe('INVALID_PARTICIPANTS');
    await f.clean();
  });

  it('keeps pending payments outside balances and requires a fresh ledger after membership changes', async () => {
    const f = await fixture(), aaa = await register('aaa'), bbb = await register('bbb');
    const a = await f.join(aaa); await f.expense(300000);
    const before = await f.overview();
    const payment = await ok(f.root + '/settlements', aaa, { fromParticipantId: a.result.participantId, toParticipantId: f.trip.ownerParticipantId,
      amountMinor: 150000, occurredOn: '2026-11-19', note: null, basedOnLedgerVersion: before.trip.ledgerVersion });
    await f.join(bbb);
    const data = await f.overview();
    expect(data.trip.pendingSettlementCount).toBe(1);
    expect(data.balances.find((row: any) => row.participantId === a.result.participantId)).toMatchObject({ sentMinor: 0, owedMinor: 100000, netMinor: -100000 });
    const path = f.root + '/settlements/' + payment.id;
    expect((await send(path + '/confirm', f.owner, { basedOnLedgerVersion: before.trip.ledgerVersion }, payment.version)).json().error.code).toBe('LEDGER_CHANGED');
    expect((await send(path + '/confirm', f.owner, { basedOnLedgerVersion: data.trip.ledgerVersion }, payment.version)).json().error.code).toBe('SETTLEMENT_EXCEEDS_BALANCE');
    await ok(path + '/cancel', aaa, {}, payment.version);
    expect((await f.overview()).balances).toEqual(data.balances);
    await f.clean();
  });

  it('freezes closed shares when access is revoked and uses current membership on reopen', async () => {
    const f = await fixture(), aaa = await register('aaa');
    const a = await f.join(aaa); await f.expense(200000);
    let data = await f.overview();
    const payment = await ok(f.root + '/settlements', aaa, { fromParticipantId: a.result.participantId, toParticipantId: f.trip.ownerParticipantId,
      amountMinor: 100000, occurredOn: '2026-11-19', note: null, basedOnLedgerVersion: data.trip.ledgerVersion });
    await ok(f.root + '/settlements/' + payment.id + '/confirm', f.owner, { basedOnLedgerVersion: data.trip.ledgerVersion }, payment.version);
    data = await f.overview();
    await ok(f.root + '/archive', f.owner, {}, data.trip.version);
    await ok(f.root + '/memberships/' + aaa.user.uid + '/remove', f.owner, { reason: 'Gỡ quyền sau khi chốt' }, 1);
    data = await f.overview();
    expect(data.trip.equalParticipantIds).toHaveLength(2);
    expect(data.balances.every((row: any) => row.netMinor === 0)).toBe(true);
    await f.clean();
    await ok(f.root + '/reopen', f.owner, {}, data.trip.version);
    data = await f.overview();
    expect(data.trip.equalParticipantIds).toEqual([f.trip.ownerParticipantId]);
    expect(data.balances.find((row: any) => row.participantId === a.result.participantId)).toMatchObject({ owedMinor: 0, sentMinor: 100000, netMinor: 100000 });
    await f.clean();
  });

  it('rejects outsiders, custom shares and manual identity changes in automatic groups', async () => {
    const f = await fixture(), outsider = await register('Ngoài nhóm');
    expect((await send(f.root + '/share-equally', outsider, {})).statusCode).toBe(404);
    expect((await send(f.root + '/participants', f.owner, { displayName: 'Tên thêm tay' })).json().error.code).toBe('GROUP_SHARING_AUTOMATIC');
    expect((await send(f.root + '/expenses', f.owner, { title: 'Chia riêng', category: 'other', amountMinor: 100000,
      payerParticipantId: f.trip.ownerParticipantId, occurredOn: '2026-11-19', splitMethod: 'exact', split: { shares: [{ participantId: f.trip.ownerParticipantId, amountMinor: 100000 }] } })).json().error.code).toBe('GROUP_EQUAL_SHARING_REQUIRED');
    await f.clean();
  });
});
