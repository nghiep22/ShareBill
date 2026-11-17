import { auditEventSchema } from '../audit.js';
import { scanCollection, type Migration, type Plan } from './runner.js';

export const auditBaselineMigration: Migration = {
  id: 'DBM-007-audit', revision: '1',
  scan: (store, pageSize) => scanCollection(store.collection('trips'), pageSize),
  async plan(_store, ref, now): Promise<Plan> {
    const [trip, events, baseline] = await Promise.all([
      ref.get(), ref.collection('auditEvents').get(), ref.collection('migrationBaselines').doc('DBM-007-audit').get(),
    ]);
    const guards = [{ ref, updateTime: trip.updateTime ?? null },
      { ref: baseline.ref, updateTime: baseline.updateTime ?? null },
      ...events.docs.map(event => ({ ref: event.ref, updateTime: event.updateTime ?? null }))];
    if (!trip.exists) return { guards, changes: [], issues: [] };
    const legacy = events.docs.filter(event => !auditEventSchema.safeParse(event.data()).success).map(event => event.ref.path);
    if (legacy.length > 1000) return { guards, changes: [], issues: [{ code: 'AUDIT_BASELINE_LIMIT', path: ref.path }] };
    const exceptions = legacy.map(path => ({ code: 'LEGACY_AUDIT_EVENT', path }));
    if (!legacy.length && !baseline.exists) return { guards, changes: [], issues: [] };
    const previous: string[] = baseline.get('legacyEventPaths') ?? [];
    if (JSON.stringify(previous) === JSON.stringify(legacy)) return { guards, changes: [], issues: [], exceptions };
    const data = { schemaVersion: 1, migrationId: 'DBM-007-audit', tripId: ref.id,
      legacyEventCount: legacy.length, legacyEventPaths: legacy,
      limitation: 'Original actor and before/after snapshots cannot be reconstructed from legacy events.',
      createdAt: baseline.get('createdAt') ?? now, updatedAt: now };
    return { guards, changes: [{ ref: baseline.ref, data, create: !baseline.exists }], issues: [], exceptions };
  },
};
