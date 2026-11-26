import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseIdentity } from '../src/release.js';
import { GET as webRelease } from '../../fe/src/app/release.json/route.js';

const cloud = {
  APP_ENVIRONMENT: 'staging', RELEASE_COMMIT: 'a'.repeat(40), FIREBASE_PROJECT_ID: 'sharebill-staging',
  FIREBASE_WEB_API_KEY: 'synthetic-key', CURSOR_SIGNING_SECRET: 's'.repeat(32), APP_ORIGIN: 'https://web.example.test',
};

afterEach(() => vi.unstubAllEnvs());

describe('release identity and cloud configuration', () => {
  it('keeps local health usable without credentials', () => {
    expect(releaseIdentity({})).toEqual({ environment: 'local', commit: null, firebaseProjectId: null });
  });
  it('exports only public release fields', () => {
    expect(releaseIdentity(cloud)).toEqual({ environment: 'staging', commit: cloud.RELEASE_COMMIT, firebaseProjectId: 'sharebill-staging' });
    expect(releaseIdentity({ ...cloud, RELEASE_COMMIT: undefined, VERCEL_GIT_COMMIT_SHA: cloud.RELEASE_COMMIT })).toEqual(releaseIdentity(cloud));
  });
  it.each([
    { APP_ENVIRONMENT: 'preview' }, { RELEASE_COMMIT: 'abc1234' }, { FIREBASE_PROJECT_ID: 'demo-sharebill' },
    { FIREBASE_WEB_API_KEY: 'demo' }, { CURSOR_SIGNING_SECRET: 'short' }, { APP_ORIGIN: '*' },
    { APP_ORIGIN: 'http://localhost:3000' }, { APP_ORIGIN: 'https://web.example.test/path' },
    { APP_ORIGIN: 'https://localhost:3000' },
    { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
    { STORAGE_EMULATOR_HOST: '127.0.0.1:9199' }, { FIREBASE_CLIENT_EMAIL: 'api@example.test' },
  ])('rejects incomplete or mixed cloud settings: %j', patch => {
    expect(() => releaseIdentity({ ...cloud, ...patch })).toThrow();
  });
  it('requires an explicit cloud environment on hosted or production runtimes', () => {
    expect(() => releaseIdentity({ VERCEL: '1' })).toThrow();
    expect(() => releaseIdentity({ NODE_ENV: 'production', APP_ENVIRONMENT: 'local' })).toThrow();
  });
});

describe('static web release configuration', () => {
  function configure(patch: Record<string, string | undefined> = {}) {
    for (const [name, value] of Object.entries({
      NEXT_PUBLIC_APP_ENVIRONMENT: 'staging', RELEASE_COMMIT: cloud.RELEASE_COMMIT,
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: cloud.FIREBASE_PROJECT_ID,
      NEXT_PUBLIC_SHAREBILL_API_URL: 'https://api.example.test', NEXT_PUBLIC_FIREBASE_API_KEY: 'synthetic-public-key',
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'sharebill-staging.firebaseapp.com',
      FIREBASE_PRIVATE_KEY: 'server-only-fixture', ...patch,
    })) vi.stubEnv(name, value);
  }
  it('exports public build identity and API origin without credentials', async () => {
    configure();
    const value = await webRelease().json();
    expect(value).toEqual({ service: 'sharebill-web', release: releaseIdentity(cloud), apiOrigin: 'https://api.example.test' });
    expect(JSON.stringify(value)).not.toContain('server-only-fixture');
    expect(JSON.stringify(value)).not.toContain('synthetic-public-key');
  });
  it.each([
    { RELEASE_COMMIT: 'short' }, { NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-sharebill' },
    { NEXT_PUBLIC_SHAREBILL_API_URL: 'http://localhost:3001' }, { NEXT_PUBLIC_SHAREBILL_API_URL: undefined },
    { NEXT_PUBLIC_FIREBASE_API_KEY: 'demo' }, { NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: undefined },
    { NEXT_PUBLIC_APP_ENVIRONMENT: 'local', VERCEL: '1' },
  ])('rejects an invalid cloud build: %j', patch => {
    configure(patch);
    expect(() => webRelease()).toThrow();
  });
});
