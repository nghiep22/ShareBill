import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/create-app.js';

if (existsSync('.env')) process.loadEnvFile('.env');

// Seed only local emulators. Validate before Firebase Admin can initialize.
if (process.env.FIREBASE_PROJECT_ID !== 'demo-sharebill' || process.env.NODE_ENV === 'production' ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '')) {
  throw new Error('Seed requires demo-sharebill and both local 127.0.0.1 emulators.');
}
process.env.FIREBASE_WEB_API_KEY = 'demo';
const app = await buildApp();
const suffix = randomUUID();
const password = 'LocalDemo-123!';

async function call(method: 'POST' | 'GET', url: string, payload?: unknown, accessToken?: string) {
  const response = await app.inject({
    method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), 'idempotency-key': randomUUID() },
  });
  if (response.statusCode >= 400) throw new Error(`Seed failed: ${method} ${url} (${response.statusCode})`);
  return response.json().data;
}

try {
  const email = `demo-an-${suffix}@example.test`;
  const owner = await call('POST', '/api/v1/auth/register', { email, password, displayName: 'An' });
  await call('POST', '/api/v1/auth/register', { email: `demo-outsider-${suffix}@example.test`, password, displayName: 'Người ngoài nhóm' });
  const token = owner.accessToken as string;
  const trip = await call('POST', '/api/v1/trips', { name: 'Đà Lạt — dữ liệu mẫu', ownerName: 'An' }, token);
  const base = `/api/v1/trips/${trip.id}`;
  const binh = await call('POST', `${base}/participants`, { displayName: 'Bình' }, token);
  const chi = await call('POST', `${base}/participants`, { displayName: 'Chi' }, token);
  const participantIds = [trip.ownerParticipantId, binh.id, chi.id] as string[];
  for (const expense of [
    { title: 'Khách sạn', amountMinor: 900000, payerParticipantId: trip.ownerParticipantId, category: 'stay' },
    { title: 'Ăn uống', amountMinor: 300000, payerParticipantId: binh.id, category: 'food' },
  ]) {
    await call('POST', `${base}/expenses`, { ...expense, splitMethod: 'equal', split: { participantIds }, occurredOn: '2026-12-20', note: null }, token);
  }
  await call('POST', `${base}/settlements`, {
    fromParticipantId: binh.id, toParticipantId: trip.ownerParticipantId, amountMinor: 100000,
    occurredOn: '2026-12-20', note: null, basedOnLedgerVersion: 2,
  }, token);
  const overview = await call('GET', `${base}/overview`, undefined, token);
  const expected = new Map([[trip.ownerParticipantId, 500000], [binh.id, -100000], [chi.id, -400000]]);
  const categoryTotals: Record<string, number> = { food: 300000, transport: 0, stay: 900000, tickets: 0, shopping: 0, other: 0 };
  const sum = (field: string) => overview.balances.reduce((total: bigint, balance: Record<string, number>) => total + BigInt(balance[field] ?? 0), 0n);
  if (overview.trip.totalExpenseMinor !== 1200000 || overview.trip.pendingSettlementCount !== 1 ||
      Object.keys(overview.trip.categoryTotalsMinor ?? {}).length !== 6 ||
      Object.keys(categoryTotals).some(category => overview.trip.categoryTotalsMinor?.[category] !== categoryTotals[category]) ||
      overview.balances.length !== 3 || overview.balances.some((balance: { participantId: string; netMinor: number }) => expected.get(balance.participantId) !== balance.netMinor) ||
      sum('paidMinor') !== 1200000n || sum('owedMinor') !== 1200000n || sum('netMinor') !== 0n) {
    throw new Error('Seed ledger does not match expected balances.');
  }
  // JWTs and refresh tokens are deliberately omitted from the summary.
  process.stdout.write(`${JSON.stringify({ tripId: trip.id, email, totalExpenseMinor: 1200000, balances: overview.balances }, null, 2)}\n`);
} finally {
  await app.close();
}
