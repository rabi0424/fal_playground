'use strict';

/* ==========================================================================
 * LoRA 比較アリーナ
 *
 * LoRA チェックポイント群（20〜30 個規模を想定）を 1 つの「セッション」として
 * 登録し、プロンプトを変えながら何度でも一斉生成（= ラウンド）→ 匿名の
 * 1 対 1 比較投票 → Elo レートによるランキングを行う別画面。
 *
 * - 生成は本体（app.js）と同じ fal キュー API（Worker のプロキシ経由）
 * - 生成結果は type: 'compare' の履歴レコードとして /api/history に保存する
 *   ため、通常の生成画面のギャラリーにもそのまま表示される
 * - セッション・対戦結果は localStorage に保存し、LoRA ライブラリと同じ
 *   /api/state 同期（セクション 'arena'）で端末間同期する
 * ========================================================================== */

/* ---------- constants ---------- */

const ARENA_MODELS = [
  { id: 'fal-ai/krea-2/turbo/lora', name: 'Krea 2 [turbo] LoRA' },
  { id: '__custom__', name: 'カスタム…' },
];

// app.js と同じ約 1MP のプリセット
const SIZES = [
  { value: 'square_1_1', label: '正方形 1:1（1024×1024）', width: 1024, height: 1024 },
  { value: 'landscape_4_3', label: '横長 4:3（1152×896）', width: 1152, height: 896 },
  { value: 'landscape_16_9', label: '横長 16:9（1344×768）', width: 1344, height: 768 },
  { value: 'portrait_3_4', label: '縦長 3:4（896×1152）', width: 896, height: 1152 },
  { value: 'portrait_2_3', label: '縦長 2:3（1024×1536）', width: 1024, height: 1536 },
  { value: 'portrait_9_16', label: '縦長 9:16（768×1344）', width: 768, height: 1344 },
];

const LS_THEME = 'fal_theme';
const LS_LORAS = 'fal_lora_library';
const LS_ARENA = 'fal_arena';
const LS_SYNC_TS = 'fal_sync_ts';

// 20〜30 件を並行ポーリングするため、本体（900ms）より間隔を空ける
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_CONSECUTIVE_ERRORS = 5;

const ELO_START = 1000;
const ELO_K = 32;

// 投票数の目安。判定が行ったり来たりしないよう、単調に増える「最少試合数」を
// 基準にする（シミュレーションでは、真の順位との相関は最少 9〜12 試合あたりで
// 頭打ちになるため、それ以上の投票を促さない）。
// 順位の揺らぎ（直近の投票での順位変動）は参考情報として添える
const MIN_GAMES_OK = 6; // ここからレートが参考値として使える
const MIN_GAMES_DONE = 10; // ここから先は投票を増やしても精度がほぼ伸びない
const STABILITY_WINDOW_RATIO = 0.15; // 順位変動を見る「直近」の割合
const STABILITY_MIN_WINDOW = 10;

/* ---------- helpers ---------- */

const $ = (sel) => document.querySelector(sel);

const els = {
  themeBtn: $('#themeBtn'),
  sessionListView: $('#sessionListView'),
  sessionList: $('#sessionList'),
  newSessionBtn: $('#newSessionBtn'),
  sessionView: $('#sessionView'),
  backBtn: $('#backBtn'),
  sessionTitle: $('#sessionTitle'),
  sessionMeta: $('#sessionMeta'),
  deleteSessionBtn: $('#deleteSessionBtn'),
  roundPrompt: $('#roundPrompt'),
  roundSize: $('#roundSize'),
  roundSteps: $('#roundSteps'),
  roundGuidance: $('#roundGuidance'),
  startRoundBtn: $('#startRoundBtn'),
  abortRoundBtn: $('#abortRoundBtn'),
  roundProgress: $('#roundProgress'),
  arenaError: $('#arenaError'),
  votePanel: $('#votePanel'),
  voteRoundLabel: $('#voteRoundLabel'),
  voteCount: $('#voteCount'),
  voteImgA: $('#voteImgA'),
  voteImgB: $('#voteImgB'),
  voteABtn: $('#voteABtn'),
  voteBBtn: $('#voteBBtn'),
  voteDrawBtn: $('#voteDrawBtn'),
  voteSkipBtn: $('#voteSkipBtn'),
  voteUndoBtn: $('#voteUndoBtn'),
  voteLog: $('#voteLog'),
  lbScope: $('#lbScope'),
  lbBody: $('#lbBody'),
  lbStatus: $('#lbStatus'),
  lbEmpty: $('#lbEmpty'),
  roundList: $('#roundList'),
  sessionDialog: $('#sessionDialog'),
  sessionName: $('#sessionName'),
  sessionModel: $('#sessionModel'),
  sessionScale: $('#sessionScale'),
  sessionCustomModelField: $('#sessionCustomModelField'),
  sessionCustomModel: $('#sessionCustomModel'),
  rangeStart: $('#rangeStart'),
  rangeEnd: $('#rangeEnd'),
  rangeAddBtn: $('#rangeAddBtn'),
  plist: $('#plist'),
  plistAllBtn: $('#plistAllBtn'),
  plistNoneBtn: $('#plistNoneBtn'),
  plistCount: $('#plistCount'),
  sessionDialogError: $('#sessionDialogError'),
  lightbox: $('#lightbox'),
  lightboxClose: $('#lightboxClose'),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const ACCESS_EXPIRED_MSG = 'ログインセッションが切れています。ページを再読み込みしてサインインし直してください。';

function isHtmlResponse(res) {
  return (res.headers.get('Content-Type') || '').includes('text/html');
}

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
    } catch { /* 本文が JSON でない場合はそのまま */ }
    throw new Error(detail);
  }
  return res.json();
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

function loraDisplayName(path) {
  const seg = path.split('?')[0].split('/').filter(Boolean).pop() || path;
  try {
    return decodeURIComponent(seg).replace(/\.safetensors$/i, '');
  } catch {
    return seg.replace(/\.safetensors$/i, '');
  }
}

// 名前順（数字は数値比較）。同じ LoRA の別バージョンがステップ数順に並ぶので、
// この並びの「間」を範囲選択の対象にする
function sortedLoraLibrary() {
  return [...loadLoraLibrary()].sort((a, b) =>
    a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' }));
}

/* ---------- arena state ---------- */
// {
//   sessions: [{
//     id, name, modelId, scale, createdAt,
//     participants: [{ id, path }],
//     settings: { size, steps, guidance },   // 最後に使ったラウンド設定
//     rounds: [{ id, prompt, seed, ts, status: 'generating'|'done',
//                settings, results: { pid: { url, width, height, error } },
//                pending: { pid: { status_url, response_url } }, historyId }],
//     matches: [{ id, roundId, a, b, winner: 'a'|'b'|'draw', ts }],
//   }]
// }

let arena = loadArena();

function loadArena() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_ARENA));
    if (parsed && Array.isArray(parsed.sessions)) return parsed;
  } catch { /* 壊れていたら初期化 */ }
  return { sessions: [] };
}

function saveArena() {
  localStorage.setItem(LS_ARENA, JSON.stringify(arena));
  syncMarkDirty('arena');
}

let idSeq = 0;
function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${(++idSeq).toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function getSession(id) {
  return arena.sessions.find((s) => s.id === id) ?? null;
}

function participantName(session, pid) {
  const p = session.participants.find((x) => x.id === pid);
  return p ? loraDisplayName(p.path) : pid;
}

// 同じ LoRA の別チェックポイント同士は名前の前半が共通で、肝心のステップ数は
// 末尾にある。全参加者の共通プレフィックスを検出して「…0005000」のように
// 末尾側を残した短縮名を作る（フル名は title で確認できる）
function participantShortNames(session) {
  const names = session.participants.map((p) => loraDisplayName(p.path));
  let cut = 0;
  if (names.length >= 2) {
    let prefix = names[0];
    for (const n of names.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
      prefix = prefix.slice(0, i);
    }
    // 区切り文字の直後まで戻す（0005000 / 0010000 の共通部分 00 まで削らない）
    const boundary = Math.max(
      prefix.lastIndexOf('_'), prefix.lastIndexOf('-'), prefix.lastIndexOf('.'));
    cut = boundary >= 3 ? boundary + 1 : (prefix.length >= 4 ? prefix.length : 0);
  }
  const map = {};
  session.participants.forEach((p, i) => {
    map[p.id] = cut > 0 && names[i].length > cut ? `…${names[i].slice(cut)}` : names[i];
  });
  return map;
}

/* ---------- device sync（app.js と同じ仕組み・セクションは loras + arena） ---------- */
// 注意: /api/state はドキュメント全体を置き換えるため、本体（app.js）側の
// SYNC_SECTIONS にも 'arena' を追加してある。ここでも両セクションを送る

const SYNC_SECTIONS = { loras: LS_LORAS, arena: LS_ARENA };
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

function syncMarkDirty(section) {
  const ts = loadSyncTs();
  ts[section] = Date.now();
  saveSyncTs(ts);
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    syncPushTimer = null;
    syncPull();
  }, SYNC_PUSH_DELAY_MS);
}

function syncFetch(method, body) {
  return fetch('/api/state', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body,
    keepalive: method === 'PUT',
  });
}

async function syncPull() {
  let doc;
  try {
    const res = await syncFetch('GET');
    if (!res.ok || isHtmlResponse(res)) return;
    doc = await res.json();
  } catch {
    return;
  }

  const ts = loadSyncTs();
  let changed = false;
  let needPush = !doc;
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

  if (changed) {
    arena = loadArena();
    renderAll();
  }
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

/* ---------- Elo ---------- */

// 対戦結果（時系列順）を再生して Elo レートと勝敗を求める。
// matches を絞り込めば「ラウンド単位のレート」も同じ関数で計算できる
function computeStandings(session, matches) {
  const ratings = {};
  const stats = {};
  for (const p of session.participants) {
    ratings[p.id] = ELO_START;
    stats[p.id] = { w: 0, d: 0, l: 0, games: 0 };
  }
  for (const m of matches) {
    if (!(m.a in ratings) || !(m.b in ratings)) continue;
    const ea = 1 / (1 + 10 ** ((ratings[m.b] - ratings[m.a]) / 400));
    const sa = m.winner === 'a' ? 1 : m.winner === 'b' ? 0 : 0.5;
    ratings[m.a] += ELO_K * (sa - ea);
    ratings[m.b] += ELO_K * ((1 - sa) - (1 - ea));
    stats[m.a].games++;
    stats[m.b].games++;
    if (m.winner === 'draw') {
      stats[m.a].d++;
      stats[m.b].d++;
    } else {
      stats[m.winner === 'a' ? m.a : m.b].w++;
      stats[m.winner === 'a' ? m.b : m.a].l++;
    }
  }
  return { ratings, stats };
}

// 投票がレート表示に十分な量に達したかの目安を返す。
// scope は 'all' またはラウンド id（リーダーボードの集計範囲と同じ）
// level: 0 = まだ不足 / 1 = 参考値として使える / 2 = 十分（これ以上は伸びにくい）
function voteSufficiency(session, matches, scope) {
  const rounds = scope === 'all'
    ? session.rounds
    : session.rounds.filter((r) => r.id === scope);
  // 投票の対象になり得るのは画像が生成できたチェックポイントだけ
  const eligible = new Set();
  for (const r of rounds) {
    for (const [pid, res] of Object.entries(r.results)) {
      if (res.url) eligible.add(pid);
    }
  }
  const pids = [...eligible];
  if (pids.length < 2 || matches.length === 0) return null;

  const { stats } = computeStandings(session, matches);
  const gamesOf = (p) => stats[p]?.games ?? 0;
  const minGames = Math.min(...pids.map(gamesOf));
  const level = minGames >= MIN_GAMES_DONE ? 2 : minGames >= MIN_GAMES_OK ? 1 : 0;

  // 次の段階までの残り票数の目安。1 票で 2 体の試合数が 1 ずつ増える。
  // ペアはほぼ均等に選ばれる（特定の 1 体だけ集中的には増やせない）ため、
  // 「不足の合計 / 2」と「均等分配で最少値が目標に届くまで」の大きい方を採る
  const target = level === 0 ? MIN_GAMES_OK : MIN_GAMES_DONE;
  const deficitSum = pids.reduce((sum, p) => sum + Math.max(0, target - gamesOf(p)), 0);
  const needVotes = Math.max(
    Math.ceil(deficitSum / 2),
    Math.ceil((target - minGames) * pids.length / 2));

  // 参考情報: 直近の投票（全体の 15%・最低 10 票）で順位がどれだけ動いたか
  const win = Math.max(STABILITY_MIN_WINDOW, Math.round(matches.length * STABILITY_WINDOW_RATIO));
  let rankShift = null;
  if (matches.length >= win + STABILITY_MIN_WINDOW) {
    const rankOf = (ratings) => {
      const order = [...pids].sort((a, b) => ratings[b] - ratings[a]);
      return Object.fromEntries(order.map((p, i) => [p, i]));
    };
    const before = rankOf(computeStandings(session, matches.slice(0, matches.length - win)).ratings);
    const now = rankOf(computeStandings(session, matches).ratings);
    rankShift = Math.max(...pids.map((p) => Math.abs(now[p] - before[p])));
  }

  return { minGames, needVotes, win, rankShift, level };
}

/* ---------- ペアの提案 ---------- */

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// 次に見せるペアを選ぶ。優先度は
//   1. このラウンドでまだ対戦していない組
//   2. セッション全体での対戦回数が少ない組
//   3. 現在レートが近い組（僅差の順位を精緻化する）
// に少しランダム性を加えたスコアの最小値。skip 直後の組は下げる
let lastSkippedKey = null;

function proposePair(session, round) {
  const pids = session.participants
    .map((p) => p.id)
    .filter((pid) => round.results[pid]?.url);
  if (pids.length < 2) return null;

  const { ratings } = computeStandings(session, session.matches);
  const roundCounts = {};
  const totalCounts = {};
  for (const m of session.matches) {
    const key = pairKey(m.a, m.b);
    totalCounts[key] = (totalCounts[key] || 0) + 1;
    if (m.roundId === round.id) roundCounts[key] = (roundCounts[key] || 0) + 1;
  }

  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < pids.length; i++) {
    for (let j = i + 1; j < pids.length; j++) {
      const key = pairKey(pids[i], pids[j]);
      const score =
        (roundCounts[key] || 0) * 10000 +
        (totalCounts[key] || 0) * 500 +
        Math.abs(ratings[pids[i]] - ratings[pids[j]]) +
        (key === lastSkippedKey ? 3000 : 0) +
        Math.random() * 120;
      if (score < bestScore) {
        bestScore = score;
        best = [pids[i], pids[j]];
      }
    }
  }
  if (!best) return null;
  // 左右の並びもランダムにして位置バイアスを避ける
  if (Math.random() < 0.5) best = [best[1], best[0]];
  return { roundId: round.id, a: best[0], b: best[1] };
}

/* ---------- 生成（ラウンド） ---------- */

// ローカルのみの実行時状態（永続化しない）
const roundAborts = new Set(); // 中断が指示されたラウンド id
const generatingSessions = new Set(); // 実行中のセッション id（ボタン制御用）

function setArenaError(text) {
  els.arenaError.hidden = !text;
  els.arenaError.textContent = text || '';
}

function buildRoundInput(session, round, participant) {
  const size = SIZES.find((s) => s.value === round.settings?.size) || SIZES[0];
  const input = {
    prompt: round.prompt,
    num_images: 1,
    seed: round.seed,
    image_size: { width: size.width, height: size.height },
    loras: [{ path: participant.path, scale: session.scale }],
  };
  if (round.settings?.steps !== '' && round.settings?.steps != null) {
    input.num_inference_steps = Number(round.settings.steps);
  }
  if (round.settings?.guidance !== '' && round.settings?.guidance != null) {
    input.guidance_scale = Number(round.settings.guidance);
  }
  return input;
}

async function startRound() {
  const session = getSession(currentSessionId);
  if (!session) return;
  const prompt = els.roundPrompt.value.trim();
  if (!prompt) {
    setArenaError('プロンプトを入力してください');
    return;
  }
  if (generatingSessions.has(session.id)) return;

  const n = session.participants.length;
  if (n >= 10 && !confirm(`${n} 個のチェックポイントで ${n} 枚を一斉生成します。よろしいですか？`)) {
    return;
  }
  setArenaError('');

  const round = {
    id: makeId('r'),
    prompt,
    // 公平な比較のため全チェックポイントで同じ seed を使う
    seed: Math.floor(Math.random() * 4294967296),
    ts: Date.now(),
    status: 'generating',
    settings: {
      size: els.roundSize.value,
      steps: els.roundSteps.value,
      guidance: els.roundGuidance.value,
    },
    results: {},
    pending: {},
    historyId: null,
  };
  session.settings = { ...round.settings }; // 次回のプリフィル用
  session.rounds.push(round);
  saveArena();
  renderRounds(session);

  await runRound(session, round);
}

// ラウンドを（未完了の参加者から）実行する。起動時の再開もこの関数を使う
async function runRound(session, round) {
  generatingSessions.add(session.id);
  updateGenerateUI(session, round);

  try {
    // 1. 未送信の参加者をすべてキューに投入する
    for (const p of session.participants) {
      if (round.results[p.id] || round.pending[p.id]) continue;
      if (roundAborts.has(round.id)) break;
      try {
        const sub = await falFetch(`https://queue.fal.run/${session.modelId}`, {
          method: 'POST',
          body: JSON.stringify(buildRoundInput(session, round, p)),
        });
        round.pending[p.id] = { status_url: sub.status_url, response_url: sub.response_url };
      } catch (err) {
        round.results[p.id] = { error: `送信失敗: ${err.message}` };
      }
      saveArena();
      updateGenerateUI(session, round);
    }

    // 2. 全参加者の完了を並行して待つ
    await Promise.all(session.participants.map(async (p) => {
      const pend = round.pending[p.id];
      if (!pend || round.results[p.id]) return;
      try {
        const r = await awaitRequest(pend, round.id);
        const img = r.images?.[0];
        if (!img) throw new Error('画像が返されませんでした');
        round.results[p.id] = { url: img.url, width: img.width, height: img.height };
      } catch (err) {
        round.results[p.id] = { error: err.message };
      }
      delete round.pending[p.id];
      saveArena();
      updateGenerateUI(session, round);
    }));

    await finalizeRound(session, round);
  } finally {
    generatingSessions.delete(session.id);
    roundAborts.delete(round.id);
    updateGenerateUI(session, null);
    renderSessionBody(session);
  }
}

// 1 件の fal リクエストの完了を待って結果を返す。一時的な接続エラーは
// 数回まで無視して次のポーリングで拾う
async function awaitRequest(pend, roundId) {
  let errors = 0;
  while (true) {
    await sleep(POLL_INTERVAL_MS + Math.random() * 500);
    if (roundAborts.has(roundId)) throw new Error('中断されました');
    let status;
    try {
      status = await falFetch(pend.status_url);
      errors = 0;
    } catch (err) {
      if (++errors >= POLL_MAX_CONSECUTIVE_ERRORS) throw err;
      continue;
    }
    if (status.status === 'COMPLETED') break;
  }
  return falFetch(pend.response_url);
}

// ラウンドの後処理: 履歴レコード（type: 'compare'）として保存し、
// fal CDN の URL をサーバーが取り込んだ失効しない URL に差し替える。
// 同じ id で再送してもサーバー側は差し替えるだけなので再実行しても安全
async function finalizeRound(session, round) {
  round.status = 'done';
  round.pending = {};

  const variants = session.participants.map((p) => {
    const res = round.results[p.id] ?? { error: '未生成' };
    const loras = [{ path: p.path, scale: session.scale }];
    return {
      ownLoras: loras,
      loras,
      images: res.url ? [{ url: res.url, width: res.width, height: res.height }] : [],
      seed: round.seed,
      elapsed: null,
      error: res.error ?? null,
    };
  });

  const record = {
    id: `arena_${round.id}`,
    ts: round.ts,
    type: 'compare',
    model: session.modelId,
    prompt: round.prompt,
    seed: round.seed,
    common: [],
    variants,
    arena: { sessionId: session.id, sessionName: session.name, roundId: round.id },
  };
  round.historyId = record.id;

  try {
    const res = await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (res.ok && !isHtmlResponse(res)) {
      const saved = await res.json();
      saved.variants?.forEach((v, i) => {
        const pid = session.participants[i]?.id;
        const url = v.images?.[0]?.url;
        if (pid && url && round.results[pid]?.url) round.results[pid].url = url;
      });
    }
  } catch {
    // オフラインなどで保存できなくても、fal CDN の URL のまま投票は続けられる
  }

  saveArena();

  // 生成が終わったラウンドをそのまま投票対象にする（このセッションを表示中のときだけ）
  if (session.id === currentSessionId) {
    votingRoundId = round.id;
    currentPair = null;
    renderSessionBody(session);
  }
}

function abortRound() {
  const session = getSession(currentSessionId);
  const round = session?.rounds.find((r) => r.status === 'generating');
  if (round) roundAborts.add(round.id);
}

// 起動時: 生成途中で閉じられたラウンドがあれば再開する
function resumeRounds() {
  for (const session of arena.sessions) {
    for (const round of session.rounds) {
      if (round.status !== 'generating') continue;
      runRound(session, round);
    }
  }
}

function updateGenerateUI(session, round) {
  if (session.id !== currentSessionId) return;
  const generating = generatingSessions.has(session.id);
  els.startRoundBtn.disabled = generating;
  els.abortRoundBtn.hidden = !generating;
  if (!generating || !round) {
    els.roundProgress.hidden = true;
    return;
  }
  const total = session.participants.length;
  const done = Object.values(round.results).filter((r) => r.url).length;
  const failed = Object.values(round.results).filter((r) => r.error).length;
  els.roundProgress.hidden = false;
  els.roundProgress.textContent =
    `生成中… ${done}/${total} 完了${failed ? `・エラー ${failed}` : ''}`;
}

/* ---------- 投票 ---------- */

let currentSessionId = null;
let votingRoundId = null;
let currentPair = null; // { roundId, a, b }

function votableRound(session) {
  const byId = session.rounds.find((r) => r.id === votingRoundId);
  if (byId && Object.values(byId.results).filter((r) => r.url).length >= 2) return byId;
  // 未指定なら最新の投票可能なラウンド
  for (let i = session.rounds.length - 1; i >= 0; i--) {
    const r = session.rounds[i];
    if (Object.values(r.results).filter((x) => x.url).length >= 2) return r;
  }
  return null;
}

function showNextPair(session) {
  const round = votableRound(session);
  if (!round) {
    els.votePanel.hidden = true;
    currentPair = null;
    return;
  }
  votingRoundId = round.id;
  currentPair = proposePair(session, round);
  els.votePanel.hidden = !currentPair;
  // 拡大表示のまま投票したら、次のペアと食い違わないよう閉じる
  if (!els.lightbox.hidden) closeLightbox();
  if (!currentPair) return;

  const roundIndex = session.rounds.indexOf(round) + 1;
  els.voteRoundLabel.textContent = `ラウンド ${roundIndex}: ${round.prompt}`;
  els.voteRoundLabel.title = round.prompt;
  const votes = session.matches.filter((m) => m.roundId === round.id).length;
  els.voteCount.textContent = `投票 ${votes} 件`;

  // 匿名化: 画像以外の情報（名前・URL のヒント）は出さない
  els.voteImgA.src = round.results[currentPair.a].url;
  els.voteImgB.src = round.results[currentPair.b].url;
  renderVoteLog(session, round);
}

function vote(winner) {
  const session = getSession(currentSessionId);
  if (!session || !currentPair) return;
  session.matches.push({
    id: makeId('m'),
    roundId: currentPair.roundId,
    a: currentPair.a,
    b: currentPair.b,
    winner,
    ts: Date.now(),
  });
  lastSkippedKey = null;
  saveArena();
  renderLeaderboard(session);
  showNextPair(session);
}

function skipPair() {
  const session = getSession(currentSessionId);
  if (!session || !currentPair) return;
  lastSkippedKey = pairKey(currentPair.a, currentPair.b);
  showNextPair(session);
}

function undoVote() {
  const session = getSession(currentSessionId);
  if (!session || session.matches.length === 0) return;
  session.matches.pop();
  saveArena();
  renderLeaderboard(session);
  showNextPair(session);
}

const WINNER_LABELS = { a: '左の勝ち', b: '右の勝ち', draw: '引き分け' };

// 直近の投票を（名前を明かして）表示する。投票後の答え合わせ用
function renderVoteLog(session, round) {
  els.voteLog.innerHTML = '';
  const shortNames = participantShortNames(session);
  const recent = session.matches.filter((m) => m.roundId === round.id).slice(-8).reverse();
  for (const m of recent) {
    const line = document.createElement('div');
    const a = document.createElement('span');
    a.textContent = shortNames[m.a] ?? participantName(session, m.a);
    a.title = participantName(session, m.a);
    if (m.winner === 'a') a.className = 'win';
    const b = document.createElement('span');
    b.textContent = shortNames[m.b] ?? participantName(session, m.b);
    b.title = participantName(session, m.b);
    if (m.winner === 'b') b.className = 'win';
    const sep = document.createElement('span');
    sep.textContent = ` × `;
    const result = document.createElement('span');
    result.textContent = `　→ ${WINNER_LABELS[m.winner]}`;
    line.append(a, sep, b, result);
    els.voteLog.appendChild(line);
  }
}

/* ---------- レンダリング ---------- */

function renderAll() {
  const session = getSession(currentSessionId);
  if (session) {
    els.sessionListView.hidden = true;
    els.sessionView.hidden = false;
    renderSessionHead(session);
    renderSessionBody(session);
  } else {
    currentSessionId = null;
    els.sessionListView.hidden = false;
    els.sessionView.hidden = true;
    renderSessionList();
  }
}

function renderSessionList() {
  els.sessionList.innerHTML = '';
  if (arena.sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'gallery-empty';
    empty.textContent = 'まだセッションはありません。「＋ 新しいセッション」から作成してください。';
    els.sessionList.appendChild(empty);
    return;
  }
  for (const session of [...arena.sessions].reverse()) {
    const card = document.createElement('div');
    card.className = 'panel session-card';
    card.addEventListener('click', () => openSession(session.id));

    const name = document.createElement('h3');
    name.textContent = session.name;
    card.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${session.modelId.replace(/^fal-ai\//, '')} ・ ${session.participants.length} チェックポイント`;
    card.appendChild(meta);

    const stats = document.createElement('div');
    stats.className = 'meta';
    stats.textContent = `ラウンド ${session.rounds.length} ・ 投票 ${session.matches.length} 件 ・ ${new Date(session.createdAt).toLocaleDateString('ja-JP')}`;
    card.appendChild(stats);

    els.sessionList.appendChild(card);
  }
}

function openSession(id) {
  const session = getSession(id);
  if (!session) return;
  currentSessionId = id;
  votingRoundId = null;
  currentPair = null;
  setArenaError('');

  // ラウンド設定のプリフィル（開いたときだけ。入力中は上書きしない）
  els.roundSize.value = session.settings?.size || SIZES[0].value;
  if (![...els.roundSize.options].some((o) => o.value === els.roundSize.value)) {
    els.roundSize.value = SIZES[0].value;
  }
  els.roundSteps.value = session.settings?.steps ?? '';
  els.roundGuidance.value = session.settings?.guidance ?? '';

  renderAll();
  const round = session.rounds.find((r) => r.status === 'generating');
  updateGenerateUI(session, round ?? null);
}

function renderSessionHead(session) {
  els.sessionTitle.textContent = session.name;
  els.sessionMeta.textContent =
    `${session.modelId} ・ ${session.participants.length} チェックポイント ・ scale ${session.scale}`;
}

function renderSessionBody(session) {
  if (session.id !== currentSessionId) return;
  renderLeaderboard(session);
  // showNextPair が投票対象ラウンド（votingRoundId）を確定させてから
  // ラウンド一覧を描画する（「比較中」表示を正しくするため）
  showNextPair(session);
  renderRounds(session);
}

function renderLeaderboard(session) {
  // スコープ選択肢（全体 + 各ラウンド）を作り直す。選択中の値は維持する
  const prev = els.lbScope.value || 'all';
  els.lbScope.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = 'セッション全体';
  els.lbScope.appendChild(allOpt);
  session.rounds.forEach((r, i) => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `ラウンド ${i + 1}: ${r.prompt.slice(0, 20)}${r.prompt.length > 20 ? '…' : ''}`;
    els.lbScope.appendChild(opt);
  });
  els.lbScope.value = prev;
  if (els.lbScope.value !== prev) els.lbScope.value = 'all';

  const scope = els.lbScope.value;
  const matches = scope === 'all'
    ? session.matches
    : session.matches.filter((m) => m.roundId === scope);

  const { ratings, stats } = computeStandings(session, matches);
  const order = [...session.participants].sort((x, y) => ratings[y.id] - ratings[x.id]);
  const shortNames = participantShortNames(session);

  els.lbBody.innerHTML = '';
  els.lbEmpty.hidden = matches.length > 0;
  order.forEach((p, i) => {
    const tr = document.createElement('tr');
    const st = stats[p.id];

    const rank = document.createElement('td');
    rank.textContent = st.games > 0 ? String(i + 1) : '–';
    tr.appendChild(rank);

    const name = document.createElement('td');
    name.className = 'lb-name';
    name.textContent = shortNames[p.id];
    name.title = `${loraDisplayName(p.path)}\n${p.path}`;
    tr.appendChild(name);

    const elo = document.createElement('td');
    elo.className = 'num';
    elo.textContent = st.games > 0 ? String(Math.round(ratings[p.id])) : '–';
    tr.appendChild(elo);

    const games = document.createElement('td');
    games.className = 'num';
    // 試合数が目安に達していないチェックポイントは薄く表示して不足を示す
    if (st.games < MIN_GAMES_OK) games.classList.add('low');
    games.textContent = String(st.games);
    tr.appendChild(games);

    const wdl = document.createElement('td');
    wdl.className = 'num';
    wdl.textContent = `${st.w}-${st.d}-${st.l}`;
    tr.appendChild(wdl);

    els.lbBody.appendChild(tr);
  });

  renderSufficiency(session, matches, scope);
}

// 「あと何票くらい必要か / もう十分か」の目安をリーダーボード下に表示する
function renderSufficiency(session, matches, scope) {
  const s = voteSufficiency(session, matches, scope);
  els.lbStatus.hidden = !s;
  els.lbStatus.classList.remove('done', 'mid');
  if (!s) return;

  const shift = s.rankShift !== null
    ? `直近 ${s.win} 票での順位変動: 最大 ±${s.rankShift}`
    : '';

  let main;
  if (s.level === 2) {
    els.lbStatus.classList.add('done');
    main = `✓ 投票は十分です（全チェックポイント ${MIN_GAMES_DONE} 試合以上）。これ以上投票しても順位の精度はほとんど上がりません`;
  } else if (s.level === 1) {
    els.lbStatus.classList.add('mid');
    main = `レートは参考値として使える段階です（最少 ${s.minGames} 試合）。確定の目安（各 ${MIN_GAMES_DONE} 試合）まで、あと約 ${s.needVotes} 票`;
  } else {
    main = `まだ投票が足りません。参考値の目安（各 ${MIN_GAMES_OK} 試合）まで、あと約 ${s.needVotes} 票（現在の最少 ${s.minGames} 試合）`;
  }
  els.lbStatus.textContent = shift ? `${main}\n${shift}` : main;
}

function renderRounds(session) {
  els.roundList.innerHTML = '';
  if (session.rounds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'まだラウンドはありません。プロンプトを入力して生成してください。';
    els.roundList.appendChild(empty);
    return;
  }

  [...session.rounds].reverse().forEach((round) => {
    const index = session.rounds.indexOf(round) + 1;
    const item = document.createElement('div');
    item.className = 'round-item';
    if (round.id === votingRoundId) item.classList.add('active');

    const head = document.createElement('div');
    head.className = 'round-item-head';

    const title = document.createElement('div');
    title.className = 'round-item-title';
    title.textContent = `R${index}　${round.prompt}`;
    title.title = round.prompt;
    head.appendChild(title);
    item.appendChild(head);

    const ok = Object.values(round.results).filter((r) => r.url).length;
    const failed = Object.values(round.results).filter((r) => r.error).length;
    const votes = session.matches.filter((m) => m.roundId === round.id).length;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = round.status === 'generating'
      ? `生成中… ${ok}/${session.participants.length}`
      : `画像 ${ok} 枚${failed ? `・失敗 ${failed}` : ''} ・ 投票 ${votes} 件`;
    item.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'round-item-actions';

    if (round.status !== 'generating' && ok >= 2) {
      const voteBtn = document.createElement('button');
      voteBtn.className = 'ghost-btn small';
      voteBtn.type = 'button';
      voteBtn.textContent = round.id === votingRoundId ? '比較中' : 'このラウンドで比較';
      voteBtn.disabled = round.id === votingRoundId;
      voteBtn.addEventListener('click', () => {
        votingRoundId = round.id;
        currentPair = null;
        renderSessionBody(session);
      });
      actions.appendChild(voteBtn);
    }

    if (round.status !== 'generating') {
      const delBtn = document.createElement('button');
      delBtn.className = 'ghost-btn small';
      delBtn.type = 'button';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', () => {
        if (!confirm(`ラウンド ${index} とその投票結果を削除しますか？\n（生成画像の履歴レコードは残ります）`)) return;
        session.rounds = session.rounds.filter((r) => r.id !== round.id);
        session.matches = session.matches.filter((m) => m.roundId !== round.id);
        if (votingRoundId === round.id) votingRoundId = null;
        saveArena();
        renderSessionBody(session);
      });
      actions.appendChild(delBtn);
    }
    item.appendChild(actions);

    // 画像一覧（開くと名前が見える = 匿名性はここでは求めない）
    if (ok > 0) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '画像一覧（チェックポイント名が見えます）';
      details.appendChild(summary);

      const grid = document.createElement('div');
      grid.className = 'round-thumbs';
      const shortNames = participantShortNames(session);
      for (const p of session.participants) {
        const res = round.results[p.id];
        if (!res?.url) continue;
        const cell = document.createElement('div');
        cell.className = 'round-thumb';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = res.url;
        img.alt = loraDisplayName(p.path);
        img.addEventListener('click', () => openLightbox(res.url));
        cell.appendChild(img);
        const label = document.createElement('div');
        label.className = 'name';
        label.textContent = shortNames[p.id];
        label.title = `${loraDisplayName(p.path)}\n${p.path}`;
        cell.appendChild(label);
        grid.appendChild(cell);
      }
      details.appendChild(grid);
      item.appendChild(details);
    }

    els.roundList.appendChild(item);
  });
}

/* ---------- lightbox ---------- */

function openLightbox(url) {
  els.lightbox.querySelector('img').src = url;
  els.lightbox.hidden = false;
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lightbox.querySelector('img').src = '';
}

/* ---------- セッション作成ダイアログ ---------- */

function dialogSetError(text) {
  els.sessionDialogError.hidden = !text;
  els.sessionDialogError.textContent = text || '';
}

function updatePlistCount() {
  const n = els.plist.querySelectorAll('input:checked').length;
  els.plistCount.textContent = `${n} 個を選択中`;
}

function openSessionDialog() {
  dialogSetError('');
  els.sessionName.value = `セッション ${new Date().toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}`;
  els.sessionScale.value = '1';
  els.sessionModel.value = ARENA_MODELS[0].id;
  els.sessionCustomModel.value = '';
  els.sessionCustomModelField.hidden = true;

  const lib = sortedLoraLibrary();
  els.plist.innerHTML = '';
  els.rangeStart.innerHTML = '';
  els.rangeEnd.innerHTML = '';
  lib.forEach((item, i) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = item.path;
    cb.dataset.index = String(i);
    label.appendChild(cb);
    const name = document.createElement('span');
    name.className = 'plist-name';
    name.textContent = item.name;
    name.title = item.path;
    label.appendChild(name);
    els.plist.appendChild(label);

    for (const select of [els.rangeStart, els.rangeEnd]) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = item.name;
      select.appendChild(opt);
    }
  });
  if (lib.length > 0) els.rangeEnd.value = String(lib.length - 1);
  updatePlistCount();

  if (lib.length === 0) {
    dialogSetError('LoRA ライブラリが空です。生成画面の「Hugging Face から一括登録」などでチェックポイントを登録してください。');
  }
  els.sessionDialog.showModal();
}

// 範囲選択: 開始〜終了（名前順）に含まれるチェックポイントをすべてチェックする
function applyRangeSelection() {
  const a = Number(els.rangeStart.value);
  const b = Number(els.rangeEnd.value);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  for (const cb of els.plist.querySelectorAll('input[type="checkbox"]')) {
    const i = Number(cb.dataset.index);
    if (i >= lo && i <= hi) cb.checked = true;
  }
  updatePlistCount();
}

function createSessionFromDialog() {
  const modelId = els.sessionModel.value === '__custom__'
    ? els.sessionCustomModel.value.trim()
    : els.sessionModel.value;
  if (!modelId) {
    dialogSetError('モデル ID を入力してください');
    return false;
  }
  const paths = [...els.plist.querySelectorAll('input:checked')].map((cb) => cb.value);
  if (paths.length < 2) {
    dialogSetError('チェックポイントを 2 つ以上選択してください');
    return false;
  }
  const scale = Number(els.sessionScale.value);

  const session = {
    id: makeId('s'),
    name: els.sessionName.value.trim() || 'セッション',
    modelId,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    createdAt: Date.now(),
    participants: paths.map((path, i) => ({ id: `p${i + 1}`, path })),
    settings: { size: SIZES[0].value, steps: '', guidance: '' },
    rounds: [],
    matches: [],
  };
  arena.sessions.push(session);
  saveArena();
  openSession(session.id);
  return true;
}

function initSessionDialog() {
  els.newSessionBtn.addEventListener('click', openSessionDialog);

  for (const m of ARENA_MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    els.sessionModel.appendChild(opt);
  }
  els.sessionModel.addEventListener('change', () => {
    els.sessionCustomModelField.hidden = els.sessionModel.value !== '__custom__';
  });

  els.rangeAddBtn.addEventListener('click', applyRangeSelection);
  els.plistAllBtn.addEventListener('click', () => {
    for (const cb of els.plist.querySelectorAll('input')) cb.checked = true;
    updatePlistCount();
  });
  els.plistNoneBtn.addEventListener('click', () => {
    for (const cb of els.plist.querySelectorAll('input')) cb.checked = false;
    updatePlistCount();
  });
  els.plist.addEventListener('change', updatePlistCount);

  // 「作成」は検証に通ったときだけ閉じる
  $('#createSessionBtn').addEventListener('click', (e) => {
    e.preventDefault();
    if (createSessionFromDialog()) els.sessionDialog.close('create');
  });
}

/* ---------- セッションの操作 ---------- */

function deleteCurrentSession() {
  const session = getSession(currentSessionId);
  if (!session) return;
  if (!confirm(`セッション「${session.name}」を削除しますか？\nラウンドと投票結果が消えます（生成画像の履歴レコードは残ります）。`)) return;
  arena.sessions = arena.sessions.filter((s) => s.id !== session.id);
  currentSessionId = null;
  saveArena();
  renderAll();
}

/* ---------- init ---------- */

initTheme();
initSessionDialog();

for (const s of SIZES) {
  const opt = document.createElement('option');
  opt.value = s.value;
  opt.textContent = s.label;
  els.roundSize.appendChild(opt);
}

els.backBtn.addEventListener('click', () => {
  currentSessionId = null;
  renderAll();
});
els.deleteSessionBtn.addEventListener('click', deleteCurrentSession);
els.startRoundBtn.addEventListener('click', startRound);
els.abortRoundBtn.addEventListener('click', abortRound);

els.voteABtn.addEventListener('click', () => vote('a'));
els.voteBBtn.addEventListener('click', () => vote('b'));
els.voteDrawBtn.addEventListener('click', () => vote('draw'));
els.voteSkipBtn.addEventListener('click', skipPair);
els.voteUndoBtn.addEventListener('click', undoVote);
els.voteImgA.addEventListener('click', () => openLightbox(els.voteImgA.src));
els.voteImgB.addEventListener('click', () => openLightbox(els.voteImgB.src));

els.lbScope.addEventListener('change', () => {
  const session = getSession(currentSessionId);
  if (session) renderLeaderboard(session);
});

els.lightbox.addEventListener('click', closeLightbox);
els.lightboxClose.addEventListener('click', closeLightbox);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.lightbox.hidden) {
    closeLightbox();
    return;
  }
  // 投票ショートカット。入力中・ダイアログ表示中は無効
  if (els.sessionView.hidden || els.votePanel.hidden || !currentPair) return;
  if (els.sessionDialog.open) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); vote('a'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); vote('b'); }
  else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); vote('draw'); }
  else if (e.key === 's' || e.key === 'S') { e.preventDefault(); skipPair(); }
});

window.addEventListener('pagehide', () => {
  if (syncPushTimer) {
    clearTimeout(syncPushTimer);
    syncPushTimer = null;
    syncPush();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncPull();
});

renderAll();
syncPull();
resumeRounds();
