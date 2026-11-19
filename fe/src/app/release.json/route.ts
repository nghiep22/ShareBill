// Static export records the same public configuration used by the client build.
export const dynamic = 'force-static';

export function GET() {
  const environment = process.env.NEXT_PUBLIC_APP_ENVIRONMENT ?? 'local';
  const commit = process.env.RELEASE_COMMIT ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const firebaseProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'demo-sharebill';
  const apiOrigin = process.env.NEXT_PUBLIC_SHAREBILL_API_URL?.replace(/\/$/, '') ?? 'http://localhost:3001';
  if (!['local', 'staging', 'production'].includes(environment)) throw new Error('Invalid NEXT_PUBLIC_APP_ENVIRONMENT');
  if (environment === 'local' && process.env.VERCEL) throw new Error('Set NEXT_PUBLIC_APP_ENVIRONMENT for a deployed web build');
  if (environment !== 'local') {
    if (!commit || !/^[a-f0-9]{40}$/i.test(commit)) throw new Error('A full RELEASE_COMMIT is required');
    if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || firebaseProjectId.startsWith('demo-')) throw new Error('A cloud NEXT_PUBLIC_FIREBASE_PROJECT_ID is required');
    const url = new URL(apiOrigin);
    if (!process.env.NEXT_PUBLIC_SHAREBILL_API_URL || url.protocol !== 'https:' || url.origin !== apiOrigin || url.username || url.password ||
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost')) {
      throw new Error('NEXT_PUBLIC_SHAREBILL_API_URL must be an explicit HTTPS origin');
    }
    if (!process.env.NEXT_PUBLIC_FIREBASE_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY === 'demo' ||
        !process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN) throw new Error('Cloud Firebase web configuration is required');
  }
  return Response.json({ service: 'sharebill-web', release: { environment, commit, firebaseProjectId }, apiOrigin });
}
