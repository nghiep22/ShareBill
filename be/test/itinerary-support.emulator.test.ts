import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { db } from '../src/firebase.js';
import { checkDatabase } from '../src/database/check-integrity.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) {
  process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill';
  process.env.FIREBASE_WEB_API_KEY ??= 'demo';
}
const api = '/api/v1';
const support = api + '/support-tickets';
type Actor = { accessToken: string; user: { uid: string } };
type Result = Awaited<ReturnType<typeof buildApp>>;

describe.skipIf(!enabled)('Itinerary and user support', () => {
  let app: Result;
  beforeAll(async () => { app = await buildApp(Fastify({ logger: false })); });
  afterAll(async () => { await app?.close(); });

  async function account(displayName: string): Promise<Actor> {
    const result = await app.inject({
      method: 'POST', url: api + '/auth/register',
      payload: { email: randomUUID() + '@example.test', password: 'TestPassword-123!', displayName },
    });
    expect(result.statusCode, result.body).toBe(201);
    return result.json().data;
  }

  function get(path: string, actor: Actor) {
    return app.inject({ method: 'GET', url: path, headers: { authorization: 'Bearer ' + actor.accessToken } });
  }

  function send(path: string, actor: Actor, payload: object, version?: number, key = randomUUID()) {
    return app.inject({ method: 'POST', url: path, payload, headers: {
      authorization: 'Bearer ' + actor.accessToken, 'idempotency-key': key, ...(version !== undefined && { 'if-match': '"' + version + '"' }),
    } });
  }

  async function createTrip(owner: Actor) {
    const result = await send(api + '/trips', owner, { name: 'Đà Lạt', sharingMode: 'per-expense', ownerName: 'An' });
    expect(result.statusCode, result.body).toBe(200);
    const id = result.json().data.id as string;
    return { id, path: api + '/trips/' + id };
  }

  async function invite(trip: string, owner: Actor, member: Actor) {
    const result = await send(trip + '/invites', owner, {});
    expect(result.statusCode, result.body).toBe(201);
    const joined = await send(api + '/invites/accept', member, { token: result.json().data.token });
    expect(joined.statusCode, joined.body).toBe(200);
  }

  it('applies itinerary edits and scheduling atomically, preserves the ledger, and checks current permissions', async () => {
    const [owner, member, outsider] = await Promise.all([account('An'), account('Bình'), account('Chi')]);
    const trip = await createTrip(owner);
    await invite(trip.path, owner, member);
    const url = trip.path + '/itinerary';
    const day = '2026-12-20';
    const activity = { action: 'add-activity', title: 'Ăn sáng', day, time: '08:00', place: 'Đà Lạt', note: 'Gặp ở sảnh' };
    const current = await get(url, member);
    expect(current.json().data).toEqual({ version: 1, activities: [], suggestions: [] });
    expect(current.headers.etag).toBe('"1"');
    expect((await get(url, outsider)).statusCode).toBe(404);
    expect((await send(url, member, activity, 1)).statusCode).toBe(403);
    expect((await send(url, owner, { ...activity, time: '25:00' }, 1)).statusCode).toBe(422);
    expect((await send(url, owner, activity)).statusCode).toBe(428);

    const suggested = await send(url, member, { action: 'suggest', title: 'Ghé đồi chè' }, 1);
    expect(suggested.statusCode, suggested.body).toBe(200);
    const suggestionId = suggested.json().data.id as string;
    const command = { ...activity, title: 'Ghé đồi chè', suggestionId };
    const key = randomUUID();
    const competing = await Promise.all([
      send(url, owner, command, 2, key),
      send(url, owner, { action: 'decline-suggestion', id: suggestionId }, 2),
    ]);
    expect(competing.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const scheduled = competing[0]!.statusCode === 200 ? competing[0]! : await send(url, owner, activity, 3);
    const activityId = scheduled.json().data.id as string;
    const nextVersion = scheduled.json().data.version as number;
    const stored = (await get(url, owner)).json().data;
    expect(stored.activities).toEqual([expect.objectContaining({ id: activityId })]);
    expect(stored.suggestions).toEqual([expect.objectContaining({
      id: suggestionId, author: 'Bình', status: competing[0]!.statusCode === 200 ? 'scheduled' : 'declined',
    })]);

    if (competing[0]!.statusCode === 200) {
      const replay = await send(url, owner, command, 2, key);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.json().data.id).toBe(activityId);
    }
    const edited = await send(url, owner, { ...activity, action: 'edit-activity', id: activityId, time: '09:30' }, nextVersion);
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await get(url, member)).json().data.activities[0].time).toBe('09:30');
    const removed = await send(url, owner, { action: 'remove-activity', id: activityId }, nextVersion + 1);
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await get(url, member)).json().data).toMatchObject({ activities: [], suggestions: [expect.objectContaining({
      status: competing[0]!.statusCode === 200 ? 'pending' : 'declined',
    })] });
    const activityLog = await get(trip.path + '/activity', member);
    expect(activityLog.json().data.items).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'itinerary.activity_removed', entityId: activityId })]));
    const overview = (await get(trip.path + '/overview', owner)).json().data;
    expect(overview).toMatchObject({ ledgerVersion: 0, trip: { version: 1, totalExpenseMinor: 0 } });
    expect((await checkDatabase(db(), { tripId: trip.id, pageSize: 25 })).issues).toEqual([]);

    const archived = await send(trip.path + '/archive', owner, {}, 1);
    expect(archived.statusCode, archived.body).toBe(200);
    expect((await send(url, member, { action: 'suggest', title: 'Một địa điểm khác' }, nextVersion + 2)).json().error.code).toBe('TRIP_NOT_WRITABLE');
    expect((await get(url, member)).statusCode).toBe(200);
    expect((await send(trip.path + '/memberships/' + member.user.uid + '/remove', owner, { reason: 'Thu hồi quyền' }, 1)).statusCode).toBe(200);
    expect((await get(url, member)).statusCode).toBe(404);
  }, 45_000);

  it('scopes support history to the author and enforces quota without duplicating retries', async () => {
    const [owner, sender] = await Promise.all([account('Chủ chuyến'), account('Người gửi')]);
    const trip = await createTrip(owner);
    const report = { category: 'receipt', message: 'Ảnh hóa đơn hiển thị lỗi sau khi lưu.' };
    expect((await app.inject({ method: 'GET', url: support })).statusCode).toBe(401);
    expect((await send(support, sender, { ...report, message: ' Lỗi ' })).statusCode).toBe(422);
    expect((await send(support, sender, { ...report, tripId: trip.id })).statusCode).toBe(404);
    await invite(trip.path, owner, sender);
    const key = randomUUID();
    const body = { ...report, tripId: trip.id };
    const submitted = await send(support, sender, body, undefined, key);
    expect(submitted.statusCode, submitted.body).toBe(201);
    const ticket = submitted.json().data;
    expect(ticket).toMatchObject({ tripId: trip.id, status: 'open' });
    const ref = db().doc('supportTickets/' + ticket.id);
    const updatedAt = Timestamp.fromMillis(Date.now() + 1_000);
    await ref.update({ status: 'in_progress', version: 2, updatedAt, internalFlag: 'secret-server-flag' });
    await ref.collection('internalNotes').doc(randomUUID()).set({ message: 'secret-operator-note' });
    const visible = await get(support + '/' + ticket.id, sender);
    expect(visible.json().data).toMatchObject({ status: 'in_progress', message: report.message });
    expect(visible.body).not.toContain('secret');
    expect((await get(support + '/' + ticket.id, owner)).statusCode).toBe(404);
    expect((await send(support, sender, { ...body, category: 'other' }, undefined, key)).json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const lookup = await get(api + '/operations/' + key, sender);
    expect(lookup.json().data).toMatchObject({ tripId: null, resourceType: 'supportTicket', resourceId: ticket.id });
    expect((await get(api + '/operations/' + key, owner)).statusCode).toBe(404);
    expect((await db().doc('users/' + sender.user.uid + '/operations/' + key).get()).get('responseSnapshot.data.message')).toBeUndefined();

    const writes = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      send(support, sender, { ...report, message: report.message + ' Lần ' + index })));
    expect(writes.map(result => result.statusCode).sort()).toEqual([201, 201, 201, 201, 429]);
    expect(writes.find(result => result.statusCode === 429)?.json().error.code).toBe('SUPPORT_TICKET_LIMIT');
    const replay = await send(support, sender, body, undefined, key);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().data.id).toBe(ticket.id);
    expect((await send(support, owner, report)).statusCode).toBe(201);

    const first = (await get(support + '?limit=2', sender)).json().data;
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    expect((await get(support + '?cursor=' + first.nextCursor, owner)).statusCode).toBe(400);
    const rest = (await get(support + '?limit=25&cursor=' + first.nextCursor, sender)).json().data;
    expect(rest.items).toHaveLength(3);
    const all = [...first.items, ...rest.items];
    expect(new Set(all.map(item => item.id)).size).toBe(5);
    expect(all.every(item => !('message' in item) && !('createdBy' in item))).toBe(true);

    const removed = await send(trip.path + '/memberships/' + sender.user.uid + '/remove', owner, { reason: 'Kết thúc hợp tác' }, 1);
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await get(support + '/' + ticket.id, sender)).statusCode).toBe(200);
    expect((await send(support, sender, body, undefined, key)).json().data.id).toBe(ticket.id);
  }, 45_000);
});
