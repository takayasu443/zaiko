/* サービスワーカー：オフラインでも開けるようにし、新しい版は利用者が「更新」を押したときだけ切り替える
 * - install で skipWaiting しない（入力中に勝手に切り替わらない）
 * - キャッシュの削除は 'zaiko-' で始まるものだけ（同じオリジンの別アプリを消さない）
 * - 正常応答(res.ok)だけをキャッシュし、HTMLの代替は画面遷移（navigate）のときだけ返す
 */
const VERSION = 'v1.2.1';
const PREFIX = 'zaiko-';
const CACHE = PREFIX + VERSION;
const SHELL = [
  './', './index.html', './style.css', './core.js', './app.js', './items-default.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// アプリ本体はネット優先（更新を素早く反映）、取れなければキャッシュ。Dropbox等の外部APIは素通し。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== 'GET') return;
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;                 // このアプリの公開資産だけを扱う
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
      }
      return res;
    } catch (e) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') { const index = await caches.match('./index.html'); if (index) return index; }
      throw e;
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
