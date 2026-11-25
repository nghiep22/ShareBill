import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMaintenanceRoutes } from '../src/maintenance-routes.js';
import { sendError } from '../src/http.js';
import { createServer } from '../src/logging.js';
import { maintenanceSummary } from '../src/services/scheduled-maintenance.js';

const secret = 'maintenance-test-secret-'.repeat(3);
afterEach(() => vi.unstubAllEnvs());
async function fixture(result: object = { jobId: 'scheduled-maintenance', status: 'succeeded', skipped: null }) {
  const run = vi.fn().mockResolvedValue(result), app = Fastify({ logger: false });
  app.setErrorHandler(sendError);
  await registerMaintenanceRoutes(app, run);
  return { app, run };
}

describe('trusted scheduled maintenance HTTP', () => {
  it.each([undefined, '', 'short', 'a'.repeat(300), 'a'.repeat(40) + '\n'])('fails closed before worker access for invalid configuration: %j', async value => {
    vi.stubEnv('CRON_SECRET', value);
    const { app, run } = await fixture();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/internal/maintenance' });
      expect(response.statusCode).toBe(503); expect(run).not.toHaveBeenCalled();
      expect(response.headers['cache-control']).toBe('private, no-store');
    } finally { await app.close(); }
  });
  it('rejects regular Firebase tokens, spoofed cron headers, query secrets and wrong methods without invoking the worker', async () => {
    vi.stubEnv('CRON_SECRET', secret);
    const { app, run } = await fixture();
    try {
      for (const headers of [{}, { authorization: 'Bearer firebase-token' }, { authorization: 'Bearer ' + 'x'.repeat(secret.length) },
        { authorization: 'bearer ' + secret }, { 'user-agent': 'vercel-cron/1.0', 'x-vercel-cron-schedule': '0 20 * * *' }]) {
        expect((await app.inject({ method: 'GET', url: '/api/internal/maintenance', headers })).statusCode).toBe(401);
      }
      expect((await app.inject({ method: 'GET', url: '/api/internal/maintenance?secret=' + secret })).statusCode).toBe(401);
      for (const method of ['POST', 'HEAD'] as const) {
        expect((await app.inject({ method, url: '/api/internal/maintenance', headers: { authorization: 'Bearer ' + secret } })).statusCode).toBe(404);
      }
      expect(run).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('runs only a fixed authenticated scope and distinguishes execution failure from a skipped run', async () => {
    vi.stubEnv('CRON_SECRET', secret);
    const { app, run } = await fixture();
    try {
      const headers = { authorization: 'Bearer ' + secret };
      expect((await app.inject({ method: 'GET', url: '/api/internal/maintenance?limit=1000', headers })).statusCode).toBe(422);
      expect((await app.inject({ method: 'GET', url: '/api/internal/maintenance', headers, payload: { limit: 1000 } })).statusCode).toBe(422);
      expect(run).not.toHaveBeenCalled();
      const response = await app.inject({ method: 'GET', url: '/api/internal/maintenance', headers });
      expect(response.statusCode).toBe(200); expect(run).toHaveBeenCalledTimes(1);
      expect(response.body).not.toContain(secret);
      run.mockResolvedValue({ status: 'failed', summary: { authErrors: 1 } });
      expect((await app.inject({ method: 'GET', url: '/api/internal/maintenance', headers })).statusCode).toBe(503);
      run.mockResolvedValue({ status: 'skipped', skipped: 'lease-held' });
      expect((await app.inject({ method: 'GET', url: '/api/internal/maintenance', headers })).statusCode).toBe(200);
      run.mockRejectedValue(new Error('private upstream token ' + secret));
      const failed = await app.inject({ method: 'GET', url: '/api/internal/maintenance', headers });
      expect(failed.statusCode).toBe(503); expect(failed.body).not.toContain(secret); expect(failed.body).not.toContain('upstream');
    } finally { await app.close(); }
  });
  it('keeps the scheduler secret and upstream errors out of HTTP logs', async () => {
    vi.stubEnv('CRON_SECRET', secret);
    const logs: string[] = [], app = createServer({ stream: { write: text => { logs.push(text); } } });
    app.setErrorHandler(sendError);
    await registerMaintenanceRoutes(app, vi.fn().mockRejectedValue(new Error('private-' + secret)));
    try {
      await app.inject({ method: 'GET', url: '/api/internal/maintenance?secret=' + secret, headers: { authorization: 'Bearer ' + secret } });
      await app.inject({ method: 'GET', url: '/api/internal/maintenance', headers: { authorization: 'Bearer ' + secret } });
      expect(logs.join('')).not.toContain(secret); expect(logs.join('')).not.toContain('private-');
    } finally { await app.close(); }
  });
  it('allows only validated aggregate counters in admin summaries', () => {
    const summary = { authScanned: 25, authQueued: 1, authProcessed: 1, authErrors: 0,
      ledgerProcessed: 1, ledgerIssues: 0, ledgerScanErrors: 0, ledgerState: 'queued' };
    expect(maintenanceSummary(summary)).toEqual(summary);
    expect(maintenanceSummary({ ...summary, secret })).toBeNull();
    expect(maintenanceSummary({ ...summary, authProcessed: -1 })).toBeNull();
    expect(maintenanceSummary({ ...summary, ledgerState: 'sensitive-exception' })).toBeNull();
  });
});
