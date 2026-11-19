import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smokeConfig, runSmoke } from './smoke.mjs';

const commit = 'a'.repeat(40);
const args = ['--api-url', 'https://api.example.test', '--web-url', 'https://web.example.test',
  '--environment', 'staging', '--project', 'sharebill-staging', '--commit', commit];
const config = smokeConfig(args);
const release = { environment: 'staging', commit, firebaseProjectId: 'sharebill-staging' };

function fixture(override = () => undefined) {
  const calls = [];
  return { calls, fetcher: async (url, options) => {
    const call = { url, ...options };
    calls.push(call);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    const replacement = override(call);
    if (replacement) return replacement;
    const path = new URL(url).pathname;
    const json = body => Response.json(body, { headers: { 'cache-control': 'private, no-store' } });
    if (path === '/health') return json({ status: 'ok', service: 'sharebill-be', release });
    if (path === '/release.json') return json({ service: 'sharebill-web', release, apiOrigin: config.apiOrigin });
    if (path === '/' || path === '/admin') return new Response('<html><body>ShareBill</body></html>', { headers: { 'content-type': 'text/html' } });
    if (options.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      'access-control-allow-origin': config.webOrigin,
      'access-control-allow-headers': 'authorization,content-type,idempotency-key,if-match',
      'access-control-allow-methods': 'GET,POST,PATCH',
    } });
    if (path.endsWith('/me')) return Response.json({ error: { code: 'UNAUTHENTICATED' } }, {
      status: 401, headers: { 'cache-control': 'private, no-store' },
    });
    throw new Error('Unexpected fixture request');
  } };
}

test('read-only smoke checks both releases, CORS methods and auth guards without credentials or writes', async () => {
  const fake = fixture();
  const report = await runSmoke(config, fake);
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, 5);
  assert.ok(fake.calls.every(call => !call.method || call.method === 'OPTIONS'));
  assert.deepEqual(report.commands, []);
  assert.equal(report.tripId, null);
});

test('an exercise is stopped before login or writes when the deployed SHA or project differs', async () => {
  for (const patch of [{ commit: 'b'.repeat(40) }, { firebaseProjectId: 'another-project' }, { environment: 'production' }]) {
    const fake = fixture(call => call.url.endsWith('/health') && Response.json({ status: 'ok', service: 'sharebill-be', release: { ...release, ...patch } }));
    const report = await runSmoke({ ...config, exercise: true }, { ...fake, env: { SMOKE_EMAIL: 'fixture@example.test', SMOKE_PASSWORD: 'Never-print-this' } });
    assert.equal(report.passed, false);
    assert.equal(report.failure, 'RELEASE_MISMATCH');
    assert.equal(fake.calls.length, 1);
  }
});

test('a web build pointing to a different API fails before authentication', async () => {
  const fake = fixture(call => call.url.endsWith('/release.json') && Response.json({ service: 'sharebill-web', release, apiOrigin: 'https://other-api.example.test' }));
  const report = await runSmoke({ ...config, exercise: true }, fake);
  assert.equal(report.failure, 'WEB_API_MISMATCH');
  assert.equal(fake.calls.length, 2);
});

test('CORS must allow If-Match and PATCH and the auth/admin guards must return 401', async () => {
  for (const kind of ['headers', 'methods', 'guard']) {
    const fake = fixture(call => {
      if (kind === 'guard' && call.url.endsWith('/api/admin/v1/me')) return Response.json({ data: { role: 'platform_admin' } });
      if (kind !== 'guard' && call.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
        'access-control-allow-origin': config.webOrigin,
        'access-control-allow-headers': kind === 'headers' ? 'authorization,content-type' : 'authorization,content-type,idempotency-key,if-match',
        'access-control-allow-methods': kind === 'methods' ? 'GET,POST' : 'GET,POST,PATCH',
      } });
    });
    assert.equal((await runSmoke(config, fake)).passed, false);
  }
});

test('upstream errors, credentials and response payloads are not copied to reports', async () => {
  const secret = 'sensitive-password-or-token';
  const fake = fixture(call => {
    if (call.url.endsWith('/api/v1/auth/login')) throw new Error(secret);
  });
  const report = await runSmoke({ ...config, exercise: true }, { ...fake, env: { SMOKE_EMAIL: 'fixture@example.test', SMOKE_PASSWORD: secret } });
  assert.equal(report.failure, 'NETWORK_TIMEOUT_OR_REDIRECT');
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(JSON.stringify(report).includes('fixture@example.test'), false);
  const missing = await runSmoke({ ...config, exercise: true }, { ...fixture(), env: {} });
  assert.equal(missing.failure, 'SMOKE_CREDENTIALS_REQUIRED');
});

test('arguments reject ambiguous environments, short SHAs, credentials, remote HTTP and mixed demo/cloud projects', () => {
  function replace(name, value) { const copy = [...args]; copy[copy.indexOf('--' + name) + 1] = value; return copy; }
  for (const [name, value] of [
    ['commit', 'abc1234'], ['environment', 'preview'], ['project', 'demo-sharebill'],
    ['api-url', 'http://api.example.test'], ['api-url', 'https://user:password@api.example.test'],
    ['api-url', 'https://api.example.test/api'], ['web-url', 'https://web.example.test/?token=private'],
    ['api-url', 'https://localhost:3001'], ['api-url', 'https://127.0.0.1:3001'],
  ]) assert.throws(() => smokeConfig(replace(name, value)), name);
  assert.throws(() => smokeConfig([...args, '--unknown']));
  const local = smokeConfig(['--api-url', 'http://localhost:3001', '--web-url', 'http://localhost:3000',
    '--environment', 'local', '--project', 'demo-sharebill', '--commit', commit]);
  assert.equal(local.exercise, false);
});
