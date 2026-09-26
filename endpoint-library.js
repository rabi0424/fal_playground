'use strict';

/* ==========================================================================
 * エンドポイントライブラリ（共有）
 *
 * 各画面のモデル／プロバイダ／ボットのプルダウンに出る「呼び出し先」を
 * 一覧にし、お気に入り（★）と非表示の印を持たせる。印は localStorage の
 * 'fal_endpoint_prefs' に { key, fav?, hidden? } の配列で入り、端末間同期の
 * 'endpoints' セクションで全端末に揃う。
 *
 * 呼び出し先そのもの（URL やパラメータ）は各画面のコードが持っていて、
 * ここで持つのは印と、ライブラリ画面に並べるための一覧（CATALOG）だけ。
 * CATALOG の漏れは test/endpoint-library.test.mjs が各画面のソースと
 * 突き合わせて検出する。
 *
 * key は生成画面・比較アリーナが同じ id を使うので、そのまま共有する
 * （片方で隠せばもう片方でも隠れる）。画像編集と Poe 編集は id が短く
 * 取り違えやすいので、画面名を前に付ける（'imgedit:fal' / 'poe:GPT-Image-2'）。
 * 「カスタム…」は自由入力の入口なので載せない（隠せない）。
 * ========================================================================== */

(() => {

const LS_PREFS = 'fal_endpoint_prefs';

const SCREEN_LABELS = {
  generate: '生成',
  arena: '比較アリーナ',
  imgedit: '画像編集',
  poe: 'Poe 編集',
};

const CATALOG = [
  { key: 'fal-ai/krea-2/turbo/lora', name: 'Krea 2 [turbo] LoRA（fal）', screens: ['generate', 'arena'] },
  { key: 'modal/krea2-turbo-exp', name: 'Krea 2 [turbo] 自前ホスト（Modal 実験版）', screens: ['generate', 'arena'] },
  { key: 'modal/krea2-turbo-gpusnap', name: 'Krea 2 [turbo] 自前ホスト（Modal GPUスナップ版）', screens: ['generate', 'arena'] },
  { key: 'modal/krea2-turbo', name: 'Krea 2 [turbo] 自前ホスト（Modal 本番）', screens: ['generate', 'arena'] },
  { key: 'modal/krea2-turbo-ckpt', name: 'Krea 2 [turbo] 自前ホスト（Modal チェックポイント指定版）', screens: ['generate', 'arena'] },
  { key: 'modal/krea2-turbo-wan', name: 'Krea 2 [turbo] 自前ホスト（Modal 統合版・編集と共有）', screens: ['generate', 'arena'] },
  { key: 'modal/krea2-turbo-lanpaint', name: 'Krea 2 [turbo] 自前ホスト（Modal LanPaint 版）', screens: ['generate', 'arena'] },
  { key: 'modal/krea2-turbo-unified', name: 'Krea 2 [turbo] 自前ホスト（Modal 統合版・Qwen 2.1 と共有）', screens: ['generate', 'arena'] },
  { key: 'modal/qwen-image-2.1', name: 'Qwen-Image 2.1 自前ホスト（Modal 統合版）', screens: ['generate', 'arena'] },
  { key: 'fal-ai/flux/schnell', name: 'FLUX.1 [schnell]', screens: ['generate'] },
  { key: 'fal-ai/flux/dev', name: 'FLUX.1 [dev]', screens: ['generate'] },
  { key: 'fal-ai/flux-pro/v1.1', name: 'FLUX1.1 [pro]', screens: ['generate'] },
  { key: 'fal-ai/flux-pro/v1.1-ultra', name: 'FLUX1.1 [pro] ultra', screens: ['generate'] },
  { key: 'fal-ai/recraft/v3/text-to-image', name: 'Recraft V3', screens: ['generate'] },
  { key: 'imgedit:fal', name: 'fal（qwen-image-edit-2511/lora）', screens: ['imgedit'] },
  { key: 'imgedit:wavespeed', name: 'WaveSpeed（qwen-image/edit-2511-lora）', screens: ['imgedit'] },
  { key: 'imgedit:runware', name: 'Runware（FLUX.1 Fill [dev] OneReward）', screens: ['imgedit'] },
  { key: 'imgedit:modal', name: 'Modal 自前ホスト（Wan2.2 + VACE マスク編集）', screens: ['imgedit'] },
  { key: 'imgedit:lanpaint', name: 'Modal 自前ホスト（LanPaint インペイント）', screens: ['imgedit'] },
  { key: 'imgedit:qwen21', name: 'Modal 自前ホスト（Qwen-Image 2.1 参照画像編集）', screens: ['imgedit'] },
  { key: 'poe:Nano-Banana-2', name: 'Nano Banana 2', screens: ['poe'] },
  { key: 'poe:Nano-Banana-Pro', name: 'Nano Banana Pro', screens: ['poe'] },
  { key: 'poe:GPT-Image-2', name: 'GPT Image 2', screens: ['poe'] },
];

let onChange = null;

function load() {
  try {
    const v = JSON.parse(falStore.get(LS_PREFS));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// 読むだけの問い合わせ用（プルダウンを作るたびに parse し直さない）
let cachedRaw = null;
let cachedMap = new Map();
function prefs() {
  const raw = falStore.get(LS_PREFS);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    let items = [];
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) items = v;
    } catch { /* 壊れていたら印なしとして扱う */ }
    cachedMap = new Map(items.filter((i) => typeof i?.key === 'string').map((i) => [i.key, i]));
  }
  return cachedMap;
}

// 利用者の操作なので、書けなかったことは飲み込まない
function save(items) {
  falStore.setOrThrow(LS_PREFS, JSON.stringify(items));
  onChange?.();
}

const isFav = (key) => !!prefs().get(key)?.fav;
const isHidden = (key) => !!prefs().get(key)?.hidden;

// 印の付け外し。何件でも保存は 1 回。false は持たせずキーごと消す。
// 印が 1 つも無くなった項目も { key } として残す（消すと同期の墓標が増えるだけ）
function setFlagMany(keys, flag, on) {
  const items = load();
  let changed = 0;
  for (const key of keys) {
    let item = items.find((i) => i.key === key);
    if (!!item?.[flag] === !!on) continue;
    if (!item) {
      item = { key };
      items.push(item);
    }
    if (on) item[flag] = true;
    else delete item[flag];
    changed++;
  }
  if (changed > 0) save(items);
  return changed;
}

const setFav = (key, on) => setFlagMany([key], 'fav', on) > 0;
const setHidden = (key, on) => setFlagMany([key], 'hidden', on) > 0;

/**
 * プルダウンに並べる順に整える。★ を先頭に（元の並びは保つ）、非表示は外す。
 * keep に渡したもの（いま選ばれている値）は非表示でも残す。黙って別の
 * エンドポイントへ切り替わると、下書きの復元や履歴の再利用で気づかず別物を
 * 呼んでしまうため。全部を隠した場合は選びようがなくなるので、隠さずに出す。
 * keyOf が null を返すもの（「カスタム…」など）は印の対象外で、常に末尾に残す。
 */
function arrange(list, keyOf, { keep = null } = {}) {
  const fixed = [];
  const favs = [];
  const rest = [];
  for (const item of list) {
    const key = keyOf(item);
    if (key == null) fixed.push(item);
    else if (isHidden(key) && key !== keep) continue;
    else (isFav(key) ? favs : rest).push(item);
  }
  const shown = [...favs, ...rest];
  if (shown.length === 0) return [...list];
  return [...shown, ...fixed];
}

// プルダウンの表示名。★ と「非表示にしたものを残している」ことが分かるようにする
function optionLabel(key, name) {
  if (key == null) return name;
  return (isFav(key) ? '★ ' : '') + name + (isHidden(key) ? '（非表示）' : '');
}

window.endpointLib = {
  catalog: () => CATALOG.map((e) => ({ ...e, screens: [...e.screens] })),
  screenLabel: (screen) => SCREEN_LABELS[screen] ?? screen,
  load,
  isFav,
  isHidden,
  setFav,
  setHidden,
  toggleFav: (key) => setFav(key, !isFav(key)),
  toggleHidden: (key) => setHidden(key, !isHidden(key)),
  setFavMany: (keys, on) => setFlagMany(keys, 'fav', on),
  setHiddenMany: (keys, on) => setFlagMany(keys, 'hidden', on),
  arrange,
  optionLabel,
  set onChange(fn) { onChange = fn; },
};

})();
