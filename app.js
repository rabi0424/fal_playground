'use strict';

/* ---------- constants ---------- */

// Modal 自前ホスト版 Krea 2（modal_comfy リポジトリ）。fal ではなく
// Worker のプロキシ（/api/krea2/generate）経由で生成する。
// エンドポイントは実験版（exp）と本番の 2 系統があり、標準は実験版
const MODAL_KREA2_EXP_ID = 'modal/krea2-turbo-exp';
const MODAL_KREA2_ID = 'modal/krea2-turbo';

const MODELS = [
  { id: 'fal-ai/krea-2/turbo/lora', name: 'Krea 2 [turbo] LoRA', sizeParam: 'image_size', lora: true, maxLoras: 3 },
  { id: MODAL_KREA2_EXP_ID, name: 'Krea 2 [turbo] 自前ホスト（Modal 実験版）', sizeParam: 'image_size', lora: true, provider: 'modal', modalEndpoint: 'exp' },
  { id: MODAL_KREA2_ID, name: 'Krea 2 [turbo] 自前ホスト（Modal 本番）', sizeParam: 'image_size', lora: true, provider: 'modal', modalEndpoint: 'prod' },
  { id: 'fal-ai/flux/schnell', name: 'FLUX.1 [schnell]（高速・安価）', sizeParam: 'image_size' },
  { id: 'fal-ai/flux/dev', name: 'FLUX.1 [dev]', sizeParam: 'image_size' },
  { id: 'fal-ai/flux-pro/v1.1', name: 'FLUX1.1 [pro]', sizeParam: 'image_size' },
  { id: 'fal-ai/flux-pro/v1.1-ultra', name: 'FLUX1.1 [pro] ultra', sizeParam: 'aspect_ratio' },
  { id: 'fal-ai/recraft/v3/text-to-image', name: 'Recraft V3', sizeParam: 'image_size' },
  { id: '__custom__', name: 'カスタム…', sizeParam: 'image_size', lora: true },
];

// fal のプリセット列挙（square: 512×512 など）は小さすぎるので使わず、
// 近年のモデルで一般的な約 1MP のピクセル指定を直接送る。
// ratio は aspect_ratio 指定のモデル（ultra 系）用
const SIZES = [
  { value: 'square_1_1', label: '正方形 1:1（1024×1024）', width: 1024, height: 1024, ratio: '1:1' },
  { value: 'landscape_4_3', label: '横長 4:3（1152×896）', width: 1152, height: 896, ratio: '4:3' },
  { value: 'landscape_16_9', label: '横長 16:9（1344×768）', width: 1344, height: 768, ratio: '16:9' },
  { value: 'portrait_3_4', label: '縦長 3:4（896×1152）', width: 896, height: 1152, ratio: '3:4' },
  { value: 'portrait_2_3', label: '縦長 2:3（1024×1536）', width: 1024, height: 1536, ratio: '2:3' },
  { value: 'portrait_9_16', label: '縦長 9:16（768×1344）', width: 768, height: 1344, ratio: '9:16' },
];

const CUSTOM_SIZE = '__custom_size__';
const DIM_MIN = 256;
const DIM_MAX = 2048;
const DIM_STEP = 8;

const LS_HISTORY = 'fal_history'; // サーバー履歴の表示用キャッシュ
const LS_HISTORY_MIGRATED = 'fal_history_migrated';
const LS_THEME = 'fal_theme';
const LS_LORAS = 'fal_lora_library';
const LS_FORM = 'fal_form_state';
const LS_JOB = 'fal_active_job';
const LORA_URL_OPTION = '__url__';
const POLL_INTERVAL_MS = 900;

/* ---------- helpers ---------- */

const $ = (sel) => document.querySelector(sel);

// モバイルレイアウト判定（style.css のブレークポイントと合わせる）
const MOBILE_MQ = window.matchMedia('(max-width: 430px)');

const els = {
  themeBtn: $('#themeBtn'),
  modelSelect: $('#modelSelect'),
  customModelField: $('#customModelField'),
  customModel: $('#customModel'),
  prompt: $('#prompt'),
  loraField: $('#loraField'),
  loraLabel: $('#loraLabel'),
  loraList: $('#loraList'),
  addLoraBtn: $('#addLoraBtn'),
  hfOpenBtn: $('#hfOpenBtn'),
  hfDialog: $('#hfDialog'),
  hfRepoInput: $('#hfRepoInput'),
  hfLoadBtn: $('#hfLoadBtn'),
  hfStatus: $('#hfStatus'),
  hfError: $('#hfError'),
  hfList: $('#hfList'),
  hfAddBtn: $('#hfAddBtn'),
  compareToggle: $('#compareToggle'),
  compareField: $('#compareField'),
  variantList: $('#variantList'),
  addVariantBtn: $('#addVariantBtn'),
  lightbox: $('#lightbox'),
  lightboxClose: $('#lightboxClose'),
  lightboxCounter: $('#lightboxCounter'),
  sizeSelect: $('#sizeSelect'),
  customSizeField: $('#customSizeField'),
  customWidth: $('#customWidth'),
  customHeight: $('#customHeight'),
  swapSizeBtn: $('#swapSizeBtn'),
  mpReadout: $('#mpReadout'),
  numImages: $('#numImages'),
  seed: $('#seed'),
  steps: $('#steps'),
  guidance: $('#guidance'),
  generateBtn: $('#generateBtn'),
  cancelBtn: $('#cancelBtn'),
  status: $('#status'),
  error: $('#error'),
  detail: $('#detail'),
  gallery: $('#gallery'),
  clearHistoryBtn: $('#clearHistoryBtn'),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Cloudflare Access のセッション切れは API がログインページ（HTML）への
// リダイレクトになるので、それを検出して案内する
const ACCESS_EXPIRED_MSG = 'ログインセッションが切れています。ページを再読み込みしてサインインし直してください。';

function isHtmlResponse(res) {
  return (res.headers.get('Content-Type') || '').includes('text/html');
}

/* ---------- history（サーバーが正・localStorage は表示キャッシュ） ---------- */

let historyCache = [];

function loadHistory() {
  return historyCache;
}

function persistHistoryCache() {
  try {
    localStorage.setItem(LS_HISTORY, JSON.stringify(historyCache));
  } catch {
    // 容量超過などは無視（サーバー側が正なので失っても支障ない）
  }
}

async function fetchHistoryFromServer() {
  let res;
  try {
    res = await fetch('/api/history');
  } catch {
    return; // オフラインなどはキャッシュ表示のまま
  }
  if (!res.ok || isHtmlResponse(res)) return;
  const server = await res.json().catch(() => null);
  if (!Array.isArray(server)) return;

  // 旧バージョンのローカル履歴が残っていてサーバーが空なら、一度だけ取り込む
  if (server.length === 0 && historyCache.length > 0 && !localStorage.getItem(LS_HISTORY_MIGRATED)) {
    localStorage.setItem(LS_HISTORY_MIGRATED, '1');
    for (const record of [...historyCache].reverse()) {
      try {
        await fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
        });
      } catch {
        // 移行できなかった分は諦める（fal CDN の失効済み画像など）
      }
    }
    return fetchHistoryFromServer();
  }

  // サーバーが空で手元に表示中の履歴があるときは消さない（移行直後の失敗対策）
  if (server.length > 0 || historyCache.length === 0) {
    historyCache = server;
    persistHistoryCache();
    renderGallery();
  }
}

// 生成完了時に呼ぶ。即座にローカルへ反映し、サーバーへは裏で保存する。
// fal の CDN 画像はサーバー側で失効しない URL に取り込まれるため、応答で差し替える
function addHistoryRecord(record) {
  historyCache.unshift(record);
  persistHistoryCache();
  (async () => {
    try {
      const res = await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
      if (!res.ok || isHtmlResponse(res)) return;
      const saved = await res.json();
      const i = historyCache.findIndex((r) => r.id === saved.id);
      if (i !== -1) historyCache[i] = saved;
      persistHistoryCache();
      if (selectedId === saved.id) renderDetail(saved);
      else renderGallery();
    } catch {
      // オフライン時など。次回起動時のサーバー取得で整合する
    }
  })();
}

function deleteHistoryRecord(id) {
  historyCache = historyCache.filter((r) => r.id !== id);
  persistHistoryCache();
  fetch(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

function clearHistory() {
  historyCache = [];
  persistHistoryCache();
  fetch('/api/history', { method: 'DELETE' }).catch(() => {});
}

/* ---------- theme ---------- */

const THEME_LABELS = { auto: '自動', light: 'ライト', dark: 'ダーク' };
const THEME_ORDER = ['auto', 'light', 'dark'];

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeBtn.textContent = THEME_LABELS[theme];
}

function initTheme() {
  applyTheme(localStorage.getItem(LS_THEME) || 'auto');
  els.themeBtn.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
    localStorage.setItem(LS_THEME, next);
    applyTheme(next);
  });
}

/* ---------- form ---------- */

function initForm() {
  for (const m of MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    els.modelSelect.appendChild(opt);
  }
  for (const s of SIZES) {
    const opt = document.createElement('option');
    opt.value = s.value;
    opt.textContent = s.label;
    els.sizeSelect.appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = CUSTOM_SIZE;
  customOpt.textContent = 'カスタム（px 指定）';
  els.sizeSelect.appendChild(customOpt);

  els.modelSelect.addEventListener('change', updateModelFields);
  els.sizeSelect.addEventListener('change', updateCustomSize);
  els.customWidth.addEventListener('input', updateMpReadout);
  els.customHeight.addEventListener('input', updateMpReadout);
  els.customWidth.addEventListener('change', () => snapDimInput(els.customWidth));
  els.customHeight.addEventListener('change', () => snapDimInput(els.customHeight));
  els.swapSizeBtn.addEventListener('click', swapDimensions);
  updateModelFields();
}

function updateModelFields() {
  const model = MODELS.find((m) => m.id === els.modelSelect.value) || MODELS[0];
  els.customModelField.hidden = model.id !== '__custom__';
  els.loraField.hidden = !model.lora;

  // Modal 版は fal のキュー API を使わないため比較モード非対応
  const isModal = model.provider === 'modal';
  els.compareToggle.closest('.compare-toggle').hidden = isModal;

  // LoRA 非対応モデル・Modal 版では比較モードを使えないので強制的に解除
  if ((!model.lora || isModal) && compareMode) setCompareMode(false);

  // Modal 版のデフォルト値・範囲は API の仕様（INTEGRATION.md）に合わせて案内する
  els.steps.placeholder = isModal ? '8（変更非推奨）' : 'デフォルト';
  els.guidance.placeholder = isModal ? '1（0〜1）' : 'デフォルト';

  // aspect_ratio 系モデルはピクセル指定に非対応なのでカスタムを出さない
  const supportsCustom = model.sizeParam !== 'aspect_ratio';
  const customOpt = [...els.sizeSelect.options].find((o) => o.value === CUSTOM_SIZE);
  if (customOpt) customOpt.hidden = !supportsCustom;
  if (!supportsCustom && els.sizeSelect.value === CUSTOM_SIZE) {
    els.sizeSelect.value = SIZES[0].value;
  }
  updateCustomSize();
}

/* ---------- custom resolution ---------- */

function snapDim(value) {
  const n = Math.round(Number(value) / DIM_STEP) * DIM_STEP;
  return Math.min(DIM_MAX, Math.max(DIM_MIN, n || DIM_MIN));
}

function snapDimInput(input) {
  input.value = String(snapDim(input.value));
  updateMpReadout();
}

function updateMpReadout() {
  const mp = (Number(els.customWidth.value) * Number(els.customHeight.value)) / 1_000_000;
  els.mpReadout.textContent = `${mp.toFixed(1)} MP`;
}

function swapDimensions() {
  const w = els.customWidth.value;
  els.customWidth.value = els.customHeight.value;
  els.customHeight.value = w;
  updateMpReadout();
}

function updateCustomSize() {
  const isCustom = els.sizeSelect.value === CUSTOM_SIZE;
  els.customSizeField.hidden = !isCustom;
  if (isCustom) updateMpReadout();
}

/* ---------- LoRA ---------- */

function addLoraRow(path = '', scale = 1, listEl = els.loraList) {
  // 履歴の再利用などで未登録の URL が来たら自動登録
  if (path) registerLora(path);

  const row = document.createElement('div');
  row.className = 'lora-row';

  const head = document.createElement('div');
  head.className = 'lora-head';

  const select = document.createElement('select');
  select.className = 'lora-select';
  head.appendChild(select);

  const delBtn = document.createElement('button');
  delBtn.className = 'ghost-btn small';
  delBtn.type = 'button';
  delBtn.textContent = '削除';
  delBtn.title = 'この行を削除';
  delBtn.addEventListener('click', () => row.remove());
  head.appendChild(delBtn);

  row.appendChild(head);

  const pathInput = document.createElement('input');
  pathInput.className = 'lora-path';
  pathInput.type = 'text';
  pathInput.placeholder = 'https://…/xxx.safetensors（入力すると自動登録）';
  pathInput.spellcheck = false;
  row.appendChild(pathInput);

  const scaleWrap = document.createElement('div');
  scaleWrap.className = 'lora-scale';

  const scaleLabel = document.createElement('span');
  scaleLabel.className = 'scale-label';
  scaleLabel.textContent = 'scale';
  scaleWrap.appendChild(scaleLabel);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '2';
  slider.step = '0.05';
  slider.value = String(scale);
  scaleWrap.appendChild(slider);

  const num = document.createElement('input');
  num.type = 'number';
  num.min = '0';
  num.max = '2';
  num.step = '0.05';
  num.value = String(scale);
  scaleWrap.appendChild(num);

  slider.addEventListener('input', () => { num.value = slider.value; });
  num.addEventListener('input', () => { slider.value = num.value; });

  const unregBtn = document.createElement('button');
  unregBtn.className = 'ghost-btn small lora-unreg';
  unregBtn.type = 'button';
  unregBtn.textContent = '登録解除';
  unregBtn.title = 'この LoRA を一覧から外す';
  unregBtn.addEventListener('click', () => {
    const current = select.value;
    if (current === LORA_URL_OPTION) return;
    unregisterLora(current);
    pathInput.value = current; // URL 入力モードに戻して値は残す
    syncLoraRow(row);
  });
  scaleWrap.appendChild(unregBtn);

  row.appendChild(scaleWrap);

  const initial = path || loadLoraLibrary()[0]?.path || LORA_URL_OPTION;
  populateLoraSelect(select, initial);
  select.addEventListener('change', () => syncLoraRow(row));

  // URL を入力したら自動登録して、その項目を選択状態にする
  pathInput.addEventListener('change', () => {
    const value = pathInput.value.trim();
    if (!value) return;
    registerLora(value);
    populateLoraSelect(select, value);
    pathInput.value = '';
    syncLoraRow(row);
  });

  listEl.appendChild(row);
  syncLoraRow(row);
}

function loadLoraLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LS_LORAS)) || [];
  } catch {
    return [];
  }
}

function saveLoraLibrary(items) {
  localStorage.setItem(LS_LORAS, JSON.stringify(items));
  syncMarkDirty('loras');
}

// URL からファイル名を取り出す（.safetensors は表示しない）
function loraDisplayName(path) {
  const seg = path.split('?')[0].split('/').filter(Boolean).pop() || path;
  try {
    return decodeURIComponent(seg).replace(/\.safetensors$/i, '');
  } catch {
    return seg.replace(/\.safetensors$/i, '');
  }
}

function registerLora(path) {
  const library = loadLoraLibrary();
  if (!library.some((item) => item.path === path)) {
    library.push({ name: loraDisplayName(path), path });
    saveLoraLibrary(library);
  }
  refreshLoraSelects();
}

function unregisterLora(path) {
  saveLoraLibrary(loadLoraLibrary().filter((item) => item.path !== path));
  refreshLoraSelects();
}

// 登録済み LoRA（ファイル名表示）+「URL を入力…」でプルダウンを構成する
function populateLoraSelect(select, selected) {
  select.innerHTML = '';
  for (const item of loadLoraLibrary()) {
    const opt = document.createElement('option');
    opt.value = item.path;
    opt.textContent = item.name;
    opt.title = item.path;
    select.appendChild(opt);
  }
  const urlOpt = document.createElement('option');
  urlOpt.value = LORA_URL_OPTION;
  urlOpt.textContent = 'URL を入力…';
  select.appendChild(urlOpt);
  select.value = selected;
  if (select.value !== selected) select.value = LORA_URL_OPTION;
}

function refreshLoraSelects() {
  for (const row of document.querySelectorAll('.lora-row')) {
    const select = row.querySelector('.lora-select');
    populateLoraSelect(select, select.value);
    syncLoraRow(row);
  }
}

function syncLoraRow(row) {
  const urlMode = row.querySelector('.lora-select').value === LORA_URL_OPTION;
  row.querySelector('.lora-path').hidden = !urlMode;
  row.querySelector('.lora-unreg').hidden = urlMode;
}

function collectLorasFrom(listEl) {
  return [...listEl.querySelectorAll('.lora-row')]
    .map((row) => {
      const select = row.querySelector('.lora-select');
      const path = select.value === LORA_URL_OPTION
        ? row.querySelector('.lora-path').value.trim()
        : select.value;
      return {
        path,
        scale: Number(row.querySelector('input[type="number"]').value) || 0,
      };
    })
    // scale 0 は効果ゼロなのに LoRA 枠を消費するので送信対象から除外する
    .filter((l) => l.path !== '' && l.scale > 0);
}

// モデルごとの LoRA 個数上限（未定義なら制限なしとして API 任せ）
function modelLoraLimit() {
  const model = MODELS.find((m) => m.id === els.modelSelect.value);
  return model?.maxLoras ?? Infinity;
}

function collectLoras() {
  return collectLorasFrom(els.loraList);
}

/* ---------- Hugging Face bulk import ---------- */
// 公開リポジトリの .safetensors を一覧表示し、選択したものを LoRA ライブラリに
// 一括登録する。登録のみで、現在の LoRA 設定行には追加しない

function parseHfRepo(raw) {
  const s = raw.trim().replace(/^https?:\/\/huggingface\.co\//, '');
  const parts = s.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

function hfSetStatus(text) {
  els.hfStatus.hidden = !text;
  els.hfStatus.textContent = text || '';
}

function hfSetError(text) {
  els.hfError.hidden = !text;
  els.hfError.textContent = text || '';
}

function hfUpdateAddBtn() {
  const n = els.hfList.querySelectorAll('input:checked:not(:disabled)').length;
  els.hfAddBtn.disabled = n === 0;
  els.hfAddBtn.textContent = `選択した ${n} 件を登録`;
}

async function loadHfRepo() {
  const repo = parseHfRepo(els.hfRepoInput.value);
  if (!repo) {
    hfSetError('リポジトリ ID を owner/repo の形式で入力してください');
    return;
  }
  hfSetError('');
  els.hfList.innerHTML = '';
  hfUpdateAddBtn();
  hfSetStatus('ファイル一覧を取得中…');

  let entries;
  try {
    // huggingface.co を直接叩くと CORS で失敗する環境があるため Worker 経由で取得する
    const res = await fetch(`/api/hf/tree?repo=${encodeURIComponent(repo)}`);
    if (res.status === 401 || res.status === 404) {
      throw new Error('リポジトリが見つかりません（非公開または ID の誤り）');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    entries = await res.json();
  } catch (err) {
    hfSetStatus('');
    hfSetError(`取得に失敗しました: ${err.message}`);
    return;
  }
  hfSetStatus('');

  const files = entries.filter((e) => e.type === 'file' && /\.safetensors$/i.test(e.path));
  if (files.length === 0) {
    hfSetError('このリポジトリに .safetensors ファイルは見つかりませんでした');
    return;
  }

  const registered = new Set(loadLoraLibrary().map((l) => l.path));
  for (const f of files) {
    const url = `https://huggingface.co/${repo}/resolve/main/${f.path}`;
    const done = registered.has(url);

    const item = document.createElement('label');
    item.className = 'hf-item';
    if (done) item.classList.add('registered');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = url;
    cb.checked = done;
    cb.disabled = done;
    item.appendChild(cb);

    const name = document.createElement('span');
    name.className = 'hf-name';
    name.textContent = f.path;
    item.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'hf-meta';
    meta.textContent = done ? '登録済み' : (f.size ? `${(f.size / 1024 / 1024).toFixed(0)} MB` : '');
    item.appendChild(meta);

    els.hfList.appendChild(item);
  }
  hfUpdateAddBtn();
}

function initHfDialog() {
  els.hfOpenBtn.addEventListener('click', () => {
    hfSetError('');
    hfSetStatus('');
    els.hfDialog.showModal();
  });

  els.hfLoadBtn.addEventListener('click', loadHfRepo);

  // Enter で form が「閉じる」ボタンで submit されるのを防いで読み込みにする
  els.hfRepoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      loadHfRepo();
    }
  });

  els.hfList.addEventListener('change', hfUpdateAddBtn);

  els.hfDialog.addEventListener('close', () => {
    if (els.hfDialog.returnValue !== 'add') return;
    const urls = [...els.hfList.querySelectorAll('input:checked:not(:disabled)')]
      .map((cb) => cb.value);
    for (const url of urls) registerLora(url);
  });
}

/* ---------- LoRA compare ---------- */

let compareMode = false;

function setCompareMode(on) {
  compareMode = on;
  els.compareToggle.checked = on;
  els.compareField.hidden = !on;
  els.loraLabel.textContent = on ? '共通 LoRA（全試行に適用）' : 'LoRA';
  els.generateBtn.textContent = on ? '比較生成' : '生成する';
  // 初めて有効化したときは試行を 2 つ用意しておく
  if (on && els.variantList.querySelectorAll('.variant').length === 0) {
    addVariant();
    addVariant();
  }
}

function renumberVariants() {
  const blocks = [...els.variantList.querySelectorAll('.variant')];
  blocks.forEach((block, i) => {
    block.querySelector('.variant-title').textContent = `試行 ${i + 1}`;
  });
}

function addVariant(ownLoras = [], addStarterRow = true) {
  const block = document.createElement('div');
  block.className = 'variant';

  const head = document.createElement('div');
  head.className = 'variant-head';

  const title = document.createElement('span');
  title.className = 'variant-title';
  head.appendChild(title);

  const delBtn = document.createElement('button');
  delBtn.className = 'ghost-btn small';
  delBtn.type = 'button';
  delBtn.textContent = '試行を削除';
  delBtn.addEventListener('click', () => { block.remove(); renumberVariants(); });
  head.appendChild(delBtn);

  block.appendChild(head);

  const list = document.createElement('div');
  list.className = 'lora-list variant-lora-list';
  block.appendChild(list);

  const addLoraBtn = document.createElement('button');
  addLoraBtn.className = 'ghost-btn small';
  addLoraBtn.type = 'button';
  addLoraBtn.textContent = '＋ LoRA を追加';
  addLoraBtn.addEventListener('click', () => addLoraRow('', 1, list));
  block.appendChild(addLoraBtn);

  els.variantList.appendChild(block);

  if (ownLoras.length > 0) {
    for (const l of ownLoras) addLoraRow(l.path, l.scale, list);
  } else if (addStarterRow) {
    addLoraRow('', 1, list);
  }
  renumberVariants();
}

function collectVariants() {
  return [...els.variantList.querySelectorAll('.variant')].map((block) => ({
    ownLoras: collectLorasFrom(block.querySelector('.variant-lora-list')),
  }));
}

function currentModelId() {
  const selected = els.modelSelect.value;
  if (selected === '__custom__') return els.customModel.value.trim();
  return selected;
}

function buildInput({ loras, seed, numImages } = {}) {
  const model = MODELS.find((m) => m.id === els.modelSelect.value) || MODELS[0];
  const input = {
    prompt: els.prompt.value.trim(),
    num_images: numImages ?? Number(els.numImages.value),
  };
  const size = SIZES.find((s) => s.value === els.sizeSelect.value) || SIZES[0];
  if (model.sizeParam === 'aspect_ratio') {
    input.aspect_ratio = size.ratio;
  } else if (els.sizeSelect.value === CUSTOM_SIZE) {
    input.image_size = {
      width: snapDim(els.customWidth.value),
      height: snapDim(els.customHeight.value),
    };
  } else {
    input.image_size = { width: size.width, height: size.height };
  }
  const effSeed = seed ?? (els.seed.value !== '' ? Number(els.seed.value) : undefined);
  if (effSeed !== undefined) input.seed = effSeed;
  if (els.steps.value !== '') input.num_inference_steps = Number(els.steps.value);
  if (els.guidance.value !== '') input.guidance_scale = Number(els.guidance.value);
  const effLoras = loras ?? (!els.loraField.hidden ? collectLoras() : []);
  if (effLoras.length > 0) input.loras = effLoras;
  return input;
}

/* ---------- generation ---------- */

let generating = false;
let selectedId = null;
let cancelRequested = false;

// 生成中フラグと生成/キャンセルボタンの表示をまとめて切り替える
function setGenerating(on) {
  generating = on;
  els.generateBtn.disabled = on;
  els.cancelBtn.hidden = !on;
  if (on) cancelRequested = false;
}

// 実行中ジョブの中断。fal 側のキャンセル（待機中のみ有効）も試みるが、
// 失敗してもローカルでは必ずポーリングを打ち切って操作可能な状態に戻す
async function cancelGeneration() {
  cancelRequested = true;
  // Modal 版はポーリングの打ち切りのみ（サーバー側で開始済みの生成は止まらない）
  const job = loadActiveJob();
  if (job?.kind === 'modal') return;
  const submitted = job?.kind === 'single' ? job.submitted : job?.current?.submitted;
  if (submitted?.cancel_url) {
    try {
      await falFetch(submitted.cancel_url, { method: 'PUT' });
    } catch {
      // 生成開始済みなどでキャンセルできなくても、ローカルの打ち切りは行う
    }
  }
}

function setStatus(text) {
  els.status.hidden = !text;
  els.status.textContent = text || '';
}

function setError(text) {
  els.error.hidden = !text;
  els.error.textContent = text || '';
}

// fal の API キーは Worker 側の Secret にあり、ブラウザには置かない。
// 呼び出しはすべて同一オリジンのプロキシ（/api/fal/proxy）経由で行う
async function falFetch(url, options = {}) {
  const res = await fetch(`/api/fal/proxy?url=${encodeURIComponent(url)}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (isHtmlResponse(res)) throw new Error(ACCESS_EXPIRED_MSG);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 300) || `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text);
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
    } catch { /* 本文が JSON でない場合はそのまま表示する */ }
    throw new Error(detail);
  }
  return res.json();
}

// 保留中ジョブ（生成完了待ち）の永続化。再読み込み/クローズしても再開できる
function saveActiveJob(job) {
  localStorage.setItem(LS_JOB, JSON.stringify(job));
}

function loadActiveJob() {
  try {
    return JSON.parse(localStorage.getItem(LS_JOB));
  } catch {
    return null;
  }
}

function clearActiveJob() {
  localStorage.removeItem(LS_JOB);
}

// リクエスト送信のみ（status_url / response_url を含む submitted を返す）
async function submitJob(modelId, input) {
  return falFetch(`https://queue.fal.run/${modelId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// 既に送信済みの submitted をポーリングし、完了したら画像を取得する
async function awaitJob(submitted, onProgress) {
  let status;
  do {
    await sleep(POLL_INTERVAL_MS);
    if (cancelRequested) throw new Error('キャンセルされました');
    status = await falFetch(submitted.status_url);
    if (onProgress) onProgress(status);
  } while (status.status !== 'COMPLETED');

  const result = await falFetch(submitted.response_url);
  const images = result.images || (result.image ? [result.image] : []);
  if (images.length === 0) throw new Error('画像が返されませんでした');

  return { requestId: submitted.request_id, images, seed: result.seed ?? null };
}

function pollStatusText(status, startedAt, prefix = '') {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  const phase = status.status === 'IN_QUEUE'
    ? `待機中（${status.queue_position + 1} 番目）`
    : '生成中';
  setStatus(`${prefix}${phase}… ${elapsed}s`);
}

async function generate() {
  const model = MODELS.find((m) => m.id === els.modelSelect.value) || MODELS[0];
  const modelId = currentModelId();
  const prompt = els.prompt.value.trim();

  if (!prompt) { setError('プロンプトを入力してください'); return; }

  // Modal 自前ホスト版は fal ではなく Worker の専用ジョブ API で生成する
  if (model.provider === 'modal') { await generateModal(model, prompt); return; }

  if (!modelId) { setError('モデル ID を入力してください'); return; }

  if (compareMode) { await generateCompare(modelId, prompt); return; }

  setGenerating(true);
  setError('');

  try {
    const input = buildInput();
    const limit = modelLoraLimit();
    if ((input.loras?.length ?? 0) > limit) {
      throw new Error(`LoRA はこのモデルでは最大 ${limit} 個までです（現在 ${input.loras.length} 個）`);
    }
    setStatus('リクエスト送信中…');
    const submitted = await submitJob(modelId, input);
    const job = { kind: 'single', modelId, prompt, input, loras: input.loras ?? [], submitted, startedAt: Date.now() };
    saveActiveJob(job);

    const r = await awaitJob(submitted, (status) => pollStatusText(status, job.startedAt));
    finishSingle(job, r);
  } catch (err) {
    setError(`エラー: ${err.message}`);
    clearActiveJob();
  } finally {
    setGenerating(false);
    setStatus('');
  }
}

function finishSingle(job, r) {
  const record = {
    id: r.requestId,
    ts: Date.now(),
    model: job.modelId,
    prompt: job.prompt,
    input: job.input ?? null, // 生成設定（サーバー側で画像への焼き込みにも使う）
    loras: job.loras ?? [],
    seed: r.seed,
    elapsed: ((Date.now() - job.startedAt) / 1000).toFixed(1),
    images: r.images,
  };
  addHistoryRecord(record);
  renderDetail(record);
  scrollToDetail();
  clearActiveJob();
}

/* ---------- Modal (自前ホスト Krea 2) generation ---------- */
// modal_comfy の Krea 2 Turbo API を Worker のプロキシ経由で呼ぶ。
// 生成はサーバー側（Durable Object）でジョブとして完結し、クライアントは
// /api/krea2/job/<id> を短い間隔でポーリングして結果を受け取る。
// 長い HTTP 接続を保持しないため、タブ休止や接続断でも結果を取りこぼさず、
// ページを再読み込みしても途中から再開できる。
// 呼び出しの認証には端末間同期と同じトークン（SYNC_TOKEN）を使う

const MODAL_TIMEOUT_MS = 300_000; // INTEGRATION.md 推奨: 300 秒以上
const MODAL_POLL_INTERVAL_MS = 2000;

function buildModalInput(prompt) {
  const input = { prompt };
  if (els.sizeSelect.value === CUSTOM_SIZE) {
    input.width = snapDim(els.customWidth.value);
    input.height = snapDim(els.customHeight.value);
  } else {
    const size = SIZES.find((s) => s.value === els.sizeSelect.value) || SIZES[0];
    input.width = size.width;
    input.height = size.height;
  }
  if (els.seed.value !== '') input.seed = Number(els.seed.value);
  if (els.steps.value !== '') input.steps = Number(els.steps.value);
  if (els.guidance.value !== '') input.cfg = Number(els.guidance.value);
  return input;
}

// ジョブ ID はクライアント側で採番する（送信のリトライや再開時に同じ ID を
// 使えば、サーバー側で重複生成されない）
function makeModalJobId() {
  if (crypto.randomUUID) return crypto.randomUUID().replaceAll('-', '');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function modalErrorMessage(res) {
  if (res.status === 404) {
    return 'この配信環境では Modal 版は使えません（Cloudflare Workers でのホストが必要です）';
  }
  const text = await res.text().catch(() => '');
  return text.slice(0, 300) || `HTTP ${res.status}`;
}

async function modalSubmit(body) {
  const res = await fetch('/api/krea2/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (isHtmlResponse(res)) throw new Error(ACCESS_EXPIRED_MSG);
  if (!res.ok) throw new Error(await modalErrorMessage(res));
  return res.json();
}

// ジョブ完了までポーリングする。一時的な接続エラー（オフライン・タブ休止から
// の復帰直後など）は無視して次のポーリングで拾う
async function modalAwaitJob(jobId, onTick) {
  const pollStart = Date.now();
  while (true) {
    await sleep(MODAL_POLL_INTERVAL_MS);
    if (cancelRequested) throw new Error('キャンセルされました');

    const res = await fetch(`/api/krea2/job/${jobId}`).catch(() => null);
    if (res && !isHtmlResponse(res)) {
      if (res.status === 404) {
        throw new Error('ジョブが見つかりませんでした（サーバー側で期限切れになった可能性があります）');
      }
      if (!res.ok) throw new Error(await modalErrorMessage(res));
      const job = await res.json().catch(() => null);
      if (job?.status === 'done') return job;
      if (job?.status === 'error') throw new Error(job.error || '生成に失敗しました');
    }

    if (onTick) onTick();
    // タイムアウト判定はポーリング結果を確認した後に行う（タブ休止からの復帰時、
    // 完了済みならタイムアウトにせず結果を採用できる）
    if (Date.now() - pollStart > MODAL_TIMEOUT_MS) {
      throw new Error(`${MODAL_TIMEOUT_MS / 1000} 秒以内に完了しませんでした。Modal ダッシュボードでアプリの状態を確認してください`);
    }
  }
}

async function generateModal(model, prompt) {
  const input = buildModalInput(prompt);
  // 実験版 / 本番の切り替え。URL は Worker 側の許可リストで解決される
  input.endpoint = model.modalEndpoint;
  if (input.cfg !== undefined && (input.cfg < 0 || input.cfg > 1)) {
    setError('この API のガイダンス（cfg）は 0〜1 の範囲で指定してください');
    return;
  }
  // この API の LoRA は URL ではなく名前（.safetensors 抜き）で指定する仕様のため変換する
  const loras = !els.loraField.hidden ? collectLoras() : [];
  if (loras.length > 0) {
    input.loras = loras.map((l) => ({ name: loraDisplayName(l.path), strength: l.scale }));
  }

  const count = Number(els.numImages.value);
  const job = {
    kind: 'modal',
    modelId: model.id,
    prompt,
    loras,
    input,
    startedAt: Date.now(),
    // seed 指定のまま複数枚生成すると全枚同一になるため、2 枚目以降はずらす
    entries: Array.from({ length: count }, (_, i) => ({
      jobId: makeModalJobId(),
      seed: input.seed !== undefined ? input.seed + i : undefined,
      submitted: false,
      result: null,
    })),
  };

  setGenerating(true);
  setError('');
  try {
    saveActiveJob(job);
    await runModalJobFrom(job);
  } catch (err) {
    setError(cancelRequested ? 'キャンセルされました' : `エラー: ${err.message}`);
    finishModal(job); // 途中まで生成できた分は履歴に残し、ジョブをクリアする
  } finally {
    setGenerating(false);
    setStatus('');
  }
}

// Modal ジョブを（未完了の分から）実行する。再開時もこの関数を使う
async function runModalJobFrom(job) {
  const total = job.entries.length;

  // 未送信分を先にすべて投入する（サーバー側で順に処理される）
  for (const entry of job.entries) {
    if (entry.submitted || entry.result) continue;
    const body = { ...job.input, jobId: entry.jobId };
    if (entry.seed !== undefined) body.seed = entry.seed;
    setStatus('リクエスト送信中…');
    await modalSubmit(body);
    entry.submitted = true;
    saveActiveJob(job);
  }

  // 順番に完了を待つ
  for (let i = 0; i < total; i++) {
    const entry = job.entries[i];
    if (entry.result) continue;
    const prefix = total > 1 ? `${i + 1}/${total} ` : '';
    const r = await modalAwaitJob(entry.jobId, () => {
      const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(0);
      setStatus(`${prefix}生成中… ${elapsed}s（コールドスタート時は 1 分ほどかかります）`);
    });
    entry.result = { url: r.url, seed: r.seed };
    saveActiveJob(job);
  }

  finishModal(job);
}

// 完了した分を履歴・結果表示に反映してジョブをクリアする（部分完了でも呼べる）
function finishModal(job) {
  clearActiveJob();
  const done = job.entries.filter((e) => e.result);
  if (done.length === 0) return;
  const record = {
    id: `modal_${Date.now()}`,
    ts: Date.now(),
    model: job.modelId,
    prompt: job.prompt,
    input: job.input ?? null,
    loras: job.loras,
    seed: done[0].result.seed,
    elapsed: ((Date.now() - job.startedAt) / 1000).toFixed(1),
    images: done.map((e) => ({ url: e.result.url, width: job.input.width, height: job.input.height })),
  };
  addHistoryRecord(record);
  renderDetail(record);
  scrollToDetail();
}

// 比較モード: 共通 LoRA + 各試行の LoRA を、同じ seed / プロンプトで順番に生成
async function generateCompare(modelId, prompt) {
  const variants = collectVariants();
  if (variants.length < 2) {
    setError('比較には試行を 2 つ以上追加してください');
    return;
  }

  const common = collectLorasFrom(els.loraList);

  // 送信前チェック: 共通 + 固有 が上限を超える試行があれば API を呼ばず中止
  const limit = modelLoraLimit();
  for (let i = 0; i < variants.length; i++) {
    const total = common.length + variants[i].ownLoras.length;
    if (total > limit) {
      setError(`試行 ${i + 1}: LoRA が ${total} 個ですが、このモデルは最大 ${limit} 個までです（共通 ${common.length} + 固有 ${variants[i].ownLoras.length}）`);
      return;
    }
  }

  // 公平な比較のため全試行で同じ seed を使う（未指定ならランダムに決定）
  const runSeed = els.seed.value !== ''
    ? Number(els.seed.value)
    : Math.floor(Math.random() * 4294967296);

  const job = {
    kind: 'compare',
    modelId,
    prompt,
    seed: runSeed,
    common,
    variants: variants.map((v) => ({ ownLoras: v.ownLoras })),
    results: [],
    current: null,
    startedAt: Date.now(),
  };

  setGenerating(true);
  setError('');

  try {
    await runCompareFrom(job);
  } catch (err) {
    setError(`エラー: ${err.message}`);
    clearActiveJob();
  } finally {
    setGenerating(false);
    setStatus('');
  }
}

// 比較ジョブを（未完了の試行から）実行する。再開時もこの関数を使う
async function runCompareFrom(job) {
  const total = job.variants.length;

  while (job.results.length < total) {
    const i = job.results.length;
    const own = job.variants[i].ownLoras;
    const loras = [...job.common, ...own];

    // 送信済み（再開）ならそれを、そうでなければ新規送信
    let submitted = (job.current && job.current.index === i) ? job.current.submitted : null;
    if (!submitted) {
      const input = buildInput({ loras, seed: job.seed, numImages: 1 });
      submitted = await submitJob(job.modelId, input);
      job.current = { index: i, submitted };
      saveActiveJob(job);
    }

    try {
      const r = await awaitJob(submitted, (status) => pollStatusText(status, job.startedAt, `試行 ${i + 1}/${total} `));
      job.results.push({ ownLoras: own, loras, images: r.images, seed: r.seed, elapsed: null, error: null });
    } catch (err) {
      // キャンセルは試行の失敗としてではなく比較全体の中断として扱う
      if (cancelRequested) throw err;
      job.results.push({ ownLoras: own, loras, images: [], seed: null, elapsed: null, error: err.message });
    }
    job.current = null;
    saveActiveJob(job);
  }

  const record = {
    id: `cmp_${Date.now()}`,
    ts: Date.now(),
    type: 'compare',
    model: job.modelId,
    prompt: job.prompt,
    seed: job.seed,
    common: job.common,
    variants: job.results,
  };
  addHistoryRecord(record);
  renderDetail(record);
  scrollToDetail();
  clearActiveJob();
}

// 起動時: 保留中ジョブがあればポーリングを再開して完了させる
async function resumeActiveJob() {
  const job = loadActiveJob();
  if (!job) return;

  setGenerating(true);
  setError('');
  setStatus('前回の生成を再開中…');

  try {
    if (job.kind === 'single') {
      const r = await awaitJob(job.submitted, (status) => pollStatusText(status, job.startedAt));
      finishSingle(job, r);
    } else if (job.kind === 'compare') {
      await runCompareFrom(job);
    } else if (job.kind === 'modal') {
      // Modal の生成はサーバー側で継続しているため、ポーリングを再開すれば
      // 離脱中に完了した分もそのまま受け取れる
      try {
        await runModalJobFrom(job);
      } catch (err) {
        setError(`前回の生成の再開に失敗しました: ${err.message}`);
        finishModal(job); // 完了していた分は履歴に残す
      }
    } else {
      clearActiveJob();
    }
  } catch (err) {
    setError(`前回の生成の再開に失敗しました: ${err.message}`);
    clearActiveJob();
  } finally {
    setGenerating(false);
    setStatus('');
  }
}

/* ---------- rendering ---------- */

function clearDetail() {
  selectedId = null;
  els.detail.innerHTML = '<div class="detail-empty">プロンプトを入力して「生成する」を押してください</div>';
}

// モバイルでは生成完了時に結果まで自動スクロールする（フォームが長く結果が画面外のため）
function scrollToDetail() {
  if (MOBILE_MQ.matches) els.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// モバイル用: ギャラリーカードから撤去した削除操作を詳細表示側に置く
function makeDetailDeleteBtn(record) {
  const btn = document.createElement('button');
  btn.className = 'ghost-btn small mobile-only';
  btn.textContent = '削除';
  btn.addEventListener('click', () => {
    deleteHistoryRecord(record.id);
    clearDetail();
    renderGallery();
  });
  return btn;
}

// 画像読み込みが稀に失敗する（拡大表示では見える）ため、失敗時に少し待って再取得する
function loadImage(imgEl, url, maxRetries = 5) {
  if (!url) { imgEl.src = ''; return; }
  let attempts = 0;
  imgEl.addEventListener('error', () => {
    if (attempts >= maxRetries) return;
    attempts += 1;
    setTimeout(() => {
      imgEl.removeAttribute('src');
      imgEl.src = url;
    }, 400 * attempts);
  });
  imgEl.src = url;
}

function renderDetail(record) {
  selectedId = record.id;
  els.detail.innerHTML = '';

  if (record.type === 'compare') {
    renderCompareDetail(record);
    renderGallery();
    return;
  }

  const imagesWrap = document.createElement('div');
  imagesWrap.className = 'detail-images';

  const detailUrls = record.images.map((i) => i.url);
  for (const img of record.images) {
    const card = document.createElement('div');
    card.className = 'image-card';

    const el = document.createElement('img');
    el.alt = record.prompt;
    if (img.width && img.height) {
      el.width = img.width;
      el.height = img.height;
    }
    loadImage(el, img.url);
    el.style.cursor = 'zoom-in';
    el.addEventListener('click', () => openLightbox(detailUrls, record.images.indexOf(img)));
    card.appendChild(el);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'ghost-btn small';
    openBtn.textContent = '開く';
    openBtn.addEventListener('click', () => window.open(img.url, '_blank'));
    actions.appendChild(openBtn);

    const dlBtn = document.createElement('button');
    dlBtn.className = 'ghost-btn small';
    dlBtn.textContent = '保存';
    dlBtn.addEventListener('click', () => downloadImage(img.url, `fal_${record.id}.png`));
    actions.appendChild(dlBtn);

    if (record.seed !== null) {
      const seedMeta = document.createElement('span');
      seedMeta.className = 'meta';
      seedMeta.textContent = `seed: ${record.seed}`;
      seedMeta.title = 'クリックでシードを再利用';
      seedMeta.style.cursor = 'pointer';
      seedMeta.addEventListener('click', () => { els.seed.value = record.seed; });
      actions.appendChild(seedMeta);
    }

    card.appendChild(actions);
    imagesWrap.appendChild(card);
  }
  els.detail.appendChild(imagesWrap);

  const meta = document.createElement('div');
  meta.className = 'detail-meta';

  const promptFull = document.createElement('div');
  promptFull.className = 'prompt-full';
  promptFull.textContent = record.prompt;
  meta.appendChild(promptFull);

  const metaLine = document.createElement('div');
  metaLine.className = 'meta-line';
  const loraText = record.loras?.length
    ? ` ・ LoRA: ${record.loras.map((l) => loraDisplayName(l.path)).join(', ')}`
    : '';
  metaLine.textContent = `${record.model}${loraText} ・ ${record.elapsed}s${record.seed !== null ? ` ・ seed: ${record.seed}` : ''}`;
  meta.appendChild(metaLine);

  const detailActions = document.createElement('div');
  detailActions.className = 'detail-actions';

  const reuseBtn = document.createElement('button');
  reuseBtn.className = 'ghost-btn small';
  reuseBtn.textContent = '設定を再利用';
  reuseBtn.addEventListener('click', () => reuseRecord(record));
  detailActions.appendChild(reuseBtn);
  detailActions.appendChild(makeDetailDeleteBtn(record));

  meta.appendChild(detailActions);
  els.detail.appendChild(meta);

  renderGallery();
}

function variantLabel(ownLoras) {
  const names = ownLoras.map((l) => loraDisplayName(l.path));
  return names.length ? names.join(' + ') : '（共通のみ）';
}

function renderCompareDetail(record) {
  const grid = document.createElement('div');
  grid.className = 'compare-grid';

  // 拡大表示で左右移動できるよう、全試行の画像 URL を並び順どおりに集める
  const compareUrls = record.variants.flatMap((v) => v.images.map((img) => img.url));

  record.variants.forEach((v, i) => {
    const col = document.createElement('div');
    col.className = 'compare-col';

    const title = document.createElement('div');
    title.className = 'compare-col-title';
    title.textContent = `試行 ${i + 1}: ${variantLabel(v.ownLoras)}`;
    title.title = v.loras.map((l) => `${loraDisplayName(l.path)} (${l.scale})`).join(', ');
    col.appendChild(title);

    if (v.error) {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = v.error;
      col.appendChild(err);
    } else {
      for (const img of v.images) {
        const el = document.createElement('img');
        el.className = 'compare-img';
        el.alt = variantLabel(v.ownLoras);
        loadImage(el, img.url);
        el.style.cursor = 'zoom-in';
        el.addEventListener('click', () => openLightbox(compareUrls, compareUrls.indexOf(img.url)));
        col.appendChild(el);
      }
      const dlBtn = document.createElement('button');
      dlBtn.className = 'ghost-btn small';
      dlBtn.textContent = '保存';
      dlBtn.addEventListener('click', () => downloadImage(v.images[0].url, `fal_cmp_${i + 1}.png`));
      col.appendChild(dlBtn);
    }

    grid.appendChild(col);
  });

  els.detail.appendChild(grid);

  const meta = document.createElement('div');
  meta.className = 'detail-meta';

  const promptFull = document.createElement('div');
  promptFull.className = 'prompt-full';
  promptFull.textContent = record.prompt;
  meta.appendChild(promptFull);

  const commonText = record.common?.length
    ? `共通 LoRA: ${record.common.map((l) => loraDisplayName(l.path)).join(', ')} ・ `
    : '';
  const metaLine = document.createElement('div');
  metaLine.className = 'meta-line';
  metaLine.textContent = `${record.model} ・ ${commonText}seed: ${record.seed}`;
  meta.appendChild(metaLine);

  const detailActions = document.createElement('div');
  detailActions.className = 'detail-actions';
  const reuseBtn = document.createElement('button');
  reuseBtn.className = 'ghost-btn small';
  reuseBtn.textContent = '設定を再利用';
  reuseBtn.addEventListener('click', () => reuseRecord(record));
  detailActions.appendChild(reuseBtn);
  detailActions.appendChild(makeDetailDeleteBtn(record));
  meta.appendChild(detailActions);

  els.detail.appendChild(meta);
}

let lightboxUrls = [];
let lightboxIndex = 0;

// urls は単一 URL 文字列でも配列でも可。配列なら拡大表示中に ←/→ で切替できる
function openLightbox(urls, index = 0) {
  lightboxUrls = Array.isArray(urls) ? urls : [urls];
  lightboxIndex = index;
  showLightboxImage();
  els.lightbox.hidden = false;
}

function showLightboxImage() {
  els.lightbox.querySelector('img').src = lightboxUrls[lightboxIndex] ?? '';
  els.lightboxCounter.hidden = lightboxUrls.length < 2;
  els.lightboxCounter.textContent = `${lightboxIndex + 1} / ${lightboxUrls.length}`;
}

// 拡大表示中に前後の画像へ（端はループ）
function lightboxNav(dir) {
  if (lightboxUrls.length < 2) return;
  lightboxIndex = (lightboxIndex + dir + lightboxUrls.length) % lightboxUrls.length;
  showLightboxImage();
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lightbox.querySelector('img').src = '';
}

async function downloadImage(url, filename) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(objectUrl);
  } catch {
    // CORS などで取得できなければ新しいタブで開く
    window.open(url, '_blank');
  }
}

function galleryThumbUrl(record) {
  if (record.type === 'compare') {
    return record.variants.find((v) => v.images?.length)?.images[0]?.url ?? '';
  }
  return record.images[0]?.url ?? '';
}

function renderGallery() {
  const items = loadHistory();
  els.gallery.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'gallery-empty';
    empty.textContent = 'まだ履歴はありません';
    els.gallery.appendChild(empty);
    return;
  }

  for (const record of items) {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    if (record.id === selectedId) item.classList.add('selected');

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.alt = record.prompt;
    thumb.loading = 'lazy';
    loadImage(thumb, galleryThumbUrl(record));
    thumb.addEventListener('click', () => renderDetail(record));
    item.appendChild(thumb);

    if (record.type === 'compare') {
      const badge = document.createElement('span');
      badge.className = 'compare-badge';
      badge.textContent = `比較 ×${record.variants.length}`;
      item.appendChild(badge);
    }

    const body = document.createElement('div');
    body.className = 'body';

    const promptText = document.createElement('div');
    promptText.className = 'prompt-text';
    promptText.textContent = record.prompt;
    promptText.title = record.prompt;
    body.appendChild(promptText);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = record.model.replace(/^fal-ai\//, '');
    body.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'ghost-btn small';
    deleteBtn.textContent = '削除';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryRecord(record.id);
      if (record.id === selectedId) {
        clearDetail();
      }
      renderGallery();
    });
    actions.appendChild(deleteBtn);

    body.appendChild(actions);
    item.appendChild(body);
    els.gallery.appendChild(item);
  }
}

// 詳細表示中に前後の履歴（ギャラリー）へ移動する。dir=+1 で右、-1 で左
function navigateGallery(dir) {
  const items = loadHistory();
  if (items.length === 0 || selectedId == null) return;
  const idx = items.findIndex((r) => r.id === selectedId);
  if (idx === -1) return;
  const next = idx + dir;
  if (next < 0 || next >= items.length) return;
  renderDetail(items[next]);
  const selEl = els.gallery.querySelector('.gallery-item.selected');
  if (selEl) selEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function reuseRecord(record) {
  els.prompt.value = record.prompt;
  const known = MODELS.some((m) => m.id === record.model);
  els.modelSelect.value = known ? record.model : '__custom__';
  if (!known) els.customModel.value = record.model;
  updateModelFields();

  if (record.type === 'compare') {
    setCompareMode(true);
    els.loraList.innerHTML = '';
    for (const lora of record.common ?? []) addLoraRow(lora.path, lora.scale, els.loraList);
    els.variantList.innerHTML = '';
    for (const v of record.variants) addVariant(v.ownLoras, false);
  } else {
    setCompareMode(false);
    els.loraList.innerHTML = '';
    for (const lora of record.loras ?? []) addLoraRow(lora.path, lora.scale);
  }
  if (record.seed != null) els.seed.value = record.seed;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- device sync ---------- */
// LoRA ライブラリを Worker の /api/state（Durable Object）に保存して端末間で
// 同期する。セクションごとに更新時刻を持ち、新しい方を採用する。
// 認証は Cloudflare Access が担うため、アプリ内のトークンはない。
//（生成履歴は /api/history でサーバー保存、fal キーは Worker の Secret なので同期対象外）

const LS_SYNC_TS = 'fal_sync_ts';
const SYNC_SECTIONS = { loras: LS_LORAS };
const SYNC_PUSH_DELAY_MS = 2000;

let syncPushTimer = null;

function loadSyncTs() {
  try {
    return JSON.parse(localStorage.getItem(LS_SYNC_TS)) || {};
  } catch {
    return {};
  }
}

function saveSyncTs(ts) {
  localStorage.setItem(LS_SYNC_TS, JSON.stringify(ts));
}

// 同期対象の localStorage を書き換えたら呼ぶ。連続変更をまとめて少し後に送信する
function syncMarkDirty(section) {
  const ts = loadSyncTs();
  ts[section] = Date.now();
  saveSyncTs(ts);
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    syncPushTimer = null;
    syncPull(); // 先にリモートの新しい変更を取り込んでから needPush 経由で送信される
  }, SYNC_PUSH_DELAY_MS);
}

function syncFetch(method, body) {
  return fetch('/api/state', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body,
    // 離脱間際の送信でも完了できるようにする
    keepalive: method === 'PUT',
  });
}

// リモートの方が新しいセクションを取り込み、ローカルの方が新しければ送信する
async function syncPull() {
  let doc;
  try {
    const res = await syncFetch('GET');
    if (!res.ok || isHtmlResponse(res)) return;
    doc = await res.json();
  } catch {
    return; // オフライン・ローカル静的サーバーなどは黙って諦める
  }

  const ts = loadSyncTs();
  let changed = false;
  let needPush = !doc; // サーバーが空（初回）ならローカルをそのまま上げる
  for (const [section, lsKey] of Object.entries(SYNC_SECTIONS)) {
    const remote = doc?.[section];
    const localTs = ts[section] || 0;
    if (remote && remote.ts > localTs) {
      if (remote.value) localStorage.setItem(lsKey, remote.value);
      else localStorage.removeItem(lsKey);
      ts[section] = remote.ts;
      changed = true;
    } else if (localTs > (remote?.ts ?? 0)) {
      needPush = true;
    }
  }
  saveSyncTs(ts);

  if (changed) refreshLoraSelects();
  if (needPush) syncPush();
}

async function syncPush() {
  const ts = loadSyncTs();
  const doc = {};
  for (const [section, lsKey] of Object.entries(SYNC_SECTIONS)) {
    doc[section] = { value: localStorage.getItem(lsKey) ?? '', ts: ts[section] || 0 };
  }
  try {
    await syncFetch('PUT', JSON.stringify(doc));
  } catch {
    // 失敗しても次の変更・次回起動時に再送される
  }
}

/* ---------- form persistence ---------- */

// LoRA リストの全行を（scale 0 や未登録も含めて）そのまま書き出す
function serializeLoraList(listEl) {
  return [...listEl.querySelectorAll('.lora-row')]
    .map((row) => {
      const select = row.querySelector('.lora-select');
      const path = select.value === LORA_URL_OPTION
        ? row.querySelector('.lora-path').value.trim()
        : select.value;
      return { path, scale: Number(row.querySelector('input[type="number"]').value) || 0 };
    })
    .filter((l) => l.path !== '');
}

function saveFormState() {
  const state = {
    model: els.modelSelect.value,
    customModel: els.customModel.value,
    prompt: els.prompt.value,
    size: els.sizeSelect.value,
    customWidth: els.customWidth.value,
    customHeight: els.customHeight.value,
    numImages: els.numImages.value,
    seed: els.seed.value,
    steps: els.steps.value,
    guidance: els.guidance.value,
    compare: compareMode,
    common: serializeLoraList(els.loraList),
    variants: [...els.variantList.querySelectorAll('.variant')]
      .map((b) => serializeLoraList(b.querySelector('.variant-lora-list'))),
  };
  localStorage.setItem(LS_FORM, JSON.stringify(state));
}

function restoreFormState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(LS_FORM)); } catch { s = null; }
  if (!s) return;

  if (s.model) els.modelSelect.value = s.model;
  els.customModel.value = s.customModel || '';
  els.prompt.value = s.prompt || '';
  updateModelFields();

  // 旧バージョンで保存された存在しないサイズ値（fal の列挙名など）は無視する
  if (s.size && [...els.sizeSelect.options].some((o) => o.value === s.size)) {
    els.sizeSelect.value = s.size;
  }
  if (s.customWidth) els.customWidth.value = s.customWidth;
  if (s.customHeight) els.customHeight.value = s.customHeight;
  els.numImages.value = s.numImages || '1';
  els.seed.value = s.seed || '';
  els.steps.value = s.steps || '';
  els.guidance.value = s.guidance || '';
  updateCustomSize();

  els.loraList.innerHTML = '';
  for (const l of s.common || []) addLoraRow(l.path, l.scale, els.loraList);

  // 比較モードは LoRA 対応モデルのときだけ復元する
  if (s.compare && !els.loraField.hidden) {
    setCompareMode(true);
    els.variantList.innerHTML = '';
    for (const v of s.variants || []) addVariant(v, false);
  }
}

let saveFormTimer = null;
function scheduleSaveForm() {
  clearTimeout(saveFormTimer);
  saveFormTimer = setTimeout(saveFormState, 300);
}

/* ---------- init ---------- */

initTheme();
initHfDialog();
initForm();
restoreFormState();

// 履歴: まずローカルキャッシュで即描画し、サーバーの内容で置き換える
try {
  historyCache = JSON.parse(localStorage.getItem(LS_HISTORY)) || [];
} catch {
  historyCache = [];
}
renderGallery();
fetchHistoryFromServer();

// モバイルでは LoRA アコーディオンを畳んだ状態で開始する（PC は常時展開）
if (MOBILE_MQ.matches) els.loraField.open = false;

// 起動時に他端末の変更（LoRA ライブラリ）を取り込む
syncPull();

// フォームの変更を localStorage に保存（入力のたび・離脱時）
document.addEventListener('input', scheduleSaveForm);
document.addEventListener('change', scheduleSaveForm);
window.addEventListener('pagehide', () => {
  saveFormState();
  // 送信待ちの同期があれば離脱前に送っておく
  if (syncPushTimer) {
    clearTimeout(syncPushTimer);
    syncPushTimer = null;
    syncPush();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveFormState();
  // タブに戻ってきたら他端末の変更（LoRA ライブラリ・履歴）を取り込む
  if (document.visibilityState === 'visible') {
    syncPull();
    fetchHistoryFromServer();
  }
});

els.generateBtn.addEventListener('click', generate);
els.cancelBtn.addEventListener('click', cancelGeneration);
els.addLoraBtn.addEventListener('click', () => addLoraRow());
els.compareToggle.addEventListener('change', () => setCompareMode(els.compareToggle.checked));
els.addVariantBtn.addEventListener('click', () => addVariant());

// スワイプ直後は click（背景タップで閉じる）を無効化して、意図しないクローズを防ぐ
let lightboxTouchX = 0;
let lightboxTouchY = 0;
let lightboxSwiped = false;

els.lightbox.addEventListener('click', () => {
  if (lightboxSwiped) { lightboxSwiped = false; return; }
  closeLightbox();
});
els.lightboxClose.addEventListener('click', closeLightbox);

// 横スワイプで前後の画像へ（縦方向の動きが主ならスクロール操作とみなして無視）
els.lightbox.addEventListener('touchstart', (e) => {
  lightboxTouchX = e.touches[0].clientX;
  lightboxTouchY = e.touches[0].clientY;
}, { passive: true });

els.lightbox.addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].clientX - lightboxTouchX;
  const dy = e.changedTouches[0].clientY - lightboxTouchY;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
    lightboxSwiped = true;
    lightboxNav(dx < 0 ? 1 : -1);
  }
}, { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.lightbox.hidden) closeLightbox();
});

// ←/→ での移動。拡大表示中はその画像群の中で、詳細表示中は前後のサムネへ
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const dir = e.key === 'ArrowRight' ? 1 : -1;

  if (!els.lightbox.hidden) {
    e.preventDefault();
    lightboxNav(dir);
    return;
  }

  if (selectedId == null) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  e.preventDefault();
  navigateGallery(dir);
});

els.clearHistoryBtn.addEventListener('click', () => {
  if (confirm('履歴をすべて削除しますか？（サーバーに保存された画像も消えます）')) {
    clearHistory();
    clearDetail();
    renderGallery();
  }
});

// Cmd/Ctrl + Enter で生成
els.prompt.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !generating) generate();
});

// 前回の生成が完了待ちのまま離脱していたら再開する
resumeActiveJob();
