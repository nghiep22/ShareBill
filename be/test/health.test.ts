import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';

describe('HTTP', () => {
  it('serves health without Firebase credentials', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'sharebill-be', release: { environment: 'local' } });
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('allows the app origin to send If-Match on versioned mutations', async () => {
    const app = await buildApp();
    const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/trips/trip/expenses/expense/void',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type,idempotency-key,if-match',
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['access-control-allow-headers']).toContain('if-match');
    } finally {
      await app.close();
    }
  });
});
