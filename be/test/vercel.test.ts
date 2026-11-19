import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import handler from '../api/index.js';

const server = createServer((request, response) => {
  void handler(request, response);
});
let origin: string;

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener address');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('Vercel HTTP entrypoint', () => {
  it('serves health and OpenAPI using the original request paths', async () => {
    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', service: 'sharebill-be', release: { environment: 'local' } });
    const document = await fetch(`${origin}/docs/json`);
    expect(document.status).toBe(200);
    expect(await document.json()).toMatchObject({ openapi: '3.0.3' });
  });
});
