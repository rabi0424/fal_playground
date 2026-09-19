'use strict';

/* ==========================================================================
 * 横スワイプで前後へ送る（共有コンポーネント）
 *
 * 拡大表示は横スワイプで前後の画像へ送れるようにしてあったが、同じ判定が
 * 画面ごとに写し取られていた。生成結果の画像にも同じ操作を付けるので、
 * ここに 1 か所へまとめる。
 *
 * 縦方向の動きが主なときは送らない（ページのスクロールを邪魔しないため）。
 * 送る / 送らないは指が動いている間に決める。離すまで待つと、ブラウザが途中で
 * スクロールとして引き取ったときに何も起きない（touchmove の注記を参照）。
 * 払わせる要素には touch-action: pan-y も当てておくこと。
 *
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
  let sent = false; // いま触れている指で、もう送ったか
  let swipedAt = 0;

  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    // 2 本指はピンチなどの別の操作。追いかけない
    if (!t || e.touches.length > 1) { start = null; return; }
    if (from && !e.target?.closest?.(from)) { start = null; return; }
    start = { x: t.clientX, y: t.clientY };
    // 前の指の送りはここで締める。送った先で描き直すと、触っていた要素が
    // 入れ替わって touchend が入れ物まで上がってこないことがあるため、
    // 「送った」の印を終わりの合図だけに頼らない（残ると次のタップを捨ててしまう）
    sent = false;
  }, { passive: true });

  // 送るかどうかは、指が動いている間に決める。
  //
  // 指を離すまで待つ作りだと、ページの中に置いた画像では効かないことがある。
  // ブラウザは横へ払った指を途中でスクロールとして引き取ることがあり、そうなると
  // touchcancel が飛んで touchend は来ない（iOS Safari）。拡大表示は画面を覆う
  // 固定の入れ物でスクロールに取られないので、離してから決めても効いていた。
  el.addEventListener('touchmove', (e) => {
    if (!start) return;
    if (e.touches.length > 1) { start = null; return; } // 途中からピンチ
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // 縦へ抜けたらスクロール。そのあと横へ戻ってきても送らない
    if (Math.abs(dy) > threshold && Math.abs(dy) >= Math.abs(dx)) { start = null; return; }
    if (Math.abs(dx) <= threshold || Math.abs(dx) <= Math.abs(dy)) return;
    start = null; // 1 回の指の動きで送るのは 1 つだけ
    if (enabled && !enabled()) return;
    sent = true;
    swipedAt = Date.now();
    onSwipe?.(dx < 0 ? 1 : -1);
  }, { passive: true });

  for (const type of ['touchend', 'touchcancel']) {
    el.addEventListener(type, () => {
      start = null;
      // click は指を離してから飛ぶ。払い切ったあと指を止めていることもあるので、
      // 捨てる猶予は「送った時刻」ではなく「離した時刻」から数え直す
      if (sent) swipedAt = Date.now();
      sent = false;
    }, { passive: true });
  }

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
