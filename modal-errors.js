'use strict';

/* ==========================================================================
 * Modal 系のエラーを日本語にする（共有）
 *
 * 生成も編集も、失敗したときに返ってくるのは英語の本文だった:
 *
 *   {"detail":"ComfyUI is not running in this container (startup failed)..."}
 *   modal-http: missing credentials for proxy authorization
 *   Modal API error 503: ...
 *
 * これをそのまま画面に出していたので、何が起きたのか・どうすればいいのかが
 * 分からなかった。ここで「日本語の一文 + 対処」に翻訳する。
 *
 * **原文は捨てない。** detail に残し、toError() は console にも出す。
 * 原因調査にはサーバーの生メッセージが要るため。
 *
 * どの層で何が返るかは modal_comfy の HANDOFF / INTEGRATION に対応する:
 *   401 Modal の proxy（GPU は起動していない）
 *   404 エンドポイントが無い
 *   422 パラメータが範囲外
 *   502 ComfyUI がグラフを拒否 / 実行時エラー
 *   503 コンテナで ComfyUI が起動していない（preemption の後など）
 *   504 時間切れ
 * ========================================================================== */

(function () {

// 本文で分かるものはステータスより具体的なので、先に照合する。
// 左が本文のパターン、右が画面に出す日本語。
const BODY_RULES = [
  // --- 入力の不備（利用者が直せる） ---
  [/prompt.{0,3} is required/i, 'プロンプトを入力してください'],
  [/images is required/i, '参照画像を 1 枚以上選んでください'],
  [/images must be \d+ or fewer/i, '参照画像の枚数が上限を超えています'],
  [/too many reference images/i, '参照画像の枚数が上限を超えています'],
  [/(^|\b)(image|mask) is required/i, '画像とマスクの両方が必要です'],
  [/too many loras/i, 'LoRA の数が上限を超えています'],
  [/not found in volume/i,
    '指定した LoRA またはチェックポイントが見つかりませんでした。名前を確認してください'],
  [/exceeds the \d+px limit/i, '画像サイズが上限を超えています。幅と高さを小さくしてください'],
  [/'steps' must be between/i, 'ステップ数が指定できる範囲を外れています'],
  [/'resolution' must be/i, '参照画像のリサイズ指定が範囲外です'],
  [/'shift' must be/i, 'shift の値が範囲外です'],
  [/invalid numeric parameter/i, '数値の指定が正しくありません'],
  [/must be non-empty base64/i, '画像データが正しく送れませんでした。選び直してお試しください'],
  [/(payload|image) too large/i, '送信したデータが大きすぎます。画像を小さくしてお試しください'],

  // --- サーバー側の状態（待てば直ることが多い） ---
  [/comfyui is not running/i,
    'サーバーの準備に失敗しました。少し待ってからもう一度お試しください'],
  [/relaunch attempt failed/i,
    'サーバーの準備に失敗しました。少し待ってからもう一度お試しください'],
  [/generation timed out/i,
    '時間内に生成が終わりませんでした。ステップ数や参照画像を減らしてお試しください'],
  [/no image produced/i, '画像が生成されませんでした。設定を変えてお試しください'],
  [/rejected workflow/i,
    'サーバーが生成の指示を受け付けませんでした（設定の組み合わせが不正な可能性があります）'],
  [/does not match the installed nodes/i,
    'サーバー側の構成と指示が噛み合っていません（デプロイし直しが必要かもしれません）'],

  // --- 設定ミス（運用者が直す） ---
  [/missing credentials for proxy authorization/i,
    'Modal の認証に失敗しました（Proxy Auth トークンを確認してください）'],
  [/modal_proxy_key/i,
    'サーバーに Modal の認証情報が設定されていません（Worker の Secret を確認してください）'],
  [/invalid function call/i,
    'エンドポイントが見つかりませんでした（デプロイされていない可能性があります）'],

  // --- ジョブ管理 ---
  [/job not found/i, 'ジョブが見つかりませんでした（保持期間切れの可能性があります）'],
];

// 本文から何も分からないときの、ステータスだけの説明。
const STATUS_RULES = {
  400: 'リクエストの形式が正しくありませんでした',
  401: 'Modal の認証に失敗しました（Proxy Auth トークンを確認してください）',
  403: 'この操作を行う権限がありません',
  404: '宛先が見つかりませんでした',
  405: 'この操作は許可されていません',
  413: '送信したデータが大きすぎます。画像を小さくしてお試しください',
  415: 'リクエストの形式が正しくありませんでした',
  422: '指定した値が受け付けられませんでした',
  429: '混み合っています。少し待ってからもう一度お試しください',
  500: 'サーバー内部でエラーが発生しました',
  502: '生成に失敗しました（サーバーが処理を完了できませんでした）',
  503: 'サーバーの準備に失敗しました。少し待ってからもう一度お試しください',
  504: '時間内に終わりませんでした。ステップ数や参照画像を減らしてお試しください',
};

const JA = /[ぁ-んァ-ヶ一-龯]/;

// FastAPI は {"detail": "..."} で返す。中身だけ取り出せたらそちらを見る
// （JSON の波括弧ごと画面に出しても読めないため）。
function extractDetail(raw) {
  if (!raw.startsWith('{')) return raw;
  try {
    const obj = JSON.parse(raw);
    const d = obj?.detail ?? obj?.error ?? obj?.message;
    if (typeof d === 'string' && d) return d;
    if (Array.isArray(d) && d.length) return JSON.stringify(d);
  } catch { /* JSON でなければ生のまま使う */ }
  return raw;
}

/**
 * ステータスと本文から日本語の説明を作る。
 * @returns {{status: number|null, message: string, detail: string}}
 */
function describe(status, body) {
  const raw = String(body ?? '').trim();
  const detail = extractDetail(raw);
  const code = Number(status) || null;

  const hit = BODY_RULES.find(([re]) => re.test(detail) || re.test(raw));
  if (hit) return { status: code, message: hit[1], detail: detail.slice(0, 400) };

  // Worker 自身が日本語で返しているものは、そのまま出したほうが具体的。
  if (JA.test(detail)) return { status: code, message: detail.slice(0, 300), detail: '' };

  const message = STATUS_RULES[code]
    || (code ? `エラーが発生しました（HTTP ${code}）` : 'エラーが発生しました');
  return { status: code, message, detail: detail.slice(0, 400) };
}

/**
 * 保存済みジョブの error 文字列を解釈する。
 * Durable Object は `Modal API error 503: {"detail":"..."}` の形で残す。
 */
function describeText(text) {
  const raw = String(text ?? '').trim();
  const m = raw.match(/^(?:Modal API error|HTTP)\s+(\d{3})\s*[:：]?\s*([\s\S]*)$/i);
  if (m) return describe(Number(m[1]), m[2]);
  return describe(null, raw);
}

// 画面に出す文字列。原文は console に回して、表示は日本語だけにする。
function toError(status, body, fallback) {
  const d = describe(status, body);
  const message = d.message || fallback || 'エラーが発生しました';
  if (d.detail && typeof console !== 'undefined') {
    console.warn(`[modal] ${d.status ?? '-'}: ${d.detail}`);
  }
  const err = new Error(message);
  err.status = d.status;
  err.detail = d.detail;
  return err;
}

function fromJobError(text, fallback) {
  const d = describeText(text);
  const message = d.message || fallback || 'エラーが発生しました';
  if (d.detail && typeof console !== 'undefined') {
    console.warn(`[modal] job: ${d.detail}`);
  }
  const err = new Error(message);
  err.status = d.status;
  err.detail = d.detail;
  return err;
}

// レスポンスから直接。本文の読み出しに失敗してもステータスだけで説明する。
async function fromResponse(res, fallback) {
  const text = await res.text().catch(() => '');
  return toError(res.status, text, fallback);
}

window.modalErrors = { describe, describeText, toError, fromJobError, fromResponse };

})();
