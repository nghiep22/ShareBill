import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { exportedFiles, inside, isolatedEnvironment, publicVerification, requireEvidence, RestoreRehearsalError, sha256 } from './restore-rehearsal-support.js';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'backup:rehearse [--report-file <summary.json>]\nRuns synthetic Auth/Firestore/Storage export and restore in two private local Emulator instances. Never imports into a running developer or cloud environment.';

async function reservePorts() {
  const servers = Array.from({ length: 12 }, () => createServer());
  try {
    await Promise.all(servers.map(server => new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); })));
    return servers.map(server => (server.address() as { port: number }).port);
  } finally { await Promise.all(servers.filter(server => server.listening).map(server => new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok())))); }
}
async function execute(args: string[], cwd: string, env: NodeJS.ProcessEnv, logPath: string) {
  const log = await open(logPath, 'wx', 0o600);
  try {
    await new Promise<void>((ok, fail) => {
      const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', log.fd, log.fd] });
      let timedOut = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        timedOut = true;
        if (child.pid && process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else if (child.pid) {
          try { process.kill(-child.pid, 'SIGINT'); } catch { /* Already stopped. */ }
          forceTimer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already stopped. */ } }, 3000);
        }
      };
      const timeout = setTimeout(stop, 180000);
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      const cleanup = () => { clearTimeout(timeout); clearTimeout(forceTimer); process.off('SIGINT', stop); process.off('SIGTERM', stop); };
      child.once('error', () => { cleanup(); fail(new RestoreRehearsalError('RESTORE_CHILD_START_FAILED')); });
      child.once('close', code => {
        cleanup();
        if (code === 0 && !timedOut) ok();
        else fail(new RestoreRehearsalError(timedOut ? 'RESTORE_STAGE_TIMEOUT' : 'RESTORE_STAGE_FAILED'));
      });
    });
  } finally { await log.close(); }
}

let directory: string | undefined;
try {
  const { values } = parseArgs({ options: { 'report-file': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) process.stdout.write(usage + '\n');
  else {
    if (values['report-file']) {
      let existing = false;
      try { await lstat(values['report-file']); existing = true; }
      catch (error) { requireEvidence((error as NodeJS.ErrnoException).code === 'ENOENT', 'RESTORE_REPORT_PATH_INVALID'); }
      requireEvidence(!existing, 'RESTORE_REPORT_EXISTS');
    }
    const base = join(backend, '.maintenance');
    await mkdir(base, { recursive: true });
    inside(await realpath(backend), await realpath(base));
    directory = await mkdtemp(join(base, 'restore-'));
    const runId = randomUUID(), projectId = 'demo-sb-restore-' + runId.replaceAll('-', '').slice(0, 12);
    const startedAt = Date.now(), ports = await reservePorts();
    const configFiles: Record<string, string> = {};
    for (const name of ['firestore.rules', 'firestore.indexes.json', 'storage.rules']) {
      await copyFile(join(backend, name), inside(directory, join(directory, name)));
      configFiles[name] = sha256(await readFile(join(directory, name)));
    }
    for (const [index, phase] of ['seed', 'verify'].entries()) {
      const [auth, firestore, storage, hub, logging, websocketPort] = ports.slice(index * 6, index * 6 + 6);
      const config = { firestore: { rules: './firestore.rules', indexes: './firestore.indexes.json' }, storage: { rules: './storage.rules' },
        emulators: { auth: { host: '127.0.0.1', port: auth }, firestore: { host: '127.0.0.1', port: firestore, websocketPort },
          storage: { host: '127.0.0.1', port: storage }, hub: { host: '127.0.0.1', port: hub }, logging: { host: '127.0.0.1', port: logging },
          ui: { enabled: false }, singleProjectMode: true } };
      await writeFile(join(directory, phase + '.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    }
    const context = { runId, projectId, ports, configFiles };
    await writeFile(join(directory, 'context.json'), JSON.stringify(context), { flag: 'wx', mode: 0o600 });
    const cli = join(backend, 'node_modules/firebase-tools/lib/bin/firebase.js');
    const command = 'node --import tsx ../../scripts/restore-rehearsal-phase.ts';
    const env = isolatedEnvironment(process.env, projectId, directory);
    const backup = inside(directory, join(directory, 'export'));
    process.stdout.write('Seeding a private Emulator fixture and exporting Auth, Firestore and Storage.\n');
    await execute([cli, 'emulators:exec', '--project', projectId, '--config', 'seed.json', '--only', 'auth,firestore,storage',
      '--export-on-exit', backup, '--non-interactive', command], directory, { ...env, SHAREBILL_RESTORE_PHASE: 'seed' }, join(directory, 'seed.log'));
    const exportCompletedAt = Date.now(), inventory = await exportedFiles(backup);
    await writeFile(join(directory, 'export-inventory.json'), JSON.stringify(inventory), { flag: 'wx', mode: 0o600 });
    requireEvidence((await exportedFiles(backup)).digest === inventory.digest, 'RESTORE_EXPORT_CHANGED');
    const restoreStartedAt = Date.now();
    process.stdout.write('Importing into a second private Emulator and checking restored access, ledger and receipt bytes.\n');
    await execute([cli, 'emulators:exec', '--project', projectId, '--config', 'verify.json', '--only', 'auth,firestore,storage',
      '--import', backup, '--non-interactive', command], directory, { ...env, SHAREBILL_RESTORE_PHASE: 'verify' }, join(directory, 'verify.log'));
    requireEvidence((await exportedFiles(backup)).digest === inventory.digest, 'RESTORE_EXPORT_CHANGED');
    const state = JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8'));
    const verification = publicVerification(JSON.parse(await readFile(join(directory, 'verified.json'), 'utf8')));
    requireEvidence(Number.isSafeInteger(state.checkpointAt) && state.checkpointAt >= startedAt && state.checkpointAt <= restoreStartedAt, 'RESTORE_CHECKPOINT_INVALID');
    const report = { schemaVersion: 1, kind: 'restore_rehearsal', target: 'isolated-emulators', passed: true, runId,
      completedAt: new Date().toISOString(), scope: ['auth', 'firestore-default', 'storage', 'rules', 'indexes'],
      backup: { files: inventory.files.length, bytes: inventory.files.reduce((sum, file) => sum + file.bytes, 0), digest: inventory.digest },
      configFiles, ...verification,
      timing: { totalMs: Date.now() - startedAt, exportStageMs: exportCompletedAt - startedAt,
        restoreAndVerificationMs: Date.now() - restoreStartedAt, recoveryPointAgeMs: restoreStartedAt - state.checkpointAt },
      limitation: 'Synthetic local rehearsal; no production RPO/RTO or cloud backup claim.' };
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    if (values['report-file']) await writeFile(values['report-file'], JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ ...report, artifactDirectory: directory }) + '\n');
  }
} catch (error) {
  process.stderr.write((error instanceof RestoreRehearsalError ? error.code : 'RESTORE_REHEARSAL_FAILED') + '\n' + usage + '\n');
  if (directory) process.stderr.write('Private diagnostic files: ' + directory + '\n');
  process.exitCode = 2;
}
