// Echo Karaoke — Service Worker
// Bumps: change CACHE_VERSION to force a full refresh on all clients.

const CACHE_VERSION = 'echo-v1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const TRACKS_CACHE = `${CACHE_VERSION}-tracks`;

// Explicit shell: these are precached on install
const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/player.html',
    '/remote.html',
    '/admin.html',
    '/manifest.json',
    '/css/player.css',
    '/js/app.js',
    '/js/browse.js',
    '/js/config.js',
    '/js/congrats.js',
    '/js/fx.js',
    '/js/lyrics.js',
    '/js/supabase.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then((cache) =>
            cache.addAll(SHELL_ASSETS).catch((err) => {
                console.warn('[sw] precache failed for some assets:', err);
            })
        ).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(
                names
                    .filter((n) => !n.startsWith(CACHE_VERSION))
                    .map((n) => caches.delete(n))
            )
        ).then(() => self.clients.claim())
    );
});

function isSupabaseApi(url) {
    return url.hostname.endsWith('.supabase.co') &&
        (url.pathname.startsWith('/rest/') ||
         url.pathname.startsWith('/auth/') ||
         url.pathname.startsWith('/realtime/'));
}

function isStorageVideoOrTrack(url) {
    return url.hostname.endsWith('.supabase.co') &&
        url.pathname.startsWith('/storage/v1/object/public/');
}

function isFontResource(url) {
    return url.hostname === 'fonts.googleapis.com' ||
        url.hostname === 'fonts.gstatic.com' ||
        url.hostname === 'api.fontshare.com';
}

function isSameOriginStatic(url) {
    return url.origin === self.location.origin &&
        !url.pathname.startsWith('/sw.js');
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Never intercept Supabase API or realtime — let the app handle failures
    if (isSupabaseApi(url)) return;

    // Storage objects (videos, tracks): cache-first, populated on demand by the app
    if (isStorageVideoOrTrack(url)) {
        event.respondWith(
            caches.open(TRACKS_CACHE).then(async (cache) => {
                const cached = await cache.match(req);
                if (cached) return cached;
                try {
                    const res = await fetch(req);
                    if (res.ok && res.status === 200) {
                        cache.put(req, res.clone()).catch(() => {});
                    }
                    return res;
                } catch (e) {
                    // No cache, no network — give a synthetic 503 so <audio>/<video> doesn't hang
                    return new Response('', { status: 503, statusText: 'Offline' });
                }
            })
        );
        return;
    }

    // Fonts from CDN: cache-first, long-lived
    if (isFontResource(url)) {
        event.respondWith(
            caches.open(SHELL_CACHE).then(async (cache) => {
                const cached = await cache.match(req);
                if (cached) return cached;
                try {
                    const res = await fetch(req);
                    if (res.ok) cache.put(req, res.clone()).catch(() => {});
                    return res;
                } catch (e) {
                    return cached || Response.error();
                }
            })
        );
        return;
    }

    // Same-origin: stale-while-revalidate
    if (isSameOriginStatic(url)) {
        event.respondWith(
            caches.open(SHELL_CACHE).then(async (cache) => {
                const cached = await cache.match(req);
                const networkFetch = fetch(req).then((res) => {
                    if (res.ok) cache.put(req, res.clone()).catch(() => {});
                    return res;
                }).catch(() => cached);
                return cached || networkFetch;
            })
        );
        return;
    }

    // Everything else: network-only
});

// Let the page ask us to pre-cache a track URL
self.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'cache-track' && msg.url) {
        event.waitUntil(
            caches.open(TRACKS_CACHE).then(async (cache) => {
                const existing = await cache.match(msg.url);
                if (existing) return;
                try {
                    const res = await fetch(msg.url);
                    if (res.ok) await cache.put(msg.url, res);
                } catch (e) { /* offline — nothing to cache */ }
            })
        );
    }
});
