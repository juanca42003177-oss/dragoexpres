/* DragoExpres — service worker para instalacion PWA (requisito de Chrome para el boton Instalar).
   Estrategia RED-PRIMERO: siempre pide la version nueva al servidor y solo usa cache si no hay internet,
   asi los cambios de Juan llegan al instante (nunca queda congelada una version vieja). */
var CACHE = 'dx-v1';
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
/* notificaciones push (como las apps grandes): llegan aunque la app este cerrada */
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || '\u{1F409} DragoExpres', {
    body: d.body || 'Abr\u00ed la app para ver m\u00e1s',
    icon: 'img/icon-192.png',
    badge: 'img/icon-192.png',
    tag: d.tag || 'dx',
    data: { url: d.url || 'https://dragoexpres.vercel.app/pedir.html' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || 'https://dragoexpres.vercel.app/pedir.html';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    return clients.openWindow(url);
  }));
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function (r) {
      var copia = r.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copia); });
      return r;
    }).catch(function () {
      return caches.match(e.request).then(function (c) {
        return c || Response.error();
      });
    })
  );
});
