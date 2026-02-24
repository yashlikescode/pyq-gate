/**
 * sw.js – Service Worker for GATE PYQ
 *
 * Strategy:
 *  - App shell (HTML/CSS/JS/manifest) cached on install for offline use (Cache-first).
 *  - Metadata JSON: Network-first with short timeout so updates reach users quickly.
 *  - Paper PDFs/images: Cache-on-demand (only cached when user opens them).
 *    Implements a size-limited cache: max 200 MB or 30 entries, LRU-evicted.
 */

"use strict";

const SHELL_CACHE = "gate-shell-v1";
const META_CACHE = "gate-meta-v1";
const PAPER_CACHE = "gate-papers-v1";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./metadata/index.json",
];

const PAPER_MAX_BYTES = 200 * 1024 * 1024; // 200 MB budget
const PAPER_MAX_ENTRIES = 30;

// ── Install: pre-cache shell ──────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

// ── Activate: clean old caches ────────────────────────────────────
self.addEventListener("activate", (event) => {
  const KNOWN = new Set([SHELL_CACHE, META_CACHE, PAPER_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => !KNOWN.has(k)).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ── Fetch ─────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  const path = url.pathname;

  // Metadata JSON: network-first (fast fallback to cache)
  if (path.includes("/metadata/")) {
    event.respondWith(networkFirstWithFallback(request, META_CACHE, 3000));
    return;
  }

  // Paper files: cache-on-demand
  const isPaperFile = /\.(pdf|jpg|jpeg|png)$/i.test(path);
  if (isPaperFile) {
    event.respondWith(cacheOnDemand(request));
    return;
  }

  // Shell: cache-first
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

// ── Strategies ────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirstWithFallback(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function cacheOnDemand(request) {
  const cache = await caches.open(PAPER_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (!response.ok) return response;

  // Enforce size budget before storing
  await enforcePaperBudget(cache);
  cache.put(request, response.clone());
  return response;
}

async function enforcePaperBudget(cache) {
  const keys = await cache.keys();
  if (keys.length < PAPER_MAX_ENTRIES) return;

  // Estimate total size and evict oldest entries
  let totalBytes = 0;
  const entries = [];
  for (const req of keys) {
    const resp = await cache.match(req);
    const blob = await resp?.blob();
    if (blob) {
      totalBytes += blob.size;
      entries.push({ req, size: blob.size });
    }
  }

  // Evict from the front (oldest) until under budget and entry limit
  while (entries.length >= PAPER_MAX_ENTRIES || totalBytes > PAPER_MAX_BYTES) {
    const evict = entries.shift();
    if (!evict) break;
    await cache.delete(evict.req);
    totalBytes -= evict.size;
  }
}
