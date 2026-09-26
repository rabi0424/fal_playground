// エンドポイント／モデル（チェックポイント）ライブラリの単体テスト:
//   node test/endpoint-library.test.mjs
//
// endpoint-library.js / ckpt-library.js をそのまま Node の vm で走らせ、
// localStorage だけ差し替える。見るのは★と非表示の並べ方と、
// 「いま選んでいるものは隠しても消えない」こと（黙って別のエンドポイントへ
// 切り替わると、気づかず別物を呼んでしまう）。
// あわせて、ライブラリ画面に並べる一覧（CATALOG）が各画面のプルダウンの
// 中身と食い違っていないかを、各画面のソースと突き合わせて確かめる。
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

const src = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

function load(store = {}) {
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const sandbox = { localStorage, console, DOMException, Intl };
  sandbox.window = sandbox;
  createContext(sandbox);
  for (const f of ['store.js', 'lora-library.js', 'ckpt-library.js', 'endpoint-library.js']) {
    runInContext(src(f), sandbox);
  }
  return { endpointLib: sandbox.endpointLib, ckptLib: sandbox.ckptLib, store };
}

let passed = 0;
// vm の中で作った配列は別の realm のものなので、JSON を通してこちらの値にしてから比べる
const eq = (label, actual, expected) => {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, label);
  passed++;
};

/* ---- エンドポイント: 並べ方 ---- */
{
  const { endpointLib, store } = load();
  let notified = 0;
  endpointLib.onChange = () => { notified++; };
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: '__custom__' }];
  const keyOf = (m) => (m.id === '__custom__' ? null : m.id);
  const ids = (opts) => endpointLib.arrange(list, keyOf, opts).map((m) => m.id);

  eq('印が無ければ元の並び', ids(), ['a', 'b', 'c', '__custom__']);

  endpointLib.setFav('c', true);
  eq('★ は先頭へ（カスタムは末尾のまま）', ids(), ['c', 'a', 'b', '__custom__']);

  endpointLib.setHidden('a', true);
  eq('非表示は外す', ids(), ['c', 'b', '__custom__']);
  eq('選んでいるものは非表示でも残す', ids({ keep: 'a' }), ['c', 'a', 'b', '__custom__']);
  eq('表示名に印が出る', endpointLib.optionLabel('a', 'A'), 'A（非表示）');
  eq('★の表示名', endpointLib.optionLabel('c', 'C'), '★ C');
  eq('カスタムは印の対象外', endpointLib.optionLabel(null, 'カスタム…'), 'カスタム…');

  endpointLib.setHiddenMany(['b', 'c'], true);
  eq('全部隠したら隠さずに出す（選びようがなくなるため）', ids(), ['a', 'b', 'c', '__custom__']);

  endpointLib.setHiddenMany(['a', 'b', 'c'], false);
  endpointLib.setFav('c', false);
  eq('外したら元に戻る', ids(), ['a', 'b', 'c', '__custom__']);
  eq('保存のたびに同期へ知らせる', notified > 0, true);
  eq('印の無い項目は key だけ残る', JSON.parse(store.fal_endpoint_prefs).every((i) => Object.keys(i).join() === 'key'), true);
  eq('変わらない操作は保存しない', endpointLib.setHiddenMany(['a'], false), 0);
}

/* ---- モデル（チェックポイント）: 系統・★・非表示 ---- */
{
  const store = {
    fal_ckpt_library: JSON.stringify([
      { path: 'https://x/b.gguf', name: 'b.gguf' },
      { path: 'https://x/a.gguf', name: 'a.gguf', base: 'krea2' },
      { path: 'https://x/q.gguf', name: 'q.gguf', base: 'qwen21' },
      { path: 'https://x/z.gguf', name: 'z.gguf', fav: true },
    ]),
  };
  const { ckptLib } = load(store);
  const paths = (base, opts) => ckptLib.forBase(base, opts).map((i) => i.path.slice(10));

  eq('base 無しは Krea 2 用。★ が先頭、あとは名前順', paths('krea2'), ['z.gguf', 'a.gguf', 'b.gguf']);
  eq('別系統は出さない', paths('qwen21'), ['q.gguf']);

  ckptLib.setHiddenMany(['https://x/a.gguf'], true);
  eq('非表示は外す', paths('krea2'), ['z.gguf', 'b.gguf']);
  eq('選んでいるものは残す', paths('krea2', { keep: 'https://x/a.gguf' }), ['z.gguf', 'a.gguf', 'b.gguf']);
  eq('登録済みの判定には非表示も含める', paths('krea2', { includeHidden: true }).length, 3);

  const items = ckptLib.load();
  items.find((i) => i.path === 'https://x/b.gguf').label = 'ベース版';
  ckptLib.save(items);
  eq('表示名は label を優先', ckptLib.label('https://x/b.gguf'), 'ベース版');
  eq('未登録はファイル名', ckptLib.label('https://x/new%20one.gguf'), 'new one.gguf');

  eq('登録は重複しない', ckptLib.register('https://x/a.gguf'), false);
  ckptLib.register('https://x/n.gguf', 'qwen21');
  eq('登録した系統で出る', paths('qwen21'), ['n.gguf', 'q.gguf']);
}

/* ---- CATALOG が各画面の選択肢を漏れなく持っているか ---- */
{
  const { endpointLib } = load();
  const catalog = new Map(endpointLib.catalog().map((e) => [e.key, e]));
  const idsIn = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
  const block = (text, start, endRe = /\n\];/) => {
    const from = text.indexOf(start);
    assert.ok(from >= 0, `${start} が見つからない`);
    const rest = text.slice(from);
    return rest.slice(0, rest.search(endRe));
  };

  const app = src('app.js');
  // MODELS は定数 ID（MODAL_…_ID）でも書かれているので、先に値へ置き換える
  const consts = Object.fromEntries(idsIn(app, /const (MODAL_\w+_ID) = '([^']+)'/g)
    .map((name) => [name, app.match(new RegExp(`const ${name} = '([^']+)'`))[1]]));
  const models = block(app, 'const MODELS = [');
  const generate = [
    ...idsIn(models, /\{ id: '([^']+)'/g),
    ...idsIn(models, /\{ id: (MODAL_\w+_ID)/g).map((n) => consts[n]),
  ].filter((id) => id !== '__custom__');
  const arena = idsIn(block(src('arena.js'), 'const ARENA_MODELS = ['), /\{ id: '([^']+)'/g)
    .filter((id) => id !== '__custom__');
  const imgedit = idsIn(block(src('imgedit.js'), 'const PROVIDERS = {', /\n\};/), /^ {2}(\w+): \{/gm)
    .map((id) => `imgedit:${id}`);
  const poe = idsIn(block(src('edit.js'), 'const BOTS = ['), /\{ id: '([^']+)'/g)
    .filter((id) => id !== '__custom__').map((id) => `poe:${id}`);

  for (const [screen, keys] of Object.entries({ generate, arena, imgedit, poe })) {
    assert.ok(keys.length > 0, `${screen} の選択肢が読めない`);
    for (const key of keys) {
      assert.ok(catalog.has(key), `endpoint-library.js の CATALOG に ${key}（${screen}）が無い`);
      assert.ok(catalog.get(key).screens.includes(screen), `${key} の screens に ${screen} が無い`);
      passed++;
    }
  }
  const all = new Set([...generate, ...arena, ...imgedit, ...poe]);
  for (const key of catalog.keys()) {
    assert.ok(all.has(key), `CATALOG の ${key} はどの画面にも無い（消し忘れ）`);
    passed++;
  }
}

console.log(`ok: ${passed} checks`);
