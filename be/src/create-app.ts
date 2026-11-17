import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { registerRoutes } from './routes.js';
import { registerFinanceRoutes } from './finance-routes.js';
import { registerReadRoutes } from './read-routes.js';
import { registerManagementRoutes } from './management-routes.js';
import { sendError } from './http.js';
import { registerAuthRoutes } from './auth-routes.js';

export async function buildApp(app = Fastify({ logger: true })) {
  const origins = (process.env.APP_ORIGIN ?? 'http://localhost:3000').split(',').map(value => value.trim()).filter(Boolean);
  const specPath = fileURLToPath(new URL('../openapi.json', import.meta.url));
  await app.register(cors, {
    origin: origins,
    methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'if-match'],
    exposedHeaders: ['etag', 'x-request-id', 'idempotency-replayed'],
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-Id', request.id);
    if (request.url.startsWith('/api/v1/')) reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  await app.register(swagger, { mode: 'static', specification: { path: specPath, baseDir: dirname(specPath) } });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
    uiConfig: { docExpansion: 'list', persistAuthorization: false },
  });
  app.setErrorHandler(sendError);
  await registerAuthRoutes(app);
  await registerRoutes(app);
  await registerFinanceRoutes(app);
  await registerReadRoutes(app);
  await registerManagementRoutes(app);
  return app;
}
