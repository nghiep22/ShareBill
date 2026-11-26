import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const usage = `Usage: pnpm smoke --api-url <origin> --web-url <origin> --environment <local|staging|production> --project <firebase-id> --commit <full-sha> [--exercise] [--report <file>]
Read-only by default. --exercise uses SMOKE_EMAIL and SMOKE_PASSWORD to create and archive a separate synthetic trip. No account is registered or deleted.`;

class SmokeError extends Error {}

function ensure(condition, code) {
  if (!condition) throw new SmokeError(code);
}

function origin(value, environment) {
  let url;
  try { url = new URL(value); } catch { throw new SmokeError('INVALID_ORIGIN'); }
  ensure(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'INVALID_ORIGIN');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  ensure(environment === 'local' ? local && ['http:', 'https:'].includes(url.protocol) : !local && url.protocol === 'https:', 'INVALID_ORIGIN');
  return url.origin;
}

export function smokeConfig(args) {
  const { values } = parseArgs({ args, strict: true, options: {
    'api-url': { type: 'string' }, 'web-url': { type: 'string' }, environment: { type: 'string' },
    project: { type: 'string' }, commit: { type: 'string' }, exercise: { type: 'boolean', default: false },
    report: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) return { help: true };
  ensure(['local', 'staging', 'production'].includes(values.environment), 'INVALID_ENVIRONMENT');
  ensure(/^[a-f0-9]{40}$/i.test(values.commit ?? ''), 'FULL_COMMIT_REQUIRED');
  ensure(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(values.project ?? ''), 'PROJECT_REQUIRED');
  ensure(values.environment === 'local' ? values.project.startsWith('demo-') : !values.project.startsWith('demo-'), 'PROJECT_ENVIRONMENT_MISMATCH');
  return { environment: values.environment, commit: values.commit.toLowerCase(), firebaseProjectId: values.project,
    apiOrigin: origin(values['api-url'], values.environment), webOrigin: origin(values['web-url'], values.environment),
    exercise: values.exercise, reportPath: values.report };
}

/** Only allowlisted metadata is reported. Never include response bodies, tokens, passwords or upstream errors. */
export async function runSmoke(config, { env = process.env, fetcher = fetch } = {}) {
  const report = {
    startedAt: new Date().toISOString(), environment: config.environment, commit: config.commit,
    firebaseProjectId: config.firebaseProjectId, apiOrigin: config.apiOrigin, webOrigin: config.webOrigin,
    mode: config.exercise ? 'exercise' : 'read-only', passed: false, checks: [], commands: [], tripId: null,
    coverage: ['release identity', 'web and admin shell', 'CORS', 'unauthenticated guards'],
    remaining: ['real browser/device acceptance', 'Google operator allow journey', 'receipt bucket signing/CORS/expiry', 'complete cloud index inventory', 'backup/restore/worker schedules'],
  };
  let session;
  async function check(name, work) {
    const item = { name, passed: false };
    report.checks.push(item);
    await work();
    item.passed = true;
  }
  async function send(base, path, options = {}) {
    try {
      return await fetcher(base + path, { ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    } catch { throw new SmokeError('NETWORK_TIMEOUT_OR_REDIRECT'); }
  }
  async function json(response, status = 200) {
    ensure(response.status === status, 'UNEXPECTED_HTTP_STATUS');
    try { return await response.json(); } catch { throw new SmokeError('INVALID_JSON'); }
  }
  function sameRelease(value) {
    ensure(value?.environment === config.environment && value?.commit?.toLowerCase() === config.commit &&
      value?.firebaseProjectId === config.firebaseProjectId, 'RELEASE_MISMATCH');
  }
  async function api(path, options = {}, status = 200) {
    const response = await send(config.apiOrigin, '/api/v1' + path, {
      ...options, headers: { ...(session && { authorization: 'Bearer ' + session.accessToken }), ...options.headers },
    });
    ensure(response.headers.get('cache-control')?.includes('no-store'), 'PRIVATE_RESPONSE_CACHEABLE');
    const body = await json(response, status);
    ensure(body.data !== undefined, 'MISSING_DATA');
    return body.data;
  }
  async function command(path, body, { key = randomUUID(), version } = {}) {
    const entry = { path, key, confirmed: false };
    report.commands.push(entry);
    const data = await api(path, { method: 'POST', body: JSON.stringify(body), headers: {
      'content-type': 'application/json', 'idempotency-key': key,
      ...(version === undefined ? {} : { 'if-match': '"' + version + '"' }),
    } });
    entry.confirmed = true;
    return data;
  }
  try {
    await check('api-release', async () => {
      const health = await json(await send(config.apiOrigin, '/health'));
      ensure(health.status === 'ok' && health.service === 'sharebill-be', 'INVALID_HEALTH');
      sameRelease(health.release);
    });
    await check('web-release', async () => {
      const web = await json(await send(config.webOrigin, '/release.json'));
      ensure(web.service === 'sharebill-web' && web.apiOrigin === config.apiOrigin, 'WEB_API_MISMATCH');
      sameRelease(web.release);
    });
    await check('web-admin-shell', async () => {
      for (const path of ['/', '/admin']) {
        const response = await send(config.webOrigin, path);
        ensure(response.status === 200 && response.headers.get('content-type')?.includes('text/html'), 'WEB_SHELL_UNAVAILABLE');
        ensure((await response.text()).toLowerCase().includes('<html'), 'INVALID_WEB_SHELL');
      }
    });
    await check('cors-versioned-commands', async () => {
      for (const method of ['POST', 'PATCH']) {
        const response = await send(config.apiOrigin, '/api/v1/trips', { method: 'OPTIONS', headers: {
          origin: config.webOrigin, 'access-control-request-method': method,
          'access-control-request-headers': 'authorization,content-type,idempotency-key,if-match',
        } });
        ensure(response.status === 204 && response.headers.get('access-control-allow-origin') === config.webOrigin, 'CORS_ORIGIN_REJECTED');
        const allowed = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(',').map(x => x.trim());
        ensure(['authorization', 'content-type', 'idempotency-key', 'if-match'].every(x => allowed.includes(x)), 'CORS_HEADERS_REJECTED');
        ensure((response.headers.get('access-control-allow-methods') ?? '').split(',').map(x => x.trim()).includes(method), 'CORS_METHOD_REJECTED');
      }
    });
    await check('unauthenticated-guards', async () => {
      for (const path of ['/api/v1/me', '/api/admin/v1/me']) {
        const response = await send(config.apiOrigin, path);
        const body = await json(response, 401);
        ensure(body.error?.code === 'UNAUTHENTICATED', 'INVALID_AUTH_GUARD');
        ensure(response.headers.get('cache-control')?.includes('no-store'), 'PRIVATE_RESPONSE_CACHEABLE');
      }
    });
    if (config.exercise) {
      ensure(env.SMOKE_EMAIL && env.SMOKE_PASSWORD, 'SMOKE_CREDENTIALS_REQUIRED');
      report.coverage.push('login/refresh', 'member denied admin', 'expense/replay/operation lookup', 'expense cursor', 'settlement/archive');
      await check('login-refresh-admin-deny', async () => {
        session = await api('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: env.SMOKE_EMAIL, password: env.SMOKE_PASSWORD }) });
        ensure(session.accessToken && session.refreshToken && session.user?.uid, 'INVALID_SESSION');
        const uid = session.user.uid;
        session = await api('/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }) });
        ensure(session.user?.uid === uid && session.accessToken, 'REFRESH_IDENTITY_MISMATCH');
        const denied = await json(await send(config.apiOrigin, '/api/admin/v1/me', {
          headers: { authorization: 'Bearer ' + session.accessToken },
        }), 403);
        ensure(denied.error?.code === 'ADMIN_FORBIDDEN', 'MEMBER_ADMIN_GUARD_FAILED');
      });
      let trip, peer, expense, expenseBody, expenseKey;
      const day = new Date().toISOString().slice(0, 10);
      await check('create-isolated-trip', async () => {
        trip = await command('/trips', { name: 'SMOKE ' + randomUUID(), sharingMode: 'per-expense', ownerName: 'Smoke owner', timezone: 'UTC' });
        ensure(trip.id && trip.ownerParticipantId, 'INVALID_TRIP');
        report.tripId = trip.id;
        peer = await command('/trips/' + trip.id + '/participants', { displayName: 'Smoke participant' });
      });
      const path = '/trips/' + trip.id;
      await check('expense-replay-and-ledger', async () => {
        expenseKey = randomUUID();
        expenseBody = { title: 'Synthetic smoke expense', amountMinor: 100000, payerParticipantId: trip.ownerParticipantId,
          occurredOn: day, category: 'other', splitMethod: 'equal', split: { participantIds: [trip.ownerParticipantId, peer.id] } };
        expense = await command(path + '/expenses', expenseBody, { key: expenseKey });
        const replay = await command(path + '/expenses', expenseBody, { key: expenseKey });
        ensure(expense.id && replay.id === expense.id, 'REPLAY_DUPLICATED');
        const op = await api('/operations/' + expenseKey);
        ensure(op.resourceId === expense.id && op.tripId === trip.id, 'OPERATION_LOOKUP_MISMATCH');
        await command(path + '/expenses', { ...expenseBody, title: 'Synthetic cursor fixture', amountMinor: 1,
          split: { participantIds: [trip.ownerParticipantId] } });
        const overview = await api(path + '/overview');
        const balance = id => overview.balances.find(row => row.participantId === id);
        ensure(overview.trip.totalExpenseMinor === 100001 && overview.trip.activeExpenseCount === 2 &&
          overview.ledgerVersion === 2 && balance(trip.ownerParticipantId)?.netMinor === 50000 && balance(peer.id)?.netMinor === -50000,
        'LEDGER_MISMATCH');
      });
      await check('expense-index-and-cursor', async () => {
        const query = path + '/expenses?status=active&category=other&limit=1';
        const first = await api(query);
        ensure(first.items?.length === 1 && first.nextCursor, 'CURSOR_MISSING');
        const second = await api(query + '&cursor=' + encodeURIComponent(first.nextCursor));
        ensure(second.items?.length === 1 && !second.nextCursor && first.items[0].id !== second.items[0].id &&
          [first.items[0].id, second.items[0].id].includes(expense.id), 'CURSOR_PAGE_MISMATCH');
      });
      await check('settle-and-archive', async () => {
        const suggestions = await api(path + '/settlement-suggestions');
        ensure(suggestions.suggestions?.length === 1, 'SUGGESTION_MISMATCH');
        const pending = await command(path + '/settlements', { fromParticipantId: peer.id, toParticipantId: trip.ownerParticipantId,
          amountMinor: 50000, occurredOn: day, basedOnLedgerVersion: suggestions.ledgerVersion });
        const confirmed = await command(path + '/settlements/' + pending.id + '/confirm',
          { basedOnLedgerVersion: suggestions.ledgerVersion }, { version: pending.version });
        ensure(confirmed.status === 'confirmed', 'CONFIRMATION_FAILED');
        const overview = await api(path + '/overview');
        ensure(overview.balances.length === 2 && overview.balances.every(row => row.netMinor === 0) &&
          overview.trip.pendingSettlementCount === 0, 'SETTLEMENT_NOT_BALANCED');
        const archived = await command(path + '/archive', {}, { version: overview.trip.version });
        ensure(archived.status === 'archived' && (await api(path + '/overview')).trip.status === 'archived', 'ARCHIVE_FAILED');
      });
    }
    report.passed = true;
  } catch (error) {
    report.failure = error instanceof SmokeError ? error.message : 'SMOKE_FAILED';
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

async function main() {
  let config;
  try { config = smokeConfig(process.argv.slice(2)); }
  catch { console.error('Invalid smoke arguments.\n' + usage); process.exitCode = 1; return; }
  if (config.help) { console.log(usage); return; }
  const report = await runSmoke(config);
  const output = JSON.stringify(report, null, 2) + '\n';
  if (config.reportPath) await writeFile(config.reportPath, output, { mode: 0o600 });
  console.log(output);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Unable to write smoke report.'); process.exitCode = 1; });
}
