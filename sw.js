// アプリ本体(HTML/CSS/JS/アイコン)だけをキャッシュする。GitHub APIは常にネットワークへ。
// 方針: オンラインなら常に最新を取得(network-first)、オフラインのときだけキャッシュを使う。
const CACHE = 'issue-memo-v3';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // cache:'reload' でブラウザの一時保存を飛ばし、必ず最新ファイルを取得する
      .then((c) => Promise.all(SHELL.map((u) =>
        fetch(new Request(u, { cache: 'reload' })).then((r) => {
          if (!r.ok) throw new Error('fetch failed: ' + u);
          return c.put(u, r);
        }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // APIなど外部は触らない
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        // オフライン時:キャッシュから返す
        const cached = await caches.match(req, { ignoreSearch: true });
        return cached || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
      })
  );
});
