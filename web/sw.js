const CACHE_NAME = 'argonvr-cache-v25';
const urlsToCache = [];

// Install the service worker
self.addEventListener('install', event => {
    // Force this new service worker to take over immediately,
    // rather than waiting for all tabs of the PWA to close.
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
            // Ensure the service worker takes control of the page immediately
            return self.clients.claim();
        })
    );
});

// Fetch resources
self.addEventListener('fetch', event => {
    // 1. Strict Network-First for HTML navigation (Hitting the Back button or refreshing)
    if (event.request.mode === 'navigate') {
        event.respondWith(
            // The { cache: 'no-store' } override forces the browser to ignore its
            // internal HTTP disk cache and actually ask the server for the file.
            fetch(event.request, { cache: 'no-store' }).catch(() => {
                return caches.match(event.request);
            })
        );
        return;
    }

    // 2. Standard Network-First fallback for everything else (scripts, styles, etc.)
    event.respondWith(
        fetch(event.request).catch(() => {
            return caches.match(event.request);
        })
    );
});