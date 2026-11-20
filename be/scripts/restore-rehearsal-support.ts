import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

export class RestoreRehearsalError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function requireEvidence(condition: unknown, code: string): asserts condition {
  if (!condition) throw new RestoreRehearsalError(code);
}
export function inside(root: string, path: string) {
  const subpath = relative(resolve(root), resolve(path));
  requireEvidence(subpath !== '' && !subpath.startsWith('..' + sep) && subpath !== '..' && !resolve(path).startsWith('\\\\') && !subpath.includes(':'), 'RESTORE_PATH_OUTSIDE_RUN');
  return resolve(path);
}
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Timestamp) return { $timestamp: [item.seconds, item.nanoseconds] };
    if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    return item;
  });
}
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function isolatedEnvironment(env: NodeJS.ProcessEnv, projectId: string, directory: string): NodeJS.ProcessEnv {
  requireEvidence(/^demo-sb-restore-[a-f0-9]{12}$/.test(projectId), 'RESTORE_SYNTHETIC_PROJECT_REQUIRED');
  const isolated = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|PROGRAMDATA|JAVA_HOME|LANG|LC_[A-Z_]+|TZ|TERM|NO_COLOR|FORCE_COLOR|FIREBASE_EMULATORS_PATH)$/i.test(key)));
  return { ...isolated, FIREBASE_PROJECT_ID: projectId, GCLOUD_PROJECT: projectId, GOOGLE_CLOUD_PROJECT: projectId,
    FIREBASE_WEB_API_KEY: 'demo', FIREBASE_STORAGE_BUCKET: projectId + '.appspot.com',
    FIREBASE_CONFIG: JSON.stringify({ projectId, storageBucket: projectId + '.appspot.com' }),
    XDG_CONFIG_HOME: join(directory, 'cli-config'), SHAREBILL_RESTORE_RUN: directory, CI: 'true', FIREBASE_CLI_DISABLE_USAGE_TRACKING: 'true' };
}

/** Walk subcollections even when a namespace parent document does not exist (adminOperations, user operations, notes). */
export async function firestoreInventory(store: Firestore) {
  const documents: { path: string; hash: string }[] = [];
  let references = 0;
  async function walk(parent: Firestore | FirebaseFirestore.DocumentReference, depth: number) {
    requireEvidence(depth <= 12, 'RESTORE_INVENTORY_LIMIT');
    for (const collection of await parent.listCollections()) {
      for (const ref of await collection.listDocuments()) {
        requireEvidence(++references <= 2000, 'RESTORE_INVENTORY_LIMIT');
        const snapshot = await ref.get();
        if (snapshot.exists) documents.push({ path: ref.path, hash: sha256(canonical(snapshot.data())) });
        await walk(ref, depth + 1);
      }
    }
  }
  await walk(store, 0);
  documents.sort((a, b) => a.path.localeCompare(b.path));
  return { documents: documents.length, digest: sha256(canonical(documents)) };
}

export async function exportedFiles(directory: string) {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  let totalBytes = 0;
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = inside(directory, join(path, entry.name));
      const info = await lstat(file);
      requireEvidence(!info.isSymbolicLink(), 'RESTORE_EXPORT_SYMLINK');
      if (info.isDirectory()) await walk(file);
      else {
        totalBytes += info.size;
        requireEvidence(info.isFile() && totalBytes <= 64 * 1024 * 1024 && files.length < 1000, 'RESTORE_EXPORT_LIMIT');
        files.push({ path: relative(directory, file).split(sep).join('/'), bytes: info.size, sha256: sha256(await readFile(file)) });
      }
    }
  }
  await walk(directory);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const metadata = JSON.parse(await readFile(join(directory, 'firebase-export-metadata.json'), 'utf8'));
  for (const service of ['auth', 'firestore', 'storage']) {
    const expected = service + '_export';
    requireEvidence(metadata[service]?.path === expected && files.some(file => file.path.startsWith(expected + '/')), 'RESTORE_EXPORT_INCOMPLETE');
  }
  requireEvidence(metadata.firestore.metadata_file === 'firestore_export/firestore_export.overall_export_metadata' &&
    files.some(file => file.path === metadata.firestore.metadata_file), 'RESTORE_EXPORT_INCOMPLETE');
  return { files, digest: sha256(canonical(files)) };
}

const count = z.number().int().nonnegative().safe();
const verificationSchema = z.strictObject({
  counts: z.strictObject({ firestoreDocuments: count.positive(), authUsers: count.positive(), receiptObjects: count.positive(), trips: count.positive() }),
  checks: z.strictObject(Object.fromEntries(['documentInventory', 'authInventory', 'passwordLogin', 'disabledAccount', 'ledger', 'memberAccess',
    'outsiderDenied', 'googleGuard', 'operationReplay', 'receiptReference', 'receiptGeneration', 'receiptBytes', 'firestoreRules', 'storageRules', 'projectionRepair',
    'googleLogin', 'adminAccess', 'internalNotesPrivate']
    .map(key => [key, z.literal(true)]))),
  checkerIssues: z.literal(0), lostFixtureWrites: z.literal(0),
});
export function publicVerification(value: unknown) {
  const result = verificationSchema.safeParse(value);
  requireEvidence(result.success, 'RESTORE_VERIFICATION_INCOMPLETE');
  return result.data;
}
