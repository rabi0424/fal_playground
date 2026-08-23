'use strict';

/* ==========================================================================
 * Runware の LoRA ライブラリ（共有コンポーネント）
 *
 * Runware は LoRA を URL ではなく AIR（provider:model@version という独自の
 * 識別子）で指定する。Civitai のモデルは civitai:<modelId>@<versionId> で
 * そのまま参照できるが、civitai.red のようなミラーや自前のモデルは参照できず、
 * 一度 Runware 側へ登録して AIR を発行してもらう必要がある。
 *
 * このファイルが持つのは 2 つ:
 *
 * 1. 使う AIR のローカルな控え（localStorage の 'fal_runware_loras'）。
 *    行のプルダウンに出す表示名・既定 weight・トリガーワードの保存先で、
 *    LoRA ライブラリ（lora-library.js）の Runware 版にあたる。識別子が URL では
 *    なく AIR なので、あちらとは別の入れ物にしている
 *
 * 2. LoRA を用意するダイアログ。3 つの入り口がある:
 *    - 登録済みから探す: modelSearch。過去に自分でアップロードしたモデル
 *      （visibility: owned）も、公開モデルも同じ経路で拾える
 *    - Civitai から: civitai.com のモデルは civitai:モデルID@バージョンID で
 *      そのまま参照できるので、URL から AIR を組み立てて実在を確かめるだけ。
 *      アップロードは要らない
 *    - Hugging Face から: modelUpload で Runware 側に取り込んで AIR を発行する。
 *      civitai.red や自前のモデルはこちら（先に既存の Civitai 取り込みで HF へ
 *      上げてから、その URL をここに渡す）
 *
 * API の呼び出しそのものは持たず、使う側から注入してもらう（画像編集画面は
 * Worker のプロキシ経由で呼ぶので、その作法をここに複製したくない）:
 *
 *   runwareLora.init({
 *     request: (task) => runwareTasks(task),  // data 配列を返す
 *     architecture: 'flux1d',                 // 既定の絞り込み
 *     architectureLabel: 'FLUX.1 dev',
 *   });
 *   button.addEventListener('click', () => runwareLora.open());
 * ========================================================================== */

(() => {

const LS_RW_LORAS = 'fal_runware_loras';

const SEARCH_LIMIT = 50;

const LS_AIR_NAMESPACE = 'fal_runware_air_ns'; // 自分で登録するモデルの AIR 名前空間
const DEFAULT_NAMESPACE = 'myloras';

// modelUpload は「検証 → ダウンロード → 最適化 → 保存 → 完了」と進む。
// WebSocket なら途中経過が流れてくるが、REST では getResponse で追う
const UPLOAD_POLL_MS = 3000;
const UPLOAD_MAX_POLLS = 200; // 約 10 分
const UPLOAD_PHASES = {
  validated: '検証しました',
  downloaded: 'ダウンロードしました',
  optimized: '最適化しました',
  stored: '保存しました',
  ready: '登録できました',
};

// LoRA のアーキテクチャ。他にもあるので入力欄は自由入力（候補として出すだけ）
const ARCHITECTURES = [
  'flux1d', 'flux1s', 'flux2klein_4b', 'flux2klein_9b',
  'sdxl', 'sd1x', 'sd3', 'pony', 'illustrious',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIALOG_HTML = `
<dialog id="rwLoraDialog" class="key-dialog rwlora-dialog">
  <form method="dialog" class="key-form">
    <h2>Runware の LoRA を用意する</h2>

    <div class="seg" role="group" aria-label="取り込み方法">
      <button type="button" class="seg-btn active" data-rwtab="search">登録済みから探す</button>
      <button type="button" class="seg-btn" data-rwtab="civitai">Civitai から</button>
      <button type="button" class="seg-btn" data-rwtab="hf">Hugging Face から</button>
    </div>

    <!-- 登録済みを検索する -->
    <div data-rwpane="search">
      <p class="hint">Runware に登録済みのモデルを検索します。「自分のモデル」には、これまでにアップロードしたものが出ます。</p>
      <div class="row">
        <label class="field">
          <span class="label">対象</span>
          <select id="rwLoraVisibility">
            <option value="owned">自分のモデル</option>
            <option value="private">非公開のもの</option>
            <option value="favorite">お気に入り</option>
            <option value="public">公開モデル全体</option>
          </select>
        </label>
        <label class="field">
          <span class="label">キーワード（空欄で一覧）</span>
          <input id="rwLoraSearch" type="search" spellcheck="false" autocomplete="off" placeholder="名前・説明・AIR">
        </label>
      </div>
      <label class="civitai-meta-check" id="rwLoraArchWrap" hidden>
        <input type="checkbox" id="rwLoraArch" checked> このモデルで使えるもの（<span id="rwLoraArchName"></span>）だけにする
      </label>
      <div class="rwlora-bar">
        <button id="rwLoraSearchBtn" class="ghost-btn" type="button">検索</button>
        <span class="hint" id="rwLoraCount"></span>
      </div>
      <div id="rwLoraResults" class="rwlora-results"></div>
      <details class="field rwlora-manual">
        <summary class="label">AIR を直接指定する</summary>
        <div class="civitai-search">
          <input id="rwLoraAirInput" type="text" placeholder="例: civitai:1234@5678" spellcheck="false" autocomplete="off">
          <button id="rwLoraAirBtn" class="ghost-btn" type="button">追加</button>
        </div>
        <p class="hint">検索に出てこない AIR（provider:model@version）をそのまま控えに入れます。</p>
      </details>
    </div>

    <!-- Civitai の URL から AIR を組み立てる -->
    <div data-rwpane="civitai" hidden>
      <p class="hint">civitai.com のモデルは、Runware が <code>civitai:モデルID@バージョンID</code> でそのまま参照できます。アップロードは要りません。</p>
      <div class="civitai-search">
        <input id="rwCivUrl" type="text" placeholder="https://civitai.com/models/...?modelVersionId=..." spellcheck="false" autocomplete="off">
        <button id="rwCivCheckBtn" class="ghost-btn" type="button">確認</button>
      </div>
      <div id="rwCivPreview" class="civitai-preview" hidden></div>
      <div class="rwlora-bar">
        <button id="rwCivAddBtn" class="primary-btn" type="button" hidden>この LoRA を使う</button>
      </div>
      <p class="hint">civitai.red などのミラーや、Runware に無いモデルはこの方法では参照できません。その場合は「Civitai から取り込み」で Hugging Face へ上げてから、「Hugging Face から」で登録してください。</p>
    </div>

    <!-- Hugging Face の URL を Runware へ取り込む -->
    <div data-rwpane="hf" hidden>
      <p class="hint">Hugging Face に置いた .safetensors を Runware へ取り込んで AIR を発行します。<strong>Runware がダウンロードするので、公開アクセスできる URL である必要があります。</strong></p>
      <label class="field">
        <span class="label">登録するファイル</span>
        <select id="rwHfPick"></select>
      </label>
      <label class="field">
        <span class="label">URL</span>
        <input id="rwHfUrl" type="text" placeholder="https://huggingface.co/owner/repo/resolve/main/foo.safetensors" spellcheck="false" autocomplete="off">
      </label>
      <div class="row">
        <label class="field">
          <span class="label">名前</span>
          <input id="rwUpName" type="text" spellcheck="false">
        </label>
        <label class="field">
          <span class="label">アーキテクチャ</span>
          <input id="rwUpArch" type="text" list="rwArchList" spellcheck="false" autocomplete="off">
          <datalist id="rwArchList"></datalist>
        </label>
      </div>
      <p class="hint" id="rwUpBaseHint" hidden></p>
      <div class="row">
        <label class="field num-field">
          <span class="label">既定 weight</span>
          <input id="rwUpWeight" type="number" min="-4" max="4" step="0.05" value="1">
        </label>
        <label class="field">
          <span class="label">トリガーワード（カンマ区切り）</span>
          <input id="rwUpTrigger" type="text" spellcheck="false">
        </label>
      </div>
      <label class="field">
        <span class="label">AIR（自動生成・変更できます）</span>
        <input id="rwUpAir" type="text" spellcheck="false" autocomplete="off">
      </label>
      <div class="rwlora-bar">
        <button id="rwUpBtn" class="primary-btn" type="button">Runware に登録する</button>
        <span class="hint" id="rwUpPhase"></span>
      </div>
      <p class="hint">登録には数分かかることがあります。途中で閉じても Runware 側の処理は続くので、あとで「登録済みから探す」で拾えます。</p>
    </div>

    <div id="rwLoraStatus" class="status" hidden></div>
    <div id="rwLoraError" class="error" hidden></div>

    <div class="key-actions">
      <button value="cancel" class="ghost-btn" formnovalidate>閉じる</button>
    </div>
  </form>
</dialog>`;


let opts = { request: null, architecture: '', architectureLabel: '', onPick: null };
let els = null;
let onChange = null;

/* ---------- 控え（localStorage） ---------- */

function load() {
  try {
    const items = JSON.parse(localStorage.getItem(LS_RW_LORAS));
    return Array.isArray(items) ? items.filter((i) => i && typeof i.air === 'string') : [];
  } catch {
    return [];
  }
}

function save(items) {
  localStorage.setItem(LS_RW_LORAS, JSON.stringify(items));
  onChange?.();
}

function entry(air) {
  return load().find((item) => item.air === air) ?? null;
}

function labelOf(item) {
  return item?.name?.trim() || item?.air || '';
}

function label(air) {
  return labelOf(entry(air)) || air;
}

function defaultWeight(air) {
  const weight = entry(air)?.weight;
  return Number.isFinite(weight) ? weight : 1;
}

function triggerWords(air) {
  return String(entry(air)?.trigger ?? '').split(',').map((w) => w.trim()).filter(Boolean);
}

function sorted(items = load()) {
  return [...items].sort((a, b) => labelOf(a).localeCompare(labelOf(b), 'ja', { numeric: true, sensitivity: 'base' }));
}

// 同じ AIR は上書きする（検索し直したときに名前やトリガーワードが新しくなる）
function register(model) {
  const air = String(model?.air ?? '').trim();
  if (!air) return null;
  const items = load();
  const before = items.find((i) => i.air === air);
  const item = {
    ...before,
    air,
    name: model.name ?? before?.name ?? air,
    architecture: model.architecture ?? before?.architecture ?? '',
    trigger: model.trigger ?? before?.trigger ?? '',
    private: model.private ?? before?.private ?? false,
    ...(Number.isFinite(model.weight) ? { weight: model.weight } : {}),
    addedAt: before?.addedAt ?? Date.now(),
  };
  save([...items.filter((i) => i.air !== air), item]);
  return item;
}

function unregister(air) {
  save(load().filter((item) => item.air !== air));
}

/* ---------- 検索 ---------- */

// AIR は provider:model@version。urn:air:… の長い表記で貼られることもあるので、
// その場合は末尾の provider:model@version だけを取り出す
function normalizeAir(raw) {
  const text = String(raw ?? '').trim();
  const urn = text.match(/^urn:air:[^:]*:[^:]*:(.+)$/i);
  const air = (urn ? urn[1] : text).trim();
  return /^[\w.-]+:[\w./-]+@[\w.-]+$/.test(air) ? air : null;
}

// modelSearch の応答は「1 タスク = 1 エントリで results を持つ」形が基本だが、
// モデルが data に直接並ぶ形もありうるので、どちらでも読めるようにしておく
function readSearchData(data) {
  const wrapper = data.find((d) => Array.isArray(d.results));
  const items = wrapper ? wrapper.results : data.filter((d) => d?.air);
  return { items, total: wrapper?.totalResults ?? items.length };
}

function toEntry(model) {
  return {
    air: model.air,
    name: model.name || model.air,
    architecture: model.architecture || '',
    // 応答のキーは positiveTriggerWords。配列で来ることもある
    trigger: Array.isArray(model.positiveTriggerWords)
      ? model.positiveTriggerWords.join(', ')
      : String(model.positiveTriggerWords ?? ''),
    private: !!model.private,
    ...(Number.isFinite(model.defaultWeight) ? { weight: model.defaultWeight } : {}),
    heroImage: model.heroImage || '',
    comment: model.shortDescription || model.comment || '',
  };
}

async function search({ query = '', visibility = 'owned', architecture = '' } = {}) {
  if (!opts.request) throw new Error('Runware API の呼び出しが設定されていません');
  const data = await opts.request({
    taskType: 'modelSearch',
    taskUUID: crypto.randomUUID(),
    category: 'lora',
    visibility,
    limit: SEARCH_LIMIT,
    offset: 0,
    ...(query ? { search: query } : {}),
    ...(architecture ? { architecture } : {}),
  });
  const { items, total } = readSearchData(data);
  return { items: items.map(toEntry), total };
}

/* ---------- 取り込み（Civitai の AIR / Hugging Face からのアップロード） ---------- */

function namespace() {
  const saved = localStorage.getItem(LS_AIR_NAMESPACE) || '';
  return /^[\w.-]+$/.test(saved) ? saved : DEFAULT_NAMESPACE;
}

async function hashHex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 同じファイルを二度登録しても同じ AIR になるよう、URL から決める。
// 衝突したら Runware 側がエラーを返すので、そのときは手で書き換えてもらう
async function suggestAir(downloadUrl) {
  const hash = await hashHex(downloadUrl);
  const id = parseInt(hash.slice(0, 8), 16) % 1_000_000_000;
  return { air: `${namespace()}:${id}@1`, uniqueIdentifier: hash.slice(0, 32) };
}

// Runware に取り込む。REST では途中経過が流れてこないので getResponse で追う
async function uploadModel(payload, onPhase) {
  if (!opts.request) throw new Error('Runware API の呼び出しが設定されていません');
  const taskUUID = crypto.randomUUID();
  const first = await opts.request({ taskType: 'modelUpload', taskUUID, ...payload });
  const finished = (items) => items.find((d) => d.status === 'ready' || (d.air && !d.status));
  const failed = (items) => items.find((d) => ['error', 'failed'].includes(d.status));

  let done = finished(first);
  if (done) return done;
  onPhase?.(first.find((d) => d.status) ?? null);

  for (let i = 0; i < UPLOAD_MAX_POLLS; i++) {
    await sleep(UPLOAD_POLL_MS);
    const items = await opts.request({ taskType: 'getResponse', taskUUID });
    const bad = failed(items);
    if (bad) throw new Error(bad.message || '取り込みに失敗しました');
    done = finished(items);
    if (done) return done;
    onPhase?.(items.find((d) => d.status) ?? null);
  }
  throw new Error('完了を確認できませんでした（Runware 側では続いている可能性があります。'
    + 'しばらくしてから「登録済みから探す」で確認してください）');
}

// Civitai のモデルページ URL から、Runware が参照できる AIR を組み立てる。
// 実在するかは modelSearch で確かめる（Runware に無いモデルもある）
async function resolveCivitai(rawUrl) {
  const res = await fetch(`/api/civitai/resolve?url=${encodeURIComponent(rawUrl)}`);
  if (!res.ok || (res.headers.get('Content-Type') || '').includes('text/html')) {
    throw new Error((await res.text().catch(() => '')).slice(0, 200) || `HTTP ${res.status}`);
  }
  const meta = await res.json();
  if (!meta.modelId || !meta.versionId) {
    throw new Error('モデル ID を特定できませんでした（モデルページの URL を貼ってください）');
  }
  const air = `civitai:${meta.modelId}@${meta.versionId}`;
  let found = null;
  try {
    const { items } = await search({ query: air, visibility: 'public' });
    found = items.find((i) => i.air === air) ?? null;
  } catch {
    found = null; // 検索に失敗しても AIR は提示する（使えるかは実行してみれば分かる）
  }
  return { meta, air, found };
}

/* ---------- ダイアログ ---------- */

function setStatus(text, done = false) {
  els.status.hidden = !text;
  els.status.textContent = text || '';
  els.status.classList.toggle('done', !!text && done);
}

function setError(text) {
  els.error.hidden = !text;
  els.error.textContent = text || '';
}

function renderResults(items) {
  els.results.innerHTML = '';
  const known = new Set(load().map((i) => i.air));
  for (const model of items) {
    const row = document.createElement('div');
    row.className = 'rwlora-item';

    const body = document.createElement('div');
    body.className = 'rwlora-item-body';

    const name = document.createElement('div');
    name.className = 'rwlora-item-name';
    name.textContent = model.name;
    body.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'rwlora-item-meta';
    meta.textContent = [model.air, model.architecture, model.private ? '非公開' : '']
      .filter(Boolean).join(' ・ ');
    body.appendChild(meta);

    if (model.trigger) {
      const trigger = document.createElement('div');
      trigger.className = 'rwlora-item-trigger';
      trigger.textContent = `トリガー: ${model.trigger}`;
      body.appendChild(trigger);
    }
    row.appendChild(body);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost-btn small';
    btn.textContent = known.has(model.air) ? '登録済み・使う' : '使う';
    btn.addEventListener('click', () => {
      const item = register(model);
      known.add(model.air);
      btn.textContent = '登録済み・使う';
      // 控えに入れるだけでなく、そのまま行に足す（探した理由はたいてい使うため）
      const added = opts.onPick?.(item);
      setStatus(added === false
        ? `候補に入れました（行が上限なので追加はしていません）: ${model.name}`
        : `使う LoRA に追加しました: ${model.name}`, true);
    });
    row.appendChild(btn);

    els.results.appendChild(row);
  }
}

let searchRun = 0;

async function runSearch() {
  const run = ++searchRun;
  setError('');
  setStatus('検索中…');
  els.count.textContent = '';
  const architecture = els.archWrap.hidden || !els.arch.checked ? '' : opts.architecture;
  try {
    const { items, total } = await search({
      query: els.search.value.trim(),
      visibility: els.visibility.value,
      architecture,
    });
    if (run !== searchRun) return; // もっと新しい検索が走っている
    renderResults(items);
    setStatus('');
    els.count.textContent = items.length === 0
      ? '見つかりませんでした'
      : `${items.length} 件${total > items.length ? `（全 ${total} 件のうち）` : ''}`;
    if (items.length === 0 && architecture) {
      els.count.textContent += ' ・ 絞り込みを外すと増えるかもしれません';
    }
  } catch (err) {
    if (run !== searchRun) return;
    setStatus('');
    els.results.innerHTML = '';
    setError(`検索に失敗しました: ${err.message}`);
  }
}

async function addManualAir() {
  setError('');
  const air = normalizeAir(els.airInput.value);
  if (!air) {
    setError('AIR は provider:model@version の形で指定してください（例: civitai:1234@5678）');
    return;
  }
  const item = register({ air, name: air, architecture: '' });
  els.airInput.value = '';
  const added = opts.onPick?.(item);
  await runSearch(); // 一覧の「登録済み」表示を作り直す
  // 検索の途中経過で消えてしまうので、結果が出そろってから伝える
  setStatus(added === false
    ? `候補に入れました（行が上限なので追加はしていません）: ${air}`
    : `使う LoRA に追加しました: ${air}`, true);
}

/* ---------- Civitai タブ ---------- */

let civitaiPick = null; // 確認できた { air, name, ... }

function renderCivitaiPreview({ meta, air, found }) {
  const rows = [
    ['モデル', meta.modelName || '(不明)'],
    ['バージョン', meta.versionName || '(不明)'],
    ['種別', [meta.modelType, meta.baseModel].filter(Boolean).join(' / ') || '(不明)'],
    ['AIR', air],
    ['Runware', found ? `あります（${found.architecture || 'アーキテクチャ不明'}）` : '見つかりませんでした'],
  ];
  els.civPreview.innerHTML = '';
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'civitai-row';
    const key = document.createElement('span');
    key.className = 'civitai-row-label';
    key.textContent = label;
    row.append(key, document.createTextNode(value));
    els.civPreview.appendChild(row);
  }
  if (!found) {
    const note = document.createElement('p');
    note.className = 'civitai-note warn';
    note.textContent = 'Runware 側にこのモデルが無いようです。そのまま使うと失敗する可能性があります。'
      + '確実に使うには、「Civitai から取り込み」で Hugging Face へ上げてから「Hugging Face から」で登録してください。';
    els.civPreview.appendChild(note);
  }
  els.civPreview.hidden = false;
}

async function checkCivitai() {
  setError('');
  civitaiPick = null;
  els.civAddBtn.hidden = true;
  els.civPreview.hidden = true;
  const raw = els.civUrl.value.trim();
  if (!raw) return;
  setStatus('Civitai を確認中…');
  try {
    const result = await resolveCivitai(raw);
    renderCivitaiPreview(result);
    civitaiPick = {
      air: result.air,
      name: result.found?.name || result.meta.modelName || result.air,
      architecture: result.found?.architecture || '',
      trigger: result.found?.trigger || '',
      ...(Number.isFinite(result.found?.weight) ? { weight: result.found.weight } : {}),
    };
    els.civAddBtn.hidden = false;
    setStatus('');
  } catch (err) {
    setStatus('');
    setError(`確認できませんでした: ${err.message}`);
  }
}

function addCivitaiPick() {
  if (!civitaiPick) return;
  const item = register(civitaiPick);
  const added = opts.onPick?.(item);
  setStatus(added === false
    ? `候補に入れました（行が上限なので追加はしていません）: ${item.name}`
    : `使う LoRA に追加しました: ${item.name}`, true);
}

/* ---------- Hugging Face タブ ---------- */

const MANUAL_URL = '__manual__';

// 取り込み元の候補。既存の LoRA ライブラリ（HF の URL）をそのまま使えるようにする
function renderHfPicker() {
  const library = window.loraLib?.sorted?.() ?? [];
  els.hfPick.innerHTML = '';
  for (const item of library) {
    const opt = document.createElement('option');
    opt.value = item.path;
    opt.textContent = window.loraLib.labelOf(item);
    opt.title = item.path;
    els.hfPick.appendChild(opt);
  }
  const manual = document.createElement('option');
  manual.value = MANUAL_URL;
  manual.textContent = 'URL を直接入力する';
  els.hfPick.appendChild(manual);
  els.hfPick.value = library.length > 0 ? library[0].path : MANUAL_URL;
  applyHfPick();
}

// ライブラリから選んだら、名前・トリガーワード・weight をそのまま初期値にする
function applyHfPick() {
  const value = els.hfPick.value;
  let base = '';
  if (value === MANUAL_URL) {
    els.hfUrl.value = '';
    els.upName.value = '';
    els.upTrigger.value = '';
    els.upWeight.value = '1';
  } else {
    const item = window.loraLib?.entry?.(value) ?? null;
    els.hfUrl.value = value;
    els.upName.value = window.loraLib?.labelOf?.(item) ?? '';
    els.upTrigger.value = item?.trigger ?? '';
    els.upWeight.value = String(Number.isFinite(item?.scale) ? item.scale : 1);
    base = item?.base ?? '';
  }
  // ライブラリのベースモデルとアーキテクチャの指定が食い違っていると、
  // 取り込めても生成で効かない。判断できるように控えの記録を出しておく
  els.upBaseHint.hidden = !base;
  els.upBaseHint.textContent = base
    ? `ライブラリでのベースモデルは「${base}」です。アーキテクチャはこれに合うものを指定してください`
      + `（FLUX.1 dev 系なら flux1d）。合っていないと、取り込めても生成では効きません。`
    : '';
  refreshSuggestedAir();
}

let airRun = 0;

async function refreshSuggestedAir() {
  const run = ++airRun;
  const url = els.hfUrl.value.trim();
  if (!url) {
    els.upAir.value = '';
    return;
  }
  const { air } = await suggestAir(url);
  if (run !== airRun) return;
  els.upAir.value = air;
}

async function runUpload() {
  setError('');
  const downloadURL = els.hfUrl.value.trim();
  const air = normalizeAir(els.upAir.value);
  const name = els.upName.value.trim();
  const architecture = els.upArch.value.trim();
  if (!/^https:\/\/\S+$/.test(downloadURL)) {
    setError('取り込み元は https の URL で指定してください');
    return;
  }
  if (!air) {
    setError('AIR は provider:model@version の形で指定してください');
    return;
  }
  if (!name) {
    setError('名前を入れてください');
    return;
  }
  if (!architecture) {
    setError('アーキテクチャを指定してください（FLUX.1 dev 系の LoRA なら flux1d）');
    return;
  }

  const trigger = els.upTrigger.value.trim();
  const weight = Number(els.upWeight.value);
  const { uniqueIdentifier } = await suggestAir(downloadURL);
  els.upBtn.disabled = true;
  setStatus('Runware に登録しています…');
  try {
    const result = await uploadModel({
      air,
      name,
      downloadURL,
      uniqueIdentifier,
      version: air.split('@')[1] || '1',
      format: 'safetensors',
      category: 'lora',
      architecture,
      private: true,
      ...(trigger ? { positiveTriggerWords: trigger } : {}),
      ...(Number.isFinite(weight) ? { defaultWeight: weight } : {}),
    }, (phase) => {
      els.upPhase.textContent = phase
        ? (UPLOAD_PHASES[phase.status] ?? phase.status) + (phase.message ? `（${phase.message}）` : '')
        : '';
    });
    const item = register({
      air: result.air || air,
      name,
      architecture,
      trigger,
      private: true,
      ...(Number.isFinite(weight) ? { weight } : {}),
    });
    els.upPhase.textContent = '';
    const added = opts.onPick?.(item);
    setStatus(added === false
      ? `登録しました（行が上限なので追加はしていません）: ${item.air}`
      : `登録して、使う LoRA に追加しました: ${item.air}`, true);
  } catch (err) {
    setStatus('');
    els.upPhase.textContent = '';
    setError(`登録に失敗しました: ${err.message}`);
  } finally {
    els.upBtn.disabled = false;
  }
}

/* ---------- タブ ---------- */

function showTab(name) {
  for (const btn of els.dialog.querySelectorAll('[data-rwtab]')) {
    btn.classList.toggle('active', btn.dataset.rwtab === name);
  }
  for (const pane of els.dialog.querySelectorAll('[data-rwpane]')) {
    pane.hidden = pane.dataset.rwpane !== name;
  }
  setError('');
  setStatus('');
  if (name === 'search') runSearch();
  if (name === 'hf') renderHfPicker();
}

function initDialog() {
  if (els) return;
  document.body.insertAdjacentHTML('beforeend', DIALOG_HTML);
  const $ = (sel) => document.querySelector(sel);
  els = {
    dialog: $('#rwLoraDialog'),
    visibility: $('#rwLoraVisibility'),
    search: $('#rwLoraSearch'),
    searchBtn: $('#rwLoraSearchBtn'),
    archWrap: $('#rwLoraArchWrap'),
    arch: $('#rwLoraArch'),
    archName: $('#rwLoraArchName'),
    count: $('#rwLoraCount'),
    results: $('#rwLoraResults'),
    status: $('#rwLoraStatus'),
    error: $('#rwLoraError'),
    airInput: $('#rwLoraAirInput'),
    airBtn: $('#rwLoraAirBtn'),
    civUrl: $('#rwCivUrl'),
    civCheckBtn: $('#rwCivCheckBtn'),
    civPreview: $('#rwCivPreview'),
    civAddBtn: $('#rwCivAddBtn'),
    hfPick: $('#rwHfPick'),
    hfUrl: $('#rwHfUrl'),
    upName: $('#rwUpName'),
    upArch: $('#rwUpArch'),
    upWeight: $('#rwUpWeight'),
    upTrigger: $('#rwUpTrigger'),
    upAir: $('#rwUpAir'),
    upBaseHint: $('#rwUpBaseHint'),
    upBtn: $('#rwUpBtn'),
    upPhase: $('#rwUpPhase'),
    archList: $('#rwArchList'),
  };

  for (const arch of ARCHITECTURES) {
    const opt = document.createElement('option');
    opt.value = arch;
    els.archList.appendChild(opt);
  }

  els.searchBtn.addEventListener('click', runSearch);
  els.visibility.addEventListener('change', runSearch);
  els.arch.addEventListener('change', runSearch);
  els.airBtn.addEventListener('click', addManualAir);
  els.civCheckBtn.addEventListener('click', checkCivitai);
  els.civAddBtn.addEventListener('click', addCivitaiPick);
  els.hfPick.addEventListener('change', applyHfPick);
  els.hfUrl.addEventListener('input', refreshSuggestedAir);
  els.upBtn.addEventListener('click', runUpload);
  for (const btn of els.dialog.querySelectorAll('[data-rwtab]')) {
    btn.addEventListener('click', () => showTab(btn.dataset.rwtab));
  }
  // form 内なので、Enter は既定だとダイアログを閉じてしまう
  for (const [input, action] of [
    [els.search, runSearch], [els.airInput, addManualAir], [els.civUrl, checkCivitai],
  ]) {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      action();
    });
  }
}

function open(tab = 'search') {
  initDialog();
  const hasArch = !!opts.architecture;
  els.archWrap.hidden = !hasArch;
  els.archName.textContent = opts.architectureLabel || opts.architecture;
  els.upArch.value = els.upArch.value || opts.architecture || '';
  els.results.innerHTML = '';
  els.civPreview.hidden = true;
  els.civAddBtn.hidden = true;
  els.upPhase.textContent = '';
  els.dialog.showModal();
  showTab(tab);
}

window.runwareLora = {
  init(options = {}) {
    opts = { ...opts, ...options };
  },
  open,
  load,
  save,
  sorted,
  entry,
  label,
  labelOf,
  defaultWeight,
  triggerWords,
  normalizeAir,
  namespace,
  suggestAir,
  uploadModel,
  register,
  unregister,
  search,
  set onChange(fn) { onChange = fn; },
};

})();
