import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const usage = 'Usage: pnpm smoke:indexes --project <cloud-project> --trip <synthetic-trip-uuid> --uid <synthetic-owner-uid> [--report <file>]\nRequires a short-lived FIRESTORE_SMOKE_ACCESS_TOKEN from the trusted runner. Reads indexes and runs at most one document-name-only query per index; never writes documents.';
const inventoryUrl = new URL('../be/firestore.indexes.json', import.meta.url);

export function indexSmokeConfig(args, env = process.env) {
  const { values } = parseArgs({ args, strict: true, options: {
    project: { type: 'string' }, trip: { type: 'string' }, uid: { type: 'string' },
    report: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return { help: true };
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(values.project ?? '') || values.project.startsWith('demo-')) throw new Error('CLOUD_PROJECT_REQUIRED');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.trip ?? '') ||
      !/^[^/\s]{1,128}$/.test(values.uid ?? '') || values.uid === '.' || values.uid === '..') throw new Error('SYNTHETIC_SCOPE_REQUIRED');
  if (env.FIREBASE_PROJECT_ID && env.FIREBASE_PROJECT_ID !== values.project ||
      Object.entries(env).some(([key, value]) => value && /(?:^|_)EMULATOR_HOST$/.test(key))) throw new Error('PROJECT_ENVIRONMENT_MISMATCH');
  return { projectId: values.project, tripId: values.trip, uid: values.uid, reportPath: values.report };
}

function fields(index) {
  const result = index.fields.map(field => ({ fieldPath: field.fieldPath, order: field.order }));
  if (!result.some(field => field.fieldPath === '__name__')) result.push({ fieldPath: '__name__', order: result.at(-1)?.order });
  return result;
}

function matches(expected, actual) {
  const collectionGroup = actual.name?.match(/\/collectionGroups\/([^/]+)\/indexes\//)?.[1];
  return collectionGroup === expected.collectionGroup && actual.queryScope === expected.queryScope &&
    JSON.stringify(fields(actual)) === JSON.stringify(fields(expected));
}

function probe(index, config) {
  const { collectionGroup } = index;
  const parent = collectionGroup === 'tripRefs' ? '/users/' + encodeURIComponent(config.uid) :
    ['expenses', 'settlements'].includes(collectionGroup) ? '/trips/' + config.tripId : '';
  const values = { status: ['tripRefs', 'expenses', 'users', 'trips'].includes(collectionGroup) ? 'active' :
    collectionGroup === 'receipts' ? 'processing' : collectionGroup === 'supportTickets' ? 'open' : 'pending',
  category: 'other', moderationStatus: 'normal', targetType: 'trip', createdBy: config.uid,
  payerParticipantId: config.tripId };
  const sorted = index.fields.at(-1);
  const filters = index.fields.slice(0, -1).map(field => ({ fieldFilter: {
    field: { fieldPath: field.fieldPath }, op: 'EQUAL', value: { stringValue: values[field.fieldPath] ?? config.tripId },
  } }));
  if (['expiresAt', 'updatedAt', 'processingLeaseUntil', 'availableAt'].includes(sorted.fieldPath)) {
    filters.push({ fieldFilter: { field: { fieldPath: sorted.fieldPath }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: new Date().toISOString() } } });
  }
  return { parent, structuredQuery: {
    select: { fields: [{ fieldPath: '__name__' }] },
    from: [{ collectionId: collectionGroup, ...(index.queryScope === 'COLLECTION_GROUP' ? { allDescendants: true } : {}) }],
    where: filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } },
    orderBy: [{ field: { fieldPath: sorted.fieldPath }, direction: sorted.order },
      { field: { fieldPath: '__name__' }, direction: sorted.order }], limit: 1,
  } };
}

export async function runIndexSmoke(config, { accessToken, fetcher = fetch, inventoryText } = {}) {
  const text = inventoryText ?? await readFile(inventoryUrl, 'utf8');
  const inventory = JSON.parse(text).indexes;
  const report = { projectId: config.projectId, tripId: config.tripId, target: 'cloud', readOnly: true,
    indexConfigSha256: createHash('sha256').update(text).digest('hex'), passed: false,
    startedAt: new Date().toISOString(), checks: [], queriesExecuted: 0 };
  const base = 'https://firestore.googleapis.com/v1/projects/' + config.projectId + '/databases/(default)';
  async function request(path, body) {
    let response;
    try {
      response = await fetcher(base + path, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { authorization: 'Bearer ' + accessToken, ...(body && { 'content-type': 'application/json' }) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    } catch { throw new Error('NETWORK_TIMEOUT_OR_REDIRECT'); }
    // Upstream payloads may contain document data or credential diagnostics. Report only status codes.
    if (!response.ok) throw new Error('HTTP_' + response.status);
    try { return await response.json(); } catch { throw new Error('INVALID_JSON'); }
  }
  try {
    if (!accessToken) throw new Error('ACCESS_TOKEN_REQUIRED');
    const actual = [];
    let pageToken;
    for (let page = 0; page < 10; page++) {
      // The wildcard collection-group endpoint currently accepts only the default page size.
      const result = await request('/collectionGroups/-/indexes' + (pageToken ? '?pageToken=' + encodeURIComponent(pageToken) : ''));
      actual.push(...result.indexes ?? []);
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
    if (pageToken) throw new Error('INDEX_INVENTORY_LIMIT');
    for (const [position, expected] of inventory.entries()) {
      const index = actual.find(item => matches(expected, item));
      report.checks.push({ id: 'IX' + String(position + 1).padStart(2, '0'), collectionGroup: expected.collectionGroup,
        state: !index ? 'MISSING' : index.state === 'READY' ? 'READY' : 'NOT_READY', queried: false });
    }
    if (report.checks.some(check => check.state !== 'READY')) throw new Error('INDEXES_NOT_READY');
    for (const [position, expected] of inventory.entries()) {
      const query = probe(expected, config);
      const result = await request('/documents' + query.parent + ':runQuery', { structuredQuery: query.structuredQuery });
      if (!Array.isArray(result) || result.some(row => row.error)) throw new Error('INVALID_QUERY_RESULT');
      report.queriesExecuted++;
      report.checks[position].queried = true;
    }
    report.passed = true;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    report.failure = /^(ACCESS_TOKEN_REQUIRED|INDEX_INVENTORY_LIMIT|INDEXES_NOT_READY|NETWORK_TIMEOUT_OR_REDIRECT|INVALID_JSON|INVALID_QUERY_RESULT|HTTP_\d{3})$/.test(code) ? code : 'INDEX_SMOKE_FAILED';
  }
  return { ...report, finishedAt: new Date().toISOString() };
}

async function main() {
  let config;
  try { config = indexSmokeConfig(process.argv.slice(2)); }
  catch { console.error('Invalid index smoke arguments.\n' + usage); process.exitCode = 2; return; }
  if (config.help) { console.log(usage); return; }
  const report = await runIndexSmoke(config, { accessToken: process.env.FIRESTORE_SMOKE_ACCESS_TOKEN });
  const result = JSON.stringify(report, null, 2) + '\n';
  if (config.reportPath) await writeFile(config.reportPath, result, { mode: 0o600 });
  console.log(result);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Unable to complete index smoke.'); process.exitCode = 2; });
}
