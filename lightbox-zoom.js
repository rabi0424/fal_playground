'use strict';

/* ==========================================================================
 * 拡大表示のズーム（共有コンポーネント）
 *
 * 拡大表示（lightbox）は画面に 1 枚出すだけで、細部を見るにはブラウザの
 * ピンチに頼るしかなかった。ここでは画像のダブルタップ（PC ではダブル
 * クリック）で拡大し、ドラッグで見たい場所へ動かせるようにする。
 *
 * 「タップで閉じる」は残す。ただしダブルタップと見分けるため、画像の上の
 * タップだけは 2 回目を待ってから閉じる（背景のタップは今までどおりその場で
 * 閉じる。画像の click は止めるので、呼び出し側の閉じる処理には届かない）。
 * ズーム中のシングルタップは等倍に戻すだけにしてある。拡大した画像は画面を
 * 覆うので、そのまま閉じてしまうと「戻したいだけ」のときに戻れない。
 *
 *   const zoom = falLightboxZoom.attach(lightboxEl, { onTap: closeLightbox });
 *   zoom.reset();   // 画像を切り替えた / 閉じたときに等倍へ戻す
 *                   //（指が触れている最中でもよい。その指はタップとして扱わない）
 *   zoom.zoomed     // ズーム中か（スワイプでの画像送りを止めるのに使う）
 * ========================================================================== */

(() => {

const ZOOM = 2.5;
// ダブルタップと見なす間隔。長くすると閉じるのが鈍く、短いと拾い損ねる
const TAP_WINDOW_MS = 260;
const TAP_SLOP = 24; // これ以上動いたらタップではなくドラッグ
const DOUBLE_SLOP = 40; // 1 回目と 2 回目のタップが離れすぎていたら別のタップ

/**
 * @param {HTMLElement} lightbox 拡大表示の入れ物（中の <img> を操作する）
 * @param {{ onTap?: () => void, zoomScale?: number }} opts
 */
function attach(lightbox, opts = {}) {
  const { onTap = null, zoomScale = ZOOM } = opts;
  const img = lightbox.querySelector('img');
  // zoomed は呼び出し側がスワイプを止めるのに読む。apply() で更新する
  const api = { reset: () => {}, zoomed: false };
  if (!img) return api;

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let base = { w: 0, h: 0 }; // 等倍のときの表示サイズ（はみ出し量の計算に使う）
  let drag = null; // ドラッグ開始時の指の位置と、そのときの平行移動量
  let moved = false;
  // いま触れている指を見送るか。reset() が指の触れている最中に呼ばれたとき（横スワイプで
  // 画像を送ったとき）に立てる。そのまま離すとタップと見なされ、閉じてしまうため
  let ignore = false;
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let tapTimer = null;

  const apply = () => {
    img.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    lightbox.classList.toggle('zoomed', scale !== 1);
    api.zoomed = scale !== 1;
  };

  // はみ出したぶんの中だけ動かせるようにする（引っ張っても余白が入り込まない）
  const clampPan = () => {
    const maxX = Math.max(0, (base.w * scale - (lightbox.clientWidth || 0)) / 2);
    const maxY = Math.max(0, (base.h * scale - (lightbox.clientHeight || 0)) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  };

  const reset = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    // 指が触れたまま呼ばれることがある（スワイプで画像を送ったとき、呼び出し側が
    // 画像を差し替えるために呼ぶ）。動かした印をここで消したまま指を離すと、
    // 動かしたのにタップと見なされて閉じてしまうので、その指は見送る
    if (drag) ignore = true;
    drag = null;
    moved = false;
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = null;
    lightbox.classList.remove('panning');
    apply();
  };

  // 触った点がその場に留まるように拡大する（見たい所を指で押さえたまま寄れる）
  const zoomAt = (x, y) => {
    const rect = img.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    base = { w: rect.width, h: rect.height };
    scale = zoomScale;
    tx = (x - cx) * (1 - scale);
    ty = (y - cy) * (1 - scale);
    clampPan();
    apply();
  };

  const onSingleTap = () => {
    tapTimer = null;
    // ズーム中は等倍に戻すだけ。閉じるのは背景タップ・✕・Esc に任せる
    if (scale !== 1) reset();
    else if (onTap) onTap();
  };

  const handleTap = (x, y) => {
    const now = Date.now();
    const near = Math.abs(x - lastTapX) < DOUBLE_SLOP && Math.abs(y - lastTapY) < DOUBLE_SLOP;
    if (now - lastTapAt < TAP_WINDOW_MS && near) {
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = null;
      lastTapAt = 0;
      if (scale === 1) zoomAt(x, y);
      else reset();
      return;
    }
    lastTapAt = now;
    lastTapX = x;
    lastTapY = y;
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = setTimeout(onSingleTap, TAP_WINDOW_MS);
  };

  img.draggable = false; // PC で画像そのものをドラッグ＆ドロップし始めないように

  img.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, tx, ty };
    moved = false;
    ignore = false; // 新しい指。前の指の見送りはここで終わり
    if (scale !== 1) {
      lightbox.classList.add('panning');
      img.setPointerCapture?.(e.pointerId);
    }
  });

  img.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) moved = true;
    if (scale === 1 || !moved) return;
    tx = drag.tx + dx;
    ty = drag.ty + dy;
    clampPan();
    apply();
  });

  const endDrag = () => {
    drag = null;
    lightbox.classList.remove('panning');
  };

  img.addEventListener('pointerup', (e) => {
    const skip = moved || ignore;
    endDrag();
    moved = false;
    ignore = false;
    if (skip) return; // 動かしたぶん・見送るぶんはタップとして扱わない
    handleTap(e.clientX, e.clientY);
  });

  img.addEventListener('pointercancel', () => {
    endDrag();
    moved = false;
    ignore = false;
  });

  // 画像の上のタップは自分で始末する。呼び出し側の「タップで閉じる」に
  // 素通しすると、ダブルタップの 1 回目で閉じてしまう
  img.addEventListener('click', (e) => e.stopPropagation());
  img.addEventListener('dblclick', (e) => e.preventDefault());

  // 画面の向きや大きさが変わると、はみ出し量の前提が崩れる
  window.addEventListener?.('resize', () => {
    if (scale !== 1) reset();
  });

  api.reset = reset;
  return api;
}

window.falLightboxZoom = { attach };

})();
