import { existsSync } from 'node:fs';
import { buildApp } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const app = await buildApp();
const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
