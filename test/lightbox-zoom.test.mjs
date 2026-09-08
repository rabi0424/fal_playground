// 拡大表示のズームのテスト:  node test/lightbox-zoom.test.mjs
//
// lightbox-zoom.js はブラウザ用の IIFE なので、必要なぶんだけの DOM を用意して
// 読み込む。見るのは:
//   - ダブルタップで拡大し、もう一度のダブルタップで等倍に戻ること
//   - 触った点がその場に留まるように寄ること（見たい所を押さえたまま拡大できる）
//   - シングルタップは、ダブルタップと見分けるために間を置いてから決まること
//     （等倍なら閉じる・ズーム中は等倍に戻すだけで閉じない）
//   - ドラッグはタップにならず、はみ出したぶんの中だけ動くこと
//   - 画像の上のタップは呼び出し側の「タップで閉じる」へ素通ししないこと
//     （素通しすると、ダブルタップの 1 回目で閉じてしまう）
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const SRC = readFileSync(new URL('../lightbox-zoom.js', import.meta.url), 'utf8');

/* ---- 最小の DOM ---- */

class El {
  constructor(tag) {
    this.tag = tag;
    this.style = {};
    this.classes = new Set();
    this.listeners = new Map();
    this.rect = { left: 0, top: 0, width: 0, height: 0 };
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)),
      contains: (c) => this.classes.has(c),
    };
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  getBoundingClientRect() {
    return this.rect;
  }

  // テストから叩く発火口。既定値は「画像の中央あたりを 1 本指で触った」形
  fire(type, ev = {}) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ clientX: 0, clientY: 0, pointerId: 1, ...ev });
    }
  }
}

// 画面 800x600 の中に、600x400 で表示されている画像
function setup() {
  const lightbox = new El('div');
  lightbox.clientWidth = 800;
  lightbox.clientHeight = 600;
  const img = new El('img');
  img.rect = { left: 100, top: 100, width: 600, height: 400 };
  lightbox.querySelector = () => img;

  const window = { addEventListener() {} };
  new Function('window', 'setTimeout', 'clearTimeout', 'Date', 'Math', SRC)(
    window, setTimeout, clearTimeout, Date, Math,
  );

  const taps = [];
  const zoom = window.falLightboxZoom.attach(lightbox, { onTap: () => taps.push(Date.now()) });
  return { lightbox, img, zoom, taps };
}

// 1 回ぶんのタップ（押して離す）
function tap(img, x, y) {
  img.fire('pointerdown', { clientX: x, clientY: y });
  img.fire('pointerup', { clientX: x, clientY: y });
}

// transform から平行移動と倍率を読む
function transform(img) {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(img.style.transform ?? '');
  return m ? { tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]) } : null;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TAP_WINDOW_MS = 260;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('ダブルタップで拡大し、もう一度で等倍に戻る', async () => {
  const { img, lightbox, zoom } = setup();
  const center = { x: 400, y: 300 }; // 画像の中心

  tap(img, center.x, center.y);
  tap(img, center.x, center.y);
  const zoomed = transform(img);
  assert.ok(zoomed, `拡大されていない: ${img.style.transform}`);
  assert.equal(zoomed.scale, 2.5);
  assert.equal(zoom.zoomed, true, 'ズーム中だと呼び出し側に伝わらない（スワイプが止まらない）');
  assert.ok(lightbox.classList.contains('zoomed'));

  tap(img, center.x, center.y);
  tap(img, center.x, center.y);
  assert.equal(transform(img), null, `等倍に戻っていない: ${img.style.transform}`);
  assert.equal(zoom.zoomed, false);
  assert.equal(lightbox.classList.contains('zoomed'), false);
});

test('触った点はその場に留まる（見たい所を押さえたまま寄れる）', async () => {
  const { img } = setup();
  // 画像の左上あたり（中心から見て左に 200・上に 100）を 2 回叩く
  const x = 200;
  const y = 200;
  tap(img, x, y);
  tap(img, x, y);

  const t = transform(img);
  // 中心は (400, 300)。拡大後もこの点が同じ場所に来る = 中心 + (点 - 中心) * s + t
  const after = { x: 400 + (x - 400) * t.scale + t.tx, y: 300 + (y - 300) * t.scale + t.ty };
  assert.ok(Math.abs(after.x - x) < 0.5, `横にずれている: ${after.x} ≠ ${x}`);
  assert.ok(Math.abs(after.y - y) < 0.5, `縦にずれている: ${after.y} ≠ ${y}`);
});

test('シングルタップは間を置いてから閉じる（ダブルタップと見分けるため）', async () => {
  const { img, taps } = setup();
  tap(img, 400, 300);
  assert.deepEqual(taps, [], 'ダブルタップの 1 回目で閉じてしまう');
  await wait(TAP_WINDOW_MS + 60);
  assert.equal(taps.length, 1, '間を置いても閉じない');
});

test('ズーム中のシングルタップは等倍に戻すだけで閉じない', async () => {
  const { img, taps, zoom } = setup();
  tap(img, 400, 300);
  tap(img, 400, 300); // 拡大
  assert.equal(zoom.zoomed, true);

  tap(img, 400, 300);
  await wait(TAP_WINDOW_MS + 60);
  assert.equal(zoom.zoomed, false, '等倍に戻っていない');
  assert.deepEqual(taps, [], '拡大を戻すつもりのタップで閉じてしまう');
});

test('ドラッグはタップにならず、はみ出したぶんの中だけ動く', async () => {
  const { img, taps } = setup();
  tap(img, 400, 300);
  tap(img, 400, 300); // 拡大（中心なので平行移動は 0）
  assert.deepEqual(transform(img), { tx: 0, ty: 0, scale: 2.5 });

  img.fire('pointerdown', { clientX: 400, clientY: 300 });
  img.fire('pointermove', { clientX: 500, clientY: 300 });
  img.fire('pointerup', { clientX: 500, clientY: 300 });
  assert.equal(transform(img).tx, 100, '指の動きに付いてこない');

  await wait(TAP_WINDOW_MS + 60);
  assert.deepEqual(taps, [], 'ドラッグがタップとして扱われている');

  // 600x400 を 2.5 倍 = 1500x1000。画面 800x600 からのはみ出しは左右 350・上下 200
  img.fire('pointerdown', { clientX: 0, clientY: 0 });
  img.fire('pointermove', { clientX: 5000, clientY: 5000 });
  img.fire('pointerup', { clientX: 5000, clientY: 5000 });
  const t = transform(img);
  assert.equal(t.tx, 350, `横に引っ張りすぎて余白が入る: ${t.tx}`);
  assert.equal(t.ty, 200, `縦に引っ張りすぎて余白が入る: ${t.ty}`);
});

test('画像のタップは呼び出し側の「タップで閉じる」へ素通ししない', async () => {
  const { img } = setup();
  let stopped = 0;
  img.fire('click', { stopPropagation: () => { stopped += 1; } });
  assert.equal(stopped, 1, 'click を止めていないと、ダブルタップの 1 回目で閉じてしまう');
});

test('reset() で等倍に戻る（画像を切り替えた / 閉じたとき）', async () => {
  const { img, zoom } = setup();
  tap(img, 400, 300);
  tap(img, 400, 300);
  assert.equal(zoom.zoomed, true);

  zoom.reset();
  assert.equal(zoom.zoomed, false);
  assert.equal(transform(img), null, `ズームが持ち越される: ${img.style.transform}`);
});

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
console.log(failed === 0 ? '\nすべて成功' : `\n${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
