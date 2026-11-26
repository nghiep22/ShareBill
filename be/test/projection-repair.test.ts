import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProjectionRepairPlan, requireRepairScope } from '../src/services/projection-repair.js';

afterEach(() => vi.unstubAllEnvs());
describe('projection repair scope', () => {
  it.each([
    ['sharebill-production', '127.0.0.1:8080'], ['demo-sharebill', undefined],
    ['demo-sharebill', 'firestore.googleapis.com:443'], ['demo-sharebill', 'https://127.0.0.1:8080'],
    ['demo-sharebill', '127.0.0.1:8080/private'], ['demo-sharebill', '127.0.0.1:99999'],
  ])('refuses ambiguous or nonlocal target %s %s', (project, host) => {
    vi.stubEnv('FIREBASE_PROJECT_ID', ''); vi.stubEnv('FIRESTORE_EMULATOR_HOST', host ?? '');
    expect(() => requireRepairScope(project)).toThrow('REPAIR_EMULATOR_REQUIRED');
  });
  it('rejects a project mismatch and accepts an explicit loopback demo target', () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', 'demo-other'); vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080');
    expect(() => requireRepairScope('demo-sharebill')).toThrow('REPAIR_EMULATOR_REQUIRED');
    vi.stubEnv('FIREBASE_PROJECT_ID', 'demo-sharebill');
    expect(requireRepairScope('demo-sharebill')).toBe('127.0.0.1:8080');
  });
  it('refuses malformed and oversized saved plans', () => {
    expect(() => parseProjectionRepairPlan({ digest: 'invalid' })).toThrow('REPAIR_INVALID_PLAN');
    expect(() => parseProjectionRepairPlan({ snapshot: 'x'.repeat(2 * 1024 * 1024) })).toThrow('REPAIR_INVALID_PLAN');
  });
  it('CLI blocks a cloud request before any network call and prints no input reason or raw exception', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/repair-projections.ts', '--project', 'sharebill-production',
      '--trip', '11111111-1111-4111-8111-111111111111', '--apply', '--reason', 'private-cli-reason'], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, FIREBASE_PROJECT_ID: '', FIRESTORE_EMULATOR_HOST: '' },
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('REPAIR_EMULATOR_REQUIRED');
    expect(result.stderr).not.toContain('private-cli-reason');
    expect(result.stdout).toBe('');
  });
});
