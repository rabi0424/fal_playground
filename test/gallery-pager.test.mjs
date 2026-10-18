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
//   - サーバーから続きのページが届いたら、作り直さずに後ろへ足すこと
//   - 末尾に居たまま続きが届いても止まらないこと（番人が見えっぱなしだと
//     IntersectionObserver は「変化」が無いので知らせてこない。以前はここで途切れ、
//     少し戻ってスクロールし直すと続きが出ていた）
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

// 観測対象と、テストから叩くための発火口を持つ。
// 本物と同じく、**新しく observe() した要素はそのときの見え方を 1 回知らせる**
// （非同期なので flush() で配る）。見えっぱなしの要素は、それ以外では知らせない
function makeIo() {
  const observed = new Set();
  let fire = () => {};
  let pending = false;
  const state = { visible: false }; // 番人が画面（+ rootMargin）内にあるか
  class IntersectionObserver {
    constructor(cb) { this.cb = cb; fire = () => this.cb([{ isIntersecting: true }]); }
    observe(el) {
      if (!observed.has(el)) pending = true;
      observed.add(el);
    }
    unobserve(el) { observed.delete(el); }
  }
  // observe() 直後の初回通知を配る（見えていれば isIntersecting: true）
  const flush = () => {
    if (!pending) return false;
    pending = false;
    if (state.visible && observed.size > 0) fire();
    return true;
  };
  return { IntersectionObserver, observed, fire: () => fire(), flush, state };
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

function setup(count, withIo = true, opts = {}) {
  const { falGallery, io } = load(withIo);
  const container = new El('div');
  const built = [];
  const pager = falGallery.create(container, (record) => {
    built.push(record.id);
    const el = new El('div');
    el.id = record.id;
    return el;
  }, opts);
  const list = records(count);
  pager.render(list);
  return { pager, container, io, built, list };
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

test('続きのページが届いたら、作り直さずに 1 ページぶん足す', () => {
  let asked = 0;
  const { pager, container, io, built, list } = setup(60, true, { onNeedMore: () => { asked += 1; } });
  pager.setHasMore(true);
  io.fire(); // 30 → 60
  const before = container.children.slice(0, 60);
  io.fire(); // 手元は出し切った → 続きを頼む
  assert.equal(asked, 1);

  // 呼び出し側は同じ配列の後ろに足して render し直す（app.js / edit.js の loadMoreHistory）
  const more = [...list, ...records(120).slice(60)];
  pager.render(more);
  pager.setHasMore(true);
  assert.equal(shownIds(container).length, 90, '届いたぶんが並んでいません（次にスクロールするまで出ない）');
  assert.ok(before.every((el, i) => container.children[i] === el), '並んでいたカードを作り直しています（サムネが読み込み直しになる）');
  assert.equal(built.length, 90);
  assert.equal(new Set(built).size, 90);
});

test('末尾に居たまま続きが届いても、そこで止まらない', () => {
  let asked = 0;
  const { pager, container, io, list } = setup(30, true, { onNeedMore: () => { asked += 1; } });
  pager.setHasMore(true);
  io.flush();
  io.state.visible = true; // ユーザーは一番下に居て、番人が見えっぱなし
  io.fire(); // 手元は 30 件で出し切っている → 続きを頼む
  assert.equal(asked, 1);

  // 小さいページが届いて、足しても番人がまだ見えている（画面の高さが足りない）
  pager.render([...list, ...records(40).slice(30)]);
  pager.setHasMore(true);
  assert.equal(shownIds(container).length, 40);
  // 見えっぱなしでも、足したあとに見え方を確かめ直して続きを頼む
  while (io.flush()) { /* 初回通知を配り切る */ }
  assert.equal(asked, 2, '番人が見えたままなのに続きを頼んでいません（ここで途切れる）');
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
