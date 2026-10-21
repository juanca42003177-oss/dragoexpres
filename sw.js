/* DragoExpres — service worker para instalacion PWA (requisito de Chrome para el boton Instalar).
   Estrategia RED-PRIMERO: siempre pide la version nueva al servidor y solo usa cache si no hay internet,
   asi los cambios de Juan llegan al instante (nunca queda congelada una version vieja). */
var CACHE = 'dx-v1';
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
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
