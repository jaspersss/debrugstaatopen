const CACHE_NAME = "brugopen-shell-v14";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./style.css?v=10",
  "./app.js?v=26",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// Live API-domeinen blijven STRIKT Network-Only zodat verkeers- en brugdata altijd realtime is.
const NETWORK_ONLY_HOSTS = [
  "storage.googleapis.com",
  "api.pdok.nl",
  "service.pdok.nl",
  "router.project-osrm.org",
  "routing.openstreetmap.de",
  "api.open-meteo.com",
  "wa.me"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Live data & externe API's: nooit cachen
  if (NETWORK_ONLY_HOSTS.some((host) => url.hostname.includes(host))) {
    return;
  }

  // Alleen same-origin app-shell & statische data via Stale-While-Revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        const networkPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              cache.put(req, res.clone());
            }
            return res;
          })
          .catch(() => cached);
        return cached || networkPromise;
      })
    );
  }
});
