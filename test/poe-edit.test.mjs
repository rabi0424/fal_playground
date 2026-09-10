// 部分AI編集（Poe ジョブ）のテスト:  node test/poe-edit.test.mjs
//
// worker.js をそのまま Node に取り込み、Poe の API と R2 をモックして流す。
// 見るのは、ヘッドスワップで増えた「2 枚目の画像」まわり:
//   - /api/poe/edit が imageIds を順番どおり受け取り、枚数と形を検証すること
//   - 送信本文で、1 枚目（切り抜き）→ 2 枚目（顔写真）の順に並ぶこと
//   - 1 枚だけの古い形（imageId）で積まれたジョブも、そのまま実行できること
//   - 2 枚目が R2 から消えていたら、実行せずエラーにすること
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeStorage, makeBucket } from './harness.mjs';

const WORKER = new URL('../worker.js', import.meta.url);
const OUT = new URL('./.poe-edit.test.mjs', import.meta.url);

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

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const CROP_ID = '1'.repeat(64);
const FACE_ID = '2'.repeat(64);

async function makeDo(mod) {
  const storage = makeStorage();
  const bucket = makeBucket({ sub: 0 });
  // 入力画像は事前に R2 へ置かれている前提（クライアントが /api/upload で上げる）
  await bucket.put(`${CROP_ID}.png`, Buffer.from('crop-bytes'), { httpMetadata: { contentType: 'image/png' } });
  await bucket.put(`${FACE_ID}.png`, Buffer.from('face-bytes'), { httpMetadata: { contentType: 'image/jpeg' } });
  const env = { IMAGES: bucket, POE_API_KEY: 'poe-test' };
  return { stub: new mod.SyncState({ storage }, env), storage, bucket, env };
}

// Poe は画像を Markdown リンクで返す。その URL を取りに行くところまでモックする
function makePoe() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://cdn.poe/')) {
      return new Response(PNG_1X1, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    calls.push({ url: u, body: JSON.parse(init.body) });
    return Response.json({
      choices: [{ message: { content: '![out](https://cdn.poe/out.png)' } }],
    });
  };
  return { calls, fetch };
}

async function runAlarms(stub, storage, max = 10) {
  for (let i = 0; i < max; i++) {
    if ((await storage.getAlarm()) === null) return;
    await storage.deleteAlarm();
    await stub.alarm();
  }
  assert.fail('alarm が収束しませんでした');
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('ヘッドスワップ: 切り抜き → 顔写真の順で 2 枚送る', async () => {
  const mod = await loadWorker();
  const { stub, storage } = await makeDo(mod);
  const poe = makePoe();
  globalThis.fetch = poe.fetch;

  const id = 'a'.repeat(32);
  await stub.startPoeJob(id, {
    model: 'Nano-Banana-2',
    prompt: 'Replace the head…',
    imageIds: [CROP_ID, FACE_ID],
    parameters: { aspect_ratio: '3:4' },
  });
  await runAlarms(stub, storage);

  const job = await stub.getPoeJob(id);
  assert.equal(job.status, 'done', job.error ?? '');

  assert.equal(poe.calls.length, 1);
  const { content } = poe.calls[0].body.messages[0];
  assert.equal(content[0].text, 'Replace the head…');
  // 並びはプロンプトが前提にしている順（1 枚目が切り抜き、2 枚目が顔写真）
  assert.equal(content[1].image_url.url, `data:image/png;base64,${Buffer.from('crop-bytes').toString('base64')}`);
  assert.equal(content[2].image_url.url, `data:image/jpeg;base64,${Buffer.from('face-bytes').toString('base64')}`);
  assert.equal(content.length, 3);
  // ボット固有パラメータはトップレベルのまま
  assert.equal(poe.calls[0].body.aspect_ratio, '3:4');
});

test('1 枚だけの古い形（imageId）で積まれたジョブも実行できる', async () => {
  const mod = await loadWorker();
  const { stub, storage } = await makeDo(mod);
  const poe = makePoe();
  globalThis.fetch = poe.fetch;

  const id = 'b'.repeat(32);
  await stub.startPoeJob(id, { model: 'Nano-Banana-2', prompt: 'blur', imageId: CROP_ID, parameters: {} });
  await runAlarms(stub, storage);

  assert.equal((await stub.getPoeJob(id)).status, 'done');
  assert.equal(poe.calls[0].body.messages[0].content.length, 2); // テキスト + 画像 1 枚
});

test('2 枚目が見つからなければ、実行せずエラーにする', async () => {
  const mod = await loadWorker();
  const { stub, storage } = await makeDo(mod);
  globalThis.fetch = async () => assert.fail('Poe を呼んではいけない');

  const id = 'c'.repeat(32);
  await stub.startPoeJob(id, {
    model: 'Nano-Banana-2',
    prompt: 'swap',
    imageIds: [CROP_ID, '9'.repeat(64)],
    parameters: {},
  });
  await runAlarms(stub, storage);

  const job = await stub.getPoeJob(id);
  assert.equal(job.status, 'error');
  assert.match(job.error, /入力画像が見つかりませんでした/);
});

test('/api/poe/edit: 画像の指定を検証する', async () => {
  const mod = await loadWorker();
  const started = [];
  const env = {
    POE_API_KEY: 'poe-test',
    STATE: {
      idFromName: () => 'id',
      get: () => ({ startPoeJob: (id, payload) => { started.push(payload); } }),
    },
  };
  const post = (body) => mod.default.fetch(new Request('https://app/api/poe/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  const base = { jobId: 'd'.repeat(32), model: 'Nano-Banana-2', prompt: 'swap' };
  assert.equal((await post({ ...base, imageIds: [CROP_ID, FACE_ID] })).status, 200);
  assert.deepEqual(started.at(-1).imageIds, [CROP_ID, FACE_ID]);

  // 1 枚だけの書き方も受ける（imageId → 1 枚の imageIds として積む）
  assert.equal((await post({ ...base, imageId: CROP_ID })).status, 200);
  assert.deepEqual(started.at(-1).imageIds, [CROP_ID]);

  assert.equal((await post(base)).status, 422); // 画像なし
  assert.equal((await post({ ...base, imageIds: [] })).status, 422); // 空
  assert.equal((await post({ ...base, imageIds: [CROP_ID, FACE_ID, CROP_ID] })).status, 422); // 多すぎ
  assert.equal((await post({ ...base, imageIds: [CROP_ID, 'zz'] })).status, 422); // 形が違う
  assert.equal((await post({ ...base, imageIds: CROP_ID })).status, 422); // 配列でない
  assert.equal(started.length, 2, '弾いたぶんはジョブを積まない');
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
