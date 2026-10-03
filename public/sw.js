const CACHE_NAME = 'fourcard-shell-v5';
const APP_FILES = ['./', './index.html', './styles.css', './online.css', './qrcode.js', './app.js', './manifest.webmanifest', './icon.svg'];
const NETWORK_FIRST_PATHS = new Set(['/', '/index.html', '/styles.css', '/online.css', '/qrcode.js', '/app.js']);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  const url = new URL(event.request.url);
  if (!NETWORK_FIRST_PATHS.has(url.pathname)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      throw error;
    }
  })());
});