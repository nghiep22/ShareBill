import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { deleteApp, getApps } from 'firebase-admin/app';
import { db } from '../src/firebase.js';
import { runLedgerReconciliation } from '../src/services/ledger-reconciliation.js';

const usage = 'db:reconcile --project <project-id> [--trip <uuid>] [--limit 1..10] [--page-size 1..100]\nRuns one bounded batch; only maintenanceJobs is written. No repair. Schedule externally.';
try {
  const { values } = parseArgs({ options: { project: { type: 'string' }, trip: { type: 'string' },
    limit: { type: 'string', default: '5' }, 'page-size': { type: 'string', default: '100' }, help: { type: 'boolean' } } });
  if (values.help) process.stdout.write(usage + '\n');
  else {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const project = values.project, emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
    if (!project || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) ||
        process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== project ||
        project.startsWith('demo-') !== emulator || !emulator && Object.entries(process.env).some(([key, value]) => value && /(?:^|_)EMULATOR_HOST$/.test(key)) ||
        !/^\d+$/.test(values.limit) || !/^\d+$/.test(values['page-size'])) throw new Error('Invalid scope');
    process.env.FIREBASE_PROJECT_ID = project;
    const result = await runLedgerReconciliation(db(), { tripId: values.trip, limit: Number(values.limit), pageSize: Number(values['page-size']) });
    process.stdout.write(JSON.stringify({ projectId: project, target: emulator ? 'emulator' : 'cloud', ...result }) + '\n');
    if ('resultSummary' in result && (result.resultSummary?.issueCount || result.resultSummary?.scanErrors)) process.exitCode = 1;
  }
} catch {
  process.stderr.write('Reconciliation failed. Check project, credentials, arguments and job lease.\n' + usage + '\n');
  process.exitCode = 2;
} finally { await Promise.all(getApps().map(app => deleteApp(app))); }
