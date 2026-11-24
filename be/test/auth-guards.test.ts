import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/create-app.js';

const verify = vi.hoisted(() => vi.fn());
vi.mock('../src/firebase.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/firebase.js')>(),
  auth: () => ({ verifyIdToken: verify }),
}));
beforeEach(() => {
  vi.stubEnv('FIREBASE_WEB_API_KEY', 'demo');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    id_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_in: '3600', user_id: 'fixture-user',
  })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); verify.mockReset(); });

describe('token verification outages', () => {
  it('treats a malformed successful refresh reply as a service failure before verifying any token', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ unexpected: true })));
    const app = await buildApp(Fastify({ logger: false }));
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: 'fixture-refresh' } });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('AUTH_UNAVAILABLE');
      expect(verify).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each(['/api/v1/trips', '/api/admin/v1/me', '/api/v1/auth/refresh'])('distinguishes service outages from invalid sessions at %s', async url => {
    const app = await buildApp(Fastify({ logger: false }));
    try {
      for (const [code, status] of [
        ['auth/internal-error', 503], ['auth/insufficient-permission', 503], ['auth/invalid-credential', 503],
        ['auth/id-token-expired', 401], ['auth/id-token-revoked', 401], ['auth/argument-error', 401],
        ['auth/user-disabled', 403], ['auth/too-many-requests', 429],
      ] as const) {
        verify.mockRejectedValueOnce(Object.assign(new Error('private provider response'), { code }));
        const response = await app.inject({ method: url.endsWith('/refresh') ? 'POST' : 'GET', url,
          headers: { authorization: 'Bearer fixture-token' }, ...(url.endsWith('/refresh') && { payload: { refreshToken: 'fixture-refresh' } }) });
        expect(response.statusCode, code).toBe(status);
        expect(response.body).not.toContain('private provider response');
        if (status === 503) expect(response.json().error.code).toBe('AUTH_UNAVAILABLE');
      }
    } finally { await app.close(); }
  });
});
