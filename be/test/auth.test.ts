import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/create-app.js';

beforeEach(() => { vi.stubEnv('FIREBASE_WEB_API_KEY', 'demo'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const payload = (action: string) => action === 'refresh' ? { refreshToken: 'fixture-refresh' } :
  action === 'password-reset' ? { email: 'person@example.test' } : { email: 'person@example.test', password: 'Fixture-123!' };
async function call(action: string, body = payload(action)) {
  const app = await buildApp(Fastify({ logger: false }));
  try { return await app.inject({ method: 'POST', url: '/api/v1/auth/' + action, payload: body }); }
  finally { await app.close(); }
}
function upstream(status: number, code: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: code } }), { status }));
}

describe('authentication failure handling', () => {
  it.each(['login', 'refresh', 'password-reset'])('keeps %s service failures retryable even when the upstream body names credentials', async action => {
    upstream(503, 'INVALID_REFRESH_TOKEN');
    const response = await call(action);
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('AUTH_UNAVAILABLE');
  });
  it.each(['login', 'refresh'])('does not invalidate a session or blame credentials for an unknown %s failure', async action => {
    upstream(400, 'UNEXPECTED_PROVIDER_FAILURE');
    const response = await call(action);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('UNEXPECTED_PROVIDER_FAILURE');
  });
  it.each([
    ['login', 'INVALID_LOGIN_CREDENTIALS', 401, 'INVALID_CREDENTIALS'],
    ['login', 'INVALID_PASSWORD', 401, 'INVALID_CREDENTIALS'],
    ['refresh', 'INVALID_REFRESH_TOKEN', 401, 'INVALID_REFRESH_TOKEN'],
    ['refresh', 'TOKEN_EXPIRED', 401, 'INVALID_REFRESH_TOKEN'],
    ['refresh', 'USER_NOT_FOUND', 401, 'INVALID_REFRESH_TOKEN'],
    ['login', 'USER_DISABLED', 403, 'ACCOUNT_DISABLED'],
    ['refresh', 'USER_DISABLED', 403, 'ACCOUNT_DISABLED'],
  ])('maps a known %s failure %s to the intended response', async (action, code, status, apiCode) => {
    upstream(400, code as string);
    const response = await call(action as string);
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(apiCode);
  });
  it('preserves provider throttling as a retryable response', async () => {
    upstream(429, 'UNKNOWN');
    const response = await call('password-reset');
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('password reset requests', () => {
  it('requests a Vietnamese reset email, normalizes the address and returns only an acknowledgement', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ email: 'person@example.test' })));
    const response = await call('password-reset', { email: ' PERSON@EXAMPLE.TEST ' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { accepted: true } });
    expect(response.headers['cache-control']).toBe('private, no-store');
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain('/accounts:sendOobCode?key=demo');
    expect(JSON.parse(options!.body as string)).toEqual({ requestType: 'PASSWORD_RESET', email: 'person@example.test' });
    expect(options!.headers).toMatchObject({ 'X-Firebase-Locale': 'vi' });
  });
  it.each(['EMAIL_NOT_FOUND', 'USER_DISABLED'])('does not disclose %s when requesting a reset', async code => {
    upstream(400, code);
    const response = await call('password-reset');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { accepted: true } });
  });
  it.each([{ email: 'invalid' }, { email: 'person@example.test', continueUrl: 'https://untrusted.example' }])('rejects an invalid or extended request before sending anything', async body => {
    const fetcher = upstream(200, 'UNUSED');
    const response = await call('password-reset', body);
    expect(response.statusCode).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
