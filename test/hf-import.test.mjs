// Hugging Face 一括登録（hf-import.js）の単体テスト:  node test/hf-import.test.mjs
//
// ブラウザ用の IIFE をそのまま Node の vm で走らせ、window / document だけ
// 差し替える。DOM 無しで確かめられるのはベースモデルの候補づくりだけだが、
// ここがこのダイアログで一番静かに壊れる場所なので押さえておく。
//
// 壊れ方: <select> は一致する option が無い値を代入されると空へ落ちる。
// 候補に無いベースモデルが選択中だと、黙って「指定しない」が選ばれた状態になり、
// そのまま登録するとベースモデル**無し**で入る。ベース無しの LoRA は
// loraLib.forBase() のどの絞り込みにも引っかからないので、登録したのに
// どのモデルの候補にも出てこない。エラーは出ない。
//
// 実際 Qwen-Image 2.1 を足したときにこれを踏んだ（候補は krea2 / qwen / wan の
// 3 つ固定で、qwen21 が無かった）。
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

function loadHfImport() {
  // hf-import.js は読み込み時に DOM を触らない（init まで遅延する）ので、
  // window だけあれば評価できる。ベースモデルの一覧は loraLib が持つので、
  // 本体と同じ順で先に読み込む
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const sandbox = { console, localStorage, DOMException };
  sandbox.window = sandbox;
  createContext(sandbox);
  for (const file of ['../store.js', '../lora-library.js', '../hf-import.js']) {
    runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), sandbox);
  }
  return sandbox.hfImport;
}

const hfImport = loadHfImport();
let failed = 0;
let passed = 0;

function check(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
    console.log(`✓ ${name}`);
  } catch {
    failed += 1;
    console.error(`✗ ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  }
}

function checkIncludes(name, list, want) {
  try {
    assert.ok(list.includes(want), `${JSON.stringify(list)} に ${want} が無い`);
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}\n  ${err.message}`);
  }
}

/* ---- 既定の候補 ---- */

const defaults = hfImport.baseKinds(null);
checkIncludes('Krea 2 が候補にある', defaults, 'krea2');
checkIncludes('Qwen（画像編集）が候補にある', defaults, 'qwen');
checkIncludes('Wan が候補にある', defaults, 'wan');
// Qwen-Image 2.1 は Qwen-Image（20B）と別アーキテクチャで LoRA に互換が無い。
// 候補に無いと、2.1 を選んだ状態で登録してもベース無しで入ってしまう
checkIncludes('Qwen-Image 2.1 が候補にある', defaults, 'qwen21');

/* ---- 選択中の種類は必ず候補に含まれる ---- */

for (const kind of defaults) {
  checkIncludes(`選択中の ${kind} は候補に残る`, hfImport.baseKinds(kind), kind);
}

// 将来ベースモデルを足したときに、BASE_KINDS への追加を忘れても
// 「指定しない」へ黙って落ちないこと
checkIncludes(
  '候補に無い種類が選択中でも補われる',
  hfImport.baseKinds('brand_new_base'),
  'brand_new_base',
);
check(
  '補うのは末尾だけで、既定の候補は消えない',
  hfImport.baseKinds('brand_new_base').slice(0, defaults.length),
  defaults,
);

/* ---- 余計な重複を作らない ---- */

check('既知の種類を渡しても候補は増えない', hfImport.baseKinds('qwen21').length, defaults.length);
check('null / 空文字はそのまま既定', hfImport.baseKinds(''), defaults);

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log(`\nok: ${passed} checks passed`);
