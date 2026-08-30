// localStorage のラッパー（store.js）の単体テスト:  node test/store.test.mjs
//
// 見るのは「容量あふれで例外を外へ出さない」こと。素の setItem を呼んでいた頃は、
// 満杯の端末で生成の途中（送信済みジョブの控えを書くところ）に例外が飛び、
// fal 側では成功しているのに結果を取り逃がして
// "The quota has been exceeded." だけが表示されていた。
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

// limit は「書ける合計文字数」。超える setItem は Safari と同じ例外を投げる
function loadStore(initial = {}, limit = Infinity) {
  const store = { ...initial };
  const used = () => Object.values(store).reduce((n, v) => n + v.length, 0);
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      const next = used() - (store[k]?.length ?? 0) + String(v).length;
      if (next > limit) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      store[k] = String(v);
    },
    removeItem: (k) => { delete store[k]; },
  };
  const sandbox = { localStorage, console, DOMException };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(new URL('../store.js', import.meta.url), 'utf8'), sandbox);
  return { falStore: sandbox.falStore, store };
}

let passed = 0;
const check = (label, actual, expected) => {
  assert.deepEqual(actual, expected, label);
  passed++;
};

/* ---- 普通に書ける場合 ---- */
{
  const { falStore, store } = loadStore();
  check('書けたら true', falStore.set('fal_form_state', 'abc'), true);
  check('中身が入る', store.fal_form_state, 'abc');
  check('読み戻せる', falStore.get('fal_form_state'), 'abc');
  falStore.remove('fal_form_state');
  check('消せる', falStore.get('fal_form_state'), null);
}

/* ---- 容量あふれ: 捨ててよいキャッシュを落として書き直す ---- */
{
  // 表示キャッシュで埋まっていて、控えを書く余地がない状態
  const { falStore, store } = loadStore({ fal_history: 'h'.repeat(100) }, 100);
  check('あふれても例外は出ず、書けたら true', falStore.set('fal_active_job', 'job'), true);
  check('控えは入った', store.fal_active_job, 'job');
  check('表示キャッシュのほうを捨てた', 'fal_history' in store, false);
}

/* ---- 容量あふれ: 空けても入らなければ false（例外は出さない） ---- */
{
  const { falStore, store } = loadStore({ fal_history: 'h'.repeat(10) }, 10);
  check('入らなければ false', falStore.set('fal_active_job', 'x'.repeat(50)), false);
  check('生成を止めないので例外は出ない', 'fal_active_job' in store, false);
}

/* ---- 捨ててよいキャッシュ自身は、自分を消して場所を作ろうとしない ---- */
{
  const { falStore } = loadStore({ fal_history: 'h'.repeat(10) }, 10);
  check('自分自身は候補にしない', falStore.set('fal_history', 'x'.repeat(50)), false);
}

/* ---- 失うと困るものは、理由の分かる例外にする ---- */
{
  const { falStore } = loadStore({}, 0);
  let message = '';
  try {
    falStore.setOrThrow('fal_lora_library', '[]');
  } catch (err) {
    message = err.message;
  }
  check('日本語で理由を伝える', message.includes('保存領域がいっぱい'), true);
  check('英語の DOMException のままにしない', message.includes('quota'), false);
}

/* ---- ストレージごと使えない環境でも落ちない ---- */
{
  const sandbox = {
    console,
    DOMException,
    localStorage: {
      getItem() { throw new Error('storage disabled'); },
      setItem() { throw new Error('storage disabled'); },
      removeItem() { throw new Error('storage disabled'); },
    },
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(new URL('../store.js', import.meta.url), 'utf8'), sandbox);
  check('書けないが例外は出ない', sandbox.falStore.set('fal_form_state', 'x'), false);
  check('読めないときは null', sandbox.falStore.get('fal_form_state'), null);
  sandbox.falStore.remove('fal_form_state'); // 投げないことだけ確かめる
  passed++;
}

/* ---- 古い HTML の検出と復帰（falBoot.requireShared） ----
 *
 * _headers で HTML にもキャッシュの猶予があるので、デプロイ後しばらくは前の版の
 * HTML が出る。あとから足した共有スクリプトは古い HTML には script タグごと
 * 無いため、それを使うところだけが黙って壊れる（実際に、履歴の取得だけが失敗して
 * 表示キャッシュの 60 件しか出ない状態になった）。ここはその検出と復帰。
 */
function loadBoot({ present = [], search = '', hash = '', session = {} } = {}) {
  const replaced = [];
  const store = { ...session };
  const sandbox = {
    console: { error() {} },
    DOMException,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    location: {
      pathname: '/', search, hash,
      replace: (url) => replaced.push(url),
    },
    history: { replaceState: (_s, _t, url) => replaced.push(`replaceState:${url}`) },
  };
  for (const name of present) sandbox[name] = {};
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(new URL('../store.js', import.meta.url), 'utf8'), sandbox);
  return { falBoot: sandbox.falBoot, replaced, store };
}

{
  // 揃っていれば何もしない
  const ok = loadBoot({ present: ['falHistory', 'falUpload'] });
  check('揃っていれば true', ok.falBoot.requireShared(['falHistory', 'falUpload']), true);
  check('読み直さない', ok.replaced.length, 0);
}
{
  // 足りなければ、問い合わせを変えて 1 度だけ読み直す
  const stale = loadBoot({ present: ['falStoreOnly'], hash: '#stats' });
  check('足りなければ false', stale.falBoot.requireShared(['falHistory']), false);
  check('1 度だけ読み直す', stale.replaced.length, 1);
  check('キャッシュを迂回する問い合わせを付ける', /^\/\?r=\d+#stats$/.test(stale.replaced[0]), true);
  check('読み直した印を残す', stale.store.fal_stale_reload, '1');
}
{
  // 読み直しても直らなければ、繰り返さない（無限ループにしない）
  const again = loadBoot({ session: { fal_stale_reload: '1' } });
  check('2 度目は読み直さない', again.falBoot.requireShared(['falHistory']), false);
  check('読み直しは起きない', again.replaced.length, 0);
}
{
  // 直ったら、印と URL の細工を片付ける
  const healed = loadBoot({
    present: ['falHistory'], search: '?r=123', hash: '#x', session: { fal_stale_reload: '1' },
  });
  check('直れば true', healed.falBoot.requireShared(['falHistory']), true);
  check('印を消す', 'fal_stale_reload' in healed.store, false);
  check('URL を元に戻す', healed.replaced, ['replaceState:/#x']);
}

console.log(`ok: ${passed} checks passed`);
