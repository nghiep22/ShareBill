import { randomUUID } from 'node:crypto';
import { FieldPath, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { checkDatabase } from '../database/check-integrity.js';

const leaseMs = 120_000;
const sweepIntervalMs = 15 * 60_000;
const maximumRetries = 3;
const count = z.number().int().nonnegative().safe();
const summarySchema = z.strictObject({ tripsScanned: count, tripsChecked: count, tripsWithIssues: count,
  issueCount: count, scanErrors: count });
export type ReconciliationSummary = z.infer<typeof summarySchema>;
const summary = (): ReconciliationSummary => ({ tripsScanned: 0, tripsChecked: 0, tripsWithIssues: 0, issueCount: 0, scanErrors: 0 });
const timestamp = z.instanceof(Timestamp);
const documentId = z.string().min(1).max(1500).regex(/^[^/]+$/);
const jobSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('ledger_reconcile'), tripId: z.uuid().nullable(), cycle: z.uuid(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']), checkpoint: documentId.nullable(),
  retryTripId: documentId.nullable(), retryCount: count.max(maximumRetries), attempts: count,
  resultSummary: summarySchema, lastErrorCode: z.enum(['RECONCILE_SCAN_FAILED', 'RECONCILE_ISSUES_FOUND']).nullable(),
  leaseOwner: z.uuid().nullable(), leaseUntil: timestamp.nullable(), availableAt: timestamp,
  createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp.nullable(),
});
type Job = z.infer<typeof jobSchema>;
type Options = { tripId?: string; limit?: number; pageSize?: number };
type Dependencies = { check?: typeof checkDatabase; now?: () => number };

export class ReconciliationLeaseLost extends Error {
  constructor() { super('RECONCILE_LEASE_LOST'); }
}

export function reconciliationJobId(tripId?: string) {
  if (tripId !== undefined && !z.uuid().safeParse(tripId).success) throw new Error('Invalid trip ID');
  return 'ledger-reconcile-' + (tripId ?? 'all');
}

/** Writes only one maintenance job/checkpoint; the checker never repairs ledger, balances, or trip metadata. */
export async function runLedgerReconciliation(store: Firestore, options: Options = {}, dependencies: Dependencies = {}) {
  const limit = options.limit ?? 5, pageSize = options.pageSize ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Invalid reconciliation limit');
  const jobId = reconciliationJobId(options.tripId), jobRef = store.doc('maintenanceJobs/' + jobId), owner = randomUUID();
  const clock = () => Timestamp.fromMillis((dependencies.now ?? Date.now)());
  const claim = await store.runTransaction(async tx => {
    const snapshot = await tx.get(jobRef), now = clock();
    const prior = snapshot.exists ? jobSchema.parse(snapshot.data()) : undefined;
    if (prior && prior.tripId !== (options.tripId ?? null)) throw new Error('Reconciliation scope mismatch');
    if (prior?.status === 'running' && prior.leaseUntil && prior.leaseUntil.toMillis() > now.toMillis()) return { skipped: 'lease-held' as const };
    if (prior && prior.status !== 'running' && prior.availableAt.toMillis() > now.toMillis()) return { skipped: 'not-due' as const };
    const fresh = !prior || ['succeeded', 'failed'].includes(prior.status);
    const data: Job = fresh ? {
      schemaVersion: 1, kind: 'ledger_reconcile', tripId: options.tripId ?? null, cycle: randomUUID(),
      status: 'running', checkpoint: null, retryTripId: null, retryCount: 0, attempts: 1,
      resultSummary: summary(), lastErrorCode: null, leaseOwner: owner,
      leaseUntil: Timestamp.fromMillis(now.toMillis() + leaseMs), availableAt: now,
      createdAt: prior?.createdAt ?? now, updatedAt: now, completedAt: null,
    } : { ...prior!, status: 'running', attempts: prior!.attempts + 1, leaseOwner: owner,
      leaseUntil: Timestamp.fromMillis(now.toMillis() + leaseMs), updatedAt: now };
    tx.set(jobRef, data);
    return { data };
  });
  if ('skipped' in claim) return { jobId, skipped: claim.skipped, processed: 0 };
  let state = claim.data;
  let processed = 0;

  async function save(transform: (job: Job, now: Timestamp) => Partial<Job>) {
    state = await store.runTransaction(async tx => {
      const snapshot = await tx.get(jobRef), now = clock();
      const job = jobSchema.parse(snapshot.data());
      if (job.leaseOwner !== owner || job.cycle !== state.cycle || job.status !== 'running' ||
          !job.leaseUntil || job.leaseUntil.toMillis() <= now.toMillis()) throw new ReconciliationLeaseLost();
      const next = jobSchema.parse({ ...job, ...transform(job, now), updatedAt: now });
      tx.set(jobRef, next);
      return next;
    });
  }
  async function finish(more: boolean, delayed = false) {
    await save((job, now) => ({ status: more ? 'queued' : job.resultSummary.issueCount || job.resultSummary.scanErrors ? 'failed' : 'succeeded',
      leaseOwner: null, leaseUntil: null, completedAt: more ? null : now,
      availableAt: Timestamp.fromMillis(now.toMillis() + (more ? delayed ? 5_000 : 0 : sweepIntervalMs)) }));
    return { jobId, skipped: null, processed, status: state.status, resultSummary: state.resultSummary };
  }

  try {
    let trips: string[], more: boolean;
    if (options.tripId) { trips = state.checkpoint ? [] : [options.tripId]; more = false; }
    else {
      let query = store.collection('trips').orderBy(FieldPath.documentId());
      if (state.checkpoint) query = query.startAfter(state.checkpoint);
      const page = await query.limit(limit + 1).get();
      trips = page.docs.slice(0, limit).map(doc => doc.id);
      more = page.size > limit;
    }
    // Retry the same ID even if its source root was deleted after the previous attempt.
    if (state.retryTripId) {
      const remaining = trips.filter(id => id !== state.retryTripId);
      more ||= remaining.length >= limit;
      trips = [state.retryTripId, ...remaining].slice(0, limit);
    }
    for (const tripId of trips) {
      await save((_job, now) => ({ leaseUntil: Timestamp.fromMillis(now.toMillis() + leaseMs) }));
      let result: Awaited<ReturnType<typeof checkDatabase>> | undefined;
      try {
        result = await (dependencies.check ?? checkDatabase)(store, { tripId, pageSize });
        if (result.summary.tripsScanned !== 1 || result.summary.tripsChecked !== 1) result = undefined;
      } catch { /* Retry boundedly without storing upstream messages or private diff contents. */ }
      let retry = false;
      await save(job => {
        if (!result) {
          const retries = job.retryTripId === tripId ? job.retryCount + 1 : 1;
          retry = retries < maximumRetries;
          return { retryTripId: retry ? tripId : null, retryCount: retry ? retries : 0,
            checkpoint: retry ? job.checkpoint : tripId, lastErrorCode: 'RECONCILE_SCAN_FAILED',
            resultSummary: retry ? job.resultSummary : { ...job.resultSummary,
              tripsScanned: job.resultSummary.tripsScanned + 1, scanErrors: job.resultSummary.scanErrors + 1 } };
        }
        const issues = result.summary.issueCount;
        return { checkpoint: tripId, retryTripId: null, retryCount: 0,
          lastErrorCode: job.resultSummary.scanErrors ? 'RECONCILE_SCAN_FAILED' : issues || job.resultSummary.issueCount ? 'RECONCILE_ISSUES_FOUND' : null,
          resultSummary: { ...job.resultSummary, tripsScanned: job.resultSummary.tripsScanned + 1,
            tripsChecked: job.resultSummary.tripsChecked + 1, tripsWithIssues: job.resultSummary.tripsWithIssues + Number(issues > 0),
            issueCount: job.resultSummary.issueCount + issues } };
      });
      processed++;
      if (retry) return finish(true, true);
    }
    return finish(more);
  } catch (error) {
    if (error instanceof ReconciliationLeaseLost) throw error;
    // A query/transaction failure leaves its lease/checkpoint intact for recovery after expiry.
    throw new Error('RECONCILE_RUN_FAILED');
  }
}

/** Admin DTO deliberately omits checkpoint, identity/path details and the checker's private diff. */
export function reconciliationSummary(value: unknown): ReconciliationSummary | null {
  const parsed = summarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
