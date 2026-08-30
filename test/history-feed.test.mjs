// 履歴の取得（history-feed.js）の単体テスト:  node test/history-feed.test.mjs
//
// 履歴に件数の上限が無いので、一覧は 1 ページぶんだけが返り、続きの位置が
// X-Next-Cursor で示される。絞り込み（q・type）もサーバー側でかかる。
// 見るのは「問い合わせを正しく組み立てること」と「取れなかったときに
// 中途半端なものを返さないこと」。
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

function loadFeed(handler) {
  const asked = [];
  const sandbox = {
    console,
    URLSearchParams,
    Response,
    fetch: async (url) => {
      asked.push(new URL(String(url), 'https://app.example'));
      return handler(asked.length);
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
    ...(cursor ? { 'X-Next-Cursor': cursor } : {}),
  },
});

let passed = 0;
const check = (label, actual, expected) => {
  assert.deepEqual(actual, expected, label);
  passed++;
};
const param = (url, key) => url.searchParams.get(key);

/* ---- 1 ページ取って、続きの位置を返す ---- */
{
  const { falHistory, asked } = loadFeed(() => json([{ id: 'a' }, { id: 'b' }], '1234'));
  const page = await falHistory.page();

  check('取れた記録を返す', page.records.map((r) => r.id), ['a', 'b']);
  check('続きの位置を返す', page.cursor, '1234');
  check('ok', page.ok, true);
  check('既定の件数を投げる', param(asked[0], 'limit'), '60');
  check('余計な絞り込みは付けない', [param(asked[0], 'q'), param(asked[0], 'cursor')], [null, null]);
}

/* ---- 絞り込みと続きの位置を渡す ---- */
{
  const { falHistory, asked } = loadFeed(() => json([]));
  await falHistory.page({ limit: 10, cursor: '99', q: '青い 犬', type: 'imgedit' });

  check('件数', param(asked[0], 'limit'), '10');
  check('続きの位置', param(asked[0], 'cursor'), '99');
  check('絞り込み（日本語と空白もそのまま）', param(asked[0], 'q'), '青い 犬');
  check('種類', param(asked[0], 'type'), 'imgedit');
}

/* ---- 続きが無ければ cursor は null ---- */
{
  const { falHistory } = loadFeed(() => json([{ id: 'a' }]));
  const page = await falHistory.page();
  check('最後のページ', page.cursor, null);
  check('記録は返る', page.records.length, 1);
}

/* ---- 空の履歴 ---- */
{
  const { falHistory } = loadFeed(() => json([]));
  const page = await falHistory.page();
  check('空でも ok', [page.ok, page.records.length, page.cursor], [true, 0, null]);
}

/* ---- 取れなかったとき（オフライン / セッション切れ / 5xx） ---- */
{
  const { falHistory } = loadFeed(() => { throw new TypeError('Failed to fetch'); });
  const page = await falHistory.page();
  check('オフラインは ok=false', [page.ok, page.records.length], [false, 0]);
}
{
  const { falHistory } = loadFeed(() => new Response('<html>sign in</html>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }));
  const page = await falHistory.page();
  check('ログインページを履歴として返さない', [page.ok, page.records.length], [false, 0]);
}
{
  const { falHistory } = loadFeed(() => new Response('boom', { status: 500 }));
  const page = await falHistory.page();
  check('エラー応答も ok=false', [page.ok, page.records.length], [false, 0]);
}

console.log(`ok: ${passed} checks passed`);
