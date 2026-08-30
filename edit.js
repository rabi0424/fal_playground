'use strict';

/* ---------- constants ---------- */

// Poe の画像編集ボット。id はボットハンドルで、Worker の /api/poe/edit に
// そのまま渡す（呼び出しは Poe の OpenAI 互換 API・課金は Poe ポイント）
const BOTS = [
  { id: 'Nano-Banana-2', name: 'Nano Banana 2' },
  { id: 'Nano-Banana-Pro', name: 'Nano Banana Pro' },
  { id: 'GPT-Image-2', name: 'GPT Image 2', gpt: true },
  { id: '__custom__', name: 'カスタム…' },
];

// 名前欄の初期候補（アルファベット順）。datalist なので入力で絞り込まれ、
// 自由入力もできる。候補は固定で、過去の入力が増えていくことはない
const NAME_PRESETS = [
  'Asher Angel',
  'Chris Pratt',
  'Henry Cavill',
  'Jaehyun (NCT)',
  'Jay (ENHYPEN)',
  'Jeno (NCT)',
  'Robert Pattinson',
  'Taeyong (NCT)',
  'Tom Holland',
  'Vinnie Hacker',
  '新田真剣佑',
  '吉沢亮',
];

// 選択枠の比率プリセット。orient（縦/横）で w:h を入れ替えて使う
const RATIOS = {
  free: null,
  '1:1': { w: 1, h: 1 },
  '4:5': { w: 4, h: 5 },
  '3:4': { w: 3, h: 4 },
  '2:3': { w: 2, h: 3 },
  '9:16': { w: 9, h: 16 },
};

// ボットへ渡すアスペクト比の候補。切り抜きの縦横比に最も近いものを選ぶ
const NANO_RATIOS = [
  { label: '1:1', value: 1 }, { label: '4:5', value: 4 / 5 }, { label: '5:4', value: 5 / 4 },
  { label: '3:4', value: 3 / 4 }, { label: '4:3', value: 4 / 3 }, { label: '2:3', value: 2 / 3 },
  { label: '3:2', value: 3 / 2 }, { label: '9:16', value: 9 / 16 }, { label: '16:9', value: 16 / 9 },
];
const GPT_RATIOS = [
  { label: '1:1', value: 1 }, { label: '3:2', value: 3 / 2 }, { label: '2:3', value: 2 / 3 },
];

const LS_FORM = 'fal_edit_form';
const LS_JOB = 'fal_edit_job'; // 実行中ジョブ。タブを閉じても次回開いたときに再開する
const LS_STATE = 'fal_edit_state'; // 選択範囲・アップロード済み元画像 URL（再読み込みで復元）

// 元画像の data URI は localStorage の容量に収まらないことがあるので IndexedDB に置く
const IDB_NAME = 'fal_edit';
const IDB_STORE = 'state';
const IDB_IMAGE_KEY = 'image';

const POLL_INTERVAL_MS = 2000;
const SEND_MIN_PX = 512; // AI に送る切り抜きの最小長辺（小さすぎると編集品質が落ちる）
const MIN_SEL_PX = 20; // 表示座標での選択・リサイズの最小サイズ

const $ = (sel) => document.querySelector(sel);

const els = {
  uploadArea: $('#uploadArea'),
  fileInput: $('#fileInput'),
  workspace: $('#workspace'),
  pageError: $('#pageError'),
  guideHint: $('#guideHint'),
  ratioChips: $('#ratioChips'),
  orientToggle: $('#orientToggle'),
  canvasWrap: $('#canvasWrap'),
  mainCanvas: $('#mainCanvas'),
  selOv: $('#selOv'),
  selBox: $('#selBox'),
  dimBadge: $('#dimBadge'),
  editPrompt: $('#editPrompt'),
  promptPreview: $('#promptPreview'),
  extraPrompt: $('#extraPrompt'),
  nameInput: $('#nameInput'),
  namePresets: $('#namePresets'),
  botSelect: $('#botSelect'),
  customBotField: $('#customBotField'),
  customBot: $('#customBot'),
  qualityField: $('#qualityField'),
  qualitySelect: $('#qualitySelect'),
  blendSlider: $('#blendSlider'),
  blendVal: $('#blendVal'),
  colorSlider: $('#colorSlider'),
  colorVal: $('#colorVal'),
  btnChange: $('#btnChange'),
  btnReset: $('#btnReset'),
  btnExec: $('#btnExec'),
  editStatus: $('#editStatus'),
  editError: $('#editError'),
  resultPanel: $('#resultPanel'),
  resultImg: $('#resultImg'),
  btnDlResult: $('#btnDlResult'),
  cropImg: $('#cropImg'),
  aiImg: $('#aiImg'),
  overlayImg: $('#overlayImg'),
  dlCrop: $('#dlCrop'),
  dlAi: $('#dlAi'),
  dlOverlay: $('#dlOverlay'),
  gallery: $('#gallery'),
  lightbox: $('#lightbox'),
  lightboxClose: $('#lightboxClose'),
  lightboxCounter: $('#lightboxCounter'),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const ACCESS_EXPIRED_MSG = 'ログインセッションが切れています。ページを再読み込みしてサインインし直してください。';

function isHtmlResponse(res) {
  return (res.headers.get('Content-Type') || '').includes('text/html');
}

/* ---------- API helpers ---------- */

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (isHtmlResponse(res)) throw new Error(ACCESS_EXPIRED_MSG);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text.slice(0, 300) || `HTTP ${res.status}`);
  }
  return res.json();
}

// クライアント側で作った画像を R2 へ置き、/api/image/<id> の URL を得る。
// キーは中身の sha256 なので、同じ画像なら送らずに済む（image-upload.js）
const uploadImage = (dataUri, meta) => falUpload.put(dataUri, meta);

// 64 桁は内容アドレス（sha256）、32 桁はそうする前に置いた画像
function imageIdFromUrl(u) {
  const m = typeof u === 'string' ? u.match(/^\/api\/image\/([0-9a-f]{64}|[0-9a-f]{32})$/) : null;
  return m ? m[1] : null;
}

function makeJobId() {
  return crypto.randomUUID().replaceAll('-', '');
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('画像を読み込めませんでした'));
    im.src = src;
  });
}

/* ---------- IndexedDB（元画像の保存） ---------- */
// 保存に失敗しても機能自体は使えるよう、呼び出し側はすべて失敗を無視する

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/* ---------- state ---------- */

let img = null; // 元画像（自然サイズで合成に使う）
let imgDataUri = null; // 元画像の data URI（初回実行時のアップロード用）
let origUrl = null; // アップロード済み元画像の URL（画像を変えるまで再利用）
let displayScale = 1; // 表示幅 / 自然幅
let sel = { x: 0, y: 0, w: 0, h: 0 }; // 表示座標での選択範囲
let hasSel = false;
let running = false;
let curRatio = '1:1';
let orient = 'portrait';

/* ---------- ratio ---------- */

function effRatio() {
  const base = RATIOS[curRatio];
  if (!base) return null;
  if (base.w === base.h) return 1;
  return orient === 'portrait' ? base.w / base.h : base.h / base.w;
}

function ratioLabel() {
  const base = RATIOS[curRatio];
  if (!base) return 'フリー';
  if (base.w === base.h) return '1:1';
  return orient === 'portrait' ? `${base.w}:${base.h}` : `${base.h}:${base.w}`;
}

function ratioLocked() {
  return curRatio !== 'free';
}

function updateLockedClass() {
  // 比率固定中は辺の中央ハンドル（自由リサイズ用）を隠す
  els.selBox.classList.toggle('ratio-locked', ratioLocked());
}

function updateOrientVis() {
  const disabled = curRatio === 'free' || curRatio === '1:1';
  els.orientToggle.classList.toggle('disabled', disabled);
}

function updateChipLabels() {
  for (const chip of els.ratioChips.querySelectorAll('.ratio-chip')) {
    const key = chip.dataset.ratio;
    if (key === 'free' || key === '1:1') continue;
    const base = RATIOS[key];
    chip.textContent = orient === 'portrait' ? `${base.w}:${base.h}` : `${base.h}:${base.w}`;
  }
}

// 現在の選択を比率に合わせて中心を保ったまま整形する
function applyRatio() {
  const r = effRatio();
  if (!r || !img) return;
  const sz = wrapSize();
  const cx = sel.x + sel.w / 2;
  const cy = sel.y + sel.h / 2;
  let nw = sel.w;
  let nh = nw / r;
  if (nh > sz.h) { nh = sz.h; nw = nh * r; }
  if (nw > sz.w) { nw = sz.w; nh = nw / r; }
  sel.w = nw;
  sel.h = nh;
  sel.x = clamp(cx - nw / 2, 0, sz.w - nw);
  sel.y = clamp(cy - nh / 2, 0, sz.h - nh);
}

function nearestRatio(candidates, aspect) {
  let best = candidates[0];
  let bestDiff = Infinity;
  for (const c of candidates) {
    const d = Math.abs(Math.log(aspect) - Math.log(c.value));
    if (d < bestDiff) { bestDiff = d; best = c; }
  }
  return best.label;
}

/* ---------- image load ---------- */

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      img = await loadImageEl(e.target.result);
    } catch {
      setEditError('画像を読み込めませんでした');
      return;
    }
    imgDataUri = e.target.result;
    origUrl = null; // 新しい画像なので次の実行でアップロードし直す
    showWorkspace();
    saveWorkState();
    // 再読み込みで復元できるよう端末内（IndexedDB）にも保存する
    idbSet(IDB_IMAGE_KEY, { dataUri: imgDataUri }).catch(() => {});
  };
  reader.readAsDataURL(file);
}

function showWorkspace() {
  els.uploadArea.hidden = true;
  els.workspace.hidden = false;
  els.guideHint.hidden = false;
  drawImg();
  clearSel();
  updateOrientVis();
  updateLockedClass();
  hideResult();
  setEditError('');
}

function drawImg() {
  const ww = els.canvasWrap.clientWidth;
  if (ww <= 0 || !img) return;
  displayScale = ww / img.naturalWidth;
  els.mainCanvas.width = img.naturalWidth;
  els.mainCanvas.height = img.naturalHeight;
  const ctx = els.mainCanvas.getContext('2d');
  ctx.clearRect(0, 0, img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, 0, 0);
}

// 画面回転やタブ復帰でレイアウト幅が変わったら、選択範囲も同じ倍率で追随させる
function rescale() {
  if (!img) return;
  const ww = els.canvasWrap.clientWidth;
  if (ww <= 0) return;
  const old = displayScale;
  drawImg();
  if (hasSel && old > 0) {
    const r = displayScale / old;
    sel.x *= r; sel.y *= r; sel.w *= r; sel.h *= r;
    updateSelBox();
  }
}

window.addEventListener('resize', rescale);
document.addEventListener('visibilitychange', () => { if (!document.hidden) rescale(); });

/* ---------- selection ---------- */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function wrapSize() {
  return { w: els.canvasWrap.clientWidth, h: els.mainCanvas.getBoundingClientRect().height };
}

function pointerPos(e) {
  const r = els.canvasWrap.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  return { x: t.clientX - r.left, y: t.clientY - r.top };
}

let isDrawing = false;
let isMoving = false;
let isResizing = false;
let activeHandle = null;
let dragStart = { x: 0, y: 0 };
let interactStart = { x: 0, y: 0, sx: 0, sy: 0, sw: 0, sh: 0 };

function startDraw(e) {
  if (running) return;
  e.preventDefault();
  const p = pointerPos(e);
  isDrawing = true;
  dragStart = p;
  sel = { x: p.x, y: p.y, w: 0, h: 0 };
  hasSel = false;
  updateExecState();
  els.selBox.classList.remove('visible');
  els.guideHint.hidden = true;
  document.addEventListener('mousemove', onDraw);
  document.addEventListener('mouseup', endDraw);
  document.addEventListener('touchmove', onDraw, { passive: false });
  document.addEventListener('touchend', endDraw);
}

function onDraw(e) {
  if (!isDrawing) return;
  e.preventDefault();
  const p = pointerPos(e);
  const sz = wrapSize();
  const r = effRatio();
  const cx = clamp(p.x, 0, sz.w);
  const cy = clamp(p.y, 0, sz.h);
  if (r) {
    const rw = cx - dragStart.x;
    const rh = cy - dragStart.y;
    let aw = Math.abs(rw);
    let ah = Math.abs(rh);
    if (aw / r > ah) ah = aw / r; else aw = ah * r;
    const mw = rw >= 0 ? sz.w - dragStart.x : dragStart.x;
    const mh = rh >= 0 ? sz.h - dragStart.y : dragStart.y;
    if (aw > mw) { aw = mw; ah = aw / r; }
    if (ah > mh) { ah = mh; aw = ah * r; }
    sel.w = aw;
    sel.h = ah;
    sel.x = rw >= 0 ? dragStart.x : dragStart.x - aw;
    sel.y = rh >= 0 ? dragStart.y : dragStart.y - ah;
  } else {
    sel.x = Math.min(dragStart.x, cx);
    sel.y = Math.min(dragStart.y, cy);
    sel.w = Math.abs(cx - dragStart.x);
    sel.h = Math.abs(cy - dragStart.y);
  }
  els.selBox.classList.add('visible');
  updateSelBox();
}

function endDraw() {
  isDrawing = false;
  document.removeEventListener('mousemove', onDraw);
  document.removeEventListener('mouseup', endDraw);
  document.removeEventListener('touchmove', onDraw);
  document.removeEventListener('touchend', endDraw);
  if (sel.w > 5 && sel.h > 5) hasSel = true;
  else clearSel();
  updateExecState();
  saveWorkState();
}

function startInteract(e) {
  if (running) return;
  const t = e.target;
  if (t.classList.contains('rh')) startResize(e, t.dataset.handle);
  else if (t === els.selBox || t === els.dimBadge) startMove(e);
}

function startMove(e) {
  e.preventDefault();
  e.stopPropagation();
  isMoving = true;
  const p = pointerPos(e);
  interactStart = { x: p.x, y: p.y, sx: sel.x, sy: sel.y, sw: sel.w, sh: sel.h };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', endMove);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', endMove);
}

function onMove(e) {
  if (!isMoving) return;
  e.preventDefault();
  const p = pointerPos(e);
  const sz = wrapSize();
  sel.x = clamp(interactStart.sx + (p.x - interactStart.x), 0, sz.w - sel.w);
  sel.y = clamp(interactStart.sy + (p.y - interactStart.y), 0, sz.h - sel.h);
  updateSelBox();
}

function endMove() {
  isMoving = false;
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseup', endMove);
  document.removeEventListener('touchmove', onMove);
  document.removeEventListener('touchend', endMove);
  saveWorkState();
}

function startResize(e, handle) {
  e.preventDefault();
  e.stopPropagation();
  isResizing = true;
  activeHandle = handle;
  const p = pointerPos(e);
  dragStart = { x: p.x, y: p.y };
  interactStart = { x: p.x, y: p.y, sx: sel.x, sy: sel.y, sw: sel.w, sh: sel.h };
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', endResize);
  document.addEventListener('touchmove', onResize, { passive: false });
  document.addEventListener('touchend', endResize);
}

function onResize(e) {
  if (!isResizing) return;
  e.preventDefault();
  const p = pointerPos(e);
  const sz = wrapSize();
  const dx = p.x - dragStart.x;
  const dy = p.y - dragStart.y;
  const s = interactStart;
  const r = effRatio();
  if (r) {
    // 比率固定: ドラッグ中の角の対角を固定点（ax, ay）にして拡縮する
    let ax;
    let ay;
    if (activeHandle === 'tl') { ax = s.sx + s.sw; ay = s.sy + s.sh; }
    else if (activeHandle === 'tr') { ax = s.sx; ay = s.sy + s.sh; }
    else if (activeHandle === 'bl') { ax = s.sx + s.sw; ay = s.sy; }
    else { ax = s.sx; ay = s.sy; }
    const tx = clamp(p.x, 0, sz.w);
    const ty = clamp(p.y, 0, sz.h);
    const adx = Math.abs(tx - ax);
    const ady = Math.abs(ty - ay);
    let nw;
    let nh;
    if (adx / r > ady) { nw = adx; nh = nw / r; } else { nh = ady; nw = nh * r; }
    nw = Math.max(nw, MIN_SEL_PX);
    nh = nw / r;
    const maxW = (activeHandle === 'tl' || activeHandle === 'bl') ? ax : sz.w - ax;
    const maxH = (activeHandle === 'tl' || activeHandle === 'tr') ? ay : sz.h - ay;
    if (nw > maxW) { nw = maxW; nh = nw / r; }
    if (nh > maxH) { nh = maxH; nw = nh * r; }
    if (activeHandle === 'tl') { sel.x = ax - nw; sel.y = ay - nh; }
    else if (activeHandle === 'tr') { sel.x = ax; sel.y = ay - nh; }
    else if (activeHandle === 'bl') { sel.x = ax - nw; sel.y = ay; }
    else { sel.x = ax; sel.y = ay; }
    sel.w = nw;
    sel.h = nh;
  } else {
    let nx = s.sx;
    let ny = s.sy;
    let nw = s.sw;
    let nh = s.sh;
    if (activeHandle.includes('l')) { nx = clamp(s.sx + dx, 0, s.sx + s.sw - MIN_SEL_PX); nw = s.sw - (nx - s.sx); }
    if (activeHandle.includes('r')) nw = clamp(s.sw + dx, MIN_SEL_PX, sz.w - s.sx);
    if (activeHandle.includes('t')) { ny = clamp(s.sy + dy, 0, s.sy + s.sh - MIN_SEL_PX); nh = s.sh - (ny - s.sy); }
    if (activeHandle.includes('b')) nh = clamp(s.sh + dy, MIN_SEL_PX, sz.h - s.sy);
    if (activeHandle === 'tm' || activeHandle === 'bm') { nx = s.sx; nw = s.sw; }
    if (activeHandle === 'ml' || activeHandle === 'mr') { ny = s.sy; nh = s.sh; }
    sel.x = nx; sel.y = ny; sel.w = nw; sel.h = nh;
  }
  updateSelBox();
}

function endResize() {
  isResizing = false;
  activeHandle = null;
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', endResize);
  document.removeEventListener('touchmove', onResize);
  document.removeEventListener('touchend', endResize);
  saveWorkState();
}

function updateSelBox() {
  els.selBox.style.left = `${sel.x}px`;
  els.selBox.style.top = `${sel.y}px`;
  els.selBox.style.width = `${sel.w}px`;
  els.selBox.style.height = `${sel.h}px`;
  const rw = Math.round(sel.w / displayScale);
  const rh = Math.round(sel.h / displayScale);
  let label = `${rw} × ${rh} px`;
  if (ratioLocked()) label = `${ratioLabel()} • ${label}`;
  els.dimBadge.textContent = label;
}

function clearSel() {
  hasSel = false;
  sel = { x: 0, y: 0, w: 0, h: 0 };
  els.selBox.classList.remove('visible');
  updateExecState();
}

// 表示座標の選択範囲を元画像のピクセル座標に変換する
function selToRect() {
  const x = clamp(Math.round(sel.x / displayScale), 0, img.naturalWidth - 1);
  const y = clamp(Math.round(sel.y / displayScale), 0, img.naturalHeight - 1);
  const w = clamp(Math.round(sel.w / displayScale), 1, img.naturalWidth - x);
  const h = clamp(Math.round(sel.h / displayScale), 1, img.naturalHeight - y);
  return { x, y, w, h };
}

// 選択範囲とアップロード済み元画像 URL を保存する（再読み込みでの復元用）。
// 元画像そのものは IndexedDB（loadFile 時に保存）にある
function saveWorkState() {
  // 容量超過などは無視（復元できなくなるだけ）
  falStore.set(LS_STATE, JSON.stringify({
    rect: img && hasSel ? selToRect() : null,
    origUrl,
  }));
}

// 再読み込み時: 元画像座標の rect から表示座標の選択範囲を復元する
function restoreSelection(rect) {
  sel = {
    x: rect.x * displayScale,
    y: rect.y * displayScale,
    w: rect.w * displayScale,
    h: rect.h * displayScale,
  };
  hasSel = true;
  els.guideHint.hidden = true;
  els.selBox.classList.add('visible');
  updateSelBox();
}

/* ---------- composite（クライアント側の合成処理） ---------- */

// Lanczos3 カーネル。AI の返す画像は切り抜きより大きいことが多く、
// canvas 標準の縮小より輪郭が保たれるので縮小時のみ使う
function lanczos3(x) {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= 3) return 0;
  const px = Math.PI * ax;
  return (Math.sin(px) / px) * (Math.sin(px / 3) / (px / 3));
}

function lanczosResize(srcCanvas, dstW, dstH) {
  const srcW = srcCanvas.width;
  const srcH = srcCanvas.height;
  const srcData = srcCanvas.getContext('2d').getImageData(0, 0, srcW, srcH).data;
  const a = 3;

  // 横方向パス: srcW×srcH → dstW×srcH
  const tmp = new Float64Array(dstW * srcH * 4);
  const xScale = dstW / srcW;
  const xSupport = xScale < 1 ? a / xScale : a;
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < dstW; x++) {
      const center = (x + 0.5) / xScale - 0.5;
      const lo = Math.ceil(center - xSupport);
      const hi = Math.floor(center + xSupport);
      let cr = 0; let cg = 0; let cb = 0; let ca = 0; let ws = 0;
      for (let i = lo; i <= hi; i++) {
        const si = Math.min(Math.max(i, 0), srcW - 1);
        const w = lanczos3(xScale < 1 ? (center - i) * xScale : (center - i));
        const idx = (y * srcW + si) * 4;
        cr += srcData[idx] * w;
        cg += srcData[idx + 1] * w;
        cb += srcData[idx + 2] * w;
        ca += srcData[idx + 3] * w;
        ws += w;
      }
      const ti = (y * dstW + x) * 4;
      if (ws > 0) {
        tmp[ti] = cr / ws; tmp[ti + 1] = cg / ws; tmp[ti + 2] = cb / ws; tmp[ti + 3] = ca / ws;
      }
    }
  }

  // 縦方向パス: dstW×srcH → dstW×dstH
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const yScale = dstH / srcH;
  const ySupport = yScale < 1 ? a / yScale : a;
  for (let x = 0; x < dstW; x++) {
    for (let y = 0; y < dstH; y++) {
      const center = (y + 0.5) / yScale - 0.5;
      const lo = Math.ceil(center - ySupport);
      const hi = Math.floor(center + ySupport);
      let cr = 0; let cg = 0; let cb = 0; let ca = 0; let ws = 0;
      for (let j = lo; j <= hi; j++) {
        const sj = Math.min(Math.max(j, 0), srcH - 1);
        const w = lanczos3(yScale < 1 ? (center - j) * yScale : (center - j));
        const idx = (sj * dstW + x) * 4;
        cr += tmp[idx] * w;
        cg += tmp[idx + 1] * w;
        cb += tmp[idx + 2] * w;
        ca += tmp[idx + 3] * w;
        ws += w;
      }
      const di = (y * dstW + x) * 4;
      if (ws > 0) {
        dst[di] = Math.max(0, Math.min(255, Math.round(cr / ws)));
        dst[di + 1] = Math.max(0, Math.min(255, Math.round(cg / ws)));
        dst[di + 2] = Math.max(0, Math.min(255, Math.round(cb / ws)));
        dst[di + 3] = Math.max(0, Math.min(255, Math.round(ca / ws)));
      }
    }
  }

  const out = document.createElement('canvas');
  out.width = dstW;
  out.height = dstH;
  const ctx = out.getContext('2d');
  const imgData = ctx.createImageData(dstW, dstH);
  imgData.data.set(dst);
  ctx.putImageData(imgData, 0, 0);
  return out;
}

// 外周 borderPx の帯の平均色（カラーマッチの基準）
function sampleBorderAvg(imageData, w, h, borderPx) {
  const d = imageData.data;
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < borderPx || x >= w - borderPx || y < borderPx || y >= h - borderPx) {
        const idx = (y * w + x) * 4;
        r += d[idx]; g += d[idx + 1]; b += d[idx + 2]; n++;
      }
    }
  }
  return n > 0 ? { r: r / n, g: g / n, b: b / n } : null;
}

// 元画像から rect を等倍で切り出す（オーバーレイ・表示用）
function drawCrop(rect) {
  const c = document.createElement('canvas');
  c.width = rect.w;
  c.height = rect.h;
  c.getContext('2d').drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return c;
}

// AI 編集結果を rect のサイズに合わせ、カラーマッチ → フェザーブレンドして
// 元画像へはめ込む。戻り値は元画像サイズの canvas
function compositeLocal(origImg, aiImgEl, rect, blendPct, colorPct) {
  const { x: cropX, y: cropY, w: cropW, h: cropH } = rect;
  const tmp = document.createElement('canvas');
  tmp.width = cropW;
  tmp.height = cropH;
  const tc = tmp.getContext('2d');
  const aiW = aiImgEl.naturalWidth || aiImgEl.width;
  const aiH = aiImgEl.naturalHeight || aiImgEl.height;
  if (aiW > cropW || aiH > cropH) {
    // 縮小は Lanczos3 でシャープに
    const aiSrc = document.createElement('canvas');
    aiSrc.width = aiW;
    aiSrc.height = aiH;
    aiSrc.getContext('2d').drawImage(aiImgEl, 0, 0);
    tc.drawImage(lanczosResize(aiSrc, cropW, cropH), 0, 0);
  } else {
    tc.drawImage(aiImgEl, 0, 0, cropW, cropH);
  }

  // カラーマッチ: 外周の平均色の差分だけ AI 画像全体をシフトする
  if (colorPct > 0) {
    const borderPx = Math.max(1, Math.round(Math.min(cropW, cropH) * colorPct / 100));
    const origC = drawCrop(rect);
    const origId = origC.getContext('2d').getImageData(0, 0, cropW, cropH);
    const aiId = tc.getImageData(0, 0, cropW, cropH);
    const oAvg = sampleBorderAvg(origId, cropW, cropH, borderPx);
    const aAvg = sampleBorderAvg(aiId, cropW, cropH, borderPx);
    if (oAvg && aAvg) {
      const dr = oAvg.r - aAvg.r;
      const dg = oAvg.g - aAvg.g;
      const db = oAvg.b - aAvg.b;
      const d = aiId.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = Math.max(0, Math.min(255, d[i] + dr));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + dg));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + db));
      }
      tc.putImageData(aiId, 0, 0);
    }
  }

  // フェザーブレンド: 外周をアルファで馴染ませる。元画像の端から 10px 以内の辺は
  // 画像の縁なのでスキップする
  if (blendPct > 0) {
    const featherPx = Math.max(1, Math.round(Math.min(cropW, cropH) * blendPct / 100));
    const skipL = cropX < 10;
    const skipR = (origImg.naturalWidth - (cropX + cropW)) < 10;
    const skipT = cropY < 10;
    const skipB = (origImg.naturalHeight - (cropY + cropH)) < 10;
    const fId = tc.getImageData(0, 0, cropW, cropH);
    const fd = fId.data;
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        let dMin = Infinity;
        if (!skipL) dMin = Math.min(dMin, x);
        if (!skipR) dMin = Math.min(dMin, cropW - 1 - x);
        if (!skipT) dMin = Math.min(dMin, y);
        if (!skipB) dMin = Math.min(dMin, cropH - 1 - y);
        if (dMin < featherPx) {
          const fi = (y * cropW + x) * 4;
          fd[fi + 3] = Math.round(fd[fi + 3] * (dMin / featherPx));
        }
      }
    }
    tc.putImageData(fId, 0, 0);
  }

  const out = document.createElement('canvas');
  out.width = origImg.naturalWidth;
  out.height = origImg.naturalHeight;
  const ctx = out.getContext('2d');
  ctx.drawImage(origImg, 0, 0);
  ctx.drawImage(tmp, cropX, cropY);
  return out;
}

// 位置確認用: 切り抜きの上に AI 編集結果を半透明で重ねる
function createOverlay(cropCanvas, aiImgEl) {
  const c = document.createElement('canvas');
  c.width = cropCanvas.width;
  c.height = cropCanvas.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(cropCanvas, 0, 0);
  ctx.globalAlpha = 0.5;
  ctx.drawImage(aiImgEl, 0, 0, c.width, c.height);
  ctx.globalAlpha = 1;
  return c;
}

/* ---------- pipeline ---------- */

// プロンプト中の {NAME}（カッコ含む）を名前欄の入力で置換する。
// 名前が未入力のときは置換せずそのまま送る
function applyNameToPrompt(prompt) {
  const name = els.nameInput.value.trim();
  return name ? prompt.replaceAll('{NAME}', name) : prompt;
}

// 実際に送るプロンプト。{NAME} を置換した編集プロンプトの末尾に、
// 追加プロンプト欄に入力があれば改行でつないで足す（そのつどの書き足し用）
function buildPrompt() {
  const base = applyNameToPrompt(els.editPrompt.value.trim());
  const extra = applyNameToPrompt(els.extraPrompt.value.trim());
  return extra ? `${base}\n${extra}` : base;
}

function currentBot() {
  return BOTS.find((b) => b.id === els.botSelect.value) || BOTS[0];
}

function currentModel() {
  const bot = currentBot();
  return bot.id === '__custom__' ? els.customBot.value.trim() : bot.id;
}

// ボット固有パラメータ。カスタムボットは受け付ける項目が不明なので送らない
function botParameters(bot, rect) {
  if (bot.id === '__custom__') return {};
  if (bot.gpt) {
    return { aspect: nearestRatio(GPT_RATIOS, rect.w / rect.h), quality: els.qualitySelect.value };
  }
  return { aspect_ratio: nearestRatio(NANO_RATIOS, rect.w / rect.h) };
}

// AI に送る切り抜き画像。長辺が SEND_MIN_PX 未満なら比率を保って拡大する
function buildSendImage(rect) {
  const crop = drawCrop(rect);
  const longest = Math.max(rect.w, rect.h);
  if (longest >= SEND_MIN_PX) return crop.toDataURL('image/png');
  const scale = SEND_MIN_PX / longest;
  const up = document.createElement('canvas');
  up.width = Math.round(rect.w * scale);
  up.height = Math.round(rect.h * scale);
  const ctx = up.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop, 0, 0, up.width, up.height);
  return up.toDataURL('image/png');
}

function setStatus(text) {
  els.editStatus.hidden = !text;
  els.editStatus.textContent = text || '';
}

// ワークスペースが出ていないとき（再開失敗など）はページ上部のエラー欄に出す
function setEditError(text) {
  const target = els.workspace.hidden ? els.pageError : els.editError;
  const other = els.workspace.hidden ? els.editError : els.pageError;
  target.hidden = !text;
  target.textContent = text || '';
  other.hidden = true;
}

function updateExecState() {
  const model = currentModel();
  els.btnExec.disabled = running
    || !hasSel
    || els.editPrompt.value.trim() === ''
    || !/^[\w.-]{1,64}$/.test(model);
  els.btnExec.textContent = running ? '実行中…' : '実行する';
}

async function execute() {
  if (running || !img || !hasSel) return;
  const bot = currentBot();
  const model = currentModel();
  const prompt = buildPrompt();
  if (!prompt || !/^[\w.-]{1,64}$/.test(model)) return;

  // {NAME} タグがあるのに名前欄が空のときだけ、置換されないまま送ってよいか確認する
  if (prompt.includes('{NAME}') && els.nameInput.value.trim() === '') {
    const ok = confirm('プロンプトに {NAME} が含まれていますが、名前欄が空です。\n置換せずにこのまま送信しますか？');
    if (!ok) return;
  }

  setEditError('');
  hideResult();
  running = true;
  updateExecState();

  try {
    const rect = selToRect();

    // 元画像は画像を変えるまで一度だけアップロードする（再開・履歴からの参照用）
    if (!origUrl) {
      setStatus('元画像をアップロード中…');
      origUrl = await uploadImage(imgDataUri, null);
      saveWorkState(); // 再読み込み後の実行で再アップロードしないよう覚えておく
    }
    setStatus('切り抜きをアップロード中…');
    const cropUrl = await uploadImage(buildSendImage(rect), null);

    const job = {
      jobId: makeJobId(),
      origUrl,
      cropUrl,
      rect,
      model,
      prompt,
      parameters: botParameters(bot, rect),
      blend: Number(els.blendSlider.value),
      color: Number(els.colorSlider.value),
      startedAt: Date.now(),
    };
    await postJson('/api/poe/edit', {
      jobId: job.jobId,
      model,
      prompt,
      imageId: imageIdFromUrl(cropUrl),
      parameters: job.parameters,
    });
    // ここまで来ればサーバー側で完結するので、タブを閉じても次回再開できる
    // （控えを書けなくても、このタブでは最後まで受け取れる）
    falStore.set(LS_JOB, JSON.stringify(job));

    await awaitAndComposite(job);
  } catch (err) {
    setStatus('');
    setEditError(err.message || 'エラーが発生しました');
  } finally {
    running = false;
    updateExecState();
  }
}

// ジョブ完了をポーリングで待ち、はめ込み合成 → アップロード → 履歴保存まで行う
async function awaitAndComposite(job) {
  let result;
  for (;;) {
    const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(0);
    setStatus(`AI 編集中（${job.model}）… ${elapsed}s`);
    const res = await fetch(`/api/poe/job/${job.jobId}`);
    if (isHtmlResponse(res)) throw new Error(ACCESS_EXPIRED_MSG);
    if (res.status === 404) {
      falStore.remove(LS_JOB);
      throw new Error('ジョブが見つかりませんでした（保持期限が切れた可能性があります）');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    result = await res.json();
    if (result.status === 'done') break;
    if (result.status === 'error') {
      falStore.remove(LS_JOB);
      throw new Error(result.error || 'AI 編集に失敗しました');
    }
    await sleep(POLL_INTERVAL_MS);
  }

  setStatus('はめ込み合成中…');
  const aiImgEl = await loadImageEl(result.url);
  const cropCanvas = drawCrop(job.rect);
  const compCanvas = compositeLocal(img, aiImgEl, job.rect, job.blend, job.color);
  const overlayCanvas = createOverlay(cropCanvas, aiImgEl);

  setStatus('保存中…');
  const compUri = compCanvas.toDataURL('image/png');
  const compUrl = await uploadImage(compUri, {
    app: 'fal playground',
    source: 'poe-edit',
    model: job.model,
    prompt: job.prompt,
    rect: job.rect,
    blend: job.blend,
    colorMatch: job.color,
    parameters: job.parameters,
    created: new Date(job.startedAt).toISOString(),
  });

  // 生成履歴に保存する（トップのギャラリーに表示される）。
  // 画像は [合成結果, AI編集後, 切り抜き, 元画像] の順で、削除時に一括で消える
  const record = {
    id: job.jobId,
    ts: Date.now(),
    type: 'edit',
    model: `poe/${job.model}`,
    prompt: job.prompt,
    input: { rect: job.rect, blend: job.blend, colorMatch: job.color, parameters: job.parameters },
    seed: null,
    elapsed: ((Date.now() - job.startedAt) / 1000).toFixed(1),
    images: [{ url: compUrl }, { url: result.url }, { url: job.cropUrl }, { url: job.origUrl }],
  };
  try {
    await postJson('/api/history', record);
  } catch {
    // 履歴保存の失敗は結果表示を妨げない（画像自体は R2 に保存済み）
  }
  // 下部の履歴ギャラリーにも即時反映する
  historyItems = [record, ...historyItems.filter((r) => r.id !== record.id)];
  renderGallery();

  falStore.remove(LS_JOB);
  setStatus('');
  showResult({
    compUri,
    aiUrl: result.url,
    cropUri: cropCanvas.toDataURL('image/png'),
    overlayUri: overlayCanvas.toDataURL('image/png'),
  });
}

/* ---------- history gallery（トップと同じサーバー履歴を表示） ---------- */

let historyItems = [];

// R2 反映直後などで読めないことがあるので軽くリトライする（app.js と同じ）
function loadThumb(imgEl, url, maxRetries = 5) {
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

function galleryThumbUrl(record) {
  if (record.type === 'compare') {
    return record.variants?.find((v) => v.images?.length)?.images[0]?.url ?? '';
  }
  return record.images?.[0]?.url ?? '';
}

// 拡大表示に使う URL 一覧（←/→・スワイプで切替できる）
function galleryImageUrls(record) {
  if (record.type === 'compare') {
    return (record.variants ?? []).flatMap((v) => (v.images ?? []).map((i) => i.url));
  }
  return (record.images ?? []).map((i) => i.url);
}

// 履歴に件数の上限は無いので、サーバーはページごとに返す。
// 取れたぶんから順に描いて、続きは裏で追う
async function fetchHistory() {
  const items = [];
  const got = await falHistory.fetchAll((page) => {
    items.push(...page);
    if (page.length === 0) return; // 取れなかった / 空のときは表示中のまま
    historyItems = items;
    renderGallery();
  });
  if (!got.ok) return; // オフラインなどは、取れたぶんを出したままにする
  historyItems = items; // 全消しの直後など、空になったことも反映する
  renderGallery();
}

function renderGallery() {
  if (historyItems.length === 0) {
    galleryPager.clear();
    const empty = document.createElement('div');
    empty.className = 'gallery-empty';
    empty.textContent = 'まだ履歴はありません';
    els.gallery.appendChild(empty);
    return;
  }

  galleryPager.render(historyItems);
}

// 履歴 1 件ぶんのカード
function galleryItemEl(record) {
  const item = document.createElement('div');
  item.className = 'gallery-item';

  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.alt = record.prompt ?? '';
  thumb.loading = 'lazy';
  loadThumb(thumb, galleryThumbUrl(record));
  thumb.addEventListener('click', () => openLightbox(galleryImageUrls(record)));
  item.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'body';

  const promptText = document.createElement('div');
  promptText.className = 'prompt-text';
  promptText.textContent = record.prompt ?? '';
  promptText.title = record.prompt ?? '';
  body.appendChild(promptText);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = (record.model ?? '').replace(/^fal-ai\//, '');
  body.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'ghost-btn small';
  deleteBtn.textContent = '削除';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    historyItems = historyItems.filter((r) => r.id !== record.id);
    fetch(`/api/history/${encodeURIComponent(record.id)}`, { method: 'DELETE' }).catch(() => {});
    renderGallery();
  });
  actions.appendChild(deleteBtn);
  body.appendChild(actions);

  item.appendChild(body);
  return item;
}

const galleryPager = falGallery.create(els.gallery, galleryItemEl);

/* ---------- lightbox（app.js の簡略版） ---------- */

let lightboxUrls = [];
let lightboxIndex = 0;

function openLightbox(urls, index = 0) {
  lightboxUrls = Array.isArray(urls) ? urls : [urls];
  if (lightboxUrls.length === 0) return;
  lightboxIndex = index;
  showLightboxImage();
  els.lightbox.hidden = false;
}

function showLightboxImage() {
  els.lightbox.querySelector('img').src = lightboxUrls[lightboxIndex] ?? '';
  els.lightboxCounter.hidden = lightboxUrls.length < 2;
  els.lightboxCounter.textContent = `${lightboxIndex + 1} / ${lightboxUrls.length}`;
}

function lightboxNav(dir) {
  if (lightboxUrls.length < 2) return;
  lightboxIndex = (lightboxIndex + dir + lightboxUrls.length) % lightboxUrls.length;
  showLightboxImage();
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lightbox.querySelector('img').src = '';
}

let lightboxTouchX = 0;
let lightboxTouchY = 0;
let lightboxSwiped = false;

function initLightbox() {
  els.lightbox.addEventListener('click', () => {
    if (lightboxSwiped) { lightboxSwiped = false; return; }
    closeLightbox();
  });
  els.lightboxClose.addEventListener('click', closeLightbox);

  // 横スワイプで前後の画像へ（縦方向の動きが主ならスクロールとみなして無視）
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
    if (els.lightbox.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowRight') { e.preventDefault(); lightboxNav(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); lightboxNav(-1); }
  });
}

/* ---------- results ---------- */

function showResult(r) {
  els.resultImg.src = r.compUri;
  els.btnDlResult.href = r.compUri;
  els.cropImg.src = r.cropUri;
  els.dlCrop.href = r.cropUri;
  els.aiImg.src = r.aiUrl;
  els.dlAi.href = r.aiUrl;
  els.overlayImg.src = r.overlayUri;
  els.dlOverlay.href = r.overlayUri;
  els.resultPanel.hidden = false;
  els.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideResult() {
  els.resultPanel.hidden = true;
}

/* ---------- resume ---------- */

// 前回のタブで実行中だったジョブがあれば、元画像をサーバーから読み戻して
// ポーリングと合成を再開する（Poe の呼び出しはサーバー側で完結している）
async function resumeJob() {
  let job = null;
  try {
    job = JSON.parse(falStore.get(LS_JOB));
  } catch { /* 壊れたデータは下で破棄する */ }
  if (!job?.jobId || !job.origUrl || !job.rect) {
    falStore.remove(LS_JOB);
    return;
  }

  running = true;
  try {
    try {
      img = await loadImageEl(job.origUrl);
    } catch {
      // 元画像を読み戻せない（削除済みなど）場合は再開をあきらめる。
      // 残したままだと開くたびに失敗し続けるのでジョブは破棄する
      falStore.remove(LS_JOB);
      setEditError('前回のジョブの元画像を読み戻せなかったため、再開を中止しました');
      return;
    }
    imgDataUri = null;
    origUrl = job.origUrl;
    showWorkspace();
    restoreSelection(job.rect);
    updateExecState();
    await awaitAndComposite(job);
  } catch (err) {
    setStatus('');
    setEditError(`前回のジョブの再開に失敗しました: ${err.message}`);
  } finally {
    running = false;
    updateExecState();
  }
}

/* ---------- form persistence（端末ごとの下書き） ---------- */

function saveForm() {
  falStore.set(LS_FORM, JSON.stringify({
    prompt: els.editPrompt.value,
    extraPrompt: els.extraPrompt.value,
    name: els.nameInput.value,
    bot: els.botSelect.value,
    customBot: els.customBot.value,
    quality: els.qualitySelect.value,
    blend: els.blendSlider.value,
    color: els.colorSlider.value,
    ratio: curRatio,
    orient,
  }));
}

function restoreForm() {
  let saved = null;
  try {
    saved = JSON.parse(falStore.get(LS_FORM));
  } catch { /* 壊れていたら既定値のまま */ }
  if (!saved) return;
  if (typeof saved.prompt === 'string') els.editPrompt.value = saved.prompt;
  if (typeof saved.extraPrompt === 'string') els.extraPrompt.value = saved.extraPrompt;
  if (typeof saved.name === 'string') els.nameInput.value = saved.name;
  if (BOTS.some((b) => b.id === saved.bot)) els.botSelect.value = saved.bot;
  if (typeof saved.customBot === 'string') els.customBot.value = saved.customBot;
  if (['low', 'medium', 'high'].includes(saved.quality)) els.qualitySelect.value = saved.quality;
  if (saved.blend != null) els.blendSlider.value = saved.blend;
  if (saved.color != null) els.colorSlider.value = saved.color;
  if (Object.hasOwn(RATIOS, saved.ratio ?? '')) curRatio = saved.ratio;
  if (saved.orient === 'landscape' || saved.orient === 'portrait') orient = saved.orient;
  for (const c of els.ratioChips.querySelectorAll('.ratio-chip')) {
    c.classList.toggle('active', c.dataset.ratio === curRatio);
  }
  for (const b of els.orientToggle.querySelectorAll('.orient-btn')) {
    b.classList.toggle('active', b.dataset.orient === orient);
  }
  updateChipLabels();
  updateLockedClass();
}

// 折りたたみサマリーに現在のプロンプトの先頭を表示する
function updatePromptPreview() {
  const t = els.editPrompt.value.trim();
  els.promptPreview.textContent = t ? (t.length > 42 ? `${t.slice(0, 42)}…` : t) : '（未入力）';
}

/* ---------- restore（再読み込み時の復元） ---------- */

// 実行中ジョブがあればその再開を優先し（元画像はサーバーから読み戻す）、
// なければ端末内に保存した元画像と選択範囲を復元する
async function restoreWorkspace() {
  if (falStore.get(LS_JOB)) {
    await resumeJob();
    return;
  }

  let state = null;
  try {
    state = JSON.parse(falStore.get(LS_STATE));
  } catch { /* 壊れていたら無視 */ }

  let saved = null;
  try {
    saved = await idbGet(IDB_IMAGE_KEY);
  } catch { /* IndexedDB が使えない環境では復元しない */ }
  if (typeof saved?.dataUri !== 'string') return;

  let restored;
  try {
    restored = await loadImageEl(saved.dataUri);
  } catch {
    return; // 壊れた保存データ。次の画像読み込みで上書きされる
  }
  if (img) return; // 復元を待つ間にユーザーが別の画像を読み込んだ
  img = restored;
  imgDataUri = saved.dataUri;
  origUrl = state?.origUrl ?? null;
  showWorkspace();
  if (state?.rect) {
    restoreSelection(state.rect);
    updateExecState();
  }
}

/* ---------- init ---------- */

function updateBotFields() {
  const bot = currentBot();
  els.qualityField.hidden = !bot.gpt;
  els.customBotField.hidden = bot.id !== '__custom__';
}

function initForm() {
  for (const b of BOTS) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name;
    els.botSelect.appendChild(opt);
  }
  for (const n of NAME_PRESETS) {
    const opt = document.createElement('option');
    opt.value = n;
    els.namePresets.appendChild(opt);
  }
  restoreForm();
  updateBotFields();
  updatePromptPreview();
  els.blendVal.textContent = els.blendSlider.value;
  els.colorVal.textContent = els.colorSlider.value;

  els.botSelect.addEventListener('change', () => { updateBotFields(); updateExecState(); saveForm(); });
  els.customBot.addEventListener('input', () => { updateExecState(); saveForm(); });
  els.qualitySelect.addEventListener('change', saveForm);
  els.editPrompt.addEventListener('input', () => { updateExecState(); updatePromptPreview(); saveForm(); });
  els.extraPrompt.addEventListener('input', saveForm);
  els.nameInput.addEventListener('input', saveForm);
  els.blendSlider.addEventListener('input', () => { els.blendVal.textContent = els.blendSlider.value; saveForm(); });
  els.colorSlider.addEventListener('input', () => { els.colorVal.textContent = els.colorSlider.value; saveForm(); });
}

function initUpload() {
  els.uploadArea.addEventListener('click', () => els.fileInput.click());
  els.uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.uploadArea.classList.add('dragover');
  });
  els.uploadArea.addEventListener('dragleave', () => els.uploadArea.classList.remove('dragover'));
  els.uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    els.uploadArea.classList.remove('dragover');
    loadFile(e.dataTransfer.files?.[0]);
  });
  els.fileInput.addEventListener('change', () => loadFile(els.fileInput.files?.[0]));
  els.btnChange.addEventListener('click', () => {
    if (running) return;
    els.fileInput.value = '';
    els.fileInput.click();
  });
}

function initSelection() {
  els.selOv.addEventListener('mousedown', startDraw);
  els.selOv.addEventListener('touchstart', startDraw, { passive: false });
  els.selBox.addEventListener('mousedown', startInteract);
  els.selBox.addEventListener('touchstart', startInteract, { passive: false });

  els.ratioChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.ratio-chip');
    if (!chip) return;
    for (const c of els.ratioChips.querySelectorAll('.ratio-chip')) c.classList.remove('active');
    chip.classList.add('active');
    curRatio = chip.dataset.ratio;
    updateLockedClass();
    updateOrientVis();
    if (hasSel && ratioLocked()) { applyRatio(); updateSelBox(); }
    saveWorkState();
    saveForm();
  });

  els.orientToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.orient-btn');
    if (!btn || btn.dataset.orient === orient) return;
    orient = btn.dataset.orient;
    for (const b of els.orientToggle.querySelectorAll('.orient-btn')) b.classList.remove('active');
    btn.classList.add('active');
    updateChipLabels();
    if (hasSel && ratioLocked()) { applyRatio(); updateSelBox(); }
    saveWorkState();
    saveForm();
  });

  els.btnReset.addEventListener('click', () => {
    if (running) return;
    clearSel();
    els.guideHint.hidden = false;
    saveWorkState();
  });
}

initForm();
initUpload();
initSelection();
initLightbox();
els.btnExec.addEventListener('click', execute);
updateOrientVis();
updateExecState();
restoreWorkspace();
if (falBoot.requireShared(['falHistory', 'falUpload'])) fetchHistory();
// タブに戻ってきたら他画面・他端末での変更を取り込む
document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchHistory(); });
