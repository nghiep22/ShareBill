import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Firestore } from 'firebase-admin/firestore';
import { checkDatabase } from '../src/database/check-integrity.js';
import { applyProjectionRepair, parseProjectionRepairPlan, prepareProjectionRepair, ProjectionRepairError, requireRepairScope } from '../src/services/projection-repair.js';

const usage = `db:repair --project <demo-project-id> --trip <uuid> [--plan-out <private-file>]
db:repair --project <demo-project-id> --trip <uuid> --apply --plan <private-file> --actor <operator-uid> --reason <reason>
Optional --database <database-id> selects a named Emulator database; default is (default).
Dry-run by default. Local loopback Emulator only. Apply requires a suspended trip and an active operator.
The plan file contains private source/projection snapshots; keep it outside Git and public artifacts.`;
const invalid = () => { throw new ProjectionRepairError('REPAIR_INVALID_ARGUMENTS'); };
try {
  const { values } = parseArgs({ options: {
    project: { type: 'string' }, trip: { type: 'string' }, database: { type: 'string', default: '(default)' }, 'plan-out': { type: 'string' },
    plan: { type: 'string' }, actor: { type: 'string' }, reason: { type: 'string' },
    apply: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) process.stdout.write(usage + '\n');
  else {
    if (existsSync('.env')) process.loadEnvFile('.env');
    if (!values.project || !values.trip) invalid();
    const projectId = values.project!, tripId = values.trip!, databaseId = values.database, scope = { projectId, databaseId };
    const host = requireRepairScope(projectId);
    if (values.apply) {
      if (!values.plan || !values.actor || !values.reason || values['plan-out']) invalid();
      const size = (await stat(values.plan!)).size;
      if (size > 2 * 1024 * 1024) invalid();
      const plan = parseProjectionRepairPlan(JSON.parse(await readFile(values.plan!, 'utf8')));
      if (plan.tripId !== tripId || plan.projectId !== projectId || plan.databaseId !== databaseId) invalid();
      const result = await applyProjectionRepair(scope, plan, values.actor!, values.reason!);
      const store = new Firestore({ projectId, databaseId, host, ssl: false });
      try {
        const verification = (await checkDatabase(store, { tripId, pageSize: 100 })).summary;
        process.stdout.write(JSON.stringify({ projectId, databaseId, target: 'emulator', apply: true, ...result, verification }) + '\n');
        if (verification.tripsChecked !== 1 || verification.issueCount) process.exitCode = 1;
      } finally { await store.terminate(); }
    } else {
      if (values.plan || values.actor || values.reason) invalid();
      const plan = await prepareProjectionRepair(scope, tripId);
      if (values['plan-out']) await writeFile(values['plan-out'], JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
      process.stdout.write(JSON.stringify({ projectId, databaseId, target: 'emulator', apply: false, tripId,
        planId: plan.id, digest: plan.digest, expectedRevision: plan.expectedRevision, expectedLedgerVersion: plan.expectedLedgerVersion,
        maintenance: plan.maintenance, changedDocuments: plan.changes.length, changes: plan.changes,
        planSaved: Boolean(values['plan-out']) }) + '\n');
    }
  }
} catch (error) {
  const code = error instanceof ProjectionRepairError ? error.code : 'REPAIR_FAILED';
  process.stderr.write(code + '\n' + usage + '\n');
  process.exitCode = 2;
}
