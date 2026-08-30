'use strict';

/* ==========================================================================
 * 履歴の取得（共有コンポーネント）
 *
 * 履歴に件数の上限が無いので、GET /api/history は 1 ページぶんだけを返し、
 * 続きの位置を X-Next-Cursor（前のページ最後の seq）で示す。
 * 絞り込み（q・type）もサーバー側でかかるので、呼び出し側は
 * 「いま見えているぶん」だけを持てばよい。
 *
 *   const page = await falHistory.page({ limit: 60 });
 *   if (page.ok) render(page.records);
 *   if (page.cursor) つづきがある → falHistory.page({ cursor: page.cursor })
 * ========================================================================== */

(() => {

const PAGE = 60;

// Access のセッションが切れると、API がログインページ（HTML）へのリダイレクトになる。
// それを JSON として読もうとしないための判定
const isHtml = (res) => (res.headers.get('Content-Type') ?? '').includes('text/html');

/**
 * 履歴を新しい順に 1 ページ取る。
 * @param {{ limit?: number, cursor?: string|null, q?: string, type?: string }} opts
 * @returns {Promise<{ ok: boolean, records: any[], cursor: string|null }>}
 *   ok=false は取れなかったとき（オフライン・セッション切れなど）
 */
async function page({ limit = PAGE, cursor = null, q = '', type = '' } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  if (q) params.set('q', q);
  if (type) params.set('type', type);

  const fail = { ok: false, records: [], cursor: null };
  let res;
  try {
    res = await fetch(`/api/history?${params}`);
  } catch {
    return fail; // オフラインなど
  }
  if (!res.ok || isHtml(res)) return fail;

  const records = await res.json().catch(() => null);
  if (!Array.isArray(records)) return fail;
  return { ok: true, records, cursor: res.headers.get('X-Next-Cursor') };
}

window.falHistory = { page, PAGE };

})();
