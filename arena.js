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

// 比較に使えるモデル。fal のほかに自前ホスト（Modal / modal_comfy）の各版も選べる。
// id は生成画面（app.js）と同じものを使う（履歴レコードの model がそろうため）。
//
// - provider: 'modal' は Worker のジョブ API（/api/krea2/generate）経由。fal は
//   キュー API（/api/fal/proxy）経由で、送るパラメータの名前も別物
// - loraBase: 参加チェックポイントの候補を絞るベースモデル
// - ckpt: セッションで UNet（チェックポイント）を指定できる版
// - cfgMax: ガイダンスの上限（Krea 2 Turbo は蒸留版なので 0〜1）
const ARENA_MODELS = [
  { id: 'fal-ai/krea-2/turbo/lora', name: 'Krea 2 [turbo] LoRA（fal）', loraBase: 'krea2' },
  { id: 'modal/krea2-turbo-exp', name: 'Krea 2 [turbo] 自前ホスト（Modal 実験版）', provider: 'modal', endpoint: 'exp', loraBase: 'krea2', cfgMax: 1 },
  { id: 'modal/krea2-turbo-gpusnap', name: 'Krea 2 [turbo] 自前ホスト（Modal GPUスナップ版）', provider: 'modal', endpoint: 'gpusnap', loraBase: 'krea2', cfgMax: 1 },
  { id: 'modal/krea2-turbo', name: 'Krea 2 [turbo] 自前ホスト（Modal 本番）', provider: 'modal', endpoint: 'prod', loraBase: 'krea2', cfgMax: 1 },
  { id: 'modal/krea2-turbo-ckpt', name: 'Krea 2 [turbo] 自前ホスト（Modal チェックポイント指定版）', provider: 'modal', endpoint: 'ckpt', loraBase: 'krea2', ckpt: true, cfgMax: 1 },
  { id: 'modal/krea2-turbo-wan', name: 'Krea 2 [turbo] 自前ホスト（Modal 統合版・編集と共有）', provider: 'modal', endpoint: 'wan', loraBase: 'krea2', ckpt: true, cfgMax: 1 },
  { id: 'modal/krea2-turbo-lanpaint', name: 'Krea 2 [turbo] 自前ホスト（Modal LanPaint 版）', provider: 'modal', endpoint: 'lanpaint', loraBase: 'krea2', ckpt: true, cfgMax: 1 },
  { id: 'modal/krea2-turbo-unified', name: 'Krea 2 [turbo] 自前ホスト（Modal 統合版・Qwen 2.1 と共有）', provider: 'modal', endpoint: 'unified', loraBase: 'krea2', ckpt: true, cfgMax: 1 },
  { id: 'modal/qwen-image-2.1', name: 'Qwen-Image 2.1 自前ホスト（Modal 統合版）', provider: 'modal', endpoint: 'qwen21', loraBase: 'qwen21', ckpt: true, ckptBase: 'qwen21', cfgMax: 10 },
  { id: '__custom__', name: 'カスタム…（fal）', loraBase: 'krea2' },
];

// 系統ごとの既定チェックポイント（app.js と同じ。表示に使うだけ）
const DEFAULT_CKPTS = {
  krea2: 'Krea-2-Turbo-Q8_0.gguf',
  qwen21: 'qwen_image_2.1_Q8_0.gguf',
};
const DEFAULT_CKPT_BASE = 'krea2';

const DEFAULT_LORA_BASE = 'krea2';

// Modal は同時 1 コンテナで順に処理する。全員ぶんを一度に投げると、後ろのジョブが
// サーバー側の打ち切り（30 分）に当たってしまうので、少しずつ流す。
// 1 本走らせながら次を待たせておけばコンテナは温まったままなので、これで遅くならない
const MODAL_ROUND_CONCURRENCY = 2;

// app.js と同じ約 1MP のプリセット
const SIZES = [
  { value: 'square_1_1', label: '正方形 1:1（1024×1024）', width: 1024, height: 1024 },
  { value: 'landscape_4_3', label: '横長 4:3（1152×896）', width: 1152, height: 896 },
  { value: 'landscape_16_9', label: '横長 16:9（1344×768）', width: 1344, height: 768 },
  { value: 'portrait_3_4', label: '縦長 3:4（896×1152）', width: 896, height: 1152 },
  { value: 'portrait_2_3', label: '縦長 2:3（1024×1536）', width: 1024, height: 1536 },
  { value: 'portrait_9_16', label: '縦長 9:16（768×1344）', width: 768, height: 1344 },
];

const LS_LORAS = 'fal_lora_library';
const LS_ARENA = 'fal_arena';
const LS_CHART_ORDER = 'fal_arena_chart_order'; // グラフの並び順（'step' | 'elo'）

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
  sessionListView: $('#sessionListView'),
  sessionList: $('#sessionList'),
  newSessionBtn: $('#newSessionBtn'),
  sessionView: $('#sessionView'),
  backBtn: $('#backBtn'),
  sessionTitle: $('#sessionTitle'),
  sessionMeta: $('#sessionMeta'),
  deleteSessionBtn: $('#deleteSessionBtn'),
  roundPromptList: $('#roundPromptList'),
  groupEditBtn: $('#groupEditBtn'),
  groupDialog: $('#groupDialog'),
  groupList: $('#groupList'),
  groupAddBtn: $('#groupAddBtn'),
  groupAssign: $('#groupAssign'),
  groupRangeStart: $('#groupRangeStart'),
  groupRangeEnd: $('#groupRangeEnd'),
  groupRangeTarget: $('#groupRangeTarget'),
  groupRangeBtn: $('#groupRangeBtn'),
  groupDialogError: $('#groupDialogError'),
  groupSaveBtn: $('#groupSaveBtn'),
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
  lbChartWrap: $('#lbChartWrap'),
  lbChart: $('#lbChart'),
  lbOrder: $('#lbOrder'),
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
  sessionCkptField: $('#sessionCkptField'),
  sessionCkpt: $('#sessionCkpt'),
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

/* ---------- Modal（自前ホスト）のジョブ API ---------- */
// 生成画面（app.js）と同じ経路。Worker にジョブを登録し、/api/krea2/job/<id> を
// ポーリングして結果を受け取る。ジョブ ID はこちらで採番するので、同じ ID で
// 送り直しても多重生成にならない（＝ラウンドの再開がそのまま使える）

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
  return modalErrors.toError(res.status, text).message;
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

// 完了まで待つ。時間切れはサーバー側（30 分）に任せる ―― 参加者が多いと Modal 側の
// 順番待ちで長くなるので、こちらで打ち切ると正常なジョブまで落としてしまう。
// 一時的な接続エラーは数回まで無視して次のポーリングで拾う
async function modalAwaitJob(jobId, roundId) {
  let errors = 0;
  while (true) {
    await sleep(POLL_INTERVAL_MS + Math.random() * 500);
    if (roundAborts.has(roundId)) throw new Error('中断されました');

    const res = await fetch(`/api/krea2/job/${jobId}`).catch(() => null);
    if (!res || isHtmlResponse(res)) {
      if (++errors >= POLL_MAX_CONSECUTIVE_ERRORS) {
        throw new Error(res ? ACCESS_EXPIRED_MSG : '接続できませんでした');
      }
      continue;
    }
    if (res.status === 404) {
      throw new Error('ジョブが見つかりませんでした（サーバー側で期限切れになった可能性があります）');
    }
    if (!res.ok) throw new Error(await modalErrorMessage(res));
    errors = 0;
    const job = await res.json().catch(() => null);
    if (job?.status === 'done') return job;
    if (job?.status === 'error') throw modalErrors.fromJobError(job.error, '生成に失敗しました');
  }
}

/* ---------- LoRA ライブラリ（共有モジュール経由・読み取りのみ） ---------- */

const loadLoraLibrary = () => loraLib.load();
const loraDisplayName = (path) => loraLib.fileName(path);
const loraLabel = (path) => loraLib.label(path);

// 候補はモデルの系統に合うものだけ（Krea 2 の LoRA は Qwen 2.1 には効かない）
function sortedLoraLibrary(base = DEFAULT_LORA_BASE) {
  return loraLib.forBase(base);
}

/* ---------- モデル（fal / Modal 自前ホスト） ---------- */

function arenaModel(id) {
  return ARENA_MODELS.find((m) => m.id === id) ?? null;
}

// セッションが自前ホスト（Modal）かどうか。作成時に控えた値を正とし、
// 無ければ id から引く（古いセッションは fal しか無かったので fal になる）
function isModalSession(session) {
  return (session.provider ?? arenaModel(session.modelId)?.provider) === 'modal';
}

function sessionEndpoint(session) {
  return session.modalEndpoint ?? arenaModel(session.modelId)?.endpoint ?? 'exp';
}

function sessionCfgMax(session) {
  return session.cfgMax ?? arenaModel(session.modelId)?.cfgMax ?? null;
}

/* ---------- チェックポイント（UNet）ライブラリ（読み取りのみ） ---------- */
// 登録は生成画面の「チェックポイント」欄で行う。ここでは選ぶだけ

// 並び（★ が先頭）と非表示の扱いは共有モジュール（ckpt-library.js）に揃える
function ckptsForBase(base = DEFAULT_CKPT_BASE, keep = null) {
  return ckptLib.forBase(base, { keep });
}

function ckptLabel(path) {
  return path ? ckptLib.label(path) : '';
}

/* ---------- arena state ---------- */
// {
//   sessions: [{
//     id, name, modelId, scale, createdAt,
//     participants: [{ id, path, group }],
//     groups: [{ id, name, prompt }],        // グループごとのプロンプト（最後に使ったもの）
//     settings: { size, steps, guidance },   // 最後に使ったラウンド設定
//     rounds: [{ id, prompt, seed, ts, status: 'generating'|'done',
//                prompts: [{ id, name, prompt }],  // グループごとのプロンプト（生成時の控え）
//                assign: { pid: gid },             // 生成時の所属（あとで分け直しても崩れないように）
//                settings, results: { pid: { url, width, height, error } },
//                pending: { pid: { status_url, response_url } }, historyId }],
//     matches: [{ id, roundId, a, b, winner: 'a'|'b'|'draw', ts }],
//   }]
// }

let arena = loadArena();

function loadArena() {
  try {
    const parsed = JSON.parse(falStore.get(LS_ARENA));
    if (parsed && Array.isArray(parsed.sessions)) return parsed;
  } catch { /* 壊れていたら初期化 */ }
  return { sessions: [] };
}

function saveArena() {
  // 対戦結果は端末間同期にも載るので、書けなくてもここでは止めない
  falStore.set(LS_ARENA, JSON.stringify(arena));
  deviceSync.markDirty('arena');
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
  return p ? loraLabel(p.path) : pid;
}

// 同じ LoRA の別チェックポイント同士は名前の前半が共通で、肝心のステップ数は
// 末尾にある。全参加者の共通プレフィックスを検出して「…0005000」のように
// 末尾側を残した短縮名を作る（フル名は title で確認できる）
function participantShortNames(session) {
  const names = session.participants.map((p) => loraLabel(p.path));
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

/* ---------- グループ ---------- */
// トリガーワードが違う LoRA（別人物・別データセット）は、同じプロンプトでは
// 比べられない。参加者をグループに分け、ラウンドではグループごとのプロンプトで
// 生成する。投票とランキングはグループをまたいで行うので、総合順位はそのまま出る。
// groups を持たない古いセッションは「1 グループだけ」として扱う

const DEFAULT_GROUP_ID = 'g1';

function ensureGroups(session) {
  if (!Array.isArray(session.groups) || session.groups.length === 0) {
    session.groups = [{ id: DEFAULT_GROUP_ID, name: 'グループ 1', prompt: '' }];
  }
  return session.groups;
}

// 参加者の所属グループ。消えたグループを指していたら先頭に寄せる
function groupOf(session, participant) {
  const groups = ensureGroups(session);
  return groups.find((g) => g.id === participant.group) ?? groups[0];
}

function groupMembers(session, groupId) {
  return session.participants.filter((p) => groupOf(session, p).id === groupId);
}

// 生成に使うグループ。1 つも入っていないグループはプロンプトを訊かない
function activeGroups(session) {
  return ensureGroups(session).filter((g) => groupMembers(session, g.id).length > 0);
}

// ラウンドの表題に使う 1 行。全グループが同じ文言ならそのまま見せる
function summarizePrompts(prompts) {
  const uniq = [...new Set(prompts.map((p) => p.prompt))];
  if (uniq.length <= 1) return uniq[0] ?? '';
  return prompts.map((p) => `${p.name}: ${p.prompt}`).join(' ／ ');
}

// この参加者に送るプロンプト。生成時の控え（assign / prompts）を優先するので、
// あとでグループを分け直しても過去のラウンドの表示はずれない
function roundPromptFor(session, round, participant) {
  const list = round.prompts;
  if (!Array.isArray(list) || list.length === 0) return round.prompt;
  const gid = round.assign?.[participant.id] ?? groupOf(session, participant).id;
  return list.find((g) => g.id === gid)?.prompt ?? round.prompt;
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

function roundSize(round) {
  return SIZES.find((s) => s.value === round.settings?.size) || SIZES[0];
}

// fal のキュー API に送る入力
function buildRoundInput(session, round, participant) {
  const size = roundSize(round);
  const input = {
    prompt: roundPromptFor(session, round, participant),
    num_images: 1,
    seed: round.seed,
    image_size: { width: size.width, height: size.height },
    loras: [{ path: participant.path, scale: session.scale }],
  };
  // Krea 2 は安全チェッカーを切り、高速化は使わずに送る（app.js と同じ。
  // 真っ黒な画像が返るのを避けるためと、品質を採るため）
  if (session.modelId === 'fal-ai/krea-2/turbo/lora') {
    input.enable_safety_checker = false;
    input.acceleration = 'none';
  }
  if (round.settings?.steps !== '' && round.settings?.steps != null) {
    input.num_inference_steps = Number(round.settings.steps);
  }
  if (round.settings?.guidance !== '' && round.settings?.guidance != null) {
    input.guidance_scale = Number(round.settings.guidance);
  }
  return input;
}

// Modal（modal_comfy）に送る入力。fal とは項目名が違う
// （image_size → width/height、num_inference_steps → steps、guidance_scale → cfg、
//  loras の path/scale → name/strength）
function buildModalRoundInput(session, round, participant) {
  const size = roundSize(round);
  const input = {
    prompt: roundPromptFor(session, round, participant),
    width: size.width,
    height: size.height,
    seed: round.seed,
    endpoint: sessionEndpoint(session),
    // LoRA は URL のまま渡す（名前だけに落とすと、別リポジトリから取り込んだものが
    // Modal 側で解決できず 404 になる）
    loras: [{ name: loraLib.modalRef(participant.path), strength: session.scale }],
  };
  if (round.settings?.steps !== '' && round.settings?.steps != null) {
    input.steps = Number(round.settings.steps);
  }
  if (round.settings?.guidance !== '' && round.settings?.guidance != null) {
    input.cfg = Number(round.settings.guidance);
  }
  // セッションで指定した UNet（空なら Modal 側の既定）
  if (session.checkpoint) input.checkpoint = session.checkpoint;
  return input;
}

// ラウンドのプロンプト欄。グループが 2 つ以上あれば 1 つずつ並べる
function roundPromptInput(groupId) {
  return els.roundPromptList.querySelector(`textarea[data-gid="${CSS.escape(groupId)}"]`);
}

function renderRoundPrompts(session, { preserve = true } = {}) {
  const groups = activeGroups(session);
  const gids = groups.map((g) => g.id).join('|');

  // 並びが同じなら作り直さない（入力中に組み立て直すと書きかけとフォーカスを失う）
  if (preserve && els.roundPromptList.dataset.gids === gids) {
    groups.forEach((g, i) => {
      const label = els.roundPromptList.children[i]?.querySelector('.label');
      if (label) label.textContent = `${g.name}（${groupMembers(session, g.id).length} チェックポイント）`;
    });
    return;
  }

  // 書きかけを消さないよう、今入っている文言は引き継ぐ
  const typed = {};
  if (preserve) {
    for (const ta of els.roundPromptList.querySelectorAll('textarea')) typed[ta.dataset.gid] = ta.value;
  }
  els.roundPromptList.innerHTML = '';
  els.roundPromptList.dataset.gids = gids;
  const multi = groups.length > 1;
  for (const g of groups) {
    const field = document.createElement('label');
    field.className = 'field';
    if (multi) {
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = `${g.name}（${groupMembers(session, g.id).length} チェックポイント）`;
      field.appendChild(label);
    }
    const ta = document.createElement('textarea');
    ta.rows = 3;
    ta.spellcheck = false;
    ta.placeholder = '生成したい画像を英語で記述...';
    ta.dataset.gid = g.id;
    ta.value = typed[g.id] ?? g.prompt ?? '';
    // 書いた文言はグループに覚えさせる（次にこのセッションを開いたときのため）
    ta.addEventListener('change', () => {
      const target = ensureGroups(session).find((x) => x.id === g.id);
      if (!target || target.prompt === ta.value) return;
      target.prompt = ta.value;
      saveArena();
    });
    field.appendChild(ta);
    els.roundPromptList.appendChild(field);
  }
}

async function startRound() {
  const session = getSession(currentSessionId);
  if (!session) return;

  // グループごとのプロンプトを集める。1 グループなら今までどおり 1 つ
  const groups = activeGroups(session);
  const prompts = [];
  for (const g of groups) {
    const text = (roundPromptInput(g.id)?.value ?? '').trim();
    if (!text) {
      setArenaError(groups.length > 1
        ? `「${g.name}」のプロンプトを入力してください`
        : 'プロンプトを入力してください');
      return;
    }
    g.prompt = text; // 次回のプリフィル用
    prompts.push({ id: g.id, name: g.name, prompt: text });
  }
  if (prompts.length === 0) {
    setArenaError('プロンプトを入力してください');
    return;
  }
  if (generatingSessions.has(session.id)) return;

  // Krea 2 Turbo は蒸留版なのでガイダンスの範囲が狭い（0〜1）。範囲外は Modal 側が
  // 422 で弾くので、全員ぶん送ってから全部失敗するより先にここで伝える
  const cfgMax = sessionCfgMax(session);
  const guidance = els.roundGuidance.value;
  if (cfgMax !== null && guidance !== '' && (Number(guidance) < 0 || Number(guidance) > cfgMax)) {
    setArenaError(`この API のガイダンスは 0〜${cfgMax} の範囲で指定してください`);
    return;
  }

  const n = session.participants.length;
  // Modal は同時 1 コンテナなので、枚数がそのまま待ち時間になる
  const note = isModalSession(session) ? '（Modal は 1 枚ずつ順に処理するので時間がかかります）' : '';
  if (n >= 10 && !confirm(`${n} 個のチェックポイントで ${n} 枚を一斉生成します${note}。よろしいですか？`)) {
    return;
  }
  setArenaError('');

  const round = {
    id: makeId('r'),
    prompt: summarizePrompts(prompts),
    prompts,
    // グループはあとから分け直せるので、このラウンドの所属を控えておく
    assign: Object.fromEntries(session.participants.map((p) => [p.id, groupOf(session, p).id])),
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
    if (isModalSession(session)) await runRoundModal(session, round);
    else await runRoundFal(session, round);

    await finalizeRound(session, round);
  } finally {
    generatingSessions.delete(session.id);
    roundAborts.delete(round.id);
    updateGenerateUI(session, null);
    renderSessionBody(session);
  }
}

// fal: 全員ぶんをキューに投入してから、完了を並行して待つ
async function runRoundFal(session, round) {
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
      // アプリを閉じている間はこのポーリングが止まるので、完了の検知（＝通知）は
      // サーバー側にも頼んでおく。一斉生成の完了はサーバー側でまとめて 1 通になる
      window.falPush?.watchFalJob(sub.status_url, 'gen');
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
}

// Modal: 同時 1 コンテナで順に処理されるので、少しずつ投げて待つ。
// 送信済みのジョブ ID は pending に控えてあり、同じ ID で送り直しても
// サーバー側が無視するので、ページを閉じたあとの再開でも二重生成にならない
async function runRoundModal(session, round) {
  const size = roundSize(round);
  const queue = session.participants.filter((p) => !round.results[p.id]);
  let next = 0;

  const worker = async () => {
    while (next < queue.length) {
      const p = queue[next++];
      if (roundAborts.has(round.id)) return;
      try {
        const jobId = round.pending[p.id]?.jobId ?? makeModalJobId();
        if (round.pending[p.id]?.jobId !== jobId) {
          round.pending[p.id] = { jobId };
          saveArena();
        }
        await modalSubmit({ ...buildModalRoundInput(session, round, p), jobId });
        const r = await modalAwaitJob(jobId, round.id);
        if (!r.url) throw new Error('画像が返されませんでした');
        round.results[p.id] = {
          url: r.url,
          width: r.width ?? size.width,
          height: r.height ?? size.height,
        };
      } catch (err) {
        round.results[p.id] = { error: err.message };
      }
      delete round.pending[p.id];
      saveArena();
      updateGenerateUI(session, round);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MODAL_ROUND_CONCURRENCY, queue.length) }, worker));

  // 中断したときは、まだ順番が来ていなかったぶんも結果を埋めておく
  // （「画像 N 枚」とだけ出て、残りがどうなったのか分からないのを避ける）
  if (roundAborts.has(round.id)) {
    for (const p of queue) {
      if (!round.results[p.id]) round.results[p.id] = { error: '中断されました' };
    }
    saveArena();
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
      // グループごとにプロンプトが違うので、実際に送った文言を記録に残す
      prompt: roundPromptFor(session, round, p),
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
  renderRoundPrompts(session, { preserve: false });

  renderAll();
  const round = session.rounds.find((r) => r.status === 'generating');
  updateGenerateUI(session, round ?? null);
}

function renderSessionHead(session) {
  els.sessionTitle.textContent = session.name;
  const groups = activeGroups(session);
  const groupText = groups.length > 1 ? ` ・ ${groups.length} グループ` : '';
  const ckptText = session.checkpoint ? ` ・ UNet ${ckptLabel(session.checkpoint)}` : '';
  els.sessionMeta.textContent =
    `${session.modelId} ・ ${session.participants.length} チェックポイント${groupText}`
    + ` ・ scale ${session.scale}${ckptText}`;
}

function renderSessionBody(session) {
  if (session.id !== currentSessionId) return;
  renderRoundPrompts(session);
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
  const multiGroup = activeGroups(session).length > 1;

  els.lbBody.innerHTML = '';
  els.lbEmpty.hidden = matches.length > 0;
  order.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.dataset.pid = p.id;
    const st = stats[p.id];

    const rank = document.createElement('td');
    rank.textContent = st.games > 0 ? String(i + 1) : '–';
    tr.appendChild(rank);

    const name = document.createElement('td');
    name.className = 'lb-name';
    name.textContent = shortNames[p.id];
    name.title = `${loraLabel(p.path)}\n${p.path}`;
    // グループ分けしているときは、どの系統の成績なのかが分からないと読めない
    if (multiGroup) {
      const group = groupOf(session, p);
      const chip = document.createElement('span');
      chip.className = 'lb-group';
      chip.textContent = group.name;
      name.appendChild(chip);
      name.title += `\nグループ: ${group.name}`;
    }
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

  renderEloChart(session, matches, ratings, stats, shortNames);
  renderSufficiency(session, matches, scope);
}

/* ---------- Elo グラフ ---------- */

// グラフの並び順。ステップ順（参加順）が既定で、Elo 降順にも切り替えられる
let chartOrder = falStore.get(LS_CHART_ORDER) === 'elo' ? 'elo' : 'step';
// 幅が変わったときに描き直すため、直近の描画に使った材料を覚えておく
let chartInput = null;

function setChartOrder(order) {
  chartOrder = order;
  falStore.set(LS_CHART_ORDER, order);
  for (const btn of els.lbOrder.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('active', btn.dataset.order === order);
  }
  if (chartInput) drawEloChart();
}

// リーダーボードと同じ集計結果から、チェックポイント順の Elo 折れ線を描く。
// 帯（90% 区間）は投票を復元抽出して Elo を計算し直したもの
function renderEloChart(session, matches, ratings, stats, shortNames) {
  els.lbChartWrap.hidden = matches.length === 0;
  if (matches.length === 0) {
    chartInput = null;
    els.lbChart.innerHTML = '';
    return;
  }
  const bands = falArenaChart.bootstrapBands(
    session.participants, matches, (ms) => computeStandings(session, ms));
  chartInput = {
    rows: session.participants.map((p) => {
      const st = stats[p.id];
      return {
        id: p.id,
        label: shortNames[p.id],
        title: loraLabel(p.path),
        elo: ratings[p.id],
        lo: bands?.[p.id]?.lo ?? null,
        hi: bands?.[p.id]?.hi ?? null,
        games: st.games,
        w: st.w,
        d: st.d,
        l: st.l,
        plotted: st.games > 0,
      };
    }),
  };
  drawEloChart();
}

function drawEloChart() {
  if (!chartInput) return;
  const width = Math.max(240, Math.floor(els.lbChart.clientWidth) || 340);
  const lay = falArenaChart.layout({
    rows: chartInput.rows,
    order: chartOrder,
    width,
    minGamesOk: MIN_GAMES_OK,
  });
  chartInput.width = width;
  falArenaChart.render(els.lbChart, lay, {
    // グラフの点と表の行を対応付けて見られるようにする
    onHover(pid) {
      for (const tr of els.lbBody.querySelectorAll('tr')) {
        tr.classList.toggle('hl', pid !== null && tr.dataset.pid === pid);
      }
    },
  });
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

    const groupPrompts = Array.isArray(round.prompts) ? round.prompts : [];
    const multiGroup = groupPrompts.length > 1;

    const title = document.createElement('div');
    title.className = 'round-item-title';
    title.textContent = multiGroup
      ? `R${index}　${groupPrompts.length} グループ`
      : `R${index}　${round.prompt}`;
    title.title = round.prompt;
    head.appendChild(title);
    item.appendChild(head);

    // グループごとに文言が違うので、まとめた 1 行では読めない。1 行ずつ出す
    if (multiGroup) {
      for (const g of groupPrompts) {
        const line = document.createElement('div');
        line.className = 'round-group-prompt';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = g.name;
        const text = document.createElement('span');
        text.textContent = g.prompt;
        line.append(name, text);
        line.title = g.prompt;
        item.appendChild(line);
      }
    }

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

      const shortNames = participantShortNames(session);
      const addThumbs = (members) => {
        const grid = document.createElement('div');
        grid.className = 'round-thumbs';
        for (const p of members) {
          const res = round.results[p.id];
          if (!res?.url) continue;
          const cell = document.createElement('div');
          cell.className = 'round-thumb';
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.src = res.url;
          img.alt = loraLabel(p.path);
          img.addEventListener('click', () => openLightbox(res.url));
          cell.appendChild(img);
          const label = document.createElement('div');
          label.className = 'name';
          label.textContent = shortNames[p.id];
          label.title = `${loraLabel(p.path)}\n${p.path}`;
          cell.appendChild(label);
          grid.appendChild(cell);
        }
        details.appendChild(grid);
      };

      if (multiGroup) {
        // 生成時の所属で束ねる（あとで分け直しても、この一覧は当時のまま）
        for (const g of groupPrompts) {
          const members = session.participants.filter((p) =>
            (round.assign?.[p.id] ?? groupOf(session, p).id) === g.id && round.results[p.id]?.url);
          if (members.length === 0) continue;
          const heading = document.createElement('div');
          heading.className = 'round-thumb-group';
          heading.textContent = `${g.name}（${members.length}）`;
          heading.title = g.prompt;
          details.appendChild(heading);
          addThumbs(members);
        }
      } else {
        addThumbs(session.participants);
      }
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

/* ---------- グループ分けダイアログ ---------- */
// 下書きを編集して「保存」で反映する（途中でやめても元のままにするため）

let groupDraft = null; // [{ id, name, prompt }]
let assignDraft = null; // { pid: gid }

function groupDialogSetError(text) {
  els.groupDialogError.hidden = !text;
  els.groupDialogError.textContent = text || '';
}

function openGroupDialog() {
  const session = getSession(currentSessionId);
  if (!session) return;
  groupDialogSetError('');
  groupDraft = ensureGroups(session).map((g) => ({ ...g }));
  assignDraft = Object.fromEntries(
    session.participants.map((p) => [p.id, groupOf(session, p).id]));
  renderGroupDialog(session);
  els.groupDialog.showModal();
}

function draftMemberCount(gid) {
  return Object.values(assignDraft).filter((x) => x === gid).length;
}

function renderGroupDialog(session) {
  // グループ一覧（名前の編集と削除）
  els.groupList.innerHTML = '';
  for (const g of groupDraft) {
    const row = document.createElement('div');
    row.className = 'group-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = g.name;
    input.spellcheck = false;
    input.addEventListener('input', () => { g.name = input.value; });
    // 所属の選択肢にも名前を反映する（入力中は動かさない）
    input.addEventListener('change', () => renderGroupDialog(session));
    row.appendChild(input);

    const count = document.createElement('span');
    count.className = 'meta';
    count.textContent = `${draftMemberCount(g.id)} 個`;
    row.appendChild(count);

    const del = document.createElement('button');
    del.className = 'ghost-btn small';
    del.type = 'button';
    del.textContent = '削除';
    del.disabled = groupDraft.length < 2;
    del.title = groupDraft.length < 2 ? 'グループは 1 つ以上必要です' : '';
    del.addEventListener('click', () => {
      groupDraft = groupDraft.filter((x) => x.id !== g.id);
      // 行き場を失った参加者は先頭のグループへ
      for (const pid of Object.keys(assignDraft)) {
        if (assignDraft[pid] === g.id) assignDraft[pid] = groupDraft[0].id;
      }
      renderGroupDialog(session);
    });
    row.appendChild(del);

    els.groupList.appendChild(row);
  }

  // 範囲での一括割り当て（連番のチェックポイントをまとめて動かす用）
  const fillRange = (select, value) => {
    select.innerHTML = '';
    session.participants.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = loraLabel(p.path);
      select.appendChild(opt);
    });
    select.value = value;
  };
  const prevStart = els.groupRangeStart.value || '0';
  const prevEnd = els.groupRangeEnd.value || String(session.participants.length - 1);
  fillRange(els.groupRangeStart, prevStart);
  fillRange(els.groupRangeEnd, prevEnd);

  const prevTarget = els.groupRangeTarget.value;
  els.groupRangeTarget.innerHTML = '';
  for (const g of groupDraft) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = `→ ${g.name}`;
    els.groupRangeTarget.appendChild(opt);
  }
  els.groupRangeTarget.value = prevTarget;
  if (els.groupRangeTarget.value !== prevTarget) els.groupRangeTarget.value = groupDraft[0].id;

  // 参加者ごとの所属
  els.groupAssign.innerHTML = '';
  session.participants.forEach((p) => {
    const row = document.createElement('label');
    const name = document.createElement('span');
    name.className = 'plist-name';
    name.textContent = loraLabel(p.path);
    name.title = p.path;
    row.appendChild(name);

    const select = document.createElement('select');
    for (const g of groupDraft) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.name;
      select.appendChild(opt);
    }
    select.value = assignDraft[p.id];
    if (select.value !== assignDraft[p.id]) select.value = groupDraft[0].id;
    select.addEventListener('change', () => {
      assignDraft[p.id] = select.value;
      renderGroupDialog(session);
    });
    row.appendChild(select);

    els.groupAssign.appendChild(row);
  });
}

function applyGroupRange() {
  const session = getSession(currentSessionId);
  if (!session || !groupDraft) return;
  const a = Number(els.groupRangeStart.value);
  const b = Number(els.groupRangeEnd.value);
  const gid = els.groupRangeTarget.value;
  if (!Number.isInteger(a) || !Number.isInteger(b)) return;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  session.participants.forEach((p, i) => {
    if (i >= lo && i <= hi) assignDraft[p.id] = gid;
  });
  renderGroupDialog(session);
}

function saveGroupDialog() {
  const session = getSession(currentSessionId);
  if (!session || !groupDraft) return false;
  const names = groupDraft.map((g) => g.name.trim());
  if (names.some((n) => !n)) {
    groupDialogSetError('グループ名を入力してください');
    return false;
  }
  session.groups = groupDraft.map((g, i) => ({ id: g.id, name: names[i], prompt: g.prompt ?? '' }));
  for (const p of session.participants) {
    const gid = assignDraft[p.id];
    p.group = session.groups.some((g) => g.id === gid) ? gid : session.groups[0].id;
  }
  saveArena();
  renderRoundPrompts(session);
  renderSessionHead(session);
  renderSessionBody(session);
  return true;
}

function initGroupDialog() {
  els.groupEditBtn.addEventListener('click', openGroupDialog);
  els.groupAddBtn.addEventListener('click', () => {
    const session = getSession(currentSessionId);
    if (!session || !groupDraft) return;
    groupDraft.push({ id: makeId('g'), name: `グループ ${groupDraft.length + 1}`, prompt: '' });
    renderGroupDialog(session);
  });
  els.groupRangeBtn.addEventListener('click', applyGroupRange);
  els.groupSaveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (saveGroupDialog()) els.groupDialog.close('save');
  });
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

// いま選ばれているモデル（カスタムは fal 扱い）
function dialogModel() {
  return arenaModel(els.sessionModel.value);
}

// 参加候補の一覧。モデルの系統に合う LoRA だけを出す
function renderPlist(base) {
  const lib = sortedLoraLibrary(base);
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
    name.textContent = loraLabel(item.path);
    name.title = item.path;
    label.appendChild(name);
    els.plist.appendChild(label);

    for (const select of [els.rangeStart, els.rangeEnd]) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = loraLabel(item.path);
      select.appendChild(opt);
    }
  });
  if (lib.length > 0) els.rangeEnd.value = String(lib.length - 1);
  updatePlistCount();
  return lib;
}

// チェックポイント指定版で使う UNet の候補（登録は生成画面で行う）
function populateSessionCkpt(base) {
  const prev = els.sessionCkpt.value;
  els.sessionCkpt.innerHTML = '';
  const defOpt = document.createElement('option');
  defOpt.value = '';
  defOpt.textContent = `既定（${DEFAULT_CKPTS[base] ?? DEFAULT_CKPTS[DEFAULT_CKPT_BASE]}）`;
  els.sessionCkpt.appendChild(defOpt);
  for (const item of ckptsForBase(base, prev)) {
    const opt = document.createElement('option');
    opt.value = item.path;
    opt.textContent = ckptLib.optionLabel(item);
    opt.title = item.path;
    els.sessionCkpt.appendChild(opt);
  }
  els.sessionCkpt.value = prev;
  if (els.sessionCkpt.value !== prev) els.sessionCkpt.value = '';
}

// モデルを変えると、使える LoRA もチェックポイントも変わる
function syncSessionModelFields() {
  const model = dialogModel();
  els.sessionCustomModelField.hidden = els.sessionModel.value !== '__custom__';
  els.sessionCkptField.hidden = !model?.ckpt;
  if (model?.ckpt) populateSessionCkpt(model.ckptBase ?? DEFAULT_CKPT_BASE);

  const base = model?.loraBase ?? DEFAULT_LORA_BASE;
  if (els.plist.dataset.base !== base) {
    els.plist.dataset.base = base;
    const lib = renderPlist(base);
    dialogSetError(lib.length === 0
      ? 'このモデルの系統に合う LoRA がライブラリにありません。生成画面の「Hugging Face から一括登録」などで登録してください。'
      : '');
  }
}

function openSessionDialog() {
  dialogSetError('');
  els.sessionName.value = `セッション ${new Date().toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}`;
  els.sessionScale.value = '1';
  populateSessionModels('');
  els.sessionModel.selectedIndex = 0; // ★ を付けたものが先頭に来る
  els.sessionCustomModel.value = '';
  els.sessionCkpt.value = '';
  delete els.plist.dataset.base; // モデルが同じでも一覧は作り直す（登録が増えている）
  syncSessionModelFields();
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

  const model = dialogModel();
  const session = {
    id: makeId('s'),
    name: els.sessionName.value.trim() || 'セッション',
    modelId,
    // 自前ホスト（Modal）は送り先も送る形も別物。あとでモデル一覧から消えても
    // 動くように、セッションに控えておく
    ...(model?.provider === 'modal' ? { provider: 'modal', modalEndpoint: model.endpoint } : {}),
    ...(model?.cfgMax != null ? { cfgMax: model.cfgMax } : {}),
    ...(model?.ckpt && els.sessionCkpt.value ? { checkpoint: els.sessionCkpt.value } : {}),
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

// モデルの候補。★ を付けたエンドポイントが先頭、非表示にしたものは外す
// （endpoint-library.js。生成画面と同じ印を使う）
function populateSessionModels(keep = els.sessionModel.value) {
  const keyOf = (m) => (m.id === '__custom__' ? null : m.id);
  els.sessionModel.innerHTML = '';
  for (const m of endpointLib.arrange(ARENA_MODELS, keyOf, { keep })) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = endpointLib.optionLabel(keyOf(m), m.name);
    els.sessionModel.appendChild(opt);
  }
  if (keep) els.sessionModel.value = keep;
  if (els.sessionModel.selectedIndex < 0) els.sessionModel.selectedIndex = 0;
}

function initSessionDialog() {
  els.newSessionBtn.addEventListener('click', openSessionDialog);

  populateSessionModels('');
  els.sessionModel.addEventListener('change', syncSessionModelFields);

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

// 端末間同期（共有モジュール）。他端末の変更が届いたら描き直す
deviceSync.init({
  onRemote() {
    arena = loadArena();
    renderAll();
  },
});

// LoRA ライブラリ（共有モジュール）。保存のたびに端末間同期へ知らせる
loraLib.onChange = () => deviceSync.markDirty('loras');
ckptLib.onChange = () => deviceSync.markDirty('ckpts');
endpointLib.onChange = () => deviceSync.markDirty('endpoints');
loraLib.migrate();

// 古い HTML を掴んでいると、あとから足した共有スクリプトが読まれない。無ければ一度だけ読み直す
falBoot.requireShared(['ckptLib', 'endpointLib']);
initSessionDialog();
initGroupDialog();

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

els.lbOrder.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (btn) setChartOrder(btn.dataset.order);
});
setChartOrder(chartOrder);

// 列幅が変わったら（画面幅の変化・サイドバーの開閉）グラフを描き直す
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    if (chartInput && Math.floor(els.lbChart.clientWidth) !== chartInput.width) drawEloChart();
  }).observe(els.lbChart);
}

els.lightbox.addEventListener('click', closeLightbox);
els.lightboxClose.addEventListener('click', closeLightbox);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.lightbox.hidden) {
    closeLightbox();
    return;
  }
  // 投票ショートカット。入力中・ダイアログ表示中は無効
  if (els.sessionView.hidden || els.votePanel.hidden || !currentPair) return;
  if (els.sessionDialog.open || els.groupDialog.open) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); vote('a'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); vote('b'); }
  else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); vote('draw'); }
  else if (e.key === 's' || e.key === 'S') { e.preventDefault(); skipPair(); }
});

window.addEventListener('pagehide', () => {
  deviceSync.flush(); // 送信待ちの同期があれば離脱前に送っておく
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') deviceSync.pull();
});

renderAll();
deviceSync.pull();
resumeRounds();
