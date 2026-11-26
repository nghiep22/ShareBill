import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSession, ShareBillApi, type Session } from '../../fe/src/api-client.js';
import { pendingStorageKey, readPending } from '../../fe/src/pending-operations.js';

const origin = 'http://localhost:3001';

function session(uid = 'account-a', accessToken = uid): Session {
  return { user: { uid, email: uid + '@example.test', displayName: uid }, accessToken,
    refreshToken: uid + '-refresh', expiresAt: Date.now() + 3_600_000 };
}

function tokens(value: Session) {
  return { ...value, expiresIn: 3600 };
}

function reply(data: unknown) {
  return new Response(JSON.stringify({ data }));
}

function failure(status: number, code: string) {
  return new Response(JSON.stringify({ error: { code, message: 'Request failed' } }), { status });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function client() {
  const changed = vi.fn(), lost = vi.fn();
  const api = new ShareBillApi(changed, lost);
  api.setSession(session());
  return { api, changed, lost };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SHAREBILL_API_URL', origin);
  const entries = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('browser session boundaries', () => {
  it.each(['account-a', 'account-b'])('discards a late read after signing back in as %s', async uid => {
    const { api, changed, lost } = client();
    const response = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(response.promise);
    const reading = api.read('/trips');
    const rejected = expect(reading).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    api.setSession(null);
    api.setSession(session(uid, 'new-login'));
    response.resolve(reply({ private: 'old account data' }));
    await rejected;
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ accessToken: 'new-login' }));
    expect(lost).not.toHaveBeenCalled();
  });

  it.each([[401, 'AUTH_REQUIRED'], [403, 'ACCOUNT_DISABLED']] as const)(
    'ignores a late %s error without refreshing or expiring the new login', async (status, code) => {
      const { api, lost } = client();
      const response = deferred<Response>();
      vi.mocked(fetch).mockReturnValueOnce(response.promise);
      const reading = api.read('/trips');
      const rejected = expect(reading).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      api.setSession(session('account-a', 'new-login'));
      response.resolve(failure(status, code));
      await rejected;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(lost).not.toHaveBeenCalled();
      expect(readSession()?.accessToken).toBe('new-login');
    },
  );

  it('shares a refresh between concurrent reads without invalidating their login', async () => {
    const { api } = client();
    api.setSession({ ...session(), expiresAt: 0 });
    const refreshed = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(refreshed.promise).mockImplementation(async () => reply(['trip']));
    const first = api.read('/trips'), second = api.read('/trips?status=archived');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    refreshed.resolve(reply(tokens(session('account-a', 'renewed'))));
    expect(await Promise.all([first, second])).toEqual([['trip'], ['trip']]);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, options] of vi.mocked(fetch).mock.calls.slice(1)) {
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer renewed' });
    }
  });

  it.each([null, 'account-a', 'account-b'])('does not restore an old refresh after the login changes to %s', async uid => {
    const { api, lost } = client();
    api.setSession({ ...session(), expiresAt: 0 });
    const response = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(response.promise);
    const reading = api.read('/trips');
    const rejected = expect(reading).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    api.setSession(uid ? session(uid, 'new-login') : null);
    response.resolve(reply(tokens(session('account-a', 'old-refresh'))));
    await rejected;
    expect(readSession()?.accessToken ?? null).toBe(uid ? 'new-login' : null);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lost).not.toHaveBeenCalled();
  });

  it.each([200, 401, 403])('discards a late retried response with status %s', async status => {
    const { api, lost } = client();
    const response = deferred<Response>();
    vi.mocked(fetch).mockResolvedValueOnce(failure(401, 'AUTH_REQUIRED'))
      .mockResolvedValueOnce(reply(tokens(session('account-a', 'refreshed'))))
      .mockReturnValueOnce(response.promise);
    const reading = api.read('/trips');
    const rejected = expect(reading).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    api.setSession(session('account-a', 'new-login'));
    response.resolve(status === 200 ? reply(['old data']) : failure(status, status === 403 ? 'ACCOUNT_DISABLED' : 'AUTH_REQUIRED'));
    await rejected;
    expect(lost).not.toHaveBeenCalled();
    expect(readSession()?.accessToken).toBe('new-login');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps a valid in-flight read when another read refreshes credentials', async () => {
    const { api } = client();
    const response = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(failure(401, 'AUTH_REQUIRED'))
      .mockResolvedValueOnce(reply(tokens(session('account-a', 'renewed'))))
      .mockResolvedValueOnce(reply(['second trip']));
    const first = api.read('/trips');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(await api.read('/trips?status=archived')).toEqual(['second trip']);
    response.resolve(reply(['first trip']));
    expect(await first).toEqual(['first trip']);
    expect(readSession()?.accessToken).toBe('renewed');
  });

  it('retains an uncertain write for the original account and reuses its key on retry', async () => {
    const { api } = client();
    const response = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(response.promise);
    const writing = api.write('/trips', { name: 'Uncertain trip' });
    const rejected = expect(writing).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const journal = pendingStorageKey(origin, 'account-a');
    const key = readPending(journal)[0]?.key;
    expect(key).toBeTruthy();
    api.setSession(session('account-b'));
    response.resolve(reply({ id: 'already-created' }));
    await rejected;
    expect(api.pending()).toEqual([]);
    expect(readPending(journal).map(entry => entry.key)).toEqual([key]);
    api.setSession(session());
    expect(api.pending().map(entry => entry.key)).toEqual([key]);
    vi.mocked(fetch).mockResolvedValueOnce(reply({ id: 'already-created' }));
    expect(await api.write('/trips', { name: 'Uncertain trip' })).toEqual({ id: 'already-created' });
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.headers).toMatchObject({ 'Idempotency-Key': key });
    expect(api.pending()).toEqual([]);
    expect(readPending(journal)).toEqual([]);
  });

  it('keeps the write journal when an interrupted refresh finishes after sign-out', async () => {
    const { api } = client();
    api.setSession({ ...session(), expiresAt: 0 });
    const response = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(response.promise);
    const writing = api.write('/trips', { name: 'Unsent trip' });
    const rejected = expect(writing).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    api.setSession(null);
    response.resolve(reply(tokens(session())));
    await rejected;
    expect(readPending(pendingStorageKey(origin, 'account-a'))).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not send a write if its login changes while its fingerprint is being prepared', async () => {
    const { api } = client();
    const digest = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
    const writing = api.write('/trips', { name: 'Must not be sent' });
    const rejected = expect(writing).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    api.setSession(session('account-a', 'new-login'));
    digest.resolve(new ArrayBuffer(32));
    await rejected;
    expect(fetch).not.toHaveBeenCalled();
    expect(api.pending()).toEqual([]);
  });

  it('does not sign back in when a login reply arrives after sign-out', async () => {
    const { api } = client();
    api.setSession(null);
    const response = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(response.promise);
    const signingIn = api.signIn('account-a@example.test', 'fixture password');
    const rejected = expect(signingIn).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    api.setSession(null);
    response.resolve(reply(tokens(session())));
    await rejected;
    expect(readSession()).toBeNull();
  });

  it('accepts only the most recently requested login', async () => {
    const { api } = client();
    api.setSession(null);
    const firstReply = deferred<Response>(), secondReply = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(firstReply.promise).mockReturnValueOnce(secondReply.promise);
    const first = api.signIn('account-a@example.test', 'fixture password');
    const rejected = expect(first).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    const second = api.signIn('account-b@example.test', 'fixture password');
    firstReply.resolve(reply(tokens(session('account-a'))));
    await rejected;
    expect(readSession()).toBeNull();
    secondReply.resolve(reply(tokens(session('account-b'))));
    await second;
    expect(readSession()?.user.uid).toBe('account-b');
  });

  it('keeps an in-memory login and retry key when the browser blocks session storage', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('Storage blocked'); },
      setItem: () => { throw new Error('Storage blocked'); },
      removeItem: () => { throw new Error('Storage blocked'); },
    });
    const { api, lost } = client();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Offline')).mockResolvedValueOnce(reply({ id: 'one-trip' }));
    await expect(api.write('/trips', { name: 'Memory only' })).rejects.toMatchObject({ status: 0 });
    expect(api.recoveryPersisted()).toBe(false);
    expect(api.pending()).toHaveLength(1);
    expect(await api.write('/trips', { name: 'Memory only' })).toEqual({ id: 'one-trip' });
    const headers = vi.mocked(fetch).mock.calls.map(([, options]) => options?.headers as Record<string, string>);
    expect(headers[0]?.['Idempotency-Key']).toBe(headers[1]?.['Idempotency-Key']);
    expect(lost).not.toHaveBeenCalled();
    expect(api.pending()).toEqual([]);
  });
});
