import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { deleteApp, getApps } from 'firebase-admin/app';
import { db } from '../src/firebase.js';
import { usersMigration } from '../src/database/migrations/001-users.js';
import { tripsMigration, linksMigration } from '../src/database/migrations/002-trips-links.js';
import { ledgerMigration } from '../src/database/migrations/003-ledger.js';
import { projectionsMigration } from '../src/database/migrations/004-projection-metadata.js';
import { operationsMigration } from '../src/database/migrations/005-operations.js';
import { auditBaselineMigration } from '../src/database/migrations/006-audit-baseline.js';
import { runMigration } from '../src/database/migrations/runner.js';

const migrations = [usersMigration, tripsMigration, linksMigration, ledgerMigration,
  projectionsMigration, operationsMigration, auditBaselineMigration];
const usage = 'Usage: db:migrate --project <firebase-project-id> [--migration <DBM-ID|all>] [--page-size 1-100] [--max-documents N] [--apply]';
class UsageError extends Error {}

function options() {
  let values;
  try { values = parseArgs({ options: {
    project: { type: 'string' }, migration: { type: 'string', default: 'all' },
    'page-size': { type: 'string', default: '100' }, 'max-documents': { type: 'string' },
    apply: { type: 'boolean' }, help: { type: 'boolean' },
  } }).values; }
  catch { throw new UsageError('Invalid arguments.'); }
  if (values.help) return null;
  if (!values.project || !/^[a-z][a-z0-9-]*[a-z0-9]$/.test(values.project)) throw new UsageError('Supply a Firebase project ID with --project.');
  if (values.migration !== 'all' && !migrations.some(migration => migration.id === values.migration)) throw new UsageError('Unknown migration ID.');
  const pageSize = Number(values['page-size']);
  if (!/^\d+$/.test(values['page-size']) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new UsageError('Invalid page size.');
  const maxDocuments = values['max-documents'] === undefined ? undefined : Number(values['max-documents']);
  if (values['max-documents'] !== undefined && (!/^\d+$/.test(values['max-documents']) || !Number.isSafeInteger(maxDocuments) || maxDocuments! < 1)) {
    throw new UsageError('Invalid document limit.');
  }
  return { projectId: values.project, migrationId: values.migration, apply: values.apply ?? false, pageSize, maxDocuments };
}

try {
  const scope = options();
  if (!scope) process.stdout.write(`${usage}\n`);
  else {
    if (existsSync('.env')) process.loadEnvFile('.env');
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== scope.projectId) throw new UsageError('--project must match FIREBASE_PROJECT_ID.');
    if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      throw new UsageError('S05 migrations currently require local Auth and Firestore Emulators.');
    }
    process.env.FIREBASE_PROJECT_ID = scope.projectId;
    const selected = scope.migrationId === 'all' ? migrations : migrations.filter(migration => migration.id === scope.migrationId);
    const reports = [];
    for (const migration of selected) {
      const report = await runMigration(db(), migration, scope);
      reports.push(report);
      if (scope.apply && (report.failed || !report.completed)) break;
    }
    process.stdout.write(`${JSON.stringify({ projectId: scope.projectId, target: 'emulator', apply: scope.apply, reports }, null, 2)}\n`);
    process.exitCode = reports.some(report => report.failed) ? 1 : 0;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed.'}\n${usage}\n`);
  process.exitCode = 2;
} finally { await Promise.all(getApps().map(app => deleteApp(app))); }
