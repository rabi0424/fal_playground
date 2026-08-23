// Civitai 取り込みパイプラインの結合テスト:  node test/import.test.mjs
//
// worker.js をそのまま Node に取り込み、Civitai / Hugging Face / R2 をモックして流す。
// サイズ関連の定数はテスト用に小さくパッチするので、1 MB のダミーファイルでも
// 「複数回の alarm 実行に分割される」実際の経路を通せる。DEBUG_ERRORS=1 を付けると
// 握りつぶしている例外を表示する。
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { makeStorage, makeBucket, makeFetch } from './harness.mjs';

const WORKER = new URL('../worker.js', import.meta.url);
const OUT = new URL('./.worker.test.mjs', import.meta.url); // 定数を差し替えた実行用コピー

const PATCHES = [
  ["import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'],
  ['const CHUNKED_DL_MIN_BYTES = 64 * 1024 * 1024;', 'const CHUNKED_DL_MIN_BYTES = 1024;'],
  ['const R2_PART_SIZE = 256 * 1024 * 1024;', 'const R2_PART_SIZE = 64 * 1024;'],
  ['const R2_SMALL_PART_SIZE = 64 * 1024 * 1024;', 'const R2_SMALL_PART_SIZE = 64 * 1024;'],
  ['const LORA_PARTS_PER_RUN = 16;', 'const LORA_PARTS_PER_RUN = 4;'],
  ['const LORA_BYTES_PER_RUN = 2 * 1024 * 1024 * 1024;', 'const LORA_BYTES_PER_RUN = 10 * 1024 * 1024;'],
  ['const LORA_API_TIMEOUT_MS = 60 * 1000;', 'const LORA_API_TIMEOUT_MS = 50;'],
]
if (process.env.DEBUG_ERRORS) {
  PATCHES.push(['    } catch (err) {\n      // pending のまま次の alarm で再試行。',
    '    } catch (err) { console.error("[run error]", err);\n      // pending のまま次の alarm で再試行。']);
};

async function loadWorker() {
  let src = readFileSync(WORKER, 'utf8');
  for (const [from, to] of PATCHES) {
    assert.equal(src.split(from).length - 1, 1, `patch target not found once: ${from}`);
    src = src.replace(from, to);
  }
  writeFileSync(OUT, src);
  return await import(`${OUT.href}?v=${Date.now()}`);
}

// Workers の FixedLengthStream 相当（長さ検証はしない素通しの TransformStream）
globalThis.FixedLengthStream = class FixedLengthStream extends TransformStream {
  constructor(len) {
    super();
    this.expectedLength = len;
  }
};

function makeDo(mod, { fileBytes, chunkSize, failPartOnce, hangOn }) {
  const counters = { sub: 0 };
  const storage = makeStorage();
  const bucket = makeBucket(counters);
  const server = makeFetch({ counters, fileBytes, chunkSize, failPartOnce, hangOn });
  globalThis.fetch = server.fetch;
  const env = { IMAGES: bucket, HF_TOKEN: 'hf_test', CIVITAI_TOKEN: 'civ_test' };
  const stub = new mod.SyncState({ storage }, env);
  return { stub, storage, bucket, server, counters };
}

// alarm を回して収束させる。1 回の実行ごとの subrequest 数を記録する
async function runAlarms({ stub, storage, counters }, max = 200) {
  const perRun = [];
  for (let i = 0; i < max; i++) {
    if ((await storage.getAlarm()) === null) break;
    await storage.deleteAlarm(); // Workers と同じく、実行開始時に alarm は消費される
    counters.sub = 0;
    await stub.alarm();
    perRun.push(counters.sub);
  }
  return perRun;
}

async function testCheckpoint() {
  const mod = await loadWorker();
  const fileBytes = randomBytes(1024 * 1024); // 1 MB = 64 KB × 16 パート
  const ctx = makeDo(mod, { fileBytes, chunkSize: 100 * 1024 }); // HF 側は 11 パート
  const { stub, storage, bucket, server } = ctx;

  await stub.startLoraImport('a'.repeat(32), 'https://civitai.com/models/45?modelVersionId=123', 'me/repo', true, 'ckpt');
  const perRun = await runAlarms(ctx);

  const job = await storage.get('lora:job:' + 'a'.repeat(32));
  assert.equal(job.status, 'done', `期待: done / 実際: ${job.status} (${job.error ?? ''})`);
  assert.ok(perRun.length >= 6, `複数回の alarm に分割されるはず: ${perRun.length} 回`);
  assert.ok(Math.max(...perRun) <= 30, `1 回あたりの subrequest が多すぎる: ${Math.max(...perRun)}`);
  assert.ok(server.completed.equals(fileBytes), 'HF に届いた内容が元ファイルと一致しない');
  assert.equal(server.batchCalls, 1, `batch API は 1 回だけのはず: ${server.batchCalls} 回`);
  assert.equal(server.verified, true, 'verify が呼ばれていない');
  assert.ok(server.committed.includes('test-ckpt.safetensors'), 'commit の内容が不正');
  assert.equal(job.hfUrl, 'https://huggingface.co/me/repo/resolve/main/test-ckpt.safetensors');
  // 一時ファイルと計画ファイルが残っていないこと
  assert.deepEqual([...bucket.objects.keys()], [], `R2 に残骸: ${[...bucket.objects.keys()]}`);
  assert.equal(bucket.uploads.size, 0, '未完了の multipart が残っている');
  console.log(`✓ ckpt: ${perRun.length} 回の alarm 実行に分割 / 各回の subrequest = ${perRun.join(', ')}`);
}

async function testLoraSingleRun() {
  const mod = await loadWorker();
  const fileBytes = randomBytes(150 * 1024); // 64 KB × 3 パート = 予算内
  const ctx = makeDo(mod, { fileBytes, chunkSize: 0 }); // basic アップロード
  const { stub, storage, bucket, server } = ctx;

  await stub.startLoraImport('b'.repeat(32), 'https://civitai.com/models/45?modelVersionId=123', 'me/repo', true, 'lora');
  const perRun = await runAlarms(ctx);

  const job = await storage.get('lora:job:' + 'b'.repeat(32));
  assert.equal(job.status, 'done', `期待: done / 実際: ${job.status} (${job.error ?? ''})`);
  assert.ok(perRun.length <= 3, `小さいファイルは実行回数が少ないはず: ${perRun.length} 回`);
  assert.ok(server.hfParts.get(1).body.equals(fileBytes), 'basic PUT の内容が一致しない');
  assert.equal(job.planAt ?? null, null, '計画ファイルの記録が残っている');
  assert.deepEqual([...bucket.objects.keys()], [], `R2 に残骸: ${[...bucket.objects.keys()]}`);
  console.log(`✓ lora: ${perRun.length} 回の alarm 実行で完了 / 各回の subrequest = ${perRun.join(', ')}`);
}

async function testRetryDuringUpload() {
  const mod = await loadWorker();
  const fileBytes = randomBytes(1024 * 1024);
  // アップロードの 5 番目のパートを 1 回だけ失敗させ、再開後も同じセッションで続くか見る
  const ctx = makeDo(mod, { fileBytes, chunkSize: 100 * 1024, failPartOnce: 5 });
  const { stub, storage, server } = ctx;

  await stub.startLoraImport('c'.repeat(32), 'https://civitai.com/models/45?modelVersionId=123', 'me/repo', false, 'ckpt');
  await runAlarms(ctx);

  const job = await storage.get('lora:job:' + 'c'.repeat(32));
  assert.equal(job.status, 'done', `期待: done / 実際: ${job.status} (${job.error ?? ''})`);
  assert.ok(server.completed.equals(fileBytes), '再試行後の内容が一致しない');
  assert.equal(server.batchCalls, 1, `再試行でも batch は 1 回のはず: ${server.batchCalls} 回`);
  console.log('✓ retry: パート失敗から再開しても同じ multipart セッションで完了');
}

async function testStallSupervision() {
  const mod = await loadWorker();
  const fileBytes = randomBytes(1024 * 1024);
  const ctx = makeDo(mod, { fileBytes, chunkSize: 100 * 1024 });
  const { stub, storage, bucket } = ctx;
  const id = 'd'.repeat(32);
  const key = `lora:job:${id}`;

  await stub.startLoraImport(id, 'https://civitai.com/models/45?modelVersionId=123', 'me/repo', true, 'ckpt');
  // 1 回だけ実行して途中（download）で止める
  await storage.deleteAlarm();
  await stub.alarm();
  const mid = await storage.get(key);
  assert.equal(mid.status, 'pending');

  // alarm が消えたまま長時間止まった状態を作る
  await storage.deleteAlarm();
  mid.progressAt = Date.now() - 20 * 60 * 1000;
  await storage.put(key, mid);

  const view = await stub.getLoraImport(id);
  assert.equal(view.status, 'error', `停滞ジョブは error になるはず: ${view.status}`);
  assert.match(view.error, /進まなかったため中断/);
  assert.equal(bucket.uploads.size, 0, '未完了の multipart が破棄されていない');
  assert.deepEqual([...bucket.objects.keys()], [], `R2 に残骸: ${[...bucket.objects.keys()]}`);
  console.log('✓ supervise: 停滞ジョブを打ち切り、R2 の残骸も破棄');

  // 打ち切り後は、取り残された実行が pending に書き戻せないこと
  await assert.rejects(() => stub.saveLoraJob(key, mid), /中断済み/);
  console.log('✓ supervise: 打ち切り済みジョブの書き戻しを拒否');
}

async function testResumeAfterLostAlarm() {
  const mod = await loadWorker();
  const fileBytes = randomBytes(1024 * 1024);
  const ctx = makeDo(mod, { fileBytes, chunkSize: 100 * 1024 });
  const { stub, storage } = ctx;
  const id = 'e'.repeat(32);
  const key = `lora:job:${id}`;

  await stub.startLoraImport(id, 'https://civitai.com/models/45?modelVersionId=123', 'me/repo', true, 'ckpt');
  await storage.deleteAlarm();
  await stub.alarm();

  // alarm が張られないまま数分放置された状態（実行が異常終了したケース）
  await storage.deleteAlarm();
  const mid = await storage.get(key);
  mid.progressAt = Date.now() - 5 * 60 * 1000;
  await storage.put(key, mid);

  await stub.getLoraImport(id); // ポーリング相当
  assert.notEqual(await storage.getAlarm(), null, 'alarm が張り直されていない');

  const perRun = await runAlarms(ctx);
  const job = await storage.get(key);
  assert.equal(job.status, 'done', `再開して完了するはず: ${job.status} (${job.error ?? ''})`);
  console.log(`✓ resume: alarm 消失から張り直して完了（追加 ${perRun.length} 回）`);
}

// Civitai の API が応答を返さないまま接続だけ生きているケース。タイムアウトが無いと
// alarm ごと固まり「モデル情報を確認中…」から永久に進まなくなる
async function testResolveHang() {
  const mod = await loadWorker();
  const fileBytes = randomBytes(64 * 1024);
  const ctx = makeDo(mod, { fileBytes, chunkSize: 0, hangOn: '/api/v1/model-versions/' });
  const { stub, storage, server } = ctx;
  const id = 'f'.repeat(32);

  await stub.startLoraImport(id, 'https://civitai.com/models/45?modelVersionId=123', 'me/repo', true, 'ckpt');
  // AbortSignal.timeout のタイマーは unref なので、待ちの間に Node が終了しないよう繋ぎ止める
  const keepAlive = setInterval(() => {}, 10);
  let perRun;
  try {
    perRun = await runAlarms(ctx, 30);
  } finally {
    clearInterval(keepAlive);
  }

  const job = await storage.get(`lora:job:${id}`);
  assert.equal(job.status, 'error', `応答なしは error で終わるはず: ${job.status}`);
  assert.match(job.error, /取り込みを完了できませんでした/);
  assert.ok(job.error.length > 30, `失敗理由が具体的に出るはず: ${job.error}`);
  assert.ok(perRun.length <= 10, `無限に回らないこと: ${perRun.length} 回`);
  assert.ok(server.hangs >= 2, '応答なしの呼び出しが再試行されている');
  console.log(`✓ resolve hang: ${perRun.length} 回で打ち切り / error = ${job.error}`);
}

// 取り込みジョブが 2 つ同時に走っても、1 回の alarm 実行の予算は合計で使う
async function testSharedBudget() {
  const mod = await loadWorker();
  const fileBytes = randomBytes(1024 * 1024);
  const ctx = makeDo(mod, { fileBytes, chunkSize: 100 * 1024 });
  const { stub, storage, counters } = ctx;

  await stub.startLoraImport('1'.repeat(32), 'https://civitai.com/models/45?modelVersionId=123', 'me/repo', false, 'ckpt');
  await stub.startLoraImport('2'.repeat(32), 'https://civitai.com/models/45?modelVersionId=123', 'me/repo2', false, 'ckpt');
  const perRun = await runAlarms(ctx, 100);

  const a = await storage.get('lora:job:' + '1'.repeat(32));
  const b = await storage.get('lora:job:' + '2'.repeat(32));
  assert.equal(a.status, 'done', `1 本目: ${a.status} (${a.error ?? ''})`);
  assert.equal(b.status, 'done', `2 本目: ${b.status} (${b.error ?? ''})`);
  assert.ok(Math.max(...perRun) <= 30, `2 本同時でも 1 回あたりが増えすぎない: ${Math.max(...perRun)}`);
  console.log(`✓ shared budget: 2 本同時で ${perRun.length} 回 / 最大 subrequest = ${Math.max(...perRun)}`);
  void counters;
}

// 大きな取り込みが走っている最中に別の取り込みを入れても、resolve で待たされないこと
async function testNewJobNotStarved() {
  const mod = await loadWorker();
  const fileBytes = randomBytes(1024 * 1024);
  const ctx = makeDo(mod, { fileBytes, chunkSize: 100 * 1024 });
  const { stub, storage } = ctx;
  const big = 'a'.repeat(32);
  const late = 'b'.repeat(32);

  await stub.startLoraImport(big, 'https://civitai.com/models/45?modelVersionId=123', 'me/big', false, 'ckpt');
  await storage.deleteAlarm();
  await stub.alarm(); // 予算を使い切るまで大きい方が進む
  const bigJob = await storage.get(`lora:job:${big}`);
  assert.equal(bigJob.status, 'pending');
  assert.equal(bigJob.step, 'download');

  await stub.startLoraImport(late, 'https://civitai.com/models/45?modelVersionId=123', 'me/late', false, 'ckpt');
  await storage.deleteAlarm();
  await stub.alarm();
  const lateJob = await storage.get(`lora:job:${late}`);
  assert.notEqual(lateJob.step, 'resolve', '後から入れたジョブが resolve で止まっている');
  console.log(`✓ starvation: 後入れジョブは 1 回の実行で ${lateJob.step} まで進んだ`);
}

// 掃除で消えた記録を、生き残った実行が書き戻して復活させないこと
async function testNoResurrection() {
  const mod = await loadWorker();
  const fileBytes = randomBytes(64 * 1024);
  const ctx = makeDo(mod, { fileBytes, chunkSize: 0 });
  const { stub, storage } = ctx;
  const id = 'a'.repeat(32);
  const key = `lora:job:${id}`;

  await stub.startLoraImport(id, 'https://civitai.com/models/45?modelVersionId=123', 'me/repo', false, 'lora');
  const job = await storage.get(key);
  await storage.delete(key); // 掃除で消えた状況

  await assert.rejects(() => stub.saveLoraJob(key, job), /終了済み/);
  assert.equal(await storage.get(key), undefined, '消したはずの記録が復活している');
  console.log('✓ resurrection: 消えた記録は書き戻されない');
}

// 一覧・中止の API
async function testListAndCancel() {
  const mod = await loadWorker();
  const fileBytes = randomBytes(1024 * 1024);
  const ctx = makeDo(mod, { fileBytes, chunkSize: 100 * 1024 });
  const { stub, storage, bucket } = ctx;
  const id = 'c'.repeat(32);

  await stub.startLoraImport(id, 'https://civitai.com/models/45?modelVersionId=123', 'me/repo', false, 'ckpt');
  await storage.deleteAlarm();
  await stub.alarm();

  const list = await stub.listLoraImports();
  assert.equal(list.jobs.length, 1);
  assert.equal(list.jobs[0].step, 'download');
  assert.ok(list.jobs[0].bytesTotal > 0, '一覧にサイズが出ていない');
  assert.ok(Number.isFinite(list.jobs[0].progressAgoSec), '一覧に停滞時間が出ていない');

  assert.equal(await stub.cancelLoraImport(id), true);
  const view = await stub.getLoraImport(id);
  assert.equal(view.status, 'error');
  assert.match(view.error, /中止/);
  assert.equal(bucket.uploads.size, 0, '中止時に multipart が破棄されていない');
  assert.equal(await stub.cancelLoraImport('9'.repeat(32)), false);
  console.log('✓ list/cancel: 一覧が取得でき、中止で multipart も破棄される');
}

// 実際に起きた不具合: alarm が過去の時刻のまま配信されずに残ると、「張られている」と
// 判定して張り直さないため、以後どのジョブも一度も実行されない（runs が 0 のまま）
async function testStuckPastAlarm() {
  const mod = await loadWorker();
  const fileBytes = randomBytes(150 * 1024);
  const ctx = makeDo(mod, { fileBytes, chunkSize: 0 });
  const { stub, storage } = ctx;
  const id = 'a'.repeat(32);

  // 3 日前の時刻で居座っている alarm
  await storage.setAlarm(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await stub.startLoraImport(id, 'https://civitai.com/models/45?modelVersionId=123', 'me/repo', false, 'lora');
  assert.ok((await storage.getAlarm()) > Date.now() - 1000, '過ぎた alarm が張り直されていない');

  await runAlarms(ctx);
  const job = await storage.get(`lora:job:${id}`);
  assert.equal(job.status, 'done', `張り直した alarm で完了するはず: ${job.status} (${job.error ?? ''})`);
  assert.ok(job.runs > 0, 'ジョブが一度も実行されていない');

  // 一覧にも「過ぎた alarm」であることが出ること
  await storage.setAlarm(Date.now() - 60 * 60 * 1000);
  const list = await stub.listLoraImports();
  assert.equal(list.alarmOverdue, true, '一覧に alarm の異常が出ていない');
  console.log('✓ stuck alarm: 過去の時刻で居座った alarm を張り直して完了');
}

// LoRA ライブラリのトリガーワード取得（モデルの隣の .civitai.json を読む）
async function testLoraMetaEndpoint() {
  const mod = await loadWorker();
  const calls = [];
  const doc = {
    savedAt: '2026-08-01T00:00:00Z',
    source: 'https://civitai.com/models/45',
    model: { name: 'High resolution', creator: 'NO8D' },
    version: { name: 'HighQuality_portrait', baseModel: 'Krea 2', trainedWords: ['hi res portrait', '', 'detailed skin'] },
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    if (String(url).endsWith('.civitai.json')) {
      return new Response(JSON.stringify(doc), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('nope', { status: 404 });
  };
  const env = {
    HF_TOKEN: 'hf_test',
    STATE: { idFromName: (n) => n, get: () => ({}) },
  };
  const call = (u) => mod.default.fetch(
    new Request(`https://app.example/api/lora/meta?url=${encodeURIComponent(u)}`), env);

  const ok = await call('https://huggingface.co/me/repo/resolve/main/sub/HighQuality.safetensors');
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.trigger, 'hi res portrait, detailed skin', '空の語を除いて連結するはず');
  assert.equal(body.base, 'Krea 2');
  assert.equal(body.modelName, 'High resolution');
  assert.equal(calls[0].url, 'https://huggingface.co/me/repo/resolve/main/sub/HighQuality.civitai.json',
    `.civitai.json の URL が違う: ${calls[0].url}`);
  assert.equal(calls[0].auth, 'Bearer hf_test', '非公開リポジトリ用のトークンが付いていない');

  // HF 以外・別拡張子は受け付けない
  assert.equal((await call('https://example.com/x.safetensors')).status, 422);
  assert.equal((await call('https://huggingface.co/me/repo/resolve/main/x.gguf')).status, 422);

  // JSON が無い LoRA は 404（クライアントはこれを見て案内を出す）
  const missing = await call('https://huggingface.co/me/repo/resolve/main/none.safetensors');
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  assert.equal((await call('https://huggingface.co/me/repo/resolve/main/none.safetensors')).status, 404);
  void missing;
  console.log('✓ lora meta: .civitai.json を読んでトリガーワード・ベースモデルを返す');
}

// WaveSpeed プロキシ: 転送先の制限とキー付与
async function testWavespeedProxy() {
  const mod = await loadWorker();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization, body: init?.body });
    return new Response(JSON.stringify({ code: 200, data: { id: 'pred-1' } }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  const env = { WAVESPEED_API_KEY: 'ws_test', STATE: { idFromName: (n) => n, get: () => ({}) } };
  const call = (target, init) => mod.default.fetch(
    new Request(`https://app.example/api/wavespeed/proxy?url=${encodeURIComponent(target)}`, init), env);

  const ok = await call('https://api.wavespeed.ai/api/v3/wavespeed-ai/qwen-image/edit-2511-lora',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"prompt":"x"}' });
  assert.equal(ok.status, 200);
  assert.equal(calls[0].auth, 'Bearer ws_test', 'API キーが付いていない');
  assert.equal(calls[0].body, '{"prompt":"x"}', '本文がそのまま渡っていない');

  // 別ホストへの転送は拒否する（プロキシを踏み台にさせない）
  assert.equal((await call('https://example.com/x')).status, 403);
  assert.equal((await call('http://api.wavespeed.ai/x')).status, 403);

  // キー未設定なら理由の分かるエラー
  const noKey = await mod.default.fetch(
    new Request('https://app.example/api/wavespeed/proxy?url=' + encodeURIComponent('https://api.wavespeed.ai/x')),
    { STATE: env.STATE });
  assert.equal(noKey.status, 500);
  assert.match(await noKey.text(), /WAVESPEED_API_KEY/);
  console.log('✓ wavespeed proxy: キー付与・転送先の制限・未設定時のエラー');
}

// Runware プロキシ: 転送先の制限とキー付与。投入も結果取得も同じ URL への
// POST なので、GET は受け付けない
async function testRunwareProxy() {
  const mod = await loadWorker();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization, body: init?.body });
    return new Response(JSON.stringify({ data: [{ taskType: 'imageInference', taskUUID: 'task-1' }] }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  const env = { RUNWARE_API_KEY: 'rw_test', STATE: { idFromName: (n) => n, get: () => ({}) } };
  const call = (target, init) => mod.default.fetch(
    new Request(`https://app.example/api/runware/proxy?url=${encodeURIComponent(target)}`, init), env);
  const post = (target, body) => call(target,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  const body = '[{"taskType":"imageInference","taskUUID":"task-1"}]';
  const ok = await post('https://api.runware.ai/v1', body);
  assert.equal(ok.status, 200);
  assert.equal(calls[0].auth, 'Bearer rw_test', 'API キーが付いていない');
  assert.equal(calls[0].body, body, '本文がそのまま渡っていない');
  assert.deepEqual((await ok.json()).data[0].taskUUID, 'task-1');

  // 別ホストへの転送は拒否する（プロキシを踏み台にさせない）
  assert.equal((await post('https://example.com/v1', body)).status, 403);
  assert.equal((await post('http://api.runware.ai/v1', body)).status, 403);
  // GET は使わない（結果取得も POST の getResponse タスク）
  assert.equal((await call('https://api.runware.ai/v1')).status, 405);

  // キー未設定なら理由の分かるエラー
  const noKey = await mod.default.fetch(
    new Request('https://app.example/api/runware/proxy?url=' + encodeURIComponent('https://api.runware.ai/v1'),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
    { STATE: env.STATE });
  assert.equal(noKey.status, 500);
  assert.match(await noKey.text(), /RUNWARE_API_KEY/);
  console.log('✓ runware proxy: キー付与・転送先の制限・POST 限定・未設定時のエラー');
}

// 画像のアップロード。replace 付きは同じキーへ上書きする
//（画像編集のマスクを塗り直すたびに合成画像が増えて残らないように）
async function testUploadReplace() {
  const mod = await loadWorker();
  const counters = { sub: 0 };
  const bucket = makeBucket(counters);
  const env = { IMAGES: bucket, STATE: { idFromName: (n) => n, get: () => ({}) } };
  // 1x1 の PNG
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const upload = (body) => mod.default.fetch(new Request('https://app.example/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  const first = await (await upload({ image: png })).json();
  assert.match(first.url, /^\/api\/image\/[0-9a-f]{32}$/, `初回の URL が不正: ${first.url}`);
  assert.equal(bucket.objects.size, 1);

  // replace 付きは新しいキーを作らず、URL には版が付く（immutable キャッシュ避け）
  const again = await (await upload({ image: png, replace: first.url })).json();
  assert.equal(bucket.objects.size, 1, '差し替えなのに画像が増えている');
  assert.equal(again.url.split('?')[0], first.url, '差し替え先が違う');
  assert.match(again.url, /\?v=\d+$/, 'キャッシュ避けの版が付いていない');

  // 版付きの URL をさらに差し替え先に渡しても同じキーを指す
  const third = await (await upload({ image: png, replace: again.url })).json();
  assert.equal(bucket.objects.size, 1);
  assert.equal(third.url.split('?')[0], first.url);

  // 他人の URL や壊れた指定は無視して新規作成にフォールバックする
  const other = await (await upload({ image: png, replace: 'https://evil.example/x' })).json();
  assert.equal(bucket.objects.size, 2);
  assert.notEqual(other.url, first.url);
  console.log('✓ upload: replace で同じ画像を上書きし、版付き URL を返す');
}

// 外部 CDN の画像の取り込み。履歴に載っている URL だけを通す（踏み台防止）
async function testCaptureEndpoint() {
  const mod = await loadWorker();
  const counters = { sub: 0 };
  const bucket = makeBucket(counters);
  const history = [{
    id: 'r1',
    images: [{ url: 'https://cdn.example.com/a.png' }, { url: '/api/image/' + 'a'.repeat(32) }],
  }];
  const fetched = [];
  globalThis.fetch = async (u) => {
    fetched.push(String(u));
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
  };
  const env = {
    IMAGES: bucket,
    STATE: { idFromName: (n) => n, get: () => ({ listHistory: async () => history }) },
  };
  const call = (body) => mod.default.fetch(new Request('https://app.example/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  const ok = await call({ url: 'https://cdn.example.com/a.png' });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).url, /^\/api\/image\/[0-9a-f]{32}$/);
  assert.equal(bucket.objects.size, 1, 'R2 に取り込まれていない');
  assert.equal(fetched.length, 1);

  // 履歴に無い URL は取り込まない（任意の URL を取りに行かせない）
  assert.equal((await call({ url: 'https://cdn.example.com/other.png' })).status, 403);
  assert.equal((await call({ url: 'http://cdn.example.com/a.png' })).status, 403);
  assert.equal((await call({ url: 'not a url' })).status, 422);
  assert.equal(fetched.length, 1, '拒否したはずの URL を取りに行っている');
  console.log('✓ capture: 履歴にある外部画像だけを R2 へ取り込む');
}

await testCheckpoint();
await testLoraSingleRun();
await testRetryDuringUpload();
await testStallSupervision();
await testResumeAfterLostAlarm();
await testResolveHang();
await testSharedBudget();
await testNewJobNotStarved();
await testNoResurrection();
await testListAndCancel();
await testStuckPastAlarm();
await testLoraMetaEndpoint();
await testWavespeedProxy();
await testRunwareProxy();
await testUploadReplace();
await testCaptureEndpoint();
rmSync(OUT, { force: true });
console.log('\nすべて成功');
