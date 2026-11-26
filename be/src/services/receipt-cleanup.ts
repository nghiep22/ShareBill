import { randomUUID } from 'node:crypto';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { ApiError } from '../http.js';
import { DAY_MS, processedPrefix, readReceipt, stagingPrefix, type ReceiptDocument } from '../database/receipt.js';
import { increment } from './trip-access.js';
import type { ReceiptObject, ReceiptStorage } from './receipt-storage.js';

function liveLease(receipt: ReceiptDocument, now: number) {
  return receipt.status === 'processing' && (receipt.processingLeaseUntil?.toMillis() ?? 0) > now;
}
function expired(receipt: ReceiptDocument, now: number) {
  return receipt.status === 'awaiting_upload' && receipt.expiresAt.toMillis() <= now ||
    receipt.status === 'ready' && receipt.updatedAt.toMillis() + DAY_MS <= now ||
    receipt.status === 'processing' && !liveLease(receipt, now) && receipt.createdAt.toMillis() + DAY_MS <= now ||
    receipt.status === 'failed';
}
function deletable(receipt: ReceiptDocument, id: string, item: ReceiptObject, now: number) {
  if (liveLease(receipt, now)) return false;
  if (item.path.startsWith(stagingPrefix(receipt.tripId, receipt.uploaderUid, id))) {
    // An expired processing lease can be reclaimed for 24h; preserve its source until that window closes.
    if (receipt.status === 'processing' && receipt.createdAt.toMillis() + DAY_MS > now) return false;
    return receipt.expiresAt.toMillis() <= now;
  }
  if (!item.path.startsWith(processedPrefix(receipt.tripId, id))) return false;
  const main = receipt.processedPath === item.path && receipt.processedGeneration === item.generation;
  if (!main) return true;
  return receipt.status === 'discarded' && (receipt.cleanupAfter?.toMillis() ?? Infinity) <= now;
}
function discardPatch(receipt: ReceiptDocument, now: Timestamp) {
  return { status: 'discarded' as const, version: increment(receipt.version), updatedAt: now,
    discardedAt: now, cleanupAfter: now, processingLeaseUntil: null, attachedExpenseId: null };
}

export async function cleanReceipt(store: FirebaseFirestore.Firestore, ref: FirebaseFirestore.DocumentReference,
  storage: ReceiptStorage, apply: boolean, nowMillis = Date.now()) {
  const tripRef = ref.parent.parent!;
  const initial = await store.runTransaction(async tx => {
    const [snapshot, trip] = await Promise.all([tx.get(ref), tx.get(tripRef)]);
    const receipt = readReceipt(snapshot, tripRef.id), stale = expired(receipt, nowMillis), now = Timestamp.fromMillis(nowMillis);
    if (!stale) return { receipt, discarded: false };
    const patch = discardPatch(receipt, now);
    if (apply) {
      const revision = increment(trip.get('revision')), ledgerVersion = trip.get('ledgerVersion');
      tx.update(ref, patch);
      tx.update(tripRef, { revision, updatedAt: now });
      tx.update(tripRef.collection('signals').doc('current'), { revision, ledgerVersion, updatedAt: now });
    }
    return { receipt: { ...receipt, ...patch }, discarded: true };
  });
  let deletedObjects = 0, keptObjects = 0, more = false, stagingRemaining = false;
  for (const prefix of [stagingPrefix(tripRef.id, initial.receipt.uploaderUid, ref.id), processedPrefix(tripRef.id, ref.id)]) {
    // One bounded object page per prefix/run. A continuation schedules another receipt retry.
    const page = await storage.list(prefix);
    more ||= Boolean(page.nextPageToken);
    const staging = prefix === stagingPrefix(tripRef.id, initial.receipt.uploaderUid, ref.id);
    if (staging && page.nextPageToken) stagingRemaining = true;
    for (const item of page.items) {
      const allowed = apply ? await store.runTransaction(async tx => {
        const receipt = readReceipt(await tx.get(ref), tripRef.id);
        return deletable(receipt, ref.id, item, Date.now());
      }, { readOnly: true }) : deletable(initial.receipt, ref.id, item, nowMillis);
      if (allowed) { if (apply) await storage.delete(item.path, item.generation); deletedObjects++; }
      else { keptObjects++; if (staging) stagingRemaining = true; }
    }
  }
  if (apply) {
    await store.runTransaction(async tx => {
      const snapshot = await tx.get(ref), receipt = readReceipt(snapshot, tripRef.id);
      const queued = store.doc(`maintenanceJobs/receipt-staging-${tripRef.id}-${ref.id}`), queue = await tx.get(queued);
      if (!more && keptObjects === 0 && receipt.status === 'discarded' && (receipt.cleanupAfter?.toMillis() ?? Infinity) <= Date.now()) {
        tx.update(ref, { storageDeletedAt: Timestamp.now() });
      }
      if (queue.exists && !stagingRemaining) tx.update(queued, { status: 'completed', updatedAt: Timestamp.now() });
    });
  }
  return { discarded: initial.discarded, deletedObjects, keptObjects, more };
}

function validReceiptPath(path: string) {
  const fields = path.split('/');
  return fields.length === 4 && fields[0] === 'trips' && fields[2] === 'receipts' &&
    z.uuid().safeParse(fields[1]).success && z.uuid().safeParse(fields[3]).success;
}
type CleanupSummary = { scanned: number; discarded: number; deletedObjects: number };
export async function cleanupReceipts(store: FirebaseFirestore.Firestore, storage: ReceiptStorage,
  options: { apply: boolean; limit: number; jobId?: string; tripId?: string }) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100 ||
      options.jobId !== undefined && !z.uuid().safeParse(options.jobId).success ||
      options.tripId !== undefined && !z.uuid().safeParse(options.tripId).success) throw new Error('Invalid cleanup options');
  const jobId = options.jobId ?? randomUUID(), owner = randomUUID(), jobRef = store.doc(`maintenanceJobs/${jobId}`);
  const now = Timestamp.now();
  const prior = options.apply ? await store.runTransaction(async tx => {
    const job = await tx.get(jobRef);
    if (options.jobId && !job.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy cleanup job.');
    if (job.exists && job.get('kind') !== 'receipt_cleanup') throw new Error('Invalid cleanup job');
    if (job.exists && job.get('tripId') !== (options.tripId ?? null)) throw new Error('Cleanup job scope mismatch');
    if (job.get('status') === 'running' && (job.get('leaseUntil') as Timestamp).toMillis() > now.toMillis()) {
      throw new ApiError(409, 'JOB_IN_PROGRESS', 'Cleanup job đang chạy.');
    }
    const data = job.data() ?? { checkpoint: null, retryPaths: [], failedPaths: [], attempts: {}, summary: { scanned: 0, discarded: 0, deletedObjects: 0 } };
    tx.set(jobRef, { ...data, tripId: options.tripId ?? null, kind: 'receipt_cleanup', status: 'running', leaseOwner: owner,
      leaseUntil: Timestamp.fromMillis(now.toMillis() + 300_000), updatedAt: now });
    return data;
  }) : { checkpoint: null, retryPaths: [], failedPaths: [], attempts: {}, summary: { scanned: 0, discarded: 0, deletedObjects: 0 } };
  let checkpoint = prior.checkpoint as string | null;
  if (checkpoint !== null && !validReceiptPath(checkpoint)) throw new Error('Invalid job checkpoint');
  const retryPaths = new Set<string>(prior.retryPaths as string[]), failedPaths = new Set<string>(prior.failedPaths as string[]);
  const attempts = prior.attempts as Record<string, number>, summary: CleanupSummary = { ...prior.summary };
  const work: { path: string; fromScan: boolean }[] = [...retryPaths].slice(0, options.limit).map(path => ({ path, fromScan: false }));
  const remaining = options.limit - work.length;
  let query: FirebaseFirestore.Query = (options.tripId ? store.collection(`trips/${options.tripId}/receipts`) :
    store.collectionGroup('receipts')).orderBy(FieldPath.documentId());
  if (checkpoint) query = query.startAfter(store.doc(checkpoint));
  const page = remaining ? await query.limit(remaining + 1).get() : null;
  if (page) work.push(...page.docs.slice(0, remaining).map(doc => ({ path: doc.ref.path, fromScan: true })));
  const more = remaining === 0 || Boolean(page && page.size > remaining);
  const errors: { path: string; code: string }[] = [];
  for (const item of work) {
    if (!validReceiptPath(item.path)) throw new Error('Unexpected receipt collection path');
    summary.scanned++;
    try {
      const result = await cleanReceipt(store, store.doc(item.path), storage, options.apply);
      summary.discarded += Number(result.discarded); summary.deletedObjects += result.deletedObjects;
      retryPaths.delete(item.path); delete attempts[item.path];
      if (result.more) retryPaths.add(item.path);
    } catch (error) {
      errors.push({ path: item.path, code: error instanceof ApiError ? error.code : 'CLEANUP_STORAGE_ERROR' });
      attempts[item.path] = (attempts[item.path] ?? 0) + 1;
      if (attempts[item.path]! < 3) retryPaths.add(item.path);
      else { retryPaths.delete(item.path); failedPaths.add(item.path); }
    }
    if (item.fromScan) checkpoint = item.path;
    if (retryPaths.size + failedPaths.size > 100) throw new Error('Cleanup error queue limit reached');
    if (options.apply) await store.runTransaction(async tx => {
      const job = await tx.get(jobRef);
      if (job.get('leaseOwner') !== owner) throw new ApiError(409, 'JOB_LEASE_LOST', 'Cleanup job đã chuyển worker.');
      tx.update(jobRef, { checkpoint, retryPaths: [...retryPaths], failedPaths: [...failedPaths], attempts, summary,
        updatedAt: Timestamp.now(), leaseUntil: Timestamp.fromMillis(Date.now() + 300_000) });
    });
  }
  const status = more ? 'pending' : retryPaths.size ? 'completed_with_errors' : failedPaths.size ? 'failed' : 'completed';
  if (options.apply) await store.runTransaction(async tx => {
    const job = await tx.get(jobRef);
    if (job.get('leaseOwner') !== owner) throw new ApiError(409, 'JOB_LEASE_LOST', 'Cleanup job đã chuyển worker.');
    tx.update(jobRef, { status, leaseUntil: Timestamp.now(), updatedAt: Timestamp.now() });
  });
  return { jobId: options.apply ? jobId : null, mode: options.apply ? 'apply' : 'dry-run', status, checkpoint,
    summary, retryPaths: [...retryPaths], failedPaths: [...failedPaths], errors };
}
