import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { auth, db } from '../src/firebase.js';
import { drainAdminAuthJobs, reconcileAdminAuth } from '../src/services/admin-auth-jobs.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (enabled) { process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill'; process.env.FIREBASE_WEB_API_KEY ??= 'demo'; }
type Identity = { accessToken: string; uid: string };

describe.skipIf(!enabled)('platform administration', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { app = await buildApp(Fastify({ logger: false })); });
  afterAll(async () => { await app?.close(); });

  async function account(google = true): Promise<Identity> {
    const email = randomUUID() + '@example.test';
    if (!google) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
        payload: { email, password: 'AdminFixture-123!', displayName: 'Người dùng' } });
      expect(response.statusCode).toBe(201);
      return { accessToken: response.json().data.accessToken, uid: response.json().data.user.uid };
    }
    const postBody = new URLSearchParams({ providerId: 'google.com',
      id_token: JSON.stringify({ sub: randomUUID(), email, email_verified: true, name: 'Quản trị thử' }) });
    const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postBody: postBody.toString(), requestUri: 'http://localhost', returnSecureToken: true }),
    });
    const result = await response.json() as { localId: string; idToken: string };
    expect(response.status).toBe(200);
    const identity = { uid: result.localId, accessToken: result.idToken };
    expect((await send('POST', '/api/v1/me/bootstrap', {}, identity)).statusCode).toBe(200);
    return identity;
  }
  async function grant(person: Identity) {
    await db().doc(`platformAdmins/${person.uid}`).set({ uid: person.uid, role: 'platform_admin', status: 'active',
      version: 1, grantedBy: 'test-operator', grantedAt: Timestamp.now() });
  }
  function send(method: 'GET' | 'POST' | 'PATCH', path: string, payload: object | undefined, person?: Identity, version?: number, key = randomUUID()) {
    return app.inject({ method, url: path, ...(payload && { payload }), headers: {
      ...(person && { authorization: 'Bearer ' + person.accessToken }), 'idempotency-key': key,
      ...(version === undefined ? {} : { 'if-match': '"' + version + '"' }),
    } });
  }
  const root = '/api/admin/v1';

  it('guards every admin API, revokes grants immediately and keeps admin rights outside trip access', async () => {
    const [password, google] = await Promise.all([account(false), account()]);
    await grant(password);
    expect((await send('GET', root + '/me', undefined)).statusCode).toBe(401);
    expect((await send('GET', root + '/me', undefined, password)).statusCode).toBe(403);
    expect((await send('GET', root + '/me', undefined, google)).statusCode).toBe(403);
    await grant(google);
    expect((await send('GET', root + '/me', undefined, google)).json().data.role).toBe('platform_admin');
    const dashboard = await send('GET', root + '/dashboard', undefined, google);
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    expect(dashboard.json().data.users).toBeGreaterThan(0);
    expect((await send('GET', root + '/system', undefined, google)).statusCode).toBe(200);
    const trip = await send('POST', '/api/v1/trips', { name: 'Chuyến riêng', ownerName: 'An' }, password);
    const id = trip.json().data.id;
    expect((await send('GET', '/api/v1/trips/' + id + '/overview', undefined, google)).statusCode).toBe(404);
    const metadata = await send('GET', root + '/trips/' + id, undefined, google);
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().data).not.toHaveProperty('balances');
    expect(metadata.json().data).not.toHaveProperty('note');
    await db().doc(`platformAdmins/${google.uid}`).update({ status: 'disabled' });
    expect((await send('GET', root + '/trips/' + id, undefined, google)).statusCode).toBe(403);
  }, 30_000);

  it('returns only aggregate reconciliation results in the protected system view', async () => {
    const operator = await account(); await grant(operator);
    const jobId = 'ledger-reconcile-' + randomUUID(), ref = db().doc('maintenanceJobs/' + jobId);
    const resultSummary = { tripsScanned: 3, tripsChecked: 2, tripsWithIssues: 1, issueCount: 2, scanErrors: 1 };
    await ref.set({ kind: 'ledger_reconcile', status: 'failed', resultSummary, attempts: 1,
      lastErrorCode: 'RECONCILE_ISSUES_FOUND', checkpoint: 'private-reconcile-checkpoint', leaseOwner: 'private-reconcile-lease',
      privateDiff: 'private-reconcile-financial-values', updatedAt: Timestamp.now() });
    try {
      const response = await send('GET', root + '/system', undefined, operator);
      expect(response.statusCode).toBe(200);
      expect(response.json().data.maintenance.find((job: { id: string }) => job.id === jobId)).toMatchObject({
        kind: 'ledger_reconcile', resultSummary, status: 'failed' });
      expect(response.body).not.toContain('private-reconcile');
      await ref.update({ 'resultSummary.unknown': 'private-reconcile-extra' });
      const invalid = await send('GET', root + '/system', undefined, operator);
      expect(invalid.json().data.maintenance.find((job: { id: string }) => job.id === jobId).resultSummary).toBeNull();
    } finally { await ref.delete(); }
  });

  it('processes a ticket with idempotent notes, version checks, private audit and safe user DTOs', async () => {
    const [operator, reporter] = await Promise.all([account(), account(false)]);
    await grant(operator);
    const ticket = await send('POST', '/api/v1/support-tickets', { category: 'balance', message: 'Cần kiểm tra số dư chuyến đi' }, reporter);
    const id = ticket.json().data.id, path = root + '/support/' + id;
    const key = randomUUID(), body = { note: 'Ghi chú chỉ dành cho người vận hành' };
    expect((await send('POST', path + '/notes', body, operator, 1, key)).statusCode).toBe(200);
    expect((await send('POST', path + '/notes', body, operator, 1, key)).headers['idempotency-replayed']).toBe('true');
    const conflict = await send('PATCH', path, { status: 'resolved', reason: 'Đã đối chiếu dữ liệu số dư' }, operator, 1);
    expect(conflict.json().error.code).toBe('VERSION_CONFLICT');
    expect((await send('PATCH', path, { status: 'resolved', reason: 'Đã đối chiếu dữ liệu số dư' }, operator, 2)).statusCode).toBe(200);
    const view = await send('GET', path, undefined, operator);
    expect(view.json().data.notes).toHaveLength(1);
    const userView = await send('GET', '/api/v1/support-tickets/' + id, undefined, reporter);
    expect(userView.json().data.status).toBe('resolved');
    expect(userView.body).not.toContain(body.note);
    expect(userView.json().data).not.toHaveProperty('notes');
    expect((await send('GET', path, undefined, reporter)).statusCode).toBe(403);
    expect((await db().collection('adminAuditEvents').where('targetId', '==', id).get()).size).toBe(2);
  }, 30_000);

  it('suspends a trip without changing the ledger and serializes concurrent moderation', async () => {
    const [operator, owner] = await Promise.all([account(), account(false)]);
    await grant(operator);
    const trip = await send('POST', '/api/v1/trips', { name: 'Kiểm khóa chuyến', ownerName: 'An' }, owner);
    const id = trip.json().data.id, ref = db().doc(`trips/${id}`), prefix = root + '/trips/' + id;
    const result = await Promise.all([1, 2].map(() => send('POST', prefix + '/suspend', { reason: 'Đang đối chiếu yêu cầu hỗ trợ' }, operator, 1)));
    expect(result.map(row => row.statusCode).sort()).toEqual([200, 409]);
    expect((await ref.get()).data()).toMatchObject({ moderationStatus: 'suspended', ledgerVersion: 0 });
    expect((await send('GET', '/api/v1/trips/' + id + '/overview', undefined, owner)).statusCode).toBe(200);
    expect((await send('POST', '/api/v1/trips/' + id + '/participants', { displayName: 'Bình' }, owner)).json().error.code).toBe('TRIP_NOT_WRITABLE');
    expect((await send('POST', prefix + '/resume', { reason: 'Đã kiểm tra và cho phép tiếp tục' }, operator, 2)).statusCode).toBe(200);
    expect((await ref.get()).get('ledgerVersion')).toBe(0);
  }, 30_000);

  it('requires recent Google authentication before a mutation and leaves data unchanged on failure', async () => {
    const [operator, reporter] = await Promise.all([account(), account(false)]);
    await grant(operator);
    const created = await send('POST', '/api/v1/support-tickets', { category: 'other', message: 'Kiểm tra xác thực gần đây' }, reporter);
    const id = created.json().data.id;
    const claims = await auth().verifyIdToken(operator.accessToken, true);
    const verification = vi.spyOn(auth(), 'verifyIdToken').mockResolvedValueOnce({ ...claims, auth_time: Math.floor(Date.now() / 1000) - 601 });
    try {
      const result = await send('PATCH', root + '/support/' + id, { status: 'resolved', reason: 'Đã kiểm tra dữ liệu báo lỗi' }, operator, 1);
      expect(result.json().error.code).toBe('ADMIN_REAUTH_REQUIRED');
      expect((await db().doc('supportTickets/' + id).get()).get('version')).toBe(1);
    } finally { verification.mockRestore(); }
  }, 30_000);

  it('keeps an account blocked on Auth failure and retries the desired state safely', async () => {
    const [operator, person] = await Promise.all([account(), account(false)]);
    await grant(operator);
    const result = await send('POST', root + '/users/' + person.uid + '/disable',
      { reason: 'Kiểm tra lỗi dịch vụ đăng nhập' }, operator, 1);
    const job = db().doc('adminAuthJobs/' + result.json().data.jobId);
    await drainAdminAuthJobs(db(), {
      updateUser: async uid => { if (uid === person.uid) throw new Error('Simulated upstream failure'); return auth().getUser(uid); },
      revokeRefreshTokens: uid => auth().revokeRefreshTokens(uid),
    }, 100);
    expect((await db().doc('users/' + person.uid).get()).data()).toMatchObject({ status: 'disabled', authSyncStatus: 'pending' });
    expect((await job.get()).data()).toMatchObject({ status: 'queued', attempts: 1, lastErrorCode: 'AUTH_SYNC_FAILED' });
    await job.update({ availableAt: Timestamp.now() });
    await drainAdminAuthJobs(db(), auth(), 100);
    expect((await job.get()).get('status')).toBe('succeeded');
    expect((await auth().getUser(person.uid)).disabled).toBe(true);
  }, 30_000);

  it('reconciles an Auth state that changed after the previous sync completed', async () => {
    const person = await account(false), checkpoint = db().doc('adminAuthReconciliation/current');
    await auth().updateUser(person.uid, { disabled: true });
    await checkpoint.set({ lastUid: person.uid.slice(0, -1) });
    try {
      const result = await reconcileAdminAuth(db(), auth(), 100);
      expect(result.queued).toBeGreaterThan(0);
      expect((await db().doc('users/' + person.uid).get()).data()).toMatchObject({ status: 'disabled', authSyncStatus: 'pending' });
      await drainAdminAuthJobs(db(), auth(), 100);
      expect((await auth().getUser(person.uid)).disabled).toBe(false);
      expect((await db().doc('users/' + person.uid).get()).data()).toMatchObject({ status: 'active', authSyncStatus: 'synced' });
    } finally { await checkpoint.delete(); }
  }, 30_000);

  it('blocks app access immediately and enables it only after Auth sync, preserving newer desired state', async () => {
    const [operator, person] = await Promise.all([account(), account(false)]);
    await grant(operator);
    const prefix = root + '/users/' + person.uid, reason = { reason: 'Thử đồng bộ khóa tài khoản' }, key = randomUUID();
    const result = await send('POST', prefix + '/disable', reason, operator, 1, key);
    expect(result.statusCode).toBe(202);
    expect((await send('POST', prefix + '/disable', reason, operator, 1, key)).json().data.jobId).toBe(result.json().data.jobId);
    expect((await send('GET', '/api/v1/me', undefined, person)).statusCode).toBe(403);
    let raced = false;
    await drainAdminAuthJobs(db(), {
      updateUser: async (uid, props) => {
        const saved = await auth().updateUser(uid, props);
        if (uid === person.uid && !raced) {
          raced = true;
          expect((await send('POST', prefix + '/enable', { reason: 'Đổi quyết định khi đồng bộ đang chạy' }, operator, 2)).statusCode).toBe(202);
          expect((await db().doc(`users/${person.uid}`).get()).get('status')).toBe('disabled');
        }
        return saved;
      },
      revokeRefreshTokens: uid => auth().revokeRefreshTokens(uid),
    }, 100);
    expect(raced).toBe(true);
    expect((await auth().getUser(person.uid)).disabled).toBe(false);
    expect((await db().doc(`users/${person.uid}`).get()).data()).toMatchObject({
      status: 'active', desiredAuthDisabled: false, authSyncStatus: 'synced', moderationVersion: 3,
    });
    const self = await send('POST', root + '/users/' + operator.uid + '/disable', reason, operator, 1);
    expect(self.json().error.code).toBe('ADMIN_TARGET_PROTECTED');
  }, 30_000);
});
