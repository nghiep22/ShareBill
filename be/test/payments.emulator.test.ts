import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { db } from '../src/firebase.js';
import { checkDatabase } from '../src/database/check-integrity.js';
import { ReceiptService } from '../src/services/receipts.js';
import { MemoryReceiptStorage } from './helpers/receipt-storage.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) { process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill'; process.env.FIREBASE_WEB_API_KEY ??= 'demo'; }
type Identity = { accessToken: string; user: { uid: string } };

describe.skipIf(!enabled)('member QR and transfer evidence', () => {
  let app: Awaited<ReturnType<typeof buildApp>>, png: Buffer;
  const storage = new MemoryReceiptStorage();
  beforeAll(async () => {
    app = await buildApp(Fastify({ logger: false }), { receipts: new ReceiptService(storage) });
    png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();
  });
  afterAll(async () => { await app?.close(); });
  async function register(name: string): Promise<Identity> {
    const result = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
      email: `${randomUUID()}@example.test`, password: 'PaymentTest-123!', displayName: name,
    } });
    expect(result.statusCode, result.body).toBe(201); return result.json().data;
  }
  function send(path: string, actor: Identity, payload: object, version?: number, key = randomUUID(), method: 'POST' | 'PATCH' = 'POST') {
    return app.inject({ method, url: path, payload, headers: { authorization: `Bearer ${actor.accessToken}`,
      'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': `"${version}"` }) } });
  }
  function get(path: string, actor: Identity) { return app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${actor.accessToken}` } }); }
  async function fixture() {
    const owner = await register('Chủ nhóm'), sender = await register('Người chuyển'), recipient = await register('Người ứng tiền');
    const created = await send('/api/v1/trips', owner, { name: 'Nhóm chuyển tiền', ownerName: 'Chủ nhóm' });
    expect(created.statusCode, created.body).toBe(200);
    const tripId = created.json().data.id as string, path = `/api/v1/trips/${tripId}`, trip = db().doc(`trips/${tripId}`);
    const invite = (await send(path + '/invites', owner, {})).json().data.token;
    for (const person of [sender, recipient]) expect((await send('/api/v1/invites/accept', person, { token: invite })).statusCode).toBe(200);
    const senderId = (await trip.collection('memberships').doc(sender.user.uid).get()).get('participantId') as string;
    const recipientId = (await trip.collection('memberships').doc(recipient.user.uid).get()).get('participantId') as string;
    const expense = await send(path + '/expenses', recipient, { title: 'Bữa ăn nhóm', amountMinor: 300_000,
      payerParticipantId: recipientId, occurredOn: '2026-11-20', category: 'food', splitMethod: 'equal',
      split: { participantIds: [created.json().data.ownerParticipantId, senderId, recipientId] } });
    expect(expense.statusCode, expense.body).toBe(200);
    return { owner, sender, recipient, senderId, recipientId, path, tripId, trip };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function ready(f: Fixture, actor: Identity) {
    const intent = await send(f.path + '/receipts/upload-intents', actor, { contentType: 'image/png', bytes: png.length });
    expect(intent.statusCode, intent.body).toBe(201);
    const data = intent.json().data; storage.seed(data.upload.fields.key, png);
    const final = await send(`${f.path}/receipts/${data.id}/finalize`, actor, {}, data.version);
    expect(final.statusCode, final.body).toBe(200); return data.id as string;
  }
  async function payment(f: Fixture, receiptIds: string[], actor = f.sender, key = randomUUID()) {
    return send(f.path + '/settlements', actor, { fromParticipantId: f.senderId, toParticipantId: f.recipientId,
      amountMinor: 100_000, occurredOn: '2026-11-20', basedOnLedgerVersion: (await f.trip.get()).get('ledgerVersion'), receiptIds }, undefined, key);
  }
  async function clean(f: Fixture) { expect((await checkDatabase(db(), { tripId: f.tripId, pageSize: 20 })).issues).toEqual([]); }

  it('keeps QR self-managed, replaces it atomically, and scopes its signed view to the group', async () => {
    const f = await fixture(), qr = await ready(f, f.recipient), outsider = await register('Ngoài nhóm');
    const path = `${f.path}/participants/${f.recipientId}/payment-qr`, key = randomUUID();
    expect((await send(path, f.owner, { receiptId: qr }, 1, randomUUID(), 'PATCH')).statusCode).toBe(403);
    const first = await send(path, f.recipient, { receiptId: qr }, 1, key, 'PATCH');
    expect(first.statusCode, first.body).toBe(200);
    expect((await send(path, f.recipient, { receiptId: qr }, 1, key, 'PATCH')).headers['idempotency-replayed']).toBe('true');
    expect((await get(`${f.path}/receipts/${qr}/view-url`, f.sender)).statusCode).toBe(200);
    expect((await get(`${f.path}/receipts/${qr}/view-url`, outsider)).statusCode).toBe(404);
    const next = await ready(f, f.recipient);
    expect((await send(path, f.recipient, { receiptId: next }, 1, randomUUID(), 'PATCH')).statusCode).toBe(409);
    expect((await send(path, f.recipient, { receiptId: next }, 2, randomUUID(), 'PATCH')).statusCode).toBe(200);
    expect((await get(`${f.path}/receipts/${qr}/view-url`, f.sender)).statusCode).toBe(403);
    expect((await f.trip.collection('receipts').doc(qr).get()).get('status')).toBe('discarded');
    await clean(f);
  }, 30_000);

  it('stores evidence, reserves a pending pair, and updates balances once only after recipient confirmation', async () => {
    const f = await fixture(), proof = await ready(f, f.sender), key = randomUUID();
    expect((await payment(f, [proof], f.owner)).statusCode).toBe(403);
    const result = await payment(f, [proof], f.sender, key);
    expect(result.statusCode, result.body).toBe(200);
    const id = result.json().data.id, ref = f.trip.collection('settlements').doc(id);
    expect((await payment(f, [proof], f.sender, key)).headers['idempotency-replayed']).toBe('true');
    expect((await ref.get()).get('receiptIds')).toEqual([proof]);
    expect((await f.trip.collection('balances').doc(f.senderId).get()).get('sentMinor')).toBe(0);
    expect((await payment(f, [await ready(f, f.sender)])).json().error.code).toBe('PAYMENT_ALREADY_PENDING');
    for (const actor of [f.sender, f.owner]) expect((await send(`${f.path}/settlements/${id}/confirm`, actor,
      { basedOnLedgerVersion: (await f.trip.get()).get('ledgerVersion') }, 1)).statusCode).toBe(403);
    const view = `${f.path}/receipts/${proof}/view-url`;
    expect((await get(view, f.sender)).statusCode).toBe(200);
    expect((await get(view, f.recipient)).statusCode).toBe(200);
    expect((await get(view, f.owner)).statusCode).toBe(403);
    const ledgerVersion = (await f.trip.get()).get('ledgerVersion'), confirmKey = randomUUID();
    const confirmed = await send(`${f.path}/settlements/${id}/confirm`, f.recipient, { basedOnLedgerVersion: ledgerVersion }, 1, confirmKey);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect((await send(`${f.path}/settlements/${id}/confirm`, f.recipient, { basedOnLedgerVersion: ledgerVersion }, 1, confirmKey)).headers['idempotency-replayed']).toBe('true');
    expect((await f.trip.collection('balances').doc(f.senderId).get()).get('sentMinor')).toBe(100_000);
    expect((await ref.get()).get('confirmationMode')).toBe('recipient');
    expect((await ref.get()).get('receiptIds')).toEqual([proof]);
    expect((await get(view, f.recipient)).statusCode).toBe(200);
    expect((await f.trip.get()).get('ledgerVersion')).toBe(ledgerVersion + 1);
    expect((await send(`${f.path}/receipts/${proof}/discard`, f.sender, {}, 4)).json().error.code).toBe('RECEIPT_ATTACHED');
    expect((await send(`${f.path}/settlements/${id}/void`, f.owner, { reason: 'Kiểm tra giữ ảnh sau khi đảo giao dịch' }, 2)).statusCode).toBe(200);
    expect((await get(view, f.recipient)).statusCode).toBe(200);
    expect((await ref.get()).get('receiptIds')).toEqual([proof]);
    await clean(f);
  }, 30_000);

  it('rejects foreign evidence and keeps a cancelled payment and its image in history', async () => {
    const f = await fixture(), foreign = await ready(f, f.recipient);
    expect((await payment(f, [foreign])).json().error.code).toBe('RECEIPT_NOT_ATTACHABLE');
    const proof = await ready(f, f.sender);
    expect((await payment(f, [proof, proof])).statusCode).toBe(422);
    const created = await payment(f, [proof]), id = created.json().data.id;
    expect(created.statusCode, created.body).toBe(200);
    const ledgerVersion = (await f.trip.get()).get('ledgerVersion');
    expect((await send(`${f.path}/settlements/${id}/cancel`, f.sender, {}, 1)).statusCode).toBe(200);
    expect((await f.trip.get()).get('ledgerVersion')).toBe(ledgerVersion);
    expect((await get(`${f.path}/receipts/${proof}/view-url`, f.recipient)).statusCode).toBe(200);
    expect((await payment(f, [proof])).json().error.code).toBe('RECEIPT_NOT_ATTACHABLE');
    await clean(f);
  }, 30_000);

  it('allows one pending transfer per pair across different keys, actors, amounts and simultaneous requests without images', async () => {
    const f = await fixture(), ledgerVersion = (await f.trip.get()).get('ledgerVersion');
    const body = { fromParticipantId: f.senderId, toParticipantId: f.recipientId, amountMinor: 40_000,
      occurredOn: '2026-11-20', basedOnLedgerVersion: ledgerVersion };
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all([
      send(f.path + '/settlements', f.owner, body, undefined, keys[0]),
      send(f.path + '/settlements', f.sender, body, undefined, keys[1]),
    ]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const winner = results.findIndex(result => result.statusCode === 200), id = results[winner]!.json().data.id as string;
    const replay = await send(f.path + '/settlements', winner === 0 ? f.owner : f.sender, body, undefined, keys[winner]);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data.id).toBe(id);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const rejected = await send(f.path + '/settlements', f.owner, { ...body, amountMinor: 20_000 });
    expect(rejected.json().error.code).toBe('PAYMENT_ALREADY_PENDING');
    const suggestions = (await get(f.path + '/settlement-suggestions', f.owner)).json().data;
    expect(suggestions).toMatchObject({ ledgerVersion, revision: (await f.trip.get()).get('revision'),
      pendingTransfers: [{ fromParticipantId: f.senderId, toParticipantId: f.recipientId, amountMinor: 40_000 }] });
    expect((await f.trip.collection('settlements').get()).size).toBe(1);
    expect((await f.trip.get()).data()).toMatchObject({ settlementCountAllTime: 1, pendingSettlementCount: 1, ledgerVersion });
    expect((await f.trip.collection('balances').doc(f.senderId).get()).get('sentMinor')).toBe(0);
    expect((await send(`${f.path}/settlements/${id}/cancel`, f.owner, {}, 1)).statusCode).toBe(200);
    expect((await get(f.path + '/settlement-suggestions', f.owner)).json().data.pendingTransfers).toEqual([]);
    const next = await send(f.path + '/settlements', f.sender, body);
    expect(next.statusCode, next.body).toBe(200);
    expect((await send(`${f.path}/settlements/${next.json().data.id}/confirm`, f.recipient, { basedOnLedgerVersion: ledgerVersion }, 1)).statusCode).toBe(200);
    const remainder = await send(f.path + '/settlements', f.sender, { ...body, amountMinor: 60_000, basedOnLedgerVersion: ledgerVersion + 1 });
    expect(remainder.statusCode, remainder.body).toBe(200);
    await clean(f);
  }, 30_000);
});
