import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { auth, db } from './firebase.js';
import { ApiError } from './http.js';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(8).max(128);
const registerInput = z.strictObject({ email, password, displayName: z.string().trim().min(1).max(80) });
const loginInput = z.strictObject({ email, password: z.string().min(1).max(128) });
const refreshInput = z.strictObject({ refreshToken: z.string().min(1).max(4096) });

type AuthReply = { idToken: string; refreshToken: string; expiresIn: string; localId: string; email: string; displayName?: string };
type RefreshReply = { id_token: string; refresh_token: string; expires_in: string; user_id: string };
type AuthAction = 'register' | 'login' | 'refresh';

function webApiKey(): string {
  const key = process.env.FIREBASE_WEB_API_KEY;
  if (!key) throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Đăng nhập chưa được cấu hình.');
  return key;
}

function firebaseUrl(action: AuthAction): string {
  const path = action === 'refresh' ? '/securetoken.googleapis.com/v1/token' :
    `/identitytoolkit.googleapis.com/v1/accounts:${action === 'register' ? 'signUp' : 'signInWithPassword'}`;
  const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const base = emulator ? `http://${emulator}${path}` :
    action === 'refresh' ? 'https://securetoken.googleapis.com/v1/token' :
      `https://identitytoolkit.googleapis.com/v1/accounts:${action === 'register' ? 'signUp' : 'signInWithPassword'}`;
  return `${base}?key=${encodeURIComponent(webApiKey())}`;
}

function upstreamError(action: AuthAction, code: string): ApiError {
  if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER' || code === 'QUOTA_EXCEEDED') {
    return new ApiError(429, 'RATE_LIMITED', 'Thử lại sau ít phút.');
  }
  if (action === 'register') {
    if (code === 'EMAIL_EXISTS') return new ApiError(409, 'EMAIL_EXISTS', 'Email này đã được sử dụng.');
    if (code === 'WEAK_PASSWORD' || code.startsWith('WEAK_PASSWORD :') || code === 'INVALID_EMAIL') {
      return new ApiError(422, 'INVALID_INPUT', 'Email hoặc mật khẩu chưa hợp lệ.');
    }
  }
  if (action === 'login') return new ApiError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
  if (action === 'refresh') return new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Phiên đăng nhập đã hết hạn.');
  return new ApiError(503, 'AUTH_UNAVAILABLE', 'Không thể kết nối dịch vụ đăng nhập.');
}

async function callFirebase<T>(action: AuthAction, body: Record<string, unknown> | URLSearchParams): Promise<T> {
  let response: Response;
  try {
    response = await fetch(firebaseUrl(action), {
      method: 'POST',
      headers: { 'content-type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: body instanceof URLSearchParams ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Không thể kết nối dịch vụ đăng nhập.');
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Phản hồi đăng nhập không hợp lệ.'); }
  if (!response.ok) {
    const code = z.object({ error: z.object({ message: z.string() }) }).safeParse(payload);
    throw upstreamError(action, code.success ? code.data.error.message : 'UNKNOWN');
  }
  return payload as T;
}

async function profile(uid: string, userEmail: string, requestedName?: string): Promise<{ uid: string; email: string; displayName: string }> {
  const ref = db().doc(`users/${uid}`);
  const name = requestedName ?? userEmail.split('@')[0] ?? 'Người dùng';
  const result = await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.get('status') === 'disabled') {
      throw new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang tạm khóa.');
    }
    if (!snap.exists) {
      const now = new Date();
      tx.create(ref, {
        displayName: name, email: userEmail, emailLower: userEmail.toLowerCase(), status: 'active',
        moderationVersion: 1, desiredAuthDisabled: false, authSyncStatus: 'synced',
        disabledReason: null, disabledAt: null, disabledBy: null, createdAt: now, updatedAt: now,
      });
    }
    return { uid, email: userEmail, displayName: (snap.get('displayName') as string | undefined) || name };
  });
  return result;
}

function tokenData(idToken: string, refreshToken: string, expiresIn: string, user: Awaited<ReturnType<typeof profile>>) {
  if (!idToken || !refreshToken || !Number.isFinite(Number(expiresIn))) {
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Phản hồi đăng nhập không hợp lệ.');
  }
  return { data: { tokenType: 'Bearer', accessToken: idToken, refreshToken, expiresIn: Number(expiresIn), user } };
}

function noStore(reply: FastifyReply): void { reply.header('Cache-Control', 'no-store'); }

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/auth/register', async (request, reply) => {
    noStore(reply);
    const parsed = registerInput.safeParse(request.body);
    if (!parsed.success) throw new ApiError(422, 'INVALID_INPUT', 'Kiểm tra lại email, mật khẩu và tên hiển thị.');
    const body = parsed.data;
    const result = await callFirebase<AuthReply>('register', { email: body.email, password: body.password, returnSecureToken: true });
    await auth().updateUser(result.localId, { displayName: body.displayName });
    const user = await profile(result.localId, result.email, body.displayName);
    return reply.status(201).send(tokenData(result.idToken, result.refreshToken, result.expiresIn, user));
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    noStore(reply);
    const parsed = loginInput.safeParse(request.body);
    if (!parsed.success) throw new ApiError(422, 'INVALID_INPUT', 'Kiểm tra lại email và mật khẩu.');
    const result = await callFirebase<AuthReply>('login', { ...parsed.data, returnSecureToken: true });
    const user = await profile(result.localId, result.email, result.displayName || undefined);
    return tokenData(result.idToken, result.refreshToken, result.expiresIn, user);
  });

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    noStore(reply);
    const parsed = refreshInput.safeParse(request.body);
    if (!parsed.success) throw new ApiError(422, 'INVALID_INPUT', 'Thiếu refresh token.');
    const result = await callFirebase<RefreshReply>('refresh', new URLSearchParams({ grant_type: 'refresh_token', refresh_token: parsed.data.refreshToken }));
    let decoded: Awaited<ReturnType<ReturnType<typeof auth>['verifyIdToken']>>;
    try { decoded = await auth().verifyIdToken(result.id_token, true); }
    catch { throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Phiên đăng nhập đã hết hạn.'); }
    if (decoded.uid !== result.user_id) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Phiên đăng nhập đã hết hạn.');
    if (!decoded.email) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Phiên đăng nhập đã hết hạn.');
    const user = await profile(decoded.uid, decoded.email);
    return tokenData(result.id_token, result.refresh_token, result.expires_in, user);
  });
}
