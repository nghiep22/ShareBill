import { randomUUID } from 'node:crypto';
import { Firestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUserDocument } from '../src/database/user.js';
import { drainAdminAuthJobs, reconcileAdminAuth } from '../src/services/admin-auth-jobs.js';
import { runLedgerReconciliation } from '../src/services/ledger-reconciliation.js';
import { MaintenanceLeaseLost, runScheduledMaintenance } from '../src/services/scheduled-maintenance.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const store = enabled ? new Firestore({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'demo-sharebill', databaseId: 'scheduled-' + randomUUID() }) : undefined;
const job = () => store!.doc('maintenanceJobs/scheduled-maintenance');
const success = () => ({ auth: vi.fn().mockResolvedValue({ scanned: 2, queued: 1, errors: 0, processed: 1 }),
  ledger: vi.fn().mockResolvedValue({ processed: 1, skipped: null, status: 'queued', resultSummary: { issueCount: 0, scanErrors: 0 } }) });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
afterAll(() => store?.terminate());
beforeEach(async () => { if (store) await job().delete(); });

describe.skipIf(!enabled)('scheduled maintenance fencing and recovery', () => {
  it('publishes aggregate results, respects cooldown and starts a fresh bounded run later', async () => {
    const steps = success(); let now = Date.now();
    const first = await runScheduledMaintenance(store!, steps, () => now);
    expect(first).toMatchObject({ status: 'succeeded', summary: { authScanned: 2, authProcessed: 1, ledgerProcessed: 1, ledgerState: 'queued' } });
    expect((await job().get()).get('leaseOwner')).toBeNull();
    expect(await runScheduledMaintenance(store!, steps, () => now)).toMatchObject({ status: 'skipped', skipped: 'cooldown' });
    expect(steps.auth).toHaveBeenCalledTimes(1); expect(steps.ledger).toHaveBeenCalledTimes(1);
    now += 15 * 60_000;
    expect(await runScheduledMaintenance(store!, steps, () => now)).toMatchObject({ status: 'succeeded' });
    expect((await job().get()).get('attempts')).toBe(2);
  });
  it('skips a duplicate trigger while the first request still holds its lease', async () => {
    const entered = gate(), blocked = gate(), steps = success();
    steps.auth.mockImplementation(async () => { entered.release(); await blocked.promise; return { scanned: 1, queued: 0, errors: 0, processed: 0 }; });
    const first = runScheduledMaintenance(store!, steps);
    await entered.promise;
    expect(await runScheduledMaintenance(store!, success())).toMatchObject({ skipped: 'lease-held' });
    blocked.release(); await first;
    expect(steps.auth).toHaveBeenCalledTimes(1); expect(steps.ledger).toHaveBeenCalledTimes(1);
  });
  it('rejects a late worker after expiry and reclaim without publishing its result or starting the next phase', async () => {
    const entered = gate(), blocked = gate(), stale = success(); let now = Date.now();
    stale.auth.mockImplementation(async () => { entered.release(); await blocked.promise; return { scanned: 99, queued: 0, errors: 0, processed: 0 }; });
    const first = runScheduledMaintenance(store!, stale, () => now);
    const rejected = expect(first).rejects.toBeInstanceOf(MaintenanceLeaseLost);
    await entered.promise; now += 300_001;
    const next = success(); await runScheduledMaintenance(store!, next, () => now);
    const before = (await job().get()).data();
    blocked.release(); await rejected;
    expect(stale.ledger).not.toHaveBeenCalled();
    expect((await job().get()).data()).toEqual(before);
  });
  it('rejects an expired lease even without a replacement worker', async () => {
    let now = Date.now(); const steps = success();
    steps.auth.mockImplementation(async () => { now += 300_001; return { scanned: 1, queued: 0, errors: 0, processed: 0 }; });
    await expect(runScheduledMaintenance(store!, steps, () => now)).rejects.toBeInstanceOf(MaintenanceLeaseLost);
    expect(steps.ledger).not.toHaveBeenCalled();
    expect((await job().get()).get('status')).toBe('running');
  });
  it('isolates phase failures, retains unknown counters and stores no upstream data', async () => {
    const steps = success();
    steps.auth.mockRejectedValue(new Error('private-token-and-email@example.test'));
    const result = await runScheduledMaintenance(store!, steps);
    expect(result).toMatchObject({ status: 'failed', summary: { authScanned: null, authProcessed: null, authErrors: 1, ledgerProcessed: 1 } });
    expect(steps.ledger).toHaveBeenCalledTimes(1);
    const data = (await job().get()).data();
    expect(data?.lastErrorCode).toBe('MAINTENANCE_AUTH_FAILED');
    expect(JSON.stringify(data)).not.toContain('private-token');
    await job().delete();
    const failed = success(); failed.ledger.mockRejectedValue(new Error('secret signed URL'));
    expect(await runScheduledMaintenance(store!, failed)).toMatchObject({ status: 'failed', summary: { ledgerProcessed: null, ledgerScanErrors: 1, ledgerState: 'failed' } });
  });
  it('does not report a partial ledger sweep or a skipped checker as proof of a clean ledger', async () => {
    const steps = success();
    steps.ledger.mockResolvedValue({ processed: 1, skipped: null, status: 'queued', resultSummary: { issueCount: 3, scanErrors: 0 } });
    expect(await runScheduledMaintenance(store!, steps)).toMatchObject({ status: 'failed', summary: { ledgerIssues: 3, ledgerState: 'queued' } });
    await job().delete();
    steps.ledger.mockResolvedValue({ processed: 0, skipped: 'not-due', status: undefined, resultSummary: undefined });
    expect(await runScheduledMaintenance(store!, steps)).toMatchObject({ status: 'succeeded', summary: { ledgerProcessed: 0, ledgerState: 'not-due' } });
  });
  it('runs the existing Auth workers and read-only ledger worker against real stored jobs', async () => {
    const uid = randomUUID(), now = Timestamp.now();
    await store!.doc('users/' + uid).set({ ...createUserDocument({ uid, displayName: 'Synthetic user' }, now), desiredAuthDisabled: true });
    const actual = new Map<string, boolean>([[uid, false]]);
    const gateway = {
      getUser: vi.fn(async (id: string) => ({ disabled: actual.get(id) ?? false })),
      updateUser: vi.fn(async (id: string, options: { disabled?: boolean }) => { actual.set(id, options.disabled ?? false); return {}; }),
      revokeRefreshTokens: vi.fn(async () => {}),
    };
    const result = await runScheduledMaintenance(store!, {
      auth: async () => {
        const checked = await reconcileAdminAuth(store!, gateway as never, 25);
        const drained = await drainAdminAuthJobs(store!, gateway as never, 25);
        return { ...checked, ...drained };
      },
      ledger: () => runLedgerReconciliation(store!, { limit: 1, pageSize: 50 }),
    });
    expect(result).toMatchObject({ status: 'succeeded', summary: { authQueued: 1, authProcessed: 1, ledgerState: 'succeeded' } });
    expect(actual.get(uid)).toBe(true);
    expect((await store!.doc('users/' + uid).get()).get('authSyncStatus')).toBe('synced');
    expect(gateway.revokeRefreshTokens).toHaveBeenCalledWith(uid);
  });
});
