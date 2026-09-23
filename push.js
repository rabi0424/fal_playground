'use strict';

/* ==========================================================================
 * プッシュ通知（生成完了の通知）とアプリ化まわりの共通処理。
 * 生成・画像編集・部分AI編集・比較アリーナ・LoRA ライブラリの全画面から読み込む
 * （shell.js のあと。サイドバーの「通知」ボタンは shell.js が置く）。
 *
 * 方針:
 * - 通知の中身は「どの画面で何件終わったか」だけ。プロンプト・モデル・画像は載せない
 * - 前面で開いている間は通知しない。別アプリに切り替え中・スリープ中・アプリを
 *   閉じている間だけ通知する。判定は端末ごとのハートビートで行い、サーバー側が
 *   送信自体を止める（Service Worker 側にも保険の判定がある）
 * - iPhone の Web Push はホーム画面に追加したアプリの中でしか使えないので、
 *   Safari のタブで開いているときは追加を促す
 * ========================================================================== */

(() => {
  const LS_DEVICE = 'fal:pushDevice';
  const HEARTBEAT_MS = 25_000;

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
  const isStandalone = window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  // shell.js より先に走る store.js に頼らない（部分AI編集の画面は store.js 以外を読まない）
  const storage = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* 覚えられないだけ */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* 同上 */ }
    },
  };

  let registration = null;
  let deviceId = storage.get(LS_DEVICE);
  let heartbeatTimer = null;
  let busy = false;

  /* ---------- 小さなトースト（画面ごとに共通のお知らせ欄が無いため） ---------- */

  let toastEl = null;
  let toastTimer = null;
  function toast(message, ms = 5000) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'push-toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  /* ---------- サーバーとのやり取り ---------- */

  async function postJson(path, body, { beacon = false } = {}) {
    const payload = JSON.stringify(body);
    if (beacon && navigator.sendBeacon) {
      const ok = navigator.sendBeacon(path, new Blob([payload], { type: 'application/json' }));
      if (ok) return null;
    }
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: beacon,
    });
    if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
    return res.json().catch(() => null);
  }

  async function vapidKey() {
    const res = await fetch('/api/push/key');
    if (!res.ok) throw new Error('通知用の鍵を取得できませんでした');
    const { key } = await res.json();
    if (!key) throw new Error('Worker に VAPID 鍵が設定されていません（README の設定手順を参照）');
    return key;
  }

  /* ---------- ハートビート（この端末が「今見えているか」を伝える） ---------- */

  function sendHeartbeat(active, beacon = false) {
    if (!deviceId) return;
    postJson('/api/push/active', { deviceId, active }, { beacon }).catch(() => {});
  }

  function startHeartbeat() {
    stopHeartbeat();
    if (!deviceId) return;
    if (document.visibilityState === 'visible') sendHeartbeat(true);
    heartbeatTimer = setInterval(() => {
      if (document.visibilityState === 'visible') sendHeartbeat(true);
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (!deviceId) return;
    // 画面から離れた瞬間に「見えていない」ことを伝える。これ以降に終わった生成は
    // 通知が届く（アプリの切り替え・スリープ・ロックはすべてここを通る）
    if (document.visibilityState === 'hidden') sendHeartbeat(false, true);
    else sendHeartbeat(true);
  });
  window.addEventListener('pagehide', () => sendHeartbeat(false, true));

  /* ---------- 購読 ---------- */

  function urlBase64ToUint8Array(base64) {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
      .replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  }

  async function currentSubscription() {
    if (!registration) return null;
    return registration.pushManager.getSubscription();
  }

  async function subscribe() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast(permission === 'denied'
        ? '通知が拒否されています。iPhone の「設定 → 通知」からこのアプリの通知を許可してください'
        : '通知は有効になりませんでした');
      return false;
    }
    const key = await vapidKey();
    const wanted = urlBase64ToUint8Array(key);
    let sub = await currentSubscription();
    // 既存の購読が別の VAPID 鍵で作られていたら作り直す
    if (sub) {
      const existing = sub.options?.applicationServerKey;
      const same = existing && existing.byteLength === wanted.length
        && new Uint8Array(existing).every((v, i) => v === wanted[i]);
      if (!same) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
    }
    if (!sub) {
      sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
    }
    const result = await postJson('/api/push/subscribe', { subscription: sub.toJSON() });
    deviceId = result?.deviceId ?? null;
    if (deviceId) storage.set(LS_DEVICE, deviceId);
    startHeartbeat();
    return true;
  }

  async function unsubscribe() {
    const sub = await currentSubscription();
    if (sub) {
      await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    stopHeartbeat();
    deviceId = null;
    storage.remove(LS_DEVICE);
  }

  /* ---------- サイドバーの「通知」 ---------- */

  const btn = document.getElementById('pushNav');

  function setButton(on, title) {
    if (!btn) return;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = title;
    btn.setAttribute('aria-label', `通知: ${on ? 'オン' : 'オフ'}`);
  }

  async function renderButton() {
    if (!supported) {
      setButton(false, isIOS && !isStandalone
        ? 'iPhone では共有メニューの「ホーム画面に追加」でアプリとして追加すると、生成完了を通知できます'
        : 'このブラウザはプッシュ通知に対応していません');
      return;
    }
    const sub = await currentSubscription();
    const on = Notification.permission === 'granted' && !!sub;
    setButton(on, on
      ? '生成完了を通知します（アプリを開いている間は通知しません）。押すとオフ'
      : '生成完了をプッシュ通知します。押すとオン');
  }

  async function toggle() {
    if (busy) return;
    if (!supported) {
      toast(isIOS && !isStandalone
        ? 'iPhone では、Safari の共有ボタン →「ホーム画面に追加」でアプリとして追加してから通知をオンにしてください'
        : 'このブラウザはプッシュ通知に対応していません');
      return;
    }
    busy = true;
    btn?.classList.add('busy');
    try {
      const sub = await currentSubscription();
      if (sub && Notification.permission === 'granted') {
        await unsubscribe();
        toast('通知をオフにしました');
      } else if (await subscribe()) {
        toast('通知をオンにしました。アプリを閉じている間やほかのアプリを使っている間に、生成の完了をお知らせします');
      }
    } catch (err) {
      toast(`通知の設定に失敗しました: ${err.message}`);
    } finally {
      busy = false;
      btn?.classList.remove('busy');
      await renderButton();
    }
  }

  btn?.addEventListener('click', toggle);

  /* ---------- fal のジョブの見張りの登録 ----------
   * fal の生成はブラウザがポーリングしているので、アプリを閉じている間は完了を
   * 知れない。送信直後にサーバーへ status_url を預けて、サーバー側でも完了を
   * 見張ってもらう（通知はそこから送られる）。
   * kind はどの画面の生成か（gen = 生成・アリーナ / imgedit = 画像編集） */

  const watched = new Set();
  async function watchFalJob(statusUrl, kind = 'gen') {
    // この端末が通知を使っていなくても登録する（PC で生成して iPhone で通知を受ける、
    // のように別の端末が受け手のことがある）。受け手が 1 台も無ければサーバーが捨てる
    if (!statusUrl || watched.has(statusUrl)) return;
    watched.add(statusUrl);
    try {
      await postJson('/api/push/watch', { statusUrl, kind });
    } catch { /* 通知は補助機能なので、失敗しても生成には影響させない */ }
  }

  window.falPush = { watchFalJob };

  /* ---------- ステータスバーの色 ----------
   * ホーム画面から起動したときのステータスバーは theme-color に従うので、
   * テーマ（自動 / ライト / ダーク）に合わせて実際の背景色を入れる */

  function syncThemeColor() {
    const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
    if (!bg) return;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.removeAttribute('media'); // 実際の表示色で上書きするので、媒体条件は外す
      meta.content = bg;
    }
  }

  new MutationObserver(syncThemeColor).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);
  syncThemeColor();

  /* ---------- 起動 ---------- */

  async function init() {
    if (!('serviceWorker' in navigator)) {
      await renderButton();
      return;
    }
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      // 許可済みなら購読を送り直して維持する（端末の再起動や鍵の入れ替えにも追従）
      if (supported && Notification.permission === 'granted') {
        const sub = await currentSubscription();
        if (sub) {
          const result = await postJson('/api/push/subscribe', { subscription: sub.toJSON() }).catch(() => null);
          if (result?.deviceId) {
            deviceId = result.deviceId;
            storage.set(LS_DEVICE, deviceId);
          }
          startHeartbeat();
        }
      }
    } catch { /* Service Worker が使えない環境では通知なしで動く */ }
    await renderButton();
  }

  init();
})();
