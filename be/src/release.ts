type Environment = Record<string, string | undefined>;

export function releaseIdentity(env: Environment = process.env) {
  const environment = env.APP_ENVIRONMENT ?? 'local';
  const commit = env.RELEASE_COMMIT ?? env.VERCEL_GIT_COMMIT_SHA ?? null;
  const firebaseProjectId = env.FIREBASE_PROJECT_ID ?? null;
  if (!['local', 'staging', 'production'].includes(environment)) throw new Error('Invalid APP_ENVIRONMENT');
  if (environment === 'local' && (env.VERCEL || env.NODE_ENV === 'production')) {
    throw new Error('Set APP_ENVIRONMENT to staging or production for a deployed API');
  }
  if (environment !== 'local') {
    if (!commit || !/^[a-f0-9]{40}$/i.test(commit)) throw new Error('A full RELEASE_COMMIT is required');
    if (!firebaseProjectId || firebaseProjectId.startsWith('demo-')) throw new Error('A cloud FIREBASE_PROJECT_ID is required');
    if (!env.FIREBASE_WEB_API_KEY || env.FIREBASE_WEB_API_KEY === 'demo') throw new Error('A cloud FIREBASE_WEB_API_KEY is required');
    if (Object.entries(env).some(([key, value]) => value && /(?:^|_)EMULATOR_HOST$/.test(key))) {
      throw new Error('Emulator hosts are forbidden in cloud environments');
    }
    if (!env.CURSOR_SIGNING_SECRET || env.CURSOR_SIGNING_SECRET.length < 32) throw new Error('CURSOR_SIGNING_SECRET must contain at least 32 characters');
    const origins = env.APP_ORIGIN?.split(',').map(value => value.trim()).filter(Boolean);
    if (!origins?.length || origins.some(value => {
      try { const url = new URL(value); return url.protocol !== 'https:' || url.origin !== value || Boolean(url.username || url.password) ||
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost'); }
      catch { return true; }
    })) throw new Error('APP_ORIGIN must list explicit HTTPS origins');
    if (Boolean(env.FIREBASE_CLIENT_EMAIL) !== Boolean(env.FIREBASE_PRIVATE_KEY)) {
      throw new Error('Set both Firebase service account fields or use application default credentials');
    }
  }
  return { environment, commit, firebaseProjectId };
}
