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
 * LoRA / チェックポイントのライブラリは**項目ごとに新しい方を採る**
 * （sync-merge.js）。手元で変わった項目には markDirty / pull のときに
 * 変更時刻（updatedAt）を付け、消した項目は墓標として覚えておく。
 * そのため、ライブラリを書き換える側は今までどおり配列を丸ごと保存すれば
 * よく、時刻を意識しなくてよい（前回の中身と見比べてここで付ける）。
 *
 * サーバーもセクションごと・項目ごとにマージするので、どの画面から
 * SECTIONS の全部を送っても、ほかの端末の変更は消えない。
 * ========================================================================== */

(() => {

const LS_SYNC_TS = 'fal_sync_ts';
// 項目ごとの「前回見た中身（のハッシュ）と変更時刻」。これと見比べて、
// 手元で変わった項目にだけ新しい時刻を付ける
const LS_SYNC_BASE = 'fal_sync_base';
// 消した項目の墓標 { section: { key: 消した時刻 } }
const LS_SYNC_DELETED = 'fal_sync_deleted';
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

function loadJson(key) {
  try {
    return JSON.parse(falStore.get(key)) || {};
  } catch {
    return {};
  }
}

const M = () => window.falSyncMerge;

// 項目の中身の短いハッシュ（FNV-1a 32bit）。前回の中身をそのまま持つと
// ライブラリがもう 1 つ localStorage に載るので、ハッシュだけ持つ
function hashOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// 手元で変わった項目に変更時刻を付け、消えた項目を墓標に記録する。
//
// 初めて同期するとき（前回の記録が無いとき）は、由来の分からない項目を
// 時刻 0 として扱う。どちらが新しいかはサーバー側の規則で決まる（sync-merge.js）
function stamp(section) {
  const key = M().ITEM_KEYS[section];
  const lsKey = SECTIONS[section];
  const items = M().parseItems(falStore.get(lsKey));
  const bases = loadJson(LS_SYNC_BASE);
  const base = bases[section];
  const allDeleted = loadJson(LS_SYNC_DELETED);
  const deleted = allDeleted[section] ?? {};
  const now = Date.now();
  const next = {};
  let touched = false;

  for (const item of items) {
    const k = item?.[key];
    if (typeof k !== 'string') continue;
    const h = hashOf(M().contentOf(item));
    const prev = base?.[k];
    let t;
    if (!base) t = Number.isFinite(item.updatedAt) ? item.updatedAt : 0;
    else if (prev && prev.h === h) t = prev.t; // 変わっていない（呼び出し側が時刻を落としていても戻す）
    else t = now;
    if (item.updatedAt !== t) {
      item.updatedAt = t;
      touched = true;
    }
    next[k] = { h, t };
    if (deleted[k] !== undefined && t > deleted[k]) delete deleted[k];
  }
  if (base) {
    for (const k of Object.keys(base)) if (!next[k]) deleted[k] = now;
  }

  if (touched) falStore.set(lsKey, JSON.stringify(items));
  bases[section] = next;
  allDeleted[section] = deleted;
  falStore.set(LS_SYNC_BASE, JSON.stringify(bases));
  falStore.set(LS_SYNC_DELETED, JSON.stringify(allDeleted));
}

function stampAll() {
  for (const section of Object.keys(SECTIONS)) {
    if (M().isItemSection(section)) stamp(section);
  }
}

// 手元の 1 セクションを、同期ドキュメントの形で取り出す
function localSection(section, ts) {
  const out = { value: falStore.get(SECTIONS[section]) ?? '', ts: ts[section] || 0 };
  if (M().isItemSection(section)) out.deleted = loadJson(LS_SYNC_DELETED)[section] ?? {};
  return out;
}

// マージ結果を手元に書く。項目単位のセクションは、書いた内容を「前回見た中身」にもする
// （そうしないと、次の stamp が届いた変更を手元の変更と取り違える）
function writeLocal(section, merged, ts) {
  const lsKey = SECTIONS[section];
  if (merged.value) falStore.set(lsKey, merged.value);
  else falStore.remove(lsKey);
  ts[section] = merged.ts || 0;
  if (!M().isItemSection(section)) return;

  const key = M().ITEM_KEYS[section];
  const next = {};
  for (const item of M().parseItems(merged.value)) {
    if (typeof item?.[key] !== 'string') continue;
    next[item[key]] = { h: hashOf(M().contentOf(item)), t: Number.isFinite(item.updatedAt) ? item.updatedAt : 0 };
  }
  const bases = loadJson(LS_SYNC_BASE);
  bases[section] = next;
  falStore.set(LS_SYNC_BASE, JSON.stringify(bases));
  const allDeleted = loadJson(LS_SYNC_DELETED);
  allDeleted[section] = merged.deleted ?? {};
  falStore.set(LS_SYNC_DELETED, JSON.stringify(allDeleted));
}

// サーバーの内容と手元を合わせる。手元が変わったか・サーバーに送るべきかを返す
function reconcile(doc) {
  const ts = loadTs();
  let changed = false;
  let needPush = !doc;
  for (const section of Object.keys(SECTIONS)) {
    const local = localSection(section, ts);
    const remote = doc?.[section];
    // 項目単位のセクションは、サーバーがまだ新形式でなければ手元を、新形式なら
    // サーバーを同時刻で優先する（sync-merge.js の「移行」）。
    // 比較アリーナは ts の大きい方。同じならサーバーのものを採る
    const merged = M().mergeSection(section, local, remote, {
      primaryWinsTie: M().isItemSection(section) ? !(remote?.v >= 2) : false,
    });
    if (!merged) continue;
    if (!M().sameSection(section, merged, local)) {
      writeLocal(section, merged, ts);
      changed = true;
    } else {
      ts[section] = Math.max(ts[section] || 0, merged.ts || 0);
    }
    if (!M().sameSection(section, merged, remote)) needPush = true;
  }
  saveTs(ts);
  if (changed) {
    loraLib.migrate(); // 同期で届いた古い形式のデータもここで揃える
    opts.onRemote();
  }
  return { changed, needPush };
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
  // 編集中（保存待ち）の画面は、手元の配列を持ったまま後で保存する。ここで
  // 届いた内容を書き込むと、その保存が古い配列で上書きしてしまうので、
  // 触らずに帰る（保存 → markDirty → pull で追いつく）
  if (!opts.canApply()) return;

  let doc;
  try {
    const res = await request('GET');
    if (!res.ok || isHtmlResponse(res)) return;
    doc = await res.json();
  } catch {
    return;
  }
  if (!opts.canApply()) return; // 取り寄せている間に編集が始まった

  stampAll(); // 通知し損ねた手元の変更もここで拾う
  const { needPush } = reconcile(doc);
  if (needPush) await push();
}

async function push({ keepalive = false } = {}) {
  stampAll();
  const ts = loadTs();
  const doc = {};
  for (const section of Object.keys(SECTIONS)) doc[section] = localSection(section, ts);
  // 失敗しても次の pull が送り直す（手元にしか無い変更は、サーバーと見比べれば分かる）。
  // ただし黙って飲み込むと、ずっと失敗していても気づけないので、理由はコンソールに残す
  let res;
  try {
    res = await request('PUT', JSON.stringify(doc), { keepalive });
  } catch (e) {
    console.warn('[deviceSync] 同期の送信に失敗しました:', e);
    return;
  }
  if (!res.ok || isHtmlResponse(res)) {
    console.warn(`[deviceSync] 同期の送信に失敗しました: HTTP ${res.status}`);
    return;
  }
  // サーバーはほかの端末の変更と合わせた結果を返すので、それを手元にも入れる。
  // ここでは送り直さない（行き来が止まらなくなるのを避ける。差は次の pull で埋まる）
  const merged = await res.json().catch(() => null);
  if (merged && opts.canApply()) reconcile(merged);
}

// 各画面は「開いたとき」と「タブが前面に戻ったとき」に pull する。ただし戻る
// ボタンなどで bfcache から復元されたときは、読み込みも visibilitychange も
// 起きない（iOS Safari）。そのままだと前に開いたときの内容が出続けるので、
// 復元されたときにも取り寄せる
window.addEventListener('pageshow', (e) => {
  if (e.persisted) pull();
});

/* ---------- 公開 API ---------- */

window.deviceSync = {
  init(options) {
    opts = { ...opts, ...options };
  },

  // 変更を記録して、少し待ってから送る（連続した変更をまとめる）
  markDirty(section) {
    // 変わった瞬間の時刻で記録する（送るまでの間に別の変更が来ても順番が狂わない）
    if (M().isItemSection(section)) stamp(section);
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
