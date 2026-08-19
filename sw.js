// Service Worker。オフラインキャッシュは行わない（Cloudflare Access の認証と
// 相性が悪く、履歴も常にサーバーが正のため）。役割はプッシュ通知の受け取りだけ。

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// 通知に載せる情報は「完了したこと」と件数だけ。プロンプト・モデル・画像などは
// 一切含めない（ロック画面に内容が出ないようにするため）。ペイロード側でも
// 同じ方針だが、万一入っていても SW 側では使わない
function buildNotification(data) {
  const count = Number.isFinite(data?.count) && data.count > 1 ? `（${data.count} 件）` : '';
  const title = typeof data?.title === 'string' && data.title ? data.title : '完了しました';
  return {
    title: `${title}${count}`,
    options: {
      body: typeof data?.body === 'string' ? data.body : '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // 同じ種類の通知は積み上げず最新の 1 件にまとめる
      tag: typeof data?.tag === 'string' ? data.tag : 'fal-done',
      renotify: true,
      data: { url: typeof data?.url === 'string' ? data.url : '/' },
    },
  };
}

// 前面で開いている（＝画面に見えている）間は通知しない。
// 別アプリに切り替えている・スリープ中・アプリを閉じている場合のみ通知する。
// サーバー側でも同じ判定（端末のハートビート）で送信自体を抑止しており、
// これはその取りこぼしに対する保険
async function isVisibleSomewhere() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.some((c) => c.visibilityState === 'visible');
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = {};
    }
    if (await isVisibleSomewhere()) return;
    const { title, options } = buildNotification(data);
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      // 目的のページが開いていなければ、既存のウィンドウ内で移動する
      if (!client.url.includes(target) && 'navigate' in client) {
        await client.navigate(target).catch(() => {});
      }
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// 購読が OS 側で作り直されたときの再登録（iOS でも稀に起きる）
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const res = await fetch('/api/push/key').catch(() => null);
    if (!res || !res.ok) return;
    const { key } = await res.json().catch(() => ({}));
    if (!key) return;
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    }).catch(() => {});
  })());
});
