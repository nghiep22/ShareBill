import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';
import { deleteApp, getApps } from 'firebase-admin/app';
import { Timestamp } from 'firebase-admin/firestore';
import { buildApp } from '../src/create-app.js';
import { auth, db, receiptBucket } from '../src/firebase.js';
import { createReceiptDocument, processedPrefix } from '../src/database/receipt.js';
import { checkDatabase } from '../src/database/check-integrity.js';
import { CloudReceiptStorage } from '../src/services/receipt-storage.js';
import { applyProjectionRepair, prepareProjectionRepair } from '../src/services/projection-repair.js';
import { canonical, firestoreInventory, requireEvidence, RestoreRehearsalError, sha256 } from './restore-rehearsal-support.js';

type Account = { email: string; password: string; uid: string; accessToken: string };
type GoogleAccount = Account & { subject: string };
const directory = process.env.SHAREBILL_RESTORE_RUN ?? '';
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const json = async (file: string) => JSON.parse(await readFile(join(directory, file), 'utf8'));
const save = (file: string, value: unknown) => writeFile(join(directory, file), JSON.stringify(value), { flag: 'wx', mode: 0o600 });

async function send(method: 'GET' | 'POST' | 'PATCH', path: string, actor?: Account, body?: object, version?: number, key: string = randomUUID()) {
  return app!.inject({ method, url: path, ...(body && { payload: body }), headers: {
    ...(actor && { authorization: 'Bearer ' + actor.accessToken }), 'idempotency-key': key,
    ...(version !== undefined && { 'if-match': '"' + version + '"' }),
  } });
}
async function ok(method: 'GET' | 'POST' | 'PATCH', path: string, actor?: Account, body?: object, version?: number, key?: string) {
  const result = await send(method, path, actor, body, version, key);
  if (result.statusCode >= 300) {
    let code = 'UNEXPECTED_RESPONSE';
    try { const value = result.json().error?.code; if (typeof value === 'string' && /^[A-Z0-9_]+$/.test(value)) code = value; } catch { /* No response body is retained. */ }
    await save('api-failure.json', { method, path, status: result.statusCode, code });
  }
  requireEvidence(result.statusCode < 300, 'RESTORE_API_CHECK_FAILED');
  return result.json().data;
}
async function register(name: string): Promise<Account> {
  const email = randomUUID() + '@rehearsal.example.test', password = 'Restore-' + randomUUID();
  const session = await ok('POST', '/api/v1/auth/register', undefined, { email, password, displayName: name });
  return { email, password, uid: session.user.uid, accessToken: session.accessToken };
}
async function login(account: Account): Promise<Account> {
  const session = await ok('POST', '/api/v1/auth/login', undefined, { email: account.email, password: account.password });
  requireEvidence(session.user.uid === account.uid, 'RESTORE_AUTH_UID_MISMATCH');
  return { ...account, accessToken: session.accessToken };
}
async function googleLogin(existing?: GoogleAccount): Promise<GoogleAccount> {
  const subject = existing?.subject ?? randomUUID(), email = existing?.email ?? randomUUID() + '@rehearsal.example.test';
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({
      requestUri: 'http://localhost', returnSecureToken: true, postBody: new URLSearchParams({ providerId: 'google.com',
        id_token: JSON.stringify({ sub: subject, email, email_verified: true, name: 'Synthetic Google operator' }) }).toString(),
    }),
  });
  requireEvidence(response.ok, 'RESTORE_GOOGLE_LOGIN_FAILED');
  const result = await response.json() as { localId: string; idToken: string };
  requireEvidence(!existing || result.localId === existing.uid, 'RESTORE_GOOGLE_UID_MISMATCH');
  const account = { email, password: '', subject, uid: result.localId, accessToken: result.idToken };
  if (!existing) await ok('POST', '/api/v1/me/bootstrap', account, {});
  return account;
}
async function authInventory() {
  const page = await auth().listUsers(100);
  requireEvidence(!page.pageToken, 'RESTORE_AUTH_LIMIT');
  const users = page.users.map(user => ({ uid: user.uid, email: user.email, displayName: user.displayName,
    disabled: user.disabled, providers: user.providerData.map(provider => ({ providerId: provider.providerId, uid: provider.uid, email: provider.email })) }))
    .sort((a, b) => a.uid.localeCompare(b.uid));
  return { users: users.length, digest: sha256(canonical(users)) };
}
async function checker(tripId: string) {
  const result = await checkDatabase(db(), { tripId, pageSize: 5 });
  requireEvidence(result.summary.tripsChecked === 1 && result.summary.issueCount === 0, 'RESTORE_CHECKER_FAILED');
}

async function seed(projectId: string) {
  const owner = await register('Synthetic owner'), member = await register('Synthetic member');
  const outsider = await register('Synthetic outsider'), disabled = await register('Synthetic disabled account');
  const operator = await googleLogin();
  await auth().updateUser(disabled.uid, { disabled: true });
  const trip = await ok('POST', '/api/v1/trips', owner, { name: 'Isolated restore rehearsal', ownerName: 'Synthetic owner' });
  const root = '/api/v1/trips/' + trip.id;
  const invite = await ok('POST', root + '/invites', owner, {});
  const joined = await ok('POST', '/api/v1/invites/accept', member, { token: invite.token });
  const receiptId = randomUUID(), attempt = randomUUID(), now = Timestamp.now();
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#f1e4cf' } }).jpeg().toBuffer();
  const path = processedPrefix(trip.id, receiptId) + attempt + '.jpg';
  const object = await new CloudReceiptStorage().write(path, bytes);
  await db().doc(`trips/${trip.id}/receipts/${receiptId}`).create({ ...createReceiptDocument(trip.id, owner.uid, receiptId, 'image/jpeg', now),
    status: 'ready', version: 3, processedPath: path, processedGeneration: object.generation,
    stagingGeneration: '1', bytes: bytes.length, width: 4, height: 3, processingAttemptId: attempt,
    processingOperationKey: randomUUID(), processingRequestHash: sha256('synthetic-processing'), processingBaseVersion: 1 });
  const expenseBody = { title: 'Synthetic shared expense', category: 'food', amountMinor: 120000,
    payerParticipantId: trip.ownerParticipantId, occurredOn: '2026-11-20', note: 'Private synthetic receipt note',
    splitMethod: 'equal', split: { participantIds: [trip.ownerParticipantId] }, receiptIds: [receiptId] };
  const expenseKey = randomUUID(), expense = await ok('POST', root + '/expenses', owner, expenseBody, undefined, expenseKey);
  const voided = await ok('POST', root + '/expenses', owner, { ...expenseBody, title: 'Synthetic voided expense', receiptIds: [], amountMinor: 10000 });
  await ok('POST', root + '/expenses/' + voided.id + '/void', owner, { reason: 'Synthetic reversal before backup' }, voided.version);
  let overview = await ok('GET', root + '/overview', owner);
  const settled = await ok('POST', root + '/settlements', member, { fromParticipantId: joined.participantId, toParticipantId: trip.ownerParticipantId,
    amountMinor: 20000, occurredOn: '2026-11-20', note: null, basedOnLedgerVersion: overview.trip.ledgerVersion });
  await ok('POST', root + '/settlements/' + settled.id + '/confirm', owner, { basedOnLedgerVersion: overview.trip.ledgerVersion }, settled.version);
  overview = await ok('GET', root + '/overview', owner);
  await ok('POST', root + '/settlements', member, { fromParticipantId: joined.participantId, toParticipantId: trip.ownerParticipantId,
    amountMinor: 3000, occurredOn: '2026-11-20', note: null, basedOnLedgerVersion: overview.trip.ledgerVersion });
  await ok('POST', root + '/itinerary', owner, { action: 'add-activity', title: 'Synthetic itinerary', day: '2026-11-20', time: '09:00', place: 'Local', note: '' }, 1);
  const ticket = await ok('POST', '/api/v1/support-tickets', owner, { category: 'balance', message: 'Synthetic restore ticket', tripId: trip.id });
  await db().doc('platformAdmins/' + operator.uid).create({ uid: operator.uid, role: 'platform_admin', status: 'active', version: 1, grantedBy: 'synthetic-rehearsal', grantedAt: now });
  const adminTicket = await ok('GET', '/api/admin/v1/support/' + ticket.id, operator);
  await ok('POST', `/api/admin/v1/support/${ticket.id}/notes`, operator, { note: 'Private synthetic internal note' }, adminTicket.version);
  await checker(trip.id);
  const inventory = await firestoreInventory(db()), users = await authInventory();
  await save('fixture.json', { projectId, trip, memberId: joined.participantId, owner, member, outsider, disabled, operator, ticketId: ticket.id,
    receipt: { id: receiptId, path, generation: object.generation, digest: sha256(bytes) },
    expense: { id: expense.id, key: expenseKey, body: expenseBody }, overview: await ok('GET', root + '/overview', owner),
    inventory, users, checkpointAt: Date.now() });
}

async function verify(projectId: string) {
  const state = await json('fixture.json');
  requireEvidence(state.projectId === projectId, 'RESTORE_STATE_SCOPE_MISMATCH');
  const inventory = await firestoreInventory(db()), users = await authInventory();
  requireEvidence(canonical(inventory) === canonical(state.inventory), 'RESTORE_DOCUMENT_INVENTORY_MISMATCH');
  requireEvidence(canonical(users) === canonical(state.users), 'RESTORE_AUTH_INVENTORY_MISMATCH');
  const owner = await login(state.owner), member = await login(state.member), outsider = await login(state.outsider);
  const operator = await googleLogin(state.operator);
  await ok('GET', '/api/admin/v1/me', operator);
  const adminTicket = await ok('GET', '/api/admin/v1/support/' + state.ticketId, operator);
  requireEvidence(adminTicket.notes.some((note: { note: string }) => note.note === 'Private synthetic internal note'), 'RESTORE_ADMIN_NOTES_FAILED');
  const userTicket = await ok('GET', '/api/v1/support-tickets/' + state.ticketId, owner);
  requireEvidence(!JSON.stringify(userTicket).includes('Private synthetic internal note'), 'RESTORE_PRIVATE_NOTES_LEAKED');
  const disabled = await send('POST', '/api/v1/auth/login', undefined, { email: state.disabled.email, password: state.disabled.password });
  requireEvidence(disabled.statusCode >= 400, 'RESTORE_DISABLED_ACCOUNT_LOST');
  const root = '/api/v1/trips/' + state.trip.id;
  await checker(state.trip.id);
  const overview = await ok('GET', root + '/overview', owner);
  requireEvidence(canonical(overview) === canonical(state.overview), 'RESTORE_LEDGER_MISMATCH');
  requireEvidence((await send('GET', root + '/overview', outsider)).statusCode === 404, 'RESTORE_ACCESS_GUARD_FAILED');
  requireEvidence((await send('GET', '/api/admin/v1/system', owner)).statusCode === 403, 'RESTORE_GOOGLE_GUARD_FAILED');
  const replay = await send('POST', root + '/expenses', owner, state.expense.body, undefined, state.expense.key);
  requireEvidence(replay.statusCode < 300 && replay.headers['idempotency-replayed'] === 'true' && replay.json().data.id === state.expense.id, 'RESTORE_OPERATION_REPLAY_FAILED');
  const memberOverview = await ok('GET', root + '/overview', member);
  requireEvidence(memberOverview.balances.find((row: { participantId: string }) => row.participantId === state.memberId)?.netMinor === -40000, 'RESTORE_MEMBER_BALANCE_FAILED');
  const receipt = await db().doc(`trips/${state.trip.id}/receipts/${state.receipt.id}`).get();
  requireEvidence(receipt.get('attachedExpenseId') === state.expense.id && receipt.get('processedGeneration') === state.receipt.generation, 'RESTORE_RECEIPT_REFERENCE_FAILED');
  const [image] = await receiptBucket().file(state.receipt.path, { generation: state.receipt.generation }).download();
  requireEvidence(sha256(image) === state.receipt.digest, 'RESTORE_RECEIPT_BYTES_FAILED');
  const firestoreClient = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${projectId}/databases/(default)/documents/trips/${state.trip.id}`,
    { headers: { authorization: 'Bearer ' + owner.accessToken }, signal: AbortSignal.timeout(10000) });
  const storageClient = await fetch(`http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}/v0/b/${projectId}.appspot.com/o/${encodeURIComponent(state.receipt.path)}?alt=media`,
    { headers: { authorization: 'Bearer ' + owner.accessToken }, signal: AbortSignal.timeout(10000) });
  requireEvidence(firestoreClient.status === 403 && storageClient.status === 403, 'RESTORE_RULES_FAILED');
  requireEvidence(canonical(await firestoreInventory(db())) === canonical(inventory), 'RESTORE_REPLAY_MUTATED_DATA');
  // Repair is exercised only after the untouched restored copy has passed inventory, access and byte checks.
  const trip = db().doc('trips/' + state.trip.id), now = Timestamp.now();
  await trip.update({ moderationStatus: 'suspended', moderationVersion: 2, revision: overview.trip.revision + 1, updatedAt: now });
  await trip.collection('balances').doc(state.memberId).update({ netMinor: 12345 });
  const dirty = await checkDatabase(db(), { tripId: state.trip.id, pageSize: 5 });
  requireEvidence(dirty.summary.issueCount > 0, 'RESTORE_REPAIR_FIXTURE_FAILED');
  const scope = { projectId }, plan = await prepareProjectionRepair(scope, state.trip.id);
  await save('repair-plan.json', plan);
  const repaired = await applyProjectionRepair(scope, plan, operator.uid, 'Isolated restore rehearsal correction');
  requireEvidence(repaired.changedDocuments > 0, 'RESTORE_REPAIR_FAILED');
  await checker(state.trip.id);
  const after = await ok('GET', root + '/overview', owner);
  requireEvidence(after.balances.every((row: { participantId: string; netMinor: number }) =>
    overview.balances.some((expected: { participantId: string; netMinor: number }) => expected.participantId === row.participantId && expected.netMinor === row.netMinor)), 'RESTORE_REPAIR_MONEY_CHANGED');
  await save('verified.json', { counts: { firestoreDocuments: inventory.documents, authUsers: users.users, receiptObjects: 1, trips: 1 },
    checks: { documentInventory: true, authInventory: true, passwordLogin: true, disabledAccount: true, ledger: true,
      memberAccess: true, outsiderDenied: true, googleGuard: true, operationReplay: true, receiptReference: true,
      receiptGeneration: true, receiptBytes: true, firestoreRules: true, storageRules: true, projectionRepair: true,
      googleLogin: true, adminAccess: true, internalNotesPrivate: true },
    checkerIssues: 0, lostFixtureWrites: 0 });
}

try {
  requireEvidence(directory && resolve(process.cwd()) === resolve(directory), 'RESTORE_PHASE_DIRECTORY_REQUIRED');
  const context = await json('context.json'), phase = process.env.SHAREBILL_RESTORE_PHASE;
  requireEvidence(/^demo-sb-restore-[a-f0-9]{12}$/.test(context.projectId) && process.env.FIREBASE_PROJECT_ID === context.projectId, 'RESTORE_SYNTHETIC_PROJECT_REQUIRED');
  requireEvidence(phase === 'seed' || phase === 'verify', 'RESTORE_PHASE_REQUIRED');
  const offset = phase === 'seed' ? 0 : 6;
  for (const [index, key] of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST'].entries()) {
    requireEvidence(process.env[key] === '127.0.0.1:' + context.ports[offset + index], 'RESTORE_EMULATOR_SCOPE_MISMATCH');
  }
  app = await buildApp(Fastify({ logger: false }));
  if (phase === 'seed') await seed(context.projectId);
  else await verify(context.projectId);
} catch (error) {
  process.stderr.write((error instanceof RestoreRehearsalError ? error.code : 'RESTORE_PHASE_FAILED') + '\n');
  process.exitCode = 2;
} finally {
  await app?.close();
  await Promise.all(getApps().map(app => deleteApp(app)));
}
