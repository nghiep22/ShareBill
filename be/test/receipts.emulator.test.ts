import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import sharp from 'sharp';
import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { db } from '../src/firebase.js';
import { checkDatabase } from '../src/database/check-integrity.js';
import { DAY_MS, MAX_RECEIPT_BYTES } from '../src/database/receipt.js';
import { ReceiptService } from '../src/services/receipts.js';
import { processReceiptImage } from '../src/services/receipt-image.js';
import { cleanReceipt, cleanupReceipts } from '../src/services/receipt-cleanup.js';
import { MemoryReceiptStorage } from './helpers/receipt-storage.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) { process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill'; process.env.FIREBASE_WEB_API_KEY ??= 'demo'; }
type Identity = { accessToken: string; user: { uid: string } };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe.skipIf(!enabled)('S10 private receipt lifecycle', () => {
  let app: Awaited<ReturnType<typeof buildApp>>, storage: MemoryReceiptStorage, receipts: ReceiptService, png: Buffer;
  const logs: string[] = [];
  beforeAll(async () => { png = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#fff4da' } }).png().toBuffer(); });
  beforeEach(async () => {
    storage = new MemoryReceiptStorage(); receipts = new ReceiptService(storage);
    app = await buildApp(Fastify({ logger: { stream: { write: (line: string) => { logs.push(line); } } } }), { receipts });
  });
  afterEach(async () => { vi.restoreAllMocks(); await app?.close(); });
  async function register(name = 'Khách'): Promise<Identity> {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
      email: `s10-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: name } });
    expect(response.statusCode).toBe(201); return response.json().data;
  }
  function send(method: 'POST' | 'PATCH', path: string, payload: object, actor: Identity, version?: number, key = randomUUID()) {
    return app.inject({ method, url: path, payload, headers: { authorization: `Bearer ${actor.accessToken}`, 'idempotency-key': key,
      ...(version === undefined ? {} : { 'if-match': `"${version}"` }) } });
  }
  function get(path: string, actor: Identity) { return app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${actor.accessToken}` } }); }
  async function fixture() {
    const owner = await register('An'), response = await send('POST', '/api/v1/trips', { name: 'Đà Lạt', sharingMode: 'per-expense', ownerName: 'An' }, owner);
    expect(response.statusCode).toBe(200);
    const { id, ownerParticipantId } = response.json().data;
    return { owner, id: id as string, participantId: ownerParticipantId as string, path: `/api/v1/trips/${id}`, trip: db().doc(`trips/${id}`) };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function join(f: Fixture) {
    const actor = await register(), invitation = await send('POST', `${f.path}/invites`, {}, f.owner);
    expect((await send('POST', '/api/v1/invites/accept', { token: invitation.json().data.token }, actor)).statusCode).toBe(200);
    return actor;
  }
  async function intent(f: Fixture, actor = f.owner) {
    const result = await send('POST', `${f.path}/receipts/upload-intents`, { contentType: 'image/png', bytes: png.length }, actor);
    expect(result.statusCode, result.body).toBe(201);
    return result.json().data as { id: string; version: number; upload: { fields: { key: string } } };
  }
  async function ready(f: Fixture, actor = f.owner) {
    const data = await intent(f, actor); storage.seed(data.upload.fields.key, png);
    const key = randomUUID(), response = await send('POST', `${f.path}/receipts/${data.id}/finalize`, {}, actor, 1, key);
    expect(response.statusCode, response.body).toBe(200);
    return { ...data, version: response.json().data.version as number, key };
  }
  function expenseInput(f: Fixture, receiptIds: string[]) {
    return { title: 'Bữa ăn', amountMinor: 100, payerParticipantId: f.participantId, splitMethod: 'equal',
      split: { participantIds: [f.participantId] }, occurredOn: '2026-12-20', category: 'food', receiptIds };
  }
  async function clean(f: Fixture) { expect((await checkDatabase(db(), { tripId: f.id, pageSize: 20 })).issues).toEqual([]); }

  it('issues bounded policies with owner/member access, a shared quota and safe replay snapshots', async () => {
    const f = await fixture(), outsider = await register(), path = `${f.path}/receipts/upload-intents`, key = randomUUID();
    const body = { contentType: 'image/png', bytes: png.length };
    expect((await send('POST', path, body, outsider)).statusCode).toBe(404);
    for (const input of [{ ...body, bytes: 0 }, { ...body, bytes: MAX_RECEIPT_BYTES + 1 }, { ...body, contentType: 'image/svg+xml' },
      { ...body, path: 'arbitrary' }, { ...body, bytes: 1.5 }]) expect((await send('POST', path, input, f.owner)).statusCode).toBe(422);
    const first = await send('POST', path, body, f.owner, undefined, key);
    const replay = await send('POST', path, body, f.owner, undefined, key);
    expect(first.statusCode, first.body).toBe(201); expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(storage.policies[0]).toMatchObject({ path: first.json().data.upload.fields.key, contentType: 'image/png', maxBytes: MAX_RECEIPT_BYTES });
    expect(storage.policies[0]!.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
    const record = await db().doc(`users/${f.owner.user.uid}/operations/${key}`).get();
    expect(JSON.stringify(record.data())).not.toContain('fake-policy-secret');
    expect((await get(`/api/v1/operations/${key}`, f.owner)).json().data.resourceType).toBe('receipt');
    for (let i = 0; i < 8; i++) expect((await send('POST', path, body, f.owner)).statusCode).toBe(201);
    expect((await send('POST', path, body, f.owner)).json().error.code).toBe('RECEIPT_UPLOAD_LIMIT');
    expect((await f.trip.collection('receipts').get()).size).toBe(9);
    await f.trip.update({ status: 'archived' });
    expect((await send('POST', path, body, f.owner, undefined, key)).json().error.code).toBe('TRIP_NOT_WRITABLE');
    expect(logs.join('')).not.toContain('fake-upload-signature');
    await clean(f);
  }, 30_000);

  it('processes a real image, attaches it atomically and signs short view URLs without persisting capabilities', async () => {
    const f = await fixture(), member = await join(f), data = await ready(f), viewPath = `${f.path}/receipts/${data.id}/view-url`;
    const receiptRef = f.trip.collection('receipts').doc(data.id), row = (await receiptRef.get()).data()!;
    expect(row).toMatchObject({ status: 'ready', version: 3, bytes: expect.any(Number), width: 20, height: 30 });
    expect(storage.objects.has(row.stagingPath)).toBe(false);
    expect((await sharp(storage.objects.get(row.processedPath)!.buffer).metadata()).format).toBe('jpeg');
    expect((await get(viewPath, member)).statusCode).toBe(403);
    const view = await get(viewPath, f.owner);
    expect(view.statusCode).toBe(200); expect(view.headers['cache-control']).toBe('private, no-store');
    expect(Date.parse(view.json().data.expiresAt)).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(view.json().data.url).toContain(`generation=${row.processedGeneration}`);
    const result = await send('POST', `${f.path}/expenses`, expenseInput(f, [data.id]), f.owner);
    expect(result.statusCode, result.body).toBe(200);
    const expenseId = result.json().data.id;
    expect((await receiptRef.get()).data()).toMatchObject({ status: 'attached', version: 4, attachedExpenseId: expenseId });
    expect((await get(viewPath, member)).statusCode).toBe(200);
    expect((await send('POST', `${f.path}/expenses/${expenseId}/void`, { reason: 'Đối soát' }, f.owner, 1)).statusCode).toBe(200);
    expect((await get(viewPath, member)).statusCode).toBe(200);
    expect((await send('POST', `${f.path}/receipts/${data.id}/discard`, {}, f.owner, 4)).json().error.code).toBe('RECEIPT_ATTACHED');
    const replay = await send('POST', `${f.path}/receipts/${data.id}/finalize`, {}, f.owner, 1, data.key);
    expect(replay.headers['idempotency-replayed']).toBe('true'); expect(replay.json().data.status).toBe('ready');
    const operations = await db().collection(`users/${f.owner.user.uid}/operations`).get(), audits = await f.trip.collection('auditEvents').get();
    expect(JSON.stringify([operations.docs.map(doc => doc.data()), audits.docs.map(doc => doc.data()), (await receiptRef.get()).data()]))
      .not.toMatch(/fake-(view-signature|upload-signature|policy-secret)/);
    expect(logs.join('')).not.toContain('fake-view-signature');
    expect((await send('POST', `${f.path}/memberships/${member.user.uid}/remove`, { reason: 'Thu hồi quyền' }, f.owner, 1)).statusCode).toBe(200);
    expect((await get(viewPath, member)).statusCode).toBe(404);
    await clean(f);
  }, 30_000);

  it('rejects invalid images, expiry and foreign finalize calls without recording a successful operation', async () => {
    const f = await fixture(), member = await join(f), data = await intent(f), path = `${f.path}/receipts/${data.id}/finalize`;
    expect((await send('POST', path, {}, member, 1)).statusCode).toBe(403);
    expect((await send('POST', path, {}, f.owner)).statusCode).toBe(428);
    expect((await send('POST', path, { path: 'other' }, f.owner, 1)).statusCode).toBe(422);
    storage.seed(data.upload.fields.key, Buffer.from('not an image'));
    const key = randomUUID(), result = await send('POST', path, {}, f.owner, 1, key);
    expect(result.json().error.code).toBe('INVALID_RECEIPT_IMAGE');
    expect((await f.trip.collection('receipts').doc(data.id).get()).get('status')).toBe('failed');
    expect((await db().doc(`users/${f.owner.user.uid}/operations/${key}`).get()).exists).toBe(false);
    expect((await send('POST', path, {}, f.owner, 1, key)).json().error.code).toBe('RECEIPT_NOT_FINALIZABLE');
    const expired = await intent(f);
    await f.trip.collection('receipts').doc(expired.id).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
    expect((await send('POST', `${f.path}/receipts/${expired.id}/finalize`, {}, f.owner, 1)).json().error.code).toBe('UPLOAD_INTENT_EXPIRED');
    const replaced = await intent(f); storage.seed(replaced.upload.fields.key, png);
    const originalRead = storage.read.bind(storage);
    const spy = vi.spyOn(storage, 'read').mockImplementationOnce(async (path, generation, maxBytes) => {
      storage.seed(path, Buffer.from('replacement')); return originalRead(path, generation, maxBytes);
    });
    const replacedKey = randomUUID();
    expect((await send('POST', `${f.path}/receipts/${replaced.id}/finalize`, {}, f.owner, 1, replacedKey)).json().error.code).toBe('STORAGE_GENERATION_CHANGED');
    spy.mockRestore();
    const replacedRef = f.trip.collection('receipts').doc(replaced.id);
    expect((await replacedRef.get()).get('status')).toBe('processing');
    await replacedRef.update({ expiresAt: Timestamp.fromMillis(Date.now() - 1), processingLeaseUntil: Timestamp.fromMillis(Date.now() - 1) });
    await cleanReceipt(db(), replacedRef, storage, true);
    expect(storage.objects.has(replaced.upload.fields.key)).toBe(true);
    storage.seed(replaced.upload.fields.key, png);
    expect((await send('POST', `${f.path}/receipts/${replaced.id}/finalize`, {}, f.owner, 1, replacedKey)).statusCode).toBe(200);
    await clean(f);
  }, 30_000);

  it('reclaims an expired lease with the original key/base version and prevents an old attempt from winning', async () => {
    const f = await fixture(), data = await intent(f), other = await intent(f), path = `${f.path}/receipts/${data.id}/finalize`, key = randomUUID();
    storage.seed(data.upload.fields.key, png);
    const entered = gate(), unblock = gate(); let calls = 0;
    receipts.imageProcessor = async (bytes, type) => { if (++calls === 1) { entered.release(); await unblock.promise; } return processReceiptImage(bytes, type); };
    const first = send('POST', path, {}, f.owner, 1, key);
    await entered.promise;
    try {
      expect((await send('POST', path, {}, f.owner, 1, key)).json().error.code).toBe('PROCESSING_IN_PROGRESS');
      expect((await send('POST', path, {}, f.owner, 2, key)).json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await send('POST', `${f.path}/receipts/${other.id}/finalize`, {}, f.owner, 1, key)).json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await send('POST', `${f.path}/expenses`, expenseInput(f, []), f.owner, undefined, key)).json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await db().doc(`users/${f.owner.user.uid}/operations/${key}`).get()).exists).toBe(false);
      await f.trip.collection('receipts').doc(data.id).update({ processingLeaseUntil: Timestamp.fromMillis(Date.now() - 1) });
      const reclaimed = await send('POST', path, {}, f.owner, 1, key);
      expect(reclaimed.statusCode, reclaimed.body).toBe(200);
      expect(reclaimed.json().data.version).toBe(4);
      const pointer = (await f.trip.collection('receipts').doc(data.id).get()).get('processedPath');
      unblock.release();
      expect((await first).headers['idempotency-replayed']).toBe('true');
      expect((await f.trip.collection('receipts').doc(data.id).get()).get('processedPath')).toBe(pointer);
      expect([...storage.objects.keys()].filter(path => path.startsWith(`receipt-processed/${f.id}/${data.id}/`))).toHaveLength(2);
      await cleanReceipt(db(), f.trip.collection('receipts').doc(data.id), storage, true);
      expect(storage.objects.has(pointer)).toBe(true);
      expect([...storage.objects.keys()].filter(path => path.startsWith(`receipt-processed/${f.id}/${data.id}/`))).toHaveLength(1);
      await clean(f);
    } finally { unblock.release(); await first; }
  }, 30_000);

  it('rechecks access after processing and collects output orphaned when the uploader is removed', async () => {
    const f = await fixture(), member = await join(f), data = await intent(f, member), key = randomUUID();
    storage.seed(data.upload.fields.key, png);
    const saved = gate(), unblock = gate(), write = storage.write.bind(storage);
    vi.spyOn(storage, 'write').mockImplementationOnce(async (path, bytes) => { const output = await write(path, bytes); saved.release(); await unblock.promise; return output; });
    const result = send('POST', `${f.path}/receipts/${data.id}/finalize`, {}, member, 1, key);
    await saved.promise;
    try {
      expect((await send('POST', `${f.path}/memberships/${member.user.uid}/remove`, { reason: 'Thu hồi quyền' }, f.owner, 1)).statusCode).toBe(200);
      unblock.release(); expect((await result).statusCode).toBe(404);
      expect((await db().doc(`users/${member.user.uid}/operations/${key}`).get()).exists).toBe(false);
      const ref = f.trip.collection('receipts').doc(data.id);
      await ref.update({ createdAt: Timestamp.fromMillis(Date.now() - 2 * DAY_MS), expiresAt: Timestamp.fromMillis(Date.now() - DAY_MS),
        processingLeaseUntil: Timestamp.fromMillis(Date.now() - 1) });
      await cleanReceipt(db(), ref, storage, true);
      expect((await ref.get()).get('status')).toBe('discarded'); expect(storage.objects.size).toBe(0);
      await clean(f);
    } finally { unblock.release(); await result; }
  }, 30_000);

  it('enforces three private receipts, unique claims and atomic detach while retaining images on void', async () => {
    const f = await fixture(), member = await join(f), data = await ready(f, member), path = `${f.path}/expenses`;
    expect((await send('POST', path, expenseInput(f, [data.id]), f.owner)).json().error.code).toBe('RECEIPT_NOT_ATTACHABLE');
    expect((await send('POST', path, expenseInput(f, [data.id, data.id]), member)).statusCode).toBe(422);
    expect((await send('POST', path, expenseInput(f, Array.from({ length: 4 }, () => randomUUID())), member)).statusCode).toBe(422);
    const otherTrip = await fixture();
    expect((await send('POST', `${otherTrip.path}/expenses`, expenseInput(otherTrip, [data.id]), otherTrip.owner)).statusCode).toBe(404);
    const results = await Promise.all([send('POST', path, expenseInput(f, [data.id]), member), send('POST', path, expenseInput(f, [data.id]), member)]);
    expect(results.map(row => row.statusCode).sort()).toEqual([200, 409]);
    const expenseId = results.find(row => row.statusCode === 200)!.json().data.id;
    const own = await ready(f), second = await ready(f), third = await ready(f);
    expect((await send('PATCH', `${path}/${expenseId}`, { receiptIds: [data.id, own.id, second.id] }, f.owner, 1)).statusCode).toBe(200);
    expect((await f.trip.get()).get('ledgerVersion')).toBe(1);
    const detached = await send('PATCH', `${path}/${expenseId}`, { receiptIds: [third.id] }, f.owner, 2);
    expect(detached.statusCode, detached.body).toBe(200);
    const old = await f.trip.collection('receipts').doc(data.id).get();
    expect(old.get('status')).toBe('discarded'); expect(old.get('attachedExpenseId')).toBeNull();
    expect(old.get('cleanupAfter').toMillis() - old.get('discardedAt').toMillis()).toBe(7 * DAY_MS);
    expect((await send('POST', `${path}/${expenseId}/void`, { reason: 'Giữ chứng từ' }, f.owner, 3)).statusCode).toBe(200);
    expect((await f.trip.collection('receipts').doc(third.id).get()).get('status')).toBe('attached');
    await clean(f);
  }, 30_000);

  it('dry-runs cleanup without writes and resumes bounded jobs after a deletion error', async () => {
    const f = await fixture(), data = await ready(f);
    const deleteSpy = vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('synthetic finalize staging-delete failure'));
    const attached = await ready(f);
    await f.trip.collection('receipts').doc(attached.id).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
    const exp = await send('POST', `${f.path}/expenses`, expenseInput(f, [attached.id]), f.owner);
    expect(exp.statusCode).toBe(200);
    expect((await send('POST', `${f.path}/expenses/${exp.json().data.id}/void`, { reason: 'Lưu chứng từ' }, f.owner, 1)).statusCode).toBe(200);
    const unused = await intent(f); storage.seed(unused.upload.fields.key, png);
    await f.trip.collection('receipts').doc(unused.id).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
    const ref = f.trip.collection('receipts').doc(data.id);
    await ref.update({ updatedAt: Timestamp.fromMillis(Date.now() - 2 * DAY_MS) });
    const before = (await f.trip.collection('receipts').get()).docs.map(doc => doc.data()), objectCount = storage.objects.size;
    const dry = await cleanupReceipts(db(), storage, { apply: false, limit: 100, tripId: f.id });
    expect(dry.summary.deletedObjects).toBe(3); expect(dry.summary.discarded).toBe(2);
    expect(storage.objects.size).toBe(objectCount);
    expect((await f.trip.collection('receipts').get()).docs.map(doc => doc.data())).toEqual(before);
    deleteSpy.mockRejectedValueOnce(new Error('synthetic delete failure'));
    let report = await cleanupReceipts(db(), storage, { apply: true, limit: 1, tripId: f.id });
    expect(report.jobId).toBeTypeOf('string');
    let passes = 0;
    while (report.status !== 'completed' && ++passes < 10) {
      report = await cleanupReceipts(db(), storage, { apply: true, limit: 1, tripId: f.id, jobId: report.jobId! });
    }
    expect(report.status).toBe('completed'); expect(deleteSpy).toHaveBeenCalled();
    expect(storage.objects.size).toBe(1);
    const attachedData = (await f.trip.collection('receipts').doc(attached.id).get()).data()!;
    expect(storage.objects.has(attachedData.processedPath)).toBe(true);
    expect((await ref.get()).get('storageDeletedAt')).toBeInstanceOf(Timestamp);
    expect((await db().doc(`maintenanceJobs/${report.jobId}`).get()).get('status')).toBe('completed');
    expect((await db().doc(`maintenanceJobs/receipt-staging-${f.id}-${attached.id}`).get()).get('status')).toBe('completed');
    await clean(f);
  }, 30_000);

  it('serializes expired-ready cleanup against attach so attached bytes always survive', async () => {
    const f = await fixture(), data = await ready(f), ref = f.trip.collection('receipts').doc(data.id);
    const pointer = (await ref.get()).get('processedPath');
    await ref.update({ updatedAt: Timestamp.fromMillis(Date.now() - 2 * DAY_MS) });
    const [attached] = await Promise.all([
      send('POST', `${f.path}/expenses`, expenseInput(f, [data.id]), f.owner), cleanReceipt(db(), ref, storage, true),
    ]);
    expect([200, 409]).toContain(attached.statusCode);
    if (attached.statusCode === 200) { expect((await ref.get()).get('status')).toBe('attached'); expect(storage.objects.has(pointer)).toBe(true); }
    else { expect((await ref.get()).get('status')).toBe('discarded'); expect(storage.objects.has(pointer)).toBe(false); }
    await clean(f);
  }, 30_000);

  it('serializes discard/attach and honors the grace period before deleting detached image bytes', async () => {
    const f = await fixture(), data = await ready(f), ref = f.trip.collection('receipts').doc(data.id), pointer = (await ref.get()).get('processedPath');
    const key = randomUUID();
    const [attached, discarded] = await Promise.all([
      send('POST', `${f.path}/expenses`, expenseInput(f, [data.id]), f.owner),
      send('POST', `${f.path}/receipts/${data.id}/discard`, {}, f.owner, data.version, key),
    ]);
    expect([attached.statusCode, discarded.statusCode].sort()).toEqual([200, 409]);
    if (attached.statusCode === 200) {
      expect((await send('PATCH', `${f.path}/expenses/${attached.json().data.id}`, { receiptIds: [] }, f.owner, 1)).statusCode).toBe(200);
    } else {
      expect((await send('POST', `${f.path}/receipts/${data.id}/discard`, {}, f.owner, data.version, key)).headers['idempotency-replayed']).toBe('true');
    }
    await cleanReceipt(db(), ref, storage, true); expect(storage.objects.has(pointer)).toBe(true);
    await ref.update({ cleanupAfter: Timestamp.fromMillis(Date.now() - 1), expiresAt: Timestamp.fromMillis(Date.now() - 1) });
    await cleanReceipt(db(), ref, storage, true); expect(storage.objects.has(pointer)).toBe(false);
    await clean(f);
  }, 30_000);
});
