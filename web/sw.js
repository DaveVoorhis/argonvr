const CACHE_NAME = 'argonvr-cache-v40';

// Install the service worker
self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(caches.open(CACHE_NAME));
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
    if (url.origin !== self.location.origin) return;

    // Bypass Service Worker interception for live/recorded media streams, sprites, and dynamic API endpoints
    if (
        url.pathname.endsWith('.m3u8') ||
        url.pathname.endsWith('.ts') ||
        url.pathname.endsWith('.mp4') ||
        url.pathname.endsWith('.vtt') ||
        url.pathname.endsWith('.jpg') ||
        url.pathname === '/health' ||
        url.pathname.startsWith('/videos/') ||
        url.pathname.startsWith('/history') ||
        url.pathname.startsWith('/cameracount') ||
        url.pathname.startsWith('/basedir') ||
        url.pathname.startsWith('/available_dates') ||
        url.pathname.startsWith('/api/')
    ) {
        return;
    }

    // 1. Network-First with cache population for HTML navigation
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .then(response => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
                    }
                    return response;
                })
                .catch(async () => {
                    const cached = await caches.match(event.request);
                    return cached || Response.error();
                })
        );
        return;
    }

    // 2. Network-First with cache population for static shell assets (JS, CSS, SVG, icons, manifest)
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response && response.ok && response.type === 'basic') {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(event.request);
                return cached || Response.error();
            })
    );
});
