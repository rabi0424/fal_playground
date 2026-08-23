'use strict';

/* ==========================================================================
 * 画像編集（Qwen Image Edit 2511 + LoRA / FLUX.1 Fill [dev] OneReward）
 *
 * 入力画像 1 枚 + 指示文で画像を編集する別画面。既存の「部分AI編集」
 * （Poe・範囲を切り抜いてはめ込む）とは別枠で、画像全体をモデルに渡す。
 *
 * - プロバイダは 3 つ。Qwen Image Edit 2511 を fal / WaveSpeed から、
 *   FLUX.1 Fill [dev] OneReward（塗った範囲を描き直す修復モデル）を Runware から
 *   選べる。API の形がそれぞれ違うので PROVIDERS のアダプタで吸収する
 *   （送信内容の組み立て・投入・ポーリング・結果の解釈・費用の目安）
 * - いずれも Worker のプロキシ経由（/api/fal/proxy・/api/wavespeed/proxy・
 *   /api/runware/proxy）で呼ぶ。API キーはブラウザに渡さない
 * - 入力画像（とマスク）は data URI として渡す。このアプリは Cloudflare Access の
 *   内側に置く前提で、/api/image/... をプロバイダ側から取りに行けるとは限らないため
 * - 同じ画像は R2 にも保存し（/api/upload）、履歴レコードと再開用に使う。
 *   data URI は localStorage に置くには大きすぎるので保存しない
 * - 結果は type: 'imgedit' の履歴レコードとして /api/history に保存するので、
 *   生成画面のギャラリーにもそのまま並ぶ
 * ========================================================================== */

/* ---------- constants ---------- */

const MAX_LORAS = 3; // どちらのプロバイダも最大 3 個
const MAX_INPUT_PX = 2048; // リサイズしない設定のときの上限（長辺）
const INPUT_QUALITY = 0.92; // 送信用 JPEG の品質
// 合成の土台に使う元画像の上限。元解像度を保つのが目的なので大きめだが、
// iOS Safari の canvas 面積上限（約 1670 万画素）に収まる範囲にする
const MAX_ORIGINAL_PX = 4096;
const MAX_ORIGINAL_AREA = 16 * 1024 * 1024;
const ORIGINAL_QUALITY = 0.95;

const HF_DEFAULT_REPO = 'tottie2215/temp_str'; // 取り込み先の既定（app.js と同じ）
const LS_JOB = 'fal_imgedit_job';
const LS_FORM = 'fal_imgedit_form';
// 下書きに入っている Runware の既定値の版。上げると、古い下書きの値を
// 一度だけ推奨値へ入れ替える（空欄＝モデル既定任せのままだと質が出ない）
const RW_DEFAULTS_VERSION = 4;

// 送信サイズ。モデルが学習時に使っている解像度に合わせて送ると崩れにくい。
// 送った画像と同じサイズで返させるので、出力サイズでもある。
// 値（ar_*）はモデル系統をまたいで共通なので、プロバイダを変えても同じ比が残る
//
// qwen: Qwen-Image 公式の aspect_ratios（https://github.com/QwenLM/Qwen-Image/issues/7）
// flux: FLUX 系。Runware は width/height が 64 の倍数・128〜2048 でないと通らない
const SIZE_PRESETS = {
  qwen: [
    { value: 'ar_1_1', label: '1:1（1328×1328）', width: 1328, height: 1328 },
    { value: 'ar_16_9', label: '16:9（1664×928）', width: 1664, height: 928 },
    { value: 'ar_9_16', label: '9:16（928×1664）', width: 928, height: 1664 },
    { value: 'ar_4_3', label: '4:3（1472×1140）', width: 1472, height: 1140 },
    { value: 'ar_3_4', label: '3:4（1140×1472）', width: 1140, height: 1472 },
    { value: 'ar_3_2', label: '3:2（1584×1056）', width: 1584, height: 1056 },
    { value: 'ar_2_3', label: '2:3（1056×1584）', width: 1056, height: 1584 },
  ],
  flux: [
    { value: 'ar_1_1', label: '1:1（1024×1024）', width: 1024, height: 1024 },
    { value: 'ar_16_9', label: '16:9（1344×768）', width: 1344, height: 768 },
    { value: 'ar_9_16', label: '9:16（768×1344）', width: 768, height: 1344 },
    { value: 'ar_4_3', label: '4:3（1152×896）', width: 1152, height: 896 },
    { value: 'ar_3_4', label: '3:4（896×1152）', width: 896, height: 1152 },
    { value: 'ar_3_2', label: '3:2（1216×832）', width: 1216, height: 832 },
    { value: 'ar_2_3', label: '2:3（832×1216）', width: 832, height: 1216 },
  ],
};

// 旧バージョンは Qwen の解像度しか無かったので qwen_* で保存されている
const migrateSizeValue = (value) => String(value ?? '').replace(/^qwen_/, 'ar_');

// Runware の width / height の上限（64 の倍数・128〜2048）
const RUNWARE_MAX_PX = 2048;

// Runware は投入も結果取得も同じ URL に「タスクの配列」を POST する
const RUNWARE_API_URL = 'https://api.runware.ai/v1';
// 出力形式の綴りだけが他と違う（大文字・JPEG ではなく JPG）
const RUNWARE_FORMATS = { png: 'PNG', jpeg: 'JPG', webp: 'WEBP' };

// FLUX.1 Fill [dev] OneReward の推奨値。素の FLUX.1 Fill とはまるで違い、
// 内蔵ガイダンス（CFG）を 1 まで下げて本来の CFG（True CFG）を効かせる。
// ByteDance の公式作例が guidance_scale=1.0 / true_cfg=4.0 / steps=50 なので、
// それに合わせている
// https://huggingface.co/bytedance-research/OneReward
//
// negative prompt だけは公式作例（"nsfw"）に従わない。True CFG は対になる
// negative prompt があって初めて効くので何かは要るが、内容の方向づけを黙って
// 加えるのは筋が違う。どんな絵でも避けたい破綻だけを並べる
const RUNWARE_RECOMMENDED = {
  steps: 50,
  cfg: 1,
  trueCfg: 4,
  // マスクの周りを一緒に切り出して拡大してから描くので、狭い範囲ほど効く。
  // Runware の目安は 32〜64
  maskMargin: 48,
  // Runware の既定は 0.8。この値は「低いほど元画像の影響を残す」なので、
  // 既定のままだと塗った範囲にも元画像が 2 割残る。修復モデルなので 1 にする
  // （ドキュメント上は FLUX Fill 系は strength を見ないとあるが、このモデルの
  //  スキーマは既定 0.8 を宣言しているので、明示して曖昧さを消す）
  strength: 1,
  // モデルへ渡すマスクを広げる px（送信サイズ基準）。潜在空間のひと単位が
  // 8px なので、2 単位ぶん見ておけば境目の混ざりは合成で捨てられる
  maskGrow: 16,
  // マスクがこの距離より縁に近い辺を、単色で広げてから送る。
  // maskMargin（48）より広く取って、切り出しが画像内に詰められないようにする
  padEdges: 96,
  negativePrompt: 'low quality, blurry, distorted, deformed, artifacts',
};

// スケジューラ。既定（自動）のままが基本なので、選択肢として出すだけ
const RUNWARE_SCHEDULERS = ['Default', 'FlowMatchEulerDiscreteScheduler', 'Euler', 'Euler a',
  'Euler Beta', 'Euler Karras', 'Euler Exponential', 'DDIM', 'DEISMultistepScheduler',
  'DPM++', 'DPM++ 2M', 'DPM++ 2M Karras', 'DPM++ 2M SDE', 'DPM++ 2M SDE Karras',
  'DPM++ 3M', 'DPM++ 3M Karras', 'DPM++ SDE', 'DPM++ SDE Karras',
  'Heun', 'Heun Karras', 'LMS', 'LMS Karras', 'UniPC', 'UniPC 2M', 'UniPC 2M Karras',
  'UniPC 3M', 'UniPC 3M Karras', 'UniPC Karras', 'LCM', 'TCDScheduler'];

const ACCESS_EXPIRED_MSG = 'セッションが切れました。ページを再読み込みしてください。';

/* ---------- helpers ---------- */

const $ = (sel) => document.querySelector(sel);

const els = {
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
  maskModeHint: $('#maskModeHint'),
  alignToggle: $('#alignToggle'),
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
  sizeHint: $('#sizeHint'),
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
  rwLoraList: $('#rwLoraList'),
  rwAddLoraBtn: $('#rwAddLoraBtn'),
  rwPickLoraBtn: $('#rwPickLoraBtn'),
  rwLoraHint: $('#rwLoraHint'),
  rwSteps: $('#rwSteps'),
  rwCfg: $('#rwCfg'),
  rwTrueCfg: $('#rwTrueCfg'),
  rwStrength: $('#rwStrength'),
  rwMaskGrow: $('#rwMaskGrow'),
  rwPadEdges: $('#rwPadEdges'),
  rwMaskMargin: $('#rwMaskMargin'),
  rwScheduler: $('#rwScheduler'),
  rwOutputQuality: $('#rwOutputQuality'),
  rwPromptWeighting: $('#rwPromptWeighting'),
  rwPresetBtn: $('#rwPresetBtn'),
  rwParamHint: $('#rwParamHint'),
  negativeHint: $('#negativeHint'),
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

/* ---------- LoRA ライブラリ（読み取りのみ・app.js と同じ形式） ---------- */

const loraLabel = (path) => loraLib.label(path);
const loraDefaultScale = (path) => loraLib.defaultScale(path);
const loraTriggerWords = (path) => loraLib.triggerWords(path);

// LoRA を使えるのは Qwen Image Edit の 2 プロバイダだけなので、候補も Qwen 用に絞る
// （Krea 2 用を混ぜても効かないか、出力が壊れる）。Runware では LoRA 欄ごと隠す
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

/* ---------- Runware の LoRA 行 ---------- */

// Runware は LoRA を AIR（provider:model@version）で指定するので、URL を持つ
// 既存のライブラリは使えない。控えと取り込みは runware-lora.js が持っている
const RW_WEIGHT_MIN = -4; // スキーマ上の下限。負の値は「その傾向から遠ざける」
const RW_WEIGHT_MAX = 4;

function addRwLoraRow(air = '', weight) {
  const library = runwareLora.sorted();
  if (library.length === 0) return;
  if (els.rwLoraList.querySelectorAll('.lora-row').length >= MAX_LORAS) return;

  const row = document.createElement('div');
  row.className = 'lora-row';

  const head = document.createElement('div');
  head.className = 'lora-head';

  const select = document.createElement('select');
  select.className = 'lora-select';
  for (const item of library) {
    const opt = document.createElement('option');
    opt.value = item.air;
    opt.textContent = runwareLora.labelOf(item);
    opt.title = item.air;
    select.appendChild(opt);
  }
  select.value = air && library.some((l) => l.air === air) ? air : library[0].air;
  head.appendChild(select);

  const delBtn = document.createElement('button');
  delBtn.className = 'ghost-btn small';
  delBtn.type = 'button';
  delBtn.textContent = '削除';
  delBtn.addEventListener('click', () => {
    row.remove();
    saveForm();
    syncRwAddLoraBtn();
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
  scaleLabel.textContent = 'weight';
  const slider = document.createElement('input');
  slider.type = 'range';
  const num = document.createElement('input');
  num.type = 'number';
  for (const el of [slider, num]) {
    el.min = String(RW_WEIGHT_MIN);
    el.max = String(RW_WEIGHT_MAX);
    el.step = '0.05';
  }
  const initial = weight ?? runwareLora.defaultWeight(select.value);
  slider.value = String(initial);
  num.value = String(initial);
  slider.addEventListener('input', () => { num.value = slider.value; row.dataset.scaleTouched = '1'; saveForm(); });
  num.addEventListener('input', () => { slider.value = num.value; row.dataset.scaleTouched = '1'; saveForm(); });
  scaleWrap.append(scaleLabel, slider, num);
  row.appendChild(scaleWrap);

  select.addEventListener('change', () => {
    if (!row.dataset.scaleTouched) {
      const def = runwareLora.defaultWeight(select.value);
      slider.value = String(def);
      num.value = String(def);
    }
    renderRwRowTrigger(row);
    saveForm();
  });

  els.rwLoraList.appendChild(row);
  renderRwRowTrigger(row);
  syncRwAddLoraBtn();
}

function renderRwRowTrigger(row) {
  const box = row.querySelector('.lora-trigger');
  const words = runwareLora.triggerWords(row.querySelector('.lora-select').value);
  box.innerHTML = '';
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

// 控えが変わったら、行のプルダウンにも新しい候補を出す（選択は保つ）
function refreshRwRowOptions(row) {
  const select = row.querySelector('.lora-select');
  const keep = select.value;
  select.innerHTML = '';
  for (const item of runwareLora.sorted()) {
    const opt = document.createElement('option');
    opt.value = item.air;
    opt.textContent = runwareLora.labelOf(item);
    opt.title = item.air;
    select.appendChild(opt);
  }
  select.value = keep;
  renderRwRowTrigger(row);
}

function syncRwAddLoraBtn() {
  const count = els.rwLoraList.querySelectorAll('.lora-row').length;
  const usable = runwareLora.sorted().length;
  els.rwAddLoraBtn.disabled = count >= MAX_LORAS || usable === 0;
  els.rwAddLoraBtn.title = count >= MAX_LORAS ? `LoRA はこの画面では最大 ${MAX_LORAS} 個までです` : '';
  els.rwLoraHint.hidden = usable > 0;
  els.rwLoraHint.textContent = '候補がまだありません。「Runware から取り込み」で、Runware に登録済みの LoRA を探して追加してください。';
}

// 選択中の行を API の形（[{ model, weight }]）にする。
// weight は 0.01 刻みでないと弾かれるので、浮動小数の誤差を落としてから送る
function collectRwLoras() {
  return [...els.rwLoraList.querySelectorAll('.lora-row')]
    .map((row) => ({
      model: row.querySelector('.lora-select').value,
      weight: Math.round((Number(row.querySelector('input[type="number"]').value) || 0) * 100) / 100,
    }))
    .filter((l) => l.model && l.weight !== 0);
}

// 行の再現用（下書きの保存と復元）。送信と同じ 0.01 刻みに丸めて持つ
function rwLoraRows() {
  return [...els.rwLoraList.querySelectorAll('.lora-row')].map((row) => ({
    air: row.querySelector('.lora-select').value,
    weight: Math.round((Number(row.querySelector('input[type="number"]').value) || 0) * 100) / 100,
  }));
}

/* ---------- 入力画像 ---------- */

// { url, width, height, from } を持つ。url は R2 に置いた元解像度の画像で、
// マスク合成の土台になる。モデルへ送るのはここから作る縮小版（sendSize）
let source = null;
let sourceImage = null; // 読み込み済みの元画像。送信サイズへの描き直しに使う

function loadImageEl(src, crossOrigin = null) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = src;
  });
}

function isSameOrigin(src) {
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return true; // data URI など
  }
}

// canvas で中身を読む画像の読み込み。別オリジンのままだと canvas が汚染されて
// 合成結果を取り出せない（"The operation is insecure"）。CDN が CORS を
// 許可していれば読める（許可していなければ onerror になる）
function loadImageForCanvas(src) {
  return isSameOrigin(src) ? loadImageEl(src) : loadImageEl(src, 'anonymous');
}

// 別サイトにある画像を R2 へ取り込んで、同一オリジンの URL にして返す。
// プロバイダによっては履歴保存時の取り込み対象から外れて外部 URL のまま残り、
// そのままでは合成できないうえ、CDN の URL が失効すると開き直せなくなる
async function captureImage(url) {
  if (isSameOrigin(url)) return url;
  const res = await fetch('/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok || isHtmlResponse(res)) return url; // 取り込めなければ元の URL のまま試す
  return (await res.json()).url;
}

// 指定サイズに描き直して JPEG の data URI にする。size 省略時は長辺 MAX_INPUT_PX
// までの縮小のみ（元のままだと data URI が数十 MB になり送信が通らない）
function toDataUri(img, size = null, quality = INPUT_QUALITY) {
  let { width, height } = size ?? fitWithin(img, MAX_INPUT_PX);
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { dataUri: canvas.toDataURL('image/jpeg', quality), width: canvas.width, height: canvas.height };
}

// 読み込み済みの元画像。復元直後などで手元に無ければ R2 から読み直す
async function sourceImageEl() {
  if (sourceImage) return sourceImage;
  if (!source?.url) throw new Error('入力画像がありません');
  sourceImage = await loadImageForCanvas(source.url);
  return sourceImage;
}

// 縦横比を保ったまま長辺 max（と面積 maxArea）に収める
function fitWithin(img, max, maxArea = Infinity) {
  const w = img.naturalWidth ?? img.width;
  const h = img.naturalHeight ?? img.height;
  const ratio = Math.min(1, max / Math.max(w, h), Math.sqrt(maxArea / (w * h)));
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

/* ---------- 送信サイズ ---------- */

// 今のプロバイダのモデルが得意な解像度
function sizePresets() {
  return SIZE_PRESETS[provider().sizeKind] ?? SIZE_PRESETS.qwen;
}

// 縦横比が一番近いプリセット。比の対数で比べる（横長・縦長を対称に扱う）
function nearestPresetSize(width, height, presets = sizePresets()) {
  const target = Math.log(width / height);
  return presets.reduce((best, size) => (
    Math.abs(Math.log(size.width / size.height) - target)
      < Math.abs(Math.log(best.width / best.height) - target) ? size : best));
}

// 選択中の設定での送信サイズ。'none' はリサイズしない（長辺の上限のみ）。
// プロバイダ側に刻みの制約があれば最後に丸める（Runware は 64 の倍数）
function sendSize(width = source?.width, height = source?.height) {
  if (!width || !height) return null;
  const presets = sizePresets();
  const choice = els.sizeSelect.value;
  const size = choice === 'none' ? fitWithin({ width, height }, MAX_INPUT_PX)
    : presets.find((s) => s.value === choice) ?? nearestPresetSize(width, height, presets);
  const snap = provider().snapSize;
  return snap ? snap(size) : { width: size.width, height: size.height };
}

// プルダウンの中身はプロバイダごとに変わる（同じ比でも解像度が違う）。
// 選んでいた値は、同じ value があればそのまま残す
function renderSizeOptions() {
  const keep = els.sizeSelect.value;
  const options = [
    { value: 'auto', label: '自動（近いアスペクト比に合わせる）' },
    ...sizePresets(),
    { value: 'none', label: `リサイズしない（長辺 ${MAX_INPUT_PX}px まで）` },
  ];
  els.sizeSelect.innerHTML = '';
  for (const size of options) {
    const opt = document.createElement('option');
    opt.value = size.value;
    opt.textContent = size.label;
    els.sizeSelect.appendChild(opt);
  }
  els.sizeSelect.value = options.some((o) => o.value === keep) ? keep : 'auto';
}

// 元画像と送信サイズで縦横比がどれだけ違うか（1.0 = 同じ）。
// 離れているほど引き伸ばされて送られる
function aspectStretch(size) {
  if (!source || !size) return 1;
  return (size.width / size.height) / (source.width / source.height);
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

// keepMask は「前の画像に合わせて塗ったマスクをそのまま引き継ぐ」場合だけ。
// 下書きの復元と、過去の合成結果を開き直すときにしか使わない
async function setSourceFromSrc(src, from, { keepMask = false } = {}) {
  setError('');
  setStatus('画像を読み込み中…');
  try {
    const img = await loadImageEl(src);
    // 合成の土台は元解像度のまま残す（モデルへ送るのは実行時に作る縮小版）。
    // 既に R2 にある画像（履歴・前回の結果・復元した入力）はそのまま使い回す
    const stored = storedImageUrl(src);
    let url = stored;
    let { width, height } = fitWithin(img, MAX_ORIGINAL_PX, MAX_ORIGINAL_AREA);
    if (stored) {
      width = img.naturalWidth;
      height = img.naturalHeight;
    } else {
      const original = toDataUri(img, { width, height }, ORIGINAL_QUALITY);
      url = await uploadDataUri(original.dataUri, { app: 'fal playground', source: 'imgedit-input' });
    }
    // 別の画像に差し替えたらマスクは引き継がない。前の画像の形に合わせて
    // 塗った範囲を、関係のない画像へそのまま当ててしまわないようにする
    const dropMask = !keepMask && url !== source?.url && mask.strokes.length > 0;
    if (dropMask) resetMask();

    sourceImage = img;
    source = { url, width, height, from };
    renderSource();
    saveForm();
    // 黙って消えると操作ミスに見えるので、消したことだけ伝える
    setStatus(dropMask ? '入力画像を差し替えたので、マスクは消去しました' : '', true);
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
    els.sourceImg.src = source.url;
    els.sourceInfo.textContent = `${source.width} × ${source.height}`
      + (source.from === 'history' ? '（履歴から）' : source.from === 'result' ? '（前回の結果）' : '');
  }
  syncMaskUi();
  syncRunBtn();
  renderSizeHint();
}

// 何をどのサイズで送るかを明示する。引き伸ばして送る場合はそれも出す
function renderSizeHint() {
  const size = sendSize();
  if (!size) {
    els.sizeHint.hidden = true;
    return;
  }
  const stretch = aspectStretch(size);
  const off = Math.abs(1 - stretch) * 100;
  // 引き伸ばして送った場合、元の比率に戻るのはマスク合成のときだけ
  //（マスク無しはモデルの出力がそのまま結果になる）
  const stretched = `${stretch > 1 ? '横' : '縦'}に ${off.toFixed(0)}% 引き伸ばして送り、`
    + (maskOn() ? '合成で元の比率へ戻します' : '結果もその比率になります');
  els.sizeHint.hidden = false;
  els.sizeHint.textContent = `${source.width}×${source.height} → ${size.width}×${size.height} で送信`
    + (off < 0.5 ? '（比率そのまま）' : `（${stretched}）`)
    + padHintText(size);
  els.sizeHint.classList.toggle('warn', off > 12);
}

// 縁の余白が付く場合、どの辺にどれだけ足すかを送信サイズの説明に添える
function padHintText(size) {
  const api = provider();
  if (!api.padEdges || !api.nativeMask || !maskOn() || mask.strokes.length === 0) return '';
  const frame = padFrame(size, mask, api.maskGrow ? api.maskGrow() : 0, api.padEdges());
  if (!frame) return '';
  const sides = [['上', frame.pad.top], ['下', frame.pad.bottom],
    ['左', frame.pad.left], ['右', frame.pad.right]]
    .filter(([, v]) => v > 0).map(([name]) => name).join('・');
  return ` ・ マスクが縁に近いので ${sides} に余白を足し、${frame.outer.width}×${frame.outer.height}`
    + ' で送って元の枠で切り出します';
}

function clearSource() {
  source = null;
  sourceImage = null;
  resetMask();
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
  if (on) drawMaskOverlay();
}

/* ---------- マスクの描画（ラスタライズ） ---------- */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// src（w×h）を横方向に箱ぼかしして、転置した dst（h×w）へ書く。
// 端は最外周の値を伸ばして扱う。2 回通すと縦横の両方がぼけ、向きも元に戻る
function boxBlurTransposed(src, dst, w, h, r) {
  const scale = 1 / (r * 2 + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    // 走査の初期値。左端より外は src[row] が続いているものとする
    let sum = src[row] * (r + 1);
    for (let i = 1; i <= r; i++) sum += src[row + Math.min(i, w - 1)];
    for (let x = 0; x < w; x++) {
      dst[x * h + y] = sum * scale;
      sum += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
}

// アルファチャンネルだけを箱ぼかし 3 回で均す（回数を重ねるとガウスに近づく）。
// 色は白に揃える。縁が「白の半透明」でないと、黒地に重ねたときに濃淡が出ない
function blurAlphaInPlace(canvas, radius) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  // 箱ぼかしは元の値だけを足し引きするので、途中の丸め誤差は蓄積しない
  let a = new Uint8ClampedArray(w * h);
  let b = new Uint8ClampedArray(w * h);
  for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3];
  // 3 回の箱ぼかしでガウス（σ = radius）に近づける箱の半径
  const r = Math.max(1, Math.round(radius));
  for (let pass = 0; pass < 3; pass++) {
    boxBlurTransposed(a, b, w, h, r); // 横 → b は h×w
    boxBlurTransposed(b, a, h, w, r); // 縦 → a は w×h に戻る
  }
  for (let i = 0; i < a.length; i++) {
    const o = i * 4;
    px[o] = 255;
    px[o + 1] = 255;
    px[o + 2] = 255;
    px[o + 3] = a[i];
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

// ぼかしを行う作業解像度の上限（長辺）。合成用のマスクは元画像と同じ大きさ
// （最大 4096px）で作るので、そのまま扱うと重すぎる。ぼかした後のマスクは
// なだらかなので、この解像度から拡大しても縁は滑らか
const BLUR_WORK_MAX_PX = 1024;

// ctx.filter は「プロパティはあるが無視される」実装もあるので、型で判定せず
// 実際ににじむかどうかを 1 度だけ試して覚える
let filterBlurs = null;

function supportsFilterBlur() {
  if (filterBlurs !== null) return filterBlurs;
  try {
    const dot = makeCanvas(9, 1);
    const dctx = dot.getContext('2d');
    if (typeof dctx.filter !== 'string') return (filterBlurs = false);
    dctx.fillStyle = '#fff';
    dctx.fillRect(4, 0, 1, 1);

    const out = makeCanvas(9, 1);
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.filter = 'blur(2px)';
    octx.drawImage(dot, 0, 0);
    // 2px 離れた画素までにじんでいれば効いている
    filterBlurs = octx.getImageData(0, 0, 9, 1).data[6 * 4 + 3] > 0;
  } catch {
    filterBlurs = false;
  }
  return filterBlurs;
}

// src を w×h に描き直し、周囲 pad px を「縁の画素が続いている」ものとして
// 埋めた canvas を返す。ぼかす前にこれを挟まないと、画像の外側が透明として
// 混ざり、端まで塗ったマスクが縁で薄くなってしまう
function padWithEdge(src, w, h, pad) {
  const out = makeCanvas(w + pad * 2, h + pad * 2);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const sw = src.width;
  const sh = src.height;
  ctx.drawImage(src, 0, 0, sw, sh, pad, pad, w, h);
  // 四辺は 1px の帯を引き伸ばす
  ctx.drawImage(src, 0, 0, 1, sh, 0, pad, pad, h);
  ctx.drawImage(src, sw - 1, 0, 1, sh, pad + w, pad, pad, h);
  ctx.drawImage(src, 0, 0, sw, 1, pad, 0, w, pad);
  ctx.drawImage(src, 0, sh - 1, sw, 1, pad, pad + h, w, pad);
  // 四隅は角の 1px
  ctx.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
  ctx.drawImage(src, sw - 1, 0, 1, 1, pad + w, 0, pad, pad);
  ctx.drawImage(src, 0, sh - 1, 1, 1, 0, pad + h, pad, pad);
  ctx.drawImage(src, sw - 1, sh - 1, 1, 1, pad + w, pad + h, pad, pad);
  return out;
}

// ぼかし。画像の外側は「縁が続いている」ものとして扱う。
//
// 素直に canvas をぼかすと、外側は透明として混ざる。すると画像の端まで塗った
// マスクが縁で半分ほどの濃さになり、端に沿って元画像が帯状に残ってしまう
// （端の物体を消しても縁だけ消えない、といった形で出る）。
// ぼかす前に縁を外へ伸ばしておけば、端まで塗った範囲は端まで有効なままになる
function blurCanvas(src, radius) {
  if (radius < 0.5) return src;

  // 作業解像度。ぼかした後はなだらかなので、ここから拡大しても縁は滑らか
  const scale = Math.min(1, BLUR_WORK_MAX_PX / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const r = radius * scale;
  const pad = Math.ceil(r * 2) + 1; // gaussian の裾が収まる幅

  let work = padWithEdge(src, w, h, pad);
  if (supportsFilterBlur()) {
    const blurred = makeCanvas(work.width, work.height);
    const bctx = blurred.getContext('2d');
    bctx.filter = `blur(${r}px)`;
    bctx.drawImage(work, 0, 0);
    work = blurred;
  } else {
    // ctx.filter が無い（または効かない）環境。以前はぼかし半径のぶんだけ
    // 縮小してから拡大し直していたが、それだと縮小率がそのままブロックの
    // 大きさになり、縁が階段状に見えてしまう
    blurAlphaInPlace(work, r);
  }

  // 余白を切り落として元の大きさに戻す
  const out = makeCanvas(src.width, src.height);
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(work, pad, pad, w, h, 0, 0, out.width, out.height);
  return out;
}

// ぼかしたマスクのアルファを 2 倍して振り切らせる（白のまま濃度だけ上げる）。
//
// ぼかしただけだと、輪郭を中心に内外へ均等ににじむので、塗った形そのものが
// 痩せる。細い塗りに強いぼかしをかけると、マスクがどこも 255 に届かず、
// 塗った範囲の全体に元画像が混ざったままになる（ブラシ 6・ぼかし 8 で 55%）。
//
// 2 倍すると、輪郭上がちょうど 255（ぼかし後は 50% なので）になり、内側は
// 振り切って完全な差し替えになる。ぼけ足は輪郭の外側だけに残るので、
// 「塗ったところは必ず差し替わり、その外側へ滑らかに抜ける」形になる
function boostMaskAlpha(src) {
  const out = makeCanvas(src.width, src.height);
  const ctx = out.getContext('2d');
  // lighter は前乗算のまま加算するので、白のまま alpha だけが 2 倍になる
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(src, 0, 0);
  ctx.drawImage(src, 0, 0);
  return out;
}

// マスクを w×h のアルファ（白 = 差し替える）として描く。
// ぼかしぶんは輪郭の外側が半透明になり、そのまま合成の混ざり具合になる。
//
// grow は輪郭を外へ広げる px 数（モデルへ渡すマスク用）。塗り足す側は太く、
// 消しゴム側は細くすることで、出来上がりの形だけを膨らませる
function rasterizeMask(w, h, strokes = mask.strokes, feather = mask.feather, grow = 0) {
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
      // 「全面」。縁が薄くならないのは blurCanvas が縁を外へ伸ばすため
      ctx.fillRect(0, 0, w, h);
      continue;
    }
    const width = Math.max(1, stroke.r * 2 * long + (stroke.mode === 'erase' ? -grow : grow) * 2);
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
  const blurred = blurCanvas(c, feather * long);
  // ぼかしていない（feather が小さい）ときは既に 0/255 なので何もしない
  return blurred === c ? c : boostMaskAlpha(blurred);
}

// モデルへ渡すマスク画像。白 = 描き直す / 黒 = そのまま、という約束なので
// 黒地に白で塗る（Runware の maskImage）。ぼかしはそのまま濃淡になる。
// PNG なのは、JPEG のブロックノイズで縁がにじむのを避けるため
function maskDataUri(outer, inner, maskData = mask, grow = 0) {
  const canvas = makeCanvas(outer.width, outer.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const shape = rasterizeMask(inner.width, inner.height, maskData.strokes, maskData.feather, grow);
  // 余白へは縁を伸ばす。縁まで塗ったマスクは余白の中まで続くので、
  // モデルにとっての「マスクの境目」は元画像の外に出る
  drawExtended(ctx, shape, inner, outer);
  return canvas.toDataURL('image/png');
}

// 送信用の画像。余白は単色で塗り、元画像は inner の位置に置く
function framedDataUri(img, outer, inner) {
  const canvas = makeCanvas(outer.width, outer.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = borderColor(img);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, inner.x, inner.y, inner.width, inner.height);
  return canvas.toDataURL('image/jpeg', INPUT_QUALITY);
}

/* ---------- 縁の余白（送信前に画像を広げる） ---------- */
//
// Runware の maskMargin は「マスクの周りごと切り出して拡大し、修復してから
// 元に戻す」処理で、最小 32・無効にできない。マスクが画像の縁に近いと切り出しが
// 画像内に詰められ、その辺だけ処理が変わって元画像が縁に残る。
//
// そこで、マスクが縁に近い辺だけ単色で広げてから送り、返ってきた画像を
// 元の枠で切り出す。モデルから見るとマスクは画像の内側にあるので、
// どの辺も同じ扱いになる。

const PAD_PROBE_PX = 256; // マスクの外接矩形を測るときの解像度（長辺）

// マスクの外接矩形。各辺までの距離を 0..1 で返す。塗りが無ければ null。
// ぼかし・消しゴム・広げ幅の効いた後の形をそのまま測りたいので、
// 実際にラスタライズして走査する
function maskEdgeGaps(size, maskData, growPx) {
  const long = Math.max(size.width, size.height);
  const w = Math.max(8, Math.round(PAD_PROBE_PX * size.width / long));
  const h = Math.max(8, Math.round(PAD_PROBE_PX * size.height / long));
  const shape = rasterizeMask(w, h, maskData.strokes, maskData.feather, growPx * w / size.width);
  const data = shape.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, w, h).data;

  let minX = w; let minY = h; let maxX = -1; let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] <= 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return {
    left: minX / w,
    right: 1 - (maxX + 1) / w,
    top: minY / h,
    bottom: 1 - (maxY + 1) / h,
  };
}

// 送信する枠。マスクが amount px より縁に近い辺へ余白を足す。
// 足す必要が無ければ null（これまで通り素の送信サイズで送る）
function padFrame(size, maskData, growPx, amount) {
  if (!(amount > 0)) return null;
  const gap = maskEdgeGaps(size, maskData, growPx);
  if (!gap) return null;
  const pad = {
    left: gap.left * size.width < amount ? amount : 0,
    right: gap.right * size.width < amount ? amount : 0,
    top: gap.top * size.height < amount ? amount : 0,
    bottom: gap.bottom * size.height < amount ? amount : 0,
  };
  if (!(pad.left || pad.right || pad.top || pad.bottom)) return null;

  // 64 の倍数・2048 まで。はみ出す場合は全体を縮める（枠の比は保つ）
  const wantW = size.width + pad.left + pad.right;
  const wantH = size.height + pad.top + pad.bottom;
  const k = Math.min(1, RUNWARE_MAX_PX / wantW, RUNWARE_MAX_PX / wantH);
  // 切り上げる。丸めで足りなくなると余白が痩せる
  const snap = (v) => Math.min(RUNWARE_MAX_PX, Math.max(128, Math.ceil(v / 64) * 64));
  const outer = { width: snap(wantW * k), height: snap(wantH * k) };

  // 元画像が入る範囲。丸めた差は余白側で吸収し、中身は引き伸ばさない
  const width = Math.min(outer.width, Math.max(64, Math.round(size.width * k)));
  const height = Math.min(outer.height, Math.max(64, Math.round(size.height * k)));
  const inner = {
    x: Math.min(Math.round(pad.left * k), outer.width - width),
    y: Math.min(Math.round(pad.top * k), outer.height - height),
    width,
    height,
  };
  return { outer, inner, pad };
}

// 余白を塗る単色。画像の外周の平均色にしておくと、モデルから見て不自然に
// なりにくい（余白はマスクの外なので描き直されない）
function borderColor(img) {
  const s = 32;
  const c = makeCanvas(s, s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, s, s);
  const d = ctx.getImageData(0, 0, s, s).data;
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (x > 0 && x < s - 1 && y > 0 && y < s - 1) continue; // 外周だけ
      const o = (y * s + x) * 4;
      r += d[o];
      g += d[o + 1];
      b += d[o + 2];
      n++;
    }
  }
  return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
}

// src を inner の位置へ描き、余白へは縁の 1px を伸ばす。
// マスクを広げた枠に載せるときに使う（縁まで塗ったマスクが余白へ続く）
function drawExtended(ctx, src, inner, outer) {
  const sw = src.width;
  const sh = src.height;
  const { x, y, width: w, height: h } = inner;
  const right = outer.width - x - w;
  const bottom = outer.height - y - h;
  ctx.drawImage(src, 0, 0, sw, sh, x, y, w, h);
  if (x > 0) ctx.drawImage(src, 0, 0, 1, sh, 0, y, x, h);
  if (right > 0) ctx.drawImage(src, sw - 1, 0, 1, sh, x + w, y, right, h);
  if (y > 0) ctx.drawImage(src, 0, 0, sw, 1, x, 0, w, y);
  if (bottom > 0) ctx.drawImage(src, 0, sh - 1, sw, 1, x, y + h, w, bottom);
  // 四隅
  if (x > 0 && y > 0) ctx.drawImage(src, 0, 0, 1, 1, 0, 0, x, y);
  if (right > 0 && y > 0) ctx.drawImage(src, sw - 1, 0, 1, 1, x + w, 0, right, y);
  if (x > 0 && bottom > 0) ctx.drawImage(src, 0, sh - 1, 1, 1, 0, y + h, x, bottom);
  if (right > 0 && bottom > 0) ctx.drawImage(src, sw - 1, sh - 1, 1, 1, x + w, y + h, right, bottom);
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
  renderSizeHint(); // 塗りの位置で、縁の余白が要るかどうかが変わる
  saveForm();
  refreshResultComposite();
}

// 塗りだけを捨てる。ぼかしはスライダーの設定なので今の値を引き継ぐ
function resetMask() {
  mask = { ...structuredClone(EMPTY_MASK), feather: maskFeatherRatio() };
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

/* ---------- ずれの補正 ---------- */
//
// Qwen Image Edit は画像全体を作り直すので、返ってくる絵が数 px ずれることが
// ある。そのままマスクで抜くと、差し替えた部分だけ位置がずれて見える。
//
// マスクの外側は「変わらないはず」の領域なので、そこの特徴が一番よく重なる
// 平行移動を探して、重ねる前にずらす。明るさの違いに引きずられないよう、
// 輝度そのものではなく勾配（＝輪郭の出方）で比べる

const ALIGN_COARSE_PX = 192; // 粗く探すときの作業解像度（長辺）
const ALIGN_FINE_PX = 512; // 詰めるときの作業解像度
const ALIGN_RANGE_RATIO = 0.03; // 探す範囲（長辺に対する比）
const ALIGN_MIN_SAMPLES = 512; // これ未満しか比べられないならあきらめる
const ALIGN_MIN_SCORE = 0.3; // 相関がこれ以下なら、ずらさない

// 画像を w×h に描き直して勾配（|dx| + |dy|）を返す
function gradientField(img, w, h, crop = null) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  if (crop) ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, w, h);
  else ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      g[i] = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + w] - lum[i - w]);
    }
  }
  return g;
}

// 比べてよい画素（マスクの外側）。境目は編集の影響を受けるので広めに除く
function alignWeights(maskData, w, h) {
  const long = Math.max(w, h);
  const shape = rasterizeMask(w, h, maskData.strokes, maskData.feather, long * 0.04);
  const alpha = shape.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, w, h).data;
  const weights = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0; i < weights.length; i++) {
    if (alpha[i * 4 + 3] <= 8) {
      weights[i] = 1;
      n++;
    }
  }
  return { weights, count: n };
}

// b を (dx, dy) ずらしたときに a と一番よく重なる位置を探す。
// 正規化相互相関なので、明るさやコントラストの違いには反応しない
function bestShift(a, b, weights, w, h, range, from = { dx: 0, dy: 0 }) {
  let best = { dx: from.dx, dy: from.dy, score: -Infinity };
  const scores = new Map(); // 副画素まで詰めるのに、ピークの周りの値が要る
  for (let dy = from.dy - range; dy <= from.dy + range; dy++) {
    for (let dx = from.dx - range; dx <= from.dx + range; dx++) {
      const y0 = Math.max(1, 1 - dy);
      const y1 = Math.min(h - 1, h - 1 - dy);
      const x0 = Math.max(1, 1 - dx);
      const x1 = Math.min(w - 1, w - 1 - dx);
      let n = 0; let sa = 0; let sb = 0; let saa = 0; let sbb = 0; let sab = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          if (!weights[i]) continue;
          const va = a[i];
          const vb = b[i + dy * w + dx];
          n++;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      if (n < ALIGN_MIN_SAMPLES) continue;
      const ma = sa / n;
      const mb = sb / n;
      const cov = sab / n - ma * mb;
      const varA = saa / n - ma * ma;
      const varB = sbb / n - mb * mb;
      const score = cov / Math.sqrt(Math.max(1e-6, varA * varB));
      scores.set(`${dx},${dy}`, score);
      if (score > best.score) best = { dx, dy, score };
    }
  }
  return { ...best, scores };
}

// 相関のピークを放物線で近似して、画素の間まで読む。
// ずれは 1px 未満のことも多いので、整数のままだと詰めきれない
function subpixelPeak(best, scores) {
  const at = (dx, dy) => scores.get(`${dx},${dy}`);
  const axis = (minus, plus) => {
    if (minus === undefined || plus === undefined) return 0;
    const denom = minus - 2 * best.score + plus;
    if (!(Math.abs(denom) > 1e-9)) return 0;
    // 中心からの外れが半画素を超えるなら、そもそも当てはまりが悪い
    const d = (0.5 * (minus - plus)) / denom;
    return Math.abs(d) <= 0.5 ? d : 0;
  };
  return {
    dx: best.dx + axis(at(best.dx - 1, best.dy), at(best.dx + 1, best.dy)),
    dy: best.dy + axis(at(best.dx, best.dy - 1), at(best.dx, best.dy + 1)),
  };
}

// 元画像に対する編集結果のずれ。合成時に引く量（元画像の解像度）を返す。
// 判断できなければ null（ずらさない）
function alignOffset(baseImg, editedImg, maskData, crop = null) {
  const baseW = baseImg.naturalWidth || baseImg.width;
  const baseH = baseImg.naturalHeight || baseImg.height;
  const aspect = baseW / baseH;

  const fit = (target) => (aspect >= 1
    ? { w: target, h: Math.max(16, Math.round(target / aspect)) }
    : { w: Math.max(16, Math.round(target * aspect)), h: target });

  // 粗く探す
  const c = fit(ALIGN_COARSE_PX);
  const cw = alignWeights(maskData, c.w, c.h);
  if (cw.count < ALIGN_MIN_SAMPLES) return null; // 比べられる場所がほとんど無い
  const range = Math.max(2, Math.round(Math.max(c.w, c.h) * ALIGN_RANGE_RATIO));
  const coarse = bestShift(
    gradientField(baseImg, c.w, c.h),
    gradientField(editedImg, c.w, c.h, crop),
    cw.weights, c.w, c.h, range,
  );
  if (!Number.isFinite(coarse.score) || coarse.score < ALIGN_MIN_SCORE) return null;

  // 作業解像度を上げて詰める
  const f = fit(ALIGN_FINE_PX);
  const scale = f.w / c.w;
  const fw = alignWeights(maskData, f.w, f.h);
  const start = { dx: Math.round(coarse.dx * scale), dy: Math.round(coarse.dy * scale) };
  const fine = fw.count >= ALIGN_MIN_SAMPLES
    ? bestShift(
      gradientField(baseImg, f.w, f.h),
      gradientField(editedImg, f.w, f.h, crop),
      fw.weights, f.w, f.h, Math.ceil(scale) + 1, start,
    )
    : { ...start, score: coarse.score };

  // 編集結果が (dx, dy) ずれているので、重ねるときは逆へ動かす。
  // drawImage は小数の座標を受け取れるので、副画素のぶんも活かせる
  const peak = fine.scores ? subpixelPeak(fine, fine.scores) : fine;
  const k = baseW / f.w;
  const round2 = (v) => Math.round(v * 100) / 100;
  const offset = { dx: round2(-peak.dx * k), dy: round2(-peak.dy * k), score: fine.score };
  // 4 分の 1 画素に満たないずれは、動かすほうが害になる
  return Math.abs(offset.dx) < 0.25 && Math.abs(offset.dy) < 0.25 ? null : offset;
}

/* ---------- 合成 ---------- */

// 出力画像をマスクの内側だけ元画像に重ねる。
//
// 合成は「元画像の解像度・縦横比」で行い、出力をそこへ引き伸ばす。モデルへは
// Qwen の解像度に合わせて縮めた（必要なら比を変えた）画像を送っているので、
// ここで戻すことで、マスクの外側は元の画素のまま・内側だけが差し替わる
function compositeWithMask(baseImg, editedImg, maskData, crop = null, offset = null) {
  const w = baseImg.naturalWidth || baseImg.width;
  const h = baseImg.naturalHeight || baseImg.height;
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(baseImg, 0, 0, w, h);

  const layer = makeCanvas(w, h);
  const lctx = layer.getContext('2d');
  lctx.imageSmoothingQuality = 'high';
  // 縁の余白を付けて送った場合は、元画像が入っていた範囲だけを取り出す。
  // 半画素ぶん内側から取るのは、拡大の補間が余白側の画素を拾わないようにするため
  // （そのままだと切り出した縁に余白の色が 1px にじむ）
  const put = (dx, dy) => {
    if (crop) {
      const i = 0.5;
      lctx.drawImage(editedImg,
        crop.x + i, crop.y + i, crop.width - i * 2, crop.height - i * 2, dx, dy, w, h);
    } else {
      lctx.drawImage(editedImg, dx, dy, w, h);
    }
  };
  // ずらすと端が空くので、先に素のまま敷いてから重ねる
  put(0, 0);
  if (offset && (offset.dx || offset.dy)) put(offset.dx, offset.dy);
  lctx.globalCompositeOperation = 'destination-in';
  lctx.drawImage(rasterizeMask(w, h, maskData.strokes, maskData.feather), 0, 0);

  ctx.drawImage(layer, 0, 0);
  return out;
}

// URL から合成した data URI を作る。画像は同一オリジン（R2）である必要がある
// （別ドメインのままだと canvas が汚染されて取り出せない）
// offset に 'auto' を渡すと、その場でずれを測る。測った結果も返すので、
// 塗り直しのたびに測り直さずに済む
async function compositeFromUrls(baseUrl, editedUrl, maskData, crop = null, offset = null, mime = 'image/png') {
  const [baseImg, editedImg] = await Promise.all([
    loadImageForCanvas(baseUrl), loadImageForCanvas(editedUrl),
  ]);
  const shift = offset === 'auto' ? alignOffset(baseImg, editedImg, maskData, crop) : offset;
  const canvas = compositeWithMask(baseImg, editedImg, maskData, crop, shift);
  try {
    return {
      dataUri: canvas.toDataURL(mime, 0.95),
      width: canvas.width,
      height: canvas.height,
      offset: shift,
    };
  } catch (err) {
    // ここに来るのは canvas が汚染されたときだけ。どちらの画像が原因か分かる
    // ようにしておく（黙って「操作は安全ではありません」だけ出さない）
    if (err.name !== 'SecurityError') throw err;
    const outside = [baseUrl, editedUrl].filter((u) => !isSameOrigin(u))
      .map((u) => new URL(u, location.href).hostname);
    throw new Error(outside.length
      ? `画像が別のサイト（${[...new Set(outside)].join(', ')}）にあるため取り出せませんでした`
      : '画像を取り出せませんでした');
  }
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
  await setSourceFromSrc(inputUrl, 'history', { keepMask: true });
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

// API の形はプロバイダごとに違うので、ここで差を吸収する。
// 画面の項目は data-only 属性で出し分ける（送っても無視される項目を見せない）
//
// sizeKind    … 送信サイズのプリセット（SIZE_PRESETS のキー）
// snapSize    … プロバイダ側の刻み制約に丸める（省略可）
// nativeMask  … マスクを API に渡せるか。渡せないものは合成だけで再現する
// requiresMask… マスク前提のモデルか（マスク無しでは実行させない）
const PROVIDERS = {
  fal: {
    label: 'fal（fal-ai/qwen-image-edit-2511/lora）',
    model: 'fal-ai/qwen-image-edit-2511/lora',
    note: '解像度・ステップ・ガイダンスまで指定できます。課金はメガピクセル単価（$0.035/MP）。',
    supports: { size: true, count: true, steps: true, guidance: true, acceleration: true, negative: true },
    sizeKind: 'qwen',
    // 画像全体を作り直すモデルなので、返ってくる絵が数 px ずれることがある
    alignOutput: true,
    pollMs: 1200,

    buildInput(dataUri, size) {
      const input = {
        prompt: els.prompt.value.trim(),
        image_urls: [dataUri],
        num_images: Number(els.numImages.value),
        num_inference_steps: Number(els.steps.value) || 28,
        guidance_scale: Number(els.guidance.value) || 4.5,
        acceleration: els.acceleration.value,
        output_format: els.outputFormat.value,
      };
      // 送った画像と同じ大きさで返させる（マスク合成が枠ごとに重なる）
      if (size) input.image_size = { width: size.width, height: size.height };
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
      const size = sendSize();
      if (!size) return '';
      const { width, height } = size;
      const mp = (width * height) / 1e6 * Number(els.numImages.value);
      return `出力 ${width}×${height} × ${els.numImages.value} 枚`
        + ` ・ ${mp.toFixed(1)} MP ・ 目安 $${(mp * 0.035).toFixed(3)}`;
    },
  },

  wavespeed: {
    label: 'WaveSpeed（wavespeed-ai/qwen-image/edit-2511-lora）',
    model: 'wavespeed-ai/qwen-image/edit-2511-lora',
    note: '指定できるのは指示文・LoRA・seed・形式だけです（ステップ等は API に無く、出力は 1 枚）。出力サイズの指定も無いので、送信サイズがそのまま効きます。課金は 1 枚 $0.025 の固定制。LoRA は公開アクセスできる URL である必要があります。',
    supports: {},
    sizeKind: 'qwen',
    alignOutput: true,
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

  // FLUX.1 Fill [dev] OneReward（runware:121@1）。塗った範囲だけを描き直す
  // 修復（inpainting）モデルで、マスクを API にそのまま渡せる唯一のプロバイダ。
  // 1 リクエストにタスクの配列を投げる形で、投入も結果取得も同じ URL を叩く
  runware: {
    label: 'Runware（runware:121@1 / FLUX.1 Fill [dev] OneReward）',
    model: 'runware:121@1',
    note: 'マスクで塗った範囲だけをモデルが描き直す修復モデルです（マスク必須）。素の FLUX.1 Fill とは推奨値がまるで違い、内蔵ガイダンス（CFG）を 1 まで下げて True CFG を 4 前後で効かせます。物体を消すときは指示文を remove の 1 語にします。送信サイズは 64 の倍数に丸めます。LoRA は Runware に登録済みのもの（AIR 指定）から選びます。費用は結果に実額を表示します。',
    supports: { size: true, count: true, steps: true, guidance: true, negative: true },
    sizeKind: 'flux',
    // LoRA の絞り込みに使う。FLUX.1 Fill [dev] は flux-1-dev 系
    // 送信サイズ基準の px。マスクを広げるのはモデルへ渡す側だけで、
    // 合成に使うマスクは塗ったままの形を保つ
    maskGrow: () => Number(els.rwMaskGrow.value) || 0,
    padEdges: () => Number(els.rwPadEdges.value) || 0,
    loraArchitecture: 'flux1d',
    loraArchitectureLabel: 'FLUX.1 dev',
    defaultNegative: RUNWARE_RECOMMENDED.negativePrompt,
    nativeMask: true,
    requiresMask: true,
    pollMs: 1500,

    // 128〜2048 の 64 の倍数でないと 422 で弾かれる
    snapSize(size) {
      const clamp = (v) => Math.min(2048, Math.max(128, Math.round(v / 64) * 64));
      return { width: clamp(size.width), height: clamp(size.height) };
    },

    buildInput(dataUri, size, maskUri) {
      const task = {
        taskType: 'imageInference',
        taskUUID: crypto.randomUUID(),
        model: this.model,
        positivePrompt: els.prompt.value.trim(),
        width: size.width,
        height: size.height,
        numberResults: Number(els.numImages.value) || 1,
        outputType: 'URL',
        outputFormat: RUNWARE_FORMATS[els.outputFormat.value] ?? 'PNG',
        includeCost: true, // 事前の目安を出せないので、実額を結果に添える
        // 同期で受け取ると生成のあいだ接続を掴んだままになる。他のプロバイダと
        // 同じく投入 → ポーリングにそろえる（タブを閉じても再開できる）
        deliveryMethod: 'async',
        // 画像はトップレベルに置く。Playground のスキーマには inputs でまとめる
        // 形も載っているが、実際の API は「このモデルでは使えない」と弾く
        seedImage: dataUri,
        ...(maskUri ? { maskImage: maskUri } : {}),
      };
      if (els.seedLock.checked && els.seed.value !== '') task.seed = Number(els.seed.value);
      // 空欄はキーごと落としてモデル既定に任せる（0 も有効な値なので長さで見る）
      if (els.rwSteps.value !== '') task.steps = Number(els.rwSteps.value);
      if (els.rwCfg.value !== '') task.CFGScale = Number(els.rwCfg.value);
      // True CFG は 1 以下だと働かない（＝内蔵ガイダンスのまま）ので、その場合は送らない
      if (els.rwTrueCfg.value !== '' && Number(els.rwTrueCfg.value) > 1) {
        task.trueCFGScale = Number(els.rwTrueCfg.value);
      }
      if (els.rwStrength.value !== '') task.strength = Number(els.rwStrength.value);
      if (els.rwMaskMargin.value !== '') task.maskMargin = Number(els.rwMaskMargin.value);
      if (els.rwScheduler.value) task.scheduler = els.rwScheduler.value;
      if (els.rwPromptWeighting.checked) task.promptWeighting = 'sdEmbeds';
      // 出力品質は非可逆な形式のときだけ意味がある
      if (els.rwOutputQuality.value !== '' && task.outputFormat !== 'PNG') {
        task.outputQuality = Number(els.rwOutputQuality.value);
      }
      // negativePrompt は 2 文字未満だと弾かれる。空欄でも公式作例と同じ既定を
      //（True CFG は対になる negative prompt があって初めて効く）
      const negative = els.negativePrompt.value.trim();
      task.negativePrompt = negative.length >= 2 ? negative : RUNWARE_RECOMMENDED.negativePrompt;
      const loras = collectRwLoras();
      if (loras.length > 0) task.lora = loras;
      return task;
    },

    strip(input) {
      return { ...input, seedImage: undefined, maskImage: undefined };
    },

    async submit(input) {
      await runwareTasks(input);
      return { taskUUID: input.taskUUID, count: input.numberResults, items: [] };
    },

    async poll(handle) {
      const data = await runwareTasks({ taskType: 'getResponse', taskUUID: handle.taskUUID });
      // 同じ結果が二度返っても増えないよう、画像単位で覚えておく
      const found = new Map((handle.items ?? []).map((i) => [i.imageUUID ?? i.imageURL, i]));
      for (const item of data) {
        if (item.imageURL) found.set(item.imageUUID ?? item.imageURL, item);
      }
      handle.items = [...found.values()];
      if (handle.items.length >= handle.count) return { done: true, result: handle.items };
      const progress = data.map((d) => d.progress).find((v) => Number.isFinite(v));
      return {
        done: false,
        text: Number.isFinite(progress) ? `編集中… ${progress}%`
          : handle.items.length > 0 ? `編集中…（${handle.items.length}/${handle.count} 枚）` : '編集中…',
      };
    },

    parse(items) {
      return {
        images: items.map((i) => ({ url: i.imageURL })).filter((i) => i.url),
        seed: items.find((i) => Number.isFinite(i.seed))?.seed ?? null,
        // safety.checkContent を送っていないので基本は付かないが、来たら数える
        flagged: items.filter((i) => i.NSFWContent === true).length,
        cost: items.reduce((sum, i) => sum + (Number(i.cost) || 0), 0) || null,
      };
    },

    costHint() {
      const size = sendSize();
      if (!size) return '';
      return `出力 ${size.width}×${size.height} × ${els.numImages.value} 枚`
        + ' ・ 費用は生成後に実額を表示します';
    },
  },
};

let providerId = 'fal';

function provider() {
  return PROVIDERS[providerId] ?? PROVIDERS.fal;
}

// どのプロバイダも Worker のプロキシ経由で呼ぶ（API キーをブラウザに置かない）
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
      // fal は detail、WaveSpeed は message、Runware は errors[].message
      const raw = body.detail ?? body.message
        ?? body.errors?.map((e) => e.message || e.code).filter(Boolean).join(' / ')
        ?? body;
      detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
    } catch { /* JSON でなければそのまま出す */ }
    throw new Error(detail);
  }
  return res.json();
}

// Runware にタスクを 1 つ投げて data 配列を返す。HTTP 200 でも errors に
// 失敗が入ることがあるので、ここで例外に変える
async function runwareTasks(task) {
  const res = await proxyFetch('runware', RUNWARE_API_URL, {
    method: 'POST',
    body: JSON.stringify([task]),
  });
  const errors = res.errors ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message || e.code).filter(Boolean).join(' / ') || 'Runware がエラーを返しました');
  }
  return res.data ?? [];
}

// マスクの扱いはプロバイダで意味が変わる。塗る前に違いが分かるようにしておく
const MASK_MODE_HINTS = {
  composite: 'モデルには画像全体を渡し、返ってきた画像の塗った範囲だけを元画像に重ねます。塗り直しは編集し直さなくても反映されます。',
  native: 'このモデルは塗った範囲そのものを描き直します。マスクは送信内容の一部なので、範囲を変えたら編集し直してください（重ね合わせだけは後からでも変わります）。',
};

// プロバイダが対応していない項目は隠す。data-only は空白区切りで複数書ける
function syncProviderFields() {
  for (const el of document.querySelectorAll('[data-only]')) {
    el.hidden = !el.dataset.only.split(/\s+/).includes(providerId);
  }
  const api = provider();
  els.providerHint.textContent = api.note;
  // 共用の欄なので、値は書き換えず「空欄のときに何が送られるか」だけ見せる
  els.negativePrompt.placeholder = api.defaultNegative ? '空欄なら下の既定を送ります' : '空欄で未指定';
  els.negativeHint.hidden = !api.defaultNegative;
  els.negativeHint.textContent = api.defaultNegative
    ? `空欄のときは「${api.defaultNegative}」を送ります（True CFG は対になる negative prompt があって初めて効くため）。`
    : '';
  els.maskModeHint.textContent = MASK_MODE_HINTS[api.nativeMask ? 'native' : 'composite'];
  // マスク前提のモデルでは切れないようにする（切ると送るものが無くなる）
  els.maskToggle.disabled = !!api.requiresMask;
  els.maskToggle.title = api.requiresMask
    ? 'このモデルはマスクした範囲を描き直すモデルなので、マスクは外せません' : '';
  if (api.requiresMask) els.maskToggle.checked = true;
  renderSizeOptions();
  renderRunwareParamHint();
  syncMaskUi();
  renderSizeHint();
  syncRunBtn(); // 費用の目安もここで出し直す
}

// 公式作例と同じ設定に戻す
function applyRunwareRecommended() {
  els.rwSteps.value = String(RUNWARE_RECOMMENDED.steps);
  els.rwCfg.value = String(RUNWARE_RECOMMENDED.cfg);
  els.rwTrueCfg.value = String(RUNWARE_RECOMMENDED.trueCfg);
  els.rwStrength.value = String(RUNWARE_RECOMMENDED.strength);
  els.rwMaskGrow.value = String(RUNWARE_RECOMMENDED.maskGrow);
  els.rwPadEdges.value = String(RUNWARE_RECOMMENDED.padEdges);
  els.rwMaskMargin.value = String(RUNWARE_RECOMMENDED.maskMargin);
  els.rwScheduler.value = '';
  els.rwPromptWeighting.checked = false;
}

// 今の値が推奨から外れていたら、その場で理由を出す
function renderRunwareParamHint() {
  if (providerId !== 'runware') return;
  const notes = [];
  const cfg = els.rwCfg.value === '' ? null : Number(els.rwCfg.value);
  const trueCfg = els.rwTrueCfg.value === '' ? null : Number(els.rwTrueCfg.value);
  if (cfg === null || cfg > 1.5) {
    notes.push('CFG はこのモデルでは 1 が前提です（素の FLUX.1 Fill とは違います）');
  }
  if (trueCfg === null || trueCfg <= 1) {
    notes.push('True CFG を 4 前後にしないと、指示文がほとんど効きません');
  } else if (trueCfg > 6) {
    notes.push('True CFG が 6 を超えると画質が落ちやすくなります');
  }
  const strength = els.rwStrength.value === '' ? null : Number(els.rwStrength.value);
  if (strength === null || strength < 1) {
    notes.push('変化の強さが 1 未満だと、塗った範囲にも元画像が残ります（空欄のときの既定は 0.8）');
  }
  if (els.rwMaskMargin.value === '') {
    notes.push('余白を 32〜64 にすると、狭い範囲を塗ったときの精細さが上がります');
  }
  if ((Number(els.rwMaskGrow.value) || 0) === 0) {
    notes.push('塗った縁に元画像が残るときは「広げる」を 16 前後にしてください');
  }
  const padEdges = Number(els.rwPadEdges.value) || 0;
  const margin = Number(els.rwMaskMargin.value) || 0;
  if (padEdges === 0) {
    notes.push('画像の縁まで塗るときは「縁の余白」を入れてください（余白より広く）');
  } else if (margin > 0 && padEdges <= margin) {
    notes.push(`「縁の余白」は「余白」（${margin}）より広くしてください`);
  }
  const base = trueCfg > 1
    ? 'True CFG は 1 ステップに 2 回推論するので、生成時間は倍近くになります（費用も上がることがあります）。'
    : '';
  els.rwParamHint.textContent = notes.length > 0
    ? `${notes.join('。')}。「推奨値に戻す」で公式の作例どおりになります。`
    : `公式の作例と同じ設定です。${base}`;
  els.rwParamHint.classList.toggle('warn', notes.length > 0);
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

  // 送るのはここで作る縮小版。元画像は合成の土台として R2 に残っている
  const size = sendSize();
  const api = provider();
  // 塗った範囲は「モデルへ渡すマスク」と「返ってきた画像の合成」の両方に使う。
  // 渡せないプロバイダでは合成だけで同じ見た目に寄せる
  const useMask = maskOn() && mask.strokes.length > 0;
  const grow = api.maskGrow ? api.maskGrow() : 0;

  // マスクが画像の縁に近い辺は、単色で広げてから送る（返ってきたら切り出す）。
  // 広げる必要が無ければ frame は null で、これまで通り素の枠で送る
  const frame = useMask && api.nativeMask && api.padEdges
    ? padFrame(size, mask, grow, api.padEdges()) : null;
  const outer = frame ? frame.outer : size;
  const inner = frame ? frame.inner : { x: 0, y: 0, width: size.width, height: size.height };

  let dataUri;
  try {
    const img = await sourceImageEl();
    dataUri = frame ? framedDataUri(img, outer, inner) : toDataUri(img, size).dataUri;
  } catch (err) {
    setRunning(false);
    setStatus('');
    setError(`入力画像を用意できませんでした: ${err.message}`);
    return;
  }

  // モデルには少し広めのマスクを渡す。修復モデルは輪郭のすぐ内側に元画像を
  // 引きずりやすい（潜在空間では 8px 角がひと単位なので、境目はどうしても
  // 混ざる）。広げたぶんは合成で捨てるので、出来上がりの範囲は変わらない
  const maskUri = useMask && api.nativeMask ? maskDataUri(outer, inner, mask, grow) : null;
  const input = api.buildInput(dataUri, outer, maskUri);
  const job = {
    id: makeId(),
    provider: providerId,
    model: api.model,
    startedAt: Date.now(),
    prompt,
    sourceUrl: source.url,
    // 元画像と、実際に送った大きさ。合成は元解像度で行うので両方残す
    sourceSize: { width: source.width, height: source.height },
    sentSize: outer,
    // 余白を足して送った場合の、元画像が入っている範囲。合成のときに切り出す
    crop: frame ? inner : null,
    // 送信内容のうち、履歴と再開に必要な分だけ控える（画像本体は持たない）
    params: api.strip(input),
    // 履歴・ギャラリー側は { path, scale } で読むので、Runware の
    // { model, weight } もその形に寄せる（path には AIR が入る）
    loras: input.loras ?? (input.lora ?? []).map((l) => ({ path: l.model, scale: l.weight })),
    // 合成はモデルの応答が返ったあとに行うので、そのときのマスクを控えておく
    mask: useMask ? structuredClone(mask) : null,
    // マスクを API にも渡したか（後から塗り直しても描き直しはやり直せない）
    maskNative: !!maskUri,
    // 出力がずれて返るモデルでは、重ねる前に位置を合わせる
    alignEnabled: useMask && !!api.alignOutput && els.alignToggle.checked,
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

  const { images, seed, flagged, cost } = api.parse(poll.result);
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
    // プロバイダが実額を返すときだけ入る（fal / WaveSpeed は返らない）
    ...(cost ? { cost } : {}),
    ...(job.maskNative ? { maskNative: true } : {}),
    ...(job.crop ? { crop: job.crop } : {}),
    ...(job.alignEnabled ? { alignEnabled: true } : {}),
    sourceSize: job.sourceSize ?? null,
    sentSize: job.sentSize ?? null,
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
  // 既に合成済みなら先頭 n 枚が前回の合成、その後ろが生成結果そのまま
  const previous = record.masked ? record.images.slice(0, n) : []; // 差し替え先
  const tail = record.masked ? record.images.slice(n) : record.images; // [生成結果 …, 入力]

  // 合成には画素が要るので、外部 CDN のままの画像はここで R2 へ取り込む。
  // 取り込んだ URL はレコードにも残す（CDN の失効後も塗り直せるように）
  for (const img of tail) {
    if (!isSameOrigin(img.url)) img.url = await captureImage(img.url);
  }

  const inputUrl = tail.at(-1).url;
  const raws = tail.slice(0, n);
  const composites = [];
  // ずれは 1 枚につき 1 度だけ測り、記録に残す（塗り直しでは測り直さない）
  const offsets = [...(record.align ?? [])];
  for (const [i, raw] of raws.entries()) {
    const want = offsets[i] === undefined && record.alignEnabled ? 'auto' : (offsets[i] ?? null);
    if (want === 'auto') setStatus('ずれを測っています…');
    const { dataUri, width, height, offset } = await compositeFromUrls(
      inputUrl, raw.url, maskData, record.crop ?? null, want,
    );
    offsets[i] = offset ?? null;
    const url = await uploadDataUri(
      dataUri,
      { app: 'fal playground', source: 'imgedit-masked', model: record.model, prompt: record.prompt },
      previous[i]?.url ?? null,
    );
    composites.push({ url, width, height });
  }
  return {
    ...record,
    masked: true,
    mask: maskData,
    ...(record.alignEnabled ? { align: offsets } : {}),
    images: [...composites, ...tail],
  };
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

// 位置合わせの結果。ずれていなかったことも分かるようにしておく
function alignMetaText(record) {
  if (!record.alignEnabled) return '';
  const found = (record.align ?? []).filter(Boolean);
  if (found.length === 0) return ' ・ ずれ無し';
  const shown = found[0];
  return ` ・ ずれ補正 ${shown.dx > 0 ? '+' : ''}${shown.dx}, ${shown.dy > 0 ? '+' : ''}${shown.dy} px`
    + (found.length > 1 ? ' ほか' : '');
}

function renderResult(record) {
  shownResult = record;
  els.resultPanel.hidden = false;
  els.resultMeta.textContent = `${record.elapsed} 秒`
    + (record.seed !== null && record.seed !== undefined ? ` ・ seed ${record.seed}` : '')
    + (record.sentSize ? ` ・ 送信 ${record.sentSize.width}×${record.sentSize.height}` : '')
    + (record.masked && record.sourceSize
      ? ` ・ 合成 ${record.sourceSize.width}×${record.sourceSize.height}` : '')
    + (record.cost ? ` ・ $${Number(record.cost).toFixed(4)}` : '')
    + alignMetaText(record);
  els.resultMaskHint.hidden = !record.masked;
  // マスクをモデルにも渡した場合、塗り直しで変わるのは重ね合わせだけ
  els.resultMaskHint.textContent = record.maskNative
    ? 'このモデルにはマスクも渡しています。ここで塗り直すと重ね合わせ方だけが変わります（描き直す範囲を変えるには編集し直してください）。'
    : 'マスクは後からでも変えられます。上の「入力画像」で塗り直すと、この結果に即座に反映されます（作り直しは不要です）。';
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
      const { dataUri } = await compositeFromUrls(
        inputUrl, raw.url, current, record.crop ?? null, record.align?.[i] ?? null,
      );
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
    rwSteps: els.rwSteps.value,
    rwCfg: els.rwCfg.value,
    rwTrueCfg: els.rwTrueCfg.value,
    rwStrength: els.rwStrength.value,
    rwMaskGrow: els.rwMaskGrow.value,
    rwPadEdges: els.rwPadEdges.value,
    align: els.alignToggle.checked,
    rwMaskMargin: els.rwMaskMargin.value,
    rwScheduler: els.rwScheduler.value,
    rwOutputQuality: els.rwOutputQuality.value,
    rwPromptWeighting: els.rwPromptWeighting.checked,
    rwDefaults: RW_DEFAULTS_VERSION,
    outputFormat: els.outputFormat.value,
    seed: els.seed.value,
    seedLock: els.seedLock.checked,
    negativePrompt: els.negativePrompt.value,
    loras: collectLoras(),
    rwLoras: rwLoraRows(),
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
  // サイズの選択肢はプロバイダで変わるので、先に並べ直してから値を戻す
  renderSizeOptions();
  if (s.size) els.sizeSelect.value = migrateSizeValue(s.size);
  if (s.numImages) els.numImages.value = s.numImages;
  if (s.steps) els.steps.value = s.steps;
  if (s.guidance) els.guidance.value = s.guidance;
  if (s.acceleration) els.acceleration.value = s.acceleration;
  els.rwSteps.value = s.rwSteps ?? '';
  els.rwCfg.value = s.rwCfg ?? '';
  els.rwTrueCfg.value = s.rwTrueCfg ?? '';
  els.rwStrength.value = s.rwStrength ?? '';
  els.rwMaskGrow.value = s.rwMaskGrow ?? '';
  els.rwPadEdges.value = s.rwPadEdges ?? '';
  els.rwMaskMargin.value = s.rwMaskMargin ?? '';
  els.rwScheduler.value = s.rwScheduler ?? '';
  els.rwOutputQuality.value = s.rwOutputQuality ?? '';
  els.rwPromptWeighting.checked = !!s.rwPromptWeighting;
  // 推奨値を入れる前の下書きは、モデル既定任せ（空欄）のままになっている。
  // それだと指示文がほとんど効かないので、一度だけ推奨値に入れ替える
  if ((s.rwDefaults ?? 0) < RW_DEFAULTS_VERSION) applyRunwareRecommended();
  if (s.outputFormat) els.outputFormat.value = s.outputFormat;
  els.seed.value = s.seed || '';
  els.seedLock.checked = !!s.seedLock;
  els.negativePrompt.value = s.negativePrompt || '';
  for (const l of s.loras || []) addLoraRow(l.path, l.scale);
  for (const l of s.rwLoras || []) addRwLoraRow(l.air, l.weight);
  els.maskToggle.checked = !!s.maskOn;
  els.alignToggle.checked = s.align !== false;
  if (s.maskSize) els.maskSize.value = s.maskSize;
  if (s.maskFeather) els.maskFeather.value = s.maskFeather;
  if (Array.isArray(s.mask?.strokes)) mask = s.mask;
  syncProviderFields();
  syncRunBtn();
  if (s.source?.url) await setSourceFromSrc(s.source.url, s.source.from || 'history', { keepMask: true });
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

// Runware の LoRA（AIR）の控えと取り込みダイアログ。API は画像編集側の
// プロキシ経由の呼び出しをそのまま使ってもらう
runwareLora.init({
  request: (task) => runwareTasks(task),
  architecture: PROVIDERS.runware.loraArchitecture,
  architectureLabel: PROVIDERS.runware.loraArchitectureLabel,
  // ダイアログで選ばれたら、そのまま使う行に足す。入らなければ false を返す
  onPick(item) {
    const rows = [...els.rwLoraList.querySelectorAll('.lora-row')];
    if (rows.some((row) => row.querySelector('.lora-select').value === item.air)) return true;
    if (rows.length >= MAX_LORAS) return false;
    addRwLoraRow(item.air);
    saveForm();
    return true;
  },
});
runwareLora.onChange = () => {
  syncRwAddLoraBtn();
  for (const row of els.rwLoraList.querySelectorAll('.lora-row')) refreshRwRowOptions(row);
};


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
els.rwAddLoraBtn.addEventListener('click', () => addRwLoraRow());
els.rwPickLoraBtn.addEventListener('click', () => runwareLora.open());
els.prompt.addEventListener('input', () => { syncRunBtn(); saveForm(); });
for (const el of [els.sizeSelect, els.numImages, els.steps, els.guidance,
  els.acceleration, els.outputFormat, els.seed, els.seedLock, els.negativePrompt,
  els.rwSteps, els.rwCfg, els.rwTrueCfg, els.rwStrength, els.rwMaskMargin,
  els.rwMaskGrow, els.rwPadEdges, els.rwScheduler, els.rwOutputQuality,
  els.rwPromptWeighting]) {
  el.addEventListener('change', saveForm);
}
// 推奨から外れたらその場で理由を出す
for (const el of [els.rwSteps, els.rwCfg, els.rwTrueCfg, els.rwStrength,
  els.rwMaskMargin, els.rwMaskGrow, els.rwPadEdges]) {
  el.addEventListener('input', renderRunwareParamHint);
}
// 広げ幅と縁の余白は、何をどの大きさで送るかを変える
for (const el of [els.rwMaskGrow, els.rwPadEdges]) {
  el.addEventListener('input', renderSizeHint);
}
els.rwPresetBtn.addEventListener('click', () => {
  applyRunwareRecommended();
  renderRunwareParamHint();
  saveForm();
});
// 用途ごとの定型文。指示文の内容ごと置き換える（このモデルは定型が前提）
for (const btn of document.querySelectorAll('[data-rwprompt]')) {
  btn.addEventListener('click', () => {
    els.prompt.value = btn.dataset.rwprompt;
    syncRunBtn();
    saveForm();
  });
}
// 送信サイズと枚数は費用の目安に効く。送信サイズは何をどう送るかの説明も更新する
els.numImages.addEventListener('change', renderCostHint);
els.sizeSelect.addEventListener('change', () => {
  renderCostHint();
  renderSizeHint();
});

/* ---------- マスクの操作 ---------- */

els.maskToggle.addEventListener('change', () => {
  syncMaskUi();
  syncRunBtn();
  renderSizeHint(); // 引き伸ばしたときに元の比率へ戻るかどうかが変わる
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

els.alignToggle.addEventListener('change', saveForm);
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

for (const name of RUNWARE_SCHEDULERS) {
  const opt = document.createElement('option');
  opt.value = name === 'Default' ? '' : name;
  opt.textContent = name === 'Default' ? '自動（モデル既定）' : name;
  els.rwScheduler.appendChild(opt);
}

syncAddLoraBtn();
syncRwAddLoraBtn();
// 下書きが無い（初回）ときも推奨値から始める
applyRunwareRecommended();
syncProviderFields();
restoreForm();
fetchHistory().then(resumeJob);
