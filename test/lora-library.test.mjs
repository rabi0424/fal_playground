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

console.log(`ok: ${passed} checks passed`);
