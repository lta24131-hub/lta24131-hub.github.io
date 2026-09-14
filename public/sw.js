const CACHE_NAME = "step-viewer-v12";
const CORE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/step-worker.js",
  "/step-worker.js?v=11",
  "/step-split-worker.js?v=11",
  "/step-partition.js?v=11",
  "/cadrum-step-worker.js",
  "/cadrum-step-worker.js?v=12",
  "/cadrum/v1/cadrum_local_preview-ddf094990a106c75.js",
  "/cadrum/v1/cadrum_local_preview-ddf094990a106c75_bg.wasm",
  "/occt/occt-import-js.js",
  "/occt/occt-import-js.wasm"
];

async function cacheOne(cache, url) {
  try {
    const response = await fetch(url, { cache: "reload", credentials: "same-origin" });
    if (response.ok) { await cache.put(url, response); return true; }
  } catch {
    // A later online launch will fill anything unavailable during installation.
  }
  return Boolean(await cache.match(url));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(CORE_URLS.map((url) => cacheOne(cache, url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_URLS" || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const urls = event.data.urls.filter((value) => {
      try { const url = new URL(value, self.location.origin); return url.origin === self.location.origin && !url.pathname.startsWith("/api/"); }
      catch { return false; }
    });
    const results = await Promise.all(urls.map((url) => cacheOne(cache, url)));
    event.ports?.[0]?.postMessage({ ok: results.every(Boolean) });
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("/", response.clone());
        }
        return response;
      } catch {
        return (await caches.match(request)) ?? (await caches.match("/"));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
