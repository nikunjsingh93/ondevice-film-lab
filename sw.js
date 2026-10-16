const CACHE_NAME = "ondevice-film-lab-v1.10.25";
const APP_SHELL = [
  "./",
  "./index.html",
  "./theme.css",
  "./theme.js",
  "./photo-formats.js",
  "./photo-codecs.js",
  "./photo-exif.js",
  "./tone-curve.js",
  "./flashback.js",
  "./flashback/assets/grain/grain_01.png",
  "./flashback/assets/grain/grain_02.png",
  "./flashback/assets/grain/grain_03.png",
  "./flashback/assets/grain/grain_04.png",
  "./flashback/assets/luts/disposable.cube",
  "./flashback/assets/luts/monochrome.cube",
  "./flashback/assets/luts/pointandshoot.cube",
  "./flashback/assets/luts/rangefinder.cube",
  "./flashback/assets/luts/V1.cube",
  "./flashback/COPYING",
  "./flashback/core/config.js",
  "./flashback/core/effects.js",
  "./flashback/core/gpu.js",
  "./flashback/core/lut.js",
  "./flashback/core/one35-dng.js",
  "./flashback/core/procedural-luts.js",
  "./flashback/core/processor.js",
  "./flashback/core/raw-decoder.js",
  "./flashback/cpu.js",
  "./flashback/NOTICE.md",
  "./flashback/package.json",
  "./flashback/shaders/acescct.wgsl",
  "./flashback/shaders/adjust.wgsl",
  "./flashback/shaders/blend.wgsl",
  "./flashback/shaders/bloom_small.wgsl",
  "./flashback/shaders/chromatic_aberration.wgsl",
  "./flashback/shaders/cnr.wgsl",
  "./flashback/shaders/colormatrix.wgsl",
  "./flashback/shaders/gaussian_blur.wgsl",
  "./flashback/shaders/grain.wgsl",
  "./flashback/shaders/grain_sample.wgsl",
  "./flashback/shaders/highlights.wgsl",
  "./flashback/shaders/lut.wgsl",
  "./flashback/shaders/postgain.wgsl",
  "./flashback/shaders/saturation.wgsl",
  "./flashback/shaders/tonecurve.wgsl",
  "./flashback/shaders/vignette.wgsl",
  "./flashback/worker.js",
  "./codecs/decode-worker.mjs",
  "./codecs/vendor/libraw.mjs",
  "./codecs/vendor/libheif.mjs",
  "./codecs/vendor/utif.mjs",
  "./codecs/vendor/bmp.mjs",
  "./manifest.webmanifest",
  "./branding/ondevice-film-lab-logo-v4.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];
const OFFLINE_URL = new URL("./index.html", self.location.href).href;

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(OFFLINE_URL, response.clone());
          }
          return response;
        } catch {
          return caches.match(OFFLINE_URL);
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })()
  );
});
