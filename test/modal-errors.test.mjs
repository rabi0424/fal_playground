// Modal 系エラーの日本語化（modal-errors.js）の単体テスト:
//   node test/modal-errors.test.mjs
//
// ブラウザ用の IIFE をそのまま Node の vm で走らせ、window だけ差し替える。
// 見るのは「画面に出る文字列が日本語になっていること」と「原文が detail に
// 残ること」の 2 点。英語の本文をそのまま出していたのが元の不具合なので、
// 実際にサーバーから返ってくる形（FastAPI の {"detail": ...} や、Durable
// Object が残す `Modal API error 503: ...`）で確かめる。
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

function load() {
  // console.warn は原文を開発者向けに出すためのもの。テストでは捨てる
  const sandbox = { console: { ...console, warn() {} } };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(new URL('../modal-errors.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.window.modalErrors;
}

const ja = /[ぁ-んァ-ヶ一-龯]/;

test('コンテナの準備に失敗した 503 を日本語にし、原文を detail に残す', () => {
  const m = load();
  const body = JSON.stringify({
    detail: 'ComfyUI is not running in this container and the relaunch attempt failed. '
      + 'check the Modal logs for the launch error, the [relaunch] lines and the [versions] line.',
  });
  const d = m.describe(503, body);
  assert.match(d.message, /サーバーの準備に失敗しました/);
  assert.match(d.message, /もう一度お試しください/);
  // 原文は捨てない（調査に要る）。JSON の波括弧ごとではなく detail の中身
  assert.match(d.detail, /ComfyUI is not running/);
  assert.ok(!d.detail.startsWith('{'));
});

test('proxy auth と未デプロイを取り違えない', () => {
  const m = load();
  assert.match(
    m.describe(401, 'modal-http: missing credentials for proxy authorization').message,
    /認証に失敗/,
  );
  assert.match(
    m.describe(404, 'modal-http: invalid function call').message,
    /エンドポイントが見つかりません/,
  );
});

test('入力の不備は、何を直せばよいかが分かる文言になる', () => {
  const m = load();
  const cases = [
    [422, "{\"detail\":\"'steps' must be between 1 and 100\"}", /ステップ数/],
    [422, '{"detail":"too many loras: 20 (max 16)"}', /LoRA の数/],
    [422, 'images must be 16 or fewer', /参照画像の枚数/],
    [422, '{"detail":"resolution 8192x8192 exceeds the 4096px limit per side"}', /画像サイズ/],
    [404, "{\"detail\":\"lora 'nope.safetensors' not found in volume. available: []\"}", /LoRA/],
    [422, 'prompt is required', /プロンプト/],
  ];
  for (const [status, body, expected] of cases) {
    const d = m.describe(status, body);
    assert.match(d.message, expected, body);
    assert.match(d.message, ja, `日本語になっていない: ${d.message}`);
  }
});

test('Durable Object が残した job.error からステータスを読み取る', () => {
  const m = load();
  const d = m.describeText('Modal API error 504: {"detail":"generation timed out"}');
  assert.equal(d.status, 504);
  assert.match(d.message, /時間内に/);
});

test('Worker が日本語で返しているものは、そのまま活かす', () => {
  const m = load();
  const d = m.describeText('入力画像が見つかりませんでした（アップロードからやり直してください）');
  assert.match(d.message, /入力画像が見つかりませんでした/);
});

test('未知のエラーでも英語を素通しせず、ステータスで説明する', () => {
  const m = load();
  const d = m.describe(500, 'something went terribly wrong');
  assert.match(d.message, ja);
  assert.match(d.detail, /terribly/);       // 原文は残る

  // 本文も無いとき
  assert.match(m.describe(418, '').message, /HTTP 418/);
  assert.match(m.describe(null, '').message, ja);
});

test('toError は表示用の Error にして status と detail を持たせる', () => {
  const m = load();
  const err = m.toError(502, '{"detail":"ComfyUI rejected workflow: bad node"}');
  // vm の中で作られるので host 側の Error とは別コンストラクタ。名前で見る
  assert.equal(err.constructor.name, 'Error');
  assert.match(err.message, /受け付けませんでした/);
  assert.equal(err.status, 502);
  assert.match(err.detail, /rejected workflow/);
});
