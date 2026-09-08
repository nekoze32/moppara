// オフラインでも記録の閲覧と入力ができるようにする。AI呼び出しだけはネットが要る。
const CACHE = 'moppara-v22';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'src/app.js',
  'src/util.js',
  'src/db.js',
  'src/store.js',
  'src/nutrition.js',
  'src/prompts.js',
  'src/ai.js',
  'src/views/welcome.js',
  'src/views/chat.js',
  'src/views/today.js',
  'src/views/trend.js',
  'src/views/settings.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // APIのPOSTは素通し
  if (new URL(req.url).origin !== location.origin) return; // 外部（AI）は素通し

  // ネット優先。さらに no-cache を付けてブラウザのHTTPキャッシュを必ず検証させる。
  // これが無いと、更新を出しても端末が古いJSを掴んだままになる（実際に踏んだ）。
  const fresh = new Request(req.url, {
    method: 'GET',
    headers: req.headers,
    mode: req.mode === 'navigate' ? 'same-origin' : req.mode,
    credentials: 'same-origin',
    redirect: 'follow',
    cache: 'no-cache',
  });
  e.respondWith(
    fetch(fresh)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
