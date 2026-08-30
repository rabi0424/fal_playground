// 画像メタデータの正規化と読み書きのテスト:  node test/image-meta.test.mjs
//
// 焼き込む JSON の形は 1 つ（v:1）で、書くのは storeImage、読むのは
// readImageMeta だけ ―― という取り決めが守られていることを見る:
//
//   - どの経路の設定を渡しても、同じ形（決まった項目 + raw）で焼かれること
//   - このアプリの焼き込み・ComfyUI・A1111 のどれを読んでも同じ形で返ること
//   - R2 のキーが必ず「受け取ったバイト列の sha256」になること（内容アドレス）
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { makeStorage, makeBucket, makeD1 } from './harness.mjs';

const WORKER = new URL('../worker.js', import.meta.url);
const OUT = new URL('./.image-meta.test.mjs', import.meta.url);

async function loadWorker() {
  let src = readFileSync(WORKER, 'utf8');
  src = src.replace("import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
  writeFileSync(OUT, src);
  return import(`${OUT.href}?v=${Date.now()}`);
}

function makeEnv(mod) {
  const bucket = makeBucket({ sub: 0 });
  const stub = new mod.SyncState({ storage: makeStorage() }, { IMAGES: bucket });
  const env = { STATE: { idFromName: () => 'singleton', get: () => stub }, IMAGES: bucket, DB: makeD1() };
  return Object.assign(env, { bucket });
}

const pending = [];
const call = (mod, env, path, init) =>
  mod.default.fetch(new Request(`https://x${path}`, init), env, {
    waitUntil: (promise) => pending.push(promise),
  });
const settle = () => Promise.all(pending.splice(0));

/* ---- PNG の組み立て（テキストチャンク入りの最小 PNG） ---- */

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

// keyword \0 本文
const tEXt = (keyword, text) =>
  chunk('tEXt', Buffer.concat([Buffer.from(`${keyword}\0`, 'latin1'), Buffer.from(text, 'latin1')]));

// keyword \0 圧縮フラグ 圧縮方式 言語タグ \0 翻訳キーワード \0 本文
const iTXt = (keyword, text) =>
  chunk('iTXt', Buffer.concat([
    Buffer.from(`${keyword}\0`, 'utf8'), Buffer.from([0, 0, 0, 0]), Buffer.from(text, 'utf8'),
  ]));

function makePng(...texts) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...texts,
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dataUri = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---- 正規化 ---- */

test('経路ごとの書き方の違いを吸収して、1 つの形にする', async () => {
  const { normalizeImageMeta } = await loadWorker();

  // fal: 設定は input の中、名前は num_inference_steps / guidance_scale / image_size
  const fal = normalizeImageMeta({
    kind: 'generate',
    model: 'fal-ai/krea-2/turbo/lora',
    prompt: 'a cat',
    input: {
      prompt: 'a cat',
      image_size: { width: 1024, height: 1536 },
      num_inference_steps: 8,
      guidance_scale: 3.5,
      seed: 42,
      num_images: 2,
    },
    loras: [{ path: 'https://x/y.safetensors', scale: 0.8 }],
    created: '2026-01-02T03:04:05.000Z',
  });
  assert.equal(fal.v, 1);
  assert.equal(fal.provider, 'fal');
  assert.deepEqual([fal.width, fal.height], [1024, 1536]);
  assert.deepEqual([fal.steps, fal.cfg, fal.seed], [8, 3.5, 42]);
  assert.deepEqual(fal.loras, [{ path: 'https://x/y.safetensors', scale: 0.8 }]);
  assert.equal(fal.created, '2026-01-02T03:04:05.000Z');
  assert.equal(fal.raw.num_images, 2, '正規化で拾わない設定は raw に残る');

  // Modal: 設定は直下、名前は steps / cfg / width / height
  const modal = normalizeImageMeta({
    kind: 'inpaint',
    model: 'modal/lanpaint',
    endpoint: 'lanpaint',
    prompt: 'remove',
    width: 832,
    height: 1216,
    steps: 6,
    cfg: 1,
    seed: 7,
    sampler_name: 'euler',
    loras: [{ name: 'distill', strength: 0.4 }],
  });
  assert.equal(modal.provider, 'modal');
  assert.equal(modal.kind, 'inpaint');
  assert.deepEqual([modal.width, modal.height, modal.steps, modal.cfg], [832, 1216, 6, 1]);
  assert.deepEqual(modal.loras, [{ path: 'distill', scale: 0.4 }], 'name/strength も同じ形に寄せる');
  assert.deepEqual(modal.raw, { endpoint: 'lanpaint', sampler_name: 'euler' });

  // 何も無くても形は同じ（読む側が項目の有無を気にしなくてよい）
  const empty = normalizeImageMeta(null);
  assert.deepEqual(Object.keys(empty).sort(), [
    'app', 'cfg', 'created', 'height', 'kind', 'loras', 'model',
    'negative', 'prompt', 'provider', 'raw', 'seed', 'steps', 'v', 'width',
  ]);
  assert.equal(empty.kind, 'generate');
  assert.equal(empty.model, null);
  assert.deepEqual(empty.loras, []);
});

test('source 名で経路を区別していた頃の焼き込みも読める', async () => {
  const { normalizeImageMeta } = await loadWorker();
  const cases = [
    ['poe-edit', 'edit'],
    ['wan-vace-edit', 'edit'],
    ['lanpaint-inpaint', 'inpaint'],
    ['krea2-modal', 'generate'],
    ['capture', 'generate'],
    ['imgedit-input', 'input'],
    ['imgedit-masked', 'composite'],
  ];
  for (const [source, kind] of cases) {
    const got = normalizeImageMeta({ app: 'fal playground', source, model: 'poe/gpt', prompt: 'x' });
    assert.equal(got.kind, kind, source);
    assert.equal(got.v, 1);
    assert.equal(got.raw.source, undefined, 'source は新しい形に置き換わるので raw に残さない');
  }
});

test('正規化を二度かけても結果は変わらない（raw の中身も落とさない）', async () => {
  const { normalizeImageMeta } = await loadWorker();
  const once = normalizeImageMeta({
    kind: 'edit', model: 'modal/wan-edit', prompt: 'p', endpoint: 'wan-edit', denoise: 0.6,
  });
  assert.deepEqual(normalizeImageMeta(once), once);
});

/* ---- 読み取り ---- */

test('自分で焼いた PNG を読み戻せる', async () => {
  const { readImageMeta } = await loadWorker();
  const meta = { app: 'fal playground', v: 1, kind: 'edit', model: 'poe/x', prompt: 'ぼかす' };
  const got = readImageMeta(makePng(iTXt('playground', JSON.stringify(meta))));
  assert.equal(got.kind, 'edit');
  assert.equal(got.prompt, 'ぼかす', 'UTF-8 の本文が壊れない');
  assert.equal(got.provider, 'poe');
});

test('ComfyUI の焼き込みを読む', async () => {
  const { readImageMeta } = await loadWorker();
  const graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev.safetensors' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'a red car' } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry' } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024 } },
    5: { class_type: 'LoraLoader', inputs: { lora_name: 'detail.safetensors', strength_model: 0.7 } },
    6: {
      class_type: 'KSampler',
      inputs: { seed: 12345, steps: 20, cfg: 7.5, positive: ['2', 0], negative: ['3', 0] },
    },
  };
  const got = readImageMeta(makePng(tEXt('prompt', JSON.stringify(graph))));
  assert.equal(got.v, 1);
  assert.equal(got.provider, 'comfyui');
  assert.equal(got.model, 'flux1-dev.safetensors');
  assert.equal(got.prompt, 'a red car');
  assert.equal(got.negative, 'blurry');
  assert.deepEqual([got.seed, got.steps, got.cfg], [12345, 20, 7.5]);
  assert.deepEqual([got.width, got.height], [768, 1024]);
  assert.deepEqual(got.loras, [{ path: 'detail.safetensors', scale: 0.7 }]);
  assert.deepEqual(got.raw.prompt, graph, '元のグラフは丸ごと残す');
});

test('A1111 の焼き込みを読む', async () => {
  const { readImageMeta } = await loadWorker();
  const params = 'a red car, highly detailed\n'
    + 'Negative prompt: blurry, low quality\n'
    + 'Steps: 28, Sampler: DPM++ 2M, CFG scale: 6.5, Seed: 987654, Size: 512x768, '
    + 'Model hash: abc123, Model: sd_xl_base_1.0';
  const got = readImageMeta(makePng(tEXt('parameters', params)));
  assert.equal(got.provider, 'a1111');
  assert.equal(got.prompt, 'a red car, highly detailed');
  assert.equal(got.negative, 'blurry, low quality');
  assert.deepEqual([got.seed, got.steps, got.cfg], [987654, 28, 6.5]);
  assert.deepEqual([got.width, got.height], [512, 768]);
  assert.equal(got.model, 'sd_xl_base_1.0');
  assert.equal(got.raw.sampler, 'DPM++ 2M');
});

test('メタの無い画像・PNG でない画像は null', async () => {
  const { readImageMeta } = await loadWorker();
  assert.equal(readImageMeta(makePng()), null);
  assert.equal(readImageMeta(Buffer.from('\xff\xd8\xff\xe0 JPEG ではない', 'latin1')), null);
});

/* ---- 書き込み（R2 まで通す） ---- */

test('アップロードした画像は内容アドレスで置かれ、メタは正規化して焼かれる', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  const png = makePng();

  const res = await call(mod, env, '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: dataUri(png),
      // クライアントは正規化前の形で送ってよい（サーバーが揃える）
      meta: { kind: 'composite', model: 'poe/gpt-image-1', prompt: 'p', rect: { x: 1 }, blend: 4 },
    }),
  });
  const { url } = await res.json();
  await settle();

  // キーは「送られてきたバイト列」の sha256。焼き込みはそのあと
  assert.equal(url, `/api/image/${sha(png)}`);
  assert.ok(env.bucket.objects.get(`${sha(png)}.png`).body.length > png.length, '焼き込まれていません');

  const meta = await (await call(mod, env, `${url}/meta`)).json();
  assert.equal(meta.v, 1);
  assert.equal(meta.kind, 'composite');
  assert.equal(meta.provider, 'poe');
  assert.deepEqual(meta.raw, { rect: { x: 1 }, blend: 4 });
});

test('同じ画像は二度送らずに済む（問い合わせで持っていると答える）', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  const png = makePng();
  const probe = () => call(mod, env, '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash: sha(png) }),
  });

  assert.equal((await (await probe()).json()).url, null);
  await call(mod, env, '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUri(png) }),
  });
  await settle();
  assert.equal((await (await probe()).json()).url, `/api/image/${sha(png)}`);
});

test('取り込んだ ComfyUI の画像も、同じ口から同じ形で読める', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  // メタを渡さずに上げれば、元々焼かれているチャンクはそのまま残る
  const png = makePng(tEXt('parameters', 'a cat\nSteps: 20, Seed: 5, Size: 64x64'));
  const { url } = await (await call(mod, env, '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUri(png) }),
  })).json();
  await settle();

  const meta = await (await call(mod, env, `${url}/meta`)).json();
  assert.equal(meta.provider, 'a1111');
  assert.equal(meta.prompt, 'a cat');
  assert.deepEqual([meta.width, meta.height, meta.seed], [64, 64, 5]);
});

test('焼き込みの無い画像のメタを聞かれたら 404', async () => {
  const mod = await loadWorker();
  const env = makeEnv(mod);
  const png = makePng();
  await call(mod, env, '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUri(png) }),
  });
  await settle();
  assert.equal((await call(mod, env, `/api/image/${sha(png)}/meta`)).status, 404);
  assert.equal((await call(mod, env, `/api/image/${'0'.repeat(64)}/meta`)).status, 404);
});

const run = async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`✗ ${name}\n  ${err.message}`);
    }
  }
  rmSync(OUT, { force: true });
  console.log(failed === 0 ? '\nすべて成功' : `\n${failed} 件失敗`);
  process.exit(failed === 0 ? 0 : 1);
};
run();
