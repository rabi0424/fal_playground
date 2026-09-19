// 横スワイプでの画像送りのテスト:  node test/swipe-nav.test.mjs
//
// swipe-nav.js はブラウザ用の IIFE なので、必要なぶんだけの DOM を用意して読み込む。
// 見るのは:
//   - 横に払ったら、その向きで送られること（左へ払う = +1 / 右へ払う = -1）
//   - 指が動いている間に決まること。指を離すのを待たないので、ブラウザが途中で
//     スクロールとして引き取っても（touchend が来ず touchcancel だけ）送られる
//   - 1 回の指の動きで送るのは 1 つだけであること
//   - 縦向きの動き・小さな動きでは送らないこと（ページのスクロールとタップを邪魔しない）
//   - from を渡したときは、その選択子に載った指だけ拾うこと
//   - enabled() が false の間は送らないこと（拡大表示のズーム中など）
//   - 送った直後の click 1 回ぶんだけ swiped() が true になること
//     （見ないと、送った先で拡大表示が開いてしまう）
//   - 2 本指（ピンチ）は送らないこと
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const SRC = readFileSync(new URL('../swipe-nav.js', import.meta.url), 'utf8');

/* ---- 最小の DOM ---- */

class El {
  constructor(tag = 'div', matches = []) {
    this.tag = tag;
    this.listeners = new Map();
    // closest() が真を返す選択子。'img' などをそのまま並べておく
    this.matchesSelectors = new Set(matches);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  closest(sel) {
    return this.matchesSelectors.has(sel) ? this : null;
  }

  fire(type, ev = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

function setup(opts = {}, clock = Date) {
  const el = new El();
  const window = {};
  new Function('window', 'Date', 'Math', SRC)(window, clock, Math);
  const moves = [];
  const swipe = window.falSwipe.attach(el, { onSwipe: (dir) => moves.push(dir), ...opts });
  return { el, swipe, moves };
}

// 1 回ぶんのスワイプ（触って、なぞって、離す）。target は指が載った要素。
// 実機と同じく、始点から終点まで何回かに分けて動かす
function drag(el, { from = [0, 0], to = [0, 0], target = el, steps = 4, end = 'touchend' } = {}) {
  el.fire('touchstart', { touches: [{ clientX: from[0], clientY: from[1] }], target });
  for (let i = 1; i <= steps; i++) {
    const at = (a, b) => a + ((b - a) * i) / steps;
    el.fire('touchmove', { touches: [{ clientX: at(from[0], to[0]), clientY: at(from[1], to[1]) }] });
  }
  if (end) el.fire(end, { changedTouches: [{ clientX: to[0], clientY: to[1] }] });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('横に払うと、その向きで送られる', () => {
  const { el, moves } = setup();
  drag(el, { from: [300, 200], to: [200, 210] }); // 左へ 100
  assert.deepEqual(moves, [1], '左へ払っても次へ送られない');
  drag(el, { from: [200, 200], to: [300, 190] }); // 右へ 100
  assert.deepEqual(moves, [1, -1], '右へ払っても前へ送られない');
});

test('縦向きの動き・小さな動きでは送らない', () => {
  const { el, moves } = setup();
  drag(el, { from: [200, 400], to: [250, 100] }); // 縦が主（スクロール）
  drag(el, { from: [200, 200], to: [230, 200] }); // 40px 未満（タップの震え）
  drag(el, { from: [200, 200], to: [200, 200] }); // 動かさない（タップ）
  assert.deepEqual(moves, [], 'スクロールやタップまで画像送りになっている');
});

test('from を渡すと、その選択子に載った指だけ拾う', () => {
  const { el, moves } = setup({ from: 'img' });
  const img = new El('img', ['img']);
  const text = new El('div');
  drag(el, { from: [300, 200], to: [200, 200], target: text });
  assert.deepEqual(moves, [], '画像以外に載った指まで拾っている');
  drag(el, { from: [300, 200], to: [200, 200], target: img });
  assert.deepEqual(moves, [1], '画像に載った指を拾えていない');
});

test('enabled() が false の間は送らない（ズーム中など）', () => {
  let on = false;
  const { el, moves } = setup({ enabled: () => on });
  drag(el, { from: [300, 200], to: [200, 200] });
  assert.deepEqual(moves, [], '見送るはずの間も送っている');
  on = true;
  drag(el, { from: [300, 200], to: [200, 200] });
  assert.deepEqual(moves, [1], '戻しても送られない');
});

test('送った直後の click 1 回ぶんだけ swiped() が true になる', () => {
  const { el, swipe } = setup();
  assert.equal(swipe.swiped(), false, 'まだ何もしていないのに true');
  drag(el, { from: [300, 200], to: [200, 200] });
  assert.equal(swipe.swiped(), true, '指を離した位置の click を捨てられない（送った先で開いてしまう）');
  assert.equal(swipe.swiped(), false, '次の click まで捨ててしまう');
});

test('払い切ったあと指を止めていても、離したときの click を捨てられる', () => {
  let now = 1_000;
  const { el, swipe } = setup({}, { now: () => now });
  el.fire('touchstart', { touches: [{ clientX: 300, clientY: 200 }], target: el });
  el.fire('touchmove', { touches: [{ clientX: 200, clientY: 200 }] }); // ここで送られる
  now += 3_000; // 指をしばらく置いたまま
  el.fire('touchend', { changedTouches: [{ clientX: 200, clientY: 200 }] });
  assert.equal(swipe.swiped(), true, '猶予を送った時刻から数えていて、離すころには切れている');
});

test('送ったあと終わりの合図が来なくても、次のタップは捨てない', () => {
  // 送った先で描き直すと、触っていた画像ごと入れ替わって touchend が
  // 入れ物まで上がってこないことがある。それで「送った」の印が残ると、
  // 次にタップしても拡大表示が開かなくなる
  let now = 1_000;
  const { el, swipe } = setup({}, { now: () => now });
  el.fire('touchstart', { touches: [{ clientX: 300, clientY: 200 }], target: el });
  el.fire('touchmove', { touches: [{ clientX: 200, clientY: 200 }] }); // 送る
  assert.equal(swipe.swiped(), true);
  now += 5_000; // touchend は来ないまま、しばらくして次のタップ

  el.fire('touchstart', { touches: [{ clientX: 150, clientY: 200 }], target: el });
  el.fire('touchend', { changedTouches: [{ clientX: 150, clientY: 200 }] });
  assert.equal(swipe.swiped(), false, 'ふつうのタップが捨てられている（拡大表示が開かない）');
});

test('送らなかった指の動きでは swiped() は true にならない', () => {
  const { el, swipe } = setup();
  drag(el, { from: [200, 200], to: [210, 300] }); // 縦向き
  assert.equal(swipe.swiped(), false, 'ふつうのタップまで捨ててしまう');
});

test('指を離す前に決まる（離さなくても送られる）', () => {
  const { el, moves } = setup();
  drag(el, { from: [300, 200], to: [200, 200], end: null });
  assert.deepEqual(moves, [1], '指を離すまで送られない（スクロールに取られると何も起きない）');
});

test('スクロールに取られても（touchcancel だけ）送られる', () => {
  const { el, moves } = setup();
  drag(el, { from: [300, 200], to: [200, 205], end: 'touchcancel' });
  assert.deepEqual(moves, [1], 'touchend が来ないと送られない');
});

test('1 回の指の動きで送るのは 1 つだけ', () => {
  const { el, moves } = setup();
  drag(el, { from: [340, 200], to: [40, 200], steps: 10 }); // 大きく払う
  assert.deepEqual(moves, [1], `なぞった回数だけ送っている: ${moves.join(',')}`);
});

test('縦へ抜けたあとに横へ戻ってきても送らない（スクロール中の指）', () => {
  const { el, moves } = setup();
  el.fire('touchstart', { touches: [{ clientX: 200, clientY: 200 }], target: el });
  el.fire('touchmove', { touches: [{ clientX: 205, clientY: 300 }] }); // 縦へ
  el.fire('touchmove', { touches: [{ clientX: 60, clientY: 320 }] }); // そこから横へ
  el.fire('touchend', { changedTouches: [{ clientX: 60, clientY: 320 }] });
  assert.deepEqual(moves, [], 'スクロールしている指で画像が送られている');
});

test('2 本指（ピンチ）は送らない', () => {
  const { el, moves } = setup();
  // 最初から 2 本
  el.fire('touchstart', { touches: [{ clientX: 300, clientY: 200 }, { clientX: 320, clientY: 210 }], target: el });
  el.fire('touchend', { changedTouches: [{ clientX: 200, clientY: 200 }] });
  assert.deepEqual(moves, [], 'ピンチの開始で送っている');

  // 1 本で始めて、横へ払い切る前に 2 本になった
  el.fire('touchstart', { touches: [{ clientX: 300, clientY: 200 }], target: el });
  el.fire('touchmove', { touches: [{ clientX: 280, clientY: 200 }, { clientX: 320, clientY: 210 }] });
  el.fire('touchmove', { touches: [{ clientX: 200, clientY: 200 }] });
  el.fire('touchend', { changedTouches: [{ clientX: 200, clientY: 200 }] });
  assert.deepEqual(moves, [], 'ピンチの途中で送っている');
});

test('指を離したあとの動きは拾わない', () => {
  const { el, moves } = setup();
  el.fire('touchstart', { touches: [{ clientX: 300, clientY: 200 }], target: el });
  el.fire('touchend', { changedTouches: [{ clientX: 300, clientY: 200 }] });
  el.fire('touchmove', { touches: [{ clientX: 200, clientY: 200 }] }); // 次の指の前触れ
  assert.deepEqual(moves, [], '離したあとの動きで送っている');
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
