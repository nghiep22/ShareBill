import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { createServer } from '../src/logging.js';
import { ApiError } from '../src/http.js';

describe('operational HTTP logs', () => {
  it('keeps route, status, duration and response request ID while excluding headers, body, parameters and error text', async () => {
    const lines: string[] = [];
    const app = await buildApp(createServer({ stream: { write: line => { lines.push(line); } } }));
    const secret = 'private-fixture-83719';
    app.post('/log-fixture/:uid', async request => {
      request.log.info({ body: request.body, headers: request.headers, req: request }, 'private log ' + secret);
      throw Object.assign(new Error('upstream password ' + secret), { code: 14, cause: { token: secret } });
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/log-fixture/' + secret + '?email=' + secret,
        headers: { authorization: 'Bearer ' + secret, cookie: 'session=' + secret, 'x-request-id': secret },
        payload: { password: secret, refreshToken: secret, token: secret, note: secret, message: secret } });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain(secret);
      const output = lines.join('');
      expect(output).not.toContain(secret);
      const records = lines.map(line => JSON.parse(line));
      const completed = records.find(record => record.event === 'http.request.completed');
      expect(completed).toMatchObject({ method: 'POST', routeTemplate: '/log-fixture/:uid', statusCode: 500,
        environment: 'local', requestId: response.headers['x-request-id'] });
      expect(completed.durationMs).toBeGreaterThanOrEqual(0);
      expect(records.find(record => record.event === 'http.request.failed').errorCode).toBe('GRPC_UNAVAILABLE');
    } finally { await app.close(); }
  });

  it('sanitizes framework not-found logs and malformed JSON without logging the raw URL or parser diagnostics', async () => {
    const lines: string[] = [];
    const app = await buildApp(createServer({ stream: { write: line => { lines.push(line); } } }));
    try {
      expect((await app.inject('/unknown/private-fixture-404?email=private@example.test')).statusCode).toBe(404);
      expect((await app.inject('/api/admin/v1/users?email=private@example.test')).statusCode).toBe(401);
      const malformed = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' },
        payload: '{"password":"private-fixture-parser"' });
      expect(malformed.statusCode).toBe(400);
      expect(lines.join('')).not.toMatch(/private-fixture|private@example/);
    } finally { await app.close(); }
  });

  it('does not trust caller request IDs and generates unique IDs across server instances', async () => {
    const servers = await Promise.all([buildApp(createServer({ stream: { write() {} } })), buildApp(createServer({ stream: { write() {} } }))]);
    try {
      const ids = await Promise.all(servers.map(async app => (await app.inject({ method: 'GET', url: '/health',
        headers: { 'x-request-id': 'caller-private-value' } })).headers['x-request-id']));
      expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);
      expect(ids[0]).not.toBe(ids[1]);
    } finally { await Promise.all(servers.map(app => app.close())); }
  });

  it('retains known invariant codes without logging the private error message', async () => {
    const lines: string[] = [];
    const app = await buildApp(createServer({ stream: { write: line => { lines.push(line); } } }));
    app.get('/invariant-fixture', async () => { throw new ApiError(500, 'BALANCE_INVARIANT_FAILED', 'private-fixture-balance'); });
    try {
      expect((await app.inject('/invariant-fixture')).statusCode).toBe(500);
      expect(lines.join('')).not.toContain('private-fixture-balance');
      expect(lines.map(line => JSON.parse(line)).some(record => record.errorCode === 'BALANCE_INVARIANT_FAILED')).toBe(true);
    } finally { await app.close(); }
  });

  it('keeps logging usable when an upstream error has a throwing property getter', async () => {
    const lines: string[] = [];
    const app = createServer({ stream: { write: line => { lines.push(line); } } });
    try {
      const failure = Object.defineProperty(new Error('private-fixture-getter'), 'code', { get() { throw new Error('private-fixture-code'); } });
      expect(() => app.log.error(failure)).not.toThrow();
      expect(() => app.log.info({ get event() { throw new Error('private-fixture-event'); } })).not.toThrow();
      expect(lines.join('')).not.toContain('private-fixture');
      expect(lines.map(line => JSON.parse(line)).every(record => record.errorCode === 'INTERNAL_ERROR')).toBe(true);
    } finally { await app.close(); }
  });
});
