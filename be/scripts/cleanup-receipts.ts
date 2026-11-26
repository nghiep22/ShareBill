import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { deleteApp, getApps } from 'firebase-admin/app';
import { db } from '../src/firebase.js';
import { cleanupReceipts } from '../src/services/receipt-cleanup.js';
import { CloudReceiptStorage } from '../src/services/receipt-storage.js';

try {
  const { values } = parseArgs({ options: { project: { type: 'string' }, apply: { type: 'boolean', default: false },
    limit: { type: 'string', default: '25' }, resume: { type: 'string' }, trip: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) process.stdout.write('receipts:cleanup --project <project-id> [--apply] [--limit 1..100] [--trip <uuid>] [--resume <job-uuid>]\n');
  else {
    if (existsSync('.env')) process.loadEnvFile('.env');
    if (!values.project || !/^[a-z][a-z0-9-]+$/.test(values.project) ||
        process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== values.project ||
        values.project.startsWith('demo-') && !process.env.FIRESTORE_EMULATOR_HOST || values.resume && !values.apply) {
      throw new Error('Project/environment mismatch or invalid arguments');
    }
    process.env.FIREBASE_PROJECT_ID = values.project;
    const report = await cleanupReceipts(db(), new CloudReceiptStorage(), { apply: values.apply,
      limit: Number(values.limit), jobId: values.resume, tripId: values.trip });
    process.stdout.write(`${JSON.stringify({ projectId: values.project, ...report }, null, 2)}\n`);
    process.exitCode = report.errors.length || report.failedPaths.length ? 1 : 0;
  }
} catch {
  process.stderr.write('Receipt cleanup failed. Check project, Storage configuration, arguments and job lease.\n');
  process.exitCode = 2;
} finally { await Promise.all(getApps().map(app => deleteApp(app))); }
