'use strict';

/* ---------- constants ---------- */

// Modal 自前ホスト版 Krea 2（modal_comfy リポジトリ）。fal ではなく
// Worker のプロキシ（/api/krea2/generate）経由で生成する。
// エンドポイントは実験版（exp）・GPU スナップショット版（gpusnap）・本番・
// チェックポイント指定版（ckpt）・統合版（wan）の 5 系統があり、標準は実験版
const MODAL_KREA2_EXP_ID = 'modal/krea2-turbo-exp';
const MODAL_KREA2_GPUSNAP_ID = 'modal/krea2-turbo-gpusnap';
const MODAL_KREA2_ID = 'modal/krea2-turbo';
const MODAL_KREA2_CKPT_ID = 'modal/krea2-turbo-ckpt';
// 統合版（modal_comfy の wan_vace_app）。画像編集（Wan2.2 + VACE）と同じコンテナを
// 共有するので、どちらかが動いていればもう一方もウォームで始められる
const MODAL_KREA2_WAN_ID = 'modal/krea2-turbo-wan';
// LanPaint 版（modal_comfy の lanpaint_app）。画像編集の「LanPaint インペイント」と
// 同じコンテナを共有する。統合版（wan）とは別コンテナなので、編集で LanPaint を
// 使うならこちらで生成するとコンテナが 1 つで済む
const MODAL_KREA2_LANPAINT_ID = 'modal/krea2-turbo-lanpaint';

const MODELS = [
  { id: 'fal-ai/krea-2/turbo/lora', name: 'Krea 2 [turbo] LoRA', sizeParam: 'image_size', lora: true, loraBase: 'krea2', maxLoras: 3 },
  { id: MODAL_KREA2_EXP_ID, name: 'Krea 2 [turbo] 自前ホスト（Modal 実験版）', sizeParam: 'image_size', lora: true, loraBase: 'krea2', provider: 'modal', modalEndpoint: 'exp' },
  { id: MODAL_KREA2_GPUSNAP_ID, name: 'Krea 2 [turbo] 自前ホスト（Modal GPUスナップ版）', sizeParam: 'image_size', lora: true, loraBase: 'krea2', provider: 'modal', modalEndpoint: 'gpusnap' },
  { id: MODAL_KREA2_ID, name: 'Krea 2 [turbo] 自前ホスト（Modal 本番）', sizeParam: 'image_size', lora: true, loraBase: 'krea2', provider: 'modal', modalEndpoint: 'prod' },
  // ckpt: Modal Volume 内のチェックポイント（UNet）を生成ごとに指定できる版
  { id: MODAL_KREA2_CKPT_ID, name: 'Krea 2 [turbo] 自前ホスト（Modal チェックポイント指定版）', sizeParam: 'image_size', lora: true, loraBase: 'krea2', provider: 'modal', modalEndpoint: 'ckpt', ckpt: true },
  // wan: 画像編集（Wan2.2 + VACE）と同居する統合版。チェックポイント指定に加え、
  // サンプラー・スケジューラ・denoise も受け付ける
  { id: MODAL_KREA2_WAN_ID, name: 'Krea 2 [turbo] 自前ホスト（Modal 統合版・編集と共有）', sizeParam: 'image_size', lora: true, loraBase: 'krea2', provider: 'modal', modalEndpoint: 'wan', ckpt: true, sampler: true },
  // lanpaint: 画像編集の「LanPaint インペイント」と同居する版。API は統合版と同じ
  { id: MODAL_KREA2_LANPAINT_ID, name: 'Krea 2 [turbo] 自前ホスト（Modal LanPaint 版・インペイントと共有）', sizeParam: 'image_size', lora: true, loraBase: 'krea2', provider: 'modal', modalEndpoint: 'lanpaint', ckpt: true, sampler: true },
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
const LS_LORAS = 'fal_lora_library';
const LS_CKPTS = 'fal_ckpt_library'; // Modal チェックポイント指定版のライブラリ
const LS_ARENA = 'fal_arena'; // 比較アリーナ（arena.js）のデータ。同期のためここでも扱う
const LS_FORM = 'fal_form_state';
const LS_JOB = 'fal_active_job';
const LORA_URL_OPTION = '__url__';
const POLL_INTERVAL_MS = 900;

// Modal チェックポイント指定版の既定チェックポイント（modal_comfy の UNET_FILE）
const DEFAULT_CKPT_NAME = 'Krea-2-Turbo-Q8_0.gguf';

/* ---------- helpers ---------- */

const $ = (sel) => document.querySelector(sel);

// モバイルレイアウト判定（style.css のブレークポイントと合わせる）
const MOBILE_MQ = window.matchMedia('(max-width: 430px)');

const els = {
  statsDialog: $('#statsDialog'),
  statsBody: $('#statsBody'),
  modelSelect: $('#modelSelect'),
  customModelField: $('#customModelField'),
  customModel: $('#customModel'),
  ckptField: $('#ckptField'),
  ckptSelect: $('#ckptSelect'),
  ckptPath: $('#ckptPath'),
  ckptUnregBtn: $('#ckptUnregBtn'),
  ckptHfBtn: $('#ckptHfBtn'),
  ckptCivitaiBtn: $('#ckptCivitaiBtn'),
  prompt: $('#prompt'),
  loraField: $('#loraField'),
  loraLabel: $('#loraLabel'),
  loraList: $('#loraList'),
  addLoraBtn: $('#addLoraBtn'),
  loraFilterHint: $('#loraFilterHint'),
  hfOpenBtn: $('#hfOpenBtn'),
  civitaiOpenBtn: $('#civitaiOpenBtn'),
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
  seedLock: $('#seedLock'),
  steps: $('#steps'),
  guidance: $('#guidance'),
  wanSamplerRow: $('#wanSamplerRow'),
  samplerName: $('#samplerName'),
  scheduler: $('#scheduler'),
  denoise: $('#denoise'),
  generateBtn: $('#generateBtn'),
  jobList: $('#jobList'),
  jobHint: $('#jobHint'),
  error: $('#error'),
  detail: $('#detail'),
  gallery: $('#gallery'),
  gallerySearch: $('#gallerySearch'),
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

// サーバーへ保存中（POST 応答待ち）のレコード ID と、保存が完了した時刻。
// 一覧の応答に含まれない可能性がある間、上書きから守る
const pendingHistorySaves = new Set();
const historySavedAt = new Map();

// このセッションで削除済みのレコード ID。保存応答による復活を防ぐ
const deletedHistoryIds = new Set();

function loadHistory() {
  return historyCache;
}

// 表示キャッシュに残す件数。全部入れると localStorage の 5MB に届き、
// ほかの保存（生成中のジョブの控えなど）まで巻き添えで書けなくなる。
// 正はサーバーなので、開いた直後にギャラリーを描ける分だけあればいい
const HISTORY_CACHE_MAX = 60;

// キャッシュ用に軽くしたレコード。マスクのストロークは 1 件で数十 KB になる
// ことがあり、塗り直しに使うのはサーバー側のレコードなので落とす
function historyCacheEntry(record) {
  if (!record.mask) return record;
  const { mask, ...rest } = record;
  return rest;
}

// サーバーから取り直せると分かっているか。移行前（サーバーへ送れていない
// ローカル履歴しかない）状態で間引くと、その記録が失われる
let historyIsServerBacked = !!falStore.get(LS_HISTORY_MIGRATED);

function persistHistoryCache() {
  const keep = historyIsServerBacked ? historyCache.slice(0, HISTORY_CACHE_MAX) : historyCache;
  // 容量超過などは無視（サーバー側が正なので失っても支障ない）
  falStore.set(LS_HISTORY, JSON.stringify(keep.map(historyCacheEntry)));
}

/* ---------- サーバーからの取得（ページ送り + 絞り込み） ----------
 *
 * 検索も統計もサーバー側へ移したので、履歴を全件手元に持つ必要は無くなった。
 * 手元にあるのは「いま見えているぶん」だけで、ギャラリーの末尾に着いたときに
 * 続きを足す。絞り込みが変われば先頭から取り直す。
 */
let historyCursor = null; // 次ページの位置（null なら続きは無い）
let historyQuery = ''; // サーバーへ投げている絞り込み
let historyLoading = false;

// 古い HTML だと history-feed.js が読まれておらず、ここだけが黙って失敗して
// 表示キャッシュのぶんしか出ない状態になる。読み直して直す
function historyFeedReady() {
  if (window.falHistory) return true;
  if (!falBoot.requireShared(['falHistory'])) {
    setError('アプリの読み込みが古いままです。ページを再読み込みしてください。');
  }
  return false;
}

// 先頭から取り直す（起動時・絞り込みが変わったとき・タブ復帰時）
async function reloadHistory() {
  if (!historyFeedReady() || historyLoading) return;
  historyLoading = true;
  const startedAt = Date.now();
  const q = historyQuery;
  try {
    const page = await falHistory.page({ q });
    if (!page.ok) {
      // 取れなかったことは知らせる。黙って手元のぶんを出すと、履歴が消えた
      // ようにしか見えない
      setError('履歴をサーバーから取得できませんでした（表示は手元のぶんだけです）。');
      return;
    }
    if (q !== historyQuery) return; // 待っている間に絞り込みが変わった

    // 旧バージョンのローカル履歴が残っていてサーバーが空なら、一度だけ取り込む
    if (!q && page.records.length === 0 && historyCache.length > 0
        && !falStore.get(LS_HISTORY_MIGRATED)) {
      falStore.set(LS_HISTORY_MIGRATED, '1');
      for (const record of [...historyCache].reverse()) {
        try {
          await fetch('/api/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record),
          });
        } catch {
          // 移行できなかった分は諦める（失効済みの画像など）
        }
      }
      historyLoading = false;
      return reloadHistory();
    }

    // タブ復帰時は、この取得と「復帰で再開したポーリングの完了 → 履歴保存」が
    // 競合する。保存中（POST 応答待ち）や、この取得の開始後に保存が完了した
    // レコードは応答に含まれないことがあり、丸ごと入れ替えるとギャラリーから
    // 消える。それらは手元のぶんを残してマージする（絞り込み中はしない）
    const onServer = new Set(page.records.map((r) => r.id));
    const keep = q ? [] : historyCache.filter(
      (r) => !onServer.has(r.id)
        && (pendingHistorySaves.has(r.id) || (historySavedAt.get(r.id) ?? 0) >= startedAt),
    );
    historyCache = [...keep, ...page.records];
    historyCursor = page.cursor;
    historyIsServerBacked = true; // ここから先は、消してもサーバーから戻せる
    if (!q) persistHistoryCache(); // 表示キャッシュは絞り込んでいないときのぶんだけ
    renderGallery();
  } finally {
    historyLoading = false;
  }
}

// ギャラリーの末尾まで並べ切ったときに、続きを足す
async function loadMoreHistory() {
  if (historyLoading || !historyCursor || !historyFeedReady()) return;
  historyLoading = true;
  const q = historyQuery;
  try {
    const page = await falHistory.page({ q, cursor: historyCursor });
    if (!page.ok || q !== historyQuery) return;
    historyCache = [...historyCache, ...page.records];
    historyCursor = page.cursor;
    renderGallery();
  } finally {
    historyLoading = false;
  }
}

// 生成完了時に呼ぶ。即座にローカルへ反映し、サーバーへは裏で保存する。
// fal の CDN 画像はサーバー側で失効しない URL に取り込まれるため、応答で差し替える
function addHistoryRecord(record) {
  historyCache.unshift(record);
  persistHistoryCache();
  pendingHistorySaves.add(record.id);
  (async () => {
    try {
      const res = await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
      if (!res.ok || isHtmlResponse(res)) return;
      const saved = await res.json();
      historySavedAt.set(saved.id, Date.now());
      const i = historyCache.findIndex((r) => r.id === saved.id);
      if (i !== -1) historyCache[i] = saved;
      // 保存中にサーバー取得の応答で上書きされて消えていたら先頭へ戻す
      else if (!deletedHistoryIds.has(saved.id)) historyCache.unshift(saved);
      persistHistoryCache();
      if (selectedId === saved.id) renderDetail(saved);
      else renderGallery();
    } catch {
      // オフライン時など。次回起動時のサーバー取得で整合する
    } finally {
      pendingHistorySaves.delete(record.id);
    }
  })();
}

function deleteHistoryRecord(id) {
  deletedHistoryIds.add(id);
  historyCache = historyCache.filter((r) => r.id !== id);
  persistHistoryCache();
  fetch(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

// 履歴の全消しは画面から外してある。ギャラリーの見出しに「すべて削除」を
// 置いていたが、検索欄のすぐ隣で、取り返しがつかない（サーバーの画像ごと消える）。
// 確認ダイアログがあっても押し間違いのほうが怖い。
// サーバー側の DELETE /api/history は残してあるので、必要になったらそこを叩く

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
  els.ckptField.hidden = !model.ckpt;
  els.loraField.hidden = !model.lora;

  // Modal 版は fal のキュー API を使わないため比較モード非対応
  const isModal = model.provider === 'modal';
  els.compareToggle.closest('.compare-toggle').hidden = isModal;

  // LoRA 非対応モデル・Modal 版では比較モードを使えないので強制的に解除
  if ((!model.lora || isModal) && compareMode) setCompareMode(false);

  // Modal 版のデフォルト値・範囲は API の仕様（INTEGRATION.md）に合わせて案内する
  els.steps.placeholder = isModal ? '8（変更非推奨）' : 'デフォルト';
  els.guidance.placeholder = isModal ? '1（0〜1）' : 'デフォルト';

  // サンプラー系は統合版だけが受け付ける
  els.wanSamplerRow.hidden = !model.sampler;

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

function addLoraRow(path = '', scale, listEl = els.loraList) {
  // 履歴の再利用などで未登録の URL が来たら自動登録する。
  // ベースモデルは今選んでいるモデルのものとして控える（候補の絞り込みに使う）
  if (path) registerLora(path, currentBaseMeta());
  // scale 未指定（新しい行）のときはライブラリの既定 scale を使う
  const initialPath = path || sortedLoraLibrary()[0]?.path || LORA_URL_OPTION;
  const effScale = scale ?? loraDefaultScale(initialPath);

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

  // トリガーワード（ライブラリに登録されていれば出す）とプロンプトへの挿入
  const trigger = document.createElement('div');
  trigger.className = 'lora-trigger';
  row.appendChild(trigger);

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
  slider.value = String(effScale);
  scaleWrap.appendChild(slider);

  const num = document.createElement('input');
  num.type = 'number';
  num.min = '0';
  num.max = '2';
  num.step = '0.05';
  num.value = String(effScale);
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

  populateLoraSelect(select, initialPath);
  // 選択を変えたら scale の初期値もその LoRA の既定に合わせる（手で動かす前だけ）
  select.addEventListener('change', () => {
    const def = loraDefaultScale(select.value);
    if (!row.dataset.scaleTouched) {
      slider.value = String(def);
      num.value = String(def);
    }
    syncLoraRow(row);
  });
  for (const input of [slider, num]) {
    input.addEventListener('input', () => { row.dataset.scaleTouched = '1'; });
  }

  // URL を入力したら自動登録して、その項目を選択状態にする
  pathInput.addEventListener('change', () => {
    const value = pathInput.value.trim();
    if (!value) return;
    registerLora(value, currentBaseMeta());
    populateLoraSelect(select, value);
    pathInput.value = '';
    syncLoraRow(row);
  });

  listEl.appendChild(row);
  syncLoraRow(row);
}

function loadLoraLibrary() {
  return loraLib.load();
}

function saveLoraLibrary(items) {
  loraLib.save(items);
}

const loraDisplayName = (path) => loraLib.fileName(path);
const loraLabel = (path) => loraLib.label(path);
const loraDefaultScale = (path) => loraLib.defaultScale(path);
const loraTriggerWords = (path) => loraLib.triggerWords(path);

function registerLora(path, meta = null) {
  loraLib.register(path, meta);
  refreshLoraSelects();
}

function unregisterLora(path) {
  loraLib.unregister(path);
  refreshLoraSelects();
}

// 新しく登録する LoRA に付けるベースモデル（今のモデル向けとして扱う）
function currentBaseMeta() {
  const kind = modelLoraBase();
  return kind ? { base: loraLib.baseLabel(kind) } : null;
}

// 選択中のモデルが使える LoRA だけを候補にする（Krea 2 用と Qwen 用が混ざらない）
function modelLoraBase() {
  return MODELS.find((m) => m.id === els.modelSelect.value)?.loraBase ?? null;
}

function sortedLoraLibrary() {
  return loraLib.forBase(modelLoraBase());
}

// 登録済み LoRA（表示名）+「URL を入力…」でプルダウンを構成する。
// 選択中のものが対象外（別のベースモデル）でも、選択が失われないよう候補に残す
function populateLoraSelect(select, selected) {
  select.innerHTML = '';
  const items = sortedLoraLibrary();
  const known = new Set(items.map((i) => i.path));
  if (selected && selected !== LORA_URL_OPTION && !known.has(selected) && loraLib.entry(selected)) {
    const opt = document.createElement('option');
    opt.value = selected;
    opt.textContent = `⚠ ${loraLabel(selected)}（このモデル向けではありません）`;
    opt.title = selected;
    select.appendChild(opt);
  }
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.path;
    opt.textContent = (item.fav ? '★ ' : '') + loraLabel(item.path);
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

// 別のベースモデル向けで隠した件数を知らせる（黙って消えると混乱するため）
function syncLoraFilterHint() {
  const want = modelLoraBase();
  const hidden = want ? loraLib.load().filter((i) => loraLib.baseKind(i.base) !== want).length : 0;
  els.loraFilterHint.hidden = hidden === 0;
  els.loraFilterHint.textContent = hidden === 0 ? ''
    : `${loraLib.baseLabel(want)} 以外の LoRA ${hidden} 件は候補から外しています（ベースモデルはライブラリ管理で直せます）`;
}

function refreshLoraSelects() {
  syncLoraFilterHint();
  // .lora-list 配下（共通 LoRA と比較モードの各試行）だけを対象にする。
  // チェックポイント欄の行はスタイル流用で .lora-row クラスを持つが、構造が
  // 違うためここで触ってはいけない（プルダウンの中身が壊れ、例外で落ちる）
  for (const row of document.querySelectorAll('.lora-list .lora-row')) {
    const select = row.querySelector('.lora-select');
    populateLoraSelect(select, select.value);
    syncLoraRow(row);
  }
}

function syncLoraRow(row) {
  const path = row.querySelector('.lora-select').value;
  const urlMode = path === LORA_URL_OPTION;
  row.querySelector('.lora-path').hidden = !urlMode;
  row.querySelector('.lora-unreg').hidden = urlMode;
  renderLoraTrigger(row, urlMode ? '' : path);
}

// 選択中の LoRA のトリガーワードと、プロンプトへ足すボタン
function renderLoraTrigger(row, path) {
  const box = row.querySelector('.lora-trigger');
  if (!box) return; // 比較モードの行など、トリガー欄を持たない構造には触らない
  box.innerHTML = '';
  const words = path ? loraTriggerWords(path) : [];
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
  btn.title = 'トリガーワードをプロンプトの末尾に追加します';
  btn.addEventListener('click', () => insertTriggerWords(words));
  box.appendChild(btn);
}

// プロンプト末尾にトリガーワードを足す。既に書かれている語は足さない
function insertTriggerWords(words) {
  const current = els.prompt.value;
  const lower = current.toLowerCase();
  const missing = words.filter((w) => !lower.includes(w.toLowerCase()));
  if (missing.length === 0) return;
  const sep = current.trim() === '' ? '' : (/[,、]\s*$/.test(current) ? ' ' : ', ');
  els.prompt.value = current + sep + missing.join(', ');
  els.prompt.dispatchEvent(new Event('input', { bubbles: true }));
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

/* ---------- checkpoint library (Modal チェックポイント指定版) ---------- */
// LoRA ライブラリと同じ考え方で、HF の resolve URL（または Volume 内のファイル名）を
// 登録しておき、生成時は checkpoint フィールドとして Modal API に渡す。
// URL 指定の場合、初回使用時に Modal 側が HF から Volume へ取り込んでキャッシュする

function loadCkptLibrary() {
  try {
    return JSON.parse(falStore.get(LS_CKPTS)) || [];
  } catch {
    return [];
  }
}

function saveCkptLibrary(items) {
  // 登録は失うと困るので、書けなかったことは黙って飲み込まない
  falStore.setOrThrow(LS_CKPTS, JSON.stringify(items));
  deviceSync.markDirty('ckpts');
}

// チェックポイントは .gguf / .safetensors の区別が重要なので拡張子ごと表示する
function ckptDisplayName(path) {
  const seg = path.split('?')[0].split('/').filter(Boolean).pop() || path;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function registerCkpt(path) {
  const library = loadCkptLibrary();
  if (!library.some((item) => item.path === path)) {
    library.push({ name: ckptDisplayName(path), path });
    saveCkptLibrary(library);
  }
  populateCkptSelect(els.ckptSelect.value);
}

function unregisterCkpt(path) {
  saveCkptLibrary(loadCkptLibrary().filter((item) => item.path !== path));
  populateCkptSelect(els.ckptSelect.value);
}

function sortedCkptLibrary() {
  return [...loadCkptLibrary()].sort((a, b) =>
    a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' }));
}

// 「既定」+ 登録済みチェックポイント + 「URL / ファイル名を入力…」でプルダウンを構成
function populateCkptSelect(selected) {
  const select = els.ckptSelect;
  const want = selected ?? '';
  select.innerHTML = '';
  const defOpt = document.createElement('option');
  defOpt.value = '';
  defOpt.textContent = `既定（${DEFAULT_CKPT_NAME}）`;
  select.appendChild(defOpt);
  for (const item of sortedCkptLibrary()) {
    const opt = document.createElement('option');
    opt.value = item.path;
    opt.textContent = item.name;
    opt.title = item.path;
    select.appendChild(opt);
  }
  const urlOpt = document.createElement('option');
  urlOpt.value = LORA_URL_OPTION;
  urlOpt.textContent = 'URL / ファイル名を入力…';
  select.appendChild(urlOpt);
  select.value = want;
  if (select.value !== want) select.value = ''; // 登録解除などで消えた項目は既定へ
  syncCkptRow();
}

function syncCkptRow() {
  const urlMode = els.ckptSelect.value === LORA_URL_OPTION;
  els.ckptPath.hidden = !urlMode;
  // 既定・直接入力では「登録解除」を出さない
  els.ckptUnregBtn.hidden = urlMode || els.ckptSelect.value === '';
}

// 生成に使うチェックポイント指定（空文字なら既定 = フィールド省略）
function selectedCkpt() {
  const v = els.ckptSelect.value;
  if (v === LORA_URL_OPTION) return els.ckptPath.value.trim();
  return v;
}

function initCkptField() {
  populateCkptSelect('');
  els.ckptSelect.addEventListener('change', syncCkptRow);

  // URL を入力したら自動登録して、その項目を選択状態にする
  //（素のファイル名は登録せずそのまま送る: Volume に既にあるものを指す用途）
  els.ckptPath.addEventListener('change', () => {
    const value = els.ckptPath.value.trim();
    if (!/^https:\/\//i.test(value)) return;
    registerCkpt(value);
    populateCkptSelect(value);
    els.ckptPath.value = '';
  });

  els.ckptUnregBtn.addEventListener('click', () => {
    const current = els.ckptSelect.value;
    if (current === '' || current === LORA_URL_OPTION) return;
    unregisterCkpt(current);
    populateCkptSelect('');
  });

}

/* ---------- Hugging Face bulk import ---------- */
// 公開リポジトリのモデルファイルを一覧表示し、選択したものをライブラリに
// 一括登録する。登録のみで、現在の LoRA 設定行には追加しない。
// LoRA モード（.safetensors → LoRA ライブラリ）とチェックポイントモード
// （.safetensors / .gguf → チェックポイントライブラリ）を兼ねる

// 既定のリポジトリ。ダイアログを開くたびにこの値へ戻す
const HF_DEFAULT_REPO = 'tottie2215/temp_str';
const HF_DEFAULT_CKPT_REPO = 'Abiray/Krea-2-Turbo-GGUF';

// HF からの一括登録（共有コンポーネント）。LoRA とチェックポイントで同じ
// ダイアログを使う。ベースモデルの初期選択は今のモデルに合わせる
function initHfDialog() {
  hfImport.init({
    defaultRepo: HF_DEFAULT_REPO,
    defaultCkptRepo: HF_DEFAULT_CKPT_REPO,
    currentBase: () => modelLoraBase() ?? 'krea2',
    registeredPaths: (kind) => (kind === 'ckpt' ? loadCkptLibrary() : loadLoraLibrary())
      .map((item) => item.path),
    register(kind, url, meta) {
      if (kind === 'ckpt') registerCkpt(url);
      else registerLora(url, meta);
    },
  });
  els.hfOpenBtn.addEventListener('click', () => hfImport.open('lora'));
  els.ckptHfBtn.addEventListener('click', () => hfImport.open('ckpt'));
}

/* ---------- 生成時間の統計 ---------- */
//
// 集計はサーバー側（GET /api/history/stats）。以前はここで全履歴を舐めていたが、
// そのために「履歴を全件手元に持つ」ことが前提になっていた。手順は worker.js へ
// そのまま移してあり（Modal の順次処理による待ち時間の補正も含む）、
// ここで受け取るのはモデルごとの集計だけなので、応答は件数に依らない。

function formatSec(s) {
  return s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : `${s.toFixed(1)}秒`;
}

// サーバーが刻んだヒストグラム（最小値・階級幅・度数）をそのまま描く
function renderStatsHistogram({ min, max, width, counts }) {
  const wrap = document.createElement('div');
  const peak = Math.max(...counts);

  const hist = document.createElement('div');
  hist.className = 'stats-hist';
  counts.forEach((c, i) => {
    const bin = document.createElement('div');
    bin.className = 'stats-bin';
    bin.title = `${formatSec(min + i * width)}〜${formatSec(min + (i + 1) * width)}: ${c} 件`;
    const bar = document.createElement('span');
    bar.style.height = c === 0 ? '0' : `${Math.max(6, (c / peak) * 100)}%`;
    bin.appendChild(bar);
    hist.appendChild(bin);
  });
  wrap.appendChild(hist);

  const axis = document.createElement('div');
  axis.className = 'stats-axis';
  const lo = document.createElement('span');
  lo.textContent = formatSec(min);
  const hi = document.createElement('span');
  hi.textContent = formatSec(max);
  axis.append(lo, hi);
  wrap.appendChild(axis);
  return wrap;
}

function statsMessage(text) {
  const empty = document.createElement('div');
  empty.className = 'stats-empty';
  empty.textContent = text;
  els.statsBody.appendChild(empty);
}

async function renderStats() {
  els.statsBody.innerHTML = '';
  statsMessage('集計中…');

  let stats = null;
  try {
    const res = await fetch('/api/history/stats');
    if (res.ok && !isHtmlResponse(res)) stats = await res.json().catch(() => null);
  } catch {
    // オフラインなど
  }
  els.statsBody.innerHTML = '';
  if (!stats) {
    statsMessage('統計を取得できませんでした');
    return;
  }

  // 表示順: モデル一覧の並び → それ以外（カスタムモデルなど）は名前順
  const ids = Object.keys(stats);
  const known = MODELS.map((m) => m.id).filter((id) => ids.includes(id));
  const others = ids.filter((id) => !known.includes(id)).sort();

  if (known.length + others.length === 0) {
    statsMessage('所要時間つきの生成履歴がまだありません');
    return;
  }

  for (const id of [...known, ...others]) {
    const stat = stats[id];

    const group = document.createElement('div');
    group.className = 'stats-group';

    const title = document.createElement('div');
    title.className = 'stats-title';
    title.textContent = MODELS.find((m) => m.id === id)?.name ?? id;
    group.appendChild(title);

    const nums = document.createElement('div');
    nums.className = 'stats-nums';
    const cell = (label, value) => {
      const el = document.createElement('span');
      el.append(`${label} `);
      const strong = document.createElement('strong');
      strong.textContent = value;
      el.appendChild(strong);
      return el;
    };
    nums.append(
      cell('平均', formatSec(stat.mean)),
      cell('中央値', formatSec(stat.median)),
      cell('最短', formatSec(stat.min)),
      cell('最長', formatSec(stat.max)),
      cell('件数', `${stat.n}`),
    );
    group.appendChild(nums);

    group.appendChild(renderStatsHistogram(stat));
    els.statsBody.appendChild(group);
  }
}

function openStats() {
  renderStats();
  renderSweepStats(); // 取れたら後から足す（統計の表示は待たせない）
  els.statsDialog.showModal();
}

function initStatsDialog() {
  // 統計はサイドバーの項目。この画面では直接開き、他の画面からは ./#stats で来る
  document.getElementById('statsNav').addEventListener('click', openStats);
  const openIfHash = () => {
    if (location.hash !== '#stats') return;
    // 閉じたあとに再読み込みしても開き直さないよう、ハッシュは消しておく
    history.replaceState(null, '', location.pathname + location.search);
    openStats();
  };
  openIfHash();
  window.addEventListener('hashchange', openIfHash);
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
  addLoraBtn.addEventListener('click', () => addLoraRow('', undefined, list));
  block.appendChild(addLoraBtn);

  els.variantList.appendChild(block);

  if (ownLoras.length > 0) {
    for (const l of ownLoras) addLoraRow(l.path, l.scale, list);
  } else if (addStarterRow) {
    addLoraRow('', undefined, list);
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

// 入力済みのシード値は「固定」チェックが入っているときだけ生成に使う
function lockedSeed() {
  if (!els.seedLock.checked || els.seed.value === '') return undefined;
  return Number(els.seed.value);
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
  const effSeed = seed ?? lockedSeed();
  if (effSeed !== undefined) input.seed = effSeed;
  if (els.steps.value !== '') input.num_inference_steps = Number(els.steps.value);
  if (els.guidance.value !== '') input.guidance_scale = Number(els.guidance.value);
  const effLoras = loras ?? (!els.loraField.hidden ? collectLoras() : []);
  if (effLoras.length > 0) input.loras = effLoras;
  return input;
}

/* ---------- generation ---------- */

// 生成中でも追加リクエストを送れるよう、実行中のジョブは複数を並行に扱う。
// 各ジョブが自分のステータス行・キャンセル・中断フラグ（job.cancelled）を持つ

let selectedId = null;

let jobSeq = 0;
function makeJid() {
  return `${Date.now()}_${++jobSeq}`;
}

// ジョブ行の DOM など実行時だけの状態。永続化データ（job）には含めない
const jobUI = new WeakMap();

// 実行中（未完了・未失敗）のジョブ。コールドスタート注記の表示判定に使う
const runningJobs = new Set();

// 行に ✕ ボタン（キャンセル / 閉じる）を付ける
function makeJobXBtn(title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'ghost-btn small job-x';
  btn.type = 'button';
  btn.textContent = '✕';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.addEventListener('click', onClick);
  return btn;
}

// 省略表示の全文をクリック / Enter で開閉できるようにする
//（ツールチップの出ないタッチ端末でも全文を確認できる）
function makeExpandable(el) {
  el.tabIndex = 0;
  el.addEventListener('click', () => {
    if (!getSelection().isCollapsed) return; // テキスト選択中は切り替えない
    el.classList.toggle('expanded');
    el.scrollIntoView({ block: 'nearest' });
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    el.classList.toggle('expanded');
  });
}

// Modal 版のコールドスタート注記は各行には出さず、実行中の間だけ共通で 1 行出す
function updateJobHint() {
  if (!els.jobHint) return;
  els.jobHint.hidden = ![...runningJobs].some((j) => j.kind === 'modal');
}

// 1 件 = 1 行: [スピナー + 状態] [プロンプト（省略表示）] [✕]
function startJobRow(job) {
  const row = document.createElement('div');
  row.className = 'job-row';

  const status = document.createElement('div');
  status.className = 'status';
  row.appendChild(status);

  const prompt = document.createElement('div');
  prompt.className = 'job-prompt';
  prompt.textContent = job.prompt || '';
  prompt.title = job.prompt || '';
  makeExpandable(prompt);
  row.appendChild(prompt);

  row.appendChild(makeJobXBtn('キャンセル', () => cancelJob(job)));

  els.jobList.appendChild(row);
  // リストがスクロール中でも、追加された行が見えるようにする
  row.scrollIntoView({ block: 'nearest' });
  jobUI.set(job, { row, status });
  runningJobs.add(job);
  updateJobHint();
}

function setJobStatus(job, text) {
  const ui = jobUI.get(job);
  if (ui) ui.status.textContent = text;
}

// 失敗したジョブは行をエラー表示に切り替えて、閉じるまで残す
function failJobRow(job, message) {
  runningJobs.delete(job);
  updateJobHint();
  const ui = jobUI.get(job);
  if (!ui) return;
  ui.row.innerHTML = '';

  const err = document.createElement('div');
  err.className = 'error';
  // どのリクエストのエラーか分かるようプロンプトも本文に含める（省略表示・クリックで全文）
  err.textContent = job.prompt ? `${message}「${job.prompt}」` : message;
  err.title = err.textContent;
  makeExpandable(err);
  ui.row.appendChild(err);

  ui.row.appendChild(makeJobXBtn('閉じる', () => endJobRow(job)));
  ui.row.scrollIntoView({ block: 'nearest' });
}

function endJobRow(job) {
  jobUI.get(job)?.row.remove();
  jobUI.delete(job);
  runningJobs.delete(job);
  updateJobHint();
}

// ジョブの中断。fal 側のキャンセル（待機中のみ有効）も試みるが、
// 失敗してもローカルでは必ずポーリングを打ち切る
async function cancelJob(job) {
  job.cancelled = true;
  // Modal 版はポーリングの打ち切りのみ（サーバー側で開始済みの生成は止まらない）
  if (job.kind === 'modal') return;
  const submitted = job.kind === 'single' ? job.submitted : job.current?.submitted;
  if (submitted?.cancel_url) {
    try {
      await falFetch(submitted.cancel_url, { method: 'PUT' });
    } catch {
      // 生成開始済みなどでキャンセルできなくても、ローカルの打ち切りは行う
    }
  }
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

// 保留中ジョブ（生成完了待ち）の永続化。再読み込み/クローズしても再開できる。
// 並行生成に対応するため配列で保存する（このタブの activeJobs が正）
let activeJobs = [];

function persistActiveJobs() {
  if (activeJobs.length === 0) falStore.remove(LS_JOB);
  else falStore.set(LS_JOB, JSON.stringify(activeJobs));
}

function loadActiveJobs() {
  try {
    const parsed = JSON.parse(falStore.get(LS_JOB));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && parsed.kind) return [parsed]; // 旧形式（単一ジョブ）からの移行
    return [];
  } catch {
    return [];
  }
}

function saveActiveJob(job) {
  const i = activeJobs.findIndex((j) => j.jid === job.jid);
  if (i === -1) activeJobs.push(job);
  else activeJobs[i] = job;
  persistActiveJobs();
}

function removeActiveJob(job) {
  activeJobs = activeJobs.filter((j) => j.jid !== job.jid);
  persistActiveJobs();
}

// リクエスト送信のみ（status_url / response_url を含む submitted を返す）
async function submitJob(modelId, input) {
  return falFetch(`https://queue.fal.run/${modelId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// 既に送信済みの submitted をポーリングし、完了したら画像を取得する
async function awaitJob(job, submitted, onProgress) {
  let status;
  do {
    await sleep(POLL_INTERVAL_MS);
    if (job.cancelled) throw new Error('キャンセルされました');
    status = await falFetch(submitted.status_url);
    if (onProgress) onProgress(status);
  } while (status.status !== 'COMPLETED');

  const result = await falFetch(submitted.response_url);
  const images = result.images || (result.image ? [result.image] : []);
  if (images.length === 0) throw new Error('画像が返されませんでした');

  return { requestId: submitted.request_id, images, seed: result.seed ?? null };
}

function pollStatusText(job, status, prefix = '') {
  const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(0);
  const phase = status.status === 'IN_QUEUE'
    ? (status.queue_position != null ? `待機中（${status.queue_position + 1} 番目）` : '待機中')
    : '生成中';
  setJobStatus(job, `${prefix}${phase}… ${elapsed}s`);
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

  const input = buildInput();
  const limit = modelLoraLimit();
  if ((input.loras?.length ?? 0) > limit) {
    setError(`LoRA はこのモデルでは最大 ${limit} 個までです（現在 ${input.loras.length} 個）`);
    return;
  }
  setError('');

  const job = { jid: makeJid(), kind: 'single', modelId, prompt, input, loras: input.loras ?? [], submitted: null, startedAt: Date.now() };
  startJobRow(job);
  setJobStatus(job, '送信中…');

  try {
    job.submitted = await submitJob(modelId, input);
    saveActiveJob(job);

    const r = await awaitJob(job, job.submitted, (status) => pollStatusText(job, status));
    finishSingle(job, r);
    endJobRow(job);
  } catch (err) {
    removeActiveJob(job);
    failJobRow(job, job.cancelled ? 'キャンセルされました' : `エラー: ${err.message}`);
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
  removeActiveJob(job);
}

/* ---------- Modal (自前ホスト Krea 2) generation ---------- */
// modal_comfy の Krea 2 Turbo API を Worker のプロキシ経由で呼ぶ。
// 生成はサーバー側（Durable Object）でジョブとして完結し、クライアントは
// /api/krea2/job/<id> を短い間隔でポーリングして結果を受け取る。
// 長い HTTP 接続を保持しないため、タブ休止や接続断でも結果を取りこぼさず、
// ページを再読み込みしても途中から再開できる。
// 呼び出しの認証には端末間同期と同じトークン（SYNC_TOKEN）を使う

const MODAL_TIMEOUT_MS = 300_000; // INTEGRATION.md 推奨: 300 秒以上
// チェックポイント指定時は初回に Modal 側で HF からの取り込み（10GB 超もありうる）が
// 走るため、Modal の関数タイムアウト（600 秒）+ 余裕まで待つ
const MODAL_CKPT_TIMEOUT_MS = 660_000;
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
  const seed = lockedSeed();
  if (seed !== undefined) input.seed = seed;
  if (els.steps.value !== '') input.steps = Number(els.steps.value);
  if (els.guidance.value !== '') input.cfg = Number(els.guidance.value);
  // 統合版だけの項目。空欄はキーごと落として API の既定に任せる
  if (!els.wanSamplerRow.hidden) {
    if (els.samplerName.value.trim() !== '') input.sampler_name = els.samplerName.value.trim();
    if (els.scheduler.value.trim() !== '') input.scheduler = els.scheduler.value.trim();
    if (els.denoise.value !== '') input.denoise = Number(els.denoise.value);
  }
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
async function modalAwaitJob(job, jobId) {
  const timeoutMs = job.input?.checkpoint ? MODAL_CKPT_TIMEOUT_MS : MODAL_TIMEOUT_MS;
  const pollStart = Date.now();
  while (true) {
    await sleep(MODAL_POLL_INTERVAL_MS);
    if (job.cancelled) throw new Error('キャンセルされました');

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

    // タイムアウト判定はポーリング結果を確認した後に行う（タブ休止からの復帰時、
    // 完了済みならタイムアウトにせず結果を採用できる）
    if (Date.now() - pollStart > timeoutMs) {
      throw new Error(`${timeoutMs / 1000} 秒以内に完了しませんでした。Modal ダッシュボードでアプリの状態を確認してください`);
    }
  }
}

async function generateModal(model, prompt) {
  const input = buildModalInput(prompt);
  // 実験版 / 本番などの切り替え。URL は Worker 側の許可リストで解決される
  input.endpoint = model.modalEndpoint;
  // チェックポイント指定版: 選択中のチェックポイント（HF URL または Volume 内の
  // ファイル名）を渡す（空なら既定）。存在しない指定はサーバーが 404 +
  // 利用可能一覧で返すのでここでは検証しない
  if (model.ckpt) {
    const ckpt = selectedCkpt();
    if (ckpt) input.checkpoint = ckpt;
  }
  if (input.cfg !== undefined && (input.cfg < 0 || input.cfg > 1)) {
    setError('この API のガイダンス（cfg）は 0〜1 の範囲で指定してください');
    return;
  }
  // この API の LoRA は名前でも HF の resolve URL でも指定できる。名前だけに落とすと
  // Volume と既定リポジトリ（tottie2215/temp_str）の直下にあるものしか解決できず、
  // 別のリポジトリから取り込んだ LoRA が 404 になるので、URL はそのまま渡す
  const loras = !els.loraField.hidden ? collectLoras() : [];
  if (loras.length > 0) {
    input.loras = loras.map((l) => ({ name: loraLib.modalRef(l.path), strength: l.scale }));
  }

  const count = Number(els.numImages.value);
  const job = {
    jid: makeJid(),
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

  startJobRow(job);
  setError('');
  try {
    saveActiveJob(job);
    await runModalJobFrom(job);
    endJobRow(job);
  } catch (err) {
    failJobRow(job, job.cancelled ? 'キャンセルされました' : `エラー: ${err.message}`);
    finishModal(job); // 途中まで生成できた分は履歴に残し、ジョブをクリアする
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
    setJobStatus(job, '送信中…');
    await modalSubmit(body);
    entry.submitted = true;
    saveActiveJob(job);
  }

  // 順番に完了を待つ
  for (let i = 0; i < total; i++) {
    const entry = job.entries[i];
    if (entry.result) continue;
    const prefix = total > 1 ? `${i + 1}/${total} ` : '';
    // 経過秒の表示はポーリング間隔（2 秒）とは独立に 1 秒ごとに更新する
    const tick = () => {
      const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(0);
      setJobStatus(job, `${prefix}生成中… ${elapsed}s`);
    };
    tick();
    const ticker = setInterval(tick, 1000);
    let r;
    try {
      r = await modalAwaitJob(job, entry.jobId);
    } finally {
      clearInterval(ticker);
    }
    entry.result = { url: r.url, seed: r.seed, elapsedMs: r.elapsedMs ?? null };
    saveActiveJob(job);
  }

  finishModal(job);
}

// 完了した分を履歴・結果表示に反映してジョブをクリアする（部分完了でも呼べる）
function finishModal(job) {
  removeActiveJob(job);
  const done = job.entries.filter((e) => e.result);
  if (done.length === 0) return;
  // サーバーが記録した実処理時間（DO のキュー待ちを含まない）。統計で使う。
  // elapsed（クライアント計測・待ち時間込み）は表示互換のためそのまま残す
  const procMs = done.map((e) => e.result.elapsedMs).filter((v) => Number.isFinite(v) && v > 0);
  const record = {
    id: `modal_${Date.now()}`,
    ts: Date.now(),
    model: job.modelId,
    prompt: job.prompt,
    input: job.input ?? null,
    loras: job.loras,
    seed: done[0].result.seed,
    elapsed: ((Date.now() - job.startedAt) / 1000).toFixed(1),
    ...(procMs.length > 0 ? { procMs } : {}),
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

  // 公平な比較のため全試行で同じ seed を使う（固定指定がなければランダムに決定）
  const runSeed = lockedSeed() ?? Math.floor(Math.random() * 4294967296);

  const job = {
    jid: makeJid(),
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

  startJobRow(job);
  setError('');

  try {
    await runCompareFrom(job);
    endJobRow(job);
  } catch (err) {
    removeActiveJob(job);
    failJobRow(job, job.cancelled ? 'キャンセルされました' : `エラー: ${err.message}`);
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
      const r = await awaitJob(job, submitted, (status) => pollStatusText(job, status, `試行 ${i + 1}/${total} `));
      job.results.push({ ownLoras: own, loras, images: r.images, seed: r.seed, elapsed: null, error: null });
    } catch (err) {
      // キャンセルは試行の失敗としてではなく比較全体の中断として扱う
      if (job.cancelled) throw err;
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
  removeActiveJob(job);
}

// 起動時: 保留中ジョブがあればポーリングを再開して完了させる
function resumeActiveJobs() {
  activeJobs = loadActiveJobs();
  persistActiveJobs(); // 旧形式（単一ジョブ）で保存されていた場合は配列に揃える
  for (const job of [...activeJobs]) resumeJob(job); // 各ジョブを並行に再開
}

async function resumeJob(job) {
  if (!job.jid) job.jid = makeJid(); // 旧形式のジョブには ID がない
  job.cancelled = false;
  startJobRow(job);
  setJobStatus(job, '再開中…');

  try {
    if (job.kind === 'single') {
      const r = await awaitJob(job, job.submitted, (status) => pollStatusText(job, status));
      finishSingle(job, r);
      endJobRow(job);
    } else if (job.kind === 'compare') {
      await runCompareFrom(job);
      endJobRow(job);
    } else if (job.kind === 'modal') {
      // Modal の生成はサーバー側で継続しているため、ポーリングを再開すれば
      // 離脱中に完了した分もそのまま受け取れる
      try {
        await runModalJobFrom(job);
        endJobRow(job);
      } catch (err) {
        failJobRow(job, `前回の生成の再開に失敗しました: ${err.message}`);
        finishModal(job); // 完了していた分は履歴に残す
      }
    } else {
      removeActiveJob(job);
      endJobRow(job);
    }
  } catch (err) {
    removeActiveJob(job);
    failJobRow(job, job.cancelled
      ? 'キャンセルされました'
      : `前回の生成の再開に失敗しました: ${err.message}`);
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
      seedMeta.addEventListener('click', () => {
        // シード単体の再利用は明示操作なので固定チェックも入れる
        els.seed.value = record.seed;
        els.seedLock.checked = true;
      });
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
    ? ` ・ LoRA: ${record.loras.map((l) => loraLabel(l.path)).join(', ')}`
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
    title.title = v.loras.map((l) => `${loraLabel(l.path)} (${l.scale})`).join(', ');
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

// 自分が配信している画像か（/api/krea2/image/... は旧 URL 互換）
const isStoredImage = (url) => typeof url === 'string' && /^\/api(\/krea2)?\/image\//.test(url);

// まだ取り込めていない画像（プロバイダの CDN の URL のまま）を持つ記録。
// 相手が消せばこちらからは失われるので、ギャラリーでひと目で分かるようにする
function hasExternalImage(record) {
  const lists = Array.isArray(record.variants)
    ? record.variants.map((v) => v.images ?? [])
    : [record.images ?? []];
  return lists.some((images) => images.some((img) => img?.url && !isStoredImage(img.url)));
}

function galleryThumbUrl(record) {
  if (record.type === 'compare') {
    return record.variants.find((v) => v.images?.length)?.images[0]?.url ?? '';
  }
  return record.images[0]?.url ?? '';
}

// いま並べている一覧。キー操作での前後移動もこれをたどる
let galleryItems = [];

function galleryEmpty(text) {
  galleryPager.clear();
  const empty = document.createElement('div');
  empty.className = 'gallery-empty';
  empty.textContent = text;
  els.gallery.appendChild(empty);
}

// 絞り込みはサーバー側（search 列への LIKE）でかかっているので、
// ここは受け取ったものをそのまま並べるだけ
function renderGallery() {
  const items = loadHistory();
  galleryItems = items;

  if (items.length === 0) {
    galleryEmpty(historyQuery ? '一致する履歴がありません' : 'まだ履歴はありません');
    galleryPager.setHasMore(false);
    return;
  }
  galleryPager.render(items);
  // 末尾まで並べ切ったら、続きを取りに行く合図を出す
  galleryPager.setHasMore(!!historyCursor);
}

// 履歴 1 件ぶんのカード
function galleryItemEl(record) {
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

  if (hasExternalImage(record)) {
    item.classList.add('external');
    const badge = document.createElement('span');
    badge.className = 'external-badge';
    badge.textContent = '未取り込み';
    badge.title = 'この記録の画像は、まだサーバーに取り込まれていません。'
      + '提供元の CDN が消すと失われます（しばらく使っていると裏で取り込まれます）。';
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
  return item;
}

const galleryPager = falGallery.create(els.gallery, galleryItemEl, { onNeedMore: loadMoreHistory });

// 詳細表示中に前後の履歴（ギャラリー）へ移動する。dir=+1 で右、-1 で左
function navigateGallery(dir) {
  const items = galleryItems;
  if (items.length === 0 || selectedId == null) return;
  const idx = items.findIndex((r) => r.id === selectedId);
  if (idx === -1) return;
  const next = idx + dir;
  if (next < 0 || next >= items.length) return;
  // ギャラリーは末尾が見えたぶんだけ足しているので、飛び先が未描画のことがある
  galleryPager.ensure(next);
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

  // チェックポイント指定版はチェックポイントも復元する（未登録の URL なら登録する）
  const recordCkpt = record.input?.checkpoint ?? '';
  if (recordCkpt && /^https:\/\//i.test(recordCkpt)) registerCkpt(recordCkpt);
  populateCkptSelect(recordCkpt);
  if (els.ckptSelect.value !== recordCkpt) {
    // ライブラリに無いファイル名指定は直接入力モードで復元する
    populateCkptSelect(recordCkpt ? LORA_URL_OPTION : '');
    els.ckptPath.value = recordCkpt;
    syncCkptRow();
  }

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
  // 設定の再利用では意図せず同じ画像が出続けないよう、シード固定は常にオフに戻す
  els.seedLock.checked = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
    ckptSelect: els.ckptSelect.value,
    ckptPath: els.ckptPath.value,
    prompt: els.prompt.value,
    size: els.sizeSelect.value,
    customWidth: els.customWidth.value,
    customHeight: els.customHeight.value,
    numImages: els.numImages.value,
    seed: els.seed.value,
    seedLock: els.seedLock.checked,
    samplerName: els.samplerName.value,
    scheduler: els.scheduler.value,
    denoise: els.denoise.value,
    steps: els.steps.value,
    guidance: els.guidance.value,
    compare: compareMode,
    common: serializeLoraList(els.loraList),
    variants: [...els.variantList.querySelectorAll('.variant')]
      .map((b) => serializeLoraList(b.querySelector('.variant-lora-list'))),
  };
  falStore.set(LS_FORM, JSON.stringify(state));
}

function restoreFormState() {
  let s;
  try { s = JSON.parse(falStore.get(LS_FORM)); } catch { s = null; }
  if (!s) return;

  if (s.model) els.modelSelect.value = s.model;
  els.customModel.value = s.customModel || '';
  populateCkptSelect(s.ckptSelect || '');
  els.ckptPath.value = s.ckptPath || '';
  syncCkptRow();
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
  els.seedLock.checked = !!s.seedLock;
  els.steps.value = s.steps || '';
  els.guidance.value = s.guidance || '';
  els.samplerName.value = s.samplerName || '';
  els.scheduler.value = s.scheduler || '';
  els.denoise.value = s.denoise || '';
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

// 端末間同期（共有モジュール）。他端末の変更が届いたら候補を作り直す
deviceSync.init({
  onRemote() {
    refreshLoraSelects();
    populateCkptSelect(els.ckptSelect.value);
  },
});

// LoRA ライブラリ（共有モジュール）。保存のたびに端末間同期へ知らせる
loraLib.onChange = () => deviceSync.markDirty('loras');
loraLib.migrate();

initHfDialog();
// Civitai 取り込み（共有モジュール）。LoRA とチェックポイントで同じダイアログを使う
civitaiImport.init({
  defaultRepo: HF_DEFAULT_REPO,
  register(kind, hfUrl, meta) {
    if (kind === 'ckpt') {
      registerCkpt(hfUrl);
      return `チェックポイントライブラリに登録しました: ${ckptDisplayName(hfUrl)}`;
    }
    registerLora(hfUrl, meta);
    return `LoRA ライブラリに登録しました: ${loraLabel(hfUrl)}`;
  },
});
els.civitaiOpenBtn.addEventListener('click', () => civitaiImport.open('lora'));
els.ckptCivitaiBtn.addEventListener('click', () => civitaiImport.open('ckpt'));
initStatsDialog();
initCkptField();
initForm();
restoreFormState();

// 履歴: まずローカルキャッシュで即描画し、サーバーの内容で置き換える
try {
  historyCache = JSON.parse(falStore.get(LS_HISTORY)) || [];
} catch {
  historyCache = [];
}
renderGallery();
reloadHistory();

// モバイルでは LoRA アコーディオンを畳んだ状態で開始する（PC は常時展開）
if (MOBILE_MQ.matches) els.loraField.open = false;

// モバイルの下部固定バーは実行中ジョブの件数で高さが変わるため、
// コンテンツが隠れないよう .layout の下余白をバーの実高さに合わせて更新する
{
  const generateArea = $('.generate-area');
  const layout = $('.layout');
  if (window.ResizeObserver && generateArea && layout) {
    new ResizeObserver(() => {
      layout.style.paddingBottom = MOBILE_MQ.matches
        ? `${generateArea.offsetHeight + 16}px`
        : '';
    }).observe(generateArea);
  }
}

// 起動時に他端末の変更（LoRA ライブラリ）を取り込む
deviceSync.pull();

// フォームの変更を localStorage に保存（入力のたび・離脱時）
document.addEventListener('input', scheduleSaveForm);
document.addEventListener('change', scheduleSaveForm);
window.addEventListener('pagehide', () => {
  saveFormState();
  // 送信待ちの同期があれば離脱前に送っておく
  deviceSync.flush(); // 送信待ちの同期があれば離脱前に送っておく
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveFormState();
  // タブに戻ってきたら他端末の変更（LoRA ライブラリ・履歴）を取り込む
  if (document.visibilityState === 'visible') {
    deviceSync.pull();
    reloadHistory();
  }
});

els.generateBtn.addEventListener('click', generate);
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

// ギャラリー検索：入力に応じてサムネを絞り込む（カラなら通常表示）。
// 入力欄は空欄時は小さく、入力が伸びるほど広がる。
function syncGallerySearchSize() {
  els.gallerySearch.size = Math.max(8, els.gallerySearch.value.length + 1);
}
// 絞り込みはサーバーへ投げるので、打つたびに投げないよう少し待つ
let gallerySearchTimer = null;
els.gallerySearch.addEventListener('input', () => {
  syncGallerySearchSize();
  clearTimeout(gallerySearchTimer);
  gallerySearchTimer = setTimeout(() => {
    const q = els.gallerySearch.value.trim();
    if (q === historyQuery) return;
    historyQuery = q;
    historyCursor = null;
    galleryPager.reset(); // 絞り込みが変われば、また先頭から
    reloadHistory();
  }, 250);
});
syncGallerySearchSize();

// Cmd/Ctrl + Enter で生成（生成中でも追加リクエストを送れる）
els.prompt.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate();
});

// 前回の生成が完了待ちのまま離脱していたら再開する
resumeActiveJobs();

// Civitai 取り込みが進行中のまま離脱していたらポーリングを再開する
//（完了時の LoRA 登録はダイアログを開いていなくても行われる）
