// Modal（modal_comfy）ジョブの結合テスト:  node test/modal.test.mjs
//
// worker.js をそのまま Node に取り込み、Modal のエンドポイントと R2 をモックして流す。
// 見るのは 3 点:
//   - /api/krea2/generate と /api/modal/edit がエンドポイントを正しく解決すること
//     （編集は Wan2.2 + VACE の /edit と LanPaint の /inpaint を振り分ける）
//   - 303（結果ポーリングへの切り替え）を追って完了まで進むこと
//   - ポーリング中の 202（まだ実行中）を完了と取り違えないこと
//   - 画像以外が返ったときに、それを結果として保存しないこと
//   - いつまでも終わらないジョブを打ち切ること
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

// 保存した PNG に焼き込んだ JSON を読み出す。
//
// チャンクの構造をたどって長さで切り出す。以前は「iTXt のあとの最初の { から、
// IDAT の手前の最後の } まで」で拾っていたが、iTXt の CRC 4 バイトに 0x7D（}）が
// 出ると終端を誤り、JSON のうしろにゴミが付いて時々パースに失敗していた
function readEmbeddedMeta(buf) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.length;) { // 8 はシグネチャ
    const len = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'iTXt') {
      const data = bytes.subarray(at + 8, at + 8 + len);
      // keyword \0 圧縮フラグ 圧縮方式 言語タグ \0 翻訳キーワード \0 本文（= \0 が 5 つ）
      const body = data.subarray(data.indexOf(0) + 5);
      return JSON.parse(new TextDecoder().decode(body));
    }
    at += 12 + len; // 長さ 4 + 種別 4 + 本体 + CRC 4
  }
  return assert.fail('iTXt チャンクがありません');
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

// Modal は結果 URL のポーリングに対して、関数が終わるまで 202 を返す。
// res.ok は 202 でも true なので、分けずに扱うと空の本文を画像として保存し、
// 壊れた結果が「完了」になってしまう
test('編集: ポーリング中の 202 は完了扱いにしない', async () => {
  const mod = await loadWorker();
  const { stub, storage, env } = makeDo(mod);

  let polls = 0;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (!u.includes('/poll/')) {
      return new Response(null, { status: 303, headers: { Location: 'https://x--y.modal.run/poll/1' } });
    }
    polls += 1;
    if (polls <= 2) return new Response(null, { status: 202 }); // まだ実行中
    return new Response(PNG_1X1, { status: 200, headers: { 'Content-Type': 'image/png', 'X-Seed': '9' } });
  };

  const id = 'f'.repeat(32);
  await stub.startKrea2Job(id, { prompt: 'remove', image: 'A', mask: 'B' },
    'https://x--y.modal.run/edit', 'edit', 'wan-edit');

  // 202 を返している間は pending のまま
  await storage.deleteAlarm();
  await stub.alarm(); // POST → 303
  await storage.deleteAlarm();
  await stub.alarm(); // 1 回目のポーリング（202）
  assert.equal((await stub.getKrea2Job(id)).status, 'pending');
  assert.equal((await stub.getKrea2Job(id)).url, null);

  await runAlarms(stub, storage);
  const job = await stub.getKrea2Job(id);
  assert.equal(job.status, 'done', job.error ?? '');
  assert.equal(job.seed, 9);
  // 202 のぶんは保存に進まないので、R2 に入る画像は 1 枚だけ
  const obj = await env.IMAGES.get(`${job.url.split('/').pop()}.png`);
  assert.ok(obj, '完了した画像が R2 にある');
  assert.equal(polls, 3);
});

test('編集: 画像以外が返ったら、結果にせずエラーにする', async () => {
  const mod = await loadWorker();
  const { stub, storage } = makeDo(mod);
  globalThis.fetch = async (url) => (String(url).includes('/poll/')
    ? new Response('{"detail":"oops"}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response(null, { status: 303, headers: { Location: 'https://x--y.modal.run/poll/1' } }));

  const id = '9'.repeat(32);
  await stub.startKrea2Job(id, { prompt: 'remove', image: 'A', mask: 'B' },
    'https://x--y.modal.run/edit', 'edit', 'wan-edit');
  await runAlarms(stub, storage);

  const job = await stub.getKrea2Job(id);
  assert.equal(job.status, 'error');
  assert.match(job.error, /画像が返りませんでした/);
  assert.equal(job.url, null);
});

test('いつまでも終わらないジョブは打ち切る（「編集中…」で止まったままにしない）', async () => {
  const mod = await loadWorker();
  const { stub, storage } = makeDo(mod);
  // ずっと 202（実行中）を返し続ける Modal
  globalThis.fetch = async (url) => (String(url).includes('/poll/')
    ? new Response(null, { status: 202 })
    : new Response(null, { status: 303, headers: { Location: 'https://x--y.modal.run/poll/1' } }));

  const id = '8'.repeat(32);
  await stub.startKrea2Job(id, { prompt: 'remove', image: 'A', mask: 'B' },
    'https://x--y.modal.run/edit', 'edit', 'wan-edit');
  await storage.deleteAlarm();
  await stub.alarm();
  assert.equal((await stub.getKrea2Job(id)).status, 'pending');

  // 上限を過ぎるまで走ったことにする
  const key = `krea2:job:${id}`;
  const stored = await storage.get(key);
  stored.created = Date.now() - 31 * 60 * 1000;
  await storage.put(key, stored);
  await storage.deleteAlarm();
  await stub.alarm();

  const job = await stub.getKrea2Job(id);
  assert.equal(job.status, 'error');
  assert.match(job.error, /分以内に完了しませんでした/);
});

// ポーリングの連鎖がどこかで切れると、クライアントは「編集中…」のまま待ち続ける
test('走っているジョブを問い合わせたら、alarm が落ちていても張り直す', async () => {
  const mod = await loadWorker();
  const { stub, storage } = makeDo(mod);
  globalThis.fetch = async () => new Response(null, { status: 202 });

  const id = '7'.repeat(32);
  await stub.startKrea2Job(id, { prompt: 'remove', image: 'A', mask: 'B' },
    'https://x--y.modal.run/edit', 'edit', 'wan-edit');
  await storage.deleteAlarm(); // alarm が落ちた状態
  assert.equal(await storage.getAlarm(), null);

  assert.equal((await stub.getKrea2Job(id)).status, 'pending');
  assert.notEqual(await storage.getAlarm(), null);
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

  await post('/api/krea2/generate', { ...base, jobId: '1'.repeat(32), endpoint: 'lanpaint' });
  assert.match(seen.at(-1)[2], /lanpaint-api-comfyapi-generate/);
  assert.deepEqual(seen.at(-1).slice(3), ['generate', 'lanpaint']);

  const edit = { ...base, image: 'AAA', mask: 'BBB' };
  await post('/api/modal/edit', { ...edit, jobId: 'e'.repeat(32) });
  assert.match(seen.at(-1)[2], /wan-vace-api-comfyapi-edit/);
  assert.deepEqual(seen.at(-1).slice(3), ['edit', 'wan-edit']);

  // 編集も endpoint フィールドで LanPaint（/inpaint）へ振り分ける
  await post('/api/modal/edit', { ...edit, jobId: 'a'.repeat(32), endpoint: 'lanpaint' });
  assert.match(seen.at(-1)[2], /lanpaint-api-comfyapi-inpaint/);
  assert.deepEqual(seen.at(-1).slice(3), ['inpaint', 'lanpaint']);
  assert.equal(seen.at(-1)[1].endpoint, undefined);

  // 未知の値は Wan2.2 + VACE（既定）へ落とす。Object の継承プロパティ名も同じ扱い
  for (const endpoint of ['nope', 'constructor', '__proto__']) {
    await post('/api/modal/edit', { ...edit, jobId: 'b'.repeat(32), endpoint });
    assert.match(seen.at(-1)[2], /wan-vace-api-comfyapi-edit/, endpoint);
    assert.deepEqual(seen.at(-1).slice(3), ['edit', 'wan-edit'], endpoint);
  }
  await post('/api/krea2/generate', { ...base, jobId: '2'.repeat(32), endpoint: 'constructor' });
  assert.match(seen.at(-1)[2], /krea2-comfy-api-exp/);
});

test('インペイント: 結果は LanPaint として記録する', async () => {
  const mod = await loadWorker();
  const { stub, storage, env } = makeDo(mod);
  globalThis.fetch = makeModal({ headers: { 'X-Width': '832', 'X-Height': '1216' } }).fetch;

  const id = 'c'.repeat(32);
  await stub.startKrea2Job(id, {
    prompt: 'a red knitted beanie hat',
    image: 'data:image/png;base64,AAAA',
    mask: 'data:image/png;base64,BBBB',
    width: 832,
    height: 1216,
    num_steps: 5,
  }, 'https://x--y.modal.run/inpaint', 'inpaint', 'lanpaint');
  await runAlarms(stub, storage);

  const job = await stub.getKrea2Job(id);
  assert.equal(job.status, 'done', job.error ?? '');
  assert.equal(job.width, 832);
  assert.equal(job.height, 1216);

  const meta = readEmbeddedMeta(await storedBytes(env, job.url));
  assert.equal(meta.source, 'lanpaint-inpaint');
  assert.equal(meta.endpoint, 'lanpaint');
  assert.equal(meta.num_steps, 5);
  assert.equal(meta.image, undefined);
  assert.equal(meta.mask, undefined);
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
