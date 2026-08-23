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
 * 2. Runware に登録済みのモデルを探して控えに入れるダイアログ。
 *    modelSearch タスクを叩くだけなので、過去に自分でアップロードしたモデル
 *    （visibility: owned）も、公開モデルも同じ経路で拾える
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

const DIALOG_HTML = `
<dialog id="rwLoraDialog" class="key-dialog rwlora-dialog">
  <form method="dialog" class="key-form">
    <h2>Runware の LoRA を取り込む</h2>
    <p class="hint">Runware に登録済みのモデルを検索して、この画面の候補に加えます。「自分のモデル」には、これまでにアップロードしたものが出ます。</p>

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
    <div id="rwLoraStatus" class="status" hidden></div>
    <div id="rwLoraError" class="error" hidden></div>

    <details class="field rwlora-manual">
      <summary class="label">AIR を直接指定する</summary>
      <div class="civitai-search">
        <input id="rwLoraAirInput" type="text" placeholder="例: civitai:1234@5678" spellcheck="false" autocomplete="off">
        <button id="rwLoraAirBtn" class="ghost-btn" type="button">追加</button>
      </div>
      <p class="hint">検索に出てこない AIR（provider:model@version）をそのまま控えに入れます。</p>
    </details>

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
  };

  els.searchBtn.addEventListener('click', runSearch);
  els.visibility.addEventListener('change', runSearch);
  els.arch.addEventListener('change', runSearch);
  els.airBtn.addEventListener('click', addManualAir);
  // form 内なので、Enter は既定だとダイアログを閉じてしまう
  for (const [input, action] of [[els.search, runSearch], [els.airInput, addManualAir]]) {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      action();
    });
  }
}

function open() {
  initDialog();
  const hasArch = !!opts.architecture;
  els.archWrap.hidden = !hasArch;
  els.archName.textContent = opts.architectureLabel || opts.architecture;
  setError('');
  setStatus('');
  els.results.innerHTML = '';
  els.dialog.showModal();
  runSearch();
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
  register,
  unregister,
  search,
  set onChange(fn) { onChange = fn; },
};

})();
