import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerRoutes } from './routes.js';
import { registerFinanceRoutes } from './finance-routes.js';
import { registerReadRoutes } from './read-routes.js';
import { sendError } from './http.js';

export async function buildApp() {
  const app = Fastify({ logger: true });
  const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
  await app.register(cors, { origin: [origin], methods: ['GET', 'POST'], allowedHeaders: ['authorization', 'content-type', 'idempotency-key'] });
  app.setErrorHandler(sendError);
  await registerRoutes(app);
  await registerFinanceRoutes(app);
  await registerReadRoutes(app);
  return app;
}
