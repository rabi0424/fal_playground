'use strict';

/* ==========================================================================
 * モデル（チェックポイント）ライブラリ（共有）
 *
 * Modal のチェックポイント指定版で使う UNet の登録先（localStorage の
 * 'fal_ckpt_library'）。生成画面・比較アリーナ・ライブラリ管理が通す。
 *
 * レコードは { path, name, base? } に、ライブラリ管理で付ける
 * label（表示名）・note・fav・hidden が任意で加わる。path が識別子で、
 * 生成時に Modal へ渡す値でもあるので書き換えない。
 *
 * チェックポイントはモデルの系統ごとに別物で、**Krea 2 用を Qwen-Image 2.1 に
 * 渡すとエラーにならずに読み込めてしまう**。そのため候補は系統で分ける。
 * base 無しの古い登録は Krea 2 用として扱う（qwen21 を足すまではそれしか無かった）。
 * ========================================================================== */

(() => {

const LS_CKPTS = 'fal_ckpt_library';
const DEFAULT_BASE = 'krea2';
const BASE_LABELS = { krea2: 'Krea 2', qwen21: 'Qwen-Image 2.1' };

let onChange = null;

function load() {
  try {
    const v = JSON.parse(falStore.get(LS_CKPTS));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// 登録は失うと困るので、書けなかったことは黙って飲み込まない
function save(items) {
  falStore.setOrThrow(LS_CKPTS, JSON.stringify(items));
  onChange?.();
}

// .gguf / .safetensors の区別が重要なので拡張子ごと表示する
function displayName(path) {
  const seg = String(path).split('?')[0].split('/').filter(Boolean).pop() || path;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function labelOf(item) {
  return item?.label?.trim() || item?.name || displayName(item?.path ?? '');
}

function label(path) {
  const item = load().find((i) => i.path === path);
  return item ? labelOf(item) : displayName(path);
}

const baseOf = (item) => item?.base || DEFAULT_BASE;

// ★ を先頭に、あとは表示名順
function sorted(items = load()) {
  return [...items].sort((a, b) => {
    if (!!a.fav !== !!b.fav) return a.fav ? -1 : 1;
    return loraLib.compareLabels(labelOf(a), labelOf(b));
  });
}

// その系統で選べるもの。非表示は外すが、keep（いま選ばれている値）は残す
function forBase(base = DEFAULT_BASE, { keep = null, includeHidden = false } = {}) {
  return sorted().filter((item) => baseOf(item) === base
    && (includeHidden || !item.hidden || item.path === keep));
}

function register(path, base = DEFAULT_BASE) {
  const items = load();
  if (items.some((item) => item.path === path)) return false;
  items.push({ name: displayName(path), path, base, addedAt: Date.now() });
  save(items);
  return true;
}

function unregister(path) {
  save(load().filter((item) => item.path !== path));
}

// 一括用。何件でも保存は 1 回
function setFlagMany(paths, key, on) {
  const want = new Set(paths);
  const items = load();
  let changed = 0;
  for (const item of items) {
    if (!want.has(item.path) || !!item[key] === !!on) continue;
    if (on) item[key] = true;
    else delete item[key];
    changed++;
  }
  if (changed > 0) save(items);
  return changed;
}

// プルダウンの表示名（★ と、残している非表示の印）
function optionLabel(item) {
  return (item.fav ? '★ ' : '') + labelOf(item) + (item.hidden ? '（非表示）' : '');
}

window.ckptLib = {
  DEFAULT_BASE,
  load,
  save,
  displayName,
  label,
  labelOf,
  baseOf,
  baseLabel: (base) => BASE_LABELS[base] ?? base,
  baseKinds: () => Object.keys(BASE_LABELS),
  sorted,
  forBase,
  register,
  unregister,
  setFavMany: (paths, on) => setFlagMany(paths, 'fav', on),
  setHiddenMany: (paths, on) => setFlagMany(paths, 'hidden', on),
  optionLabel,
  set onChange(fn) { onChange = fn; },
};

})();
