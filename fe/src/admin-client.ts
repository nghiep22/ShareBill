import { getApp, getApps, initializeApp } from 'firebase/app';
import { browserPopupRedirectResolver, connectAuthEmulator, getAuth, GoogleAuthProvider, inMemoryPersistence, initializeAuth, signInWithPopup, signOut } from 'firebase/auth';
import { ApiError, operationId } from './api-client';
import { pendingStorageKey, readPending, requestFingerprint, writePending } from './pending-operations';

function adminAuth() {
  const local = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || (local ? 'demo' : '');
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || (local ? 'demo-sharebill' : '');
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || (local ? 'demo-sharebill.firebaseapp.com' : '');
  if (!apiKey || !projectId || !authDomain) throw new Error('Đăng nhập quản trị chưa được cấu hình.');
  const name = 'sharebill-admin';
  const exists = getApps().some(app => app.name === name);
  const app = exists ? getApp(name) : initializeApp({ apiKey, projectId, authDomain }, name);
  const auth = exists ? getAuth(app) : initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
  if (!exists && local && projectId.startsWith('demo-')) connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  return auth;
}

export class AdminClient {
  private keys = new Map<string, string>();
  async login() {
    const auth = adminAuth();
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
    await this.read('/me');
  }
  async logout() {
    this.keys.clear();
    await signOut(adminAuth());
  }
  async read<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }
  async write(path: string, body: object, version: number, method = 'POST') {
    const signature = JSON.stringify([path, body, version, method]);
    const uid = adminAuth().currentUser?.uid;
    if (!uid) throw new ApiError('Đăng nhập quản trị để tiếp tục.', 401);
    const fingerprint = await requestFingerprint([path, body, version, method]);
    const storageKey = pendingStorageKey('admin:' + window.location.origin, uid);
    const stored = readPending(storageKey);
    const prior = fingerprint ? stored.find(entry => entry.fingerprint === fingerprint) : undefined;
    const key = prior?.key ?? this.keys.get(signature) ?? operationId();
    this.keys.set(signature, key);
    if (fingerprint && !prior) writePending(storageKey, [...stored, { key, fingerprint, startedAt: Date.now() }]);
    const forget = () => {
      this.keys.delete(signature);
      writePending(storageKey, readPending(storageKey).filter(entry => entry.key !== key));
    };
    try {
      const data = await this.request(path, { method, body, version, key });
      forget();
      return data;
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 0 || cause.status >= 500)) {
        try {
          const saved = await this.read('/operations/' + key);
          forget();
          return saved;
        } catch { /* Keep the key for an identical retry after reauthentication. */ }
      }
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 &&
        ![401, 403, 408, 429].includes(cause.status)) forget();
      throw cause;
    }
  }
  private async request<T>(path: string, options: { method?: string; body?: object; version?: number; key?: string } = {}): Promise<T> {
    const user = adminAuth().currentUser;
    if (!user) throw new ApiError('Đăng nhập quản trị để tiếp tục.', 401);
    const token = await user.getIdToken();
    const configured = process.env.NEXT_PUBLIC_SHAREBILL_API_URL;
    const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const origin = configured || (local ? 'http://localhost:3001' : 'https://sharebill-api-staging.vercel.app');
    let response: Response;
    try {
      response = await fetch(origin.replace(/\/$/, '') + '/api/admin/v1' + path, {
        method: options.method ?? 'GET', cache: 'no-store', signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'Bearer ' + token, ...(options.body && { 'Content-Type': 'application/json' }),
          ...(options.key && { 'Idempotency-Key': options.key }), ...(options.version && { 'If-Match': '"' + options.version + '"' }) },
        body: options.body && JSON.stringify(options.body),
      });
    } catch { throw new ApiError('Chưa xác định kết quả. Kiểm tra dữ liệu trước khi gửi lại cùng nội dung.', 0); }
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(result?.error?.message ?? 'Yêu cầu chưa thành công.', response.status, result?.error?.code);
    if (result?.data === undefined) throw new ApiError('Phản hồi quản trị chưa hợp lệ.', 502);
    return result.data;
  }
}
