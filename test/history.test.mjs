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
// 保管レイアウト側では、1 レコード 1 キー（hist:<id>）+ 並び順（history:order）に
// なっていること、1 件の保存が全履歴の書き直しにならないこと、旧レイアウト
// （history:list に全件）からの移行が効くことを見る
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
  assert.deepEqual(list[0], { id: 'rec-2', prompt: 'a cat', images: [] });
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

test('1 レコード 1 キーで持ち、並び順は別のキーに置く', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);

  await postRecord(mod, env, { id: 'a', prompt: '1 番目', images: [] });
  await postRecord(mod, env, { id: 'b', prompt: '2 番目', mask: MASK, images: [] });

  assert.deepEqual(await env.storage.get('history:order'), ['b', 'a'], '新しい順に並びます');
  assert.equal((await env.storage.get('hist:a')).prompt, '1 番目');
  assert.deepEqual((await env.storage.get('hist:b')).mask, MASK);
  // 全件を 1 キーに詰める旧レイアウトは残っていない（2MB 上限に当たる原因）
  assert.equal(await env.storage.get('history:list'), undefined);
});

test('1 件の保存で書き直すのは、そのレコードと並び順だけ', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  await postRecord(mod, env, { id: 'a', mask: MASK, images: [] });

  const written = [];
  const put = env.storage.put.bind(env.storage);
  env.storage.put = async (k, v) => { written.push(k); return put(k, v); };
  await postRecord(mod, env, { id: 'b', images: [] });

  assert.deepEqual(written, ['hist:b', 'history:order'], '他のレコードまで書き直しています');
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

  assert.deepEqual(await env.storage.get('history:order'), []);
  assert.equal((await env.storage.list({ prefix: 'hist:' })).size, 0);
  assert.deepEqual(await (await call(mod, env, '/api/history')).json(), []);
});

test('上限を超えたら、古いものから画像ごと消える', async () => {
  const mod = await loadWorker([['const HISTORY_KEEP = 1000;', 'const HISTORY_KEEP = 3;']]);
  const env = makeEnv(mod);

  // 保存済み画像（/api/image/<id>）を持つレコードを、上限より 1 件多く入れる
  const imageId = (n) => String(n).repeat(32);
  for (let i = 1; i <= 4; i++) {
    await env.IMAGES.put(`${imageId(i)}.png`, 'png');
    await postRecord(mod, env, { id: `r${i}`, images: [{ url: `/api/image/${imageId(i)}` }] });
  }

  const list = await (await call(mod, env, '/api/history')).json();
  assert.deepEqual(list.map((r) => r.id), ['r4', 'r3', 'r2'], '古いものから落ちていません');
  assert.equal(await env.storage.get('hist:r1'), undefined, 'レコードの実体が残っています');
  assert.equal(await env.bucket.get(`${imageId(1)}.png`), null, '画像が残っています');
  assert.ok(await env.bucket.get(`${imageId(2)}.png`), '残すべき画像まで消しています');
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

  // 実体は 1 件ずつのキーに移り、旧キーは消える
  assert.equal(await storage.get('history:list'), undefined);
  assert.equal((await storage.list({ prefix: 'hist:' })).size, 300);
  const one = await (await call(mod, env, '/api/history/old-0')).json();
  assert.deepEqual(one.mask, MASK, '移行でマスクが落ちています');

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
