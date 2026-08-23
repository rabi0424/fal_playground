// LoRA ライブラリ（lora-library.js）の単体テスト:  node test/lora-library.test.mjs
//
// ブラウザ用の IIFE をそのまま Node の vm で走らせ、window / localStorage だけ
// 差し替える。見るのは Modal 系 API へ渡す識別子（modalRef）の作り方で、
// ここを名前だけに落とすと「別のリポジトリから取り込んだ LoRA が
// lora '...' not found in volume で 404 になる」不具合に戻る。
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

function loadLib(store = {}) {
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const sandbox = { localStorage, console };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(new URL('../lora-library.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.loraLib;
}

const loraLib = loadLib();
let passed = 0;
const check = (label, actual, expected) => {
  assert.equal(actual, expected, label);
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
check('Krea は krea2', loraLib.baseKind('Krea 2'), 'krea2');
check('空は null', loraLib.baseKind(''), null);

console.log(`ok: ${passed} checks passed`);
