import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { registerRoutes } from './routes.js';
import { registerFinanceRoutes } from './finance-routes.js';
import { registerReadRoutes } from './read-routes.js';
import { registerManagementRoutes } from './management-routes.js';
import { registerInviteRoutes } from './invite-routes.js';
import { registerMembershipRoutes } from './membership-routes.js';
import { registerLedgerRoutes } from './ledger-routes.js';
import { registerReceiptRoutes } from './receipt-routes.js';
import { ReceiptService } from './services/receipts.js';
import { sendError } from './http.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerItineraryRoutes } from './itinerary-routes.js';
import { registerSupportRoutes } from './support-routes.js';
import { registerAdminRoutes } from './admin-routes.js';
import { releaseIdentity } from './release.js';
import { createServer } from './logging.js';

export async function buildApp(app = createServer(), options: { receipts?: ReceiptService } = {}) {
  const release = releaseIdentity();
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
    if (request.url.startsWith('/api/v1/') || request.url.startsWith('/api/admin/v1/')) reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ event: 'http.request.completed', method: request.method,
      routeTemplate: request.routeOptions.url ?? 'unmatched', statusCode: reply.statusCode,
      durationMs: reply.elapsedTime, environment: release.environment, releaseSha: release.commit }, 'request completed');
  });
  await app.register(swagger, { mode: 'static', specification: { path: specPath, baseDir: dirname(specPath) } });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
    uiConfig: { docExpansion: 'list', persistAuthorization: false },
  });
  app.setErrorHandler(sendError);
  await registerAuthRoutes(app);
  await registerRoutes(app, release);
  await registerFinanceRoutes(app);
  await registerReadRoutes(app);
  await registerManagementRoutes(app);
  await registerInviteRoutes(app);
  await registerMembershipRoutes(app);
  await registerLedgerRoutes(app);
  await registerReceiptRoutes(app, options.receipts ?? new ReceiptService());
  await registerItineraryRoutes(app);
  await registerSupportRoutes(app);
  await registerAdminRoutes(app);
  return app;
}
