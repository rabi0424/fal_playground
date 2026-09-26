'use strict';

/* ==========================================================================
 * ライブラリ管理（LoRA・モデル・エンドポイント）
 *
 * 登録済み LoRA の表示名・トリガーワード・既定 scale などを一覧で編集する別画面。
 * モデル（チェックポイント。ckpt-library.js）とエンドポイント（各画面の
 * モデル／プロバイダの呼び出し先。endpoint-library.js）も同じ一覧に並べ、
 * ★（候補の先頭へ）と非表示（候補から外す）を同じ操作で付けられる。
 * 種類はタブで分けず、絞り込みのチップの 1 つとして扱う。
 *
 * - 保存先は本体（app.js）と同じ localStorage の 'fal_lora_library'。
 *   項目はすべて任意で、path と name しか持たない古いデータもそのまま扱える
 * - path（ダウンロード URL）はこの LoRA の識別子。生成時に Modal へ渡す名前も
 *   path から作るため、ここでは絶対に書き換えない（label は表示専用）
 * - トリガーワード等は、Civitai 取り込み時にモデルの隣へ保存した
 *   <ファイル名>.civitai.json を Worker 経由（/api/lora/meta）で読んで補完する
 * ========================================================================== */

/* ---------- constants ---------- */

const SAVE_DELAY_MS = 400; // 入力が落ち着いてから保存する
const HF_DEFAULT_REPO = 'tottie2215/temp_str'; // 取り込み先の既定（app.js と同じ）

/* ---------- helpers ---------- */

const $ = (sel) => document.querySelector(sel);

const els = {
  searchInput: $('#searchInput'),
  kindChips: $('#kindChips'),
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
  bulkBar: $('#bulkBar'),
  bulkCount: $('#bulkCount'),
  bulkBaseLabel: $('#bulkBaseLabel'),
  bulkBaseSelect: $('#bulkBaseSelect'),
  bulkApplyBtn: $('#bulkApplyBtn'),
  bulkHideBtn: $('#bulkHideBtn'),
  bulkShowBtn: $('#bulkShowBtn'),
  bulkAllBtn: $('#bulkAllBtn'),
  bulkClearBtn: $('#bulkClearBtn'),
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
let ckpts = ckptLib.load();
let kind = 'all'; // 'all' | 'lora' | 'ckpt' | 'endpoint'
let filter = 'all'; // 'all' | 'fav' | 'todo' | 'hidden' | `base:<名前>`
let expanded = null; // 展開中の項目（entry.sel）
const selected = new Set(); // 一括操作で選んでいる項目（entry.sel）
const saveTimers = new Map();
const dirtyKinds = new Set(); // 遅延保存を待っている種類（'lora' | 'ckpt'）

/* ---------- 種類をまたいだ一覧 ---------- */

const KIND_LABELS = { lora: 'LoRA', ckpt: 'モデル', endpoint: 'エンドポイント' };
// 名前順で種類をまたいで並べるときの順（件数の少ないものを上に）
const KIND_ORDER = { endpoint: 0, ckpt: 1, lora: 2 };

// 一覧の 1 行。sel は種類をまたいで一意な識別子（選択・展開に使う）
function makeEntry(kindName, id, item) {
  return { kind: kindName, id, item, sel: `${kindName}\t${id}` };
}

// エンドポイントは印だけを持つので、一覧（カタログ）と印を合わせて行にする
function endpointItems() {
  return endpointLib.catalog().map((e) => ({
    ...e,
    fav: endpointLib.isFav(e.key),
    hidden: endpointLib.isHidden(e.key),
  }));
}

function allEntries() {
  return [
    ...library.map((i) => makeEntry('lora', i.path, i)),
    ...ckpts.map((i) => makeEntry('ckpt', i.path, i)),
    ...endpointItems().map((i) => makeEntry('endpoint', i.key, i)),
  ];
}

function entryName(entry) {
  if (entry.kind === 'lora') return entryLabel(entry.item);
  if (entry.kind === 'ckpt') return ckptLib.labelOf(entry.item);
  return entry.item.name;
}

// 絞り込みのチップに使う「ベースモデル」の表記
function entryBase(entry) {
  if (entry.kind === 'lora') return entry.item.base || '';
  if (entry.kind === 'ckpt') return ckptLib.baseLabel(ckptLib.baseOf(entry.item));
  return '';
}

function saveCkpts() {
  ckptLib.save(ckpts);
}

/* ---------- ベースモデルの選択肢 ---------- */

// ライブラリで実際に使われている表記。Civitai 由来の "Qwen-Image" のように
// 代表名と違う文字列も候補に残す（選び直したときに消えてしまわないように）
function usedBases() {
  return [...new Set(library.map((i) => i.base).filter(Boolean))].sort();
}

// <select> を作る。**selected は必ず候補に含める**（一致する option が無い値を
// 代入すると空へ落ち、既存の値が黙って消えるため）。空の選択肢は「指定しない」
function fillBaseSelect(select, selectedValue) {
  select.innerHTML = '';
  for (const label of loraLib.baseChoices(selectedValue, usedBases())) {
    const opt = document.createElement('option');
    opt.value = label;
    opt.textContent = label;
    select.appendChild(opt);
  }
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '指定しない';
  select.appendChild(none);
  select.value = selectedValue || '';
}

/* ---------- 一括操作 ---------- */

// 選択を種類ごとに分ける
function selectedByKind() {
  const out = { lora: [], ckpt: [], endpoint: [] };
  for (const sel of selected) {
    const [k, id] = sel.split('\t');
    out[k]?.push(id);
  }
  return out;
}

function renderBulkBar() {
  // ライブラリから消えたものが選択に残らないようにする
  const alive = new Set(allEntries().map((e) => e.sel));
  for (const sel of [...selected]) {
    if (!alive.has(sel)) selected.delete(sel);
  }
  els.bulkBar.hidden = selected.size === 0;
  if (selected.size === 0) return;
  els.bulkCount.textContent = `${selected.size} 件を選択中`;
  // ベースモデルの一括変更は LoRA だけ（モデルの系統は取り違えると危ないので 1 件ずつ）
  const loraCount = selectedByKind().lora.length;
  els.bulkBaseLabel.hidden = loraCount === 0;
  els.bulkApplyBtn.hidden = loraCount === 0;
  els.bulkApplyBtn.textContent = `選択した LoRA ${loraCount} 件に反映`;
  // いま見ている一覧で意味のあるほうだけ出す（非表示の一覧に「非表示にする」は要らない）
  els.bulkHideBtn.hidden = filter === 'hidden';
  els.bulkShowBtn.hidden = filter !== 'hidden';
  // 開き直すたびに選び直させない。今の選択を保ったまま候補だけ作り直す
  fillBaseSelect(els.bulkBaseSelect, els.bulkBaseSelect.value);
}

function applyBulkBase() {
  const base = els.bulkBaseSelect.value.trim();
  const paths = selectedByKind().lora;
  if (paths.length === 0) return;
  for (const path of paths) {
    const item = library.find((i) => i.path === path);
    if (item) item.base = base;
  }
  // 一括はまとめて即保存する（入力のたびの遅延保存とは別扱い）
  saveLibrary(library);
  setStatus(`${paths.length} 件のベースモデルを「${base || '指定しない'}」にしました`, true);
  render();
}

// 一括で非表示にする / 戻す。保存は loraLib 側で 1 回にまとまる
function applyBulkHidden(on) {
  if (selected.size === 0) return;
  flushSaves(); // 書きかけの編集を先に確定させる（読み直しで消さないため）
  const by = selectedByKind();
  let changed = 0;
  try {
    changed += by.lora.length ? loraLib.setHiddenMany(by.lora, on) : 0;
    changed += by.ckpt.length ? ckptLib.setHiddenMany(by.ckpt, on) : 0;
    changed += by.endpoint.length ? endpointLib.setHiddenMany(by.endpoint, on) : 0;
  } catch (err) {
    setError(err.message);
  }
  library = loadLibrary();
  ckpts = ckptLib.load();
  // 隠したものは今の一覧から消えるので、選択も外して操作バーを残さない
  if (on && filter !== 'hidden') selected.clear();
  if (!on && filter === 'hidden') selected.clear();
  setStatus(changed === 0
    ? (on ? '選択した項目はすべて非表示です' : '選択した項目はすべて表示中です')
    : `${changed} 件を${on ? '非表示にしました' : '候補に戻しました'}`, true);
  render();
}

function initBulkBar() {
  els.bulkApplyBtn.addEventListener('click', applyBulkBase);
  els.bulkHideBtn.addEventListener('click', () => applyBulkHidden(true));
  els.bulkShowBtn.addEventListener('click', () => applyBulkHidden(false));
  els.bulkAllBtn.addEventListener('click', () => {
    for (const entry of visibleEntries()) selected.add(entry.sel);
    render();
  });
  els.bulkClearBtn.addEventListener('click', () => {
    selected.clear();
    render();
  });
}

function saveKind(k) {
  if (k === 'ckpt') saveCkpts();
  else saveLibrary(library);
}

// 入力のたびに保存すると同期が騒がしいので、少し待ってからまとめて書く。
// kind は 'lora'（既定）か 'ckpt'。エンドポイントの印は endpointLib が即保存する
function scheduleSave(path, mutate, k = 'lora') {
  const items = k === 'ckpt' ? ckpts : library;
  const item = items.find((l) => l.path === path);
  if (!item) return;
  mutate(item);
  const timerKey = `${k}\t${path}`;
  dirtyKinds.add(k);
  clearTimeout(saveTimers.get(timerKey));
  saveTimers.set(timerKey, setTimeout(() => {
    saveTimers.delete(timerKey);
    // 同じ種類の保存待ちが残っていれば、最後のものがまとめて書く
    if ([...saveTimers.keys()].some((key) => key.startsWith(`${k}\t`))) return;
    dirtyKinds.delete(k);
    saveKind(k);
  }, SAVE_DELAY_MS));
}

function flushSaves() {
  if (saveTimers.size === 0) return;
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
  for (const k of dirtyKinds) saveKind(k);
  dirtyKinds.clear();
}

function matchesSearch(entry, q) {
  if (!q) return true;
  const { item } = entry;
  const hay = [entryName(entry), item.name, item.trigger, item.note, entryBase(entry), item.path, item.key,
    ...(item.screens ?? []).map((sc) => endpointLib.screenLabel(sc))]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

const isTodo = (entry) => entry.kind === 'lora' && needsAttention(entry.item);

// 種類のチップで絞った一覧（ほかのチップの件数はこの中で数える）
function kindEntries() {
  const all = allEntries();
  return kind === 'all' ? all : all.filter((e) => e.kind === kind);
}

// 非表示にしたものは、ほかの画面の候補からも、この一覧の既定の表示からも外す。
// 「非表示」フィルタがそれらを見る（＝戻す）ための場所
function visibleEntries() {
  const q = els.searchInput.value.trim().toLowerCase();
  let entries = kindEntries().filter((e) => matchesSearch(e, q));
  entries = entries.filter((e) => (filter === 'hidden' ? e.item.hidden : !e.item.hidden));
  if (filter === 'fav') entries = entries.filter((e) => e.item.fav);
  else if (filter === 'todo') entries = entries.filter(isTodo);
  else if (filter.startsWith('base:')) {
    const base = filter.slice('base:'.length);
    entries = entries.filter((e) => entryBase(e) === base);
  }

  const sort = els.sortSelect.value;
  return entries.sort((a, b) => {
    if (sort === 'added') return (b.item.addedAt || 0) - (a.item.addedAt || 0);
    if (sort === 'scale') return (b.item.scale ?? 1) - (a.item.scale ?? 1);
    // 名前順。お気に入りは先頭に集める（各画面のプルダウンと同じ並び）
    if (!!a.item.fav !== !!b.item.fav) return a.item.fav ? -1 : 1;
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return loraLib.compareLabels(entryName(a), entryName(b));
  });
}

/* ---------- 描画 ---------- */

function renderKindChips() {
  const all = allEntries();
  const count = (k) => all.filter((e) => (k === 'all' || e.kind === k) && !e.item.hidden).length;
  els.kindChips.innerHTML = '';
  for (const k of ['all', 'lora', 'ckpt', 'endpoint']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lib-chip lib-kind-chip';
    btn.classList.toggle('on', kind === k);
    btn.setAttribute('aria-pressed', String(kind === k));
    btn.textContent = `${k === 'all' ? 'すべて' : KIND_LABELS[k]} ${count(k)}`;
    btn.addEventListener('click', () => {
      if (kind === k) return;
      kind = k;
      // 種類が変わると意味を失う絞り込み（要整理・ベースモデル）は外す
      if (filter === 'todo' || filter.startsWith('base:')) filter = 'all';
      render();
    });
    els.kindChips.appendChild(btn);
  }
}

function renderFilters() {
  renderKindChips();
  // 件数は「非表示を除いたもの」で数える（一覧に出る数と合わせる）。
  // 「非表示」チップだけが非表示のものを数え、押すとそれだけを見せる
  const inKind = kindEntries();
  const shown = inKind.filter((e) => !e.item.hidden);
  const bases = [...new Set(shown.map(entryBase).filter(Boolean))].sort();
  const chips = [
    { key: 'all', label: 'すべて', count: shown.length },
    { key: 'fav', label: '★', count: shown.filter((e) => e.item.fav).length },
    { key: 'todo', label: '要整理', count: shown.filter(isTodo).length },
    { key: 'hidden', label: '非表示', count: inKind.filter((e) => e.item.hidden).length },
    ...bases.map((b) => ({ key: `base:${b}`, label: b, count: shown.filter((e) => entryBase(e) === b).length })),
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
  renderBulkBar();
  els.list.innerHTML = '';

  const entries = visibleEntries();
  for (const entry of entries) els.list.appendChild(renderEntry(entry));

  els.empty.hidden = entries.length > 0;
  if (kind === 'lora' && library.length === 0) {
    els.empty.textContent = 'まだ LoRA が登録されていません。生成画面の「Hugging Face から一括登録」や「Civitai から取り込み」で追加してください。';
  } else if (kind === 'ckpt' && ckpts.length === 0) {
    els.empty.textContent = 'まだモデル（チェックポイント）が登録されていません。生成画面でチェックポイント指定版を選び、「チェックポイント」欄から登録してください。';
  } else {
    els.empty.textContent = '条件に合う項目がありません。';
  }
  els.fetchAllBtn.disabled = library.filter((i) => needsAttention(i) && isHfPath(i.path)).length === 0;
  // 取り込み・情報の取得は LoRA（とモデル）のもの。エンドポイントだけを見ているときは出さない
  els.civitaiBtn.hidden = kind === 'endpoint';
  els.fetchAllBtn.hidden = kind === 'endpoint' || kind === 'ckpt';
}

function renderEntry(entry) {
  if (entry.kind === 'ckpt') return renderCkptCard(entry);
  if (entry.kind === 'endpoint') return renderEndpointCard(entry);
  return renderCard(entry);
}

function badge(text, cls = '') {
  const el = document.createElement('span');
  el.className = `lib-badge${cls ? ` ${cls}` : ''}`;
  el.textContent = text;
  return el;
}

// ★・非表示の付け外し。LoRA / モデルは遅延保存、エンドポイントは即保存
function toggleFlag(entry, flag) {
  if (entry.kind === 'endpoint') {
    try {
      if (flag === 'fav') endpointLib.toggleFav(entry.id);
      else endpointLib.toggleHidden(entry.id);
    } catch (err) {
      setError(err.message);
    }
    return;
  }
  scheduleSave(entry.id, (i) => {
    if (i[flag]) delete i[flag];
    else i[flag] = true;
  }, entry.kind);
}

// 見出し行（種類をまたいで共通）。一括選択・★・非表示・名前・バッジ
function renderHead(entry, { expandable = true } = {}) {
  const { item } = entry;
  const head = document.createElement('div');
  head.className = 'lib-card-head';

  // 一括操作用のチェックボックス。見出し行のクリックは展開に使われているので、
  // ここでイベントを止めて取り合わないようにする
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'lib-check';
  check.checked = selected.has(entry.sel);
  check.title = '一括操作の対象にする';
  check.addEventListener('click', (e) => e.stopPropagation());
  check.addEventListener('change', () => {
    if (check.checked) selected.add(entry.sel);
    else selected.delete(entry.sel);
    renderBulkBar();
  });
  head.appendChild(check);

  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'lib-star';
  star.classList.toggle('on', !!item.fav);
  star.textContent = '★';
  star.title = item.fav ? 'お気に入りから外す' : 'お気に入りに入れる（候補の先頭に並びます）';
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFlag(entry, 'fav');
    render();
  });
  head.appendChild(star);

  // 非表示の付け外し。削除と違ってレコードは残るので、情報を失わずに畳める
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'lib-eye';
  eye.classList.toggle('on', !!item.hidden);
  eye.textContent = item.hidden ? '🚫' : '👁';
  eye.title = item.hidden
    ? '候補に戻す'
    : '候補から隠す（登録は残ります。ほかの画面のプルダウンから消えます）';
  eye.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFlag(entry, 'hidden');
    render();
  });
  head.appendChild(eye);

  const name = document.createElement('span');
  name.className = 'lib-name';
  name.textContent = entryName(entry);
  head.appendChild(name);

  // 種類をまたいで並べているときだけ、何の行かを添える
  if (kind === 'all') head.appendChild(badge(KIND_LABELS[entry.kind], `kind-${entry.kind}`));
  if (item.hidden) head.appendChild(badge('非表示'));

  if (expandable) {
    head.addEventListener('click', () => {
      expanded = expanded === entry.sel ? null : entry.sel;
      render();
      if (expanded) {
        document.querySelector('.lib-card.open')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  } else {
    head.classList.add('static');
  }
  return head;
}

function newCard(entry) {
  const card = document.createElement('div');
  card.className = 'lib-card';
  if (expanded === entry.sel) card.classList.add('open');
  if (entry.item.hidden) card.classList.add('is-hidden');
  return card;
}

function renderCard(entry) {
  const { item } = entry;
  const card = newCard(entry);
  const head = renderHead(entry);

  // ベースモデルと「まだ情報を取っていない」ことは別の情報なので両方出す
  if (item.base) head.appendChild(badge(item.base, 'base'));
  if (needsAttention(item)) head.appendChild(badge('トリガー未取得', 'warn'));
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

  if (expanded === entry.sel) card.appendChild(renderEditor(item));
  return card;
}

/* ---------- モデル（チェックポイント） ---------- */

function renderCkptCard(entry) {
  const { item } = entry;
  const card = newCard(entry);
  const head = renderHead(entry);
  head.appendChild(badge(ckptLib.baseLabel(ckptLib.baseOf(item)), 'base'));
  card.appendChild(head);

  const sub = document.createElement('div');
  sub.className = 'lib-sub';
  const fileName = ckptLib.displayName(item.path);
  sub.textContent = [
    fileName === entryName(entry) ? null : fileName,
    item.addedAt ? `${formatDate(item.addedAt)} 追加` : null,
    item.note || null,
  ].filter(Boolean).join(' ・ ') || 'チェックポイント（UNet）';
  card.appendChild(sub);

  if (expanded === entry.sel) card.appendChild(renderCkptEditor(item));
  return card;
}

function renderCkptEditor(item) {
  const box = document.createElement('div');
  box.className = 'lib-editor';
  const save = (mutate) => scheduleSave(item.path, mutate, 'ckpt');

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.value = item.label || '';
  labelInput.placeholder = item.name || ckptLib.displayName(item.path);
  labelInput.addEventListener('input', () => {
    save((i) => { i.label = labelInput.value; });
    box.closest('.lib-card').querySelector('.lib-name').textContent = ckptLib.labelOf({ ...item, label: labelInput.value });
  });
  box.appendChild(field('表示名', labelInput,
    'プルダウンとこの一覧に出る名前です。生成時に送られるファイルは変わりません。'));

  // 系統は取り違えるとエラーにならずに噛み合わない絵が出るので、選択式に限る
  const baseSelect = document.createElement('select');
  for (const b of ckptLib.baseKinds()) {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = ckptLib.baseLabel(b);
    baseSelect.appendChild(opt);
  }
  baseSelect.value = ckptLib.baseOf(item);
  baseSelect.addEventListener('change', () => {
    save((i) => { i.base = baseSelect.value; });
    render();
  });
  box.appendChild(field('系統', baseSelect,
    'このチェックポイントを候補に出すモデルの系統です。別系統のモデルには渡せません。'));

  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.value = item.note || '';
  noteInput.placeholder = '例: 学習 5000 step 版';
  noteInput.addEventListener('input', () => {
    save((i) => { i.note = noteInput.value; });
  });
  box.appendChild(field('メモ', noteInput));

  const pathBox = document.createElement('div');
  pathBox.className = 'lib-path';
  pathBox.textContent = item.path;
  box.appendChild(field('ファイル', pathBox));

  const actions = document.createElement('div');
  actions.className = 'lib-actions';
  actions.appendChild(copyButton(item.path));
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  actions.appendChild(spacer);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'ghost-btn small lib-danger';
  delBtn.textContent = '削除';
  delBtn.addEventListener('click', () => {
    const name = ckptLib.labelOf(item);
    if (!confirm(`「${name}」をライブラリから削除します。よろしいですか？\n（モデルのファイル自体は消えません）`)) return;
    flushSaves();
    ckpts = ckpts.filter((c) => c.path !== item.path);
    expanded = null;
    saveCkpts();
    render();
    setStatus(`「${name}」を削除しました`, true);
  });
  actions.appendChild(delBtn);

  box.appendChild(actions);
  return box;
}

/* ---------- エンドポイント ---------- */

// 呼び出し先そのものはコードが持つので、ここで変えられるのは★と非表示だけ
function renderEndpointCard(entry) {
  const { item } = entry;
  const card = newCard(entry);
  const head = renderHead(entry, { expandable: false });
  for (const screen of item.screens) head.appendChild(badge(endpointLib.screenLabel(screen), 'base'));
  card.appendChild(head);

  const sub = document.createElement('div');
  sub.className = 'lib-sub';
  sub.textContent = item.key;
  card.appendChild(sub);
  return card;
}

function copyButton(text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost-btn small';
  btn.textContent = 'URL をコピー';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'コピーしました';
      setTimeout(() => { btn.textContent = 'URL をコピー'; }, 1500);
    } catch {
      setError('コピーできませんでした（ブラウザの許可が必要です）');
    }
  });
  return btn;
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
    'カンマ区切り。生成画面と画像編集の「挿入」でプロンプトに足せます。'));

  /* トリガーワードの入れ方 */
  // 位置と自動挿入は 1 組で考えるものなので、同じ欄にまとめる
  const trigOpts = document.createElement('div');
  trigOpts.className = 'lib-trigger-opts';

  const placeSelect = document.createElement('select');
  for (const [value, text] of [['end', '末尾に足す（既定）'], ['head', '冒頭に足す']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    placeSelect.appendChild(opt);
  }
  placeSelect.value = item.triggerPlace === 'head' ? 'head' : 'end';
  placeSelect.addEventListener('change', () => {
    scheduleSave(item.path, (i) => {
      if (placeSelect.value === 'head') i.triggerPlace = 'head';
      else delete i.triggerPlace;
    });
  });
  trigOpts.appendChild(placeSelect);

  const autoLabel = document.createElement('label');
  autoLabel.className = 'check-row';
  const autoCheck = document.createElement('input');
  autoCheck.type = 'checkbox';
  autoCheck.checked = !!item.triggerAuto;
  autoCheck.addEventListener('change', () => {
    scheduleSave(item.path, (i) => {
      if (autoCheck.checked) i.triggerAuto = true;
      else delete i.triggerAuto;
    });
  });
  const autoText = document.createElement('span');
  autoText.textContent = 'この LoRA を選んだら自動で入れる';
  autoLabel.append(autoCheck, autoText);
  trigOpts.appendChild(autoLabel);

  box.appendChild(field('トリガーワードの入れ方', trigOpts,
    '自動挿入は、LoRA 行に追加したときとプルダウンで選び直したときに走ります（すでに書かれている語は足しません）。下書きの復元や履歴からの再利用では走りません。'));

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
  // 自由入力だと表記ゆれがそのまま絞り込みの分裂になるのでプルダウンにする。
  // 既に使われている表記も候補に入るので、取り込み時に付いた名前は残せる
  const baseSelect = document.createElement('select');
  fillBaseSelect(baseSelect, item.base || '');
  baseSelect.addEventListener('change', () => {
    scheduleSave(item.path, (i) => { i.base = baseSelect.value.trim(); });
    // 絞り込みのチップは件数を持つので、変えたらその場で作り直す
    renderFilters();
  });
  box.appendChild(field('ベースモデル', baseSelect,
    '生成画面では、選んだモデルに合うベースモデルの LoRA だけが候補に出ます。'));

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

  actions.appendChild(copyButton(item.path));

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
// 古い HTML を掴んでいると、あとから足した共有スクリプトが読まれない。無ければ一度だけ読み直す
falBoot.requireShared(['ckptLib', 'endpointLib']);
deviceSync.init({
  canApply: () => saveTimers.size === 0,
  onRemote() {
    library = loadLibrary();
    ckpts = ckptLib.load();
    render();
  },
});

loraLib.onChange = () => deviceSync.markDirty('loras');
ckptLib.onChange = () => deviceSync.markDirty('ckpts');
endpointLib.onChange = () => deviceSync.markDirty('endpoints');
loraLib.migrate();
library = loadLibrary(); // 移行後の内容で描画する

// この画面からも Civitai 取り込みができる（登録したらその場で一覧に出す）
civitaiImport.init({
  defaultRepo: HF_DEFAULT_REPO,
  register(importKind, hfUrl, meta) {
    if (importKind === 'ckpt') {
      ckptLib.register(hfUrl);
      ckpts = ckptLib.load();
      render();
      return `モデルライブラリに登録しました: ${ckptLib.label(hfUrl)}`;
    }
    loraLib.register(hfUrl, meta);
    library = loadLibrary();
    render();
    return `ライブラリに登録しました: ${loraLib.label(hfUrl)}`;
  },
});


els.searchInput.addEventListener('input', render);
els.sortSelect.addEventListener('change', render);
initBulkBar();
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
