/**
 * Khata service worker (module worker).
 *
 * - Pre-caches the whole app shell so a cold launch works with no network.
 * - Serves navigations from the cached shell (offline-first), refreshing it in
 *   the background.
 * - Never caches API calls: those belong to the sync engine, which has its own
 *   queue and retry policy.
 * - Handles Background Sync (`khata-sync`) by flushing the IndexedDB queue even
 *   when no tab is open.
 */

import { flush } from './js/sync-core.js';

const APP_VERSION = '__APP_VERSION__';
const SHELL_CACHE = `khata-shell-${APP_VERSION}`;
const RUNTIME_CACHE = 'khata-runtime-v1';

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/theme-boot.js',
  './js/app.js',
  './js/db.js',
  './js/settings.js',
  './js/logger.js',
  './js/i18n.js',
  './js/ui.js',
  './js/pdf.js',
  './js/zip.js',
  './js/sync.js',
  './js/sync-core.js',
  './js/version.js',
  './js/shared/money.js',
  './js/shared/ledger.js',
  './js/shared/sms.js',
  './js/shared/validation.js',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  './icons/favicon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll fails the whole install on one 404, so add individually and keep
      // whatever succeeded.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (error) {
            console.warn('[sw] precache miss', url, error?.message);
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE).map((key) => caches.delete(key)),
      );
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {
          /* not supported everywhere */
        }
      }
      await self.clients.claim();
    })(),
  );
});

function isApiRequest(url) {
  return url.pathname.includes('/api/');
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    // Refresh in the background for the next launch.
    fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
      })
      .catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    const runtime = await caches.open(RUNTIME_CACHE);
    runtime.put(request, response.clone());
  }
  return response;
}

async function navigationResponse(event, request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = (await cache.match(request, { ignoreSearch: true })) || (await cache.match('./index.html'));
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put('./index.html', response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network.catch(() => null));
    return cached;
  }
  const response = await network;
  if (response) return response;
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Khata offline</title><p>Khata has not been cached on this device yet. Open it once with a connection.</p>',
    { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 503 },
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin calls
  if (isApiRequest(url)) return; // the sync engine owns these

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(event, request));
    return;
  }
  event.respondWith(cacheFirst(request).catch(() => caches.match(request, { ignoreSearch: true })));
});

/* ------------------------------------------------------- background sync */

async function notifyClients(message) {
  const clientList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clientList) client.postMessage(message);
}

self.addEventListener('sync', (event) => {
  if (event.tag !== 'khata-sync') return;
  event.waitUntil(
    (async () => {
      try {
        const result = await flush();
        await notifyClients({ type: 'khata:sync-result', ok: true, result });
      } catch (error) {
        await notifyClients({ type: 'khata:sync-result', ok: false, error: error?.message || 'sync failed' });
        // Re-throwing lets the browser retry the background sync later.
        throw error;
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'khata:skip-waiting') self.skipWaiting();
  if (data.type === 'khata:sync-now') {
    event.waitUntil(
      (async () => {
        try {
          const result = await flush();
          await notifyClients({ type: 'khata:sync-result', ok: true, result });
        } catch (error) {
          await notifyClients({ type: 'khata:sync-result', ok: false, error: error?.message || 'sync failed' });
        }
      })(),
    );
  }
});
