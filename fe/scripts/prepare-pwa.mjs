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
for (const path of ['/index.html', ...assets.sort()]) {
  hash.update(path).update(await readFile(new URL(path.slice(1), out)));
}
const cache = 'sharebill-shell-' + hash.digest('hex').slice(0, 16);

const worker = `
const CACHE = ${JSON.stringify(cache)};
const ASSETS = ${JSON.stringify(['/', ...assets])};
const shell = new Set(ASSETS);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});

let updateCheck;
self.addEventListener('message', event => {
  // Retain the explicit action understood by versions already deployed.
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'APPLY_UPDATE_WHEN_SAFE') {
    updateCheck ??= (async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const ready = await Promise.all(tabs.map(tab => new Promise(resolve => {
        const channel = new MessageChannel();
        const finish = value => { clearTimeout(timer); channel.port1.close(); resolve(value); };
        const timer = setTimeout(() => finish(false), 1500);
        channel.port1.onmessage = event => finish(event.data?.ready === true);
        tab.postMessage({ type: 'PWA_UPDATE_CHECK' }, [channel.port2]);
      })));
      if (ready.every(Boolean)) await self.skipWaiting();
    })().finally(() => { updateCheck = undefined; });
    event.waitUntil(updateCheck);
  }
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      // Keep one previous shell for a tab that starts editing during activation.
      const previous = keys.filter(key => /^sharebill-shell-[a-f0-9]{16}$/.test(key) && key !== CACHE).at(-1);
      return Promise.all(keys.filter(key => key.startsWith('sharebill-shell-') && key !== CACHE && key !== previous)
        .map(key => caches.delete(key)));
    })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate' && (url.pathname === '/demo' || url.pathname === '/demo/')) {
    event.respondWith(Promise.resolve(Response.redirect(self.location.origin + '/', 302)));
    return;
  }
  const page = url.pathname;
  if (event.request.mode === 'navigate' && page === '/') {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(page).then(response => response || fetch(event.request))));
  } else if (shell.has(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname).then(response => response || fetch(event.request))));
  }
});
`;

await writeFile(new URL('sw.js', out), worker);
