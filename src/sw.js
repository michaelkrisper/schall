// App shell cache. The deploy workflow replaces __VERSION__ with the commit,
// so every release installs a fresh cache. Recordings live in IndexedDB, not
// here. Other apps share the origin (michaelkrisper.github.io) and with it the
// cache storage, so only this app's old caches are removed.

const VERSION = '__VERSION__';
const CACHE = `schall-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'dsp.wasm',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'js/main.js',
  'js/audio.js',
  'js/worklet.js',
  'js/dsp.js',
  'js/stats.js',
  'js/settings.js',
  'js/level-view.js',
  'js/spectrum-view.js',
  'js/tracker.js',
  'js/recorder.js',
  'js/recordings-view.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith('schall-') && key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches
      .match(request, { ignoreSearch: true })
      .then((hit) => hit ?? (request.mode === 'navigate' ? caches.match('./') : null))
      .then((hit) => hit ?? fetch(request)),
  );
});
