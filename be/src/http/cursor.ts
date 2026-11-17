import { createHmac, timingSafeEqual } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { ApiError } from '../http.js';

const pointSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  value: z.union([z.string().min(1).max(64), z.strictObject({
    seconds: z.int().nonnegative(), nanoseconds: z.int().min(0).max(999_999_999),
  })]),
});
const payloadSchema = z.strictObject({
  v: z.literal(1), scope: z.string().min(1).max(512), revision: z.int().nonnegative().nullable(),
  point: pointSchema, expiresAt: z.int().positive(),
});
export type CursorPoint = z.infer<typeof pointSchema>;
export type CursorScope = {
  kind: 'trips' | 'expenses' | 'settlements' | 'activity'; uid: string; tripId?: string;
  filters: Record<string, string | null>; sort: string;
};

function secret(): string {
  const configured = process.env.CURSOR_SIGNING_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.FIRESTORE_EMULATOR_HOST) return 'sharebill-emulator-only-cursor-signing-key';
  throw new Error('CURSOR_SIGNING_SECRET must contain at least 32 characters.');
}

function scopeString(scope: CursorScope): string {
  return JSON.stringify({ kind: scope.kind, uid: scope.uid, tripId: scope.tripId ?? null,
    filters: Object.fromEntries(Object.entries(scope.filters).sort(([a], [b]) => a.localeCompare(b))), sort: scope.sort });
}

function invalid(): never {
  throw new ApiError(400, 'INVALID_CURSOR', 'Con trỏ phân trang không hợp lệ.');
}

export function encodeCursor(scope: CursorScope, revision: number | null, point: CursorPoint): string {
  const payload = Buffer.from(JSON.stringify(payloadSchema.parse({ v: 1, scope: scopeString(scope), revision,
    point, expiresAt: Date.now() + 24 * 60 * 60 * 1000 }))).toString('base64url');
  const signature = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function decodeCursor(token: string, scope: CursorScope, revision: number | null): CursorPoint {
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) invalid();
  const [body, signature] = token.split('.');
  const expected = createHmac('sha256', secret()).update(body!).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature!, 'base64url'); }
  catch { return invalid(); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) invalid();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')); }
  catch { return invalid(); }
  const parsed = payloadSchema.safeParse(value);
  if (!parsed.success || parsed.data.expiresAt < Date.now() || parsed.data.scope !== scopeString(scope)) invalid();
  if (parsed.data.revision !== revision) throw new ApiError(409, 'CURSOR_STALE', 'Danh sách đã thay đổi. Hãy tải lại từ đầu.');
  return parsed.data.point;
}

export function cursorValue(value: CursorPoint['value']): string | Timestamp {
  return typeof value === 'string' ? value : new Timestamp(value.seconds, value.nanoseconds);
}

export function timestampPoint(value: Timestamp, id: string): CursorPoint {
  return { id, value: { seconds: value.seconds, nanoseconds: value.nanoseconds } };
}
