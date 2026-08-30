// 履歴 API とカタログ（D1）のテスト:  node test/history.test.mjs
//
// API 側で見るのは 4 点:
//   - 一覧（GET /api/history）がマスクを外して返すこと。マスクは塗った線の座標を
//     そのまま持つので 1 件で数十 KB あり、一覧に混ぜると毎回の転送量になる
//   - 1 件取得（GET /api/history/<id>）はマスクを含む丸ごとを返すこと
//   - 保存（POST）はマスクを捨てず、応答にも含めて返すこと
//     （画像編集は応答をそのまま持って塗り直しの保存に使う）
//   - 一覧が limit / cursor でページ送りできること
//
// カタログ側では、履歴が D1 の history 表と history_images 表に入っていること、
// 画像を共有している記録が残っているうちは R2 から消さないこと、そして
// Durable Object に貯まっていた過去のレコード（旧レイアウトを含む）が
// 並び順そのままで D1 へ移ることを見る。
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeStorage, makeBucket, makeD1 } from './harness.mjs';

const WORKER = new URL('../worker.js', import.meta.url);
const OUT = new URL('./.history.test.mjs', import.meta.url);

const PATCHES = [
  ["import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'],
];

async function loadWorker(extra = []) {
  let src = readFileSync(WORKER, 'utf8');
  for (const [from, to] of [...PATCHES, ...extra]) {
    assert.equal(src.split(from).length - 1, 1, `patch target not found once: ${from}`);
    src = src.replace(from, to);
  }
  writeFileSync(OUT, src);
  return import(`${OUT.href}?v=${Date.now()}${Math.random()}`);
}

// Durable Object の stub と D1 をぶら下げた env（実物と同じく単一インスタンス）
function makeEnv(mod, storage = makeStorage()) {
  const bucket = makeBucket({ sub: 0 });
  const stub = new mod.SyncState({ storage }, { IMAGES: bucket });
  const d1 = makeD1();
  const env = { STATE: { idFromName: () => 'singleton', get: () => stub }, IMAGES: bucket, DB: d1 };
  return Object.assign(env, { storage, stub, bucket, d1 });
}

// D1 を直接のぞく（表の形そのものを確かめるため）
const rows = (env, sql, ...args) => env.d1.db.prepare(sql).all(...args).map((r) => ({ ...r }));

const nextCursor = (res) => res.headers.get('X-Next-Cursor');

const MASK = { feather: 0.01, strokes: [{ mode: 'add', pts: [[0.1, 0.2], [0.3, 0.4]] }] };
const imageId = (n) => String(n).padStart(32, '0');
const imageUrl = (n) => `/api/image/${imageId(n)}`;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// 裏の片付けは ctx.waitUntil に乗せて応答のあとに走る。本物と同じ形で受けて、
// settle() で終わるまで待てるようにする
const pending = [];
const call = (mod, env, path, init) =>
  mod.default.fetch(new Request(`https://x${path}`, init), env, {
    waitUntil: (promise) => pending.push(promise),
  });
const settle = () => Promise.all(pending.splice(0));

const postRecord = (mod, env, record) => call(mod, env, '/api/history', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(record),
});

const listIds = async (mod, env, query = '') =>
  (await (await call(mod, env, `/api/history${query}`)).json()).map((r) => r.id);

/* ---- API の形 ---- */

test('一覧はマスクを外し、1 件取得は丸ごと返す', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  const saved = await (await postRecord(mod, env, {
    id: 'rec-1',
    type: 'imgedit',
    prompt: 'remove the cup',
    masked: true,
    mask: MASK,
    images: [{ url: imageUrl(1) }],
  })).json();
  // 保存の応答はマスク込み（画像編集はこれを持って塗り直しを保存する）
  assert.deepEqual(saved.mask, MASK);

  const list = await (await call(mod, env, '/api/history')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'rec-1');
  assert.equal('mask' in list[0], false, '一覧にマスクが残っています');
  // マスクの有無を見分ける印は残す（「マスクを調整」の出し分けに使う）
  assert.equal(list[0].masked, true);
  assert.equal(list[0].prompt, 'remove the cup');

  const one = await (await call(mod, env, '/api/history/rec-1')).json();
  assert.deepEqual(one.mask, MASK);
});

test('マスクの無いレコードはそのまま返る', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  await postRecord(mod, env, { id: 'rec-2', prompt: 'a cat', images: [] });
  const list = await (await call(mod, env, '/api/history')).json();
  // seq は並び順としてサーバーが振る通し番号
  assert.deepEqual(list[0], { id: 'rec-2', prompt: 'a cat', images: [], seq: 1 });
});

test('知らない id は 404、GET と DELETE 以外は 405', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  assert.equal((await call(mod, env, '/api/history/nope')).status, 404);
  assert.equal((await call(mod, env, '/api/history/rec-1', { method: 'PUT' })).status, 405);
});

test('id はルートが受ける形だけ通す', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  // 通らない id を保存できてしまうと、1 件取得も削除もできないレコードが残る
  assert.equal((await postRecord(mod, env, { id: 'あ/い', images: [] })).status, 422);
  assert.equal((await postRecord(mod, env, { id: '', images: [] })).status, 422);
  assert.equal((await postRecord(mod, env, { id: 'ok.id-1_2', images: [] })).status, 200);
});

/* ---- カタログの形 ---- */

test('履歴は D1 の表に入り、マスクは列を分ける', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  await postRecord(mod, env, { id: 'a', prompt: '1 番目', model: 'flux', images: [{ url: imageUrl(1) }] });
  await postRecord(mod, env, { id: 'b', prompt: '2 番目', mask: MASK, images: [{ url: imageUrl(2) }] });

  const catalog = rows(env, 'SELECT seq, id, source, model, prompt, mask FROM history ORDER BY seq DESC');
  assert.deepEqual(catalog.map((r) => r.id), ['b', 'a'], '新しい順に並びます');
  assert.equal(catalog[1].model, 'flux', '絞り込みに使う列が空です');
  assert.equal(catalog[1].prompt, '1 番目');
  assert.equal(catalog.every((r) => r.source === 'playground'), true);
  // マスクは record 列ではなく mask 列。一覧の SELECT が読まないので転送量に乗らない
  assert.deepEqual(JSON.parse(catalog[0].mask), MASK);
  assert.equal(catalog[1].mask, null);
  assert.equal('mask' in JSON.parse(rows(env, 'SELECT record FROM history WHERE id = ?', 'b')[0].record), false);

  // 画像の参照が張られる（消してよいかの判断と /api/capture がここを引く）
  assert.deepEqual(
    rows(env, 'SELECT url, history_id FROM history_images ORDER BY history_id'),
    [{ url: imageUrl(1), history_id: 'a' }, { url: imageUrl(2), history_id: 'b' }],
  );
});

test('同じ id の保存は差し替えになり、増えない', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  await postRecord(mod, env, { id: 'a', prompt: '前', images: [{ url: imageUrl(1) }] });
  await postRecord(mod, env, { id: 'b', prompt: 'ほか', images: [] });
  await postRecord(mod, env, { id: 'a', prompt: '後', images: [{ url: imageUrl(2) }] });

  const list = await (await call(mod, env, '/api/history')).json();
  assert.deepEqual(list.map((r) => r.id), ['a', 'b'], '差し替えた側が先頭に来ます');
  assert.equal(list[0].prompt, '後');
  assert.equal(rows(env, 'SELECT id FROM history').length, 2);
  // 参照も張り替わる（前の画像を指したままにしない）
  assert.deepEqual(
    rows(env, 'SELECT url FROM history_images WHERE history_id = ?', 'a').map((r) => r.url),
    [imageUrl(2)],
  );
});

/* ---- ページ送り ---- */

test('limit と cursor でページを刻める', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  for (let i = 1; i <= 5; i++) await postRecord(mod, env, { id: `r${i}`, images: [] });

  const first = await call(mod, env, '/api/history?limit=2');
  assert.deepEqual((await first.json()).map((r) => r.id), ['r5', 'r4']);

  const second = await call(mod, env, `/api/history?limit=2&cursor=${nextCursor(first)}`);
  assert.deepEqual((await second.json()).map((r) => r.id), ['r3', 'r2']);

  const third = await call(mod, env, `/api/history?limit=2&cursor=${nextCursor(second)}`);
  assert.deepEqual((await third.json()).map((r) => r.id), ['r1']);
  assert.equal(nextCursor(third), null, '最後のページで続きを返しています');
});

test('件数の上限は無く、1 ページの取得は件数に依らず数クエリで済む', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  for (let i = 1; i <= 40; i++) {
    await env.IMAGES.put(`${imageId(i)}.png`, 'png');
    await postRecord(mod, env, { id: `r${i}`, images: [{ url: imageUrl(i) }] });
  }

  assert.equal(rows(env, 'SELECT id FROM history').length, 40, '古いものが勝手に消えています');
  assert.ok(await env.bucket.get(`${imageId(1)}.png`), '古い画像が消えています');

  // 無料プランの D1 は 1 リクエスト 50 クエリまで。一覧はここに収まり続ける必要がある
  const before = env.d1.counters.queries;
  assert.deepEqual(await listIds(mod, env), Array.from({ length: 40 }, (_, i) => `r${40 - i}`));
  assert.ok(env.d1.counters.queries - before <= 3, `一覧で ${env.d1.counters.queries - before} クエリ使っています`);
});

/* ---- 削除 ---- */

test('削除しても他のレコードは残る', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  await postRecord(mod, env, { id: 'rec-1', mask: MASK, images: [] });
  await postRecord(mod, env, { id: 'rec-2', images: [] });
  assert.equal((await call(mod, env, '/api/history/rec-1', { method: 'DELETE' })).status, 200);

  assert.deepEqual(await listIds(mod, env), ['rec-2']);
  assert.equal(rows(env, 'SELECT url FROM history_images WHERE history_id = ?', 'rec-1').length, 0);
});

test('画像を共有している記録が残っているうちは、その画像を消さない', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  await env.IMAGES.put(`${imageId(1)}.png`, 'png');
  await env.IMAGES.put(`${imageId(2)}.png`, 'png');

  // 編集の入力に使い回すと、同じ画像が 2 つの記録に載る
  await postRecord(mod, env, { id: 'src', images: [{ url: imageUrl(1) }] });
  await postRecord(mod, env, { id: 'edit', images: [{ url: imageUrl(2) }, { url: imageUrl(1) }] });

  await call(mod, env, '/api/history/src', { method: 'DELETE' });
  assert.ok(await env.bucket.get(`${imageId(1)}.png`), 'まだ使っている画像を消しています');

  await call(mod, env, '/api/history/edit', { method: 'DELETE' });
  assert.equal(await env.bucket.get(`${imageId(1)}.png`), null, '参照が無くなった画像が残っています');
  assert.equal(await env.bucket.get(`${imageId(2)}.png`), null);
});

test('全消しは実体も画像も消し、終わらなければ done: false を返す', async () => {
  // 1 リクエストで消しきれない件数にして、続きがあることを示せるか見る
  const mod = await loadWorker([['const HISTORY_CLEAR_PAGE = 200;', 'const HISTORY_CLEAR_PAGE = 2;'],
    ['const HISTORY_CLEAR_BUDGET = 40;', 'const HISTORY_CLEAR_BUDGET = 4;']]);
  const env = makeEnv(mod);
  for (let i = 1; i <= 6; i++) {
    await env.IMAGES.put(`${imageId(i)}.png`, 'png');
    await postRecord(mod, env, { id: `r${i}`, images: [{ url: imageUrl(i) }] });
  }

  const first = await (await call(mod, env, '/api/history', { method: 'DELETE' })).json();
  assert.equal(first.done, false, '一度で終わったことになっています');
  assert.ok(rows(env, 'SELECT id FROM history').length > 0);

  for (let guard = 0; guard < 10; guard++) {
    const res = await (await call(mod, env, '/api/history', { method: 'DELETE' })).json();
    if (res.done) break;
  }
  assert.equal(rows(env, 'SELECT id FROM history').length, 0);
  assert.equal(rows(env, 'SELECT url FROM history_images').length, 0);
  assert.equal(await env.bucket.get(`${imageId(1)}.png`), null, '画像が残っています');
  assert.deepEqual(await listIds(mod, env), []);
});

/* ---- スキーマの更新（既にある DB への追従） ---- */

// image_id 列が無かった頃の DB を作る（本番がこの形だった）
function seedOldCatalog(env, count, imagesPerRecord = 4) {
  for (const sql of [
    `CREATE TABLE history (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
       source TEXT NOT NULL DEFAULT 'playground', type TEXT NOT NULL DEFAULT '',
       created INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL DEFAULT '',
       prompt TEXT NOT NULL DEFAULT '', record TEXT NOT NULL, mask TEXT)`,
    'CREATE TABLE history_images (url TEXT NOT NULL, history_id TEXT NOT NULL, PRIMARY KEY (url, history_id))',
    'CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  ]) env.d1.db.prepare(sql).run();

  const ins = env.d1.db.prepare(
    'INSERT INTO history (seq,id,source,type,created,model,prompt,record) VALUES (?,?,?,?,?,?,?,?)',
  );
  for (let i = 1; i <= count; i++) {
    const id = `old-${i}`;
    const images = Array.from({ length: imagesPerRecord }, (_, n) => ({
      url: `/api/image/${String(i * 10 + n).padStart(32, '0')}`,
    }));
    ins.run(i, id, 'playground', '', 1780000000000 + i, 'modal/krea2-exp', 'p', JSON.stringify({ id, images }));
  }
  // Durable Object からの引き取りは済んでいる状態
  env.d1.db.prepare("INSERT INTO meta (k,v) VALUES ('history_migrated','done')").run();
}

test('image_id 列が無い既存の DB でも、一覧が落ちない', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  seedOldCatalog(env, 20);

  // 列を足す ALTER より先に、その列を使う CREATE INDEX を流すと
  // 「no such column: image_id」で履歴 API がまるごと 500 になる
  const res = await call(mod, env, '/api/history?limit=500');
  assert.equal(res.status, 200, '一覧が落ちています');
  assert.equal((await res.json()).length, 20);

  const cols = rows(env, 'PRAGMA table_info(history_images)').map((c) => c.name);
  assert.ok(cols.includes('image_id'), `列が足されていません: ${cols.join(', ')}`);
});

test('既存の画像参照に image_id が埋め戻され、一覧は全件たどれる', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  seedOldCatalog(env, 120);

  let ids = [];
  for (let guard = 0; guard < 30; guard++) {
    ids = await listIds(mod, env, '?limit=500'); // 作り直しは 1 リクエストずつ進む
    const done = rows(env, "SELECT v FROM meta WHERE k = 'image_links_rebuilt'").length > 0;
    if (done) break;
  }
  assert.equal(ids.length, 120);
  assert.equal(rows(env, 'SELECT url FROM history_images').length, 120 * 4);
  assert.equal(rows(env, 'SELECT url FROM history_images WHERE image_id IS NULL').length, 0,
    'image_id が埋まっていない参照が残っています');
});

test('1 リクエストの D1 クエリ数は、無料プランの上限（50）に収まる', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  // 1 レコード 8 枚。画像編集や比較アリーナはこれくらいになる
  seedOldCatalog(env, 300, 8);

  let worst = 0;
  for (let req = 0; req < 25; req++) {
    const before = env.d1.counters.queries;
    const res = await call(mod, env, '/api/history?limit=500');
    worst = Math.max(worst, env.d1.counters.queries - before);
    assert.equal(res.status, 200, `${req + 1} 回目で落ちました`);
  }
  // 裏の片付け（スキーマ更新・参照の作り直し）が一覧を巻き添えにしないこと
  assert.ok(worst <= 50, `1 リクエストで ${worst} クエリ使っています`);
});

/* ---- 外部 URL の取り込み ---- */

// 外部 CDN の画像を返す fetch。取れない URL は 404 にする
function stubCdn(alive = true) {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (!alive) return new Response('gone', { status: 404 });
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  };
  return asked;
}

const CDN = 'https://d2h7xmz5gqybh9.cloudfront.net/output/a.png';

test('保存のとき、プロバイダのドメインでなくても取り込む', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  const asked = stubCdn();

  // WaveSpeed は出力を別ドメインの CDN で返す。以前はここが許可リストから漏れていた
  const saved = await (await postRecord(mod, env, {
    id: 'r1', ts: Date.now(), model: 'wavespeed-ai/qwen-image/edit-2511-lora',
    images: [{ url: CDN }],
  })).json();

  assert.equal(asked.length, 1, '取りに行っていません');
  assert.match(saved.images[0].url, /^\/api\/image\/[0-9a-f]{64}$/, `取り込まれていません: ${saved.images[0].url}`);
  assert.equal(env.bucket.objects.size, 1);
  // 参照にも id が入る（＝回収の対象になり、未取り込みの印も消える）
  assert.equal(rows(env, 'SELECT url FROM history_images WHERE image_id IS NULL').length, 0);
});

test('相対 URL（取り込み済み）は取りに行かない', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  const asked = stubCdn();

  await postRecord(mod, env, { id: 'r1', images: [{ url: imageUrl(1) }] });
  assert.deepEqual(asked, [], '保存済みの画像を取りに行っています');
});

test('取り込み漏れは、あとから裏で拾われる', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  stubCdn();

  // 取り込みの条件を広げる前に保存されたぶん（外部 URL のまま）を作る
  await postRecord(mod, env, { id: 'r1', images: [{ url: CDN }, { url: imageUrl(1) }] });
  env.d1.db.prepare('UPDATE history SET record = ? WHERE id = ?')
    .run(JSON.stringify({ id: 'r1', images: [{ url: CDN }, { url: imageUrl(1) }] }), 'r1');
  env.d1.db.prepare('DELETE FROM history_images').run();
  env.d1.db.prepare('INSERT INTO history_images (url, history_id, image_id) VALUES (?,?,NULL),(?,?,?)')
    .run(CDN, 'r1', imageUrl(1), 'r1', imageId(1));
  env.bucket.objects.clear();

  // 一覧の取得に便乗して片付けが走る（応答は先に返るので、ここでは直接呼ぶ）
  await call(mod, env, '/api/history');
  await settle();

  const record = await (await call(mod, env, '/api/history/r1')).json();
  assert.match(record.images[0].url, /^\/api\/image\/[0-9a-f]{64}$/, 'レコードの URL が差し替わっていません');
  assert.equal(record.images[1].url, imageUrl(1), 'ほかの画像まで書き換えています');
  assert.equal(rows(env, 'SELECT url FROM history_images WHERE image_id IS NULL').length, 0);
  assert.equal(rows(env, `SELECT url FROM history_images WHERE url = '${CDN}'`).length, 0,
    '差し替え前の参照が残っています');
});

test('もう取れない URL は、印を付けて何度も試さない', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  stubCdn();
  await postRecord(mod, env, { id: 'r1', images: [{ url: imageUrl(1) }] });
  // 失効した外部 URL を 1 件だけ足す
  env.d1.db.prepare('INSERT INTO history_images (url, history_id, image_id) VALUES (?,?,NULL)')
    .run(CDN, 'r1');

  const asked = stubCdn(false); // 404 が返る
  await call(mod, env, '/api/history');
  await settle();
  assert.equal(asked.length, 1, '取りに行っていません');

  await call(mod, env, '/api/history');
  await settle();
  assert.equal(asked.length, 1, '取れない URL を何度も試しています');
});

/* ---- 使われなかった画像の回収 ---- */

const sweep = async (mod, env) =>
  (await call(mod, env, '/api/images/sweep', { method: 'POST' })).json();

const marks = (env) => rows(env, 'SELECT image_id, marked_at FROM image_gc');

const backdate = (env, ms) =>
  env.d1.db.prepare('UPDATE image_gc SET marked_at = ?').run(Date.now() - ms);

const WEEK = 7 * 24 * 60 * 60 * 1000;

test('使われなかった画像は、印を付けてから猶予を越えたときだけ消える', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  await env.IMAGES.put(`${imageId(1)}.png`, 'png'); // 記録から参照される
  await env.IMAGES.put(`${imageId(2)}.png`, 'png'); // 誰も使わない
  await env.IMAGES.put('lora-staging/abc.safetensors', 'x'); // 触ってはいけない
  await postRecord(mod, env, { id: 'r1', images: [{ url: imageUrl(1) }] });

  // 1 回目は印を付けるだけ。編集中の画像を巻き込まないため、その場では消さない
  const first = await sweep(mod, env);
  assert.deepEqual([first.marked, first.deleted], [1, 0]);
  assert.deepEqual((await marks(env)).map((r) => r.image_id), [imageId(2)]);
  assert.ok(await env.bucket.get(`${imageId(2)}.png`), '1 回目で消えています');

  // 猶予の内側なら、何度走らせても消えない
  assert.equal((await sweep(mod, env)).deleted, 0);

  backdate(env, WEEK + 1000);
  const third = await sweep(mod, env);
  assert.equal(third.deleted, 1);
  assert.equal(await env.bucket.get(`${imageId(2)}.png`), null, '猶予を越えても残っています');
  assert.ok(await env.bucket.get(`${imageId(1)}.png`), '参照されている画像を消しています');
  assert.ok(await env.bucket.get('lora-staging/abc.safetensors'), 'LoRA の一時ファイルを消しています');
  assert.equal((await marks(env)).length, 0, '消したのに印が残っています');
});

test('印が付いたあとで参照が付いたら、印は外れる', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  // 画像編集は「画像を選んだ瞬間」に上げるので、しばらく参照ゼロのまま置かれる
  await env.IMAGES.put(`${imageId(3)}.png`, 'png');
  await sweep(mod, env);
  assert.equal((await marks(env)).length, 1);

  // 編集が終わって履歴に載る
  await postRecord(mod, env, { id: 'r1', images: [{ url: imageUrl(3) }] });
  backdate(env, WEEK + 1000); // 猶予は越えているが、もう参照がある
  const after = await sweep(mod, env);
  assert.equal(after.deleted, 0, '参照が付いた画像を消しています');
  assert.equal((await marks(env)).length, 0, '印が外れていません');
  assert.ok(await env.bucket.get(`${imageId(3)}.png`));
});

test('アップロードの問い合わせで「持っている」と答えたら、印を外す', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  const hash = 'a'.repeat(64); // 内容アドレス（sha256）のキー
  await env.IMAGES.put(`${hash}.png`, 'png');
  await sweep(mod, env);
  assert.deepEqual((await marks(env)).map((r) => r.image_id), [hash]);

  const probe = await (await call(mod, env, '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  })).json();
  assert.equal(probe.url, `/api/image/${hash}`);
  assert.equal((await marks(env)).length, 0, '使う気配があるのに印が残っています');

  // 印が無いので、次の掃除は「付け直す」ところからやり直しになる
  backdate(env, WEEK + 1000);
  assert.equal((await sweep(mod, env)).deleted, 0, '猶予を待たずに消しています');
});

test('掃除の結果は meta に残り、累計が積み上がる', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  for (let i = 1; i <= 3; i++) await env.IMAGES.put(`${imageId(i)}.png`, 'png');

  await sweep(mod, env);
  backdate(env, WEEK + 1000);
  const run = await sweep(mod, env);
  assert.deepEqual([run.deleted, run.total, run.done], [3, 3, true]);

  // 最後の結果は GET で読める（統計の表示に使う）
  const shown = await (await call(mod, env, '/api/images/sweep')).json();
  assert.equal(shown.total, 3);
  assert.equal(shown.deleted, 3);
  assert.ok(shown.at > 0);
});

test('1 回で見切れないときは、続きから見る', async () => {
  const mod = await loadWorker([['const IMAGE_GC_PAGE = 200;', 'const IMAGE_GC_PAGE = 2;'],
    ['const IMAGE_GC_BUDGET = 30;', 'const IMAGE_GC_BUDGET = 4;']]);
  const env = makeEnv(mod);
  for (let i = 1; i <= 8; i++) await env.IMAGES.put(`${imageId(i)}.png`, 'png');

  const first = await sweep(mod, env);
  assert.equal(first.done, false, '一度で見終わったことになっています');
  assert.ok(first.scanned < 8 && first.scanned > 0, `scanned=${first.scanned}`);

  let seen = first.scanned;
  for (let guard = 0; guard < 10; guard++) {
    const next = await sweep(mod, env);
    seen += next.scanned;
    if (next.done) break;
  }
  assert.equal((await marks(env)).length, 8, `印が付いたのは ${(await marks(env)).length} 件`);
});

/* ---- Durable Object からの移行 ---- */

// 索引まで作られた状態（前のレイアウト）の Durable Object を用意する
async function seedDurableObject(mod, count) {
  const storage = makeStorage();
  const ids = Array.from({ length: count }, (_, i) => `old-${i}`);
  for (const [i, id] of ids.entries()) {
    await storage.put(`hist:${id}`, {
      id, prompt: `過去 ${i}`, ts: 1000 + i, images: [{ url: imageUrl(i + 1) }],
      ...(i === 0 ? { mask: MASK } : {}),
    });
  }
  await storage.put('history:order', ids); // 新しい順
  return storage;
}

test('Durable Object に貯まっていた履歴が、並び順そのままで D1 へ移る', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod, await seedDurableObject(mod, 150));

  let ids = [];
  for (let guard = 0; guard < 30; guard++) {
    ids = await listIds(mod, env); // 引き取りは 1 リクエストずつ進む
    if (ids.length === 150) break;
  }
  assert.deepEqual(ids.slice(0, 3), ['old-0', 'old-1', 'old-2']);
  assert.equal(rows(env, 'SELECT id FROM history').length, 150);
  // 画像の参照も張り直される（移行後に /api/capture や削除が効くように）
  assert.equal(rows(env, 'SELECT url FROM history_images').length, 150);
  // マスクは列に移る
  assert.deepEqual(JSON.parse(rows(env, 'SELECT mask FROM history WHERE id = ?', 'old-0')[0].mask), MASK);
  // 引き取ったぶんは Durable Object から消える（二重に持たない）
  assert.equal((await env.storage.list({ prefix: 'hist:' })).size, 0);
  assert.equal((await env.storage.list({ prefix: 'hidx:' })).size, 0);
  assert.equal(await env.storage.get('history:order'), undefined);

  // 移行後の保存は、移ってきたぶんより新しい通し番号になる
  await postRecord(mod, env, { id: 'new', images: [] });
  assert.deepEqual((await listIds(mod, env)).slice(0, 2), ['new', 'old-0']);
});

test('移行が 1 リクエストで終わらなくても、続きから移り切る', async () => {
  const mod = await loadWorker([['const HISTORY_MIGRATE_BUDGET = 12;', 'const HISTORY_MIGRATE_BUDGET = 2;'],
    ['const HISTORY_MIGRATE_BATCH = 60;', 'const HISTORY_MIGRATE_BATCH = 5;']]);
  const env = makeEnv(mod, await seedDurableObject(mod, 20));

  // 1 回目は一部だけ。新しい方から移すので、見えるのは常に先頭から
  const partial = await listIds(mod, env);
  assert.ok(partial.length > 0 && partial.length < 20, `1 回で ${partial.length} 件移っています`);
  assert.deepEqual(partial.slice(0, 2), ['old-0', 'old-1'], '古い方から移しています');

  for (let guard = 0; guard < 20; guard++) {
    if ((await listIds(mod, env)).length === 20) break;
  }
  assert.equal((await listIds(mod, env)).length, 20);
  assert.equal((await env.storage.list({ prefix: 'hist:' })).size, 0);
});

test('さらに旧いレイアウト（history:list に全件）からでも D1 まで届く', async () => {
  const mod = await loadWorker();
  const storage = makeStorage();
  // 一括操作の 128 件をまたぐ件数で、分割し忘れがあれば落ちるようにする
  await storage.put('history:list', Array.from({ length: 300 }, (_, i) => ({
    id: `old-${i}`, prompt: `過去 ${i}`, images: [], ...(i === 0 ? { mask: MASK } : {}),
  })));
  const env = makeEnv(mod, storage);

  let ids = [];
  for (let guard = 0; guard < 20; guard++) {
    ids = await listIds(mod, env); // 移行は 1 リクエストの予算ぶんずつ進む
    if (ids.length === 300) break;
  }
  assert.equal(ids.length, 300);
  assert.deepEqual(ids.slice(0, 2), ['old-0', 'old-1'], '並び順が変わっています');
  assert.equal(await storage.get('history:list'), undefined);
  const one = await (await call(mod, env, '/api/history/old-0')).json();
  assert.deepEqual(one.mask, MASK, '移行でマスクが落ちています');
});

test('移行が済んだら、以後は Durable Object を見に行かない', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod, await seedDurableObject(mod, 3));
  await listIds(mod, env);

  let exported = 0;
  const real = env.stub.exportHistory.bind(env.stub);
  env.stub.exportHistory = async (n) => { exported++; return real(n); };
  await listIds(mod, env);
  await postRecord(mod, env, { id: 'new', images: [] });
  assert.equal(exported, 0, '移行済みなのに Durable Object を叩いています');
});

/* ---- 実行 ---- */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}\n  ${err.message}`);
    if (process.env.DEBUG_ERRORS) console.error(err);
  }
}
rmSync(OUT, { force: true });
console.log(failed === 0 ? '\nすべて成功' : `\n${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
