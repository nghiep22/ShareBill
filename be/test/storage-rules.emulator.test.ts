import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';
import { receiptBucket } from '../src/firebase.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST);
if (enabled) {
  process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill'; process.env.FIREBASE_WEB_API_KEY ??= 'demo';
  process.env.FIREBASE_STORAGE_BUCKET ??= 'demo-sharebill.appspot.com';
}
describe.skipIf(!enabled)('Storage client deny rules', () => {
  it('denies reads and writes for an authenticated client while server object access works', async () => {
    const app = await buildApp(Fastify({ logger: false }));
    const objectPath = `receipt-processed/rules-test/${randomUUID()}.jpg`;
    try {
      const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
        email: `rules-${randomUUID()}@example.test`, password: 'TestPassword-123!', displayName: 'Rules test' } });
      expect(registered.statusCode).toBe(201);
      const bucket = receiptBucket(), file = bucket.file(objectPath);
      await file.save(Buffer.from('synthetic-private-bytes'), { resumable: false, metadata: { contentType: 'image/jpeg' } });
      expect((await file.download())[0].toString()).toBe('synthetic-private-bytes');
      const base = `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}/v0/b/${bucket.name}/o`;
      const headers = { authorization: `Bearer ${registered.json().data.accessToken}` };
      const deniedRead = await fetch(`${base}/${encodeURIComponent(objectPath)}?alt=media`, { headers });
      expect(deniedRead.status).toBe(403);
      const deniedWrite = await fetch(`${base}?uploadType=media&name=${encodeURIComponent(`receipt-staging/rules-${randomUUID()}/original`)}`,
        { method: 'POST', headers: { ...headers, 'content-type': 'image/png' }, body: Buffer.from('not-allowed') });
      expect(deniedWrite.status).toBe(403);
    } finally {
      await receiptBucket().file(objectPath).delete({ ignoreNotFound: true });
      await app.close();
    }
  }, 30_000);
});
