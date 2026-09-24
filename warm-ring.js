'use strict';

/* ==========================================================================
 * Modal のウォーム表示（共有コンポーネント）
 *
 * Modal のコンテナはアイドルが続くと落ち、次の実行はコールドスタート（35〜60 秒）
 * になる。あと何秒もつかを数字で出すと急かされるので、**減っていくリングだけ**を
 * 実行ボタンの隣に置く（残り 30 秒で黄、10 秒で赤）。
 *
 * 起点（最後にコンテナを使い終わった時刻）はサーバー（/api/krea2/warm）が持つ。
 * どの端末・どの画面（生成 / 画像編集 / 比較アリーナ）から投げたジョブも Worker を
 * 通るので、そこが唯一の正になる。残りの計算だけをこちらで毎秒行う。
 * 同じコンテナを共有するエンドポイント（統合版 Krea 2 と Qwen 2.1 の生成・編集など）
 * には、サーバーが同じ時刻を配る。
 *
 *   const ring = falWarmRing.attach(el, {
 *     endpoint: () => 'qwen21-edit',   // 今見せるエンドポイントのキー（Modal 以外は null）
 *     busy: () => true,                // 実行中か（実行中は満ちたまま脈打たせる）
 *     verb: '編集',                    // ラベルの「次の○○はコールドスタート」
 *   });
 *   ring.sync();          // 選択を変えたとき。表示・1 秒ごとの描き直しを合わせる
 *   ring.refresh();       // サーバーに起点を訊き直す
 *   ring.note(endpoint);  // 自分のジョブが終わったとき（問い合わせずに起点を更新）
 *   ring.render();        // 実行中の本数が変わったときなど
 *
 * タブを裏に回したら描き直しを止め、戻ったら起点を訊き直す（ほかの画面・
 * 端末が温めているかもしれない）ところまでは、ここで面倒を見る。
 * ========================================================================== */

(() => {

const WARM_SOON_MS = 30_000; // ここから黄
const WARM_LAST_MS = 10_000; // ここから赤
const WARM_ARC_LEN = 2 * Math.PI * 9; // リングの円周（r=9・CSS の dasharray と同じ）

// 起点はどの画面でも同じものなので、1 ページの中では共有する
let warmWindowMs = 180_000; // サーバーの値で上書きする（modal_comfy の設定次第）
let warmAt = {}; // endpoint -> 最後に使い終わった時刻
let warmFetching = null;

function isHtml(res) {
  return (res.headers.get('Content-Type') ?? '').includes('text/html');
}

async function fetchWarm() {
  if (warmFetching) return warmFetching;
  warmFetching = (async () => {
    try {
      const res = await fetch('/api/krea2/warm');
      if (!res.ok || isHtml(res)) return;
      const data = await res.json();
      if (Number(data?.windowMs) > 0) warmWindowMs = Number(data.windowMs);
      if (data?.endpoints) warmAt = { ...warmAt, ...data.endpoints };
    } catch {
      // 取れなければ手元の記録のまま（オフラインなど）
    } finally {
      warmFetching = null;
    }
  })();
  return warmFetching;
}

function attach(el, { endpoint, busy = () => false, verb = '生成' }) {
  let timer = null;

  // 残り時間から見た目を決める。リングは「残り / 全体」ぶんだけ描く
  function view(now = Date.now()) {
    const key = endpoint();
    if (!key) return null;
    if (busy()) return { level: 'busy', ratio: 1, label: `${verb}中（コンテナは動いています）` };
    const left = (warmAt[key] ?? 0) + warmWindowMs - now;
    if (left <= 0) return { level: 'cold', ratio: 0, label: `冷えています（次の${verb}はコールドスタート）` };
    if (left <= WARM_LAST_MS) return { level: 'last', ratio: left / warmWindowMs, label: 'まもなく冷えます' };
    if (left <= WARM_SOON_MS) return { level: 'soon', ratio: left / warmWindowMs, label: 'もうすぐ冷えます' };
    return { level: 'warm', ratio: left / warmWindowMs, label: `ウォーム（すぐ${verb}できます）` };
  }

  // 前回描いた状態。変わっていない値は DOM に書かない。
  // リングは backdrop-filter（ぼかし）の効いた実行バーの中にあり、中身が変わるたびに
  // iOS はバー全体のぼかしを描き直す。1 秒ごとの描き直しを「変わったときだけ」に絞る
  const drawn = { hidden: null, level: null, label: null, offset: null };

  function render() {
    const v = view();
    if (drawn.hidden !== !v) {
      el.hidden = !v;
      drawn.hidden = !v;
    }
    if (!v) return;
    if (drawn.level !== v.level) {
      el.classList.remove('warm', 'soon', 'last', 'cold', 'busy');
      el.classList.add(v.level);
      drawn.level = v.level;
    }
    if (drawn.label !== v.label) {
      el.setAttribute('aria-label', v.label);
      el.title = v.label;
      drawn.label = v.label;
    }
    // 1/10 周（約 5.7）より細かい差は目に見えないので、そのぶんは描き直さない
    const offset = Math.round(WARM_ARC_LEN * (1 - v.ratio) * 10) / 10;
    if (drawn.offset !== offset) {
      el.querySelector('.warm-arc').style.strokeDashoffset = String(offset);
      drawn.offset = offset;
    }
  }

  async function refresh() {
    await fetchWarm();
    render();
  }

  function note(key) {
    if (!key) return;
    warmAt[key] = Date.now();
    render();
  }

  // 表示が要るあいだだけ 1 秒ごとに描き直す（タブが裏なら止める）
  function sync() {
    const want = !!endpoint() && document.visibilityState === 'visible';
    render();
    if (want && timer === null) {
      timer = setInterval(() => {
        const before = view()?.level;
        render();
        // 冷えた瞬間に一度だけ確かめる（ほかの端末が温め直しているかもしれない）
        if (before !== 'cold' && view()?.level === 'cold') refresh();
      }, 1000);
    } else if (!want && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    // 裏にいるあいだに他の画面・端末が温めているかもしれない
    if (document.visibilityState === 'visible' && endpoint()) refresh();
    sync(); // 裏では 1 秒ごとの描き直しを止める
  });

  return { render, refresh, note, sync };
}

window.falWarmRing = { attach };

})();
