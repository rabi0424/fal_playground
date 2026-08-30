'use strict';

/* ==========================================================================
 * 履歴のページ送り取得（共有コンポーネント）
 *
 * 履歴の件数に上限が無くなったので、GET /api/history は 1 ページぶんだけを返し、
 * 続きの位置を X-Next-Cursor（percent-encoded）で示す。
 *
 * 生成・部分AI編集・画像編集の 3 画面は「全件を手元に持って絞り込む」作りで、
 * ギャラリー検索も統計もそこに乗っている。そこでページを続けて取り、取れたぶんから
 * 順に呼び出し側へ渡す。最初の 1 ページで描き始められるので、件数が増えても
 * 画面が出るまでの待ち時間は変わらない（増えるのは、そのあと裏で追う量だけ）。
 *
 *   const got = await falHistory.fetchAll((page) => { ... });
 *   if (got.ok) { ... }  // 途中で切れていない（＝これで全件）
 * ========================================================================== */

(() => {

const PAGE = 500;

// Access のセッションが切れると、API がログインページ（HTML）へのリダイレクトになる。
// それを JSON として読もうとしないための判定
const isHtml = (res) => (res.headers.get('Content-Type') ?? '').includes('text/html');

/**
 * 履歴を新しい順に、ページごとに渡す。
 * @param {(page: any[], info: { first: boolean }) => void} onPage 1 ページぶん
 * @param {{ pageSize?: number }} opts
 * @returns {Promise<{ ok: boolean, total: number }>} ok は最後まで取れたか
 */
async function fetchAll(onPage, { pageSize = PAGE } = {}) {
  let cursor = '';
  let first = true;
  let total = 0;

  for (;;) {
    const params = new URLSearchParams({ limit: String(pageSize) });
    if (cursor) params.set('cursor', cursor);

    let res;
    try {
      res = await fetch(`/api/history?${params}`);
    } catch {
      return { ok: false, total }; // オフラインなど。取れたぶんは呼び出し側に渡してある
    }
    if (!res.ok || isHtml(res)) return { ok: false, total };

    const page = await res.json().catch(() => null);
    if (!Array.isArray(page)) return { ok: false, total };
    total += page.length;
    onPage(page, { first });
    first = false;

    // ヘッダは percent-encoded。URLSearchParams が入れ直すので、ここでは素に戻す
    const next = res.headers.get('X-Next-Cursor');
    if (!next) return { ok: true, total };
    cursor = decodeURIComponent(next);
  }
}

window.falHistory = { fetchAll };

})();
