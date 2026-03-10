/**
 * sw.js — Leus Service Worker
 * Caches the app shell for offline use.
 */

const CACHE_NAME = 'leus-v1';
const APP_SHELL  = [
  './',
  './index.html',
  './src/css/main.css',
  './src/js/app.js',
  './src/js/camera.js',
  './src/js/scanner.js',
  './src/js/filters.js',
  './src/js/ocr.js',
  './src/js/export.js',
  './src/js/storage.js',
  './manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Network-first for CDN resources (OpenCV, Tesseract, jsPDF)
  const url = new URL(e.request.url);
  const isCDN = url.hostname !== self.location.hostname;

  if (isCDN) {
    // Cache-first for CDN (they are versioned, safe to cache long-term)
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      }))
    );
    return;
  }

  // Cache-first for local app shell
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
