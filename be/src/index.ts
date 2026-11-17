import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import { buildApp } from './create-app.js';

if (process.env.NODE_ENV !== 'production' && existsSync('.env')) process.loadEnvFile('.env');
const app = await buildApp(Fastify({ logger: true }));
const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
