import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { deleteApp, getApps } from 'firebase-admin/app';
import { auth, db } from '../src/firebase.js';
import { drainAdminAuthJobs, reconcileAdminAuth } from '../src/services/admin-auth-jobs.js';

try {
  const { values } = parseArgs({ options: { project: { type: 'string' }, limit: { type: 'string', default: '25' } } });
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (!values.project || process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== values.project ||
    values.project.startsWith('demo-') && !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Invalid project/environment');
  process.env.FIREBASE_PROJECT_ID = values.project;
  const limit = Number(values.limit), store = db(), gateway = auth();
  const jobs = await drainAdminAuthJobs(store, gateway, limit);
  const reconciliation = await reconcileAdminAuth(store, gateway, limit);
  process.stdout.write(JSON.stringify({ ...jobs, reconciliation }) + '\n');
  if (reconciliation.errors) process.exitCode = 1;
} catch {
  process.stderr.write('Auth worker failed. Check project, credentials and job indexes.\n');
  process.exitCode = 1;
} finally { await Promise.all(getApps().map(app => deleteApp(app))); }
