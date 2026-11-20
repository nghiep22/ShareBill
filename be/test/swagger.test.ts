import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';

describe('Swagger UI', () => {
  it('serves the existing API as a testable OpenAPI document', async () => {
    const app = await buildApp();
    try {
      const page = await app.inject({ method: 'GET', url: '/docs/' });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Swagger UI');

      const response = await app.inject({ method: 'GET', url: '/docs/json' });
      expect(response.statusCode).toBe(200);
      const spec = response.json();
      expect(spec.openapi).toBe('3.0.3');
      expect(spec.components.securitySchemes.BearerAuth.scheme).toBe('bearer');
      for (const [, pointer] of JSON.stringify(spec).matchAll(/"\$ref":"#\/([^\"]+)"/g)) {
        expect(pointer?.split('/').reduce((part: unknown, key: string) =>
          (part as Record<string, unknown> | undefined)?.[key], spec), `#/${pointer}`).toBeDefined();
      }

      const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
        Object.entries(methods as Record<string, unknown>).map(([method, details]) => ({ path, method, details })));
      expect(operations).toHaveLength(68);
      expect(spec.paths['/api/v1/trips/{tripId}/share-equally'].post).toBeDefined();
      for (const { path, method, details } of operations) {
        const url = path.replace(/\{([^}]+)\}/g, ':$1');
        expect(app.hasRoute({ method: method.toUpperCase(), url }), `${method.toUpperCase()} ${url}`).toBe(true);
        if ((method === 'post' || method === 'patch') && !path.endsWith('/bootstrap')) {
          expect((details as { requestBody?: unknown }).requestBody, `${method.toUpperCase()} ${path} body`).toBeDefined();
        }
        if ((method === 'post' || method === 'patch') && path.startsWith('/api/v1/trips')) {
          expect((details as { parameters: { $ref: string }[] }).parameters.some(p =>
            p.$ref === '#/components/parameters/IdempotencyKey'), `${path} key`).toBe(true);
        }
      }
    } finally {
      await app.close();
    }
  });
});
