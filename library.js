'use strict';

/* ==========================================================================
 * LoRA ライブラリ管理
 *
 * 登録済み LoRA の表示名・トリガーワード・既定 scale などを一覧で編集する別画面。
 *
 * - 保存先は本体（app.js）と同じ localStorage の 'fal_lora_library'。
 *   項目はすべて任意で、path と name しか持たない古いデータもそのまま扱える
 * - path（ダウンロード URL）はこの LoRA の識別子。生成時に Modal へ渡す名前も
 *   path から作るため、ここでは絶対に書き換えない（label は表示専用）
 * - トリガーワード等は、Civitai 取り込み時にモデルの隣へ保存した
 *   <ファイル名>.civitai.json を Worker 経由（/api/lora/meta）で読んで補完する
 * ========================================================================== */

/* ---------- constants ---------- */

const LS_LORAS = 'fal_lora_library';
const LS_CKPTS = 'fal_ckpt_library'; // 同期のためここでも扱う（値は触らない）
const LS_ARENA = 'fal_arena';

const SAVE_DELAY_MS = 400; // 入力が落ち着いてから保存する
const HF_DEFAULT_REPO = 'tottie2215/temp_str'; // 取り込み先の既定（app.js と同じ）

/* ---------- helpers ---------- */

const $ = (sel) => document.querySelector(sel);

const els = {
  searchInput: $('#searchInput'),
  filterChips: $('#filterChips'),
  sortSelect: $('#sortSelect'),
  fetchAllBtn: $('#fetchAllBtn'),
  civitaiBtn: $('#civitaiBtn'),
  status: $('#status'),
  error: $('#error'),
  list: $('#list'),
  empty: $('#empty'),
  metaDialog: $('#metaDialog'),
  metaTitle: $('#metaTitle'),
  metaDiff: $('#metaDiff'),
  metaError: $('#metaError'),
  metaApplyBtn: $('#metaApplyBtn'),
};

function setStatus(text, done = false) {
  els.status.hidden = !text;
  els.status.textContent = text || '';
  els.status.classList.toggle('done', !!text && done);
}

function setError(text) {
  els.error.hidden = !text;
  els.error.textContent = text || '';
}

function isHtmlResponse(res) {
  return (res.headers.get('Content-Type') || '').includes('text/html');
}

/* ---------- ライブラリ ---------- */

function loadLibrary() {
  return loraLib.load();
}

function saveLibrary(items) {
  loraLib.save(items);
}

const loraFileName = (path) => loraLib.fileName(path);
const entryLabel = (item) => loraLib.labelOf(item);
const triggerWords = (item) => (item.trigger || '').split(',').map((w) => w.trim()).filter(Boolean);

// 「要整理」＝ .civitai.json をまだ読んでおらず、トリガーワードも入っていないもの
function needsAttention(item) {
  return !item.metaAt && !item.trigger;
}

function isHfPath(path) {
  return /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[^/]+\/.+\.safetensors$/i.test(path);
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

/* ---------- 一覧の状態 ---------- */

let library = loadLibrary();
let filter = 'all'; // 'all' | 'fav' | 'todo' | `base:<名前>`
let expanded = null; // 展開中の path
const saveTimers = new Map();

// 入力のたびに保存すると同期が騒がしいので、少し待ってからまとめて書く
function scheduleSave(path, mutate) {
  const item = library.find((l) => l.path === path);
  if (!item) return;
  mutate(item);
  clearTimeout(saveTimers.get(path));
  saveTimers.set(path, setTimeout(() => {
    saveTimers.delete(path);
    saveLibrary(library);
  }, SAVE_DELAY_MS));
}

function flushSaves() {
  if (saveTimers.size === 0) return;
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
  saveLibrary(library);
}

function matchesSearch(item, q) {
  if (!q) return true;
  const hay = [entryLabel(item), item.name, item.trigger, item.note, item.base, item.path]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function visibleItems() {
  const q = els.searchInput.value.trim().toLowerCase();
  let items = library.filter((item) => matchesSearch(item, q));
  if (filter === 'fav') items = items.filter((i) => i.fav);
  else if (filter === 'todo') items = items.filter(needsAttention);
  else if (filter.startsWith('base:')) {
    const base = filter.slice('base:'.length);
    items = items.filter((i) => (i.base || '') === base);
  }

  const sort = els.sortSelect.value;
  return items.sort((a, b) => {
    if (sort === 'added') return (b.addedAt || 0) - (a.addedAt || 0);
    if (sort === 'scale') return (b.scale ?? 1) - (a.scale ?? 1);
    // 名前順。お気に入りは先頭に集める（生成画面のプルダウンと同じ並び）
    if (!!a.fav !== !!b.fav) return a.fav ? -1 : 1;
    return entryLabel(a).localeCompare(entryLabel(b), 'ja', { numeric: true, sensitivity: 'base' });
  });
}

/* ---------- 描画 ---------- */

function renderFilters() {
  const bases = [...new Set(library.map((i) => i.base).filter(Boolean))].sort();
  const chips = [
    { key: 'all', label: 'すべて', count: library.length },
    { key: 'fav', label: '★', count: library.filter((i) => i.fav).length },
    { key: 'todo', label: '要整理', count: library.filter(needsAttention).length },
    ...bases.map((b) => ({ key: `base:${b}`, label: b, count: library.filter((i) => i.base === b).length })),
  ];
  els.filterChips.innerHTML = '';
  for (const chip of chips) {
    if (chip.count === 0 && chip.key !== 'all') continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lib-chip';
    btn.classList.toggle('on', filter === chip.key);
    btn.textContent = `${chip.label} ${chip.count}`;
    btn.addEventListener('click', () => {
      filter = filter === chip.key ? 'all' : chip.key;
      render();
    });
    els.filterChips.appendChild(btn);
  }
}

function render() {
  renderFilters();
  els.list.innerHTML = '';

  const items = visibleItems();
  for (const item of items) els.list.appendChild(renderCard(item));

  const hasAny = library.length > 0;
  els.empty.hidden = items.length > 0;
  els.empty.textContent = hasAny
    ? '条件に合う LoRA がありません。'
    : 'まだ LoRA が登録されていません。生成画面の「Hugging Face から一括登録」や「Civitai から取り込み」で追加してください。';
  els.fetchAllBtn.disabled = library.filter((i) => needsAttention(i) && isHfPath(i.path)).length === 0;
}

function renderCard(item) {
  const card = document.createElement('div');
  card.className = 'lib-card';
  if (expanded === item.path) card.classList.add('open');

  /* --- 見出し行 --- */
  const head = document.createElement('div');
  head.className = 'lib-card-head';

  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'lib-star';
  star.classList.toggle('on', !!item.fav);
  star.textContent = '★';
  star.title = item.fav ? 'お気に入りから外す' : 'お気に入りに入れる';
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    scheduleSave(item.path, (i) => { i.fav = !i.fav; });
    render();
  });
  head.appendChild(star);

  const name = document.createElement('span');
  name.className = 'lib-name';
  name.textContent = entryLabel(item);
  head.appendChild(name);

  // ベースモデルと「まだ情報を取っていない」ことは別の情報なので両方出す
  if (item.base) {
    const badge = document.createElement('span');
    badge.className = 'lib-badge base';
    badge.textContent = item.base;
    head.appendChild(badge);
  }
  if (needsAttention(item)) {
    const badge = document.createElement('span');
    badge.className = 'lib-badge warn';
    badge.textContent = 'トリガー未取得';
    head.appendChild(badge);
  }

  head.addEventListener('click', () => {
    expanded = expanded === item.path ? null : item.path;
    render();
    if (expanded) {
      document.querySelector('.lib-card.open')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
  card.appendChild(head);

  /* --- トリガーワード --- */
  const words = triggerWords(item);
  if (words.length > 0) {
    const trig = document.createElement('div');
    trig.className = 'lib-trigger';
    for (const word of words) {
      const chip = document.createElement('span');
      chip.className = 'lib-trigger-chip';
      chip.textContent = word;
      trig.appendChild(chip);
    }
    card.appendChild(trig);
  }

  /* --- 補足行 --- */
  const sub = document.createElement('div');
  sub.className = 'lib-sub';
  // 表示名と同じ文字列なら、ファイル名を二度書かない
  const fileName = loraFileName(item.path);
  sub.textContent = [
    fileName === entryLabel(item) ? null : fileName,
    item.scale !== undefined ? `既定 scale ${Number(item.scale).toFixed(2)}` : null,
    item.addedAt ? `${formatDate(item.addedAt)} 追加` : null,
    item.note || null,
  ].filter(Boolean).join(' ・ ');
  card.appendChild(sub);

  if (expanded === item.path) card.appendChild(renderEditor(item));
  return card;
}

function field(labelText, control, hint) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = labelText;
  wrap.append(label, control);
  if (hint) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = hint;
    wrap.appendChild(h);
  }
  return wrap;
}

function renderEditor(item) {
  const box = document.createElement('div');
  box.className = 'lib-editor';

  /* 表示名 */
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.value = item.label || '';
  labelInput.placeholder = item.name || loraFileName(item.path);
  labelInput.addEventListener('input', () => {
    scheduleSave(item.path, (i) => { i.label = labelInput.value; });
    // 見出しだけその場で追従させる（再描画すると入力が途切れる）
    box.closest('.lib-card').querySelector('.lib-name').textContent =
      labelInput.value.trim() || item.name || loraFileName(item.path);
  });
  box.appendChild(field('表示名', labelInput,
    'プルダウンとこの一覧に出る名前です。生成時に送られるファイル名は変わりません。'));

  /* トリガーワード */
  const trigInput = document.createElement('input');
  trigInput.type = 'text';
  trigInput.value = item.trigger || '';
  trigInput.placeholder = '例: hi res portrait, detailed skin';
  trigInput.spellcheck = false;
  trigInput.addEventListener('input', () => {
    scheduleSave(item.path, (i) => { i.trigger = trigInput.value; });
  });
  box.appendChild(field('トリガーワード', trigInput,
    'カンマ区切り。生成画面の「挿入」でプロンプト末尾に足せます。'));

  /* 既定 scale */
  const scaleWrap = document.createElement('div');
  scaleWrap.className = 'lora-scale';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '2';
  slider.step = '0.05';
  slider.value = String(item.scale ?? 1);
  const num = document.createElement('input');
  num.type = 'number';
  num.min = '0';
  num.max = '2';
  num.step = '0.05';
  num.value = String(item.scale ?? 1);
  const applyScale = (value) => {
    scheduleSave(item.path, (i) => { i.scale = Number(value) || 0; });
  };
  slider.addEventListener('input', () => { num.value = slider.value; applyScale(slider.value); });
  num.addEventListener('input', () => { slider.value = num.value; applyScale(num.value); });
  scaleWrap.append(slider, num);
  box.appendChild(field('既定 scale', scaleWrap, 'この LoRA を行に追加したときの初期値になります。'));

  /* ベースモデル */
  const baseInput = document.createElement('input');
  baseInput.type = 'text';
  baseInput.value = item.base || '';
  baseInput.placeholder = '例: Krea 2';
  baseInput.setAttribute('list', 'baseList');
  baseInput.addEventListener('input', () => {
    scheduleSave(item.path, (i) => { i.base = baseInput.value.trim(); });
  });
  // 既に使っているベースモデル名を候補に出す（input の子には置けないので box 直下）
  const datalist = document.createElement('datalist');
  datalist.id = 'baseList';
  for (const base of [...new Set(library.map((i) => i.base).filter(Boolean))].sort()) {
    const opt = document.createElement('option');
    opt.value = base;
    datalist.appendChild(opt);
  }
  box.appendChild(datalist);
  box.appendChild(field('ベースモデル', baseInput));

  /* メモ */
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.value = item.note || '';
  noteInput.placeholder = '例: 人物のみ。背景には効かない';
  noteInput.addEventListener('input', () => {
    scheduleSave(item.path, (i) => { i.note = noteInput.value; });
  });
  box.appendChild(field('メモ', noteInput));

  /* ファイル */
  const pathBox = document.createElement('div');
  pathBox.className = 'lib-path';
  pathBox.textContent = item.path;
  box.appendChild(field('ファイル', pathBox));

  /* 操作 */
  const actions = document.createElement('div');
  actions.className = 'lib-actions';

  if (isHfPath(item.path)) {
    const fetchBtn = document.createElement('button');
    fetchBtn.type = 'button';
    fetchBtn.className = 'ghost-btn small';
    fetchBtn.textContent = 'Civitai の情報を取得';
    fetchBtn.addEventListener('click', () => openMetaDialog(item, fetchBtn));
    actions.appendChild(fetchBtn);
  }

  if (item.source) {
    const link = document.createElement('a');
    link.className = 'ghost-btn small';
    link.href = item.source;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = '取り込み元を開く';
    actions.appendChild(link);
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'ghost-btn small';
  copyBtn.textContent = 'URL をコピー';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(item.path);
      copyBtn.textContent = 'コピーしました';
      setTimeout(() => { copyBtn.textContent = 'URL をコピー'; }, 1500);
    } catch {
      setError('コピーできませんでした（ブラウザの許可が必要です）');
    }
  });
  actions.appendChild(copyBtn);

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  actions.appendChild(spacer);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'ghost-btn small lib-danger';
  delBtn.textContent = '削除';
  delBtn.addEventListener('click', () => {
    if (!confirm(`「${entryLabel(item)}」をライブラリから削除します。よろしいですか？\n（モデルのファイル自体は消えません）`)) return;
    flushSaves();
    library = library.filter((l) => l.path !== item.path);
    expanded = null;
    saveLibrary(library);
    render();
    setStatus(`「${entryLabel(item)}」を削除しました`, true);
  });
  actions.appendChild(delBtn);

  box.appendChild(actions);
  return box;
}

/* ---------- .civitai.json の取り込み ---------- */

async function fetchMeta(path) {
  const res = await fetch(`/api/lora/meta?url=${encodeURIComponent(path)}`);
  if (res.status === 404) throw new Error('この LoRA にはサイト情報 JSON がありません（Civitai 取り込み以外や、保存しない設定で取り込んだもの）');
  if (!res.ok || isHtmlResponse(res)) throw new Error(`取得に失敗しました（HTTP ${res.status}）`);
  return await res.json();
}

// 取得結果と現在値の差分。手で入れてある項目は既定で「そのまま」にする
function metaDiffRows(item, meta) {
  return [
    { key: 'trigger', label: 'トリガーワード', value: meta.trigger },
    { key: 'base', label: 'ベースモデル', value: meta.base },
    { key: 'label', label: '表示名', value: meta.modelName },
    { key: 'source', label: '取り込み元', value: meta.source },
  ].filter((row) => row.value && row.value !== (item[row.key] || ''))
    .map((row) => ({ ...row, current: item[row.key] || '', apply: !item[row.key] }));
}

let metaTarget = null;
let metaRows = [];

async function openMetaDialog(item, btn) {
  setError('');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '取得中…';
  let meta;
  try {
    meta = await fetchMeta(item.path);
  } catch (err) {
    setError(err.message);
    btn.disabled = false;
    btn.textContent = label;
    return;
  }
  btn.disabled = false;
  btn.textContent = label;

  // 何も新しくない場合でも「読んだ」ことは記録して、要整理から外す
  metaRows = metaDiffRows(item, meta);
  if (metaRows.length === 0) {
    scheduleSave(item.path, (i) => { i.metaAt = Date.now(); });
    flushSaves();
    render();
    setStatus('新しく反映できる情報はありませんでした', true);
    return;
  }

  metaTarget = item;
  els.metaError.hidden = true;
  els.metaDiff.innerHTML = '';
  for (const row of metaRows) {
    const card = document.createElement('label');
    card.className = 'lib-diff-row';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = row.apply;
    check.addEventListener('change', () => { row.apply = check.checked; });
    card.appendChild(check);

    const body = document.createElement('div');
    body.className = 'lib-diff-body';

    const title = document.createElement('div');
    title.className = 'lib-diff-title';
    title.textContent = row.label;
    body.appendChild(title);

    const value = document.createElement('div');
    value.className = 'lib-diff-value';
    value.textContent = row.value;
    body.appendChild(value);

    if (row.current) {
      const current = document.createElement('div');
      current.className = 'hint';
      current.textContent = `現在: ${row.current}（編集済みのため既定では上書きしません）`;
      body.appendChild(current);
    }

    card.appendChild(body);
    els.metaDiff.appendChild(card);
  }
  els.metaTitle.textContent = `「${entryLabel(item)}」の情報を取得しました`;
  els.metaDialog.showModal();
}

function applyMeta() {
  if (!metaTarget) return;
  const path = metaTarget.path;
  scheduleSave(path, (item) => {
    for (const row of metaRows) {
      if (row.apply) item[row.key] = row.value;
    }
    item.metaAt = Date.now();
  });
  flushSaves();
  els.metaDialog.close();
  metaTarget = null;
  render();
  setStatus('取得した情報を反映しました', true);
}

// 未取得のものをまとめて取得する。こちらは空欄だけを埋め、既存の値は触らない
async function fetchAllMeta() {
  const targets = library.filter((i) => needsAttention(i) && isHfPath(i.path));
  if (targets.length === 0) return;
  setError('');
  els.fetchAllBtn.disabled = true;
  let filled = 0;
  let missing = 0;
  for (const [index, item] of targets.entries()) {
    setStatus(`取得中… ${index + 1} / ${targets.length}`);
    try {
      const meta = await fetchMeta(item.path);
      const rows = metaDiffRows(item, meta).filter((row) => row.apply);
      if (rows.length > 0) filled += 1;
      scheduleSave(item.path, (target) => {
        for (const row of rows) target[row.key] = row.value;
        target.metaAt = Date.now();
      });
    } catch {
      missing += 1;
      scheduleSave(item.path, (target) => { target.metaAt = Date.now(); }); // 毎回試さない
    }
  }
  flushSaves();
  render();
  setStatus(`${targets.length} 件を確認し、${filled} 件に情報を反映しました`
    + (missing > 0 ? `（${missing} 件はサイト情報 JSON がありませんでした）` : ''), true);
}

/* ---------- init ---------- */

// 端末間同期（共有モジュール）。編集中の入力が消えないよう、保存待ちが
// 残っている間は他端末の内容を反映しない（次の pull で追いつく）
deviceSync.init({
  canApply: () => saveTimers.size === 0,
  onRemote() {
    library = loadLibrary();
    render();
  },
});

loraLib.onChange = () => deviceSync.markDirty('loras');
loraLib.migrate();
library = loadLibrary(); // 移行後の内容で描画する

// この画面からも Civitai 取り込みができる（登録したらその場で一覧に出す）
civitaiImport.init({
  defaultRepo: HF_DEFAULT_REPO,
  register(kind, hfUrl, meta) {
    loraLib.register(hfUrl, meta);
    library = loadLibrary();
    render();
    return `ライブラリに登録しました: ${loraLib.label(hfUrl)}`;
  },
});


els.searchInput.addEventListener('input', render);
els.sortSelect.addEventListener('change', render);
els.fetchAllBtn.addEventListener('click', fetchAllMeta);
els.civitaiBtn.addEventListener('click', () => civitaiImport.open('lora'));
els.metaApplyBtn.addEventListener('click', applyMeta);
els.metaDialog.addEventListener('close', () => { metaTarget = null; });

window.addEventListener('pagehide', () => {
  flushSaves();
  deviceSync.flush(); // 送信待ちの同期があれば離脱前に送っておく
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSaves();
  else deviceSync.pull();
});

render();
deviceSync.pull();
