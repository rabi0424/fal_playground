'use strict';

/* ==========================================================================
 * 画像編集（fal-ai/qwen-image-edit-2511/lora）
 *
 * 入力画像 1 枚 + 指示文 + LoRA で画像を編集する別画面。既存の「部分AI編集」
 * （Poe・範囲を切り抜いてはめ込む）とは別枠で、画像全体をモデルに渡す。
 *
 * - fal の呼び出しは生成画面と同じく Worker のプロキシ（/api/fal/proxy）経由。
 *   キューに投げて status_url をポーリングする
 * - 入力画像は data URI として fal に渡す。このアプリは Cloudflare Access の
 *   内側に置く前提で、/api/image/... を fal から取りに行けるとは限らないため
 * - 同じ画像は R2 にも保存し（/api/upload）、履歴レコードと再開用に使う。
 *   data URI は localStorage に置くには大きすぎるので保存しない
 * - 結果は type: 'imgedit' の履歴レコードとして /api/history に保存するので、
 *   生成画面のギャラリーにもそのまま並ぶ
 * ========================================================================== */

/* ---------- constants ---------- */

const MODEL_ID = 'fal-ai/qwen-image-edit-2511/lora';
const MAX_LORAS = 3; // fal 側の上限
const MAX_INPUT_PX = 2048; // 送信前に長辺をここまで縮める
const INPUT_QUALITY = 0.92; // 縮小後の JPEG 品質
const POLL_INTERVAL_MS = 1200;

const LS_THEME = 'fal_theme';
const LS_LORAS = 'fal_lora_library';
const LS_JOB = 'fal_imgedit_job';
const LS_FORM = 'fal_imgedit_form';

// 出力サイズ。既定は「入力画像に合わせる」（image_size を送らない）
const SIZES = [
  { value: 'auto', label: '入力画像に合わせる' },
  { value: 'square_1_1', label: '正方形 1:1（1024×1024）', width: 1024, height: 1024 },
  { value: 'landscape_4_3', label: '横長 4:3（1152×896）', width: 1152, height: 896 },
  { value: 'landscape_16_9', label: '横長 16:9（1344×768）', width: 1344, height: 768 },
  { value: 'portrait_3_4', label: '縦長 3:4（896×1152）', width: 896, height: 1152 },
  { value: 'portrait_2_3', label: '縦長 2:3（1024×1536）', width: 1024, height: 1536 },
  { value: 'portrait_9_16', label: '縦長 9:16（768×1344）', width: 768, height: 1344 },
];

const ACCESS_EXPIRED_MSG = 'セッションが切れました。ページを再読み込みしてください。';

/* ---------- helpers ---------- */

const $ = (sel) => document.querySelector(sel);

const els = {
  themeBtn: $('#themeBtn'),
  uploadArea: $('#uploadArea'),
  fileInput: $('#fileInput'),
  pickFileBtn: $('#pickFileBtn'),
  pickHistoryBtn: $('#pickHistoryBtn'),
  sourcePreview: $('#sourcePreview'),
  sourceImg: $('#sourceImg'),
  sourceInfo: $('#sourceInfo'),
  clearSourceBtn: $('#clearSourceBtn'),
  prompt: $('#prompt'),
  loraList: $('#loraList'),
  addLoraBtn: $('#addLoraBtn'),
  loraHint: $('#loraHint'),
  sizeSelect: $('#sizeSelect'),
  numImages: $('#numImages'),
  steps: $('#steps'),
  guidance: $('#guidance'),
  acceleration: $('#acceleration'),
  seed: $('#seed'),
  seedLock: $('#seedLock'),
  negativePrompt: $('#negativePrompt'),
  runBtn: $('#runBtn'),
  cancelBtn: $('#cancelBtn'),
  status: $('#status'),
  error: $('#error'),
  resultPanel: $('#resultPanel'),
  resultMeta: $('#resultMeta'),
  resultImages: $('#resultImages'),
  gallery: $('#gallery'),
  galleryEmpty: $('#galleryEmpty'),
  historyDialog: $('#historyDialog'),
  historyPicker: $('#historyPicker'),
  historyEmpty: $('#historyEmpty'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isHtmlResponse(res) {
  return (res.headers.get('Content-Type') || '').includes('text/html');
}

function setStatus(text, done = false) {
  els.status.hidden = !text;
  els.status.textContent = text || '';
  els.status.classList.toggle('done', !!text && done);
}

function setError(text) {
  els.error.hidden = !text;
  els.error.textContent = text || '';
}

function makeId() {
  return crypto.randomUUID().replace(/-/g, '');
}

/* ---------- theme（app.js と同じ） ---------- */

const THEME_LABELS = { auto: '自動', light: 'ライト', dark: 'ダーク' };
const THEME_ORDER = ['auto', 'light', 'dark'];

function initTheme() {
  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    els.themeBtn.textContent = THEME_LABELS[theme];
  };
  apply(localStorage.getItem(LS_THEME) || 'auto');
  els.themeBtn.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
    localStorage.setItem(LS_THEME, next);
    apply(next);
  });
}

/* ---------- LoRA ライブラリ（読み取りのみ・app.js と同じ形式） ---------- */

function loadLoraLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LS_LORAS)) || [];
  } catch {
    return [];
  }
}

function loraFileName(path) {
  const seg = path.split('?')[0].split('/').filter(Boolean).pop() || path;
  try {
    return decodeURIComponent(seg).replace(/\.safetensors$/i, '');
  } catch {
    return seg.replace(/\.safetensors$/i, '');
  }
}

function loraEntry(path) {
  return loadLoraLibrary().find((item) => item.path === path) ?? null;
}

function loraLabel(path) {
  const item = loraEntry(path);
  return item?.label?.trim() || item?.name || loraFileName(path);
}

function loraDefaultScale(path) {
  const scale = loraEntry(path)?.scale;
  return Number.isFinite(scale) ? scale : 1;
}

function loraTriggerWords(path) {
  return (loraEntry(path)?.trigger || '').split(',').map((w) => w.trim()).filter(Boolean);
}

// ★ を先頭に、あとは表示名順（生成画面のプルダウンと同じ並び）
function sortedLoraLibrary() {
  return [...loadLoraLibrary()].sort((a, b) => {
    if (!!a.fav !== !!b.fav) return a.fav ? -1 : 1;
    return loraLabel(a.path).localeCompare(loraLabel(b.path), 'ja', { numeric: true, sensitivity: 'base' });
  });
}

/* ---------- LoRA 行 ---------- */

function addLoraRow(path = '', scale) {
  const library = sortedLoraLibrary();
  if (library.length === 0) return;
  if (els.loraList.querySelectorAll('.lora-row').length >= MAX_LORAS) return;

  const row = document.createElement('div');
  row.className = 'lora-row';

  const head = document.createElement('div');
  head.className = 'lora-head';

  const select = document.createElement('select');
  select.className = 'lora-select';
  for (const item of library) {
    const opt = document.createElement('option');
    opt.value = item.path;
    opt.textContent = (item.fav ? '★ ' : '') + loraLabel(item.path);
    opt.title = item.path;
    select.appendChild(opt);
  }
  select.value = path && library.some((l) => l.path === path) ? path : library[0].path;
  head.appendChild(select);

  const delBtn = document.createElement('button');
  delBtn.className = 'ghost-btn small';
  delBtn.type = 'button';
  delBtn.textContent = '削除';
  delBtn.addEventListener('click', () => {
    row.remove();
    saveForm();
    syncAddLoraBtn();
  });
  head.appendChild(delBtn);
  row.appendChild(head);

  const trigger = document.createElement('div');
  trigger.className = 'lora-trigger';
  row.appendChild(trigger);

  const scaleWrap = document.createElement('div');
  scaleWrap.className = 'lora-scale';
  const scaleLabel = document.createElement('span');
  scaleLabel.className = 'scale-label';
  scaleLabel.textContent = 'scale';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '2';
  slider.step = '0.05';
  const num = document.createElement('input');
  num.type = 'number';
  num.min = '0';
  num.max = '2';
  num.step = '0.05';
  const initialScale = scale ?? loraDefaultScale(select.value);
  slider.value = String(initialScale);
  num.value = String(initialScale);
  slider.addEventListener('input', () => { num.value = slider.value; row.dataset.scaleTouched = '1'; saveForm(); });
  num.addEventListener('input', () => { slider.value = num.value; row.dataset.scaleTouched = '1'; saveForm(); });
  scaleWrap.append(scaleLabel, slider, num);
  row.appendChild(scaleWrap);

  // 選択を変えたら、手で動かす前ならライブラリの既定 scale に合わせる
  select.addEventListener('change', () => {
    if (!row.dataset.scaleTouched) {
      const def = loraDefaultScale(select.value);
      slider.value = String(def);
      num.value = String(def);
    }
    renderRowTrigger(row);
    saveForm();
  });

  els.loraList.appendChild(row);
  renderRowTrigger(row);
  syncAddLoraBtn();
}

// 選択中の LoRA のトリガーワードと、プロンプトへ足すボタン
function renderRowTrigger(row) {
  const box = row.querySelector('.lora-trigger');
  const path = row.querySelector('.lora-select').value;
  box.innerHTML = '';
  const words = loraTriggerWords(path);
  box.hidden = words.length === 0;
  if (words.length === 0) return;

  for (const word of words) {
    const chip = document.createElement('span');
    chip.className = 'lib-trigger-chip';
    chip.textContent = word;
    box.appendChild(chip);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost-btn small';
  btn.textContent = '挿入';
  btn.title = 'トリガーワードを指示文の末尾に追加します';
  btn.addEventListener('click', () => insertTriggerWords(words));
  box.appendChild(btn);
}

function insertTriggerWords(words) {
  const current = els.prompt.value;
  const lower = current.toLowerCase();
  const missing = words.filter((w) => !lower.includes(w.toLowerCase()));
  if (missing.length === 0) return;
  const sep = current.trim() === '' ? '' : (/[,、]\s*$/.test(current) ? ' ' : ', ');
  els.prompt.value = current + sep + missing.join(', ');
  saveForm();
}

function syncAddLoraBtn() {
  const count = els.loraList.querySelectorAll('.lora-row').length;
  const empty = sortedLoraLibrary().length === 0;
  els.addLoraBtn.disabled = count >= MAX_LORAS || empty;
  els.addLoraBtn.title = count >= MAX_LORAS ? `LoRA はこのモデルでは最大 ${MAX_LORAS} 個までです` : '';
  // 登録が 1 つも無いときは、追加ボタンが押せない理由を出しておく
  els.loraHint.hidden = !empty;
}

function collectLoras() {
  return [...els.loraList.querySelectorAll('.lora-row')]
    .map((row) => ({
      path: row.querySelector('.lora-select').value,
      scale: Number(row.querySelector('input[type="number"]').value) || 0,
    }))
    // scale 0 は効果ゼロなのに LoRA 枠を消費するので送らない
    .filter((l) => l.path && l.scale > 0);
}

/* ---------- 入力画像 ---------- */

// { dataUri, url, width, height, from } を持つ。url は R2 に置いた履歴用の URL
let source = null;

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = src;
  });
}

// 長辺を MAX_INPUT_PX まで縮めて JPEG の data URI にする。
// 元のままだと data URI が数十 MB になり、キューへの送信が通らないことがある
function toSendableDataUri(img) {
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const ratio = longest > MAX_INPUT_PX ? MAX_INPUT_PX / longest : 1;
  const width = Math.round(img.naturalWidth * ratio);
  const height = Math.round(img.naturalHeight * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  return { dataUri: canvas.toDataURL('image/jpeg', INPUT_QUALITY), width, height };
}

// 既に R2 にある画像か（同一オリジンの /api/image/... なら保存済み）。
// img.src は絶対 URL になるので、相対・絶対のどちらでも判定できるようにする
function storedImageUrl(src) {
  try {
    const u = new URL(src, location.href);
    if (u.origin === location.origin && u.pathname.startsWith('/api/image/')) return u.pathname;
  } catch { /* data URI などはここに来る */ }
  return null;
}

async function uploadDataUri(dataUri, meta) {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUri, meta }),
  });
  if (!res.ok || isHtmlResponse(res)) throw new Error('画像の保存に失敗しました');
  return (await res.json()).url;
}

async function setSourceFromSrc(src, from) {
  setError('');
  setStatus('画像を読み込み中…');
  try {
    const img = await loadImageEl(src);
    const { dataUri, width, height } = toSendableDataUri(img);
    // 再開と履歴表示のために R2 にも置く。既に R2 にある画像（履歴・前回の結果・
    // 復元した入力）はそのまま使い回す（同じ画像を二重に持たない）
    const url = storedImageUrl(src)
      ?? await uploadDataUri(dataUri, { app: 'fal playground', source: 'imgedit-input' });
    source = { dataUri, url, width, height, from };
    renderSource();
    saveForm();
    setStatus('');
  } catch (err) {
    setStatus('');
    // 別ドメインの画像は canvas から取り出せない（fal の CDN 画像を保存前に
    // 読み込もうとした場合など）。原因が分かる文言にしておく
    setError(err.name === 'SecurityError'
      ? 'この画像は直接読み込めませんでした。保存済みの履歴から選び直してください。'
      : err.message);
  }
}

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setError('画像ファイルを選んでください');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => setSourceFromSrc(String(reader.result), 'file');
  reader.onerror = () => setError('ファイルを読み込めませんでした');
  reader.readAsDataURL(file);
}

function renderSource() {
  const has = !!source;
  els.sourcePreview.hidden = !has;
  els.uploadArea.hidden = has;
  if (has) {
    els.sourceImg.src = source.dataUri || source.url;
    els.sourceInfo.textContent = `${source.width} × ${source.height}`
      + (source.from === 'history' ? '（履歴から）' : source.from === 'result' ? '（前回の結果）' : '');
  }
  syncRunBtn();
}

function clearSource() {
  source = null;
  els.fileInput.value = '';
  renderSource();
  saveForm();
}

function syncRunBtn() {
  els.runBtn.disabled = !source || els.prompt.value.trim() === '' || running;
}

/* ---------- 履歴 ---------- */

let historyItems = [];

async function fetchHistory() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok || isHtmlResponse(res)) return;
    const all = await res.json();
    historyItems = Array.isArray(all) ? all : [];
  } catch {
    // オフライン時などは空のまま
  }
  renderGallery();
}

function recordThumb(record) {
  if (record.type === 'compare') {
    return record.variants?.find((v) => v.images?.length)?.images[0]?.url ?? '';
  }
  return record.images?.[0]?.url ?? '';
}

// この画面で作ったレコードだけを下部のギャラリーに並べる
function renderGallery() {
  const mine = historyItems.filter((r) => r.type === 'imgedit');
  els.gallery.innerHTML = '';
  els.galleryEmpty.hidden = mine.length > 0;
  for (const record of mine.slice(0, 24)) {
    const item = document.createElement('figure');
    item.className = 'ie-gallery-item';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = record.prompt || '編集結果';
    img.src = recordThumb(record);
    img.addEventListener('click', () => setSourceFromSrc(img.src, 'history'));
    item.appendChild(img);

    const cap = document.createElement('figcaption');
    cap.textContent = record.prompt || '';
    item.appendChild(cap);

    els.gallery.appendChild(item);
  }
}

function openHistoryPicker() {
  els.historyPicker.innerHTML = '';
  const withImages = historyItems.filter((r) => recordThumb(r));
  els.historyEmpty.hidden = withImages.length > 0;
  for (const record of withImages.slice(0, 60)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ie-picker-item';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = record.prompt || '';
    img.src = recordThumb(record);
    btn.appendChild(img);
    btn.addEventListener('click', () => {
      els.historyDialog.close();
      setSourceFromSrc(img.src, 'history');
    });
    els.historyPicker.appendChild(btn);
  }
  els.historyDialog.showModal();
}

async function saveHistoryRecord(record) {
  historyItems = [record, ...historyItems.filter((r) => r.id !== record.id)];
  renderGallery();
  try {
    const res = await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!res.ok || isHtmlResponse(res)) return record;
    // fal の CDN 画像はサーバー側で R2 に取り込まれ、失効しない URL に差し替わる
    const saved = await res.json();
    historyItems = [saved, ...historyItems.filter((r) => r.id !== saved.id)];
    renderGallery();
    return saved;
  } catch {
    return record; // 画像自体は fal 側にあるので、表示だけは続行する
  }
}

/* ---------- fal ---------- */

async function falFetch(url, options = {}) {
  const res = await fetch(`/api/fal/proxy?url=${encodeURIComponent(url)}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (isHtmlResponse(res)) throw new Error(ACCESS_EXPIRED_MSG);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 300) || `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text);
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
    } catch { /* JSON でなければそのまま出す */ }
    throw new Error(detail);
  }
  return res.json();
}

function buildInput(dataUri) {
  const size = SIZES.find((s) => s.value === els.sizeSelect.value);
  const input = {
    prompt: els.prompt.value.trim(),
    image_urls: [dataUri],
    num_images: Number(els.numImages.value),
    num_inference_steps: Number(els.steps.value) || 28,
    guidance_scale: Number(els.guidance.value) || 4.5,
    acceleration: els.acceleration.value,
    output_format: 'png',
  };
  if (size && size.width) input.image_size = { width: size.width, height: size.height };
  if (els.seedLock.checked && els.seed.value !== '') input.seed = Number(els.seed.value);
  const negative = els.negativePrompt.value.trim();
  if (negative) input.negative_prompt = negative;
  const loras = collectLoras();
  if (loras.length > 0) input.loras = loras;
  return input;
}

/* ---------- 実行 ---------- */

let running = false;
let cancelled = false;

function setRunning(on) {
  running = on;
  cancelled = false;
  els.cancelBtn.hidden = !on;
  syncRunBtn();
}

function saveJob(job) {
  localStorage.setItem(LS_JOB, JSON.stringify(job));
}

function clearJob() {
  localStorage.removeItem(LS_JOB);
}

async function run() {
  if (!source || running) return;
  const prompt = els.prompt.value.trim();
  if (prompt === '') return;

  setError('');
  setRunning(true);
  setStatus('リクエストを送信中…');

  const input = buildInput(source.dataUri);
  const job = {
    id: makeId(),
    startedAt: Date.now(),
    prompt,
    sourceUrl: source.url,
    // 送信内容のうち、履歴と再開に必要な分だけ控える（画像本体は持たない）
    params: { ...input, image_urls: undefined },
    loras: input.loras ?? [],
  };

  try {
    const submitted = await falFetch(`https://queue.fal.run/${MODEL_ID}`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    job.submitted = submitted;
    saveJob(job);
    await waitAndFinish(job);
  } catch (err) {
    setRunning(false);
    setStatus('');
    setError(cancelled ? 'キャンセルしました' : `編集に失敗しました: ${err.message}`);
    clearJob();
  }
}

// 送信済みジョブの完了待ち。ページを開き直したときもここから再開する
async function waitAndFinish(job) {
  setRunning(true);
  let status;
  do {
    await sleep(POLL_INTERVAL_MS);
    if (cancelled) throw new Error('キャンセルしました');
    status = await falFetch(job.submitted.status_url);
    const queue = status.queue_position;
    setStatus(status.status === 'IN_QUEUE' && Number.isFinite(queue)
      ? `順番待ち（${queue} 番目）…`
      : '編集中…');
  } while (status.status !== 'COMPLETED');

  const result = await falFetch(job.submitted.response_url);
  const images = result.images || (result.image ? [result.image] : []);
  if (images.length === 0) throw new Error('画像が返されませんでした');

  const record = {
    id: job.id,
    ts: Date.now(),
    type: 'imgedit',
    model: MODEL_ID,
    prompt: job.prompt,
    input: job.params,
    loras: job.loras,
    seed: result.seed ?? job.params?.seed ?? null,
    elapsed: ((Date.now() - job.startedAt) / 1000).toFixed(1),
    // 出力に続けて入力画像も残す（削除時に一括で消える）
    images: [...images.map((i) => ({ url: i.url, width: i.width, height: i.height })),
      { url: job.sourceUrl }],
  };
  clearJob();
  const saved = await saveHistoryRecord(record);
  setRunning(false);
  setStatus('');
  renderResult(saved, images.length);
}

function renderResult(record, outputCount) {
  els.resultPanel.hidden = false;
  els.resultMeta.textContent = `${record.elapsed} 秒`
    + (record.seed !== null && record.seed !== undefined ? ` ・ seed ${record.seed}` : '');
  els.resultImages.innerHTML = '';

  for (const [i, img] of record.images.entries()) {
    const isInput = i >= outputCount;
    const card = document.createElement('figure');
    card.className = 'ie-result-card';

    const el = document.createElement('img');
    el.src = img.url;
    el.alt = isInput ? '入力画像' : record.prompt;
    card.appendChild(el);

    const cap = document.createElement('figcaption');
    cap.textContent = isInput ? '入力画像' : `結果 ${i + 1}`;
    card.appendChild(cap);

    if (!isInput) {
      const actions = document.createElement('div');
      actions.className = 'ie-result-actions';

      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'ghost-btn small';
      again.textContent = 'この結果を編集';
      again.addEventListener('click', () => {
        setSourceFromSrc(img.url, 'result');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      actions.appendChild(again);

      const open = document.createElement('a');
      open.className = 'ghost-btn small';
      open.href = img.url;
      open.target = '_blank';
      open.rel = 'noreferrer';
      open.textContent = '原寸で開く';
      actions.appendChild(open);

      card.appendChild(actions);
    }
    els.resultImages.appendChild(card);
  }
  els.resultPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// 送信済みのまま閉じられたジョブを拾って続きから待つ
async function resumeJob() {
  let job;
  try {
    job = JSON.parse(localStorage.getItem(LS_JOB));
  } catch {
    job = null;
  }
  if (!job?.submitted?.status_url) return;
  setStatus('前回の編集の結果を確認中…');
  try {
    await waitAndFinish(job);
  } catch (err) {
    setRunning(false);
    setStatus('');
    setError(`前回の編集を再開できませんでした: ${err.message}`);
    clearJob();
  }
}

/* ---------- 入力内容の保存 ---------- */

function saveForm() {
  const state = {
    prompt: els.prompt.value,
    size: els.sizeSelect.value,
    numImages: els.numImages.value,
    steps: els.steps.value,
    guidance: els.guidance.value,
    acceleration: els.acceleration.value,
    seed: els.seed.value,
    seedLock: els.seedLock.checked,
    negativePrompt: els.negativePrompt.value,
    loras: collectLoras(),
    // 画像本体は大きすぎるので保存しない。R2 の URL から読み直す
    source: source ? { url: source.url, from: source.from } : null,
  };
  localStorage.setItem(LS_FORM, JSON.stringify(state));
}

async function restoreForm() {
  let s;
  try {
    s = JSON.parse(localStorage.getItem(LS_FORM));
  } catch {
    s = null;
  }
  if (!s) return;

  els.prompt.value = s.prompt || '';
  if (s.size) els.sizeSelect.value = s.size;
  if (s.numImages) els.numImages.value = s.numImages;
  if (s.steps) els.steps.value = s.steps;
  if (s.guidance) els.guidance.value = s.guidance;
  if (s.acceleration) els.acceleration.value = s.acceleration;
  els.seed.value = s.seed || '';
  els.seedLock.checked = !!s.seedLock;
  els.negativePrompt.value = s.negativePrompt || '';
  for (const l of s.loras || []) addLoraRow(l.path, l.scale);
  syncRunBtn();
  if (s.source?.url) await setSourceFromSrc(s.source.url, s.source.from || 'history');
}

/* ---------- init ---------- */

initTheme();

for (const size of SIZES) {
  const opt = document.createElement('option');
  opt.value = size.value;
  opt.textContent = size.label;
  els.sizeSelect.appendChild(opt);
}

els.pickFileBtn.addEventListener('click', () => els.fileInput.click());
els.uploadArea.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => loadFile(els.fileInput.files?.[0]));
els.clearSourceBtn.addEventListener('click', clearSource);
els.pickHistoryBtn.addEventListener('click', openHistoryPicker);

for (const type of ['dragenter', 'dragover']) {
  els.uploadArea.addEventListener(type, (e) => {
    e.preventDefault();
    els.uploadArea.classList.add('dragover');
  });
}
for (const type of ['dragleave', 'drop']) {
  els.uploadArea.addEventListener(type, (e) => {
    e.preventDefault();
    els.uploadArea.classList.remove('dragover');
  });
}
els.uploadArea.addEventListener('drop', (e) => loadFile(e.dataTransfer?.files?.[0]));

els.addLoraBtn.addEventListener('click', () => addLoraRow());
els.prompt.addEventListener('input', () => { syncRunBtn(); saveForm(); });
for (const el of [els.sizeSelect, els.numImages, els.steps, els.guidance,
  els.acceleration, els.seed, els.seedLock, els.negativePrompt]) {
  el.addEventListener('change', saveForm);
}

els.runBtn.addEventListener('click', run);
els.cancelBtn.addEventListener('click', () => {
  cancelled = true;
  setStatus('キャンセルしています…');
});

syncAddLoraBtn();
restoreForm();
fetchHistory().then(resumeJob);
