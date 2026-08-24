'use strict';

/* ==========================================================================
 * LoRA ライブラリ（共有）
 *
 * 登録済み LoRA の保存先（localStorage の 'fal_lora_library'）と、表示名・
 * トリガーワード・既定 scale・ベースモデルの扱いをまとめる。生成画面・画像編集・
 * ライブラリ管理・比較アリーナのすべてがここを通す。
 *
 * レコードは { path, name } だけの古い形でも動く。path（ダウンロード URL）は
 * この LoRA の識別子で、生成時に Modal へ渡す指定も path から作るため書き換えない。
 * label はあくまで表示用。
 *
 * 保存のたびに端末間同期へ知らせる必要があるが、同期の実装はページごとに持って
 * いるので loraLib.onChange に登録してもらう。
 * ========================================================================== */

(() => {

const LS_LORAS = 'fal_lora_library';
const LS_BASE_MIGRATED = 'fal_lora_base_migrated';

let onChange = null;

function load() {
  try {
    return JSON.parse(falStore.get(LS_LORAS)) || [];
  } catch {
    return [];
  }
}

// 利用者が起こした登録・削除は、書けなかったことを黙って飲み込まない
// （消えたと気づけないまま使い続けることになる）。
// 自動移行のように諦めてよい書き込みだけ quiet で通す
function save(items, { quiet = false } = {}) {
  const json = JSON.stringify(items);
  if (quiet) falStore.set(LS_LORAS, json);
  else falStore.setOrThrow(LS_LORAS, json);
  onChange?.();
}

// URL 末尾のファイル名（.safetensors 抜き）。生成時に Modal へ渡す名前でもある
function fileName(path) {
  const seg = String(path).split('?')[0].split('/').filter(Boolean).pop() || path;
  try {
    return decodeURIComponent(seg).replace(/\.safetensors$/i, '');
  } catch {
    return seg.replace(/\.safetensors$/i, '');
  }
}

// Hugging Face の resolve / blob URL（modal_comfy がそのまま受け付ける形）。
// 判定は modal_comfy 側の HF_URL_RE に合わせてある
const HF_RESOLVE_RE = /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/(?:resolve|blob)\/[^/]+\/.+$/i;

// Modal 系 API（modal_comfy）へ渡す LoRA の識別子。
//
// あちらはファイル名でも HF の resolve URL でも受け取るが、ファイル名だけで渡すと
// Volume にあるものか、既定リポジトリ（tottie2215/temp_str）の直下にあるものしか
// 解決できない。別のリポジトリから取り込んだ LoRA や、サブフォルダに置かれた
// ファイルは「lora '...' not found in volume」の 404 になる。
// URL のまま渡せば Modal 側が初回リクエスト時に取り込めるので、URL を持つものは
// URL で渡す（「名前を直接入力…」で打たれた素の名前はそのまま名前で渡す）
function modalRef(path) {
  const s = String(path ?? '').trim();
  return HF_RESOLVE_RE.test(s) ? s : fileName(s);
}

function entry(path) {
  return load().find((item) => item.path === path) ?? null;
}

// 画面に出す名前。未設定なら取り込み時の自動名にフォールバックする
function label(path) {
  const item = entry(path);
  return item?.label?.trim() || item?.name || fileName(path);
}

function labelOf(item) {
  return item?.label?.trim() || item?.name || fileName(item?.path ?? '');
}

function defaultScale(path) {
  const scale = entry(path)?.scale;
  return Number.isFinite(scale) ? scale : 1;
}

function triggerWords(path) {
  return (entry(path)?.trigger || '').split(',').map((w) => w.trim()).filter(Boolean);
}

// Civitai のベースモデル表記はゆれるので（"Qwen"／"Qwen-Image"／"Krea 2"／
// "Wan Video 14B t2v" など）、使う側が判定しやすい大まかな種類に寄せる
function baseKind(base) {
  const s = String(base ?? '').toLowerCase();
  if (s === '') return null;
  // "qwen" に "wan" は含まれない（wen）ので、この順で取り違えは起きない
  if (s.includes('wan')) return 'wan';
  if (s.includes('qwen')) return 'qwen';
  if (s.includes('krea')) return 'krea2';
  return 'other';
}

const BASE_LABELS = { qwen: 'Qwen', krea2: 'Krea 2', wan: 'Wan', other: 'その他' };

// ★ を先頭に、あとは表示名順（数字は数値として比較する）
function sorted(items = load()) {
  return [...items].sort((a, b) => {
    if (!!a.fav !== !!b.fav) return a.fav ? -1 : 1;
    return labelOf(a).localeCompare(labelOf(b), 'ja', { numeric: true, sensitivity: 'base' });
  });
}

// そのモデルで使えるものだけ。want が null なら制限しない
function forBase(want) {
  const all = sorted();
  return want ? all.filter((item) => baseKind(item.base) === want) : all;
}

function register(path, meta = null) {
  const items = load();
  if (!items.some((item) => item.path === path)) {
    items.push({
      name: fileName(path),
      path,
      addedAt: Date.now(),
      // 取り込み時に Civitai から分かっている情報はそのまま初期値にする
      // （あとで「情報を取得」を押さなくても、ベースモデルで絞り込める）
      ...(meta?.base ? { base: meta.base } : {}),
      ...(meta?.trigger ? { trigger: meta.trigger } : {}),
      ...(meta?.source ? { source: meta.source } : {}),
      ...(meta?.base || meta?.trigger ? { metaAt: Date.now() } : {}),
    });
    save(items);
  }
  return true;
}

function unregister(path) {
  save(load().filter((item) => item.path !== path));
}

/* ---------- 移行 ---------- */

function migrate() {
  const items = load();
  let changed = false;

  // 過去の Civitai 取り込みがサブフォルダのパスを %2F にエンコードした URL で
  // 登録していた不具合の補正。%2F だと HF 一括登録経由の URL と食い違い、
  // Modal 生成へ渡る LoRA 名が変わって効かなくなる
  for (const item of items) {
    if (/^https:\/\/huggingface\.co\/.*%2F/i.test(item.path)) {
      item.path = item.path.replace(/%2F/gi, '/');
      item.name = fileName(item.path);
      changed = true;
    }
  }

  // ベースモデルでの絞り込みを入れる前に登録された LoRA は、すべて Krea 2 用。
  // 一度だけ印を付ける（あとからライブラリ画面で直せる）。
  // 空のときは印を付けない。別端末から同期でデータが流れてくる前に印だけ消費すると、
  // 届いた LoRA がベースモデル無しのまま候補から消えてしまう
  if (items.length > 0 && !falStore.get(LS_BASE_MIGRATED)) {
    for (const item of items) {
      if (!item.base) {
        item.base = 'Krea 2';
        changed = true;
      }
    }
    falStore.set(LS_BASE_MIGRATED, String(Date.now()));
  }

  if (changed) save(items, { quiet: true }); // 移行は起動時に走る。ここで止めない
}

window.loraLib = {
  load,
  save,
  entry,
  fileName,
  modalRef,
  label,
  labelOf,
  defaultScale,
  triggerWords,
  baseKind,
  baseLabel: (kind) => BASE_LABELS[kind] ?? kind,
  sorted,
  forBase,
  register,
  unregister,
  migrate,
  set onChange(fn) { onChange = fn; },
};

})();
