const CACHE_NAME = 'argonvr-cache-v34';
const urlsToCache = [];

// Install the service worker
self.addEventListener('install', event => {
    self.skipWaiting();

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                return cache.addAll(urlsToCache);
            })
    );
});

// Activate and clean up old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        }).then(() => {
            return self.clients.claim();
        })
    );
});

// Fetch resources
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Bypass Service Worker interception for live/recorded media streams, sprites, and dynamic API endpoints
    if (
        url.pathname.endsWith('.m3u8') ||
        url.pathname.endsWith('.ts') ||
        url.pathname.endsWith('.vtt') ||
        url.pathname.endsWith('.jpg') ||
        url.pathname.startsWith('/history') ||
        url.pathname.startsWith('/cameracount') ||
        url.pathname.startsWith('/basedir') ||
        url.pathname.startsWith('/available_dates') ||
        url.pathname.startsWith('/api/')
    ) {
        return;
    }

    // 1. Strict Network-First for HTML navigation
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' }).catch(() => {
                return caches.match(event.request);
            })
        );
        return;
    }

    // 2. Standard Network-First fallback for static assets
    event.respondWith(
        fetch(event.request).catch(async () => {
            const cached = await caches.match(event.request);
            return cached || Response.error();
        })
    );
});