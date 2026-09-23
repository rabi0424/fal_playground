'use strict';

/* ==========================================================================
 * 端末間同期（共有コンポーネント）
 *
 * LoRA ライブラリ・チェックポイントライブラリ・比較アリーナのデータを
 * /api/state 経由で全端末に揃える。生成画面・LoRA ライブラリ・比較アリーナ・
 * 画像編集が同じものを使う。
 *
 * 以前は同じ 80 行が 3 つの JS に複製されていて、画像編集にだけ入っていなかった。
 * そのため画像編集から登録した LoRA は、その端末の localStorage に残るだけで
 * 他の端末へ渡らなかった。取り込みの入口が増えるたびに複製するのは無理があるので、
 * ここに 1 つだけ置く。
 *
 * 使う側は:
 *
 *   deviceSync.init({
 *     onRemote() { ... 届いた内容で画面を描き直す ... },
 *     canApply: () => saveTimers.size === 0,  // 反映を待たせたいとき（任意）
 *   });
 *   loraLib.onChange = () => deviceSync.markDirty('loras');
 *   deviceSync.pull();
 *
 * 注意: /api/state はドキュメント全体を置き換えるので、どの画面からも
 * SECTIONS の全部を送る（欠けると他の画面のデータが消える）。
 * ========================================================================== */

(() => {

const LS_SYNC_TS = 'fal_sync_ts';
const PUSH_DELAY_MS = 2000;

const SECTIONS = {
  loras: 'fal_lora_library',
  ckpts: 'fal_ckpt_library',
  arena: 'fal_arena',
};

let opts = {
  onRemote: () => {},
  canApply: () => true,
};
let pushTimer = null;

// Cloudflare Access のセッション切れは、API がログインページの HTML を返す
function isHtmlResponse(res) {
  return (res.headers.get('Content-Type') || '').includes('text/html');
}

function loadTs() {
  try {
    return JSON.parse(falStore.get(LS_SYNC_TS)) || {};
  } catch {
    return {};
  }
}

function saveTs(ts) {
  falStore.set(LS_SYNC_TS, JSON.stringify(ts));
}

// keepalive（ページを離れても送り切る）は、**本文が 64KB を超えると送信せずに
// fetch が即座に失敗する**（ブラウザの仕様。Chromium で 63KB から失敗を確認）。
// 以前は PUT を常に keepalive で送っていたので、LoRA ライブラリが 150 件ほどに
// 育って本文が 64KB を超えた時点から、**同期の送信がすべて黙って失敗していた**
// （設定した端末には残るが、ほかの端末には届かない）。
// keepalive はページを離れる直前の送信（flush）だけに使い、それも収まるときだけにする
const KEEPALIVE_MAX_BYTES = 60 * 1024;

function request(method, body, { keepalive = false } = {}) {
  return fetch('/api/state', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body,
    keepalive: keepalive && new TextEncoder().encode(body ?? '').length <= KEEPALIVE_MAX_BYTES,
  });
}

async function pull() {
  let doc;
  try {
    const res = await request('GET');
    if (!res.ok || isHtmlResponse(res)) return;
    doc = await res.json();
  } catch {
    return;
  }

  const ts = loadTs();
  let changed = false;
  let needPush = !doc;
  for (const [section, lsKey] of Object.entries(SECTIONS)) {
    const remote = doc?.[section];
    const localTs = ts[section] || 0;
    if (remote && remote.ts > localTs) {
      if (remote.value) falStore.set(lsKey, remote.value);
      else falStore.remove(lsKey);
      ts[section] = remote.ts;
      changed = true;
    } else if (localTs > (remote?.ts ?? 0)) {
      needPush = true;
    }
  }
  saveTs(ts);

  // 編集中に他端末の内容で画面を差し替えると入力が消えるので、呼び出し側が
  // 待たせたいときは反映しない（次の pull で追いつく）
  if (changed && opts.canApply()) {
    loraLib.migrate(); // 同期で届いた古い形式のデータもここで揃える
    opts.onRemote();
  }
  if (needPush) push();
}

async function push({ keepalive = false } = {}) {
  const ts = loadTs();
  const doc = {};
  for (const [section, lsKey] of Object.entries(SECTIONS)) {
    doc[section] = { value: falStore.get(lsKey) ?? '', ts: ts[section] || 0 };
  }
  // 失敗しても次の変更・次回起動時に再送される（手元の ts がサーバーより新しい
  // ままなので、次の pull が送り直す）。ただし黙って飲み込むと、ずっと失敗して
  // いても気づけないので、理由はコンソールに残す
  try {
    const res = await request('PUT', JSON.stringify(doc), { keepalive });
    if (!res.ok) console.warn(`[deviceSync] 同期の送信に失敗しました: HTTP ${res.status}`);
  } catch (e) {
    console.warn('[deviceSync] 同期の送信に失敗しました:', e);
  }
}

/* ---------- 公開 API ---------- */

window.deviceSync = {
  init(options) {
    opts = { ...opts, ...options };
  },

  // 変更を記録して、少し待ってから送る（連続した変更をまとめる）
  markDirty(section) {
    const ts = loadTs();
    ts[section] = Date.now();
    saveTs(ts);
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pull();
    }, PUSH_DELAY_MS);
  },

  pull,

  // 離脱前に、送信待ちが残っていれば送っておく
  flush() {
    if (!pushTimer) return;
    clearTimeout(pushTimer);
    pushTimer = null;
    push({ keepalive: true });
  },
};

})();
