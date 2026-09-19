'use strict';

/* ==========================================================================
 * 横スワイプで前後へ送る（共有コンポーネント）
 *
 * 拡大表示は横スワイプで前後の画像へ送れるようにしてあったが、同じ判定が
 * 画面ごとに写し取られていた。生成結果の画像にも同じ操作を付けるので、
 * ここに 1 か所へまとめる。
 *
 * 縦方向の動きが主なときは送らない（ページのスクロールを邪魔しないため）。
 * 指を離した位置では click も飛ぶので、送った直後かどうかを swiped() で
 * 見られるようにしてある。「タップで開く / 閉じる」の頭でこれを見て、
 * スワイプのぶんは捨てる（見ないと、送った先で拡大表示が開いてしまう）。
 *
 *   const swipe = falSwipe.attach(el, {
 *     onSwipe: (dir) => nav(dir),   // dir=+1: 左へ払った（右隣へ）/ -1: 右へ払った（左隣へ）
 *     from: 'img',                  // この選択子に載った指だけ拾う（省略時は入れ物ぜんぶ）
 *     enabled: () => !zoom.zoomed,  // false を返す間は見送る
 *   });
 *   if (swipe.swiped()) return;     // 直前がスワイプなら、その click は捨てる
 * ========================================================================== */

(() => {

const THRESHOLD = 40; // これ以上の横移動でページ送りとみなす
// 送ったあとの click を捨てる猶予。指を離してから click が飛ぶまでの間だけ効かせる
const CLICK_GUARD_MS = 600;

/**
 * @param {HTMLElement} el 指を拾う入れ物
 * @param {{ onSwipe?: (dir: 1|-1) => void, from?: string|null,
 *           enabled?: () => boolean, threshold?: number }} opts
 */
function attach(el, opts = {}) {
  const { onSwipe = null, from = null, enabled = null, threshold = THRESHOLD } = opts;
  let start = null; // 追いかけている指の始点
  let swipedAt = 0;

  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    // 2 本指はピンチなどの別の操作。追いかけない
    if (!t || e.touches.length > 1) { start = null; return; }
    if (from && !e.target?.closest?.(from)) { start = null; return; }
    start = { x: t.clientX, y: t.clientY };
  }, { passive: true });

  // 途中で指が増えたら、そこからはピンチ。送らない
  el.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) start = null;
  }, { passive: true });

  el.addEventListener('touchend', (e) => {
    const s = start;
    start = null;
    if (!s || !onSwipe) return;
    if (enabled && !enabled()) return;
    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) <= threshold || Math.abs(dx) <= Math.abs(dy)) return;
    swipedAt = Date.now();
    onSwipe(dx < 0 ? 1 : -1);
  }, { passive: true });

  el.addEventListener('touchcancel', () => { start = null; }, { passive: true });

  return {
    // 直前がスワイプだったか。続けて飛んでくる click 1 回ぶんだけ true を返して消える
    //（click が飛ばないこともあるので、時間でも切る）
    swiped() {
      if (!swipedAt || Date.now() - swipedAt >= CLICK_GUARD_MS) return false;
      swipedAt = 0;
      return true;
    },
  };
}

window.falSwipe = { attach };

})();
