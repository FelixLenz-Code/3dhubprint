/// <reference lib="webworker" />
// Service worker: offline app shell (precache) + Web Push notifications.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';
import type { PushPayload } from '@printhub/shared';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

// autoUpdate: take over immediately so the page reloads into the new version.
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// API, websocket and webcam streams always go to the network.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

self.addEventListener('push', (event) => {
  let data: PushPayload = { title: 'PrintHub', body: '', url: '/' };
  try {
    data = { ...data, ...(event.data?.json() as PushPayload) };
  } catch {
    data.body = event.data?.text() ?? '';
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag,
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data as { url?: string })?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        await existing.navigate(url);
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
