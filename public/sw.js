/* ============================================================
   第一性原理引擎 · Service Worker
   缓存策略：
   - 静态资源（App Shell）：缓存优先 + 后台更新（stale-while-revalidate）
   - /api/* 请求：网络优先，绝不缓存（保证实时性）
   ============================================================ */
'use strict';

const CACHE_NAME = 'fp-engine-v1';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './tree.js',
  './md.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
];

// 安装：预缓存 App Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 请求：静态缓存优先；API 网络优先
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // 跨域（DeepSeek API 走服务端）不处理
  if (url.pathname.startsWith('/api/')) return;    // API 不缓存，走网络

  // 静态资源：stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
