import { randomUUID } from 'node:crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { auth, db } from '../firebase.js';
import { drainAdminAuthJobs, reconcileAdminAuth } from './admin-auth-jobs.js';
import { runLedgerReconciliation } from './ledger-reconciliation.js';

const count = z.number().int().nonnegative().safe();
const summarySchema = z.strictObject({ authScanned: count.nullable(), authQueued: count.nullable(), authProcessed: count.nullable(),
  authErrors: count, ledgerProcessed: count.nullable(), ledgerIssues: count, ledgerScanErrors: count,
  ledgerState: z.enum(['queued', 'running', 'succeeded', 'failed', 'lease-held', 'not-due', 'not-run']) });
export type MaintenanceSummary = z.infer<typeof summarySchema>;
const emptySummary = (): MaintenanceSummary => ({ authScanned: null, authQueued: null, authProcessed: null,
  authErrors: 0, ledgerProcessed: null, ledgerIssues: 0, ledgerScanErrors: 0, ledgerState: 'not-run' });
const jobId = 'scheduled-maintenance';
const leaseMs = 300_000, cooldownMs = 15 * 60_000;
type Steps = {
  auth: () => Promise<{ scanned: number; queued: number; errors: number; processed: number }>;
  ledger: () => Promise<{ processed: number; skipped?: string | null; status?: string;
    resultSummary?: { issueCount: number; scanErrors: number } }>;
};

export class MaintenanceLeaseLost extends Error {
  constructor() { super('MAINTENANCE_LEASE_LOST'); }
}

/** A short, fenced orchestration run. Each underlying worker retains its own leases and checkpoints. */
export async function runScheduledMaintenance(store: Firestore, steps: Steps, clock = Date.now) {
  const ref = store.doc('maintenanceJobs/' + jobId), owner = randomUUID();
  const claim = await store.runTransaction(async tx => {
    const previous = await tx.get(ref), now = Timestamp.fromMillis(clock());
    if (previous.get('leaseUntil') instanceof Timestamp && previous.get('leaseUntil').toMillis() > now.toMillis()) return 'lease-held';
    if (previous.get('availableAt') instanceof Timestamp && previous.get('availableAt').toMillis() > now.toMillis()) return 'cooldown';
    tx.set(ref, { schemaVersion: 1, kind: 'scheduled_maintenance', status: 'running',
      attempts: (previous.get('attempts') ?? 0) + 1, leaseOwner: owner,
      leaseUntil: Timestamp.fromMillis(now.toMillis() + leaseMs), availableAt: now,
      createdAt: previous.get('createdAt') ?? now, updatedAt: now, completedAt: null,
      lastErrorCode: null, resultSummary: emptySummary() });
    return 'claimed';
  });
  if (claim !== 'claimed') return { jobId, skipped: claim, status: 'skipped' as const };

  async function save(patch: Record<string, unknown>) {
    await store.runTransaction(async tx => {
      const current = await tx.get(ref), now = Timestamp.fromMillis(clock());
      if (current.get('leaseOwner') !== owner || current.get('status') !== 'running' ||
        !(current.get('leaseUntil') instanceof Timestamp) || current.get('leaseUntil').toMillis() <= now.toMillis()) throw new MaintenanceLeaseLost();
      tx.update(ref, { ...patch, updatedAt: now });
    });
  }
  const result = emptySummary();
  try {
    const checked = await steps.auth();
    Object.assign(result, { authScanned: checked.scanned, authQueued: checked.queued, authProcessed: checked.processed, authErrors: checked.errors });
  } catch { result.authErrors = 1; }
  summarySchema.parse(result);
  await save({ resultSummary: result });
  try {
    const checked = await steps.ledger();
    Object.assign(result, { ledgerProcessed: checked.processed, ledgerIssues: checked.resultSummary?.issueCount ?? 0,
      ledgerScanErrors: checked.resultSummary?.scanErrors ?? 0, ledgerState: checked.skipped ?? checked.status ?? 'not-run' });
  } catch { result.ledgerScanErrors = 1; result.ledgerState = 'failed'; }
  summarySchema.parse(result);
  const status = result.authErrors || result.ledgerIssues || result.ledgerScanErrors ? 'failed' : 'succeeded';
  const now = Timestamp.fromMillis(clock());
  await save({ status, leaseOwner: null, leaseUntil: null, completedAt: now,
    availableAt: Timestamp.fromMillis(now.toMillis() + cooldownMs), resultSummary: result,
    lastErrorCode: result.authErrors ? 'MAINTENANCE_AUTH_FAILED' : result.ledgerScanErrors ? 'MAINTENANCE_LEDGER_FAILED' : result.ledgerIssues ? 'RECONCILE_ISSUES_FOUND' : null });
  return { jobId, skipped: null, status, summary: result };
}

export async function scheduledMaintenance() {
  const store = db();
  return runScheduledMaintenance(store, {
    auth: async () => {
      const gateway = auth(), checked = await reconcileAdminAuth(store, gateway, 25);
      const processed = await drainAdminAuthJobs(store, gateway, 25);
      return { ...checked, ...processed };
    },
    ledger: () => runLedgerReconciliation(store, { limit: 1, pageSize: 50 }),
  });
}

export function maintenanceSummary(value: unknown): MaintenanceSummary | null {
  const parsed = summarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
