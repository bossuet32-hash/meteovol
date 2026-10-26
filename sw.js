// Service worker : l'app et les zones fonctionnent hors ligne ; fond de carte IGN mis en cache au fil de l'usage.
const VERSION = 'mv-2026-10-26c';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/util.js', 'js/metar.js', 'js/meteo.js', 'js/bulletin.js', 'js/zones.js', 'js/map.js', 'js/mission.js', 'js/pdf.js', 'js/lieu.js', 'js/rtk.js', 'data/centipede.json',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/jspdf.umd.min.js',
  'vendor/images/layers.png', 'vendor/images/layers-2x.png', 'vendor/images/marker-icon.png',
  'data/aerodromes.json', 'data/zones/meta.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('mv-20') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
async function trim(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // tuiles de zones : réseau d'abord (nouveau cycle AIRAC), cache sinon
  if (url.origin === location.origin && url.pathname.includes('/data/')) {
    e.respondWith(fetch(req).then((r) => { const cp = r.clone(); caches.open('mv-data').then((c) => c.put(req, cp)); return r; })
      .catch(() => caches.match(req)));
    return;
  }
  // fond de carte IGN : cache d'abord
  if (url.hostname === 'data.geopf.fr' && url.pathname.startsWith('/wmts')) {
    e.respondWith(caches.open('mv-tiles').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === 'opaque') { c.put(req, r.clone()); trim('mv-tiles', 3000); }
      return r;
    }).catch(() => caches.match(req)));
    return;
  }
  // l'app elle-même
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).catch(() => caches.match('index.html'))));
  }
});
