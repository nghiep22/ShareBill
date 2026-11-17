import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { deleteApp, getApps } from 'firebase-admin/app';
import { checkDatabase } from '../src/database/check-integrity.js';
import { entityId } from '../src/database/integrity-schemas.js';
import { db } from '../src/firebase.js';

const usage = 'Usage: db:check --project <firebase-project-id> [--trip <uuid>] [--page-size <1-100>]';

class UsageError extends Error {}

function options() {
  let args;
  try {
    args = parseArgs({ options: {
      project: { type: 'string' }, trip: { type: 'string' }, 'page-size': { type: 'string', default: '100' }, help: { type: 'boolean' },
    } }).values;
  } catch {
    throw new UsageError('Invalid arguments.');
  }
  if (args.help) return null;
  if (!args.project || !/^[a-z][a-z0-9-]*[a-z0-9]$/.test(args.project)) throw new UsageError('Supply a Firebase project ID with --project.');
  if (args.trip !== undefined && !entityId.safeParse(args.trip).success) throw new UsageError('--trip must be a UUID.');
  const pageSize = Number(args['page-size']);
  if (!/^\d+$/.test(args['page-size']) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new UsageError('--page-size must be an integer from 1 to 100.');
  }
  return { projectId: args.project, tripId: args.trip, pageSize };
}

try {
  const scope = options();
  if (!scope) process.stdout.write(`${usage}\n`);
  else {
    if (existsSync('.env')) process.loadEnvFile('.env');
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== scope.projectId) {
      throw new UsageError('--project must match the configured FIREBASE_PROJECT_ID.');
    }
    const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
    if (scope.projectId.startsWith('demo-') && !emulator) throw new UsageError('A demo project requires FIRESTORE_EMULATOR_HOST.');
    process.env.FIREBASE_PROJECT_ID = scope.projectId;
    const report = await checkDatabase(db(), scope);
    process.stdout.write(`${JSON.stringify({ projectId: scope.projectId, tripId: scope.tripId ?? null,
      target: emulator ? 'emulator' : 'cloud', ...report }, null, 2)}\n`);
    process.exitCode = report.summary.issueCount ? 1 : 0;
  }
} catch (error) {
  const detail = error instanceof UsageError ? `${error.message}\n${usage}` : 'Database check failed. Verify the Firestore endpoint and read credentials.';
  process.stderr.write(`${detail}\n`);
  process.exitCode = 2;
} finally {
  await Promise.all(getApps().map(app => deleteApp(app)));
}
