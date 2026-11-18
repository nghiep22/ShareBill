import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = new URL('../out/', import.meta.url);
const outPath = fileURLToPath(out);
const assets = ['/da-lat.jpg', '/manifest.webmanifest'];

for (const path of ['_next/static', 'icons']) {
  const entries = await readdir(new URL(path, out), { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.map')) continue;
    const assetPath = relative(outPath, join(entry.parentPath, entry.name));
    assets.push('/' + assetPath.split(sep).join('/'));
  }
}

const hash = createHash('sha256');
for (const path of ['/index.html', '/demo.html', ...assets.sort()]) {
  hash.update(path).update(await readFile(new URL(path.slice(1), out)));
}
const cache = 'sharebill-shell-' + hash.digest('hex').slice(0, 16);

const worker = `
const CACHE = ${JSON.stringify(cache)};
const ASSETS = ${JSON.stringify(['/', '/demo', ...assets])};
const shell = new Set(ASSETS);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys
      .filter(key => key.startsWith('sharebill-shell-') && key !== CACHE)
      .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const page = url.pathname === '/demo/' ? '/demo' : url.pathname;
  if (event.request.mode === 'navigate' && (page === '/' || page === '/demo')) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(page).then(response => response || fetch(event.request))));
  } else if (shell.has(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname).then(response => response || fetch(event.request))));
  }
});
`;

await writeFile(new URL('sw.js', out), worker);
