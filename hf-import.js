'use strict';

/* ==========================================================================
 * Hugging Face からの一括登録（共有コンポーネント）
 *
 * 公開リポジトリのファイル一覧を出して、選んだものをライブラリへ登録する。
 * huggingface.co を直接叩くと CORS で失敗する環境があるので、一覧の取得は
 * Worker 経由（/api/hf/tree）で行う。
 *
 * 生成画面（LoRA / チェックポイント）と画像編集画面から同じものを使うため、
 * ダイアログの DOM もこのファイルで組み立てる。使う側は:
 *
 *   hfImport.init({
 *     defaultRepo: 'owner/repo',          // LoRA のときの既定リポジトリ
 *     defaultCkptRepo: 'owner/repo',      // チェックポイントのときの既定（任意）
 *     currentBase: () => 'krea2',         // ベースモデルの初期選択（種類で返す）
 *     registeredPaths: (kind) => [...],   // 登録済み URL（「登録済み」表示に使う）
 *     register(kind, url, meta) { ... },  // 選択されたものを登録する
 *     afterRegister(kind) { ... },        // 登録が済んだあとの再描画（任意）
 *   });
 *   button.addEventListener('click', () => hfImport.open('lora'));
 * ========================================================================== */

(() => {

const DIALOG_HTML = `
<dialog id="hfDialog" class="key-dialog hf-dialog">
  <form method="dialog" class="key-form">
    <h2 id="hfTitle">Hugging Face から LoRA を一括登録</h2>
    <p class="hint" id="hfHint"></p>
    <div class="hf-search">
      <input id="hfRepoInput" type="text" placeholder="owner/repo" spellcheck="false" autocomplete="off">
      <button id="hfLoadBtn" class="ghost-btn" type="button">読み込み</button>
    </div>
    <input id="hfFilterInput" class="hf-filter" type="search" placeholder="ファイル名で絞り込み…" spellcheck="false" autocomplete="off">
    <label class="field" id="hfBaseField">
      <span class="label">ベースモデル <em>（どのモデル用の LoRA か。候補の絞り込みに使います）</em></span>
      <select id="hfBaseSelect"></select>
    </label>
    <div id="hfStatus" class="status" hidden></div>
    <div id="hfError" class="error" hidden></div>
    <div id="hfList" class="hf-list"></div>
    <div class="key-actions">
      <button value="cancel" class="ghost-btn" formnovalidate>閉じる</button>
      <button value="add" id="hfAddBtn" class="primary-btn" disabled>選択した 0 件を登録</button>
    </div>
  </form>
</dialog>`;

// ベースモデルの選択肢。値は loraLib が保存する表記そのもの
// （読むときは loraLib.baseKind() で種類に寄せられる）
const BASE_KINDS = ['krea2', 'qwen', 'wan'];

let opts = {
  defaultRepo: '',
  defaultCkptRepo: '',
  currentBase: () => null,
  registeredPaths: () => [],
  register: () => {},
  afterRegister: null,
};
let els = null;
let mode = 'lora'; // 'lora' | 'ckpt'

function parseRepo(raw) {
  const s = raw.trim().replace(/^https?:\/\/huggingface\.co\//, '');
  const parts = s.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

function setStatus(text) {
  els.status.hidden = !text;
  els.status.textContent = text || '';
}

function setError(text) {
  els.error.hidden = !text;
  els.error.textContent = text || '';
}

function updateAddBtn() {
  const n = els.list.querySelectorAll('input:checked:not(:disabled)').length;
  els.addBtn.disabled = n === 0;
  els.addBtn.textContent = `選択した ${n} 件を登録`;
}

async function loadRepo() {
  const repo = parseRepo(els.repoInput.value);
  if (!repo) {
    setError('リポジトリ ID を owner/repo の形式で入力してください');
    return;
  }
  setError('');
  els.list.innerHTML = '';
  updateAddBtn();
  setStatus('ファイル一覧を取得中…');

  let entries;
  try {
    const res = await fetch(`/api/hf/tree?repo=${encodeURIComponent(repo)}`);
    if (res.status === 401 || res.status === 404) {
      throw new Error('リポジトリが見つかりません（非公開または ID の誤り）');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    entries = await res.json();
  } catch (err) {
    setStatus('');
    setError(`取得に失敗しました: ${err.message}`);
    return;
  }
  setStatus('');

  const pattern = mode === 'ckpt' ? /\.(safetensors|gguf)$/i : /\.safetensors$/i;
  const files = entries.filter((e) => e.type === 'file' && pattern.test(e.path));
  if (files.length === 0) {
    setError(mode === 'ckpt'
      ? 'このリポジトリに .safetensors / .gguf ファイルは見つかりませんでした'
      : 'このリポジトリに .safetensors ファイルは見つかりませんでした');
    return;
  }

  // リポジトリへの追加日（= 最終コミット日時）の新しい順。日付が取れなければ元の順序
  const dateOf = (f) => Date.parse(f.lastCommit?.date ?? '') || 0;
  files.sort((a, b) => dateOf(b) - dateOf(a));

  const registered = new Set(opts.registeredPaths(mode) ?? []);
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
    const date = dateOf(f)
      ? new Date(dateOf(f)).toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' })
      : '';
    const size = f.size ? `${(f.size / 1024 / 1024).toFixed(0)} MB` : '';
    meta.textContent = done ? '登録済み' : [date, size].filter(Boolean).join(' ・ ');
    item.appendChild(meta);

    els.list.appendChild(item);
  }
  applyFilter();
  updateAddBtn();
}

// 一覧をファイル名で絞り込む（選択状態は保持したまま表示だけ切り替える）
function applyFilter() {
  const q = els.filterInput.value.trim().toLowerCase();
  for (const item of els.list.querySelectorAll('.hf-item')) {
    const name = item.querySelector('.hf-name').textContent.toLowerCase();
    item.classList.toggle('filtered-out', q !== '' && !name.includes(q));
  }
}

function renderBaseOptions(selectedKind) {
  els.baseSelect.innerHTML = '';
  for (const kind of BASE_KINDS) {
    const opt = document.createElement('option');
    // 保存されるのは表示名。読むときに loraLib.baseKind() で種類へ寄せる
    opt.value = loraLib.baseLabel(kind);
    opt.textContent = kind === 'qwen' ? 'Qwen（画像編集）' : loraLib.baseLabel(kind);
    els.baseSelect.appendChild(opt);
  }
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '指定しない';
  els.baseSelect.appendChild(none);
  els.baseSelect.value = selectedKind ? loraLib.baseLabel(selectedKind) : '';
}

function openDialog(which) {
  mode = which;
  els.title.textContent = mode === 'ckpt'
    ? 'Hugging Face からチェックポイントを一括登録'
    : 'Hugging Face から LoRA を一括登録';
  els.hint.innerHTML = mode === 'ckpt'
    ? '公開リポジトリの ID（owner/repo）または URL を入力すると、含まれる .safetensors / .gguf を一覧表示します。<br>選択したものはチェックポイントライブラリに登録され、初回使用時に Modal Volume へ取り込まれます。'
    : '公開リポジトリの ID（owner/repo）または URL を入力すると、含まれる .safetensors を一覧表示します。<br>選択したものは LoRA ライブラリに登録されます（現在の LoRA 設定行には追加されません）。';
  setError('');
  setStatus('');
  // 開くたびに既定リポジトリ・絞り込みへ戻して自動で読み込む
  els.repoInput.value = mode === 'ckpt' ? opts.defaultCkptRepo : opts.defaultRepo;
  els.filterInput.value = '';
  els.list.innerHTML = '';
  // ベースモデルの指定は LoRA のときだけ。既定は今のモデルに合わせる
  els.baseField.hidden = mode === 'ckpt';
  renderBaseOptions(opts.currentBase());
  updateAddBtn();
  els.dialog.showModal();
  loadRepo();
}

function initDialog() {
  els.loadBtn.addEventListener('click', loadRepo);
  els.filterInput.addEventListener('input', applyFilter);

  // Enter で form が「閉じる」ボタンで submit されるのを防いで読み込みにする
  els.repoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      loadRepo();
    }
  });

  els.list.addEventListener('change', updateAddBtn);

  els.dialog.addEventListener('close', () => {
    if (els.dialog.returnValue !== 'add') return;
    const urls = [...els.list.querySelectorAll('input:checked:not(:disabled)')]
      .map((cb) => cb.value);
    if (urls.length === 0) return;
    // LoRA はベースモデルを一緒に控える（あとで候補の絞り込みに使う）
    const base = els.baseSelect.value;
    for (const url of urls) opts.register(mode, url, base ? { base } : null);
    opts.afterRegister?.(mode);
  });
}

/* ---------- 公開 API ---------- */

window.hfImport = {
  init(options) {
    opts = { ...opts, ...options };
    document.body.insertAdjacentHTML('beforeend', DIALOG_HTML);
    const $ = (sel) => document.querySelector(sel);
    els = {
      title: $('#hfTitle'),
      hint: $('#hfHint'),
      dialog: $('#hfDialog'),
      repoInput: $('#hfRepoInput'),
      loadBtn: $('#hfLoadBtn'),
      filterInput: $('#hfFilterInput'),
      baseField: $('#hfBaseField'),
      baseSelect: $('#hfBaseSelect'),
      status: $('#hfStatus'),
      error: $('#hfError'),
      list: $('#hfList'),
      addBtn: $('#hfAddBtn'),
    };
    initDialog();
  },
  open(which) {
    openDialog(which);
  },
};

})();
