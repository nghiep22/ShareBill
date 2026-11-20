import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import { canonical, exportedFiles, inside, isolatedEnvironment, publicVerification } from '../scripts/restore-rehearsal-support.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    inside(await realpath(tmpdir()), await realpath(directory));
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sharebill-restore-evidence-')); directories.push(directory);
  const metadata = { version: 'test', auth: { path: 'auth_export' }, storage: { path: 'storage_export' },
    firestore: { path: 'firestore_export', metadata_file: 'firestore_export/firestore_export.overall_export_metadata' } };
  for (const service of ['auth', 'firestore', 'storage']) {
    await mkdir(join(directory, service + '_export'));
    await writeFile(join(directory, service + '_export', service === 'firestore' ? 'firestore_export.overall_export_metadata' : 'fixture.json'), 'synthetic');
  }
  await writeFile(join(directory, 'firebase-export-metadata.json'), JSON.stringify(metadata));
  return { directory, metadata };
}
function verification() {
  return { counts: { firestoreDocuments: 51, authUsers: 4, receiptObjects: 1, trips: 1 },
    checks: Object.fromEntries(['documentInventory', 'authInventory', 'passwordLogin', 'disabledAccount', 'ledger', 'memberAccess', 'outsiderDenied',
      'googleGuard', 'operationReplay', 'receiptReference', 'receiptGeneration', 'receiptBytes', 'firestoreRules', 'storageRules', 'projectionRepair',
      'googleLogin', 'adminAccess', 'internalNotesPrivate'].map(key => [key, true])),
    checkerIssues: 0, lostFixtureWrites: 0 };
}

describe('isolated restore rehearsal evidence', () => {
  it('inherits only runtime environment values and pins a generated demo project with a private CLI config', () => {
    const result = isolatedEnvironment({ PATH: 'runtime-path', JAVA_HOME: 'jdk', FIREBASE_TOKEN: 'private-token', MYSTERY_KEY: 'private-key',
      FIRESTORE_EMULATOR_HOST: 'remote:8080', GOOGLE_APPLICATION_CREDENTIALS: 'private-file', FIREBASE_PROJECT_ID: 'production' },
    'demo-sb-restore-123456abcdef', '/private-run');
    expect(result.PATH).toBe('runtime-path'); expect(result.JAVA_HOME).toBe('jdk');
    expect(result.FIREBASE_PROJECT_ID).toBe('demo-sb-restore-123456abcdef');
    expect(JSON.stringify(result)).not.toMatch(/private-token|private-key|private-file|remote:8080|production/);
    expect(result.XDG_CONFIG_HOME).toBe(join('/private-run', 'cli-config'));
  });
  it.each(['sharebill-production', 'demo-sharebill', 'demo-sb-restore-../../../escape'])('does not accept a user environment project %s', project => {
    expect(() => isolatedEnvironment({}, project, '/private-run')).toThrow('RESTORE_SYNTHETIC_PROJECT_REQUIRED');
  });
  it('rejects targets outside or equal to the owned directory', () => {
    expect(() => inside('/owned', '/owned')).toThrow('RESTORE_PATH_OUTSIDE_RUN');
    expect(() => inside('/owned', '/other/export')).toThrow('RESTORE_PATH_OUTSIDE_RUN');
    expect(inside('/owned', '/owned/export')).toMatch(/export$/);
  });
  it('fingerprints all three native export components and detects a changed file', async () => {
    const f = await fixture(), first = await exportedFiles(f.directory);
    expect(first.files).toHaveLength(4);
    expect(await exportedFiles(f.directory)).toEqual(first);
    await writeFile(join(f.directory, 'auth_export/fixture.json'), 'changed');
    expect((await exportedFiles(f.directory)).digest).not.toBe(first.digest);
  });
  it('rejects incomplete or escaping export metadata before import', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, 'firebase-export-metadata.json'), JSON.stringify({ ...f.metadata, auth: { path: '../auth_export' } }));
    await expect(exportedFiles(f.directory)).rejects.toThrow('RESTORE_EXPORT_INCOMPLETE');
    await writeFile(join(f.directory, 'firebase-export-metadata.json'), JSON.stringify(f.metadata));
    await rm(join(f.directory, 'storage_export/fixture.json'));
    await expect(exportedFiles(f.directory)).rejects.toThrow('RESTORE_EXPORT_INCOMPLETE');
  });
  it('retains timestamp precision and array order in document fingerprints', () => {
    expect(canonical({ b: 1, a: Timestamp.fromMillis(1234) })).toBe(canonical({ a: Timestamp.fromMillis(1234), b: 1 }));
    expect(canonical(new Timestamp(1, 1))).not.toBe(canonical(new Timestamp(1, 2)));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
  it('allows only complete successful checks in the public report and rejects private extra fields', () => {
    expect(publicVerification(verification())).toEqual(verification());
    const missing = verification(); delete missing.checks.receiptBytes;
    expect(() => publicVerification(missing)).toThrow('RESTORE_VERIFICATION_INCOMPLETE');
    expect(() => publicVerification({ ...verification(), password: 'private' })).toThrow('RESTORE_VERIFICATION_INCOMPLETE');
    expect(() => publicVerification({ ...verification(), checkerIssues: 1 })).toThrow('RESTORE_VERIFICATION_INCOMPLETE');
    expect(() => publicVerification({ ...verification(), checks: { ...verification().checks, operationReplay: false } })).toThrow('RESTORE_VERIFICATION_INCOMPLETE');
  });
  it('CLI rejects a cloud selection before creating an Emulator process', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rehearse-restore.ts', '--project', 'production-private'], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('RESTORE_REHEARSAL_FAILED');
    expect(result.stderr).not.toContain('production-private');
    expect(result.stdout).toBe('');
  });
  it('refuses an existing report before starting a rehearsal and preserves its contents', async () => {
    const f = await fixture(), report = join(f.directory, 'report.json');
    await writeFile(report, 'existing-evidence');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rehearse-restore.ts', '--report-file', report], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('RESTORE_REPORT_EXISTS');
    expect(result.stdout).toBe('');
    expect(await readFile(report, 'utf8')).toBe('existing-evidence');
  });
});
