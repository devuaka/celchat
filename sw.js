// CelChat used to run at this path and now lives in ./app/. This retires the old service worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    self.registration.unregister().then(() => self.clients.matchAll({ type: 'window' })).then((cs) => Promise.all(cs.map((c) => c.navigate(c.url).catch(() => undefined)))),
  );
});
