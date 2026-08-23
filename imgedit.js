'use strict';

/* ==========================================================================
 * 画像編集（Qwen Image Edit 2511 + LoRA）
 *
 * 入力画像 1 枚 + 指示文 + LoRA で画像を編集する別画面。既存の「部分AI編集」
 * （Poe・範囲を切り抜いてはめ込む）とは別枠で、画像全体をモデルに渡す。
 *
 * - 同じモデルを fal と WaveSpeed の 2 プロバイダから選べる。API の形が違うので
 *   PROVIDERS のアダプタで吸収する（送信内容の組み立て・投入・ポーリング・結果の解釈）
 * - どちらも Worker のプロキシ経由（/api/fal/proxy・/api/wavespeed/proxy）で呼ぶ。
 *   API キーはブラウザに渡さない
 * - 入力画像は data URI として fal に渡す。このアプリは Cloudflare Access の
 *   内側に置く前提で、/api/image/... を fal から取りに行けるとは限らないため
 * - 同じ画像は R2 にも保存し（/api/upload）、履歴レコードと再開用に使う。
 *   data URI は localStorage に置くには大きすぎるので保存しない
 * - 結果は type: 'imgedit' の履歴レコードとして /api/history に保存するので、
 *   生成画面のギャラリーにもそのまま並ぶ
 * ========================================================================== */

/* ---------- constants ---------- */

const MAX_LORAS = 3; // どちらのプロバイダも最大 3 個
const MAX_INPUT_PX = 2048; // 送信前に長辺をここまで縮める
const INPUT_QUALITY = 0.92; // 縮小後の JPEG 品質

const LS_THEME = 'fal_theme';
const HF_DEFAULT_REPO = 'tottie2215/temp_str'; // 取り込み先の既定（app.js と同じ）
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
  maskCanvas: $('#maskCanvas'),
  maskToggle: $('#maskToggle'),
  maskTools: $('#maskTools'),
  maskUndoBtn: $('#maskUndoBtn'),
  maskAllBtn: $('#maskAllBtn'),
  maskClearBtn: $('#maskClearBtn'),
  maskSize: $('#maskSize'),
  maskSizeVal: $('#maskSizeVal'),
  maskFeather: $('#maskFeather'),
  maskFeatherVal: $('#maskFeatherVal'),
  prompt: $('#prompt'),
  provider: $('#provider'),
  providerHint: $('#providerHint'),
  loraList: $('#loraList'),
  addLoraBtn: $('#addLoraBtn'),
  civitaiBtn: $('#civitaiBtn'),
  loraHint: $('#loraHint'),
  sizeSelect: $('#sizeSelect'),
  numImages: $('#numImages'),
  steps: $('#steps'),
  guidance: $('#guidance'),
  acceleration: $('#acceleration'),
  outputFormat: $('#outputFormat'),
  seed: $('#seed'),
  seedLock: $('#seedLock'),
  negativePrompt: $('#negativePrompt'),
  runBtn: $('#runBtn'),
  costHint: $('#costHint'),
  cancelBtn: $('#cancelBtn'),
  status: $('#status'),
  error: $('#error'),
  resultPanel: $('#resultPanel'),
  resultMeta: $('#resultMeta'),
  resultMaskHint: $('#resultMaskHint'),
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

const loraLabel = (path) => loraLib.label(path);
const loraDefaultScale = (path) => loraLib.defaultScale(path);
const loraTriggerWords = (path) => loraLib.triggerWords(path);

// このモデルは Qwen Image Edit なので、Qwen 用の LoRA だけを候補にする
// （Krea 2 用を混ぜても効かないか、出力が壊れる）
const LORA_BASE = 'qwen';

function sortedLoraLibrary() {
  return loraLib.forBase(LORA_BASE);
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
  const usable = sortedLoraLibrary().length;
  els.addLoraBtn.disabled = count >= MAX_LORAS || usable === 0;
  els.addLoraBtn.title = count >= MAX_LORAS ? `LoRA はこのモデルでは最大 ${MAX_LORAS} 個までです` : '';

  // 使える LoRA が無い / 別のベースモデル向けを隠したことを伝える
  const hidden = loraLib.load().length - usable;
  els.loraHint.hidden = usable > 0 && hidden === 0;
  els.loraHint.textContent = usable === 0
    ? 'Qwen 用の LoRA が登録されていません。下の「Civitai から取り込み」で追加できます（Krea 2 用の LoRA はこのモデルでは使えません）。'
    : `Qwen 以外の LoRA ${hidden} 件は候補から外しています（ベースモデルはライブラリ管理で直せます）。`;
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

// replace に既存の /api/image/... を渡すと、新しく作らずその画像を差し替える
// （マスクの塗り直しのたびに合成画像が増えて置き去りになるのを防ぐ）
async function uploadDataUri(dataUri, meta, replace = null) {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUri, meta, ...(replace ? { replace } : {}) }),
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
  syncMaskUi();
  syncRunBtn();
}

function clearSource() {
  source = null;
  els.fileInput.value = '';
  renderSource();
  saveForm();
}

function syncRunBtn() {
  els.runBtn.disabled = !source || els.prompt.value.trim() === '' || running
    || (maskOn() && mask.strokes.length === 0);
  renderCostHint();
}

/* ==========================================================================
 * マスク
 *
 * モデルにはマスクを渡せない（画像全体が編集されて返る）ので、返ってきた画像を
 * マスクの内側だけ元画像に重ねて合成する。合成はすべてブラウザ側で行うため、
 * 塗り直せば作り直さずに結果が変わる（履歴のマスクも同じ仕組みで描き直せる）。
 *
 * 塗りは「正規化した座標のストローク」で持つ。ピクセルのマスク画像で持つと
 * 保存が重く、出力の解像度が入力と違うときに合わせられないため
 * ========================================================================== */

// { strokes: [{ mode, r, pts: [[x, y], ...] }], feather }。座標・太さ・ぼかしは
// すべて 0..1（太さとぼかしは長辺に対する比率）
const EMPTY_MASK = { strokes: [], feather: 0.01 };

let mask = structuredClone(EMPTY_MASK);
let maskTool = 'add'; // 'add' | 'erase'
let maskStroke = null; // ドラッグ中のストローク

function maskOn() {
  return els.maskToggle.checked;
}

// スライダー（1..40 / 0..20）と比率の対応。長辺に対する % で持つ
const maskSizeRatio = () => Number(els.maskSize.value) / 400;
const maskFeatherRatio = () => Number(els.maskFeather.value) / 400;

function syncMaskUi() {
  const on = maskOn() && !!source;
  els.maskTools.hidden = !on;
  els.maskCanvas.hidden = !on;
  els.sourcePreview.classList.toggle('masking', on);
  els.maskSizeVal.textContent = `${els.maskSize.value}`;
  els.maskFeatherVal.textContent = els.maskFeather.value === '0'
    ? 'なし' : `${els.maskFeather.value}`;
  els.maskUndoBtn.disabled = mask.strokes.length === 0;
  els.maskClearBtn.disabled = mask.strokes.length === 0;
  // 出力サイズが入力と違うと重ねられないので、マスク中は入力に合わせる
  els.sizeSelect.disabled = on;
  if (on && els.sizeSelect.value !== 'auto') {
    els.sizeSelect.value = 'auto';
    renderCostHint();
  }
  if (on) drawMaskOverlay();
}

/* ---------- マスクの描画（ラスタライズ） ---------- */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// ぼかし。ctx.filter が無い環境（古い iOS Safari など）では、縮小して拡大し直す
// ことで近い見た目にする（完全な gaussian ではないが縁は滑らかになる）
function blurCanvas(src, radius) {
  if (radius < 0.5) return src;
  const out = makeCanvas(src.width, src.height);
  const ctx = out.getContext('2d');
  if (typeof ctx.filter === 'string') {
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(src, 0, 0);
    return out;
  }
  const scale = Math.max(1 / 64, 1 / Math.max(1, radius));
  const small = makeCanvas(src.width * scale, src.height * scale);
  const sctx = small.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(src, 0, 0, small.width, small.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, out.width, out.height);
  return out;
}

// マスクを w×h のアルファ（白 = 差し替える）として描く。
// ぼかしぶんは縁が半透明になり、そのまま合成の混ざり具合になる
function rasterizeMask(w, h, strokes = mask.strokes, feather = mask.feather) {
  const long = Math.max(w, h);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  for (const stroke of strokes) {
    ctx.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over';
    if (stroke.rect) {
      // 「全面」。ぼかしで画像の縁が薄くならないよう外側まで塗る
      ctx.fillRect(-long, -long, w + long * 2, h + long * 2);
      continue;
    }
    const width = Math.max(1, stroke.r * 2 * long);
    ctx.lineWidth = width;
    const pts = stroke.pts;
    if (pts.length === 1) {
      // 点置き（タップ）は線にならないので円で塗る
      ctx.beginPath();
      ctx.arc(pts[0][0] * w, pts[0][1] * h, width / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
    for (const [x, y] of pts.slice(1)) ctx.lineTo(x * w, y * h);
    ctx.stroke();
  }
  return blurCanvas(c, feather * long);
}

// 入力画像の上に重ねる表示。差し替わる側を明るいまま残し、外側を暗くする
//（部分AI編集の選択範囲と同じ見せ方）。ぼかしはそのまま濃淡として出るので、
// どのくらい滑らかに混ざるかが塗りながら分かる
function drawMaskOverlay() {
  const img = els.sourceImg;
  const box = img.getBoundingClientRect();
  if (box.width === 0) return; // 画像がまだ表示されていない
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(box.width * dpr);
  const h = Math.round(box.height * dpr);
  if (els.maskCanvas.width !== w || els.maskCanvas.height !== h) {
    els.maskCanvas.width = w;
    els.maskCanvas.height = h;
  }
  const ctx = els.maskCanvas.getContext('2d');
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);

  const strokes = maskStroke ? [...mask.strokes, maskStroke] : mask.strokes;
  if (strokes.length === 0) return;
  const shape = rasterizeMask(w, h, strokes, mask.feather);

  // 外側を暗くする（塗った側だけが元の明るさで残る）
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(shape, 0, 0);

  // 塗った側にうっすらアクセント色を乗せて、暗いだけの画像と見分けられるようにする
  const tint = makeCanvas(w, h);
  const tctx = tint.getContext('2d');
  tctx.drawImage(shape, 0, 0);
  tctx.globalCompositeOperation = 'source-in';
  tctx.fillStyle = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim() || '#2563eb';
  tctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.28;
  ctx.drawImage(tint, 0, 0);
  ctx.globalAlpha = 1;
}

/* ---------- 塗る操作 ---------- */

function maskPoint(e) {
  const box = els.sourceImg.getBoundingClientRect();
  return [
    Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
    Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
  ];
}

function onMaskDown(e) {
  if (!maskOn() || !source) return;
  e.preventDefault();
  els.maskCanvas.setPointerCapture(e.pointerId);
  maskStroke = { mode: maskTool, r: maskSizeRatio(), pts: [maskPoint(e)] };
  drawMaskOverlay();
}

function onMaskMove(e) {
  if (!maskStroke) return;
  e.preventDefault();
  const p = maskPoint(e);
  const last = maskStroke.pts.at(-1);
  // 細かすぎる点は捨てる（保存が膨らむだけで見た目は変わらない）
  if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.004) return;
  maskStroke.pts.push(p);
  drawMaskOverlay();
}

function onMaskUp() {
  if (!maskStroke) return;
  mask.strokes.push(maskStroke);
  maskStroke = null;
  commitMaskChange();
}

// 塗り終わり・ぼかし変更のたびに呼ぶ。表示中の結果があればその場で合成し直す
function commitMaskChange() {
  syncMaskUi();
  syncRunBtn();
  saveForm();
  refreshResultComposite();
}

function maskUndo() {
  mask.strokes.pop();
  commitMaskChange();
}

function maskClear() {
  mask.strokes = [];
  commitMaskChange();
}

function maskAll() {
  mask.strokes.push({ mode: 'add', rect: true, pts: [] });
  commitMaskChange();
}

/* ---------- 合成 ---------- */

// 出力画像をマスクの内側だけ元画像に重ねる。合成は出力の解像度で行い、
// 元画像はそこへ引き伸ばす（出力が入力より大きいときに解像度を落とさない）
function compositeWithMask(baseImg, editedImg, maskData) {
  const w = editedImg.naturalWidth || editedImg.width;
  const h = editedImg.naturalHeight || editedImg.height;
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(baseImg, 0, 0, w, h);

  const layer = makeCanvas(w, h);
  const lctx = layer.getContext('2d');
  lctx.drawImage(editedImg, 0, 0, w, h);
  lctx.globalCompositeOperation = 'destination-in';
  lctx.drawImage(rasterizeMask(w, h, maskData.strokes, maskData.feather), 0, 0);

  ctx.drawImage(layer, 0, 0);
  return out;
}

// URL から合成した data URI を作る。画像は同一オリジン（R2）である必要がある
// （別ドメインのままだと canvas が汚染されて取り出せない）
async function compositeFromUrls(baseUrl, editedUrl, maskData, mime = 'image/png') {
  const [baseImg, editedImg] = await Promise.all([loadImageEl(baseUrl), loadImageEl(editedUrl)]);
  const canvas = compositeWithMask(baseImg, editedImg, maskData);
  return {
    dataUri: canvas.toDataURL(mime, 0.95),
    width: canvas.width,
    height: canvas.height,
  };
}

// 費用の目安。課金の考え方がプロバイダごとに違う（fal は解像度、WaveSpeed は枚数）
function renderCostHint() {
  const text = provider().costHint();
  els.costHint.hidden = !text;
  els.costHint.textContent = text;
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

    // マスクで合成したものは、あとからでも範囲を変えられる
    if (record.masked) {
      const adjust = document.createElement('button');
      adjust.type = 'button';
      adjust.className = 'ghost-btn small ie-gallery-adjust';
      adjust.textContent = 'マスクを調整';
      adjust.addEventListener('click', () => reopenMaskedResult(record));
      item.appendChild(adjust);
    }

    els.gallery.appendChild(item);
  }
}

// 過去の合成結果を開き直して、マスクだけを塗り替えられるようにする。
// 入力画像はそのレコードのものに戻す（合成の相手が変わらないように）
async function reopenMaskedResult(record) {
  const inputUrl = record.images.at(-1)?.url;
  if (!inputUrl) return;
  els.maskToggle.checked = true;
  mask = record.mask?.strokes ? structuredClone(record.mask) : structuredClone(EMPTY_MASK);
  els.maskFeather.value = String(Math.round((mask.feather ?? 0.01) * 400));
  els.prompt.value = record.prompt || '';
  await setSourceFromSrc(inputUrl, 'history');
  syncMaskUi();
  saveForm();
  renderResult(record);
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

/* ---------- プロバイダ ---------- */

// 同じ Qwen Image Edit 2511 でも API の形が違うので、ここで差を吸収する。
// supports に無い項目は UI ごと隠す（送っても無視される項目を見せない）
const PROVIDERS = {
  fal: {
    label: 'fal（fal-ai/qwen-image-edit-2511/lora）',
    model: 'fal-ai/qwen-image-edit-2511/lora',
    note: '解像度・ステップ・ガイダンスまで指定できます。課金はメガピクセル単価（$0.035/MP）。',
    supports: { size: true, count: true, steps: true, guidance: true, acceleration: true, negative: true },
    pollMs: 1200,

    buildInput(dataUri) {
      const size = SIZES.find((x) => x.value === els.sizeSelect.value);
      const input = {
        prompt: els.prompt.value.trim(),
        image_urls: [dataUri],
        num_images: Number(els.numImages.value),
        num_inference_steps: Number(els.steps.value) || 28,
        guidance_scale: Number(els.guidance.value) || 4.5,
        acceleration: els.acceleration.value,
        output_format: els.outputFormat.value,
      };
      if (size && size.width) input.image_size = { width: size.width, height: size.height };
      if (els.seedLock.checked && els.seed.value !== '') input.seed = Number(els.seed.value);
      const negative = els.negativePrompt.value.trim();
      if (negative) input.negative_prompt = negative;
      const loras = collectLoras();
      if (loras.length > 0) input.loras = loras;
      return input;
    },

    // 画像本体は履歴にも再開用の記録にも残さない
    strip(input) {
      return { ...input, image_urls: undefined };
    },

    async submit(input) {
      const res = await proxyFetch('fal', `https://queue.fal.run/${this.model}`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return { statusUrl: res.status_url, responseUrl: res.response_url, requestId: res.request_id };
    },

    async poll(handle) {
      const status = await proxyFetch('fal', handle.statusUrl);
      if (status.status !== 'COMPLETED') {
        const queue = status.queue_position;
        return {
          done: false,
          text: status.status === 'IN_QUEUE' && Number.isFinite(queue) ? `順番待ち（${queue} 番目）…` : '編集中…',
        };
      }
      return { done: true, result: await proxyFetch('fal', handle.responseUrl) };
    },

    parse(result) {
      const images = result.images || (result.image ? [result.image] : []);
      return {
        images: images.map((i) => ({ url: i.url, width: i.width, height: i.height })),
        seed: result.seed ?? null,
        // 安全性チェックに引っかかった画像は fal 側で黒く塗り潰されて返る
        flagged: (result.has_nsfw_concepts ?? []).filter(Boolean).length,
      };
    },

    costHint() {
      const size = SIZES.find((x) => x.value === els.sizeSelect.value);
      const width = size?.width ?? source?.width;
      const height = size?.height ?? source?.height;
      if (!width || !height) return '';
      const mp = (width * height) / 1e6 * Number(els.numImages.value);
      return `出力 ${width}×${height} × ${els.numImages.value} 枚`
        + ` ・ ${mp.toFixed(1)} MP ・ 目安 $${(mp * 0.035).toFixed(3)}`;
    },
  },

  wavespeed: {
    label: 'WaveSpeed（wavespeed-ai/qwen-image/edit-2511-lora）',
    model: 'wavespeed-ai/qwen-image/edit-2511-lora',
    note: '指定できるのは指示文・LoRA・seed・形式だけです（解像度やステップは API に無く、出力は 1 枚）。課金は 1 枚 $0.025 の固定制。LoRA は公開アクセスできる URL である必要があります。',
    supports: {},
    pollMs: 2000,
    endpoint: 'https://api.wavespeed.ai/api/v3/wavespeed-ai/qwen-image/edit-2511-lora',

    buildInput(dataUri) {
      const input = {
        prompt: els.prompt.value.trim(),
        images: [dataUri], // 1 枚目がベース画像（最大 3 枚まで渡せる仕様）
        // 未指定は -1（ランダム）。fal と違って省略ではなく明示する
        seed: els.seedLock.checked && els.seed.value !== '' ? Number(els.seed.value) : -1,
        // 既定が jpeg なので、劣化させないよう常に明示して送る
        output_format: els.outputFormat.value,
      };
      const loras = collectLoras();
      if (loras.length > 0) input.loras = loras;
      return input;
    },

    strip(input) {
      return { ...input, images: undefined };
    },

    async submit(input) {
      const res = await proxyFetch('wavespeed', this.endpoint, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      const data = res.data ?? res;
      if (!data?.id && !data?.urls?.get) throw new Error('予測 ID が返りませんでした');
      return {
        id: data.id,
        resultUrl: data.urls?.get ?? `https://api.wavespeed.ai/api/v3/predictions/${data.id}/result`,
      };
    },

    async poll(handle) {
      const res = await proxyFetch('wavespeed', handle.resultUrl);
      const data = res.data ?? res;
      if (data.status === 'completed') return { done: true, result: data };
      if (['failed', 'cancelled', 'timeout'].includes(data.status)) {
        throw new Error(data.error || `処理が ${data.status} で終わりました`);
      }
      return { done: false, text: data.status === 'created' ? '順番待ち…' : '編集中…' };
    },

    parse(result) {
      // outputs は URL 文字列の配列。モデルによっては構造化オブジェクトが来る
      const images = (result.outputs ?? [])
        .map((o) => (typeof o === 'string' ? { url: o } : { url: o?.url, width: o?.width, height: o?.height }))
        .filter((i) => i.url);
      return { images, seed: result.seed ?? null, flagged: 0 };
    },

    costHint() {
      return '出力 1 枚 ・ 目安 $0.025（枚数固定の課金）';
    },
  },
};

let providerId = 'fal';

function provider() {
  return PROVIDERS[providerId] ?? PROVIDERS.fal;
}

// どちらのプロバイダも Worker のプロキシ経由で呼ぶ（API キーをブラウザに置かない）
async function proxyFetch(name, url, options = {}) {
  const res = await fetch(`/api/${name}/proxy?url=${encodeURIComponent(url)}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (isHtmlResponse(res)) throw new Error(ACCESS_EXPIRED_MSG);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 300) || `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text);
      // fal は detail、WaveSpeed は message にエラー内容を入れる
      const raw = body.detail ?? body.message ?? body;
      detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
    } catch { /* JSON でなければそのまま出す */ }
    throw new Error(detail);
  }
  return res.json();
}

// プロバイダが対応していない項目は隠す
function syncProviderFields() {
  for (const el of document.querySelectorAll('[data-only]')) {
    el.hidden = el.dataset.only !== providerId;
  }
  els.providerHint.textContent = provider().note;
  renderCostHint();
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

  const api = provider();
  const input = api.buildInput(source.dataUri);
  const job = {
    id: makeId(),
    provider: providerId,
    model: api.model,
    startedAt: Date.now(),
    prompt,
    sourceUrl: source.url,
    // 送信内容のうち、履歴と再開に必要な分だけ控える（画像本体は持たない）
    params: api.strip(input),
    loras: input.loras ?? [],
    // 合成はモデルの応答が返ったあとに行うので、そのときのマスクを控えておく
    mask: maskOn() && mask.strokes.length > 0 ? structuredClone(mask) : null,
  };

  try {
    job.handle = await api.submit(input);
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
  const api = PROVIDERS[job.provider] ?? PROVIDERS.fal;
  setRunning(true);
  let poll;
  do {
    await sleep(api.pollMs);
    if (cancelled) throw new Error('キャンセルしました');
    poll = await api.poll(job.handle);
    if (!poll.done) setStatus(poll.text);
  } while (!poll.done);

  const { images, seed, flagged } = api.parse(poll.result);
  if (images.length === 0) throw new Error('画像が返されませんでした');

  // seed 未指定を表す -1 は「ランダム」なので記録しない
  const usedSeed = seed ?? (job.params?.seed >= 0 ? job.params.seed : null);
  const record = {
    id: job.id,
    ts: Date.now(),
    type: 'imgedit',
    model: job.model ?? api.model,
    prompt: job.prompt,
    input: job.params,
    loras: job.loras,
    seed: usedSeed,
    elapsed: ((Date.now() - job.startedAt) / 1000).toFixed(1),
    outputCount: images.length,
    // 出力に続けて入力画像も残す（削除時に一括で消える）
    images: [...images, { url: job.sourceUrl }],
  };
  clearJob();
  // 先に保存する。fal / WaveSpeed の CDN 画像はここで R2 に取り込まれて同一
  // オリジンになり、canvas で合成できるようになる（別ドメインのままだと読めない）
  let saved = await saveHistoryRecord(record);

  if (job.mask) {
    setStatus('マスクの内側だけを合成中…');
    try {
      saved = await buildMaskedRecord(saved, job.mask);
      saved = await saveHistoryRecord(saved);
    } catch (err) {
      // 合成できなくても、生成そのものは成功している。マスクなしの結果を出す
      setError(`マスクの合成に失敗しました（生成結果はそのまま残っています）: ${err.message}`);
    }
  }

  setRunning(false);
  setStatus(flagged > 0
    ? `安全性チェックにより ${flagged} 枚が塗り潰されて返りました`
    : '');
  renderResult(saved);
}

// 保存済みレコードの各出力をマスク合成し、結果を先頭に足したレコードを返す。
// images は [合成 …, 生成結果そのまま …, 入力画像] の順になる
async function buildMaskedRecord(record, maskData) {
  const n = record.outputCount ?? record.images.length - 1;
  const inputUrl = record.images.at(-1).url;
  // 既に合成済みなら先頭 n 枚が前回の合成、その後ろが生成結果そのまま
  const previous = record.masked ? record.images.slice(0, n) : []; // 差し替え先
  const tail = record.masked ? record.images.slice(n) : record.images; // [生成結果 …, 入力]
  const raws = tail.slice(0, n);
  const composites = [];
  for (const [i, raw] of raws.entries()) {
    const { dataUri, width, height } = await compositeFromUrls(inputUrl, raw.url, maskData);
    const url = await uploadDataUri(
      dataUri,
      { app: 'fal playground', source: 'imgedit-masked', model: record.model, prompt: record.prompt },
      previous[i]?.url ?? null,
    );
    composites.push({ url, width, height });
  }
  return { ...record, masked: true, mask: maskData, images: [...composites, ...tail] };
}

// images の並びから各画像の役割を決める。
// マスクあり: [合成 …, 生成結果そのまま …, 入力] / マスクなし: [結果 …, 入力]
function resultRoles(record) {
  const n = record.outputCount ?? record.images.length - 1;
  return record.images.map((img, i) => {
    if (i < n) return { img, role: 'result', index: i };
    if (record.masked && i < n * 2) return { img, role: 'raw', index: i - n };
    return { img, role: 'input', index: 0 };
  });
}

const ROLE_LABELS = {
  result: (i, masked) => (masked ? `合成結果 ${i + 1}` : `結果 ${i + 1}`),
  raw: (i) => `生成結果そのまま ${i + 1}（マスク前）`,
  input: () => '入力画像',
};

function renderResult(record) {
  shownResult = record;
  els.resultPanel.hidden = false;
  els.resultMeta.textContent = `${record.elapsed} 秒`
    + (record.seed !== null && record.seed !== undefined ? ` ・ seed ${record.seed}` : '');
  els.resultMaskHint.hidden = !record.masked;
  els.resultImages.innerHTML = '';

  for (const { img, role, index } of resultRoles(record)) {
    const isInput = role === 'input';
    const card = document.createElement('figure');
    card.className = 'ie-result-card';
    if (role === 'result') card.dataset.resultIndex = String(index);

    const el = document.createElement('img');
    el.src = img.url;
    el.alt = isInput ? '入力画像' : record.prompt;
    card.appendChild(el);

    const cap = document.createElement('figcaption');
    cap.textContent = ROLE_LABELS[role](index, record.masked);
    card.appendChild(cap);

    if (role === 'result') {
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

/* ---------- 表示中の結果をマスクの変更に追従させる ---------- */

let shownResult = null; // 結果パネルに出しているレコード
let maskSaveTimer = null;

// 表示中の結果が、今の入力画像から作られたものか。
// 別の画像に差し替えたあとの塗り直しを、前の結果に反映させないため
function resultFollowsMask() {
  return !!(shownResult?.masked && source && shownResult.images.at(-1)?.url === source.url);
}

// 塗り直したら、その場で合成し直して表示だけ先に更新する（作り直しはしない）。
// 保存とアップロードは重いので、操作が落ち着いてからまとめて行う
let compositeRun = 0;

async function refreshResultComposite() {
  if (!resultFollowsMask()) return;
  const record = shownResult;
  const current = structuredClone(mask);
  const run = ++compositeRun;
  const n = record.outputCount ?? 1;
  const inputUrl = record.images.at(-1).url;
  try {
    for (let i = 0; i < n; i++) {
      const raw = record.images[n + i];
      if (!raw) continue;
      const { dataUri } = await compositeFromUrls(inputUrl, raw.url, current);
      if (run !== compositeRun || shownResult !== record) return; // 続けて塗られた
      const el = els.resultImages.querySelector(`[data-result-index="${i}"] img`);
      if (el) el.src = dataUri;
    }
  } catch {
    return; // 画像を読み直せないときは保存もしない
  }
  record.mask = current;
  scheduleMaskSave(record);
}

const MASK_SAVE_DELAY_MS = 2000;

function scheduleMaskSave(record) {
  clearTimeout(maskSaveTimer);
  maskSaveTimer = setTimeout(() => saveMaskedResult(record), MASK_SAVE_DELAY_MS);
}

// 合成画像を作り直して履歴を更新する。合成画像は同じ URL へ上書きするので、
// 塗り直しを繰り返しても保存される画像は増えない
async function saveMaskedResult(record) {
  if (shownResult !== record) return;
  try {
    const updated = await buildMaskedRecord(record, record.mask);
    if (shownResult !== record) return;
    shownResult = await saveHistoryRecord(updated);
    setStatus('マスクの変更を保存しました', true);
  } catch (err) {
    setError(`マスクの保存に失敗しました: ${err.message}`);
  }
}

// 送信済みのまま閉じられたジョブを拾って続きから待つ
async function resumeJob() {
  let job;
  try {
    job = JSON.parse(localStorage.getItem(LS_JOB));
  } catch {
    job = null;
  }
  if (!job?.handle) return;
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
    provider: providerId,
    size: els.sizeSelect.value,
    numImages: els.numImages.value,
    steps: els.steps.value,
    guidance: els.guidance.value,
    acceleration: els.acceleration.value,
    outputFormat: els.outputFormat.value,
    seed: els.seed.value,
    seedLock: els.seedLock.checked,
    negativePrompt: els.negativePrompt.value,
    loras: collectLoras(),
    // 画像本体は大きすぎるので保存しない。R2 の URL から読み直す
    source: source ? { url: source.url, from: source.from } : null,
    maskOn: els.maskToggle.checked,
    maskSize: els.maskSize.value,
    maskFeather: els.maskFeather.value,
    mask, // ストロークなので軽い（画像として持つと保存に収まらない）
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
  if (s.provider && PROVIDERS[s.provider]) {
    providerId = s.provider;
    els.provider.value = providerId;
  }
  if (s.size) els.sizeSelect.value = s.size;
  if (s.numImages) els.numImages.value = s.numImages;
  if (s.steps) els.steps.value = s.steps;
  if (s.guidance) els.guidance.value = s.guidance;
  if (s.acceleration) els.acceleration.value = s.acceleration;
  if (s.outputFormat) els.outputFormat.value = s.outputFormat;
  els.seed.value = s.seed || '';
  els.seedLock.checked = !!s.seedLock;
  els.negativePrompt.value = s.negativePrompt || '';
  for (const l of s.loras || []) addLoraRow(l.path, l.scale);
  els.maskToggle.checked = !!s.maskOn;
  if (s.maskSize) els.maskSize.value = s.maskSize;
  if (s.maskFeather) els.maskFeather.value = s.maskFeather;
  if (Array.isArray(s.mask?.strokes)) mask = s.mask;
  syncProviderFields();
  syncRunBtn();
  if (s.source?.url) await setSourceFromSrc(s.source.url, s.source.from || 'history');
  syncMaskUi();
}

/* ---------- init ---------- */

// LoRA ライブラリ（共有モジュール）。この画面は同期を持たないので保存だけ行う
loraLib.migrate();

// Civitai からの取り込み。登録したらその場で候補に出す
civitaiImport.init({
  defaultRepo: HF_DEFAULT_REPO,
  register(kind, hfUrl, meta) {
    // この画面から入れたものは Qwen 用として扱う（Civitai 側の表記があればそちら優先）
    loraLib.register(hfUrl, { ...(meta ?? {}), base: meta?.base || 'Qwen' });
    syncAddLoraBtn();
    for (const row of els.loraList.querySelectorAll('.lora-row')) renderRowTrigger(row);
    return `ライブラリに登録しました: ${loraLib.label(hfUrl)}`;
  },
});

initTheme();

for (const [id, api] of Object.entries(PROVIDERS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = api.label;
  els.provider.appendChild(opt);
}
els.provider.value = providerId;
els.provider.addEventListener('change', () => {
  providerId = els.provider.value;
  syncProviderFields();
  saveForm();
});

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
els.civitaiBtn.addEventListener('click', () => civitaiImport.open('lora'));
els.prompt.addEventListener('input', () => { syncRunBtn(); saveForm(); });
for (const el of [els.sizeSelect, els.numImages, els.steps, els.guidance,
  els.acceleration, els.outputFormat, els.seed, els.seedLock, els.negativePrompt]) {
  el.addEventListener('change', saveForm);
}
// 出力サイズと枚数は費用の目安に効く
for (const el of [els.sizeSelect, els.numImages]) {
  el.addEventListener('change', renderCostHint);
}

/* ---------- マスクの操作 ---------- */

els.maskToggle.addEventListener('change', () => {
  syncMaskUi();
  syncRunBtn();
  saveForm();
});

for (const btn of els.maskTools.querySelectorAll('.seg-btn')) {
  btn.addEventListener('click', () => {
    maskTool = btn.dataset.tool;
    for (const other of els.maskTools.querySelectorAll('.seg-btn')) {
      other.classList.toggle('active', other === btn);
    }
  });
}

els.maskUndoBtn.addEventListener('click', maskUndo);
els.maskClearBtn.addEventListener('click', maskClear);
els.maskAllBtn.addEventListener('click', maskAll);
els.maskSize.addEventListener('input', syncMaskUi);
els.maskFeather.addEventListener('input', () => {
  mask.feather = maskFeatherRatio();
  syncMaskUi();
});
// ぼかしはドラッグ中に何度も変わるので、確定したときだけ合成し直す
els.maskFeather.addEventListener('change', commitMaskChange);

els.maskCanvas.addEventListener('pointerdown', onMaskDown);
els.maskCanvas.addEventListener('pointermove', onMaskMove);
for (const type of ['pointerup', 'pointercancel']) {
  els.maskCanvas.addEventListener(type, onMaskUp);
}

// 画像の表示サイズが変わったら重ね描きし直す（回転・ウィンドウ幅の変更）
window.addEventListener('resize', () => { if (maskOn()) drawMaskOverlay(); });
els.sourceImg.addEventListener('load', () => { if (maskOn()) drawMaskOverlay(); });

els.runBtn.addEventListener('click', run);
els.cancelBtn.addEventListener('click', () => {
  cancelled = true;
  setStatus('キャンセルしています…');
});

syncAddLoraBtn();
syncProviderFields();
restoreForm();
fetchHistory().then(resumeJob);
