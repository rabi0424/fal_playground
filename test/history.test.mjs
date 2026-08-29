// 履歴 API のテスト:  node test/history.test.mjs
//
// 見るのは 3 点:
//   - 一覧（GET /api/history）がマスクを外して返すこと。マスクは塗った線の座標を
//     そのまま持つので 1 件で数十 KB あり、3 画面が開くたびに全件を取る作りでは
//     ここがそのまま毎回の転送量になる
//   - 1 件取得（GET /api/history/<id>）はマスクを含む丸ごとを返すこと
//   - 保存（POST）はマスクを捨てず、応答にも含めて返すこと
//     （画像編集は応答をそのまま持って塗り直しの保存に使う）
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeStorage, makeBucket } from './harness.mjs';

const WORKER = new URL('../worker.js', import.meta.url);
const OUT = new URL('./.history.test.mjs', import.meta.url);

const PATCHES = [
  ["import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'],
];

async function loadWorker() {
  let src = readFileSync(WORKER, 'utf8');
  for (const [from, to] of PATCHES) {
    assert.equal(src.split(from).length - 1, 1, `patch target not found once: ${from}`);
    src = src.replace(from, to);
  }
  writeFileSync(OUT, src);
  return import(`${OUT.href}?v=${Date.now()}`);
}

// Durable Object の stub を直接ぶら下げた env（実物と同じく単一インスタンス）
function makeEnv(mod) {
  const stub = new mod.SyncState({ storage: makeStorage() }, { IMAGES: makeBucket({ sub: 0 }) });
  return { STATE: { idFromName: () => 'singleton', get: () => stub }, IMAGES: makeBucket({ sub: 0 }) };
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
