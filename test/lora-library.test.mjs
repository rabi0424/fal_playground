// LoRA ライブラリ（lora-library.js）の単体テスト:  node test/lora-library.test.mjs
//
// ブラウザ用の IIFE をそのまま Node の vm で走らせ、window / localStorage だけ
// 差し替える。見るのは Modal 系 API へ渡す識別子（modalRef）の作り方で、
// ここを名前だけに落とすと「別のリポジトリから取り込んだ LoRA が
// lora '...' not found in volume で 404 になる」不具合に戻る。
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

// full: true にすると setItem が容量あふれの例外を投げる（満杯の端末の再現）
function loadLib(store = {}, { full = false } = {}) {
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      store[k] = String(v);
    },
    removeItem: (k) => { delete store[k]; },
  };
  const sandbox = { localStorage, console, DOMException };
  sandbox.window = sandbox;
  createContext(sandbox);
  // 保存は store.js（falStore）越しに行うので、本体と同じ順で読み込む
  runInContext(readFileSync(new URL('../store.js', import.meta.url), 'utf8'), sandbox);
  runInContext(readFileSync(new URL('../lora-library.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.loraLib;
}

const loraLib = loadLib();
let passed = 0;
const check = (label, actual, expected) => {
  assert.equal(actual, expected, label);
  passed++;
};

// 配列を比べる用（check は strictEqual なので参照が違うと落ちる）
const checkList = (label, actual, expected) => {
  assert.deepEqual(actual, expected, label);
  passed++;
};

/* ---- modalRef: HF の resolve URL はそのまま渡す ---- */

// 既定リポジトリのもの。名前に落としても動くが、URL のままでも同じ結果になる
check('resolve URL はそのまま',
  loraLib.modalRef('https://huggingface.co/tottie2215/temp_str/resolve/main/foo.safetensors'),
  'https://huggingface.co/tottie2215/temp_str/resolve/main/foo.safetensors');

// 別のリポジトリ。名前に落とすと Modal 側が既定リポジトリしか見ないので 404 になる
check('別リポジトリの resolve URL もそのまま',
  loraLib.modalRef('https://huggingface.co/someone/wan-loras/resolve/main/my_wan_lora.safetensors'),
  'https://huggingface.co/someone/wan-loras/resolve/main/my_wan_lora.safetensors');

// サブフォルダ。名前に落とすとフォルダが消えて hf_hub_download が 404 になる
check('サブフォルダ付きもそのまま',
  loraLib.modalRef('https://huggingface.co/owner/repo/resolve/main/FusionX_LoRa/x.safetensors'),
  'https://huggingface.co/owner/repo/resolve/main/FusionX_LoRa/x.safetensors');

// revision 指定と blob 形式も modal_comfy の HF_URL_RE が受け取る
check('main 以外の revision もそのまま',
  loraLib.modalRef('https://huggingface.co/owner/repo/resolve/v2/x.safetensors'),
  'https://huggingface.co/owner/repo/resolve/v2/x.safetensors');
check('blob 形式もそのまま',
  loraLib.modalRef('https://huggingface.co/owner/repo/blob/main/x.safetensors'),
  'https://huggingface.co/owner/repo/blob/main/x.safetensors');

// クエリ付き（?download=true）。modal_comfy 側が末尾のクエリを落とすので触らない
check('クエリ付きもそのまま',
  loraLib.modalRef('https://huggingface.co/owner/repo/resolve/main/x.safetensors?download=true'),
  'https://huggingface.co/owner/repo/resolve/main/x.safetensors?download=true');

/* ---- modalRef: URL でないものは名前として渡す ---- */

// 「名前を直接入力…」で打たれた素の名前
check('素の名前はそのまま名前',
  loraLib.modalRef('Shimizu_krea2_v1_000005000'), 'Shimizu_krea2_v1_000005000');
check('拡張子付きの名前は拡張子を落とす',
  loraLib.modalRef('Shimizu_krea2_v1.safetensors'), 'Shimizu_krea2_v1');
check('前後の空白は落とす', loraLib.modalRef('  my_lora  '), 'my_lora');

// huggingface.co でも resolve/blob でない URL は名前に落とす（渡しても解決できない）
check('resolve でない HF URL は名前へ',
  loraLib.modalRef('https://huggingface.co/owner/repo'), 'repo');

// HF 以外のホスト（Civitai の直リンクなど）も名前に落とす
check('HF 以外の URL は名前へ',
  loraLib.modalRef('https://civitai.com/api/download/models/12345'), '12345');

check('空はそのまま空', loraLib.modalRef(''), '');
check('null も空', loraLib.modalRef(null), '');

/* ---- fileName は表示用なので今までどおり ---- */

check('fileName はファイル名だけ',
  loraLib.fileName('https://huggingface.co/owner/repo/resolve/main/FusionX_LoRa/x.safetensors'), 'x');

/* ---- baseKind: Wan と Qwen を取り違えない ---- */

check('Wan Video 表記は wan', loraLib.baseKind('Wan Video 14B t2v'), 'wan');
check('Wan 2.2 表記は wan', loraLib.baseKind('Wan Video 2.2 I2V-A14B'), 'wan');
check('Qwen は qwen（wan を含まない）', loraLib.baseKind('Qwen-Image'), 'qwen');
// Qwen-Image 2.1 は別アーキテクチャなので、Qwen-Image 用 LoRA と同じ枠にしない
check('Qwen-Image 2.1 は qwen21', loraLib.baseKind('Qwen-Image 2.1'), 'qwen21');
check('区切り無しの qwen21 も qwen21', loraLib.baseKind('qwen21'), 'qwen21');
check('アンダースコア表記も qwen21', loraLib.baseKind('qwen_image_2_1'), 'qwen21');
// Qwen-Image Edit の版番号（2509 / 2511）を 2.1 と読み違えない
check('Qwen-Image Edit 2511 は qwen', loraLib.baseKind('Qwen-Image Edit 2511'), 'qwen');
check('Qwen-Image Edit 2509 は qwen', loraLib.baseKind('qwen-image-edit-2509'), 'qwen');
// wan を先に見るので、Wan 側の版番号に巻き込まれない
check('Wan 2.1 は wan', loraLib.baseKind('Wan Video 2.1 T2V'), 'wan');

/* ---- baseChoices: 選択中の値を絶対に落とさない ---- */
// <select> は一致する option が無い値を代入されると空へ落ちる。候補を作る側が
// 現在値を含め損ねると、開いただけでベースモデルが消える（保存まで気づけない）
const known = loraLib.baseKinds().map((k) => loraLib.baseLabel(k));
checkList('既定の候補は BASE_KINDS の表示名', loraLib.baseChoices(''), known);
check(
  '候補に無い現在値は末尾に足される',
  loraLib.baseChoices('Qwen-Image').at(-1),
  'Qwen-Image',
);
check(
  '既知の値を渡しても重複しない',
  loraLib.baseChoices('Krea 2').length,
  known.length,
);
check(
  'ライブラリで使われている表記も候補に入る',
  loraLib.baseChoices('', ['SDXL 1.0']).includes('SDXL 1.0'),
  true,
);
checkList(
  '空文字・空白だけの値は候補にしない',
  loraLib.baseChoices('   ', ['', '  ']),
  known,
);
check(
  'extras と現在値が同じなら 1 つだけ',
  loraLib.baseChoices('SDXL 1.0', ['SDXL 1.0']).filter((v) => v === 'SDXL 1.0').length,
  1,
);
check('Krea は krea2', loraLib.baseKind('Krea 2'), 'krea2');
check('空は null', loraLib.baseKind(''), null);

/* ---- 保存（store.js 経由） ---- */

// 登録したものが読み戻せる
{
  const store = {};
  const lib = loadLib(store);
  lib.register('https://huggingface.co/owner/repo/resolve/main/x.safetensors');
  check('登録すると保存される', lib.load().length, 1);
  check('保存先は fal_lora_library', JSON.parse(store.fal_lora_library).length, 1);
  lib.unregister('https://huggingface.co/owner/repo/resolve/main/x.safetensors');
  check('削除も保存される', lib.load().length, 0);
}

// 満杯の端末では、黙って消えたことにせず理由の分かる例外を出す
// （素の setItem をそのまま呼んでいた頃は "The quota has been exceeded." だった）
{
  const lib = loadLib({}, { full: true });
  let message = '';
  try {
    lib.register('https://huggingface.co/owner/repo/resolve/main/x.safetensors');
  } catch (err) {
    message = err.message;
  }
  check('容量あふれは日本語で伝える', message.includes('保存領域がいっぱい'), true);
}

/* ---- お気に入り（★） ---- */

// 付けたものは sorted() の先頭に来る（どの画面でも候補の上に並ぶ）
{
  const store = {};
  const lib = loadLib(store);
  const a = 'https://huggingface.co/owner/repo/resolve/main/aaa.safetensors';
  const z = 'https://huggingface.co/owner/repo/resolve/main/zzz.safetensors';
  lib.register(a);
  lib.register(z);
  checkList('既定は表示名順', Array.from(lib.sorted(), (i) => i.path), [a, z]);

  check('付ける前は false', lib.isFav(z), false);
  check('toggleFav は新しい状態を返す', lib.toggleFav(z), true);
  check('付けたら isFav が true', lib.isFav(z), true);
  checkList('★ が先頭に来る', Array.from(lib.sorted(), (i) => i.path), [z, a]);
  check('保存もされる', JSON.parse(store.fal_lora_library).find((i) => i.path === z).fav, true);

  check('外すと false に戻る', lib.toggleFav(z), false);
  checkList('外すと表示名順に戻る', Array.from(lib.sorted(), (i) => i.path), [a, z]);
  check('外したら項目に fav は残らない',
    'fav' in JSON.parse(store.fal_lora_library).find((i) => i.path === z), false);

  // 未登録の path に付けようとしても、ライブラリを壊さない
  check('未登録には付かない', lib.setFav('https://huggingface.co/x/y/resolve/main/none.safetensors', true), false);
  check('件数は変わらない', lib.load().length, 2);
}

/* ---- 非表示 ---- */

// 候補（forBase）からは外れるが、レコードと付けた情報は残る
{
  const store = {};
  const lib = loadLib(store);
  const keep = 'https://huggingface.co/owner/repo/resolve/main/keep.safetensors';
  const gone = 'https://huggingface.co/owner/repo/resolve/main/gone.safetensors';
  lib.register(keep, { base: 'Krea 2' });
  lib.register(gone, { base: 'Krea 2' });

  check('既定は表示', lib.isHidden(gone), false);
  check('隠すと true', lib.toggleHidden(gone), true);
  checkList('候補からは消える', Array.from(lib.forBase('krea2'), (i) => i.path), [keep]);
  checkList('includeHidden なら出る',
    Array.from(lib.forBase('krea2', { includeHidden: true }), (i) => i.path).sort(), [gone, keep]);
  check('レコードは残る', lib.load().length, 2);
  check('付けた情報も残る', lib.entry(gone).base, 'Krea 2');
  check('戻せる', lib.toggleHidden(gone), false);
  checkList('戻すと候補に出る',
    Array.from(lib.forBase('krea2'), (i) => i.path).sort(), [gone, keep]);
}

// 一括は「実際に変わった件数」を返し、保存は 1 回だけ
{
  const store = {};
  const lib = loadLib(store);
  const paths = ['a', 'b', 'c'].map((n) => `https://huggingface.co/owner/repo/resolve/main/${n}.safetensors`);
  for (const p of paths) lib.register(p);
  let writes = 0;
  const onChange = () => { writes++; };
  lib.onChange = onChange;

  check('3 件まとめて隠す', lib.setHiddenMany(paths, true), 3);
  check('保存は 1 回', writes, 1);
  check('すべて非表示', lib.forBase(null).length, 0);
  check('もう一度隠しても変わらない', lib.setHiddenMany(paths, true), 0);
  check('変化が無ければ保存もしない', writes, 1);
  check('2 件だけ戻す', lib.setHiddenMany(paths.slice(0, 2), false), 2);
  checkList('戻した 2 件が候補に出る',
    Array.from(lib.forBase(null), (i) => i.path).sort(), paths.slice(0, 2));
}

/* ---- トリガーワードの挿入 ---- */

// 末尾（既定）: 区切りを二重にしない
check('空なら語だけ', loraLib.insertTriggers('', ['ohwx'], 'end'), 'ohwx');
check('末尾に足す', loraLib.insertTriggers('a cat', ['ohwx'], 'end'), 'a cat, ohwx');
check('末尾がカンマなら空白だけ', loraLib.insertTriggers('a cat,', ['ohwx'], 'end'), 'a cat, ohwx');
check('読点でも同じ', loraLib.insertTriggers('猫、', ['ohwx'], 'end'), '猫、 ohwx');

// 冒頭: 先頭の区切りは食わせる
check('冒頭に足す', loraLib.insertTriggers('a cat', ['ohwx'], 'head'), 'ohwx, a cat');
check('複数語もまとめて', loraLib.insertTriggers('a cat', ['ohwx', 'zwx'], 'head'), 'ohwx, zwx, a cat');
check('先頭のカンマは食う', loraLib.insertTriggers(', a cat', ['ohwx'], 'head'), 'ohwx, a cat');
check('冒頭でも空なら語だけ', loraLib.insertTriggers('  ', ['ohwx'], 'head'), 'ohwx');

// 既に書かれている語は足さない（足すものが無ければ null）
check('入っていれば null', loraLib.insertTriggers('a ohwx cat', ['ohwx'], 'head'), null);
check('大文字小文字は問わない', loraLib.insertTriggers('a OHWX cat', ['ohwx'], 'end'), null);
check('足りない語だけ入れる',
  loraLib.insertTriggers('a ohwx cat', ['ohwx', 'zwx'], 'end'), 'a ohwx cat, zwx');
check('語が無ければ null', loraLib.insertTriggers('a cat', [], 'end'), null);

// 位置と自動挿入は LoRA ごとの設定（未設定は末尾・自動なし）
{
  const lib = loadLib({});
  const p = 'https://huggingface.co/owner/repo/resolve/main/t.safetensors';
  lib.register(p);
  check('既定は末尾', lib.triggerPlace(p), 'end');
  check('既定は自動なし', lib.triggerAuto(p), false);
  const items = lib.load();
  items[0].triggerPlace = 'head';
  items[0].triggerAuto = true;
  lib.save(items);
  check('冒頭を覚える', lib.triggerPlace(p), 'head');
  check('自動を覚える', lib.triggerAuto(p), true);
  check('未登録は既定', lib.triggerPlace('https://huggingface.co/x/y/resolve/main/none.safetensors'), 'end');
}

console.log(`ok: ${passed} checks passed`);
