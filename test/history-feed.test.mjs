// 履歴のページ送り取得（history-feed.js）の単体テスト:  node test/history-feed.test.mjs
//
// 見るのは 3 点:
//   - 続きが無くなるまでページを追い、取れたぶんから順に呼び出し側へ渡すこと
//   - 続きの位置（X-Next-Cursor）が percent-encoded なので、そのまま問い合わせに
//     入れ直すと二重エンコードになる。素に戻してから渡していること
//   - 途中で切れたとき（オフライン / Access のセッション切れ）は ok=false にして、
//     それまでに取れたぶんは呼び出し側に渡したままにすること
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

// pages: 1 ページぶんの配列の配列。fetch に来た URL は asked に記録する
function loadFeed(handler) {
  const asked = [];
  const sandbox = {
    console,
    URLSearchParams,
    Response,
    fetch: async (url) => {
      asked.push(String(url));
      return handler(new URL(String(url), 'https://app.example'), asked.length);
    },
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(new URL('../history-feed.js', import.meta.url), 'utf8'), sandbox);
  return { falHistory: sandbox.falHistory, asked };
}

const json = (body, cursor) => new Response(JSON.stringify(body), {
  headers: {
    'Content-Type': 'application/json',
    ...(cursor ? { 'X-Next-Cursor': encodeURIComponent(cursor) } : {}),
  },
});

// fetchAll の戻り値は vm の中で作られる（realm が違うと deepStrictEqual が落ちる）
// ので、比べる前に素のオブジェクトへ写す
let passed = 0;
const check = (label, actual, expected) => {
  assert.deepEqual(actual, expected, label);
  passed++;
};

// 実際に返る形の索引キー（':' を含むので、素で query に入れると壊れる）
const CURSOR = 'hidx:999999999999998:rec-1';

/* ---- 続きがある間は追う ---- */
{
  const { falHistory, asked } = loadFeed((url, n) => (n === 1
    ? json([{ id: 'a' }, { id: 'b' }], CURSOR)
    : json([{ id: 'c' }])));

  const pages = [];
  const got = await falHistory.fetchAll((page, info) => pages.push([page.map((r) => r.id), info.first]));

  check('取れたぶんをページごとに渡す', pages, [[['a', 'b'], true], [['c'], false]]);
  check('最後まで取れた', { ...got }, { ok: true, total: 3 });
  check('1 回目は先頭から', new URL(asked[0], 'https://x').searchParams.get('cursor'), null);
  // ヘッダは encode 済み。そのまま入れると %3A が %253A になって別のキーになる
  check('続きの位置が素に戻っている', new URL(asked[1], 'https://x').searchParams.get('cursor'), CURSOR);
}

/* ---- 空の履歴 ---- */
{
  const { falHistory, asked } = loadFeed(() => json([]));
  const pages = [];
  const got = await falHistory.fetchAll((page) => pages.push(page));
  check('空でも 1 度は渡す', pages, [[]]);
  check('空で終わる', { ...got }, { ok: true, total: 0 });
  check('余計に取りに行かない', asked.length, 1);
}

/* ---- 途中で切れた（オフライン） ---- */
{
  const { falHistory } = loadFeed((url, n) => {
    if (n === 1) return json([{ id: 'a' }], CURSOR);
    throw new TypeError('Failed to fetch');
  });
  const pages = [];
  const got = await falHistory.fetchAll((page) => pages.push(page.map((r) => r.id)));
  check('取れたぶんは渡してある', pages, [['a']]);
  check('最後までは取れていない', { ...got }, { ok: false, total: 1 });
}

/* ---- Access のセッション切れ（ログインページの HTML が返る） ---- */
{
  const { falHistory } = loadFeed(() => new Response('<html>sign in</html>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }));
  const pages = [];
  const got = await falHistory.fetchAll((page) => pages.push(page));
  check('HTML を履歴として渡さない', pages, []);
  check('ok=false で返る', { ...got }, { ok: false, total: 0 });
}

/* ---- 5xx ---- */
{
  const { falHistory } = loadFeed(() => new Response('boom', { status: 500 }));
  const got = await falHistory.fetchAll(() => {});
  check('エラー応答も ok=false', { ...got }, { ok: false, total: 0 });
}

console.log(`ok: ${passed} checks passed`);
