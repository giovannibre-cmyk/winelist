const CACHE_NAME = "sommelier-shell-v2";
const SHELL_FILES = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Non intercettare mai le chiamate all'API Anthropic o a CDN esterne (es. pdf.js).
  if (url.hostname === "api.anthropic.com" || url.hostname !== self.location.hostname) {
    return;
  }

  const isAppShell = /\.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith("/");

  if (isAppShell) {
    // Network-first per l'app shell: così ogni aggiornamento caricato su GitHub
    // arriva subito, invece di restare bloccati sulla versione vecchia in cache.
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache-first per asset statici che cambiano raramente (icone).
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).catch(() => cached))
    );
  }
});
