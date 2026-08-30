'use strict';

/* ==========================================================================
 * ギャラリーの分割描画（共有コンポーネント）
 *
 * 生成・部分AI編集・画像編集の 3 画面が、履歴を全件まとめて DOM に並べていた。
 * 履歴は上限なく貯まるので、画面を開くだけで数千ノードを作ることになり、
 * スマホではメニューを移るたびに固まって見える原因になっていた。
 * サムネはどの画面も原寸画像なので、並べた枚数だけデコードも走る。
 *
 * ここでは「末尾が見えたぶんだけ足す」を 1 か所に置く。並べた件数は描き直しを
 * またいで保つので、下までスクロールしてからサムネを選んでも先頭には戻らない。
 *
 * サーバー側にも続きがあるときは setHasMore(true) を渡しておく。末尾まで並べ切って
 * なお続きがあれば onNeedMore が呼ばれるので、呼び出し側が次のページを取って
 * render し直す（取得中に何度も呼ばれないよう、呼び出し側で番をすること）。
 *
 *   const pager = falGallery.create(el, (record) => 要素を作って返す, { onNeedMore });
 *   pager.render(records);      // 並べ直す（並べていた件数は保つ）
 *   pager.setHasMore(bool);     // サーバー側に続きがあるか
 *   pager.clear();              // 空にする（「履歴はありません」を出すときなど）
 *   pager.reset();              // 次の render を先頭 1 ページぶんに戻す（絞り込みが変わったとき）
 *   pager.ensure(i);            // i 番目が並ぶまで広げる（キー操作で飛ぶときなど）
 * ========================================================================== */

(() => {

const PAGE = 30;

/**
 * @param {HTMLElement} container 並べ先。中身はこのページャが管理する
 * @param {(record: any, index: number) => HTMLElement} buildItem 1 件ぶんの要素を作る
 * @param {{ pageSize?: number, onNeedMore?: () => void }} opts
 */
function create(container, buildItem, opts = {}) {
  const { pageSize = PAGE, onNeedMore = null } = opts;
  let records = [];
  let shown = 0; // DOM に並べた件数
  let target = pageSize; // 並べておきたい件数（スクロールで増える）
  let hasMore = false; // サーバー側にまだ続きがあるか（呼び出し側が教える）

  // 末尾の番人。グリッドの 1 マスを食わないよう、全幅 1px にしておく
  const sentinel = document.createElement('div');
  sentinel.className = 'gallery-sentinel';
  sentinel.setAttribute('aria-hidden', 'true');

  // 基準はビューポート。生成画面のギャラリーは幅の広いときだけ自前でスクロールし、
  // 狭いときはページに流れる。ビューポート基準なら両方そのまま動く
  //（自前スクロールのときは番人が親に切り取られるので、rootMargin の先読みは効かない。
  //  1 ページ足すだけなので、そこで待たせることはない）
  // 未対応の環境（IntersectionObserver が無い）では最初から全件並べる＝従来どおり
  const io = window.IntersectionObserver
    ? new IntersectionObserver(
        (entries) => { if (entries.some((e) => e.isIntersecting)) grow(); },
        { rootMargin: '300px' },
      )
    : null;

  function syncSentinel() {
    // 手元に続きがあるか、サーバー側に続きがあるうちは番人を置いたままにする
    if (shown < records.length || hasMore) {
      container.appendChild(sentinel); // 追記のたびに末尾へ動かす
      io.observe(sentinel);
    } else {
      io?.unobserve(sentinel);
      sentinel.remove();
    }
  }

  function append(upTo) {
    sentinel.remove(); // 足したぶんより後ろへ回すので、いったん外す
    const frag = document.createDocumentFragment();
    for (let i = shown; i < upTo; i++) frag.appendChild(buildItem(records[i], i));
    container.appendChild(frag);
    shown = upTo;
    if (io) syncSentinel();
  }

  function grow() {
    if (shown < records.length) {
      target = shown + pageSize;
      append(Math.min(target, records.length));
      return;
    }
    // 手元のぶんは並べ切った。続きは呼び出し側に取ってきてもらう
    if (hasMore) onNeedMore?.();
  }

  return {
    render(list) {
      records = Array.isArray(list) ? list : [];
      container.innerHTML = '';
      shown = 0;
      // 未対応環境では全件。対応環境では、それまでに広げたぶんを保つ
      const want = io ? Math.max(target, pageSize) : records.length;
      append(Math.min(want, records.length));
    },

    clear() {
      records = [];
      shown = 0;
      container.innerHTML = '';
      io?.unobserve(sentinel);
    },

    reset() {
      target = pageSize;
    },

    setHasMore(value) {
      hasMore = !!value;
      if (io) syncSentinel();
    },

    ensure(index) {
      if (index < shown || index >= records.length) return;
      target = Math.max(target, index + 1);
      append(Math.min(target, records.length));
    },
  };
}

window.falGallery = { create };

})();
