// ギャラリーの分割描画のテスト:  node test/gallery-pager.test.mjs
//
// gallery-pager.js はブラウザ用の IIFE なので、必要なぶんだけの DOM と
// IntersectionObserver を用意して読み込む。見るのは:
//   - 最初は 1 ページぶんしか並べないこと（履歴 1000 件でも開くのが軽い理由）
//   - 末尾が見えるたびに 1 ページずつ足すこと
//   - 並べた件数が描き直しをまたいで保たれること
//     （下までスクロールしてからサムネを選んでも先頭に戻らない）
//   - reset() で先頭 1 ページぶんに戻ること（絞り込みが変わったとき）
//   - ensure() で未描画の位置まで広げられること（キーでの前後移動）
//   - IntersectionObserver が無い環境では全件並べること（従来どおり）
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const SRC = readFileSync(new URL('../gallery-pager.js', import.meta.url), 'utf8');

/* ---- 最小の DOM ---- */

class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.attrs = {};
  }

  appendChild(node) {
    // DocumentFragment は中身だけを移す（本物と同じ）
    const nodes = node.tag === '#fragment' ? node.children.splice(0) : [node];
    for (const n of nodes) {
      n.parentNode?.removeChild(n);
      n.parentNode = this;
      this.children.push(n);
    }
    return node;
  }

  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i !== -1) this.children.splice(i, 1);
    node.parentNode = null;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(k, v) {
    this.attrs[k] = v;
  }

  set innerHTML(v) {
    assert.equal(v, '', 'このスタブは innerHTML の代入で空にする用途だけを想定しています');
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }
}

const document = {
  createElement: (tag) => new El(tag),
  createDocumentFragment: () => new El('#fragment'),
};

// 観測対象と、テストから叩くための発火口だけを持つ
function makeIo() {
  const observed = new Set();
  let fire = () => {};
  class IntersectionObserver {
    constructor(cb) { this.cb = cb; fire = () => this.cb([{ isIntersecting: true }]); }
    observe(el) { observed.add(el); }
    unobserve(el) { observed.delete(el); }
  }
  return { IntersectionObserver, observed, fire: () => fire() };
}

function load(withIo = true) {
  const io = makeIo();
  const window = withIo ? { IntersectionObserver: io.IntersectionObserver } : {};
  // ブラウザではグローバルにも居るので、同じ形で渡す
  new Function('window', 'document', 'IntersectionObserver', SRC)(
    window, document, io.IntersectionObserver,
  );
  return { falGallery: window.falGallery, io };
}

const records = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

// 番人を除いた、並んでいる履歴の数
function shownIds(container) {
  return container.children.filter((c) => c.className !== 'gallery-sentinel').map((c) => c.id);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function setup(count, withIo = true) {
  const { falGallery, io } = load(withIo);
  const container = new El('div');
  const built = [];
  const pager = falGallery.create(container, (record) => {
    built.push(record.id);
    const el = new El('div');
    el.id = record.id;
    return el;
  });
  pager.render(records(count));
  return { pager, container, io, built };
}

test('最初は 1 ページぶん（30 件）だけ並べる', () => {
  const { container, built } = setup(100);
  assert.equal(shownIds(container).length, 30);
  assert.equal(built.length, 30, '見えないぶんまで要素を作っています');
  assert.deepEqual(shownIds(container).slice(0, 2), ['r0', 'r1']);
});

test('番人は末尾にあり、残りが無くなると消える', () => {
  const { container, io } = setup(45);
  assert.equal(container.children.at(-1).className, 'gallery-sentinel');
  assert.equal(io.observed.size, 1);

  io.fire(); // 末尾が見えた
  assert.equal(shownIds(container).length, 45);
  assert.equal(container.children.at(-1).className, '', '出し切ったのに番人が残っています');
  assert.equal(io.observed.size, 0);
});

test('末尾が見えるたびに 1 ページずつ足す', () => {
  const { container, io, built } = setup(100);
  io.fire();
  assert.equal(shownIds(container).length, 60);
  io.fire();
  assert.equal(shownIds(container).length, 90);
  // 足したぶんだけを作り直す（並んでいるものは作り直さない）
  assert.equal(built.length, 90);
  assert.equal(new Set(built).size, 90);
  // 番人はそのつど末尾へ動く
  assert.equal(container.children.at(-1).className, 'gallery-sentinel');
});

test('描き直しても、広げた件数は保たれる', () => {
  const { pager, container, io } = setup(100);
  io.fire();
  assert.equal(shownIds(container).length, 60);

  pager.render(records(100)); // サムネを選んだときなどの描き直し
  assert.equal(shownIds(container).length, 60, '描き直しで先頭に戻っています');

  pager.reset(); // 絞り込みが変わった
  pager.render(records(100));
  assert.equal(shownIds(container).length, 30);
});

test('件数が減ったら、その件数までしか並べない', () => {
  const { pager, container, io } = setup(100);
  io.fire();
  pager.render(records(10));
  assert.equal(shownIds(container).length, 10);
  assert.equal(container.children.length, 10, '番人が残っています');
});

test('ensure() は未描画の位置まで広げ、範囲外は何もしない', () => {
  const { pager, container } = setup(100);
  pager.ensure(70);
  assert.equal(shownIds(container).length, 71);
  pager.ensure(5); // すでに並んでいる
  assert.equal(shownIds(container).length, 71);
  pager.ensure(999); // 範囲外
  assert.equal(shownIds(container).length, 71);
});

test('clear() は空にする', () => {
  const { pager, container } = setup(100);
  pager.clear();
  assert.equal(container.children.length, 0);
});

test('IntersectionObserver が無い環境では全件並べる', () => {
  const { container } = setup(100, false);
  assert.equal(shownIds(container).length, 100);
  assert.equal(container.children.length, 100, '番人を置いています');
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
console.log(failed === 0 ? '\nすべて成功' : `\n${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
