import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth, db } from './firebase.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function requireUser(request: FastifyRequest): Promise<string> {
  const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Vui lòng đăng nhập.');
  let uid: string;
  try { uid = (await auth().verifyIdToken(token, true)).uid; }
  catch { throw new ApiError(401, 'UNAUTHENTICATED', 'Phiên đăng nhập không hợp lệ.'); }
  const user = await db().doc(`users/${uid}`).get();
  if (user.exists && user.get('status') === 'disabled') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
  return uid;
}

export function operationKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Thiếu mã yêu cầu hợp lệ.');
  }
  return key;
}

export function sendError(error: unknown, _request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof ApiError) {
    reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    return;
  }
  reply.log.error(error);
  reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Đã có lỗi. Vui lòng thử lại.' } });
}
