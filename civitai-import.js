'use strict';

/* ==========================================================================
 * Civitai からの取り込み（共有コンポーネント）
 *
 * Civitai の URL からモデルをサーバー側で Hugging Face リポジトリへ取り込み、
 * 完了したらライブラリへ登録する。実処理は Worker のジョブなので、タブを閉じても
 * 継続する。進行中のジョブ ID は localStorage に控え、再訪時にポーリングを再開する。
 *
 * 生成画面（LoRA / チェックポイント）と画像編集画面から同じものを使うため、
 * ダイアログの DOM もこのファイルで組み立てる。使う側は:
 *
 *   civitaiImport.init({
 *     defaultRepo: 'owner/repo',
 *     register(kind, hfUrl, meta) { ... 登録して完了メッセージを返す ... },
 *   });
 *   button.addEventListener('click', () => civitaiImport.open('lora'));
 *
 * register に渡る meta は取り込み時に Civitai から得た { base, trigger, source,
 * modelName }。ライブラリ側で初期値として使えるように渡している
 * ========================================================================== */

(() => {

const LS_CIVITAI_JOB = 'fal_civitai_job'; // 進行中の Civitai 取り込みジョブ

const DIALOG_HTML = `
<dialog id="civitaiDialog" class="key-dialog civitai-dialog">
  <form method="dialog" class="key-form">
    <h2 id="civitaiTitle">Civitai から LoRA を取り込み</h2>
    <p class="hint" id="civitaiHint"></p>
    <div class="civitai-search">
      <input id="civitaiUrlInput" type="text" placeholder="https://civitai.com/models/..." spellcheck="false" autocomplete="off">
      <button id="civitaiResolveBtn" class="ghost-btn" type="button">確認</button>
    </div>
    <label class="field">
      <span class="label">アップロード先リポジトリ（owner/repo）</span>
      <input id="civitaiRepoInput" type="text" spellcheck="false" autocomplete="off">
    </label>
    <label class="civitai-meta-check" title="トリガーワード・説明・サンプルの生成設定などを .civitai.json としてモデルの隣に保存します（画像本体は保存しません）">
      <input type="checkbox" id="civitaiMetaToggle" checked> サイトの情報（トリガーワード等）を JSON で一緒に保存する
    </label>
    <div id="civitaiPreview" class="civitai-preview" hidden></div>
    <div id="civitaiStatus" class="status" hidden></div>
    <div id="civitaiProgress" class="civitai-progress" hidden>
      <div class="civitai-progress-track"><div class="civitai-progress-fill"></div></div>
      <span class="civitai-progress-text"></span>
    </div>
    <div id="civitaiError" class="error" hidden></div>
    <p class="hint" id="civitaiBlocked" hidden></p>
    <div class="key-actions">
      <button value="cancel" class="ghost-btn" formnovalidate>閉じる</button>
      <button id="civitaiCancelBtn" class="ghost-btn" type="button" hidden>取り込みを中止</button>
      <button id="civitaiStartBtn" class="primary-btn" type="button" disabled>取り込み開始</button>
    </div>
  </form>
</dialog>`;

let opts = { defaultRepo: '', register: () => 'ライブラリに登録しました' };
let els = null;

/* ---------- helpers（app.js と同じもの。単体で動くよう持たせる） ---------- */

// ジョブ ID はクライアント側で採番する（app.js と同じ理由・同じ形式。
// このダイアログは app.js を読まない画面からも使うので、ここに持たせる）
function makeJobId() {
  if (crypto.randomUUID) return crypto.randomUUID().replaceAll('-', '');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function parseHfRepo(raw) {
  const s = raw.trim().replace(/^https?:\/\/huggingface\.co\//, '');
  const parts = s.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

const CIVITAI_STEP_LABELS = {
  resolve: 'モデル情報を確認中…',
  download: 'Civitai からダウンロード中…（サイズにより数分かかります）',
  upload: 'Hugging Face へアップロード中…（サイズにより数分かかります）',
  commit: 'リポジトリへコミット中…',
};
const CIVITAI_POLL_MS = 2000;
// ダイアログを閉じている／タブが裏にあるときの間隔。ポーリングは 1 回ごとに Worker と
// Durable Object を起こす（DO は最後のリクエストからしばらく起きたままなので、短い間隔で
// 叩き続けると常時起動と変わらない）。見ていない間は間隔を空けて呼び出し量を抑える
const CIVITAI_POLL_IDLE_MS = 30000;
// これより古い「進行中」記録は捨てる。サーバー側の記録が失われた場合などに、
// 取り込みボタンが永久に押せないままになるのを防ぐ保険
const CIVITAI_JOB_MAX_AGE_MS = 6 * 60 * 60 * 1000;

let civitaiResolved = null; // 「確認」で取得したメタデータ（URL・repo 変更で無効化）
let civitaiPolling = false;
let civitaiPollWake = null; // ポーリングの待機を打ち切る関数（ダイアログを開いた時など）
let civitaiMode = 'lora'; // 'lora' | 'ckpt'（取り込み完了時の登録先ライブラリ）

// ジョブはページを跨いで完了しうるので、登録先はダイアログの状態ではなく
// localStorage のジョブ記録に控えた kind から決める
function civitaiRegisterTo(kind, hfUrl, meta) {
  return opts.register(kind, hfUrl, meta ?? null);
}

// done: true で完了表示（スピナーを止めてチェックマークにする）
// ライブラリ登録の初期値に使う項目だけ取り出す（.civitai.json を読み直さずに済む）
function civitaiEntryMeta(resolved) {
  if (!resolved) return null;
  // metaDoc は「サイト情報を JSON で保存する」が ON のときだけ返る
  const words = resolved.metaDoc?.version?.trainedWords ?? [];
  return {
    base: resolved.baseModel ?? null,
    trigger: words.filter((w) => typeof w === 'string' && w.trim() !== '').join(', ') || null,
    modelName: resolved.modelName ?? null,
    source: resolved.metaDoc?.source ?? null,
  };
}

function civitaiSetStatus(text, done = false) {
  els.status.hidden = !text;
  els.status.textContent = text || '';
  els.status.classList.toggle('done', !!text && done);
}

function civitaiSetError(text) {
  els.error.hidden = !text;
  els.error.textContent = text || '';
}

function civitaiActiveJob() {
  let active = null;
  try {
    active = JSON.parse(falStore.get(LS_CIVITAI_JOB));
  } catch {
    active = null;
  }
  if (!active?.jobId) return null;
  // 古すぎる記録（開始時刻が無いものも含む）は「取り残し」とみなして捨てる。
  // 取り込みボタンが永久に押せないままになるのを防ぐ
  const ts = Number(active.ts);
  if (!Number.isFinite(ts) || Date.now() - ts > CIVITAI_JOB_MAX_AGE_MS) {
    falStore.remove(LS_CIVITAI_JOB);
    return null;
  }
  return active;
}

// ポーリングの待機。civitaiPollWake() で待機を打ち切って即時更新できる
function civitaiPollSleep(ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      civitaiPollWake = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    civitaiPollWake = done;
  });
}

// 見えていないときはゆっくり見に行く（Worker / DO の呼び出し量を抑える）
function civitaiPollDelay() {
  const watching = els.dialog.open && document.visibilityState !== 'hidden';
  return watching ? CIVITAI_POLL_MS : CIVITAI_POLL_IDLE_MS;
}

// 転送中（download / upload ステップ）のプログレスバー。それ以外では隠す
function civitaiSetProgress(done, total, extra = '') {
  const show = Number.isFinite(done) && Number.isFinite(total) && total > 0;
  els.progress.hidden = !show;
  if (!show) return;
  const pct = Math.min(100, (done / total) * 100);
  els.progress.querySelector('.civitai-progress-fill').style.width = `${pct}%`;
  // 桁は合計サイズ基準で揃える（"45.3 / 218 MB" のような不揃いを避ける）
  const digits = total < 100 * 1024 * 1024 ? 1 : 0;
  const mb = (b) => (b / 1024 / 1024).toFixed(digits);
  els.progress.querySelector('.civitai-progress-text').textContent
    = `${mb(done)} / ${mb(total)} MB${extra}`;
}

// 転送速度と残り時間の推定。進捗はパート単位（64/256 MiB）で飛び飛びに増えるため、
// 直近 60 秒の移動窓で平均して平滑化する。ステップが変わったり進捗が巻き戻ったら
//（新しいジョブ・再開など）推定をやり直す
const civitaiRate = { step: null, samples: [] };

function civitaiEtaText(step, done, total) {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return '';
  if (civitaiRate.step !== step || (civitaiRate.samples.at(-1)?.b ?? -1) > done) {
    civitaiRate.step = step;
    civitaiRate.samples = [];
  }
  const s = civitaiRate.samples;
  s.push({ t: Date.now(), b: done });
  while (s.length > 2 && s.at(-1).t - s[0].t > 60_000) s.shift();
  const spanMs = s.at(-1).t - s[0].t;
  const bytes = s.at(-1).b - s[0].b;
  // 窓が短いうちや停滞中は出さない（不正確な値を見せない）
  if (spanMs < 5000 || bytes <= 0) return '';
  const rate = bytes / (spanMs / 1000);
  const speed = `${(rate / 1024 / 1024).toFixed(rate < 10 * 1024 * 1024 ? 1 : 0)} MB/s`;
  return ` ・ ${speed} ・ 残り${civitaiFormatEta((total - done) / rate)}`;
}

function civitaiFormatEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '不明';
  if (sec < 60) return `約${Math.max(5, Math.round(sec / 5) * 5)}秒`;
  if (sec < 3600) return `約${Math.round(sec / 60)}分`;
  return `約${Math.floor(sec / 3600)}時間${Math.round((sec % 3600) / 60)}分`;
}

function civitaiSyncStartBtn() {
  const busy = civitaiActiveJob() != null;
  // 「押せないが理由が分からない」を作らないよう、無効の理由は必ず画面に出す
  const reason = busy ? '別の取り込みが進行中です。終わるまで待つか「取り込みを中止」してください'
    : !civitaiResolved ? 'URL を入れて「確認」を押してください'
      : civitaiResolved.repoError ? civitaiResolved.repoError
        : '';
  els.startBtn.disabled = reason !== '';
  els.startBtn.title = reason;
  // 確認前の当たり前の案内はうるさいので、確認済み or 進行中のときだけ出す
  els.blocked.hidden = reason === '' || (!civitaiResolved && !busy);
  els.blocked.textContent = reason ? `取り込みを開始できません: ${reason}` : '';
  els.cancelBtn.hidden = !busy; // 進行中のときだけ中止できる
  // 本体もJSONも新規作業が不要なときだけ「登録」表記にする
  const registerOnly = civitaiResolved?.alreadyUploaded
    && (!els.metaToggle.checked || civitaiResolved.metaFileExists || !civitaiResolved.metaDoc);
  els.startBtn.textContent = registerOnly ? 'ライブラリに登録' : '取り込み開始';
}

function civitaiRenderPreview(meta) {
  els.preview.innerHTML = '';
  const row = (label, value) => {
    if (!value) return;
    const div = document.createElement('div');
    div.className = 'civitai-row';
    const l = document.createElement('span');
    l.className = 'civitai-row-label';
    l.textContent = label;
    div.append(l, document.createTextNode(value));
    els.preview.appendChild(div);
  };
  const note = (text, warn = false) => {
    if (!text) return;
    const div = document.createElement('div');
    div.className = warn ? 'civitai-note warn' : 'civitai-note';
    div.textContent = text;
    els.preview.appendChild(div);
  };

  row('モデル', meta.modelName ?? '（不明）');
  row('バージョン', [meta.versionName, meta.baseModel].filter(Boolean).join(' ・ '));
  const size = meta.sizeKB ? `${(meta.sizeKB / 1024).toFixed(0)} MB` : '';
  row('ファイル', [meta.fileName ?? '（DL 時に決定）', size].filter(Boolean).join(' ・ '));

  // 保存対象のサイト情報（トリガーワード等）。使い物になるかここで判断できるよう、
  // 要点を整形して出しつつ、保存される JSON 全文も畳んで見られるようにする
  const doc = meta.metaDoc;
  if (doc) {
    const words = doc.version?.trainedWords ?? [];
    row('トリガー', words.length ? words.join(' / ') : '（登録なし）');
    const byline = [
      doc.model?.creator ? `作者: ${doc.model.creator}` : null,
      doc.model?.tags?.length ? doc.model.tags.slice(0, 6).join(', ') : null,
    ].filter(Boolean).join(' ・ ');
    row('作者・タグ', byline);
    const sampleCount = doc.images?.length ?? 0;
    row('サンプル', sampleCount
      ? `生成設定つき ${sampleCount} 件（URL と設定のみ保存・画像本体は保存しません）` : '');

    // 説明文は HTML で来るのでテキスト化して先頭だけ見せる
    const descHtml = doc.version?.description || doc.model?.description || '';
    if (descHtml) {
      const text = new DOMParser().parseFromString(descHtml, 'text/html').body.textContent
        .replace(/\s+/g, ' ').trim();
      if (text) {
        const div = document.createElement('div');
        div.className = 'civitai-desc';
        div.textContent = text.length > 300 ? `${text.slice(0, 300)}…` : text;
        els.preview.appendChild(div);
      }
    }

    const details = document.createElement('details');
    details.className = 'civitai-json';
    const summary = document.createElement('summary');
    summary.textContent = '保存される JSON を表示';
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(doc, null, 2);
    details.appendChild(pre);
    els.preview.appendChild(details);
  } else {
    note('サイト情報を取得できなかったため、JSON の保存はありません', true);
  }

  const expectedType = civitaiMode === 'ckpt' ? 'Checkpoint' : 'LORA';
  if (meta.modelType && meta.modelType !== expectedType) {
    note(`モデル種類が ${expectedType} ではありません（${meta.modelType}）`, true);
  }
  note(meta.metaWarning, true);
  note(meta.repoError, true);
  if (meta.alreadyUploaded) {
    note(doc && !meta.metaFileExists
      ? '同じ内容のファイルが既にリポジトリにあります（本体はスキップし、JSON の保存と登録だけ行います）'
      : '同じ内容のファイルが既にリポジトリにあります。アップロードは行わず登録だけします');
  } else if (meta.nameExists) {
    note('同名のファイルがリポジトリにあります（内容が違うため上書きされます）', true);
  }
  els.preview.hidden = false;
}

async function civitaiResolveUrl() {
  const rawUrl = els.urlInput.value.trim();
  const repo = parseHfRepo(els.repoInput.value);
  civitaiResolved = null;
  els.preview.hidden = true;
  civitaiSyncStartBtn();
  if (!rawUrl) {
    civitaiSetError('Civitai の URL を入力してください');
    return;
  }
  if (!repo) {
    civitaiSetError('アップロード先を owner/repo の形式で入力してください');
    return;
  }
  civitaiSetError('');
  civitaiSetStatus('モデル情報を取得中…');
  try {
    const res = await fetch(`/api/civitai/resolve?url=${encodeURIComponent(rawUrl)}&repo=${encodeURIComponent(repo)}`);
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    civitaiResolved = await res.json();
  } catch (err) {
    civitaiSetStatus('');
    civitaiSetError(`確認に失敗しました: ${err.message}`);
    return;
  }
  civitaiSetStatus('');
  civitaiRenderPreview(civitaiResolved);
  civitaiSyncStartBtn();
}

async function civitaiStartImport() {
  if (!civitaiResolved) return;
  const saveMeta = els.metaToggle.checked;

  // 同じ内容が既にあり、JSON も保存済み（または保存しない設定）なら登録だけで完了。
  // JSON が未保存で保存 ON のときはジョブに進み、サーバー側で JSON のみコミットされる
  if (civitaiResolved.alreadyUploaded
    && (!saveMeta || civitaiResolved.metaFileExists || !civitaiResolved.metaDoc)) {
    civitaiSetStatus(`既存のファイルを${civitaiRegisterTo(civitaiMode, civitaiResolved.alreadyUploaded, civitaiEntryMeta(civitaiResolved))}`, true);
    return;
  }

  const rawUrl = els.urlInput.value.trim();
  const repo = parseHfRepo(els.repoInput.value);
  if (!rawUrl || !repo) return;
  const jobId = makeJobId();
  civitaiSetError('');
  civitaiSetStatus('取り込みジョブを開始しています…');
  els.startBtn.disabled = true;
  try {
    const res = await fetch('/api/lora-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, url: rawUrl, repo, saveMeta, kind: civitaiMode }),
    });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
  } catch (err) {
    civitaiSetStatus('');
    civitaiSetError(`開始できませんでした: ${err.message}`);
    civitaiSyncStartBtn();
    return;
  }
  falStore.set(LS_CIVITAI_JOB, JSON.stringify({
    jobId, ts: Date.now(), kind: civitaiMode, meta: civitaiEntryMeta(civitaiResolved),
  }));
  civitaiPollJob();
}

// 取り込みの中止。サーバー側のジョブも止めてから記録を捨てる
async function civitaiCancelImport() {
  const active = civitaiActiveJob();
  falStore.remove(LS_CIVITAI_JOB); // 先に消してポーリングを止める
  civitaiSetStatus('取り込みを中止しました', true);
  civitaiSetProgress(null, null);
  civitaiSyncStartBtn();
  civitaiPollWake?.();
  if (active) {
    try {
      await fetch(`/api/lora-import/job/${active.jobId}`, { method: 'DELETE' });
    } catch { /* 通信できなくても、こちらの記録は消えているので操作は続けられる */ }
  }
}

// 進行中ジョブのポーリング。完了時はダイアログが閉じていても登録まで済ませる
async function civitaiPollJob() {
  if (civitaiPolling) return;
  const active = civitaiActiveJob();
  if (!active) return;
  civitaiPolling = true;
  try {
    while (true) {
      // 別タブでの完了・中止・期限切れで記録が消えていたら止める
      if (!civitaiActiveJob()) {
        if (!els.status.classList.contains('done')) { // 完了・中止の表示は残す
          civitaiSetStatus('');
          civitaiSetProgress(null, null);
        }
        break;
      }
      let res;
      try {
        res = await fetch(`/api/lora-import/job/${active.jobId}`);
      } catch {
        await civitaiPollSleep(civitaiPollDelay() * 2); // ネットワーク断はそのまま再試行
        continue;
      }
      if (res.status === 404) {
        // ジョブ保持期間（1 時間）切れなど。結果は分からないので静かに諦める
        falStore.remove(LS_CIVITAI_JOB);
        civitaiSetStatus('');
        civitaiSetProgress(null, null);
        break;
      }
      if (!res.ok) {
        await civitaiPollSleep(civitaiPollDelay() * 2);
        continue;
      }
      const job = await res.json();
      if (job.status === 'done') {
        falStore.remove(LS_CIVITAI_JOB);
        civitaiSetProgress(null, null);
        const registered = civitaiRegisterTo(active.kind === 'ckpt' ? 'ckpt' : 'lora', job.hfUrl, active.meta);
        civitaiSetStatus(job.skipped
          ? `既にアップロード済みだったため本体は省略し、登録だけ行いました（${registered}）`
          : `取り込みが完了し、${registered}`, true);
        break;
      }
      if (job.status === 'error') {
        falStore.remove(LS_CIVITAI_JOB);
        civitaiSetStatus('');
        civitaiSetProgress(null, null);
        civitaiSetError(job.error || '取り込みに失敗しました');
        break;
      }
      civitaiSetStatus(CIVITAI_STEP_LABELS[job.step] ?? '処理中…');
      const transferring = job.step === 'download' || job.step === 'upload';
      civitaiSetProgress(
        transferring ? job.bytesDone : null,
        job.bytesTotal,
        transferring ? civitaiEtaText(job.step, job.bytesDone, job.bytesTotal) : '',
      );
      await civitaiPollSleep(civitaiPollDelay());
    }
  } finally {
    civitaiPolling = false;
    civitaiSyncStartBtn();
  }
}

function openCivitaiDialog(mode) {
  // モードが変わったら前回の確認結果は使い回さない（登録先・警告表示が異なる）
  if (civitaiMode !== mode) {
    civitaiResolved = null;
    els.preview.hidden = true;
  }
  civitaiMode = mode;
  els.title.textContent = mode === 'ckpt'
    ? 'Civitai からチェックポイントを取り込み'
    : 'Civitai から LoRA を取り込み';
  els.hint.innerHTML = (mode === 'ckpt'
    ? 'Civitai のモデルページ URL（modelVersionId 付き可）またはダウンロード URL を入力すると、モデルを Hugging Face リポジトリへ取り込んでチェックポイントライブラリに登録します（約 30 GB まで・サイズにより数分〜数十分）。<br>'
    : 'Civitai のモデルページ URL（modelVersionId 付き可）またはダウンロード URL を入力すると、モデルを Hugging Face リポジトリへアップロードして LoRA ライブラリに登録します。<br>')
    + '公開リポジトリへのアップロードは再配布に当たります。モデルのライセンスを確認してください。';
  civitaiSetError('');
  if (!civitaiActiveJob()) {
    civitaiSetStatus('');
    civitaiSetProgress(null, null);
  }
  els.repoInput.value ||= opts.defaultRepo;
  els.metaToggle.checked = true; // JSON 保存は開くたびに既定の ON へ戻す
  civitaiSyncStartBtn();
  els.dialog.showModal();
  civitaiPollJob(); // 進行中ジョブがあれば表示を再開する
  civitaiPollWake?.(); // 既にポーリング中なら待機を飛ばして今の進捗をすぐ出す
}

// ボタンの処理が例外で落ちると「押しても何も起きない」だけになって原因が追えない。
// 想定外の失敗も必ず画面に出す
function civitaiOnClick(handler) {
  return async (e) => {
    try {
      await handler(e);
    } catch (err) {
      civitaiSetStatus('');
      civitaiSetError(`処理に失敗しました: ${err?.message ?? err}`);
      throw err; // コンソールにも残す
    }
  };
}

function initCivitaiDialog() {
  els.resolveBtn.addEventListener('click', civitaiOnClick(civitaiResolveUrl));
  els.startBtn.addEventListener('click', civitaiOnClick(civitaiStartImport));
  els.cancelBtn.addEventListener('click', civitaiOnClick(civitaiCancelImport));
  els.metaToggle.addEventListener('change', civitaiSyncStartBtn);

  // URL・リポジトリを変えたら確認からやり直す（プレビューと開始ボタンを無効化）
  for (const input of [els.urlInput, els.repoInput]) {
    input.addEventListener('input', () => {
      civitaiResolved = null;
      els.preview.hidden = true;
      civitaiSyncStartBtn();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        civitaiResolveUrl();
      }
    });
  }

  // タブに戻ってきたら間隔を戻すため、待機中のポーリングを起こす
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') civitaiPollWake?.();
  });
}

/* ---------- 公開 API ---------- */

window.civitaiImport = {
  init(options) {
    opts = { ...opts, ...options };
    document.body.insertAdjacentHTML('beforeend', DIALOG_HTML);
    const $ = (sel) => document.querySelector(sel);
    els = {
      title: $('#civitaiTitle'),
      hint: $('#civitaiHint'),
      dialog: $('#civitaiDialog'),
      urlInput: $('#civitaiUrlInput'),
      resolveBtn: $('#civitaiResolveBtn'),
      repoInput: $('#civitaiRepoInput'),
      metaToggle: $('#civitaiMetaToggle'),
      preview: $('#civitaiPreview'),
      status: $('#civitaiStatus'),
      progress: $('#civitaiProgress'),
      error: $('#civitaiError'),
      blocked: $('#civitaiBlocked'),
      startBtn: $('#civitaiStartBtn'),
      cancelBtn: $('#civitaiCancelBtn'),
    };
    initCivitaiDialog();
    civitaiPollJob(); // 前回の取り込みが続いていれば拾う
  },
  open(mode) {
    openCivitaiDialog(mode);
  },
};

})();
