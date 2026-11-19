import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { indexSmokeConfig, runIndexSmoke } from './firestore-index-smoke.mjs';

const inventoryText = await readFile(new URL('../be/firestore.indexes.json', import.meta.url), 'utf8');
const inventory = JSON.parse(inventoryText).indexes;
const config = indexSmokeConfig(['--project', 'sharebill-staging', '--trip', '9f95cf70-c193-446b-8cb9-3e46b4c6eb71', '--uid', 'synthetic-fixture'], {});
const actual = inventory.map((index, i) => ({ ...index, name: 'projects/sharebill-staging/databases/(default)/collectionGroups/' + index.collectionGroup + '/indexes/' + i,
  state: 'READY', fields: [...index.fields, { fieldPath: '__name__', order: index.fields.at(-1).order }] }));

test('checks all 18 indexes including pending participant links, then runs only bounded name projections', async () => {
  let queries = 0;
  const report = await runIndexSmoke(config, { accessToken: 'synthetic-secret', inventoryText, fetcher: async (url, options) => {
    if (!options.body) return Response.json({ indexes: actual });
    queries++;
    const query = JSON.parse(options.body).structuredQuery;
    assert.equal(query.limit, 1);
    assert.deepEqual(query.select, { fields: [{ fieldPath: '__name__' }] });
    assert.ok(url.includes(':runQuery'));
    assert.ok(['GET', 'POST'].includes(options.method));
    if (query.from[0].collectionId === 'receipts') assert.equal(query.from[0].allDescendants, true);
    return Response.json([{ readTime: '2026-11-19T00:00:00Z', document: { name: 'private-document-name' } }]);
  } });
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, 18);
  assert.equal(queries, 18);
  assert.equal(JSON.stringify(report).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(report).includes('private-document-name'), false);
});

test('missing, building and wrong document-id ordering stop before any document query', async () => {
  for (const indexes of [actual.slice(0, -1), actual.map((x, i) => i ? x : { ...x, state: 'CREATING' }),
    actual.map((x, i) => i ? x : { ...x, fields: x.fields.map(f => f.fieldPath === '__name__' ? { ...f, order: 'ASCENDING' } : f) })]) {
    let calls = 0;
    const report = await runIndexSmoke(config, { accessToken: 'fixture', inventoryText, fetcher: async () => { calls++; return Response.json({ indexes }); } });
    assert.equal(report.passed, false);
    assert.equal(report.failure, 'INDEXES_NOT_READY');
    assert.equal(calls, 1);
    assert.equal(report.queriesExecuted, 0);
  }
});

test('reads index inventory pagination and reports permission failures without upstream messages', async () => {
  let page = 0;
  const report = await runIndexSmoke(config, { accessToken: 'fixture', inventoryText, fetcher: async (_url, options) => {
    if (options.body) return Response.json({ error: { message: 'do-not-print' } }, { status: 403 });
    return Response.json(page++ ? { indexes: actual.slice(8) } : { indexes: actual.slice(0, 8), nextPageToken: 'next' });
  } });
  assert.equal(page, 2);
  assert.equal(report.failure, 'HTTP_403');
  assert.equal(JSON.stringify(report).includes('do-not-print'), false);
});

test('cloud index CLI rejects demo targets, path injection, wrong projects and any Emulator host', () => {
  const args = ['--project', 'sharebill-staging', '--trip', config.tripId, '--uid', config.uid];
  for (const [key, value] of [['project', 'demo-sharebill'], ['trip', '../trips'], ['uid', '../private']]) {
    const next = [...args]; next[next.indexOf('--' + key) + 1] = value;
    assert.throws(() => indexSmokeConfig(next, {}));
  }
  assert.throws(() => indexSmokeConfig(args, { FIREBASE_PROJECT_ID: 'other-project' }));
  assert.throws(() => indexSmokeConfig(args, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }));
});
