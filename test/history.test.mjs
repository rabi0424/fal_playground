// 履歴 API と保管レイアウトのテスト:  node test/history.test.mjs
//
// API 側で見るのは 3 点:
//   - 一覧（GET /api/history）がマスクを外して返すこと。マスクは塗った線の座標を
//     そのまま持つので 1 件で数十 KB あり、3 画面が開くたびに全件を取る作りでは
//     ここがそのまま毎回の転送量になる
//   - 1 件取得（GET /api/history/<id>）はマスクを含む丸ごとを返すこと
//   - 保存（POST）はマスクを捨てず、応答にも含めて返すこと
//     （画像編集は応答をそのまま持って塗り直しの保存に使う）
//
// 保管レイアウト側では、1 レコード 1 キー（hist:<id>）+ 1 件 1 キーの索引
// （hidx:<逆順の通し番号>:<id>）になっていること、1 件の保存で書くキー数が件数に
// 依らないこと、件数の上限が無いこと、旧レイアウト（history:list に全件 /
// history:order に id の配列）からの移行が効くことを見る
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeStorage, makeBucket } from './harness.mjs';

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
  return import(`${OUT.href}?v=${Date.now()}`);
}

// Durable Object の stub を直接ぶら下げた env（実物と同じく単一インスタンス）
function makeEnv(mod, storage = makeStorage()) {
  const bucket = makeBucket({ sub: 0 });
  const stub = new mod.SyncState({ storage }, { IMAGES: bucket });
  const env = { STATE: { idFromName: () => 'singleton', get: () => stub }, IMAGES: bucket };
  return Object.assign(env, { storage, stub, bucket });
}

// 索引キー（新しい順に並ぶ）から id だけ取り出す
const indexIds = async (storage) =>
  [...(await storage.list({ prefix: 'hidx:' })).values()];

const nextCursor = (res) => res.headers.get('X-Next-Cursor');

const MASK = { feather: 0.01, strokes: [{ mode: 'add', pts: [[0.1, 0.2], [0.3, 0.4]] }] };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const call = (mod, env, path, init) =>
  mod.default.fetch(new Request(`https://x${path}`, init), env);

const postRecord = (mod, env, record) => call(mod, env, '/api/history', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(record),
});

test('一覧はマスクを外し、1 件取得は丸ごと返す', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  const saved = await (await postRecord(mod, env, {
    id: 'rec-1',
    type: 'imgedit',
    prompt: 'remove the cup',
    masked: true,
    mask: MASK,
    images: [{ url: '/api/image/' + 'a'.repeat(32) }],
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
  // seq は並び順の索引と突き合わせるためにサーバーが振る通し番号
  assert.deepEqual(list[0], { id: 'rec-2', prompt: 'a cat', images: [], seq: 1 });
});

test('知らない id は 404、GET と DELETE 以外は 405', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  assert.equal((await call(mod, env, '/api/history/nope')).status, 404);
  assert.equal((await call(mod, env, '/api/history/rec-1', { method: 'PUT' })).status, 405);
});

test('削除しても他のレコードは残る', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  await postRecord(mod, env, { id: 'rec-1', mask: MASK, images: [] });
  await postRecord(mod, env, { id: 'rec-2', images: [] });
  assert.equal((await call(mod, env, '/api/history/rec-1', { method: 'DELETE' })).status, 200);

  const list = await (await call(mod, env, '/api/history')).json();
  assert.deepEqual(list.map((r) => r.id), ['rec-2']);
});

test('1 レコード 1 キーで持ち、並び順は 1 件 1 キーの索引に置く', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  await postRecord(mod, env, { id: 'a', prompt: '1 番目', images: [] });
  await postRecord(mod, env, { id: 'b', prompt: '2 番目', mask: MASK, images: [] });

  assert.deepEqual(await indexIds(env.storage), ['b', 'a'], '索引が新しい順に並びます');
  assert.equal((await env.storage.get('hist:a')).prompt, '1 番目');
  assert.deepEqual((await env.storage.get('hist:b')).mask, MASK);
  // 並び順や全件を 1 キーに詰める旧レイアウトは残っていない（2MB 上限に当たる原因）
  assert.equal(await env.storage.get('history:list'), undefined);
  assert.equal(await env.storage.get('history:order'), undefined);
});

test('1 件の保存で書くキーは、件数が増えても変わらない', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  for (let i = 0; i < 50; i++) await postRecord(mod, env, { id: `x${i}`, mask: MASK, images: [] });

  const written = [];
  const put = env.storage.put.bind(env.storage);
  env.storage.put = async (k, v) => { written.push(...(v === undefined ? Object.keys(k) : [k])); return put(k, v); };
  await postRecord(mod, env, { id: 'b', images: [] });

  // レコード本体・その索引・通し番号の 3 つだけ（ほかのレコードには触れない）
  assert.equal(written.length, 3, `書いたキー: ${written.join(', ')}`);
  assert.ok(written.includes('hist:b'));
  assert.ok(written.includes('history:seq'));
  assert.ok(written.some((k) => k.startsWith('hidx:') && k.endsWith(':b')));
});

test('同じ id の保存は差し替えになり、増えない', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  await postRecord(mod, env, { id: 'a', prompt: '前', images: [] });
  await postRecord(mod, env, { id: 'b', prompt: 'ほか', images: [] });
  await postRecord(mod, env, { id: 'a', prompt: '後', images: [] });

  const list = await (await call(mod, env, '/api/history')).json();
  assert.deepEqual(list.map((r) => r.id), ['a', 'b'], '差し替えた側が先頭に来ます');
  assert.equal(list[0].prompt, '後');
});

test('全消しはレコードの実体も消す', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  await postRecord(mod, env, { id: 'a', images: [] });
  await postRecord(mod, env, { id: 'b', images: [] });
  assert.equal((await call(mod, env, '/api/history', { method: 'DELETE' })).status, 200);

  assert.equal((await env.storage.list({ prefix: 'hist:' })).size, 0);
  assert.equal((await env.storage.list({ prefix: 'hidx:' })).size, 0, '索引が残っています');
  assert.deepEqual(await (await call(mod, env, '/api/history')).json(), []);
});

test('件数の上限は無い（古いものが勝手に消えない）', async () => {
  // 1 ページぶんより多く入れて、古い方が落ちていないことを見る
  const mod = await loadWorker([['const HISTORY_PAGE_DEFAULT = 500;', 'const HISTORY_PAGE_DEFAULT = 5;']]);
  const env = makeEnv(mod);

  const imageId = (n) => String(n).padStart(32, '0');
  for (let i = 1; i <= 12; i++) {
    await env.IMAGES.put(`${imageId(i)}.png`, 'png');
    await postRecord(mod, env, { id: `r${i}`, images: [{ url: `/api/image/${imageId(i)}` }] });
  }

  // 実体も画像も 1 件残らず残っている
  assert.equal((await env.storage.list({ prefix: 'hist:' })).size, 12);
  assert.ok(await env.bucket.get(`${imageId(1)}.png`), '古い画像が消えています');
  assert.deepEqual(await indexIds(env.storage), Array.from({ length: 12 }, (_, i) => `r${12 - i}`));

  // 一覧はページ送りで全部たどれる
  const seen = [];
  let cursor = '';
  for (let guard = 0; guard < 10; guard++) {
    const res = await call(mod, env, `/api/history?cursor=${cursor}`);
    seen.push(...(await res.json()).map((r) => r.id));
    cursor = nextCursor(res);
    if (!cursor) break;
  }
  assert.equal(cursor, null, '続きの位置が返り続けています');
  assert.deepEqual(seen, Array.from({ length: 12 }, (_, i) => `r${12 - i}`));
});

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

test('ページの途中で削除しても、続きの位置は生きている', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  for (let i = 1; i <= 4; i++) await postRecord(mod, env, { id: `r${i}`, images: [] });

  const first = await call(mod, env, '/api/history?limit=2');
  assert.deepEqual((await first.json()).map((r) => r.id), ['r4', 'r3']);
  await call(mod, env, '/api/history/r2', { method: 'DELETE' });

  const second = await call(mod, env, `/api/history?limit=2&cursor=${nextCursor(first)}`);
  assert.deepEqual((await second.json()).map((r) => r.id), ['r1'], '消したぶんが出ています');
});

test('id はルートが受ける形だけ通す', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  // 通らない id を保存できてしまうと、1 件取得も削除もできないレコードが残る
  assert.equal((await postRecord(mod, env, { id: 'あ/い', images: [] })).status, 422);
  assert.equal((await postRecord(mod, env, { id: '', images: [] })).status, 422);
  assert.equal((await postRecord(mod, env, { id: 'ok.id-1_2', images: [] })).status, 200);
});

test('旧レイアウト（history:list に全件）から移行する', async () => {
  const mod = await loadWorker();
  const storage = makeStorage();
  // 上限（一括操作の 128 件）をまたぐ件数で、分割し忘れがあれば落ちるようにする
  const legacy = Array.from({ length: 300 }, (_, i) => ({
    id: `old-${i}`,
    prompt: `過去 ${i}`,
    images: [],
    ...(i === 0 ? { mask: MASK } : {}),
  }));
  await storage.put('history:list', legacy);
  const env = makeEnv(mod, storage);

  const list = await (await call(mod, env, '/api/history')).json();
  assert.equal(list.length, 300);
  assert.deepEqual(list.map((r) => r.id).slice(0, 2), ['old-0', 'old-1'], '並び順が変わっています');
  assert.equal('mask' in list[0], false);

  // 実体は 1 件ずつのキーに移り、並び順は 1 件 1 キーの索引になり、旧キーは消える
  assert.equal(await storage.get('history:list'), undefined);
  assert.equal(await storage.get('history:order'), undefined);
  assert.equal((await storage.list({ prefix: 'hist:' })).size, 300);
  assert.deepEqual((await indexIds(storage)).slice(0, 2), ['old-0', 'old-1']);
  const one = await (await call(mod, env, '/api/history/old-0')).json();
  assert.deepEqual(one.mask, MASK, '移行でマスクが落ちています');

  // 移行後も、続きの保存と削除がそのまま効く
  await postRecord(mod, env, { id: 'new', images: [] });
  await call(mod, env, '/api/history/old-1', { method: 'DELETE' });
  const after = await (await call(mod, env, '/api/history')).json();
  assert.deepEqual(after.map((r) => r.id).slice(0, 2), ['new', 'old-0']);
  assert.equal(after.length, 300);
});

test('旧レイアウト（history:order に id の配列）から移行する', async () => {
  const mod = await loadWorker();
  const storage = makeStorage();
  // 一括操作の 128 件をまたぐ件数で、分割し忘れがあれば落ちるようにする
  const ids = Array.from({ length: 300 }, (_, i) => `old-${i}`);
  for (const [i, id] of ids.entries()) {
    await storage.put(`hist:${id}`, { id, prompt: `過去 ${i}`, images: [] });
  }
  await storage.put('history:order', ids);
  // 消し込みが途中で終わった残り（並び順にあって実体が無い）も混ぜておく
  await storage.put('history:order', [...ids.slice(0, 5), 'ghost', ...ids.slice(5)]);
  const env = makeEnv(mod, storage);

  const list = await (await call(mod, env, '/api/history')).json();
  assert.deepEqual(list.map((r) => r.id).slice(0, 2), ['old-0', 'old-1'], '並び順が変わっています');
  assert.equal(list.length, 300, '実体の無い並び順まで数えています');
  assert.equal(await storage.get('history:order'), undefined, '旧キーが残っています');

  // 移行後も、続きの保存と削除がそのまま効く
  await postRecord(mod, env, { id: 'new', images: [] });
  await call(mod, env, '/api/history/old-1', { method: 'DELETE' });
  const after = await (await call(mod, env, '/api/history')).json();
  assert.deepEqual(after.map((r) => r.id).slice(0, 2), ['new', 'old-0']);
  assert.equal(after.length, 300);
});

test('移行は 1 度だけ走る', async () => {
  const mod = await loadWorker();
  const storage = makeStorage();
  await storage.put('history:list', [{ id: 'x', images: [] }]);
  const env = makeEnv(mod, storage);

  await call(mod, env, '/api/history');
  // 移行後に旧キーが作り直されても、同じインスタンスでは読み直さない
  await storage.put('history:list', [{ id: 'ゴミ', images: [] }]);
  const list = await (await call(mod, env, '/api/history')).json();
  assert.deepEqual(list.map((r) => r.id), ['x']);
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
