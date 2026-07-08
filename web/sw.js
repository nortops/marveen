self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // No-op: do not call respondWith. Requests fall through to the network.
  // This empty handler is required for Chrome's PWA installability check.
});
