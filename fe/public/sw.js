// Development recovery for browsers still controlled by an older production PWA.
// The production build replaces out/sw.js with scripts/prepare-pwa.mjs.
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    await self.registration.unregister();
    const tabs = await self.clients.matchAll({ type: 'window' });
    await Promise.all(tabs.map(tab => tab.navigate(tab.url)));
  })());
});
