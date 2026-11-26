import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/create-app.js';

const enabled = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST);
if (enabled) {
  process.env.FIREBASE_PROJECT_ID ??= 'demo-sharebill';
  process.env.FIREBASE_WEB_API_KEY ??= 'demo';
}

describe.skipIf(!enabled)('password recovery with Firebase Auth Emulator', () => {
  it('resets the password through an email action and signs back into the same account', async () => {
    const app = await buildApp();
    const email = 'recovery-' + randomUUID() + '@example.test';
    const originalPassword = 'Original-Password-123!';
    const newPassword = 'Recovered-Password-456!';
    try {
      const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
        payload: { email, password: originalPassword, displayName: 'Recovery fixture' } });
      expect(registered.statusCode).toBe(201);
      const uid = registered.json().data.user.uid;
      const reset = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset', payload: { email: email.toUpperCase() } });
      const unknown = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset', payload: { email: randomUUID() + '@example.test' } });
      expect(reset.statusCode).toBe(200);
      expect(unknown.json()).toEqual(reset.json());
      const host = 'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST;
      const codes = await fetch(host + '/emulator/v1/projects/' + process.env.FIREBASE_PROJECT_ID + '/oobCodes');
      const { oobCodes } = await codes.json() as { oobCodes: { email: string; requestType: string; oobCode: string }[] };
      const code = oobCodes.find(item => item.email === email && item.requestType === 'PASSWORD_RESET');
      expect(code).toBeDefined();
      const changed = await fetch(host + '/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=demo', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobCode: code!.oobCode, newPassword }),
      });
      expect(changed.status).toBe(200);
      const oldLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: originalPassword } });
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: newPassword } });
      expect(newLogin.statusCode).toBe(200);
      expect(newLogin.json().data.user.uid).toBe(uid);
      const replay = await fetch(host + '/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=demo', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobCode: code!.oobCode, newPassword }),
      });
      expect(replay.status).toBe(400);
    } finally { await app.close(); }
  }, 30_000);
});
