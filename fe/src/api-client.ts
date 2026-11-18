import { pendingStorageKey, readPending, requestFingerprint, writePending, type PendingOperation } from './pending-operations';

const sessionKey = 'sharebill-live-session-v1';

type User = { uid: string; displayName: string; email: string };
type Tokens = { accessToken: string; refreshToken: string; expiresIn: number; user: User };
export type Session = Omit<Tokens, 'expiresIn'> & { expiresAt: number };
type RequestOptions = { method?: 'POST' | 'PATCH'; body?: unknown; token?: string; key?: string; version?: number };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export function baseUrl() {
  const configured = process.env.NEXT_PUBLIC_SHAREBILL_API_URL;
  if (configured) return configured.replace(/\/$/, '');
  return ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:3001' : 'https://sharebill-api-staging.vercel.app';
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(baseUrl() + '/api/v1' + path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
        ...(options.token && { Authorization: 'Bearer ' + options.token }),
        ...(options.key && { 'Idempotency-Key': options.key }),
        ...(options.version !== undefined && { 'If-Match': '"' + options.version + '"' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApiError('Kết nối với máy chủ bị gián đoạn. Hãy thử lại.', 0);
  }
  const envelope = await response.json().catch(() => null) as { data?: T; error?: { message?: string; code?: string } } | null;
  if (!response.ok) throw new ApiError(envelope?.error?.message ?? 'Yêu cầu chưa thành công. Hãy thử lại.', response.status, envelope?.error?.code);
  if (envelope?.data === undefined) throw new ApiError('Máy chủ trả về dữ liệu không hợp lệ.', 502);
  return envelope.data;
}

export function readSession(): Session | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null') as Session | null;
    return saved?.accessToken && saved.refreshToken && saved.user?.uid && Number.isFinite(saved.expiresAt) ? saved : null;
  } catch {
    return null;
  }
}

function sessionFrom(tokens: Tokens): Session {
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: tokens.user, expiresAt: Date.now() + tokens.expiresIn * 1000 };
}

export type Page<T> = { items: T[]; nextCursor: string | null };
export type CompletedOperation = { status: 'completed'; tripId: string | null; resourceId: string; resourceType: string };

export class ShareBillApi {
  private current: Session | null = null;
  private refreshing?: Promise<Session>;
  private commandKeys = new Map<string, string>();
  private operations: PendingOperation[] = [];
  private journalPersistent = true;
  private listeners = new Set<() => void>();

  constructor(private onSession: (session: Session | null) => void, private onSessionLost?: (uid: string, message: string) => void) {}

  private expire(session: Session, cause: ApiError) {
    if (this.current !== session) return;
    this.onSessionLost?.(session.user.uid, cause.code === 'ACCOUNT_DISABLED' ? cause.message : 'Phiên đã hết hạn. Vui lòng đăng nhập lại.');
    this.setSession(null);
  }

  setSession(session: Session | null) {
    if (this.current?.user.uid !== session?.user.uid) {
      this.commandKeys.clear();
      this.refreshing = undefined;
      this.operations = session ? readPending(pendingStorageKey(baseUrl(), session.user.uid)) : [];
      this.journalPersistent = true;
      this.notifyPending();
    }
    this.current = session;
    this.onSession(session);
    try {
      if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session));
      else sessionStorage.removeItem(sessionKey);
    } catch { /* The current tab can still hold an in-memory session. */ }
  }

  pending = () => this.operations;
  recoveryPersisted = () => this.journalPersistent;
  subscribePending = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notifyPending() {
    this.listeners.forEach(listener => listener());
  }

  private savePending(uid: string, transform: (entries: PendingOperation[]) => PendingOperation[]) {
    const storageKey = pendingStorageKey(baseUrl(), uid);
    const active = this.current?.user.uid === uid;
    const entries = transform(active ? this.operations : readPending(storageKey));
    const saved = writePending(storageKey, entries);
    if (active) {
      this.operations = entries;
      this.journalPersistent = saved;
      this.notifyPending();
    }
  }

  async checkOperation(key: string) {
    return this.read<CompletedOperation>('/operations/' + encodeURIComponent(key));
  }

  acknowledgeOperation(key: string) {
    const uid = this.current?.user.uid;
    if (uid) this.savePending(uid, entries => entries.filter(entry => entry.key !== key));
  }

  async signIn(email: string, password: string, displayName?: string) {
    const tokens = await request<Tokens>(displayName ? '/auth/register' : '/auth/login', {
      method: 'POST', body: { email, password, ...(displayName && { displayName }) },
    });
    this.setSession(sessionFrom(tokens));
  }

  private async token(force = false, sentToken?: string) {
    const session = this.current;
    if (!session) throw new ApiError('Vui lòng đăng nhập lại.', 401);
    if (force ? sentToken !== session.accessToken : session.expiresAt > Date.now() + 60_000) return session.accessToken;
    if (!this.refreshing) {
      const refresh = request<Tokens>('/auth/refresh', { method: 'POST', body: { refreshToken: session.refreshToken } })
        .then(result => {
          if (this.current !== session) throw new ApiError('Phiên đăng nhập đã thay đổi.', 401);
          const next = sessionFrom(result);
          this.setSession(next);
          return next;
        })
        .catch((cause: unknown) => {
          if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) this.expire(session, cause);
          throw cause;
        })
        .finally(() => { if (this.refreshing === refresh) this.refreshing = undefined; });
      this.refreshing = refresh;
    }
    return (await this.refreshing).accessToken;
  }

  async read<T>(path: string, body?: object): Promise<T> {
    return this.authorized<T>(path, body === undefined ? {} : { method: 'POST', body });
  }

  async page<T>(path: string, query: Record<string, string | undefined>, cursor?: string): Promise<Page<T>> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) if (value) params.set(name, value);
    if (cursor) params.set('cursor', cursor);
    return this.read<Page<T>>(path + '?' + params.toString());
  }

  private async authorized<T>(path: string, options: RequestOptions): Promise<T> {
    const uid = this.current?.user.uid;
    const token = await this.token();
    const session = this.current;
    if (session?.user.uid !== uid) throw new ApiError('Phiên đăng nhập đã thay đổi.', 401);
    try {
      return await request<T>(path, { ...options, token });
    } catch (cause) {
      if (!(cause instanceof ApiError) || !session || this.current?.user.uid !== uid) throw cause;
      if (cause.code === 'ACCOUNT_DISABLED') this.expire(session, cause);
      if (cause.status !== 401) throw cause;
      const refreshedToken = await this.token(true, token);
      const refreshed = this.current;
      if (!refreshed || refreshed.user.uid !== uid) throw cause;
      try {
        return await request<T>(path, { ...options, token: refreshedToken });
      } catch (retry) {
        if (retry instanceof ApiError && (retry.status === 401 || retry.code === 'ACCOUNT_DISABLED')) this.expire(refreshed, retry);
        throw retry;
      }
    }
  }

  async write<T>(path: string, body: object, options: { method?: 'POST' | 'PATCH'; version?: number; key?: string } = {}): Promise<T> {
    const method = options.method ?? 'POST';
    const requestData = [method, path, options.version, body];
    const uid = this.current?.user.uid;
    if (!uid) throw new ApiError('Vui lòng đăng nhập lại.', 401);
    const fingerprint = options.key ? undefined : await requestFingerprint(requestData);
    if (this.current?.user.uid !== uid) throw new ApiError('Phiên đăng nhập đã thay đổi.', 401);
    const signature = fingerprint ?? JSON.stringify(requestData);
    const previous = fingerprint && this.operations.find(entry => entry.fingerprint === fingerprint);
    const key = options.key ?? (previous ? previous.key : undefined) ?? this.commandKeys.get(signature) ?? operationId();
    if (!options.key) this.commandKeys.set(signature, key);
    if (fingerprint && !previous) this.savePending(uid, entries => [...entries, { key, fingerprint, startedAt: Date.now() }]);
    if (!fingerprint && !options.key && this.journalPersistent) {
      this.journalPersistent = false;
      this.notifyPending();
    }
    const forget = () => {
      if (this.current?.user.uid === uid) this.commandKeys.delete(signature);
      if (fingerprint) this.savePending(uid, entries => entries.filter(entry => entry.key !== key));
    };
    try {
      const result = await this.authorized<T>(path, { method, body, key, version: options.version });
      forget();
      return result;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status) &&
          !(previous && [401, 403, 404].includes(cause.status)) && cause.code !== 'PROCESSING_IN_PROGRESS') forget();
      throw cause;
    }
  }
}

export function operationId() {
  // randomUUID requires a secure context; getRandomValues also works on local LAN previews.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
}
