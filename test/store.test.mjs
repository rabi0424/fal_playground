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

console.log(`ok: ${passed} checks passed`);
