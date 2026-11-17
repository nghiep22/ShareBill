import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/create-app.js';

const ready = buildApp().then(async app => {
  await app.ready();
  return app;
});

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  const app = await ready;
  app.server.emit('request', request, response);
}
