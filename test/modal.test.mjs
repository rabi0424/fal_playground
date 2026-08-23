// Modal（modal_comfy）ジョブの結合テスト:  node test/modal.test.mjs
//
// worker.js をそのまま Node に取り込み、Modal のエンドポイントと R2 をモックして流す。
// 見るのは 3 点:
//   - /api/krea2/generate と /api/modal/edit がエンドポイントを正しく解決すること
//   - 303（結果ポーリングへの切り替え）を追って完了まで進むこと
//   - 編集の結果から seed と実際の解像度（X-Width / X-Height）を拾うこと
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeStorage, makeBucket } from './harness.mjs';

const WORKER = new URL('../worker.js', import.meta.url);
const OUT = new URL('./.modal.test.mjs', import.meta.url);

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

/* ---- Modal のモック ---- */
// 1 回目は 303 でポーリング URL を返し、2 回目に PNG を返す（実物と同じ流れ）

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function makeModal({ headers = {} } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    assert.equal(init.headers['Modal-Key'], 'wk-test');
    assert.equal(init.headers['Modal-Secret'], 'ws-test');
    if (!u.includes('/poll/')) {
      return new Response(null, { status: 303, headers: { Location: 'https://x--y.modal.run/poll/1' } });
    }
    return new Response(PNG_1X1, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'X-Seed': '4242', ...headers },
    });
  };
  return { calls, fetch };
}

function makeDo(mod) {
  const storage = makeStorage();
  const bucket = makeBucket({ sub: 0 });
  const env = {
    IMAGES: bucket,
    MODAL_PROXY_KEY: 'wk-test',
    MODAL_PROXY_SECRET: 'ws-test',
  };
  return { stub: new mod.SyncState({ storage }, env), storage, bucket, env };
}

async function runAlarms(stub, storage, max = 10) {
  for (let i = 0; i < max; i++) {
    if ((await storage.getAlarm()) === null) return;
    await storage.deleteAlarm();
    await stub.alarm();
  }
  assert.fail('alarm が収束しませんでした');
}

// R2 モックに入った PNG のバイト列
async function storedBytes(env, url) {
  const obj = await env.IMAGES.get(`${url.split('/').pop()}.png`);
  assert.ok(obj, `R2 に ${url} がありません`);
  return new Response(obj.body).arrayBuffer();
}

// 保存した PNG に焼き込んだ JSON を読み出す
function readEmbeddedMeta(buf) {
  const text = Buffer.from(buf).toString('latin1');
  const at = text.indexOf('iTXt');
  assert.ok(at > 0, 'iTXt チャンクがありません');
  const start = text.indexOf('{', at);
  const end = text.lastIndexOf('}', text.indexOf('IDAT', at));
  return JSON.parse(Buffer.from(text.slice(start, end + 1), 'latin1').toString('utf8'));
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('編集: 303 を追って完了し、seed と実際の解像度を拾う', async () => {
  const mod = await loadWorker();
  const { stub, storage, env } = makeDo(mod);
  const modal = makeModal({ headers: { 'X-Width': '1248', 'X-Height': '832' } });
  globalThis.fetch = modal.fetch;

  const id = 'a'.repeat(32);
  await stub.startKrea2Job(id, {
    prompt: 'remove',
    image: 'data:image/png;base64,AAAA',
    mask: 'data:image/png;base64,BBBB',
    width: 1248,
    height: 832,
    loras: [{ name: 'distill', strength: 0.4 }],
  }, 'https://x--y.modal.run/edit', 'edit', 'wan-edit');
  await runAlarms(stub, storage);

  const job = await stub.getKrea2Job(id);
  assert.equal(job.status, 'done', job.error ?? '');
  assert.equal(job.seed, 4242);
  assert.equal(job.width, 1248);
  assert.equal(job.height, 832);
  assert.match(job.url, /^\/api\/image\/[0-9a-f]{32}$/);
  assert.ok(job.elapsedMs >= 0);

  // 1 回目が POST、2 回目がポーリング
  assert.equal(modal.calls.length, 2);
  assert.equal(modal.calls[0].method, 'POST');
  assert.equal(modal.calls[0].body.prompt, 'remove');
  assert.equal(modal.calls[1].url, 'https://x--y.modal.run/poll/1');

  // 焼き込むのは設定だけ。画像本体（base64）は入れない
  const meta = readEmbeddedMeta(await storedBytes(env, job.url));
  assert.equal(meta.source, 'wan-vace-edit');
  assert.equal(meta.endpoint, 'wan-edit');
  assert.equal(meta.width, 1248);
  assert.equal(meta.image, undefined);
  assert.equal(meta.mask, undefined);
  assert.deepEqual(meta.loras, [{ name: 'distill', strength: 0.4 }]);
});

test('生成: X-Width が無くても完了し、記録は生成として残る', async () => {
  const mod = await loadWorker();
  const { stub, storage, env } = makeDo(mod);
  globalThis.fetch = makeModal().fetch;

  const id = 'b'.repeat(32);
  await stub.startKrea2Job(id, { prompt: 'a cat', width: 1024, height: 1536 },
    'https://x--wan.modal.run/generate', 'generate', 'wan');
  await runAlarms(stub, storage);

  const job = await stub.getKrea2Job(id);
  assert.equal(job.status, 'done', job.error ?? '');
  assert.equal(job.width, null);
  assert.equal(job.height, null);

  const meta = readEmbeddedMeta(await storedBytes(env, job.url));
  assert.equal(meta.source, 'krea2-modal');
  assert.equal(meta.endpoint, 'wan');
});

test('ルーティング: endpoint フィールドで URL を選び、未知の値は既定へ落とす', async () => {
  const mod = await loadWorker();
  const seen = [];
  const stub = {
    startKrea2Job: (...args) => { seen.push(args); },
    getKrea2Job: async () => null,
  };
  const env = {
    STATE: { idFromName: () => 'id', get: () => stub },
    MODAL_PROXY_KEY: 'wk-test',
    MODAL_PROXY_SECRET: 'ws-test',
  };
  const post = (path, body) => mod.default.fetch(new Request(`https://app${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  const base = { prompt: 'a cat', jobId: 'c'.repeat(32) };
  assert.equal((await post('/api/krea2/generate', { ...base, endpoint: 'wan' })).status, 200);
  assert.match(seen.at(-1)[2], /wan-vace-api-comfyapi-generate/);
  assert.deepEqual(seen.at(-1).slice(3), ['generate', 'wan']);

  await post('/api/krea2/generate', { ...base, jobId: 'd'.repeat(32), endpoint: 'nope' });
  assert.match(seen.at(-1)[2], /krea2-comfy-api-exp/);
  assert.deepEqual(seen.at(-1).slice(3), ['generate', 'exp']);

  // endpoint は Modal API に無いフィールドなので転送しない
  assert.equal(seen.at(-1)[1].endpoint, undefined);
  assert.equal(seen.at(-1)[1].jobId, undefined);

  await post('/api/modal/edit', { ...base, jobId: 'e'.repeat(32), image: 'AAA', mask: 'BBB' });
  assert.match(seen.at(-1)[2], /wan-vace-api-comfyapi-edit/);
  assert.deepEqual(seen.at(-1).slice(3), ['edit', 'wan-edit']);
});

test('編集: 画像とマスクが無ければ 422 で弾く', async () => {
  const mod = await loadWorker();
  const env = {
    STATE: { idFromName: () => 'id', get: () => ({ startKrea2Job: () => assert.fail('呼ばれてはいけない') }) },
    MODAL_PROXY_KEY: 'wk-test',
    MODAL_PROXY_SECRET: 'ws-test',
  };
  const post = (body) => mod.default.fetch(new Request('https://app/api/modal/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  const jobId = 'f'.repeat(32);
  assert.equal((await post({ jobId, image: 'A', mask: 'B' })).status, 422); // prompt 無し
  assert.equal((await post({ prompt: 'x', jobId, mask: 'B' })).status, 422); // image 無し
  assert.equal((await post({ prompt: 'x', jobId, image: 'A' })).status, 422); // mask 無し
  assert.equal((await post({ prompt: 'x', image: 'A', mask: 'B' })).status, 422); // jobId 無し
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
