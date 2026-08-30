// 画像アップロード（image-upload.js）の単体テスト:  node test/image-upload.test.mjs
//
// R2 のキーは中身の sha256 なので、持っている画像は送らずに済ませられる。
// 見るのは「問い合わせで済んだら本文を送らないこと」「送る必要があるときは
// ちゃんと送ること」、そして問い合わせが失敗しても保存だけは通ること。
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// 1x1 の PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HASH = createHash('sha256').update(Buffer.from(PNG.split(',')[1], 'base64')).digest('hex');

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json' }, ...init,
});

// handler は /api/upload に来た body だけを受ける（data URI の取得は本物に任せる）
function loadUpload(handler) {
  const sent = [];
  const sandbox = {
    console,
    crypto,
    Response,
    fetch: async (url, init) => {
      if (String(url).startsWith('data:')) return fetch(url); // バイト列の取り出し
      const body = JSON.parse(init.body);
      sent.push(body);
      return handler(body, sent.length);
    },
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(new URL('../image-upload.js', import.meta.url), 'utf8'), sandbox);
  return { falUpload: sandbox.falUpload, sent };
}

let passed = 0;
const check = (label, actual, expected) => {
  assert.deepEqual(actual, expected, label);
  passed++;
};

/* ---- 持っている画像は送らない ---- */
{
  const { falUpload, sent } = loadUpload(() => json({ url: `/api/image/${HASH}` }));
  const url = await falUpload.put(PNG, { app: 'test' });

  check('保存済みの URL が返る', url, `/api/image/${HASH}`);
  check('問い合わせ 1 回で済む', sent.length, 1);
  check('中身のハッシュを聞いている', sent[0], { hash: HASH });
  check('本文は送っていない', 'image' in sent[0], false);
}

/* ---- 持っていなければ送る ---- */
{
  const { falUpload, sent } = loadUpload((body, n) => (n === 1
    ? json({ url: null })
    : json({ url: `/api/image/${HASH}` })));
  const url = await falUpload.put(PNG, { app: 'test' });

  check('保存した URL が返る', url, `/api/image/${HASH}`);
  check('問い合わせ → 本文の 2 回', sent.length, 2);
  check('2 回目で本文を送っている', sent[1].image, PNG);
  check('meta も一緒に送る', sent[1].meta, { app: 'test' });
}

/* ---- meta が無ければ付けない ---- */
{
  const { falUpload, sent } = loadUpload((body, n) => (n === 1 ? json({ url: null }) : json({ url: '/x' })));
  await falUpload.put(PNG);
  check('meta を送らない', 'meta' in sent[1], false);
}

/* ---- 問い合わせが失敗しても保存は通す ---- */
{
  const { falUpload, sent } = loadUpload((body, n) => {
    if (n === 1) throw new TypeError('Failed to fetch');
    return json({ url: `/api/image/${HASH}` });
  });
  check('本文を送って保存できる', await falUpload.put(PNG), `/api/image/${HASH}`);
  check('本文つきで送り直している', sent.length, 2);
}

/* ---- 大きすぎるときは、サイズが分かる文言にする ---- */
{
  const { falUpload } = loadUpload((body, n) => (n === 1
    ? json({ url: null })
    : new Response('too large', { status: 413 })));
  await assert.rejects(() => falUpload.put(PNG), /大きすぎます/);
  passed++;
}

/* ---- Access のセッション切れ（ログインページの HTML が返る） ---- */
{
  const { falUpload } = loadUpload(() => new Response('<html>sign in</html>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }));
  await assert.rejects(() => falUpload.put(PNG), /ログインし直して/);
  passed++;
}

console.log(`ok: ${passed} checks passed`);
