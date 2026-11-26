import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';

describe('cross-origin HTTP contract', () => {
  it('allows configured preflight methods and headers, and exposes private response headers', async () => {
    const app = await buildApp(Fastify({ logger: false }));
    try {
      for (const method of ['GET', 'POST', 'PATCH']) {
        const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/trips', headers: {
          origin: 'http://localhost:3000', 'access-control-request-method': method,
          'access-control-request-headers': 'authorization,content-type,idempotency-key,if-match',
        } });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:3000');
        expect(preflight.headers['access-control-allow-headers']).toContain('if-match');
      }
      const protectedGet = await app.inject({ method: 'GET', url: '/api/v1/trips',
        headers: { origin: 'http://localhost:3000' } });
      expect(protectedGet.statusCode).toBe(401);
      expect(protectedGet.headers['cache-control']).toBe('private, no-store');
      expect(protectedGet.headers['x-request-id']).toBeTypeOf('string');
      expect(protectedGet.headers['access-control-expose-headers']).toContain('etag');
      expect(protectedGet.headers['access-control-expose-headers']).toContain('x-request-id');
      const foreign = await app.inject({ method: 'OPTIONS', url: '/api/v1/trips', headers: {
        origin: 'https://unexpected.example', 'access-control-request-method': 'POST',
      } });
      expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    } finally { await app.close(); }
  });
  it('maps malformed JSON to a stable client error without exposing the input', async () => {
    const app = await buildApp(Fastify({ logger: false }));
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/trips',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        payload: '{"secret":"unfinished"',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_JSON');
      expect(response.body).not.toContain('secret');
      expect(response.headers['cache-control']).toBe('private, no-store');
    } finally { await app.close(); }
  });
});
