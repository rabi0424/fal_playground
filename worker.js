// 個人用 playground のバックエンド（Cloudflare Workers + Durable Object）。
// 静的アセット（index.html など）はこのコードより先に配信されるため、
// ここに来るのはアセットに一致しないパス（/api/*）のみ。
//
// 認証について: このアプリは Cloudflare Access（メール認証）で保護される前提で、
// アプリ内の認証は持たない。Access を有効にせずデプロイすると fal プロキシ等の
// API が誰でも使える状態になるので注意（README 参照）。
import { DurableObject } from 'cloudflare:workers';

// 生成画像・履歴の保存設定
// 画像本体は R2（env.IMAGES）に置く。履歴レコードは Durable Object の SQLite に
// 小さな JSON（プロンプト・設定・画像への参照）として持つ。
//
// 履歴に件数の上限は無い（消えるのは明示的に削除したときだけ）。
const HISTORY_PREFIX = 'hist:'; // 履歴 1 件ぶん（hist:<id>）
const HISTORY_INDEX_PREFIX = 'hidx:'; // 並び順の索引（hidx:<逆順の通し番号>:<id> → id）
const HISTORY_SEQ_KEY = 'history:seq'; // 最後に振った通し番号
const HISTORY_ORDER_KEY = 'history:order'; // 旧レイアウト（並び順を id の配列で 1 キーに）
const HISTORY_LEGACY_KEY = 'history:list'; // さらに旧（全件を 1 キーに詰めていた）

// 通し番号は「大きいほど新しい」。索引キーには (SPAN - seq) を桁揃えで入れるので、
// キーの辞書順＝新しい順になる。Durable Object のキー一覧は辞書順に返るため、
// list({ prefix, startAfter, limit }) がそのままページ送りになる
const HISTORY_SEQ_DIGITS = 15;
const HISTORY_SEQ_SPAN = 10 ** HISTORY_SEQ_DIGITS - 1; // 15 桁に収まる最大値

// 一覧（GET /api/history）の 1 ページぶんの件数。件数の上限を外した以上、
// ここを決めておかないと 1 回の応答が青天井になる
const HISTORY_PAGE_DEFAULT = 500;
const HISTORY_PAGE_MAX = 1000;


// 履歴レコードの id。GET / DELETE のルートが受ける形と揃える（ここを緩くすると、
// 保存はできるのに 1 件取得も削除もできないレコードが作れてしまう）
const HISTORY_ID_RE = /^[\w.-]{1,100}$/;

// Durable Object の一括 get / put / delete は 1 回 128 件まで
const DO_BATCH = 128;

function chunkBatch(items, size = DO_BATCH) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Modal 生成ジョブの設定。ジョブは Durable Object の alarm でサーバー側完結で
// 処理する（クライアントとの接続が切れても結果を取りこぼさないため）
const JOB_TTL_MS = 60 * 60 * 1000; // 完了・失敗ジョブの保持期間
// 走り続けているジョブを打ち切る上限。Wan2.2 + VACE の編集が 900 秒級なので
// その倍以上を取る。ここが無いと、ポーリングが何かの理由で終わらないときに
// クライアントが「編集中…」のまま止まり続ける
const JOB_MAX_RUN_MS = 30 * 60 * 1000;
const JOB_POLL_DELAY_MS = 2000;
// これ以上「予定時刻を過ぎているのに実行されていない」alarm は、配信されないまま
// 残っているものとみなして張り直す。Durable Object の alarm は実行が繰り返し
// 異常終了すると過去の時刻のまま居座ることがあり、その状態を「張られている」と
// 判定すると誰もジョブを進めなくなる（取り込みが resolve のまま永久に止まる）
const ALARM_OVERDUE_MS = 60 * 1000;
const JOB_MAX_SUBMIT_ATTEMPTS = 2; // 送信自体の再試行上限（多重生成・多重課金の防止）

// 画像に焼き込む kind。ジョブの kind から引く（既定は生成）
const JOB_META_KINDS = { edit: 'edit', inpaint: 'inpaint' };

// プロバイダ側の URL は失効しうるので、履歴に残す画像はすべて自分の R2 に取り込む。
//
// 以前はホストの許可リスト（fal / WaveSpeed / Runware のドメイン）で絞っていたが、
// WaveSpeed は出力を別ドメインの CDN（CloudFront）から配信するため漏れていて、
// 編集結果が相手の CDN にしか無い状態で履歴に残っていた。そして許可リストは
// 踏み台対策としても効いていない（任意の URL を含むレコードを保存してから
// /api/capture を呼べば取り込めるので、所有者にとっての制限になっていない）。
// このアプリは Cloudflare Access の内側にあり、対象は自分が保存するレコードに
// 載っている URL だけなので、https の画像はすべて取り込む

// Poe の OpenAI 互換 API（部分AI編集で使用）。キーは Worker の Secret（POE_API_KEY）
const POE_API_URL = 'https://api.poe.com/v1/chat/completions';

// /api/upload で受け付ける画像の上限（デコード後のバイト数）
const UPLOAD_MAX_BYTES = 40 * 1024 * 1024;

/* ---------- Civitai → Hugging Face LoRA 取り込み ---------- */
// Civitai のモデルページ URL / ダウンロード URL から LoRA をダウンロードし、
// R2 に一時保存 → Hugging Face リポジトリへ LFS アップロード → コミットする。
// 処理は他のジョブと同じく Durable Object の alarm でサーバー側完結
//（ただし生成ジョブのポーリングを妨げないよう専用の DO インスタンスで動かす）。
// 必要な Secret: HF_TOKEN（write 権限）、CIVITAI_TOKEN（DL はほぼログイン必須）

const HF_BASE = 'https://huggingface.co';
// civitai.com と既知のミラー（civitai.red 系）を許可する
const CIVITAI_HOSTS = /(^|\.)(civitai\.(com|red)|civitaired\.\w+)$/;
const LORA_STAGING_PREFIX = 'lora-staging/';
const LORA_IMPORT_MAX_ATTEMPTS = 4; // 連続エラーでの打ち切り上限（進捗があれば戻る）
// 進捗のたびに attempts を戻すため、「少し進んでは固まる」を繰り返すジョブは
// attempts だけでは止まらない。再開を含む通算の実行回数にも上限を設ける
// （予算切れによる正常な中断も 1 回に数えるので、暴走を止めるためだけの大きめの値。
// 30 GB を細かいパートで送る場合でも数百回で収まる。エラーの繰り返しは attempts 側で
// 先に止まる）
const LORA_IMPORT_MAX_RUNS = 1000;
// 1 回の alarm 実行で転送するパート数・バイト数の上限。Workers / Durable Object には
// 1 回の呼び出しあたりの CPU 時間・subrequest 数の上限があり、巨大なチェックポイントを
// 1 回で流し切ろうとすると実行ごと打ち切られる。打ち切りは例外にならないので次の alarm も
// 張られず、ジョブが取り残される。予算を使い切ったらこちらから中断して次の alarm に
// 続きを渡す（完了パートは記録済みなのでやり直しにはならない）
const LORA_PARTS_PER_RUN = 16;
const LORA_BYTES_PER_RUN = 2 * 1024 * 1024 * 1024;
// アップロード計画（LFS の転送先一覧）を作り直すまでの期間。署名 URL の寿命より短くする
const LORA_UPLOAD_PLAN_TTL_MS = 6 * 60 * 60 * 1000;
// 進捗が完全に止まったジョブを打ち切るまでの猶予。alarm が異常終了して pending の
// まま取り残されたジョブも、これを過ぎればポーリング側から error にする
const LORA_STALL_TIMEOUT_MS = 15 * 60 * 1000;
// alarm が消えたまま止まっているジョブの alarm を張り直すまでの猶予
const LORA_RESUME_STALE_MS = 3 * 60 * 1000;
// 転送 1 本あたりのタイムアウト下限（相手が無音のまま接続を保つケースの保険）
const LORA_TRANSFER_MIN_TIMEOUT_MS = 10 * 60 * 1000;
// メタデータ・制御系 API のタイムアウト。応答が小さいので長く待つ意味がなく、
// ここが返ってこないと「モデル情報を確認中…」のまま alarm ごと固まる
const LORA_API_TIMEOUT_MS = 60 * 1000;
const LORA_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4GB。LoRA としては十分すぎる上限
// チェックポイント取り込みの上限。R2 ステージングは multipart 保存に対応しているので
// 本質的な上限ではなく、異常なサイズの取り込みを弾くための安全弁
const CKPT_MAX_BYTES = 30 * 1024 * 1024 * 1024;
// R2 の単発 PUT で安全に置けるサイズ。これを超えるステージングは multipart で保存する
const R2_SINGLE_PUT_MAX = 4 * 1024 * 1024 * 1024;
// multipart のパートサイズ（R2 の仕様で最後のパート以外は同一サイズである必要がある）。
// 巨大ファイルは 256 MiB、それ以外は 64 MiB（小さいほど並列・再開の粒度が細かい）
const R2_PART_SIZE = 256 * 1024 * 1024;
const R2_SMALL_PART_SIZE = 64 * 1024 * 1024;
// これ以上のサイズで Range 対応・SHA256 公称値ありなら、並列分割ダウンロードを使う
const CHUNKED_DL_MIN_BYTES = 64 * 1024 * 1024;
// 並列度。Workers の同時アウトバウンド接続上限（6）の内側に収める
const DL_CONCURRENCY = 4;
const UPLOAD_CONCURRENCY = 2;

// 転送 1 本ぶんの中断シグナル。応答が来ないまま接続だけ生き続ける相手に当たると
// fetch は永久に待ってしまい、alarm が返らずジョブごと固まるので必ず付ける。
// 期限は「最低 10 分、または 1 MB/s で流し切れる時間」の長いほう（bytes=0 なら最低値）
function transferSignal(bytes = 0) {
  const budget = (Number(bytes) || 0) / (1024 * 1024) * 1000;
  return AbortSignal.timeout(Math.max(LORA_TRANSFER_MIN_TIMEOUT_MS, budget));
}

// メタデータ取得やアップロードの制御系リクエスト用の中断シグナル
function apiSignal() {
  return AbortSignal.timeout(LORA_API_TIMEOUT_MS);
}

// エラーメッセージ用のステップ名（クライアント側の表示と揃える）
const CIVITAI_STEP_NAMES = {
  resolve: 'モデル情報の確認',
  download: 'Civitai からのダウンロード',
  upload: 'Hugging Face へのアップロード',
  commit: 'リポジトリへのコミット',
};

// Civitai の URL を解釈する。対応形式:
//   https://civitai.com/models/{modelId}(?modelVersionId={vid})
//   https://civitai.com/api/download/models/{vid}(?...)
function civitaiParseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !CIVITAI_HOSTS.test(u.hostname)) return null;
  let m = u.pathname.match(/^\/api\/download\/models\/(\d+)/);
  if (m) return { origin: u.origin, versionId: m[1], directUrl: u.toString() };
  m = u.pathname.match(/^\/models\/(\d+)/);
  if (m) {
    const vid = u.searchParams.get('modelVersionId');
    return { origin: u.origin, modelId: m[1], versionId: /^\d+$/.test(vid ?? '') ? vid : null };
  }
  return null;
}

// Civitai 公開 API の呼び出し。ミラー URL が渡された場合はそのホストを試した後
// 本家 civitai.com にフォールバックする（ミラーの API 互換性が不明なため）
async function civitaiApi(path, origin, env) {
  const headers = { 'User-Agent': 'fal-playground' };
  if (env.CIVITAI_TOKEN) headers.Authorization = `Bearer ${env.CIVITAI_TOKEN}`;
  const origins = [...new Set([origin, 'https://civitai.com'])];
  let lastErr;
  for (const o of origins) {
    try {
      const res = await fetch(`${o}/api/v1${path}`, { headers, signal: apiSignal() });
      if (res.ok) return await res.json();
      lastErr = new Error(`Civitai API error ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// HF のファイルパスとして安全な名前に整える（.safetensors を保証する）
function sanitizeLoraFileName(name) {
  let s = String(name ?? '').replace(/[^\w.-]+/g, '_').replace(/^[_.]+/, '').slice(0, 200);
  s = s.replace(/\.safetensors$/i, '');
  if (!s.replace(/[_.-]/g, '')) s = 'civitai-model'; // 非 ASCII 名などで空になった場合
  return `${s}.safetensors`;
}

// .safetensors と対で保存するサイト情報 JSON のパス（foo.safetensors → foo.civitai.json）
function civitaiMetaJsonPath(fileName) {
  return fileName.replace(/\.safetensors$/i, '') + '.civitai.json';
}

// HF の resolve URL を組み立てる。パス全体を encodeURIComponent すると
// サブフォルダの「/」が %2F になり、HF 一括登録経由の URL と食い違って
// Modal 生成へ渡る LoRA 名が変わってしまうため、セグメント単位でエンコードする
function hfResolveUrl(repo, path) {
  return `${HF_BASE}/${repo}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`;
}

// .safetensors の HF resolve URL から、隣に置いた .civitai.json の URL を作る。
// 想定外の URL（HF 以外・別の拡張子）は null を返して呼び出し側で弾く
function hfMetaJsonUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'huggingface.co') return null;
  if (!/^\/[\w.-]+\/[\w.-]+\/resolve\/[^/]+\/.+\.safetensors$/i.test(u.pathname)) return null;
  return `${u.origin}${civitaiMetaJsonPath(u.pathname)}`;
}

// 保存した JSON から、ライブラリ表示に使う項目だけ取り出す
function civitaiMetaSummary(doc) {
  const words = Array.isArray(doc?.version?.trainedWords) ? doc.version.trainedWords : [];
  return {
    trigger: words.filter((w) => typeof w === 'string' && w.trim() !== '').join(', ') || null,
    base: doc?.version?.baseModel ?? null,
    modelName: doc?.model?.name ?? null,
    versionName: doc?.version?.name ?? null,
    creator: doc?.model?.creator ?? null,
    source: doc?.source ?? null,
    savedAt: doc?.savedAt ?? null,
  };
}

// 取り込み時点の Civitai の情報を JSON として保存するための文書を組み立てる。
// トリガーワード・説明・サンプル画像の生成パラメータなど「後から使い方を調べる」
// ための情報を残す。画像本体は保存しない（URL と生成設定のみ）。
// ジョブレコード（DO storage の 128KiB 制限）に載せるため各フィールドは切り詰める
function buildCivitaiMetaDoc(version, model, sourceUrl) {
  const clip = (s, n) => (typeof s === 'string' && s !== '' ? s.slice(0, n) : null);
  return {
    savedAt: new Date().toISOString(),
    source: sourceUrl,
    modelId: model?.id ?? version.modelId ?? null,
    versionId: version.id ?? null,
    model: {
      name: model?.name ?? version.model?.name ?? null,
      type: model?.type ?? version.model?.type ?? null,
      nsfw: model?.nsfw ?? version.model?.nsfw ?? null,
      creator: model?.creator?.username ?? null,
      tags: (model?.tags ?? []).slice(0, 30),
      description: clip(model?.description, 8000),
    },
    version: {
      name: version.name ?? null,
      baseModel: version.baseModel ?? null,
      trainedWords: version.trainedWords ?? [],
      publishedAt: version.publishedAt ?? null,
      description: clip(version.description, 8000),
      stats: version.stats ?? null,
      files: (version.files ?? []).map((f) => ({
        name: f.name ?? null,
        sizeKB: f.sizeKB ?? null,
        sha256: f.hashes?.SHA256 ?? null,
        primary: !!f.primary,
      })),
    },
    images: (version.images ?? []).slice(0, 8).map((img) => ({
      url: img.url ?? null,
      width: img.width ?? null,
      height: img.height ?? null,
      ...(img.meta && typeof img.meta === 'object' ? {
        meta: {
          prompt: clip(img.meta.prompt, 1500),
          negativePrompt: clip(img.meta.negativePrompt, 1000),
          steps: img.meta.steps ?? null,
          sampler: img.meta.sampler ?? null,
          cfgScale: img.meta.cfgScale ?? null,
          seed: img.meta.seed ?? null,
        },
      } : {}),
    })),
  };
}

// URL からモデル情報とダウンロード対象ファイルを解決する。
// ダウンロード URL 直指定でメタデータが取れない場合は最小限の情報で返す
//（ファイル名は DL 時の Content-Disposition で補う）。
// 返り値の doc は保存用のサイト情報 JSON（取得できなければ null）
async function civitaiResolve(rawUrl, env) {
  const parsed = civitaiParseUrl(rawUrl);
  if (!parsed) {
    throw new Error('URL を解釈できません（civitai.com のモデルページ URL またはダウンロード URL を入力してください）');
  }
  let version = null;
  let model = null;
  try {
    if (parsed.versionId) {
      version = await civitaiApi(`/model-versions/${parsed.versionId}`, parsed.origin, env);
      // モデル本体の説明・タグ・作者はバージョン API に無いので別途取得（任意）
      const modelId = version?.modelId ?? null;
      if (modelId) {
        try {
          model = await civitaiApi(`/models/${modelId}`, parsed.origin, env);
        } catch { /* モデル情報は無くても続行できる */ }
      }
    } else {
      model = await civitaiApi(`/models/${parsed.modelId}`, parsed.origin, env);
      version = model?.modelVersions?.[0] ?? null;
      if (!version) throw new Error('モデルバージョンが見つかりません');
    }
  } catch (err) {
    // ダウンロード URL 直指定ならメタデータなしで続行できる
    if (!parsed.directUrl) throw err;
  }

  if (!version) {
    return {
      versionId: parsed.versionId,
      modelId: parsed.modelId ?? null,
      modelName: null,
      modelType: null,
      versionName: null,
      baseModel: null,
      fileName: null,
      sizeKB: null,
      sha256: null,
      downloadUrl: parsed.directUrl,
      metaWarning: 'メタデータを取得できませんでした（ファイル名・ハッシュ検証なしで取り込みます）',
      doc: null,
    };
  }

  const files = version.files ?? [];
  const file = files.find((f) => f.primary)
    ?? files.find((f) => f.metadata?.format === 'SafeTensor')
    ?? files[0];
  if (!file) throw new Error('このバージョンにダウンロード可能なファイルがありません');

  return {
    versionId: String(version.id ?? parsed.versionId ?? ''),
    // Runware の AIR（civitai:モデルID@バージョンID）を組み立てるのに要る
    modelId: String(version.modelId ?? model?.id ?? parsed.modelId ?? '') || null,
    modelName: model?.name ?? version.model?.name ?? null,
    modelType: model?.type ?? version.model?.type ?? null,
    versionName: version.name ?? null,
    baseModel: version.baseModel ?? null,
    fileName: sanitizeLoraFileName(file.name),
    sizeKB: file.sizeKB ?? null,
    sha256: (file.hashes?.SHA256 ?? '').toLowerCase() || null,
    downloadUrl: parsed.directUrl ?? file.downloadUrl
      ?? `${parsed.origin}/api/download/models/${version.id}`,
    metaWarning: null,
    doc: buildCivitaiMetaDoc(version, model, rawUrl),
  };
}

function hfAuthHeaders(env) {
  return env.HF_TOKEN ? { Authorization: `Bearer ${env.HF_TOKEN}` } : {};
}

// HF リポジトリのファイル一覧（LFS の oid 付き）。expand 付きの応答はページング
// されるので Link ヘッダの rel="next" を辿って全件集める。
// 失敗時は { status } を投げる（404 = リポジトリなし等をルート側で区別するため）
async function fetchHfTree(repo, env) {
  const entries = [];
  let next = `${HF_BASE}/api/models/${repo}/tree/main?recursive=true&expand=true`;
  for (let page = 0; page < 20 && next; page++) {
    const res = await fetch(next, {
      headers: { 'User-Agent': 'fal-playground', ...hfAuthHeaders(env) },
      signal: apiSignal(),
    });
    if (!res.ok) {
      if (entries.length > 0) break; // 途中で失敗したら取れた分だけ返す
      const err = new Error(`HF tree error ${res.status}`);
      err.status = res.status;
      err.body = await res.text();
      throw err;
    }
    const batch = await res.json();
    if (Array.isArray(batch)) entries.push(...batch);
    const link = res.headers.get('Link') || '';
    next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return entries;
}

/* ---------- PNG メタデータ焼き込み ---------- */
// 生成設定の JSON を PNG の iTXt チャンクとして埋め込む（ComfyUI がワークフローを
// 画像に焼き込むのと同じ発想）。ダウンロードした画像ファイルだけから設定を確認できる

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_META_KEYWORD = 'playground';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// PNG でなければそのまま返す（fal は JPEG を返すモデルもある）
// 先頭が PNG のシグネチャか。Modal が画像以外（202 の空応答・エラー JSON）を
// 返したときに、それを画像として保存してしまわないための番人
function looksLikePng(buf) {
  const src = new Uint8Array(buf);
  return src.length >= 33 && PNG_SIGNATURE.every((b, i) => src[i] === b);
}

function embedPngMetadata(buf, text) {
  const src = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (src.length < 33 || !PNG_SIGNATURE.every((b, i) => src[i] === b)) return src;
  const ihdrLen = new DataView(src.buffer, src.byteOffset, src.byteLength).getUint32(8);
  const insertAt = 8 + 12 + ihdrLen; // シグネチャ + IHDR チャンク全体の直後

  // iTXt: keyword \0 圧縮フラグ(0) 圧縮方式(0) 言語タグ \0 翻訳キーワード \0 本文(UTF-8)
  const enc = new TextEncoder();
  const data = new Uint8Array([...enc.encode(PNG_META_KEYWORD), 0, 0, 0, 0, 0, ...enc.encode(text)]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(enc.encode('iTXt'), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));

  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(src.subarray(insertAt), insertAt + chunk.length);
  return out;
}

/* ---------- 画像メタデータ（正規化） ----------
 *
 * 焼き込む JSON は、経路ごとに勝手な形になっていた（直下に並べる・input に
 * 入れる・parameters に入れる・source 名がばらばら）。読む側がそのすべてを
 * 知らないといけないのは持たないので、形を 1 つに決めてある:
 *
 *   { app, v, kind, provider, model, prompt, negative, seed,
 *     width, height, steps, cfg, loras[{path,scale}], created, raw{…} }
 *
 * よく使う項目は固定の名前で持ち、経路固有のもの（Modal の sampler_name、
 * ComfyUI のグラフなど）は raw にまとめて残す。書くのは storeImage だけ、
 * 読むのは readImageMeta だけ。アーカイブ側のアプリもこの形を前提にする
 */

const IMAGE_META_APP = 'fal playground';
const IMAGE_META_VERSION = 1;
const IMAGE_META_LORA_MAX = 20; // 焼き込みが際限なく育たないように

// 何をした画像か。generate=生成 / edit=画像編集 / inpaint=塗った範囲の描き直し /
// composite=編集結果を元画像へ合成したもの / input=編集の入力として上げたもの
const IMAGE_META_KINDS = new Set(['generate', 'edit', 'inpaint', 'composite', 'input']);

// source 名で経路を区別していたころの焼き込みを読むための対応表
const LEGACY_META_KINDS = {
  'poe-edit': 'edit',
  'wan-vace-edit': 'edit',
  'lanpaint-inpaint': 'inpaint',
  'krea2-modal': 'generate',
  capture: 'generate',
  'imgedit-input': 'input',
  'imgedit-masked': 'composite',
};

// 正規化で拾う名前。ここに載っていない項目が raw 行きになる。
// 同じ意味の別名（fal の num_inference_steps と Modal の steps など）も載せる
const IMAGE_META_FIELDS = new Set([
  'app', 'v', 'kind', 'source', 'provider', 'model', 'model_id', 'prompt',
  'negative', 'negative_prompt', 'seed', 'width', 'height', 'image_size',
  'steps', 'num_inference_steps', 'cfg', 'guidance_scale', 'cfg_scale',
  'loras', 'created', 'raw', 'input', 'parameters',
]);

function metaText(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function metaNumber(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? n : null;
}

// model 名の頭でどのサービスか分かる（fal-ai/… modal/… poe/… wavespeed-ai/… runware:…）
function metaProvider(model) {
  const id = String(model ?? '');
  if (id.startsWith('fal-ai/')) return 'fal';
  if (id.startsWith('modal/')) return 'modal';
  if (id.startsWith('poe/')) return 'poe';
  if (id.startsWith('wavespeed')) return 'wavespeed';
  if (id.startsWith('runware')) return 'runware';
  return null;
}

// LoRA の並び。fal は {path, scale}、Modal は {name, strength}、ComfyUI は
// {lora_name, strength_model} と呼び方が違うので、ここで 1 つに寄せる
function metaLoras(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const l of list) {
    if (!l || typeof l !== 'object') continue;
    const path = metaText(l.path) ?? metaText(l.name) ?? metaText(l.lora_name) ?? metaText(l.air);
    if (!path) continue;
    out.push({ path, scale: metaNumber(l.scale ?? l.strength ?? l.strength_model ?? l.weight) ?? 1 });
    if (out.length >= IMAGE_META_LORA_MAX) break;
  }
  return out;
}

// 正規化で拾わなかった項目を raw に集める。v:1 の raw はそのまま引き継ぐ
//（ComfyUI のグラフのように、名前が正規化の項目と重なるものが入っているため）
function imageMetaRaw(meta) {
  const raw = meta.raw && typeof meta.raw === 'object' ? { ...meta.raw } : {};
  const add = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (!IMAGE_META_FIELDS.has(k) && v !== undefined) raw[k] = v;
    }
  };
  add(meta.parameters);
  add(meta.input);
  add(meta);
  return raw;
}

// どんな形で渡されても v:1 の形にして返す。
// 設定が直下・input・parameters のどこにあっても拾えるよう、まず 1 つの袋にまとめる
export function normalizeImageMeta(src) {
  const meta = src && typeof src === 'object' && !Array.isArray(src) ? src : {};
  const input = meta.input && typeof meta.input === 'object' ? meta.input : {};
  const params = meta.parameters && typeof meta.parameters === 'object' ? meta.parameters : {};
  const bag = { ...params, ...input, ...meta }; // 直下が最優先、次に input
  const size = bag.image_size && typeof bag.image_size === 'object' ? bag.image_size : {};
  const model = metaText(bag.model) ?? metaText(bag.model_id);

  return {
    app: IMAGE_META_APP,
    v: IMAGE_META_VERSION,
    kind: IMAGE_META_KINDS.has(meta.kind) ? meta.kind : (LEGACY_META_KINDS[meta.source] ?? 'generate'),
    provider: metaText(meta.provider) ?? metaProvider(model),
    model,
    prompt: metaText(bag.prompt),
    negative: metaText(bag.negative) ?? metaText(bag.negative_prompt),
    seed: metaNumber(bag.seed),
    width: metaNumber(bag.width) ?? metaNumber(size.width),
    height: metaNumber(bag.height) ?? metaNumber(size.height),
    steps: metaNumber(bag.steps) ?? metaNumber(bag.num_inference_steps),
    cfg: metaNumber(bag.cfg) ?? metaNumber(bag.guidance_scale) ?? metaNumber(bag.cfg_scale),
    loras: metaLoras(bag.loras),
    created: metaText(meta.created) ?? new Date().toISOString(),
    raw: imageMetaRaw(meta),
  };
}

// 経路固有の中身を落とした要約。カタログの params 列に入れるのはこちら
//（細かい設定が要るときは record を見ればよく、列を太らせる意味がない）
function imageMetaSummary(meta) {
  const { raw: _raw, ...rest } = normalizeImageMeta(meta);
  return rest;
}

/* ---------- 焼き込みを読む ---------- */

// PNG のテキストチャンクを { keyword: text } で返す。PNG でなければ null。
// 圧縮された本文（zTXt・圧縮フラグ付きの iTXt）は deflate なので読み飛ばす
function readPngTextChunks(buf) {
  const src = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (src.length < 33 || !PNG_SIGNATURE.every((b, i) => src[i] === b)) return null;
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const dec = new TextDecoder();
  const out = new Map();
  for (let at = 8; at + 12 <= src.length;) {
    const len = view.getUint32(at);
    if (!Number.isFinite(len) || at + 12 + len > src.length) break; // 途中で切れている
    const type = dec.decode(src.subarray(at + 4, at + 8));
    if (type === 'IEND') break;
    if (type === 'tEXt' || type === 'iTXt') {
      const body = src.subarray(at + 8, at + 8 + len);
      const zero = body.indexOf(0);
      const keyword = zero > 0 ? dec.decode(body.subarray(0, zero)) : null;
      let text = null;
      if (keyword && type === 'tEXt') {
        text = dec.decode(body.subarray(zero + 1));
      } else if (keyword && body[zero + 1] === 0) {
        // iTXt: keyword \0 圧縮フラグ 圧縮方式 言語タグ \0 翻訳キーワード \0 本文
        const lang = body.indexOf(0, zero + 3);
        const trans = lang >= 0 ? body.indexOf(0, lang + 1) : -1;
        if (trans >= 0) text = dec.decode(body.subarray(trans + 1));
      }
      if (keyword && text !== null && !out.has(keyword)) out.set(keyword, text);
    }
    at += 12 + len;
  }
  return out;
}

// ComfyUI の焼き込み（prompt = API 形式のグラフ、workflow = 画面の配線）を読む。
// ノードの種類で当たりを付けるので、変わったワークフローでは埋まらない項目も出る。
// 元のグラフは raw に丸ごと残すので、取りこぼしはそちらから拾える
function comfyImageMeta(chunks) {
  const graph = safeJsonParse(chunks.get('prompt') ?? '');
  const nodes = graph && typeof graph === 'object' ? graph : {};
  // ノードの入力は [ノード id, 出力番号] で他のノードを指す
  const textOf = (ref) => (Array.isArray(ref) ? metaText(nodes[ref[0]]?.inputs?.text) : null);

  let sampler = null;
  let model = null;
  let width = null;
  let height = null;
  const loras = [];
  for (const node of Object.values(nodes)) {
    const cls = String(node?.class_type ?? '');
    const inp = node?.inputs ?? {};
    if (!sampler && /KSampler|SamplerCustom/i.test(cls)) sampler = inp;
    if (!model && /CheckpointLoader|UNETLoader|DiffusionLoader/i.test(cls)) {
      model = metaText(inp.ckpt_name) ?? metaText(inp.unet_name) ?? metaText(inp.model_name);
    }
    if (/LoraLoader/i.test(cls)) loras.push(inp);
    if (/EmptyLatentImage|EmptySD3LatentImage|EmptyLatent/i.test(cls)) {
      width = metaNumber(inp.width) ?? width;
      height = metaNumber(inp.height) ?? height;
    }
  }

  return {
    kind: 'generate',
    provider: 'comfyui',
    model,
    prompt: textOf(sampler?.positive),
    negative: textOf(sampler?.negative),
    seed: sampler?.seed ?? sampler?.noise_seed ?? null,
    steps: sampler?.steps ?? null,
    cfg: sampler?.cfg ?? null,
    width,
    height,
    loras: metaLoras(loras),
    raw: Object.fromEntries([...chunks].map(([k, v]) => [k, safeJsonParse(v) ?? v])),
  };
}

// A1111 / Forge 系の焼き込み（parameters に 1 枚のテキスト）を読む。
//   プロンプト
//   Negative prompt: …
//   Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 512x768, Model: …
function a1111ImageMeta(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let last = lines.length - 1;
  while (last > 0 && lines[last].trim() === '') last--;
  // 最終行が「Key: value, …」なら設定行。そうでなければ全部プロンプト扱い
  const isSettings = /^[A-Za-z][\w ]*:/.test(lines[last] ?? '') && lines[last].includes(',');
  const settings = isSettings ? lines[last] : '';
  const head = lines.slice(0, isSettings ? last : lines.length).join('\n');

  const NEG = 'Negative prompt:';
  const negAt = head.indexOf(NEG);
  const fields = new Map();
  for (const m of settings.matchAll(/([A-Za-z][\w ]*?):\s*("[^"]*"|[^,]*)/g)) {
    fields.set(m[1].trim().toLowerCase(), m[2].trim().replace(/^"|"$/g, ''));
  }
  const size = (fields.get('size') ?? '').match(/^(\d+)\s*x\s*(\d+)$/);

  return {
    kind: 'generate',
    provider: 'a1111',
    model: fields.get('model') ?? null,
    prompt: (negAt >= 0 ? head.slice(0, negAt) : head).trim(),
    negative: negAt >= 0 ? head.slice(negAt + NEG.length).trim() : null,
    seed: fields.get('seed') ?? null,
    steps: fields.get('steps') ?? null,
    cfg: fields.get('cfg scale') ?? null,
    width: size?.[1] ?? null,
    height: size?.[2] ?? null,
    raw: Object.fromEntries(fields),
  };
}

// 画像を読んで v:1 のメタを返す（読めなければ null）。このアプリが焼いたもの・
// ComfyUI・A1111 のどれでも同じ形で返るので、呼ぶ側は経路を気にしなくてよい。
// アーカイブ側のアプリもこれを使う（だから export してある）
export function readImageMeta(buf) {
  const chunks = readPngTextChunks(buf);
  if (!chunks || chunks.size === 0) return null;

  const own = safeJsonParse(chunks.get(PNG_META_KEYWORD) ?? '');
  if (own) return normalizeImageMeta(own);
  if (chunks.has('prompt') || chunks.has('workflow')) return normalizeImageMeta(comfyImageMeta(chunks));
  if (chunks.has('parameters')) return normalizeImageMeta(a1111ImageMeta(chunks.get('parameters')));
  return null;
}

/* ---------- helpers ---------- */

// data URI（または生の base64 文字列）を { mime, bytes } に変換する。
// 画像以外の MIME や壊れた base64 は null を返す
function decodeImageDataUri(input) {
  if (typeof input !== 'string' || input === '') return null;
  let mime = 'image/png';
  let b64 = input;
  const m = input.match(/^data:([\w/+.-]+);base64,(.*)$/s);
  if (m) {
    mime = m[1];
    b64 = m[2];
  }
  if (!mime.startsWith('image/')) return null;
  let bin;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime, bytes };
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000; // 引数上限を避けて分割する
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Poe（OpenAI 互換 API）の応答テキストから画像 URL を取り出す。
// 画像ボットは Markdown の画像リンク（または裸の URL）として返す
function extractImageUrl(content) {
  if (typeof content !== 'string') return null;
  const md = content.match(/!\[[^\]]*\]\((https?:[^)\s]+)\)/);
  if (md) return md[1];
  const link = content.match(/\[[^\]]*\]\((https?:[^)\s]+)\)/);
  if (link) return link[1];
  const bare = content.match(/https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/i);
  return bare ? bare[0] : null;
}

// 履歴レコード内の画像リスト（通常は images、比較レコードは variants[].images）を
// その画像群に適用された LoRA とセットで返す
function recordImageLists(record) {
  if (Array.isArray(record?.variants)) {
    return record.variants.map((v) => ({ images: v.images ?? [], loras: v.loras ?? null }));
  }
  return [{ images: record?.images ?? [], loras: record?.loras ?? null }];
}

// 索引キー。逆順（SPAN - seq）を桁揃えして入れるので、辞書順＝新しい順になる。
// カタログは D1 に移したので、これらは Durable Object に残っている過去のレコードを
// 新しい順に取り出すため（＝移行のため）だけに使う
function historyIndexKey(seq, id) {
  return HISTORY_INDEX_PREFIX + String(HISTORY_SEQ_SPAN - seq).padStart(HISTORY_SEQ_DIGITS, '0') + ':' + id;
}

// 索引キーから通し番号を戻す。レコード側の seq と突き合わせて、
// 差し替えで振り直された古い索引を見分けるのに使う
function historyIndexSeq(key) {
  const n = Number(key.slice(HISTORY_INDEX_PREFIX.length, HISTORY_INDEX_PREFIX.length + HISTORY_SEQ_DIGITS));
  return Number.isFinite(n) ? HISTORY_SEQ_SPAN - n : NaN;
}

// このアプリが配信している画像 URL から id を取り出す（/api/krea2/image/ は旧 URL 互換）
// 末尾の ?v=... は差し替え時のキャッシュ避け（/api/upload の replace）。
// 同じキーを指すので、削除対象の判定では無視する
function localImageId(u) {
  const m = typeof u === 'string'
    ? u.match(/^\/api(?:\/krea2)?\/image\/([0-9a-f]{64}|[0-9a-f]{32})(?:\?.*)?$/) : null;
  return m ? m[1] : null;
}

/* ---------- 生成履歴のカタログ（D1） ----------
 *
 * 正はここ。Durable Object の KV に索引を手で作るのをやめ、SQLite の表にした。
 * 並び替えもページ送りも SQL に任せられるうえ、アーカイブ側のアプリからも
 * 同じ DB をバインドして共有できる（Durable Object は 1 インスタンスが
 * 単一スレッドなので、そこを通すと直列点をもう 1 つ作ることになる）。
 *
 * 無料プランの D1 は 1 リクエストあたり 50 クエリ・1 クエリあたり 100 個の
 * bound parameter までなので、まとめ書きはその範囲で刻む。
 */

const HISTORY_SOURCE = 'playground'; // この画面が作ったレコードの source
const D1_MAX_BIND = 90; // bound parameter の上限 100 に対して少し余裕を取る
const HISTORY_MIGRATE_BATCH = 60; // 1 度に Durable Object から引き取る件数
// 無料プランの D1 は 1 リクエスト 50 クエリまで。裏の片付けはそのうちの一部しか
// 使わないよう、1 リクエストにつき 1 回ぶんで打ち切る（残りは次のリクエストで）
const HISTORY_MIGRATE_BUDGET = 12; // 1 リクエストで移行に使うクエリ数の上限
const HISTORY_LINKS_BUDGET = 10; // 画像参照の作り直しに使うクエリ数の上限
const HISTORY_LINKS_PAGE = 50;
const HISTORY_CLEAR_BUDGET = 40; // 全消し 1 リクエストで使うクエリ数の上限
const HISTORY_CLEAR_PAGE = 200;

// meta の覚書。スキーマ版が上がると、次のアクセスで DDL と作り直しが走る
const META_SCHEMA = 'schema_version';
const META_MIGRATED = 'history_migrated';
const META_LINKS = 'image_links_rebuilt';
const META_SEARCH = 'search_backfilled';
const META_PARAMS = 'params_backfilled';
const META_LINKS_CURSOR = 'image_links_cursor';
const META_GC_CURSOR = 'image_gc_cursor';
const META_GC_STATS = 'image_gc_stats';
const SCHEMA_VERSION = '4';

// 自分が配信している画像の id。64 桁は内容アドレス（中身の sha256）、
// 32 桁はそうする前に置いた画像（ランダム UUID）。どちらもそのまま配信する
const IMAGE_ID_RE = /^([0-9a-f]{64}|[0-9a-f]{32})$/;
// 掃除の対象にしてよい R2 のキー。許可リストにするのは、このバケットに
// LoRA 取り込みの一時ファイル（lora-staging/...）も同居しているため。
// 除外リスト方式だと、将来べつの用途を足したときに巻き添えにする
const IMAGE_KEY_RE = /^([0-9a-f]{64}|[0-9a-f]{32})\.png$/;
// 参照が無いと分かってから実際に消すまでの猶予。画像編集は「画像を選んだ瞬間」に
// アップロードし、履歴に載るのは編集が終わってからなので、その間は参照ゼロになる
const IMAGE_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 便乗実行の間隔
const IMAGE_GC_BUDGET = 30; // 1 回の掃除で使う D1 クエリ数の上限
const IMAGE_GC_PAGE = 200; // R2 を 1 度に列挙する件数
// 取り込み漏れを 1 回で何枚拾うか。1 枚につき外部への取得・R2 への保存・
// D1 の書き換えが要るので、無料プランの 1 リクエスト 50 クエリに収まる数にする
const HISTORY_CAPTURE_BUDGET = 6;

const HISTORY_COLS = [
  'seq', 'id', 'source', 'type', 'created', 'model', 'prompt', 'search', 'params', 'record', 'mask',
];

// 検索は search 列への LIKE。索引は効かないが、この規模では十分で、
// FTS5（trigram）は必要になってから足せる（列さえあれば差分は小さい）。
// 空白区切りの AND 検索なので、語をいくつまで受けるか決めておく
const HISTORY_SEARCH_TOKENS = 8;
const HISTORY_SEARCH_PAGE = 60; // 検索文字列を埋め戻すときの 1 回ぶん
const HISTORY_SEARCH_BUDGET = 8;

// params 列（正規化した生成設定）の埋め戻し。1 リクエストで使うクエリ数の上限も
// 検索と同じ考え方で決める
const HISTORY_PARAMS_PAGE = 60;
const HISTORY_PARAMS_BUDGET = 8;

// schema.sql と同じ内容。Git 連携デプロイでは wrangler の migrations が走らないので、
// 最初に履歴へ触れたときにここから用意する。
//
// 順番が要る: 表 → 列の追加 → 索引。既にある表には CREATE TABLE IF NOT EXISTS が
// 何もしないので、あとから足した列は ALTER でしか入らない。索引をその前に流すと
// 「no such column」で落ちる（実際に image_id でそれをやって、履歴 API を
// まるごと 500 にした）
const HISTORY_TABLES = [
  `CREATE TABLE IF NOT EXISTS history (
     seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
     source TEXT NOT NULL DEFAULT 'playground', type TEXT NOT NULL DEFAULT '',
     created INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL DEFAULT '',
     prompt TEXT NOT NULL DEFAULT '', search TEXT NOT NULL DEFAULT '',
     params TEXT NOT NULL DEFAULT '', record TEXT NOT NULL, mask TEXT)`,
  `CREATE TABLE IF NOT EXISTS history_images (
     url TEXT NOT NULL, history_id TEXT NOT NULL, image_id TEXT,
     PRIMARY KEY (url, history_id))`,
  `CREATE TABLE IF NOT EXISTS image_gc (
     image_id TEXT PRIMARY KEY, marked_at INTEGER NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
];

// 既にある表への列の追加。列がある場合は「duplicate column name」で失敗するので、
// それは適用済みとして黙って進む
const HISTORY_ALTERS = [
  'ALTER TABLE history_images ADD COLUMN image_id TEXT',
  "ALTER TABLE history ADD COLUMN search TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE history ADD COLUMN params TEXT NOT NULL DEFAULT ''",
];

const HISTORY_INDEXES = [
  'CREATE INDEX IF NOT EXISTS history_source_seq ON history (source, seq DESC)',
  'CREATE INDEX IF NOT EXISTS history_images_owner ON history_images (history_id)',
  'CREATE INDEX IF NOT EXISTS history_images_image ON history_images (image_id)',
];

// 移行まで済んでいるか。isolate ごとに覚えておけば、平常時の追加コストは
// 「meta を 1 回引く」だけで済む
let historyCatalogReady = false;

// 複数行 INSERT を bound parameter の上限に収まるよう刻む
function insertStatements(db, table, cols, rows, prefix = 'INSERT') {
  const perStatement = Math.max(1, Math.floor(D1_MAX_BIND / cols.length));
  const tuple = `(${cols.map(() => '?').join(',')})`;
  const out = [];
  for (const part of chunkBatch(rows, perStatement)) {
    out.push(db.prepare(
      `${prefix} INTO ${table} (${cols.join(',')}) VALUES ${part.map(() => tuple).join(',')}`,
    ).bind(...part.flat()));
  }
  return out;
}

// レコード → history の 1 行。マスクだけ列を分ける（一覧で読まないため）
function historyRow(record) {
  const { mask, ...rest } = record;
  return [
    record.seq,
    record.id,
    HISTORY_SOURCE,
    record.type ?? '',
    Number.isFinite(record.ts) ? record.ts : 0,
    typeof record.model === 'string' ? record.model : '',
    typeof record.prompt === 'string' ? record.prompt : '',
    historySearchText(record),
    JSON.stringify(imageMetaSummary(recordImageMeta(record))),
    JSON.stringify(rest),
    mask ? JSON.stringify(mask) : null,
  ];
}

// その記録が載せている画像の URL（外部 CDN のものも含む）
function recordImageUrls(record) {
  const urls = new Set();
  for (const { images } of recordImageLists(record)) {
    for (const img of images) if (typeof img?.url === 'string') urls.add(img.url);
  }
  return [...urls];
}

/* ---------- 検索用の文字列 ----------
 *
 * app.js のギャラリー検索（gallerySearchText）が作っていたものと同じ文字列を、
 * 保存時に search 列へ入れる。同じ結果になることがこの移行の要なので、
 * 手順もそのまま持ってきてある（プロンプト・モデル名・LoRA のパスと表示名）。
 *
 * 表示名は LoRA ライブラリの設定ではなくパスから決まる（lora-library.js の
 * fileName）ので、サーバー側でもまったく同じものを作れる
 */
function loraFileName(path) {
  const seg = String(path).split('?')[0].split('/').filter(Boolean).pop() || path;
  try {
    return decodeURIComponent(seg).replace(/\.safetensors$/i, '');
  } catch {
    return seg.replace(/\.safetensors$/i, '');
  }
}

// 効いている LoRA（重み 0 は効果が無いので検索対象から外す）
function recordActiveLoras(record) {
  const loras = [];
  if (Array.isArray(record.loras)) loras.push(...record.loras);
  if (Array.isArray(record.common)) loras.push(...record.common);
  if (Array.isArray(record.variants)) {
    for (const v of record.variants) {
      if (Array.isArray(v.ownLoras)) loras.push(...v.ownLoras);
    }
  }
  return loras.filter((l) => l && l.path && (Number(l.scale) || 0) > 0);
}

function historySearchText(record) {
  const loraText = recordActiveLoras(record)
    .map((l) => `${l.path} ${loraFileName(l.path)}`)
    .join(' ');
  return `${record.prompt ?? ''} ${record.model ?? ''} ${loraText}`.toLowerCase();
}

// 履歴レコードの type から、画像メタの kind を決める。
// 画像編集（imgedit）はマスクの有無で「塗った範囲の描き直し」か「全体の編集」かが変わる。
//
// マスクの有無は masked で見ること。mask 本体は列を分けてあり、record 列には
// 入っていない ―― mask を見ると、保存のときと埋め戻しのときで答えが変わる
function recordMetaKind(record) {
  if (record?.type === 'edit') return 'edit';
  if (record?.type === 'imgedit') return record.masked || record.maskNative ? 'inpaint' : 'edit';
  return 'generate';
}

// 履歴レコード → v:1 のメタ。画像への焼き込みと params 列で同じものを使うので、
// 「ファイルに焼かれている設定」と「カタログに載っている設定」がずれない
function recordImageMeta(record, loras = null) {
  return normalizeImageMeta({
    kind: recordMetaKind(record),
    model: record?.model,
    prompt: record?.prompt,
    seed: record?.seed ?? null,
    loras: loras ?? recordActiveLoras(record),
    input: record?.input ?? null,
    created: new Date(Number(record?.ts) || Date.now()).toISOString(),
  });
}

// 空白区切りの AND 検索。LIKE のワイルドカードは打ち消す
function searchTokens(q) {
  return String(q ?? '').toLowerCase().trim().split(/\s+/)
    .filter(Boolean)
    .slice(0, HISTORY_SEARCH_TOKENS)
    .map((token) => token.replace(/[\\%_]/g, (c) => `\\${c}`));
}

// id ごとに違う値を 1 文で書き込む（1 行 1 文だとクエリ数の予算に収まらない）
function updateByIdStatements(db, table, column, rows) {
  const perStatement = Math.max(1, Math.floor(D1_MAX_BIND / 3));
  const out = [];
  for (const part of chunkBatch(rows, perStatement)) {
    const cases = part.map(() => 'WHEN ? THEN ?').join(' ');
    const marks = part.map(() => '?').join(',');
    out.push(db.prepare(
      `UPDATE ${table} SET ${column} = CASE id ${cases} END WHERE id IN (${marks})`,
    ).bind(...part.flat(), ...part.map(([id]) => id)));
  }
  return out;
}

// history_images に入れる行。image_id は自分が配信している画像のときだけ入る
//（外部 CDN の URL は null）。掃除はこの列だけを見るので、URL 文字列の形
//（?v= 付きや旧 /api/krea2/image/...）に振り回されずに済む
const IMAGE_LINK_COLS = ['url', 'history_id', 'image_id'];

function imageLinks(record) {
  return recordImageUrls(record).map((url) => [url, record.id, localImageId(url)]);
}

// 表を用意し、Durable Object に残っている過去のレコードを引き取る。
// 移行は新しい方から進めるので、途中でもギャラリーの先頭は D1 側に揃っている
async function getMeta(env, keys) {
  const marks = keys.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT k, v FROM meta WHERE k IN (${marks})`)
    .bind(...keys).all();
  return new Map(results.map((row) => [row.k, row.v]));
}

const setMeta = (env, key, value) => env.DB
  .prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind(key, String(value)).run();

// 表を用意し、過去の持ち物を今の形に揃える。済んでしまえば、平常時の追加コストは
// 「meta を 1 回引く」だけ（それも isolate ごとに 1 度）
async function ensureHistoryCatalog(env, stub) {
  if (historyCatalogReady) return;

  let state = new Map();
  try {
    state = await getMeta(env, [META_MIGRATED, META_SCHEMA, META_LINKS, META_SEARCH, META_PARAMS]);
  } catch {
    // 表がまだ無い（初回）
  }
  // 片付けの段どりを増やしたら、ここの条件にも足すこと。入れ忘れると
  // 「1 回だけ走って、次からは早期 return で二度と進まない」状態になる
  if (state.get(META_MIGRATED) && state.get(META_LINKS) && state.get(META_SEARCH)
      && state.get(META_PARAMS) && state.get(META_SCHEMA) === SCHEMA_VERSION) {
    historyCatalogReady = true;
    return;
  }

  // スキーマは版が上がったときだけ流す。表 → 列の追加 → 索引の順を守ること
  if (state.get(META_SCHEMA) !== SCHEMA_VERSION) {
    for (const sql of HISTORY_TABLES) await env.DB.prepare(sql).run();
    for (const sql of HISTORY_ALTERS) {
      try {
        await env.DB.prepare(sql).run();
      } catch {
        // 適用済み
      }
    }
    for (const sql of HISTORY_INDEXES) await env.DB.prepare(sql).run();
    // ここで立てておく。以後のリクエストは DDL を流さない
    await setMeta(env, META_SCHEMA, SCHEMA_VERSION);
  }

  // 過去の持ち物の引き取りは「できるところまで」。予算切れや失敗で一覧まで
  // 巻き添えにしない（表示できるぶんは表示する）
  try {
    // 1. Durable Object に残っている履歴を引き取る
    if (!state.get(META_MIGRATED) && !(await migrateHistoryFromDo(env, stub))) return;
    // 2. 画像参照（history_images）を、レコードから作り直す
    if (!state.get(META_LINKS)) {
      if (!(await rebuildImageLinks(env))) return;
      await setMeta(env, META_LINKS, new Date().toISOString());
    }
    // 3. 検索用の文字列（search 列）を、レコードから埋める
    if (!state.get(META_SEARCH)) {
      if (!(await backfillSearch(env))) return;
      await setMeta(env, META_SEARCH, new Date().toISOString());
    }
    // 4. 正規化した生成設定（params 列）を、レコードから埋める
    if (!state.get(META_PARAMS)) {
      if (!(await backfillParams(env))) return;
      await setMeta(env, META_PARAMS, new Date().toISOString());
    }
    historyCatalogReady = true;
  } catch {
    // 続きは次のリクエストで。一覧はここまでのぶんを返す
  }
}

// Durable Object から D1 へ。移し終えたら true。予算切れなら false（次のリクエストで続き）
async function migrateHistoryFromDo(env, stub) {
  for (let spent = 0; spent < HISTORY_MIGRATE_BUDGET;) {
    const records = await stub.exportHistory(HISTORY_MIGRATE_BATCH);
    if (records.length === 0) {
      await setMeta(env, META_MIGRATED, new Date().toISOString());
      return true;
    }
    // 通し番号は Durable Object が振ったものをそのまま使う（並び順が変わらない）
    const stmts = [
      ...insertStatements(env.DB, 'history', HISTORY_COLS, records.map(historyRow), 'INSERT OR REPLACE'),
      ...insertStatements(env.DB, 'history_images', IMAGE_LINK_COLS,
        records.flatMap(imageLinks), 'INSERT OR IGNORE'),
    ];
    await env.DB.batch(stmts);
    spent += stmts.length;
    await stub.forgetHistory(records.map((r) => r.id));
  }
  return false; // 表示は移行済みのぶんだけ。残りは次のリクエストで
}

// history_images をレコードから作り直す。image_id 列を後から足したので、
// 既存行にはそれが入っていない。URL 文字列を SQL で切り出すより、保存時と
// まったく同じ JS（recordImageUrls / localImageId）で引き直すほうが確実
async function rebuildImageLinks(env) {
  const at = await getMeta(env, [META_LINKS_CURSOR]); // 位置は seq
  let after = Number(at.get(META_LINKS_CURSOR)) || Infinity;

  for (let spent = 0; spent < HISTORY_LINKS_BUDGET;) {
    const { results } = await env.DB.prepare(
      'SELECT id, seq, record FROM history WHERE seq < ? ORDER BY seq DESC LIMIT ?',
    ).bind(after === Infinity ? Number.MAX_SAFE_INTEGER : after, HISTORY_LINKS_PAGE).all();
    spent += 1;
    if (results.length === 0) {
      return true;
    }
    const ids = results.map((row) => row.id);
    const links = results.flatMap((row) => imageLinks(JSON.parse(row.record)));
    const stmts = [];
    for (const part of chunkBatch(ids, D1_MAX_BIND)) {
      stmts.push(env.DB.prepare(
        `DELETE FROM history_images WHERE history_id IN (${part.map(() => '?').join(',')})`,
      ).bind(...part));
    }
    stmts.push(...insertStatements(env.DB, 'history_images', IMAGE_LINK_COLS, links, 'INSERT OR IGNORE'));
    await env.DB.batch(stmts);
    spent += stmts.length;
    after = results[results.length - 1].seq;
    await setMeta(env, META_LINKS_CURSOR, after);
    spent += 1;
  }
  return false;
}

// search 列を埋める。空文字の行が対象なので、済んだものは自然に外れていく
async function backfillSearch(env) {
  for (let spent = 0; spent < HISTORY_SEARCH_BUDGET;) {
    const { results } = await env.DB.prepare(
      "SELECT id, record FROM history WHERE search = '' LIMIT ?",
    ).bind(HISTORY_SEARCH_PAGE).all();
    spent += 1;
    if (results.length === 0) return true;

    const stmts = updateByIdStatements(env.DB, 'history', 'search',
      results.map((row) => [row.id, historySearchText(JSON.parse(row.record))]));
    await env.DB.batch(stmts);
    spent += stmts.length;
  }
  return false; // 続きは次のリクエストで
}

// params 列を埋める。空文字の行が対象なので、済んだものは自然に外れていく
async function backfillParams(env) {
  for (let spent = 0; spent < HISTORY_PARAMS_BUDGET;) {
    const { results } = await env.DB.prepare(
      "SELECT id, record FROM history WHERE params = '' LIMIT ?",
    ).bind(HISTORY_PARAMS_PAGE).all();
    spent += 1;
    if (results.length === 0) return true;

    const stmts = updateByIdStatements(env.DB, 'history', 'params', results.map((row) => [
      row.id, JSON.stringify(imageMetaSummary(recordImageMeta(JSON.parse(row.record)))),
    ]));
    await env.DB.batch(stmts);
    spent += stmts.length;
  }
  return false; // 続きは次のリクエストで
}

// 新しい順に 1 ページ。cursor は前のページの最後の seq
async function historyPage(env, { limit, cursor, q, type } = {}) {
  const want = Math.max(1, Math.min(Math.trunc(limit) || HISTORY_PAGE_DEFAULT, HISTORY_PAGE_MAX));
  const where = ['source = ?'];
  const bind = [HISTORY_SOURCE];

  const after = Number(cursor);
  if (Number.isFinite(after) && after > 0) {
    where.push('seq < ?');
    bind.push(after);
  }
  if (type) {
    where.push('type = ?');
    bind.push(type);
  }
  // 空白区切りの AND 検索。すべての語を含む記録だけを残す
  for (const token of searchTokens(q)) {
    where.push("search LIKE ? ESCAPE '\\'");
    bind.push(`%${token}%`);
  }
  bind.push(want);

  const { results } = await env.DB.prepare(
    `SELECT seq, record FROM history WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
  ).bind(...bind).all();

  const records = results.map((row) => JSON.parse(row.record));
  // want 件取れたなら、まだ続きがあるかもしれない
  return { records, cursor: results.length < want ? null : results[results.length - 1].seq };
}

/* ---------- 生成時間の統計 ----------
 *
 * これまではクライアントが全履歴を持って計算していた。手順はそのまま持ってきて
 * あり（同じ結果になることが移行の要）、違うのは入力の集め方だけ:
 * レコード全体ではなく、必要な数項目だけを SQL で抜き出す。
 *
 * Modal は Durable Object で順次処理されるので、記録された所要時間には前の
 * ジョブを待っていた時間が混ざる。完了時刻順に並べて、直前の記録の完了時刻より
 * 前には遡らないようにして待ち時間を差し引く
 */
const STATS_MAX_SEC = 30 * 60; // これを超える標本は、補正しきれなかった待ち時間とみなして捨てる

const isModalModel = (model) => String(model ?? '').startsWith('modal/');

async function historyStats(env) {
  const { results } = await env.DB.prepare(
    `SELECT model,
            created AS ts,
            json_extract(record, '$.elapsed') AS elapsed,
            json_extract(record, '$.outputCount') AS outputCount,
            json_extract(record, '$.procMs') AS procMs,
            json_array_length(json_extract(record, '$.images')) AS imageCount,
            json_extract(record, '$.variants') AS variants
       FROM history
      WHERE source = ? AND created > 0
      ORDER BY created ASC`,
  ).bind(HISTORY_SOURCE).all();
  return summarizeStats(statsSamples(results));
}

// モデル ID → 1 枚あたりの所要秒
function statsSamples(rows) {
  const samples = new Map();
  const add = (model, sec) => {
    if (!Number.isFinite(sec) || sec <= 0 || sec > STATS_MAX_SEC) return;
    if (!samples.has(model)) samples.set(model, []);
    samples.get(model).push(sec);
  };

  // Modal: 完了時刻順（rows はその並び）に、順次キューを再構成する
  let prevEnd = 0;
  for (const row of rows) {
    if (!isModalModel(row.model)) continue;
    // 画像編集の記録は images に合成前の生画像と入力画像も並ぶので、
    // 枚数は outputCount を優先して見る
    const count = Math.max(1, row.outputCount ?? row.imageCount ?? 1);
    const procMs = safeJsonParse(row.procMs);
    if (Array.isArray(procMs) && procMs.length > 0) {
      for (const ms of procMs) add(row.model, ms / 1000);
    } else {
      const elapsedMs = parseFloat(row.elapsed) * 1000;
      if (elapsedMs > 0) {
        const start = Math.max(row.ts - elapsedMs, prevEnd);
        const span = row.ts - start;
        // 複数枚の記録は 1 ジョブずつ順に処理された合計なので枚数で割り、
        // 新しい記録（枚数ぶんの標本）と重みを揃えるため枚数回数える
        for (let i = 0; i < count; i++) add(row.model, span / count / 1000);
      }
    }
    prevEnd = Math.max(prevEnd, row.ts);
  }

  // fal ほか: 比較の記録（variants）は所要時間を持たないので対象外
  for (const row of rows) {
    if (isModalModel(row.model) || row.variants !== null) continue;
    add(row.model, parseFloat(row.elapsed));
  }
  return samples;
}

function statsQuantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// 標本そのものではなく、描くのに要るものだけ返す（件数に依らない大きさにする）。
// ヒストグラムの刻み方は、これまでクライアントが描いていたものと同じ
function summarizeStats(samples) {
  const out = {};
  for (const [model, values] of samples) {
    values.sort((a, b) => a - b);
    const n = values.length;
    const min = values[0];
    const max = values[n - 1];
    const bins = Math.min(16, Math.max(5, Math.ceil(Math.sqrt(n))));
    const width = Math.max((max - min) / bins, 0.05);
    const counts = new Array(bins).fill(0);
    for (const v of values) counts[Math.min(bins - 1, Math.floor((v - min) / width))] += 1;
    out[model] = {
      n,
      min,
      max,
      width,
      counts,
      mean: values.reduce((sum, v) => sum + v, 0) / n,
      median: statsQuantile(values, 0.5),
    };
  }
  return out;
}

// 1 件（マスク込み）
async function historyGet(env, id) {
  const row = await env.DB.prepare('SELECT record, mask FROM history WHERE id = ?').bind(id).first();
  if (!row) return null;
  const record = JSON.parse(row.record);
  if (row.mask) record.mask = JSON.parse(row.mask);
  return record;
}

// 保存。同じ id の保存は差し替えで、新しい通し番号が付くので先頭に来る
async function historySave(env, record) {
  const top = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS top FROM history').first();
  const saved = { ...record, seq: (top?.top ?? 0) + 1 };
  await env.DB.batch([
    env.DB.prepare('DELETE FROM history WHERE id = ?').bind(saved.id),
    env.DB.prepare('DELETE FROM history_images WHERE history_id = ?').bind(saved.id),
    ...insertStatements(env.DB, 'history', HISTORY_COLS, [historyRow(saved)]),
    ...insertStatements(env.DB, 'history_images', IMAGE_LINK_COLS, imageLinks(saved), 'INSERT OR IGNORE'),
  ]);
  return saved;
}

// 参照が無くなった画像だけ R2 から消す。1 枚が複数の記録に出ることがある
// （編集の入力に使い回したときなど）ので、消す前に残りの参照を数える
async function dropOrphanImages(env, stub, urls) {
  const candidates = [...new Set(urls.map(localImageId).filter(Boolean))];
  const orphans = [];
  for (const part of chunkBatch(candidates, D1_MAX_BIND)) {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT image_id FROM history_images WHERE image_id IN (${part.map(() => '?').join(',')})`,
    ).bind(...part).all();
    const stillUsed = new Set(results.map((row) => row.image_id));
    for (const id of part) if (!stillUsed.has(id)) orphans.push(id);
  }
  await deleteImageObjects(env, stub, orphans);
}

// 画像の実体を消す。掃除の印も一緒に片付ける（実体が無くなれば印も要らない）
async function deleteImageObjects(env, stub, ids) {
  if (ids.length === 0) return 0;
  // R2 の delete は 1 回 1000 キーまで
  for (let i = 0; i < ids.length; i += 1000) {
    await env.IMAGES.delete(ids.slice(i, i + 1000).map((id) => `${id}.png`));
  }
  await stub.deleteImages(ids); // R2 移行前に Durable Object へ入れた画像も掃除する
  for (const part of chunkBatch(ids, D1_MAX_BIND)) {
    await env.DB.prepare(
      `DELETE FROM image_gc WHERE image_id IN (${part.map(() => '?').join(',')})`,
    ).bind(...part).run();
  }
  return ids.length;
}

// 「今から使う」画像から掃除の印を外す。参照が付く前に消されるのを防ぐ
const claimImage = (env, id) =>
  env.DB.prepare('DELETE FROM image_gc WHERE image_id = ?').bind(id).run();

// 画像を R2 へ置く唯一の入口。生成結果も取り込みもアップロードも、必ずここを通す。
// キーは中身の sha256（内容アドレス）なので、同じ画像は何度置いても 1 つに収まる。
// PNG なら正規化したメタ（v:1）を焼き込む。
//
// 焼き込みはキーを決めたあとなので、保存されたファイル自身のハッシュはキーと
// 一致しない。キーは「受け取ったバイト列」のハッシュ ―― クライアントが送って
// くるハッシュ（/api/upload の問い合わせ）と突き合わせるためにこうしてある
async function storeImage(env, bytes, { meta = null, contentType = 'image/png' } = {}) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const id = await sha256Hex(src);
  const body = meta ? embedPngMetadata(src, JSON.stringify(normalizeImageMeta(meta))) : src;
  await env.IMAGES.put(`${id}.png`, body, { httpMetadata: { contentType } });

  // 掃除の印を外す（前に「参照が無い」と印を付けた画像を、また使い始めたとき）。
  // ここで落ちても画像は保存済みで、印は猶予 7 日のあいだに次の参照で外れるので、
  // 保存そのものは失敗させない
  try {
    await claimImage(env, id);
  } catch {
    // カタログがまだ用意されていない経路（Durable Object の alarm など）
  }
  return { id, url: `/api/image/${id}` };
}

// 外部にある画像を R2 へ取り込んで、同一オリジンの URL を返す（取れなければ null）
async function captureExternalImage(env, src, meta = null) {
  const res = await fetch(src, { signal: apiSignal() });
  if (!res.ok) return null;
  const type = (res.headers.get('Content-Type') ?? '').split(';')[0].trim();
  if (!type.startsWith('image/')) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > UPLOAD_MAX_BYTES) return null;
  const { url } = await storeImage(env, buf, { meta, contentType: type });
  return url;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ---------- 使われなかった画像の回収（マーク&スイープ） ----------
 *
 * 画像編集は「画像を選んだ瞬間」に R2 へ上げ、履歴に載るのは編集が終わってから
 * なので、その間はどこからも参照されない。見つけ次第消すと編集中のものを
 * 巻き込むので、まず印を付け、IMAGE_GC_GRACE_MS を越えてなお参照が無いものだけを
 * 消す。アップロードの問い合わせで「持っている」と答えたときも印を外す
 * （これから使う気配があるので）。
 */

// 一覧の取得や生成の完了に便乗して、裏で片付けを進める（応答は先に返っている）。
// 取り込み漏れを片付けてから、使われなかった画像の回収へ進む。
//
// 「もう漏れは無い」を覚え込ませないこと。保存のときに相手の CDN が一時的に
// 落ちていれば、あとから漏れが増える。残りの確認は 1 クエリで済むので、
// 毎回聞き直すほうが安い
async function runHousekeeping(env, stub) {
  if (!historyCatalogReady) return; // 引き取りと参照の作り直しが済んでから
  try {
    if (!(await captureMissingImages(env))) return; // 残っているうちはそちらを優先
    await maybeSweepImages(env, stub);
  } catch {
    // 片付けの失敗で表の動きを止めない。次の機会にまた試す
  }
}

// 履歴に残っている外部 URL を R2 へ取り込む。取り込みの条件を広げる前に保存した
// ぶん（プロバイダの CDN が別ドメインで、許可リストから漏れていた）が対象。
// 残りが無くなったら true
async function captureMissingImages(env) {
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT url FROM history_images WHERE image_id IS NULL LIMIT ?',
  ).bind(HISTORY_CAPTURE_BUDGET).all();
  if (results.length === 0) return true;

  for (const { url } of results) {
    let local = null;
    try {
      const src = new URL(url);
      if (src.protocol === 'https:') local = await captureExternalImage(env, src);
    } catch {
      local = null; // URL として読めない・取得できない
    }
    if (local) {
      await replaceHistoryImageUrl(env, url, local);
      continue;
    }
    // もう取れない URL（失効済みなど）。毎回試し続けないよう、空文字を
    // 「試したが取り込めなかった」印として置く（id としては何にも一致しない）
    await env.DB.prepare("UPDATE history_images SET image_id = '' WHERE url = ?").bind(url).run();
  }
  return false; // まだ残っているかもしれないので、次の機会に続ける
}

// 取り込んだ画像の URL を、それを載せているレコードすべてで差し替える
async function replaceHistoryImageUrl(env, from, to) {
  const { results } = await env.DB.prepare(
    'SELECT h.id AS id, h.record AS record FROM history h'
    + ' JOIN history_images i ON i.history_id = h.id WHERE i.url = ?',
  ).bind(from).all();

  const stmts = [];
  for (const row of results) {
    const record = JSON.parse(row.record);
    for (const { images } of recordImageLists(record)) {
      for (const img of images) if (img?.url === from) img.url = to;
    }
    stmts.push(env.DB.prepare('UPDATE history SET record = ? WHERE id = ?')
      .bind(JSON.stringify(record), row.id));
  }
  stmts.push(env.DB.prepare('DELETE FROM history_images WHERE url = ?').bind(from));
  stmts.push(...insertStatements(
    env.DB, 'history_images', IMAGE_LINK_COLS,
    results.map((row) => [to, row.id, localImageId(to)]), 'INSERT OR IGNORE',
  ));
  await env.DB.batch(stmts);
}

// 1 日に 1 度、裏で走らせる
async function maybeSweepImages(env, stub) {
  if (!historyCatalogReady) return; // 移行と参照の作り直しが済んでから
  const last = safeJsonParse((await getMeta(env, [META_GC_STATS])).get(META_GC_STATS));
  // 見終わっていないぶんが残っているときは、間隔を待たずに続きへ進む
  if (last?.done && Date.now() - (last.at ?? 0) < IMAGE_GC_INTERVAL_MS) return;
  try {
    await sweepImages(env, stub);
  } catch {
    // 掃除の失敗は生成の邪魔をしない。次の機会にまた試す
  }
}

async function sweepImages(env, stub) {
  const now = Date.now();
  const state = await getMeta(env, [META_GC_CURSOR, META_GC_STATS]);
  const previous = safeJsonParse(state.get(META_GC_STATS));
  let cursor = state.get(META_GC_CURSOR) || null;
  let scanned = 0;
  let marked = 0;
  let deleted = 0;

  for (let spent = 1; spent < IMAGE_GC_BUDGET;) {
    const listed = await env.IMAGES.list({ limit: IMAGE_GC_PAGE, ...(cursor ? { cursor } : {}) });
    const ids = listed.objects.map((obj) => IMAGE_KEY_RE.exec(obj.key)?.[1]).filter(Boolean);
    scanned += ids.length;
    cursor = listed.truncated ? listed.cursor : null;
    spent += 1; // 列挙そのものは D1 を使わないが、際限なく回さないため数える
    if (ids.length > 0) {
      const page = await sweepPage(env, stub, ids, now);
      marked += page.marked;
      deleted += page.deleted;
      spent += page.spent;
    }
    if (!cursor) break;
  }

  await setMeta(env, META_GC_CURSOR, cursor ?? '');
  const stats = {
    at: now,
    scanned,
    marked,
    deleted,
    total: (previous?.total ?? 0) + deleted,
    done: !cursor, // false なら、まだ見ていない画像が残っている
  };
  await setMeta(env, META_GC_STATS, JSON.stringify(stats));
  return stats;
}

async function sweepPage(env, stub, ids, now) {
  let spent = 0;
  const referenced = new Set();
  const marks = new Map();
  for (const part of chunkBatch(ids, D1_MAX_BIND)) {
    const marksSql = part.map(() => '?').join(',');
    const refs = await env.DB.prepare(
      `SELECT DISTINCT image_id FROM history_images WHERE image_id IN (${marksSql})`,
    ).bind(...part).all();
    const gc = await env.DB.prepare(
      `SELECT image_id, marked_at FROM image_gc WHERE image_id IN (${marksSql})`,
    ).bind(...part).all();
    spent += 2;
    for (const row of refs.results) referenced.add(row.image_id);
    for (const row of gc.results) marks.set(row.image_id, row.marked_at);
  }

  const adopted = []; // 参照が付いた。印を外す
  const mark = []; // 参照が無い。まだ消さず、印だけ付ける
  const drop = []; // 印から猶予を越えて、なお参照が無い
  for (const id of ids) {
    if (referenced.has(id)) {
      if (marks.has(id)) adopted.push(id);
      continue;
    }
    const at = marks.get(id);
    if (at === undefined) mark.push(id);
    else if (now - at >= IMAGE_GC_GRACE_MS) drop.push(id);
  }

  const stmts = [];
  for (const part of chunkBatch(adopted, D1_MAX_BIND)) {
    stmts.push(env.DB.prepare(
      `DELETE FROM image_gc WHERE image_id IN (${part.map(() => '?').join(',')})`,
    ).bind(...part));
  }
  stmts.push(...insertStatements(
    env.DB, 'image_gc', ['image_id', 'marked_at'], mark.map((id) => [id, now]), 'INSERT OR IGNORE',
  ));
  if (stmts.length > 0) {
    await env.DB.batch(stmts);
    spent += stmts.length;
  }
  if (drop.length > 0) {
    await deleteImageObjects(env, stub, drop);
    spent += Math.ceil(drop.length / D1_MAX_BIND);
  }
  return { spent, marked: mark.length, deleted: drop.length };
}

async function historyDelete(env, stub, id) {
  const row = await env.DB.prepare('SELECT record FROM history WHERE id = ?').bind(id).first();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM history WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM history_images WHERE history_id = ?').bind(id),
  ]);
  if (row) await dropOrphanImages(env, stub, recordImageUrls(JSON.parse(row.record)));
}

// 全消し。1 リクエストのクエリ数に上限があるので、終わらなければ done: false を
// 返して呼び出し側に続けてもらう
async function historyClear(env, stub) {
  for (let spent = 0; spent < HISTORY_CLEAR_BUDGET; spent += 4) {
    const { results } = await env.DB.prepare(
      'SELECT id, record FROM history WHERE source = ? ORDER BY seq DESC LIMIT ?',
    ).bind(HISTORY_SOURCE, HISTORY_CLEAR_PAGE).all();
    if (results.length === 0) return true;

    const ids = results.map((row) => row.id);
    const urls = [...new Set(results.flatMap((row) => recordImageUrls(JSON.parse(row.record))))];
    for (const part of chunkBatch(ids, D1_MAX_BIND)) {
      const marks = part.map(() => '?').join(',');
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM history WHERE id IN (${marks})`).bind(...part),
        env.DB.prepare(`DELETE FROM history_images WHERE history_id IN (${marks})`).bind(...part),
      ]);
    }
    await dropOrphanImages(env, stub, urls);
  }
  return false;
}

// その画像 URL が履歴に載っているか（/api/capture の踏み台対策）
async function historyOwnsImage(env, url) {
  const row = await env.DB.prepare('SELECT 1 AS hit FROM history_images WHERE url = ? LIMIT 1')
    .bind(url).first();
  return !!row;
}

export class SyncState extends DurableObject {
  // 監視側（superviseLoraJob）が停滞で打ち切った取り込みジョブのキー。同じインスタンス内で
  // まだ走り続けている実行があれば、次の保存で気づいて止める（中断済みの記録を
  // pending に書き戻して「ダウンロード中…」を復活させないため）
  abortedLoraJobs = new Set();

  /* ---- 端末間同期（LoRA ライブラリなど小さな設定） ---- */

  async load() {
    return (await this.ctx.storage.get('state')) ?? null;
  }

  async save(value) {
    await this.ctx.storage.put('state', value);
  }

  /* ---- 生成画像（R2 移行前の旧 DO ストレージ用。新規保存は R2 に直接行う） ---- */

  // 旧方式（R2 移行前）で DO の SQLite に分割保存した画像を読み出す。
  // R2 に見つからなかった画像だけがここに来る（後方互換）。
  async loadImage(id) {
    const index = (await this.ctx.storage.get('krea2:index')) ?? [];
    const entry = index.find((e) => e.id === id);
    if (!entry) return null;
    const keys = Array.from({ length: entry.chunks }, (_, i) => `krea2:img:${id}:${i}`);
    const map = await this.ctx.storage.get(keys);
    const parts = keys.map((k) => new Uint8Array(map.get(k)));
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return out.buffer;
  }

  async deleteImages(ids) {
    if (ids.length === 0) return;
    const index = (await this.ctx.storage.get('krea2:index')) ?? [];
    const targets = new Set(ids);
    const keep = [];
    for (const entry of index) {
      if (!targets.has(entry.id)) {
        keep.push(entry);
        continue;
      }
      await this.ctx.storage.delete(
        Array.from({ length: entry.chunks }, (_, i) => `krea2:img:${entry.id}:${i}`),
      );
    }
    await this.ctx.storage.put('krea2:index', keep);
  }

  /* ---- 生成履歴（D1 へ移し終えるまでの置き場） ----
   *
   * カタログの正は D1 の history テーブル（下の historyPage などを参照）。
   * ここに残っているのは、まだ D1 へ移していない過去のレコードだけで、
   * 移行が済めば空になり、以後この Durable Object は生成・取り込みの
   * ジョブ実行だけを持つ。
   *
   * レコードは hist:<id>、並び順は hidx:<逆順の通し番号>:<id> に入っている。
   */

  // さらに古いレイアウトが残っていれば、まず索引の形に揃える（1 度だけ）
  async migrateHistory() {
    if (this.historyMigrated) return;

    // 旧レイアウト 1: 全件を history:list の 1 キーに詰めていた
    let order = null;
    const legacy = await this.ctx.storage.get(HISTORY_LEGACY_KEY);
    if (Array.isArray(legacy)) {
      const seen = new Set();
      order = [];
      const entries = [];
      for (const record of legacy) {
        if (typeof record?.id !== 'string' || seen.has(record.id)) continue;
        seen.add(record.id);
        order.push(record.id);
        entries.push([HISTORY_PREFIX + record.id, record]);
      }
      // 1 件が数十 KB になりうるので、一括 put は上限より小さく刻む
      for (const part of chunkBatch(entries, 32)) {
        await this.ctx.storage.put(Object.fromEntries(part));
      }
      await this.ctx.storage.delete(HISTORY_LEGACY_KEY);
    }

    // 旧レイアウト 2: 並び順を history:order の 1 キー（id の配列）で持っていた
    order ??= await this.ctx.storage.get(HISTORY_ORDER_KEY);
    if (Array.isArray(order)) {
      let seq = order.length;
      // レコードにも seq を書くので 1 件あたり 2 キー。一括 put の上限に収まるよう刻む
      for (const part of chunkBatch(order, DO_BATCH / 2)) {
        const stored = await this.ctx.storage.get(part.map((id) => HISTORY_PREFIX + id));
        const writes = {};
        for (const id of part) {
          const record = stored.get(HISTORY_PREFIX + id);
          const n = seq--;
          if (!record) continue; // 消し込みが途中で終わった残り
          record.seq = n;
          writes[HISTORY_PREFIX + id] = record;
          writes[historyIndexKey(n, id)] = id;
        }
        if (Object.keys(writes).length > 0) await this.ctx.storage.put(writes);
      }
      await this.ctx.storage.put(HISTORY_SEQ_KEY, order.length);
      await this.ctx.storage.delete(HISTORY_ORDER_KEY);
    }

    this.historyMigrated = true;
  }

  // D1 へ移すぶんを新しい順に取り出す。新しい方から移すので、移行の途中でも
  // ギャラリーの先頭（＝よく見るところ）は D1 側に揃っている。
  // 実体の無い索引（消し込みが途中で終わった残り）はここで片付ける
  async exportHistory(limit) {
    await this.migrateHistory();
    for (;;) {
      const index = await this.ctx.storage.list({ prefix: HISTORY_INDEX_PREFIX, limit });
      if (index.size === 0) return [];

      const keys = [...index.keys()];
      const records = [];
      const stale = [];
      for (const part of chunkBatch(keys)) {
        const stored = await this.ctx.storage.get(part.map((key) => HISTORY_PREFIX + index.get(key)));
        for (const key of part) {
          const record = stored.get(HISTORY_PREFIX + index.get(key));
          // 差し替えで振り直された古い索引も、番号が合わないので捨てる
          if (record && record.seq === historyIndexSeq(key)) records.push(record);
          else stale.push(key);
        }
      }
      for (const part of chunkBatch(stale)) await this.ctx.storage.delete(part);
      if (records.length > 0) return records;
      // 全部が実体の無い索引だった。消したので、次のぶんを見る
    }
  }

  // 移し終えたレコードを捨てる。画像は D1 側のカタログが参照を持つので、
  // ここでは消さない（移行で画像が失われないように）
  async forgetHistory(ids) {
    const index = [];
    for (const part of chunkBatch(ids.map((id) => HISTORY_PREFIX + id))) {
      const stored = await this.ctx.storage.get(part);
      for (const record of stored.values()) {
        if (Number.isFinite(record?.seq)) index.push(historyIndexKey(record.seq, record.id));
      }
      await this.ctx.storage.delete(part);
    }
    for (const part of chunkBatch(index)) await this.ctx.storage.delete(part);
  }

  /* ---- Modal 生成ジョブ ---- */

  // ジョブを登録して alarm を仕込む。同じ id の再送は無視する（多重生成防止）
  // Modal（modal_comfy）への生成・編集ジョブ。生成も編集も 303 で結果ポーリングに
  // 変わる点・PNG バイナリが返る点が同じなので、同じ機構で扱う
  async startKrea2Job(id, payload, endpoint, kind = 'generate', endpointKey = null) {
    const key = `krea2:job:${id}`;
    if (await this.ctx.storage.get(key)) return;

    // ついでに保持期間を過ぎた古いジョブを掃除する
    const jobs = await this.ctx.storage.list({ prefix: 'krea2:job:' });
    for (const [k, j] of jobs) {
      if (Date.now() - j.created > JOB_TTL_MS) await this.ctx.storage.delete(k);
    }

    await this.ctx.storage.put(key, {
      status: 'pending',
      payload,
      endpoint,
      kind,        // 'generate' | 'edit' | 'inpaint'
      // 'exp' | 'prod' | 'ckpt' | 'wan' | 'wan-edit' | 'lanpaint'（画像に焼き込む記録用）
      endpointKey,
      pollUrl: null,
      attempts: 0,
      created: Date.now(),
    });
    await this.ensureAlarm();
  }

  async getKrea2Job(id) {
    const job = await this.ctx.storage.get(`krea2:job:${id}`);
    if (!job) return null;
    // まだ走っているなら、alarm が生きているか確かめる。ポーリングの連鎖が
    // どこかで切れると、クライアントは「編集中…」のまま待ち続けてしまう
    if (job.status === 'pending') await this.ensureAlarm();
    return {
      status: job.status,
      url: job.url ?? null,
      seed: job.seed ?? null,
      // 編集では入力サイズが 32 の倍数へ丸められる。合成側が元画像に戻すために要る
      width: job.width ?? null,
      height: job.height ?? null,
      elapsedMs: job.elapsedMs ?? null, // 実処理時間（DO のキュー待ちを含まない）
      error: job.error ?? null,
    };
  }

  // alarm を確実に張る。既に張られていても、予定時刻をとうに過ぎている（＝配信されない
  // まま残っている）ものは張り直す
  async ensureAlarm(delayMs = 50) {
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at < Date.now() - ALARM_OVERDUE_MS) {
      await this.ctx.storage.setAlarm(Date.now() + delayMs);
    }
  }

  // 未完了ジョブを順に処理する（順次実行なので Modal 側のウォーム状態も保ちやすい）。
  // lora:job: は数分かかりうるため専用の DO インスタンス（'lora-import'）にのみ
  // 登録され、singleton 側の生成ジョブのポーリングを妨げない
  async alarm() {
    let pendingLeft = false;
    // 転送の予算はこの実行ぶんで、取り込みジョブが複数あっても合計で使う
    // （1 呼び出しあたりの上限はジョブ単位ではなく実行単位のため）
    const run = { parts: 0, bytes: 0, yielded: false };
    for (const prefix of ['krea2:job:', 'poe:job:', 'lora:job:']) {
      const jobs = await this.ctx.storage.list({ prefix });
      let entries = [...jobs];
      if (prefix === 'lora:job:') {
        // 最後に前進してから長く待っているジョブを先に回す。大きな取り込みが 1 本
        // 走っていても、後から入れたジョブが順番待ちで止まったままにならないようにする
        entries.sort((a, b) => (a[1].progressAt ?? a[1].created ?? 0) - (b[1].progressAt ?? b[1].created ?? 0));
      }
      for (const [key, job] of entries) {
        if (job.status !== 'pending') continue;
        if (prefix === 'poe:job:') await this.runPoeJob(key, job);
        else if (prefix === 'lora:job:') await this.runLoraImportJob(key, job, run);
        else await this.runKrea2Job(key, job);
        const after = await this.ctx.storage.get(key);
        if (after?.status === 'pending') pendingLeft = true;
      }
    }
    if (pendingLeft) await this.ctx.storage.setAlarm(Date.now() + JOB_POLL_DELAY_MS);
  }

  /* ---- Poe 部分AI編集ジョブ ---- */
  // krea2 ジョブと同じ考え方: ジョブを登録してすぐ応答し、Poe API の呼び出しは
  // alarm で行う。生成中にタブを閉じても結果を取りこぼさない。
  // 入力画像（切り抜き）は事前に /api/upload で R2 へ置き、その id を参照する

  async startPoeJob(id, payload) {
    const key = `poe:job:${id}`;
    if (await this.ctx.storage.get(key)) return; // 同 id の再送は無視（多重課金防止）

    const jobs = await this.ctx.storage.list({ prefix: 'poe:job:' });
    for (const [k, j] of jobs) {
      if (Date.now() - j.created > JOB_TTL_MS) await this.ctx.storage.delete(k);
    }

    await this.ctx.storage.put(key, {
      status: 'pending',
      payload,
      attempts: 0,
      created: Date.now(),
    });
    await this.ensureAlarm();
  }

  async getPoeJob(id) {
    const job = await this.ctx.storage.get(`poe:job:${id}`);
    if (!job) return null;
    return {
      status: job.status,
      url: job.url ?? null,
      error: job.error ?? null,
    };
  }

  // Poe のチャット補完 API（非ストリーミング）を 1 回呼び、応答中の画像を
  // R2 に取り込んで完了する。応答待ちは数十秒〜になるが alarm 内の fetch で待てる
  async runPoeJob(key, job) {
    try {
      if (job.attempts >= JOB_MAX_SUBMIT_ATTEMPTS) {
        job.status = 'error';
        job.error = 'Poe へのリクエストを完了できませんでした（接続エラーが続いています）';
        await this.ctx.storage.put(key, job);
        return;
      }
      // 途中で落ちても際限なく再送されないよう、送信前に回数を記録する
      job.attempts += 1;
      await this.ctx.storage.put(key, job);

      const { model, prompt, imageId, parameters } = job.payload;

      // 入力画像（切り抜き）を R2 から読み出して data URI にする
      const obj = await this.env.IMAGES.get(`${imageId}.png`);
      if (!obj) {
        job.status = 'error';
        job.error = '入力画像が見つかりませんでした（アップロードからやり直してください）';
        await this.ctx.storage.put(key, job);
        return;
      }
      const mime = obj.httpMetadata?.contentType || 'image/png';
      const dataUri = `data:${mime};base64,${bytesToBase64(new Uint8Array(await obj.arrayBuffer()))}`;

      const res = await fetch(POE_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.env.POE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          }],
          stream: false,
          // ボット固有パラメータ（aspect_ratio / quality など）はトップレベルに展開する
          //（OpenAI SDK の extra_body 相当）
          ...(parameters ?? {}),
        }),
      });

      if (!res.ok) {
        const text = (await res.text()).slice(0, 500);
        let detail = text;
        try {
          const body = JSON.parse(text);
          detail = body?.error?.message || detail;
        } catch { /* JSON でなければ本文をそのまま使う */ }
        job.status = 'error';
        job.error = `Poe API error ${res.status}: ${detail}`;
        await this.ctx.storage.put(key, job);
        return;
      }

      const data = await res.json();
      const message = data?.choices?.[0]?.message ?? {};
      // 画像は Markdown リンクで返るのが基本だが、attachments を返す実装にも備える
      let imageUrl = null;
      for (const a of message.attachments ?? []) {
        if (a?.url && (a.mimeType ?? a.content_type ?? '').startsWith('image/')) {
          imageUrl = a.url;
          break;
        }
      }
      if (!imageUrl) imageUrl = extractImageUrl(message.content);
      if (!imageUrl) {
        job.status = 'error';
        job.error = `画像が返されませんでした: ${String(message.content ?? '').slice(0, 300)}`;
        await this.ctx.storage.put(key, job);
        return;
      }

      // Poe CDN の URL は失効しうるので、即座に R2 へ取り込む
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        job.status = 'error';
        job.error = `編集結果の画像を取得できませんでした（HTTP ${imgRes.status}）`;
        await this.ctx.storage.put(key, job);
        return;
      }
      const { url } = await storeImage(this.env, await imgRes.arrayBuffer(), {
        meta: {
          kind: 'edit',
          model: `poe/${model}`,
          prompt,
          created: new Date(job.created).toISOString(),
        },
        contentType: imgRes.headers.get('Content-Type') || 'image/png',
      });
      job.status = 'done';
      job.url = url;
      await this.ctx.storage.put(key, job);
    } catch {
      // ネットワーク断など。pending のまま次の alarm で再試行する（attempts 上限で打ち切り）
    }
  }

  // 1 ジョブを進める。Modal が 303（処理継続中）を返したらポーリング URL を保存して
  // pending のまま戻り、次の alarm で続きを確認する
  async runKrea2Job(key, job) {
    // いつまでも「編集中…」のままにしない。打ち切った理由も添える
    if (Date.now() - job.created > JOB_MAX_RUN_MS) {
      job.status = 'error';
      job.error = `${Math.round(JOB_MAX_RUN_MS / 60000)} 分以内に完了しませんでした`
        + `（Modal ダッシュボードで状態を確認してください${job.lastError ? `。最後のエラー: ${job.lastError}` : ''}）`;
      await this.ctx.storage.put(key, job);
      return;
    }
    try {
      let res;
      if (job.pollUrl) {
        res = await fetch(job.pollUrl, { headers: this.modalHeaders(), redirect: 'manual' });
      } else {
        if (job.attempts >= JOB_MAX_SUBMIT_ATTEMPTS) {
          job.status = 'error';
          job.error = '生成リクエストを送信できませんでした（接続エラーが続いています）';
          await this.ctx.storage.put(key, job);
          return;
        }
        // 途中で落ちても際限なく再送されないよう、送信前に回数を記録する。
        // submittedAt は実処理時間（elapsedMs）の起点。DO のキューで先行ジョブを
        // 待っていた時間を含まない、Modal 呼び出し自体の所要時間を測るため
        job.attempts += 1;
        job.submittedAt = Date.now();
        await this.ctx.storage.put(key, job);
        // チェックポイント指定時は HF トークンを添え、非公開リポジトリからの
        // 取り込みも Modal 側でできるようにする（ジョブ記録には保存しない）
        const body = { ...job.payload };
        if (body.checkpoint && this.env.HF_TOKEN) body.hf_token = this.env.HF_TOKEN;
        res = await fetch(job.endpoint, {
          method: 'POST',
          headers: { ...this.modalHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'manual',
        });
      }

      // 202 は「まだ実行中」。Modal は結果 URL のポーリングに対して、関数が
      // 終わるまで 202 を返す。res.ok は 202 でも true なので、ここで分けないと
      // 空の本文を画像として保存し、壊れた結果を done にしてしまう
      if (res.status === 202) return; // pending のまま次の alarm で確認する

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('Location');
        const pollUrl = loc ? new URL(loc, job.pollUrl ?? job.endpoint).toString() : null;
        if (!pollUrl || !new URL(pollUrl).hostname.endsWith('.modal.run')) {
          job.status = 'error';
          job.error = `不正なリダイレクト応答です（${res.status}）`;
        } else {
          job.pollUrl = pollUrl;
        }
        await this.ctx.storage.put(key, job);
        return;
      }
      if (!res.ok) {
        job.status = 'error';
        job.error = `Modal API error ${res.status}: ${(await res.text()).slice(0, 300)}`;
        await this.ctx.storage.put(key, job);
        return;
      }

      const seedHeader = Number(res.headers.get('X-Seed'));
      const seed = Number.isFinite(seedHeader) ? seedHeader : null;
      // 実際に生成された解像度（編集では 32 の倍数に丸められる）
      const width = Number(res.headers.get('X-Width'));
      const height = Number(res.headers.get('X-Height'));
      // 生成設定を画像に焼き込んでから保存する。画像本体（base64）は焼かない。
      // 正規化で拾われない項目（endpoint・sampler_name など）は raw に入る
      const { image: _img, mask: _mask, hf_token: _tok, ...params } = job.payload;
      const endpoint = job.endpointKey ?? (job.endpoint.includes('-exp-') ? 'exp'
        : job.endpoint.includes('-gpusnap-') ? 'gpusnap'
          : job.endpoint.includes('-ckpt-') ? 'ckpt' : 'prod');
      const meta = {
        kind: JOB_META_KINDS[job.kind] ?? 'generate',
        model: `modal/${endpoint}`,
        endpoint,
        ...params,
        seed: seed ?? job.payload.seed ?? null,
        created: new Date(job.created).toISOString(),
      };
      const body = await res.arrayBuffer();
      // 画像以外が返ったら、そのまま保存して「完了」にしない（表示できない
      // 結果が履歴に残るより、理由の分かるエラーで止めたほうがいい）
      if (!looksLikePng(body)) {
        job.status = 'error';
        job.error = `Modal から画像が返りませんでした（${res.status} `
          + `${res.headers.get('Content-Type') || 'Content-Type 不明'}・${body.byteLength} バイト）`;
        await this.ctx.storage.put(key, job);
        return;
      }
      const { url } = await storeImage(this.env, body, { meta, contentType: 'image/png' });
      job.status = 'done';
      job.url = url;
      job.seed = seed;
      if (Number.isFinite(width) && width > 0) job.width = width;
      if (Number.isFinite(height) && height > 0) job.height = height;
      job.elapsedMs = job.submittedAt ? Date.now() - job.submittedAt : null;
      await this.ctx.storage.put(key, job);
    } catch (err) {
      // ネットワーク断など。pending のまま次の alarm で再試行する
      //（送信済みで pollUrl 未取得の場合は attempts 上限で打ち切られる）。
      // 何度も続くときのために、最後の理由だけ控えて上限到達時の文言に載せる
      job.lastError = String(err?.message ?? err).slice(0, 200);
      try {
        await this.ctx.storage.put(key, job);
      } catch {
        // 控えられなくても再試行は続く
      }
    }
  }

  modalHeaders() {
    return {
      'Modal-Key': this.env.MODAL_PROXY_KEY,
      'Modal-Secret': this.env.MODAL_PROXY_SECRET,
    };
  }

  /* ---- Civitai → HF LoRA 取り込みジョブ ---- */
  // 専用 DO インスタンス（'lora-import'）で動く前提。ステップごとに進捗を保存し、
  // 途中で落ちても次の alarm で続きから再開する（download は最初からやり直し）

  async startLoraImport(id, sourceUrl, repo, saveMeta, kind = 'lora') {
    const key = `lora:job:${id}`;
    if (await this.ctx.storage.get(key)) return; // 同 id の再送は無視（多重取り込み防止）

    const jobs = await this.ctx.storage.list({ prefix: 'lora:job:' });
    for (const [k, j] of jobs) {
      // 大きなチェックポイントは 1 時間を超えることがあるので、まだ進捗が動いている
      // ジョブは TTL 超過でも消さない（別タブから開始した取り込みを壊さない）
      if (Date.now() - j.created > JOB_TTL_MS && !this.loraJobIsLive(j)) {
        await this.abortStagingMultipart(k, j); // やりかけの multipart は破棄してから消す
        await this.ctx.storage.delete(k);
        this.abortedLoraJobs.add(k); // まだ走っている実行があればここで止める
      }
    }
    // 取り残された一時ファイルの掃除（失敗ジョブの分など）
    try {
      const staged = await this.env.IMAGES.list({ prefix: LORA_STAGING_PREFIX });
      for (const obj of staged.objects) {
        if (Date.now() - obj.uploaded.getTime() > 24 * 60 * 60 * 1000) {
          await this.env.IMAGES.delete(obj.key);
        }
      }
    } catch { /* 掃除の失敗は無視 */ }

    await this.ctx.storage.put(key, {
      status: 'pending',
      step: 'resolve',
      sourceUrl,
      repo,
      kind, // 'lora' | 'ckpt'（サイズ上限の切り替えに使う。登録先はクライアント側で判断）
      saveMeta: saveMeta !== false,
      meta: null,
      metaDoc: null,
      size: null,
      sha256: null,
      etags: {},
      attempts: 0,
      runs: 0,
      created: Date.now(),
      progressAt: Date.now(),
    });
    await this.ensureAlarm();
  }

  // ジョブ記録の保存。停滞検知の基準になる「最後に前進した時刻」を必ず更新する。
  // 打ち切り済みのジョブなら例外にして、取り残された実行をここで終わらせる
  async saveLoraJob(key, job) {
    if (this.abortedLoraJobs.has(key)) throw new Error('この取り込みジョブは中断済みです');
    // 掃除で消えた記録を書き戻して復活させない。取り残された実行がここで止まる
    //（復活したジョブは alarm を占有し続け、後続の取り込みが resolve から進まなくなる）
    if (!(await this.ctx.storage.get(key))) {
      this.abortedLoraJobs.add(key);
      throw new Error('この取り込みジョブは終了済みです');
    }
    job.progressAt = Date.now();
    await this.ctx.storage.put(key, job);
  }

  // この alarm 実行でまだ転送してよいか（パート数・バイト数の予算が残っているか）
  runBudgetLeft(run) {
    return run.parts < LORA_PARTS_PER_RUN && run.bytes < LORA_BYTES_PER_RUN;
  }

  // 直近まで前進していた（＝実行中とみなせる）か
  loraJobIsLive(job) {
    return job.status === 'pending'
      && Date.now() - (job.progressAt ?? job.created ?? 0) < LORA_STALL_TIMEOUT_MS;
  }

  // 進行中ジョブの生存確認。alarm 内の fetch が固まってもリクエスト側は動くので、
  // ポーリングのたびにここで見張る:
  //   - 長時間まったく前進しない → 打ち切って error にする（永久に「ダウンロード中…」
  //     のまま残り、クライアントの取り込みボタンも塞がったままになるのを防ぐ）
  //   - alarm が消えている → 張り直して続きから再開させる（実行が異常終了した場合）
  async superviseLoraJob(key, job) {
    const stalledMs = Date.now() - (job.progressAt ?? job.created ?? 0);
    if (stalledMs > LORA_STALL_TIMEOUT_MS) {
      await this.failLoraImport(key, job,
        `取り込みが ${Math.round(LORA_STALL_TIMEOUT_MS / 60000)} 分以上進まなかったため中断しました（回線かサーバー側の停止。もう一度お試しください）`);
      this.abortedLoraJobs.add(key);
      return job;
    }
    if (stalledMs > LORA_RESUME_STALE_MS) await this.ensureAlarm();
    return job;
  }

  // 取り込みジョブの一覧（調査用）。表示が進まないときに、ジョブが実際どの段階に
  // いるのか・alarm が張られているのかを外から確認するために使う
  async listLoraImports() {
    const jobs = await this.ctx.storage.list({ prefix: 'lora:job:' });
    const now = Date.now();
    const alarmAt = await this.ctx.storage.getAlarm();
    return {
      now: new Date(now).toISOString(),
      alarmAt: alarmAt ?? null,
      alarmInMs: alarmAt === null ? null : alarmAt - now,
      alarmOverdue: alarmAt !== null && alarmAt < now - ALARM_OVERDUE_MS,
      aborted: this.abortedLoraJobs.size,
      jobs: [...jobs].map(([key, j]) => ({
        id: key.slice('lora:job:'.length),
        status: j.status,
        step: j.step,
        kind: j.kind ?? 'lora',
        fileName: j.meta?.fileName ?? null,
        repo: j.repo ?? null,
        sourceUrl: j.sourceUrl ?? null,
        bytesDone: j.bytesDone ?? null,
        bytesTotal: j.bytesTotal ?? null,
        runs: j.runs ?? 0,
        attempts: j.attempts ?? 0,
        createdAgoSec: Math.round((now - (j.created ?? now)) / 1000),
        progressAgoSec: Math.round((now - (j.progressAt ?? j.created ?? now)) / 1000),
        error: j.error ?? null,
        lastError: j.lastError ?? null,
      })),
    };
  }

  // ジョブの中止（ユーザー操作）。走っている実行も次の保存で止まる
  async cancelLoraImport(id) {
    const key = `lora:job:${id}`;
    const job = await this.ctx.storage.get(key);
    if (!job) return false;
    if (job.status === 'pending') {
      await this.failLoraImport(key, job, '取り込みを中止しました');
    }
    this.abortedLoraJobs.add(key);
    return true;
  }

  async getLoraImport(id) {
    const key = `lora:job:${id}`;
    const job = await this.ctx.storage.get(key);
    if (!job) return null;
    if (job.status === 'pending') await this.superviseLoraJob(key, job);
    return {
      status: job.status,
      step: job.step,
      kind: job.kind ?? 'lora',
      fileName: job.meta?.fileName ?? null,
      hfUrl: job.hfUrl ?? null,
      skipped: job.skipped ?? false,
      bytesDone: job.bytesDone ?? null,
      bytesTotal: job.bytesTotal ?? null,
      error: job.error ?? null,
    };
  }

  // 並列パート転送の合算進捗カウンタ。stream(counter) を通ったバイト数を
  // job.bytesDone に加算して 1 秒ごとに保存する（複数パート同時でも合算になる）。
  // パートが失敗したら rollback(counter) で加算分を戻し、リトライでの二重加算を防ぐ
  makeProgressTally(key, job) {
    let lastSaved = 0;
    const save = async (force = false) => {
      if (!force && Date.now() - lastSaved < 1000) return;
      lastSaved = Date.now();
      await this.saveLoraJob(key, job);
    };
    return {
      stream: (counter) => new TransformStream({
        transform: async (chunk, controller) => {
          counter.n += chunk.byteLength;
          job.bytesDone += chunk.byteLength;
          await save();
          controller.enqueue(chunk);
        },
      }),
      rollback: async (counter) => {
        job.bytesDone -= counter.n;
        counter.n = 0;
        await save(true);
      },
      save,
    };
  }

  // 転送バイト数を job に間引き記録する TransformStream（プログレスバー表示用）。
  // base はレンジ転送（multipart の各パート）再開時の開始オフセット
  loraProgressStream(key, job, base = 0) {
    let counted = base;
    let lastSaved = 0;
    return new TransformStream({
      transform: async (chunk, controller) => {
        counted += chunk.byteLength;
        if (Date.now() - lastSaved > 1000) {
          lastSaved = Date.now();
          job.bytesDone = counted;
          await this.saveLoraJob(key, job);
        }
        controller.enqueue(chunk);
      },
    });
  }

  async failLoraImport(key, job, message) {
    job.status = 'error';
    job.error = message;
    await this.abortStagingMultipart(key, job);
    await this.saveLoraJob(key, job);
    await this.deleteLoraStaging(key);
  }

  loraStagingKey(key) {
    return `${LORA_STAGING_PREFIX}${key.slice('lora:job:'.length)}`;
  }

  // アップロード計画（LFS の転送先一覧）の置き場。ステージング本体と同じ接頭辞に
  // 置くので、取り残されても 24 時間後の掃除で一緒に回収される
  loraPlanKey(key) {
    return `${this.loraStagingKey(key)}.plan.json`;
  }

  async deleteLoraStaging(key) {
    try {
      await this.env.IMAGES.delete([this.loraStagingKey(key), this.loraPlanKey(key)]);
    } catch { /* 消せなくても 24h 後の掃除で回収される */ }
  }

  // やりかけの multipart ステージングを破棄する（未使用なら no-op）。
  // 完了しなかった multipart のパートは R2 の一覧に出ないまま容量を消費し続ける
  // ため、リトライ・失敗・ジョブ掃除の各所で明示的に破棄する
  async abortStagingMultipart(key, job) {
    if (!job?.stagingUploadId) {
      if (job) {
        job.stagingParts = {};
        job.stagingPartSize = null;
      }
      return;
    }
    try {
      await this.env.IMAGES.resumeMultipartUpload(this.loraStagingKey(key), job.stagingUploadId).abort();
    } catch { /* 既に完了・破棄済みならそれで良い */ }
    job.stagingUploadId = null;
    job.stagingParts = {};
    job.stagingPartSize = null;
  }

  // R2 の単発 PUT 上限を超えるファイルをステージングへ multipart で保存する。
  // 入力ストリームをパートサイズごとに区切り、順番に uploadPart へ流す
  //（メモリにパートを溜めない。各パートの書き込みはアップロードの進みに合わせて
  // バックプレッシャーがかかる）
  async putStagingMultipart(key, job, stream, size) {
    await this.abortStagingMultipart(key, job); // 前回の試行の残骸があれば先に破棄
    const upload = await this.env.IMAGES.createMultipartUpload(this.loraStagingKey(key));
    job.stagingUploadId = upload.uploadId;
    await this.saveLoraJob(key, job);

    const reader = stream.getReader();
    let leftover = null;
    const parts = [];
    const partCount = Math.ceil(size / R2_PART_SIZE);
    for (let n = 1; n <= partCount; n++) {
      const len = Math.min(R2_PART_SIZE, size - (n - 1) * R2_PART_SIZE);
      const { readable, writable } = new FixedLengthStream(len);
      const putPromise = upload.uploadPart(n, readable);
      const writer = writable.getWriter();
      let written = 0;
      while (written < len) {
        let chunk = leftover;
        leftover = null;
        if (!chunk) {
          const { done, value } = await reader.read();
          if (done) throw new Error('ステージング中にダウンロードが途切れました');
          chunk = value;
        }
        if (chunk.byteLength > len - written) {
          leftover = chunk.subarray(len - written);
          chunk = chunk.subarray(0, len - written);
        }
        await writer.write(chunk);
        written += chunk.byteLength;
      }
      await writer.close();
      parts.push(await putPromise);
    }
    await upload.complete(parts);
    job.stagingUploadId = null;
    await this.saveLoraJob(key, job);
  }

  // ステップを進められるだけ進める。ネットワーク断などの例外は pending のまま抜けて
  // 次の alarm で再試行する（連続エラー数と通算実行回数の両方で打ち切り）
  async runLoraImportJob(key, job, run) {
    // 転送予算を使い切っていても、転送を伴わないステップ（モデル情報の確認・コミット）は
    // 進めてよい。大きな取り込みが走っている間、他のジョブが始まらないのを防ぐ
    if (!this.runBudgetLeft(run) && job.step !== 'resolve' && job.step !== 'commit') return;
    run.yielded = false; // 中断フラグはジョブごとに見る（予算自体は実行全体で共有）
    try {
      job.runs = (job.runs ?? 0) + 1;
      if (job.attempts >= LORA_IMPORT_MAX_ATTEMPTS || job.runs > LORA_IMPORT_MAX_RUNS) {
        await this.failLoraImport(key, job, job.lastError
          ? `取り込みを完了できませんでした: ${job.lastError}`
          : '取り込みを完了できませんでした（エラーが続いています）');
        return;
      }
      job.attempts += 1;
      await this.saveLoraJob(key, job);

      while (job.status === 'pending') {
        const stepBefore = job.step;
        if (job.step === 'resolve') await this.loraStepResolve(key, job);
        else if (job.step === 'download') await this.loraStepDownload(key, job, run);
        else if (job.step === 'upload') await this.loraStepUpload(key, job, run);
        else if (job.step === 'commit') await this.loraStepCommit(key, job);
        else {
          await this.failLoraImport(key, job, `不明なステップです: ${job.step}`);
          return;
        }
        job.lastError = null; // ステップを通せたので、前回の失敗理由は持ち越さない
        if (run.yielded) break;
        // 転送ステップが切り替わったら、予算を使いかけのまま次に進まず一度 alarm に返す。
        // 残り予算が中途半端だとアップロード開始直後に中断することになり、転送先を
        // 取り直すぶんだけ無駄が出る
        if (job.step !== stepBefore && (run.parts > 0 || run.bytes > 0)) break;
      }
    } catch (err) {
      // pending のまま次の alarm で再試行。打ち切り時の説明に使うので理由は控えておく
      const timedOut = err?.name === 'TimeoutError' || /aborted due to timeout/i.test(String(err?.message ?? ''));
      job.lastError = timedOut
        ? `${CIVITAI_STEP_NAMES[job.step] ?? job.step}で応答がありませんでした（タイムアウト）`
        : String(err?.message ?? err).slice(0, 200);
      try {
        await this.saveLoraJob(key, job);
      } catch { /* 打ち切り済みジョブ（書き戻し禁止）ならそのまま終わる */ }
    }
  }

  // メタデータ解決と、アップロード済みチェック（同一 SHA256 が既にあれば登録だけで済む）
  async loraStepResolve(key, job) {
    const { doc, ...meta } = await civitaiResolve(job.sourceUrl, this.env);
    job.meta = meta;
    job.metaDoc = job.saveMeta ? doc : null;

    let tree;
    try {
      tree = await fetchHfTree(job.repo, this.env);
    } catch (err) {
      if (err.status === 401 || err.status === 404) {
        await this.failLoraImport(key, job,
          `アップロード先リポジトリ ${job.repo} にアクセスできません（HTTP ${err.status}。ID の誤りか、HF_TOKEN の権限不足です）`);
        return;
      }
      throw err; // ネットワーク断などは再試行
    }
    if (job.meta.sha256) {
      const hit = tree.find((e) => e.type === 'file' && e.lfs?.oid === job.meta.sha256);
      if (hit) {
        job.skipped = true;
        job.meta.fileName = hit.path;
        job.hfUrl = hfResolveUrl(job.repo, hit.path);
        // 本体はアップロード済みでもサイト情報 JSON が無ければコミットだけ行う
        //（メタデータの後付け取り込みにもなる）
        if (job.metaDoc && !tree.some((e) => e.path === civitaiMetaJsonPath(hit.path))) {
          job.metaOnly = true;
          job.step = 'commit';
        } else {
          job.status = 'done';
        }
        await this.saveLoraJob(key, job);
        return;
      }
    }
    job.step = 'download';
    await this.saveLoraJob(key, job);
  }

  // Civitai 系ホストにのみ認可ヘッダを付ける（S3 等のリダイレクト先には渡さない）
  civitaiDlHeaders(url) {
    const headers = { 'User-Agent': 'fal-playground' };
    if (this.env.CIVITAI_TOKEN && CIVITAI_HOSTS.test(new URL(url).hostname)) {
      headers.Authorization = `Bearer ${this.env.CIVITAI_TOKEN}`;
    }
    return headers;
  }

  // ダウンロード URL をリダイレクト追跡込みで開く。range を渡すとそのまま付ける
  //（署名付き URL の期限切れ対策として、リトライのたびにここから引き直す）。
  // expectBytes は本文を読み切るまでのタイムアウト見積もりに使う
  async civitaiOpen(sourceUrl, range, expectBytes = 0) {
    let dlUrl = sourceUrl;
    let res = null;
    for (let hop = 0; hop < 5; hop++) {
      const headers = this.civitaiDlHeaders(dlUrl);
      if (range) headers.Range = range;
      res = await fetch(dlUrl, { headers, redirect: 'manual', signal: transferSignal(expectBytes) });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('Location');
        if (!loc) break;
        dlUrl = new URL(loc, dlUrl).toString();
        continue;
      }
      break;
    }
    return { res, finalUrl: dlUrl };
  }

  // Civitai からダウンロードして R2 に一時保存する。Range 対応かつ SHA256 の
  // 公称値がある場合は並列分割ダウンロード（パート単位で再開できる）、それ以外は
  // 従来どおり 1 本のストリームで保存しつつ SHA256 を計算する
  async loraStepDownload(key, job, run) {
    // Range: bytes=0-0 の探りで、到達性・範囲リクエスト対応・総サイズを一度に調べる
    const { res, finalUrl } = await this.civitaiOpen(job.meta.downloadUrl, 'bytes=0-0');
    if (res.status === 401 || res.status === 403) {
      await this.failLoraImport(key, job,
        'Civitai がダウンロードを拒否しました（CIVITAI_TOKEN が未設定・無効か、Early Access 中のモデルです）');
      return;
    }
    if (!res.ok) {
      await this.failLoraImport(key, job, `Civitai からのダウンロードに失敗しました（HTTP ${res.status}）`);
      return;
    }

    // 206 なら Content-Range の総サイズ、200（Range 非対応）なら Content-Length
    const ranged = res.status === 206;
    const size = ranged
      ? Number((res.headers.get('Content-Range') || '').split('/')[1])
      : Number(res.headers.get('Content-Length'));
    if (!Number.isFinite(size) || size <= 0) {
      await this.failLoraImport(key, job, 'ダウンロード応答にサイズ情報がなく取り込めません');
      return;
    }
    const maxBytes = job.kind === 'ckpt' ? CKPT_MAX_BYTES : LORA_MAX_BYTES;
    if (size > maxBytes) {
      await this.failLoraImport(key, job, job.kind === 'ckpt'
        ? `ファイルが大きすぎます（${(size / 1024 ** 3).toFixed(1)} GB）。Civitai 経由の取り込みは約 ${CKPT_MAX_BYTES / 1024 ** 3} GB までです`
        : `ファイルが大きすぎます（${(size / 1024 ** 3).toFixed(1)} GB）。LoRA の取り込みは ${LORA_MAX_BYTES / 1024 ** 3} GB までです。チェックポイントを取り込む場合は、チェックポイント指定版モデルのチェックポイント欄にある「Civitai から取り込み」を使ってください`);
      return;
    }
    if (!job.meta.fileName) {
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename\*?="?([^";]+)"?/);
      let name = m ? m[1].replace(/^UTF-8''/i, '') : `civitai-${job.meta.versionId ?? 'model'}`;
      try {
        name = decodeURIComponent(name);
      } catch { /* エンコードが壊れていればそのまま使う */ }
      job.meta.fileName = sanitizeLoraFileName(name);
    }

    job.bytesTotal = size;
    await this.saveLoraJob(key, job);

    if (ranged && job.meta.sha256 && size > CHUNKED_DL_MIN_BYTES) {
      // 並列分割ダウンロード。逐次の SHA256 計算はできないため oid には公称値を使う
      //（各パートは長さ検証つき。内容が公称値と食い違っていれば HF 側の検証で弾かれる）
      await res.body?.cancel();
      const finished = await this.chunkedStagingDownload(key, job, finalUrl, size, run);
      if (!finished) return; // 予算切れ。残りのパートは次の alarm 実行で取得する
      job.sha256 = job.meta.sha256;
    } else {
      // 逐次ストリーム経路。探りが 200（Range 非対応）ならその応答をそのまま使い、
      // 206 なら全体を取り直す
      let body = res.body;
      if (ranged) {
        await res.body?.cancel();
        const full = await this.civitaiOpen(job.meta.downloadUrl, null, size);
        if (!full.res.ok) {
          throw new Error(`download error ${full.res.status}`); // pending のまま次の alarm で再試行
        }
        body = full.res.body;
      }
      // 並列経路のやりかけが残っていれば破棄してから単発ストリームで保存する
      await this.abortStagingMultipart(key, job);
      job.bytesDone = 0;
      await this.saveLoraJob(key, job);

      // R2 への保存と SHA256 計算を 1 パスで行う。DigestStream への write を
      // TransformStream 内で await することで、バッファを溜めずに両者へ流す
      const digester = new crypto.DigestStream('SHA-256');
      const writer = digester.getWriter();
      const stream = body
        .pipeThrough(new TransformStream({
          async transform(chunk, controller) {
            await writer.write(chunk);
            controller.enqueue(chunk);
          },
          async flush() {
            await writer.close();
          },
        }))
        .pipeThrough(this.loraProgressStream(key, job))
        .pipeThrough(new FixedLengthStream(size));
      // R2 の単発 PUT 上限を超えるサイズは multipart で保存する
      if (size > R2_SINGLE_PUT_MAX) {
        await this.putStagingMultipart(key, job, stream, size);
      } else {
        await this.env.IMAGES.put(this.loraStagingKey(key), stream);
      }

      const sha256 = [...new Uint8Array(await digester.digest)]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      if (job.meta.sha256 && sha256 !== job.meta.sha256) {
        await this.failLoraImport(key, job, 'ダウンロードしたファイルの SHA256 が Civitai の公称値と一致しません');
        return;
      }
      job.sha256 = sha256;
      run.bytes += size; // 分割できない経路なので中断はしないが、予算は消費した扱いにする
    }
    job.size = size;
    job.step = 'upload';
    await this.saveLoraJob(key, job);
  }

  // Range 並列ダウンロード + R2 multipart 保存。完了済みパートはジョブ記録に控え、
  // 途中断・リトライ時は残りのパートだけをやり直す（巨大ファイルでも全体の
  // やり直しが発生しない）。パートが進むたび attempts を 1 戻すので、前進が続く限りは
  // 打ち切られず、停滞すれば連続エラー数・通算実行回数・停滞時間のどれかで止まる
  async chunkedStagingDownload(key, job, finalUrl, size, run) {
    const partSize = size > 8 * 1024 * 1024 * 1024 ? R2_PART_SIZE : R2_SMALL_PART_SIZE;
    const stagingKey = this.loraStagingKey(key);
    let upload;
    if (job.stagingUploadId && job.stagingPartSize === partSize) {
      upload = this.env.IMAGES.resumeMultipartUpload(stagingKey, job.stagingUploadId);
    } else {
      await this.abortStagingMultipart(key, job);
      upload = await this.env.IMAGES.createMultipartUpload(stagingKey);
      job.stagingUploadId = upload.uploadId;
      job.stagingPartSize = partSize;
      job.stagingParts = {};
      await this.saveLoraJob(key, job);
    }

    const partCount = Math.ceil(size / partSize);
    const partLen = (n) => Math.min(partSize, size - (n - 1) * partSize);
    const pending = [];
    for (let n = 1; n <= partCount; n++) {
      if (!job.stagingParts[n]) pending.push(n);
    }
    // 再開時は保存済みパートのバイト数から数え直す
    job.bytesDone = Object.keys(job.stagingParts)
      .reduce((sum, n) => sum + partLen(Number(n)), 0);
    await this.saveLoraJob(key, job);

    const tally = this.makeProgressTally(key, job);
    const worker = async () => {
      while (pending.length > 0) {
        if (!this.runBudgetLeft(run)) return; // 予算切れ。残りは次の alarm 実行へ
        const n = pending.shift();
        const offset = (n - 1) * partSize;
        const len = partLen(n);
        run.parts += 1;
        run.bytes += len;
        let lastErr = null;
        for (let retry = 0; retry < 3; retry++) {
          const counter = { n: 0 };
          try {
            const res = await fetch(finalUrl, {
              headers: { ...this.civitaiDlHeaders(finalUrl), Range: `bytes=${offset}-${offset + len - 1}` },
              signal: transferSignal(len), // 無音のまま繋ぎっぱなしになる相手を切る
            });
            if (res.status !== 206) {
              await res.body?.cancel();
              throw new Error(`range request failed (HTTP ${res.status})`);
            }
            const part = await upload.uploadPart(
              n,
              res.body.pipeThrough(tally.stream(counter)).pipeThrough(new FixedLengthStream(len)),
            );
            job.stagingParts[n] = { partNumber: part.partNumber, etag: part.etag };
            job.attempts = Math.max(0, job.attempts - 1); // 前進したぶんだけ打ち切りカウントを戻す
            lastErr = null;
            await tally.save(true);
            break;
          } catch (err) {
            await tally.rollback(counter);
            lastErr = err;
          }
        }
        // 同じパートで 3 回失敗したら一旦諦める（ジョブは pending のまま。次の alarm で
        // URL を引き直して残りから再開する。署名付き URL の期限切れもこれで回復する）
        if (lastErr) throw lastErr;
      }
    };
    await Promise.all(Array.from({ length: DL_CONCURRENCY }, worker));

    if (pending.length > 0) {
      run.yielded = true; // 予算切れ。完了パートは記録済みなので次の実行が続きを取る
      await this.saveLoraJob(key, job);
      return false;
    }

    const parts = Object.values(job.stagingParts).sort((a, b) => a.partNumber - b.partNumber);
    await upload.complete(parts);
    job.stagingUploadId = null;
    job.bytesDone = size;
    await this.saveLoraJob(key, job);
    return true;
  }

  // アップロード計画（LFS batch API の応答）を得る。転送先の一覧は multipart だと
  // 数百件になり Durable Object のストレージには収まらないので R2 に置く。batch を
  // 叩き直すと multipart セッション（uploadId）が変わって送信済みのパートが無効に
  // なるため、複数回の alarm 実行にまたがるときは同じ計画を読み直して使い続ける
  async loraUploadPlan(key, job, lfsHeaders) {
    if (job.planAt && Date.now() - job.planAt < LORA_UPLOAD_PLAN_TTL_MS) {
      const saved = await this.env.IMAGES.get(this.loraPlanKey(key));
      if (saved) return await saved.json();
    }

    const batchRes = await fetch(`${HF_BASE}/${job.repo}.git/info/lfs/objects/batch`, {
      method: 'POST',
      headers: lfsHeaders,
      body: JSON.stringify({
        operation: 'upload',
        transfers: ['basic', 'multipart'],
        objects: [{ oid: job.sha256, size: job.size }],
        hash_algo: 'sha256',
      }),
      signal: apiSignal(),
    });
    if (!batchRes.ok) {
      if (batchRes.status >= 400 && batchRes.status < 500) {
        await this.failLoraImport(key, job,
          `Hugging Face LFS API がリクエストを拒否しました（HTTP ${batchRes.status}: ${(await batchRes.text()).slice(0, 200)}）`);
        return null;
      }
      throw new Error(`LFS batch error ${batchRes.status}`);
    }
    const object = (await batchRes.json())?.objects?.[0];
    if (object?.error) {
      await this.failLoraImport(key, job, `Hugging Face LFS error: ${object.error.message ?? 'unknown'}`);
      return null;
    }

    const upload = object?.actions?.upload;
    const header = upload?.header ?? {};
    const chunkSize = Number(header.chunk_size);
    const verify = object?.actions?.verify;
    // actions が無い場合は同一オブジェクトがサーバー側に既にある（コミットだけでよい）
    const plan = {
      mode: !upload ? 'skip' : (Number.isFinite(chunkSize) && chunkSize > 0 ? 'multipart' : 'basic'),
      href: upload?.href ?? null,
      header,
      // verify はアップロードした場合だけ呼ぶ（既にサーバー側にあるなら不要）
      verify: upload && verify ? { href: verify.href, header: verify.header ?? {} } : null,
    };

    // 新しい計画になったら、前の計画に送ったパートは無効なので送り直す
    job.etags = {};
    job.planAt = null;
    if (plan.mode === 'multipart') {
      const partCount = Object.keys(header).filter((k) => /^\d+$/.test(k)).length;
      // 1 回の実行に収まらないときだけ計画を保存する（LoRA 程度なら従来どおり使い捨て）
      if (partCount > LORA_PARTS_PER_RUN) {
        await this.env.IMAGES.put(this.loraPlanKey(key), JSON.stringify(plan));
        job.planAt = Date.now();
      }
    }
    await this.saveLoraJob(key, job);
    return plan;
  }

  // multipart の各パートを送る。header の連番キーが PUT 先 URL で、完了ごとに etag を
  // 保存して再開できるようにする。パートが進むたび attempts を 1 戻すので、前進が
  // 続く限りは打ち切られない。全パートを送り終えたときだけ true を返す
  async loraUploadMultipart(key, job, run, plan, stagingKey, lfsHeaders) {
    const chunkSize = Number(plan.header.chunk_size);
    const parts = Object.keys(plan.header)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    const uploadPartLen = (p) => Math.min(chunkSize, job.size - (Number(p) - 1) * chunkSize);
    const pending = parts.filter((p) => !job.etags[p]); // 再開時はアップロード済みを飛ばす
    // 再開時はアップロード済みパートのバイト数から数え直す
    job.bytesDone = parts.filter((p) => job.etags[p])
      .reduce((sum, p) => sum + uploadPartLen(p), 0);
    await this.saveLoraJob(key, job);

    const tally = this.makeProgressTally(key, job);
    let stagingLost = false;
    let planStale = false;
    const uploadWorker = async () => {
      while (pending.length > 0 && !stagingLost) {
        if (!this.runBudgetLeft(run)) return; // 予算切れ。残りは次の alarm 実行へ
        const part = pending.shift();
        const offset = (Number(part) - 1) * chunkSize;
        const length = uploadPartLen(part);
        run.parts += 1;
        run.bytes += length;
        const counter = { n: 0 };
        try {
          const obj = await this.env.IMAGES.get(stagingKey, { range: { offset, length } });
          if (!obj) {
            stagingLost = true;
            return;
          }
          const putRes = await fetch(plan.header[part], {
            method: 'PUT',
            body: obj.body.pipeThrough(tally.stream(counter)).pipeThrough(new FixedLengthStream(length)),
            signal: transferSignal(length),
          });
          if (!putRes.ok) {
            // 署名 URL の失効。計画ごと取り直す（同じ URL で再試行しても通らない）
            if (putRes.status === 401 || putRes.status === 403) planStale = true;
            throw new Error(`part ${part} upload error ${putRes.status}`);
          }
          job.etags[part] = putRes.headers.get('ETag') ?? '';
          job.attempts = Math.max(0, job.attempts - 1); // 前進したぶんだけ打ち切りカウントを戻す
          await tally.save(true);
        } catch (err) {
          await tally.rollback(counter);
          throw err;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, uploadWorker));
    } catch (err) {
      if (planStale) {
        job.planAt = null;
        job.etags = {};
        await this.saveLoraJob(key, job);
      }
      throw err;
    }

    if (stagingLost) {
      // 一時ファイルが消えている（R2 掃除など）。download からやり直す
      job.step = 'download';
      job.etags = {};
      job.planAt = null;
      await this.abortStagingMultipart(key, job);
      await this.saveLoraJob(key, job);
      return false;
    }
    if (pending.length > 0) {
      run.yielded = true; // 予算切れ。送信済みの etag は保存済みなので続きから送れる
      await this.saveLoraJob(key, job);
      return false;
    }

    const completeRes = await fetch(plan.href, {
      method: 'POST',
      headers: lfsHeaders,
      body: JSON.stringify({
        oid: job.sha256,
        parts: parts.map((p) => ({ partNumber: Number(p), etag: job.etags[p] })),
      }),
      signal: apiSignal(),
    });
    if (!completeRes.ok) throw new Error(`multipart complete error ${completeRes.status}`);
    return true;
  }

  // HF の LFS プロトコルでアップロードする: batch API で転送先を取得し、
  // multipart（応答 header の chunk_size + 連番 URL）なら分割 PUT + 完了通知、
  // そうでなければ単発 PUT。verify アクションがあれば最後に呼ぶ
  async loraStepUpload(key, job, run) {
    const stagingKey = this.loraStagingKey(key);
    job.bytesTotal = job.size;
    if (!job.planAt) job.bytesDone = 0; // 再開時はパートの etag から数え直す
    await this.saveLoraJob(key, job);
    const lfsHeaders = {
      Accept: 'application/vnd.git-lfs+json',
      'Content-Type': 'application/vnd.git-lfs+json',
      ...hfAuthHeaders(this.env),
    };

    const plan = await this.loraUploadPlan(key, job, lfsHeaders);
    if (!plan) return; // 打ち切り済み（failLoraImport 済み）

    if (plan.mode === 'multipart') {
      const finished = await this.loraUploadMultipart(key, job, run, plan, stagingKey, lfsHeaders);
      if (!finished) return; // 予算切れ・一時ファイル消失。続きは次の alarm 実行で
    } else if (plan.mode === 'basic') {
      // basic: 応答の header をそのまま付けて単発 PUT
      const obj = await this.env.IMAGES.get(stagingKey);
      if (!obj) {
        job.step = 'download';
        await this.saveLoraJob(key, job);
        return;
      }
      const putRes = await fetch(plan.href, {
        method: 'PUT',
        headers: { ...plan.header },
        body: obj.body
          .pipeThrough(this.loraProgressStream(key, job))
          .pipeThrough(new FixedLengthStream(job.size)),
        signal: transferSignal(job.size),
      });
      if (!putRes.ok) throw new Error(`upload error ${putRes.status}`);
      run.bytes += job.size;
    }

    if (plan.verify) {
      const verifyRes = await fetch(plan.verify.href, {
        method: 'POST',
        headers: { ...lfsHeaders, ...plan.verify.header },
        body: JSON.stringify({ oid: job.sha256, size: job.size }),
        signal: apiSignal(),
      });
      if (!verifyRes.ok) throw new Error(`verify error ${verifyRes.status}`);
    }

    job.step = 'commit';
    job.planAt = null;
    await this.saveLoraJob(key, job);
  }

  // commit API（NDJSON）で LFS ポインタとサイト情報 JSON をリポジトリに記録して完了。
  // metaOnly のとき（本体はアップロード済みで JSON が無いだけ）は JSON のみコミットする
  async loraStepCommit(key, job) {
    const summaryName = job.meta.modelName
      ? `${job.meta.modelName}${job.meta.versionName ? ` (${job.meta.versionName})` : ''}`
      : job.meta.fileName;
    const lines = [
      {
        key: 'header',
        value: { summary: `${job.metaOnly ? 'Add metadata for' : 'Upload'} ${summaryName} from Civitai` },
      },
    ];
    if (!job.metaOnly) {
      lines.push({
        key: 'lfsFile',
        value: { path: job.meta.fileName, algo: 'sha256', oid: job.sha256, size: job.size },
      });
    }
    if (job.metaDoc) {
      lines.push({
        key: 'file',
        value: {
          path: civitaiMetaJsonPath(job.meta.fileName),
          content: bytesToBase64(new TextEncoder().encode(JSON.stringify(job.metaDoc, null, 2))),
          encoding: 'base64',
        },
      });
    }
    const res = await fetch(`${HF_BASE}/api/models/${job.repo}/commit/main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson', ...hfAuthHeaders(this.env) },
      body: lines.map((l) => JSON.stringify(l)).join('\n'),
      signal: apiSignal(),
    });
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        await this.failLoraImport(key, job,
          `Hugging Face へのコミットに失敗しました（HTTP ${res.status}: ${(await res.text()).slice(0, 200)}）`);
        return;
      }
      throw new Error(`commit error ${res.status}`);
    }
    job.status = 'done';
    job.hfUrl = hfResolveUrl(job.repo, job.meta.fileName);
    await this.saveLoraJob(key, job);
    await this.deleteLoraStaging(key);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const stub = env.STATE.get(env.STATE.idFromName('singleton'));
    // 変更系 API は JSON の Content-Type を必須にする（クロスサイトの form 送信対策）
    const isJson = (request.headers.get('Content-Type') || '').includes('application/json');

    // Hugging Face 公開リポジトリのファイル一覧の中継。
    // ブラウザから huggingface.co を直接叩くと CORS 等で失敗するため、
    // 同一オリジンの API として提供する（公開データのみ・repo 形式を厳密に検証）
    // モデルの隣に保存した .civitai.json を読み出す（LoRA ライブラリのトリガーワード等）。
    // ブラウザから huggingface.co を直接叩くと CORS で失敗し、非公開リポジトリは
    // トークンが要るため Worker 経由にする。返すのは表示に使う項目だけ
    if (url.pathname === '/api/lora/meta') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const target = hfMetaJsonUrl(url.searchParams.get('url') || '');
      if (!target) {
        return new Response('url は Hugging Face の .safetensors の URL を指定してください', { status: 422 });
      }
      let res;
      try {
        res = await fetch(target, {
          headers: { 'User-Agent': 'fal-playground', ...hfAuthHeaders(env) },
          signal: apiSignal(),
        });
      } catch {
        return new Response('Hugging Face に接続できませんでした', { status: 502 });
      }
      if (res.status === 404) return new Response('サイト情報 JSON がありません', { status: 404 });
      if (!res.ok) return new Response(`Hugging Face error ${res.status}`, { status: 502 });
      let doc;
      try {
        doc = await res.json();
      } catch {
        return new Response('サイト情報 JSON を解釈できませんでした', { status: 502 });
      }
      return Response.json(civitaiMetaSummary(doc));
    }

    if (url.pathname === '/api/hf/tree') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const repo = url.searchParams.get('repo') || '';
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return new Response('Invalid repo', { status: 400 });
      // expand=true で各ファイルの最終コミット日時（lastCommit.date）も取得する
      //（クライアント側で「追加日の新しい順」に並べるため）
      try {
        return Response.json(await fetchHfTree(repo, env));
      } catch (err) {
        return new Response(err.body ?? err.message, {
          status: err.status ?? 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Civitai URL の事前確認（取り込みダイアログのプレビュー用）。モデル情報と、
    // アップロード先リポジトリに同じ内容・同じ名前が既にあるかを返す
    if (url.pathname === '/api/civitai/resolve') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const repo = url.searchParams.get('repo') || '';
      // repo 省略は「Civitai の情報だけ欲しい」場合（Runware へ AIR で参照するとき）。
      // 指定された場合だけ、取り込み先リポジトリの重複も見る
      if (repo !== '' && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        return new Response('Invalid repo', { status: 400 });
      }
      let resolved;
      try {
        resolved = await civitaiResolve(url.searchParams.get('url'), env);
      } catch (err) {
        return new Response(err.message, { status: 422 });
      }
      const { doc, ...meta } = resolved;
      let alreadyUploaded = null;
      let nameExists = false;
      let metaFileExists = false;
      let repoError = null;
      if (repo === '') {
        return Response.json({ ...meta, metaDoc: doc, alreadyUploaded, nameExists, metaFileExists, repoError });
      }
      try {
        const tree = await fetchHfTree(repo, env);
        if (meta.sha256) {
          const hit = tree.find((e) => e.type === 'file' && e.lfs?.oid === meta.sha256);
          if (hit) {
            alreadyUploaded = hfResolveUrl(repo, hit.path);
            metaFileExists = tree.some((e) => e.path === civitaiMetaJsonPath(hit.path));
          }
        }
        nameExists = meta.fileName != null
          && tree.some((e) => e.type === 'file' && e.path === meta.fileName);
      } catch (err) {
        // 401 はトークンの期限切れ・権限不足、404 は ID の誤りか非公開。
        // タイムアウトや回線断もここに来るので、原因が分かるように理由を添える
        const why = err.status === 401 ? 'HF_TOKEN の期限切れか権限不足です'
          : err.status === 404 ? 'リポジトリ ID が違うか、トークンに読み取り権限がありません'
            : err.name === 'TimeoutError' ? 'Hugging Face が時間内に応答しませんでした'
              : `${err.message ?? err}`;
        repoError = `アップロード先リポジトリ ${repo} を確認できません`
          + `（HTTP ${err.status ?? '-'}: ${String(why).slice(0, 120)}）`;
      }
      return Response.json({ ...meta, metaDoc: doc, alreadyUploaded, nameExists, metaFileExists, repoError });
    }

    // Civitai → HF 取り込みジョブの投入。ダウンロード〜アップロードは数分かかり
    // うるので、生成ジョブとは別の DO インスタンスの alarm で処理する
    if (url.pathname === '/api/lora-import') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!isJson) return new Response('Content-Type must be application/json', { status: 415 });
      if (!env.HF_TOKEN) {
        return new Response('HF_TOKEN is not configured（Worker の Secret に Hugging Face の write トークンを設定してください）', { status: 500 });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      const { jobId, url: sourceUrl, repo } = payload ?? {};
      if (typeof jobId !== 'string' || !/^[0-9a-f]{32}$/.test(jobId)) {
        return new Response('jobId is required', { status: 422 });
      }
      if (!civitaiParseUrl(sourceUrl)) {
        return new Response('url は civitai.com のモデルページ URL またはダウンロード URL を指定してください', { status: 422 });
      }
      if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        return new Response('repo は owner/repo の形式で指定してください', { status: 422 });
      }
      const saveMeta = payload.saveMeta !== false; // 既定はサイト情報 JSON も保存する
      const kind = payload.kind === 'ckpt' ? 'ckpt' : 'lora';
      const importStub = env.STATE.get(env.STATE.idFromName('lora-import'));
      await importStub.startLoraImport(jobId, sourceUrl, repo, saveMeta, kind);
      return Response.json({ queued: true, jobId });
    }

    // 取り込みジョブの一覧（調査用）。ブラウザで開いて状態を確認できるようにしておく
    if (url.pathname === '/api/lora-import/jobs') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const importStub = env.STATE.get(env.STATE.idFromName('lora-import'));
      return new Response(JSON.stringify(await importStub.listLoraImports(), null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    // 取り込みジョブの状態取得（クライアントはこれをポーリングする）。DELETE で中止
    const loraJobMatch = url.pathname.match(/^\/api\/lora-import\/job\/([0-9a-f]{32})$/);
    if (loraJobMatch) {
      const importStub = env.STATE.get(env.STATE.idFromName('lora-import'));
      if (request.method === 'DELETE') {
        const ok = await importStub.cancelLoraImport(loraJobMatch[1]);
        return Response.json({ cancelled: ok });
      }
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const job = await importStub.getLoraImport(loraJobMatch[1]);
      if (!job) return new Response('Job not found', { status: 404 });
      return Response.json(job);
    }

    // WaveSpeed API のプロキシ。fal と同じく API キー（Secret の WAVESPEED_API_KEY）は
    // ここで付与する。転送先は api.wavespeed.ai のみ（submit も結果取得も同じホスト）
    if (url.pathname === '/api/wavespeed/proxy') {
      if (!['GET', 'POST'].includes(request.method)) {
        return new Response('Method not allowed', { status: 405 });
      }
      if (request.method !== 'GET' && !isJson) {
        return new Response('Content-Type must be application/json', { status: 415 });
      }
      let target;
      try {
        target = new URL(url.searchParams.get('url') || '');
      } catch {
        return new Response('Invalid target url', { status: 400 });
      }
      if (target.protocol !== 'https:' || target.hostname !== 'api.wavespeed.ai') {
        return new Response('Target not allowed', { status: 403 });
      }
      if (!env.WAVESPEED_API_KEY) {
        return new Response('WAVESPEED_API_KEY is not configured（Worker の Secret に WaveSpeed の API キーを設定してください）', { status: 500 });
      }
      const upstream = await fetch(target, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${env.WAVESPEED_API_KEY}`,
          ...(request.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: request.method === 'GET' ? undefined : await request.text(),
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
      });
    }

    // Runware API のプロキシ。投入も結果取得（getResponse）も同じ URL に
    // タスクの配列を POST する形なので、転送先は api.runware.ai の 1 つだけ。
    // API キー（Secret の RUNWARE_API_KEY）はここで付与する
    if (url.pathname === '/api/runware/proxy') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!isJson) return new Response('Content-Type must be application/json', { status: 415 });
      let target;
      try {
        target = new URL(url.searchParams.get('url') || '');
      } catch {
        return new Response('Invalid target url', { status: 400 });
      }
      if (target.protocol !== 'https:' || target.hostname !== 'api.runware.ai') {
        return new Response('Target not allowed', { status: 403 });
      }
      if (!env.RUNWARE_API_KEY) {
        return new Response('RUNWARE_API_KEY is not configured（Worker の Secret に Runware の API キーを設定してください）', { status: 500 });
      }
      const upstream = await fetch(target, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RUNWARE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: await request.text(),
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
      });
    }

    // fal API のプロキシ。API キー（Secret の FAL_KEY）はここで付与し、ブラウザには
    // 一切渡さない。転送先はフル URL で受け取るが queue.fal.run のみに制限する
    if (url.pathname === '/api/fal/proxy') {
      if (!['GET', 'POST', 'PUT'].includes(request.method)) {
        return new Response('Method not allowed', { status: 405 });
      }
      if (request.method !== 'GET' && !isJson) {
        return new Response('Content-Type must be application/json', { status: 415 });
      }
      let target;
      try {
        target = new URL(url.searchParams.get('url') || '');
      } catch {
        return new Response('Invalid target url', { status: 400 });
      }
      if (target.protocol !== 'https:' || target.hostname !== 'queue.fal.run') {
        return new Response('Target not allowed', { status: 403 });
      }
      if (!env.FAL_KEY) {
        return new Response('FAL_KEY is not configured（Worker の Secret に fal の API キーを設定してください）', { status: 500 });
      }
      const upstream = await fetch(target, {
        method: request.method,
        headers: {
          Authorization: `Key ${env.FAL_KEY}`,
          ...(request.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: request.method === 'GET' ? undefined : await request.text(),
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
      });
    }

    // 生成履歴。追加時に外部（fal CDN）の画像をサーバーへ取り込み、失効しない
    // ローカル URL に差し替えたうえで、生成設定を PNG に焼き込む
    if (url.pathname === '/api/history') {
      await ensureHistoryCatalog(env, stub);
      if (request.method === 'GET') {
        const { records, cursor } = await historyPage(env, {
          limit: Number(url.searchParams.get('limit')),
          cursor: url.searchParams.get('cursor') ?? '',
          q: url.searchParams.get('q') ?? '',
          type: url.searchParams.get('type') ?? '',
        });
        // 続きの位置はヘッダで返し、本文は今までどおり配列のままにしておく。
        // デプロイ直後にまだ古い JS を持っているタブでも、直近の 1 ページぶんは
        // そのまま表示できる（読み込み直せば続きも追うようになる）
        // 片付けは裏で。一覧はページごとに来るので、先頭ページのときだけ乗せる
        if (!url.searchParams.get('cursor')) ctx?.waitUntil?.(runHousekeeping(env, stub));
        return Response.json(records, {
          headers: cursor ? { 'X-Next-Cursor': String(cursor) } : {},
        });
      }
      if (request.method === 'POST') {
        if (!isJson) return new Response('Content-Type must be application/json', { status: 415 });
        let record;
        try {
          record = await request.json();
        } catch {
          return new Response('Invalid JSON', { status: 400 });
        }
        if (typeof record?.id !== 'string' || !HISTORY_ID_RE.test(record.id)) {
          return new Response('Invalid record', { status: 422 });
        }
        for (const { images, loras } of recordImageLists(record)) {
          for (const img of images) {
            if (typeof img?.url !== 'string') continue;
            let src;
            try {
              src = new URL(img.url);
            } catch {
              continue; // 相対 URL（取り込み済みのローカル画像）はそのまま
            }
            if (src.protocol !== 'https:') continue;
            try {
              const local = await captureExternalImage(env, src, recordImageMeta(record, loras));
              if (local) img.url = local;
            } catch {
              // 取得できなければ元の URL のまま残す（表示は CDN の失効まで可能）。
              // 取りこぼしは captureMissingImages があとから拾う
            }
          }
        }
        const saved = await historySave(env, record);
        ctx?.waitUntil?.(runHousekeeping(env, stub)); // 片付けは裏で。応答は先に返る
        return Response.json(saved);
      }
      if (request.method === 'DELETE') {
        // 1 リクエストで使えるクエリ数に上限があるので、終わらなければ
        // done: false を返す（呼び出し側が終わるまで繰り返す）
        return Response.json({ ok: true, done: await historyClear(env, stub) });
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // 生成時間の統計。集計だけを返すので、応答の大きさは件数に依らない。
    // 1 件取得のルートより先に置くこと（stats が id として食われる）
    if (url.pathname === '/api/history/stats') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      await ensureHistoryCatalog(env, stub);
      return Response.json(await historyStats(env));
    }

    // 履歴 1 件の取得（マスクを含む丸ごと）と削除（保存済み画像も一緒に消す）
    const historyMatch = url.pathname.match(/^\/api\/history\/([\w.-]{1,100})$/);
    if (historyMatch) {
      await ensureHistoryCatalog(env, stub);
      if (request.method === 'GET') {
        const record = await historyGet(env, historyMatch[1]);
        if (!record) return new Response('Not found', { status: 404 });
        return Response.json(record);
      }
      if (request.method !== 'DELETE') return new Response('Method not allowed', { status: 405 });
      await historyDelete(env, stub, historyMatch[1]);
      return Response.json({ ok: true });
    }

    // 別サイトにある画像を R2 へ取り込んで、同一オリジンの URL にして返す。
    //
    // 履歴の保存時にも同じことをしているが、取り込めるホストを絞っているため、
    // プロバイダが別ドメインの CDN で返すと外部 URL のまま残る。それだと
    // (1) canvas で画素を扱えず（マスク合成が "The operation is insecure" で失敗）、
    // (2) CDN の URL が失効したあとに開き直せない。
    // 踏み台にされないよう、取り込めるのはこの履歴に実際に載っている URL だけ
    if (url.pathname === '/api/capture') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!isJson) return new Response('Content-Type must be application/json', { status: 415 });
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      const target = typeof body?.url === 'string' ? body.url : '';
      let src;
      try {
        src = new URL(target);
      } catch {
        return new Response('Invalid url', { status: 422 });
      }
      if (src.protocol !== 'https:') return new Response('https only', { status: 403 });
      await ensureHistoryCatalog(env, stub);
      if (!(await historyOwnsImage(env, target))) {
        return new Response('Unknown image', { status: 403 });
      }

      const local = await captureExternalImage(env, src);
      if (!local) return new Response('Upstream error', { status: 502 });
      return Response.json({ url: local });
    }

    // クライアント側で作った画像（アップロードした入力画像・切り抜き・合成結果など）の
    // 保存先。キーは中身の sha256（内容アドレス）なので、同じ画像は同じキーに収まる。
    // そこで 2 段階にして、持っている画像は送らずに済ませる:
    //   1) { hash } だけ POST → 持っていれば { url }、無ければ { url: null }
    //   2) 無かったときだけ { image, meta } を POST
    // 申告されたハッシュは鍵に使わない（サーバーが計算し直すので、嘘をつかれても
    // 正しいキーに収まるだけ）。meta があれば正規化して PNG へ焼き込むが、
    // 焼き込みは鍵を決めたあとなので、キーは「送られてきたバイト列」のハッシュになる
    if (url.pathname === '/api/upload') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!isJson) return new Response('Content-Type must be application/json', { status: 415 });
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      await ensureHistoryCatalog(env, stub);

      // 1) 持っているかの問い合わせ（本文に画像を含めない）
      if (body?.image === undefined) {
        const hash = typeof body?.hash === 'string' ? body.hash.toLowerCase() : '';
        if (!/^[0-9a-f]{64}$/.test(hash)) {
          return new Response('hash must be a sha-256 hex digest', { status: 422 });
        }
        if (!(await env.IMAGES.head(`${hash}.png`))) return Response.json({ url: null });
        await claimImage(env, hash); // これから使うので、掃除の印を外す
        return Response.json({ url: `/api/image/${hash}` });
      }

      // 2) 本体を受け取る
      const decoded = decodeImageDataUri(body.image);
      if (!decoded) return new Response('image must be a base64 image data URI', { status: 422 });
      if (decoded.bytes.length > UPLOAD_MAX_BYTES) {
        return new Response('Image too large', { status: 413 });
      }
      const stored = await storeImage(env, decoded.bytes, {
        meta: body.meta && typeof body.meta === 'object' ? body.meta : null,
        contentType: decoded.mime,
      });
      return Response.json({ url: stored.url });
    }

    // 使われなかった画像の回収。GET は最後の結果（統計に出す）、POST でその場で実行する
    if (url.pathname === '/api/images/sweep') {
      await ensureHistoryCatalog(env, stub);
      if (request.method === 'GET') {
        const state = await getMeta(env, [META_GC_STATS]);
        return Response.json(safeJsonParse(state.get(META_GC_STATS)) ?? { at: null, total: 0 });
      }
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      return Response.json(await sweepImages(env, stub));
    }


    // Poe（OpenAI 互換 API）での部分AI編集ジョブの投入。API キー（Secret の
    // POE_API_KEY）は Worker で付与し、ブラウザには渡さない。実際の呼び出しは
    // krea2 と同じく Durable Object の alarm で行い、クライアントはポーリングする
    if (url.pathname === '/api/poe/edit') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!isJson) return new Response('Content-Type must be application/json', { status: 415 });
      if (!env.POE_API_KEY) {
        return new Response('POE_API_KEY is not configured（Worker の Secret に Poe の API キーを設定してください）', { status: 500 });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      const { jobId, model, prompt, imageId, parameters } = payload ?? {};
      if (typeof jobId !== 'string' || !/^[0-9a-f]{32}$/.test(jobId)) {
        return new Response('jobId is required', { status: 422 });
      }
      if (typeof model !== 'string' || !/^[\w.-]{1,64}$/.test(model)) {
        return new Response('model is required', { status: 422 });
      }
      if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > 8000) {
        return new Response('prompt is required', { status: 422 });
      }
      if (typeof imageId !== 'string' || !IMAGE_ID_RE.test(imageId)) {
        return new Response('imageId is required', { status: 422 });
      }
      if (parameters != null && (typeof parameters !== 'object' || Array.isArray(parameters)
        || JSON.stringify(parameters).length > 2000)) {
        return new Response('Invalid parameters', { status: 422 });
      }
      await stub.startPoeJob(jobId, { model, prompt, imageId, parameters: parameters ?? {} });
      return Response.json({ queued: true, jobId });
    }

    // Poe 編集ジョブの状態取得（クライアントはこれをポーリングして結果を受け取る）
    const poeJobMatch = url.pathname.match(/^\/api\/poe\/job\/([0-9a-f]{32})$/);
    if (poeJobMatch) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const job = await stub.getPoeJob(poeJobMatch[1]);
      if (!job) return new Response('Job not found', { status: 404 });
      return Response.json(job);
    }

    // Modal 上の Krea 2 Turbo API（modal_comfy）への生成ジョブ投入。
    // Proxy Auth Token をブラウザに置かないよう Worker 経由で呼ぶ（INTEGRATION.md 参照）。
    // ジョブを登録してすぐ応答し、実際の Modal 呼び出しは Durable Object の alarm で行う。
    // 長い HTTP 接続を保持しないため、生成中にクライアントとの接続が切れても
    //（モバイルのタブ休止など）結果を取りこぼさない
    if (url.pathname === '/api/krea2/generate') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!isJson) return new Response('Content-Type must be application/json', { status: 415 });
      if (!env.MODAL_PROXY_KEY || !env.MODAL_PROXY_SECRET) {
        return new Response('MODAL_PROXY_KEY / MODAL_PROXY_SECRET is not configured', { status: 500 });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      if (typeof payload?.prompt !== 'string' || payload.prompt.trim() === '') {
        return new Response('prompt is required', { status: 422 });
      }
      const jobId = payload.jobId;
      if (typeof jobId !== 'string' || !/^[0-9a-f]{32}$/.test(jobId)) {
        return new Response('jobId is required', { status: 422 });
      }
      delete payload.jobId;

      // エンドポイントはクライアントの endpoint フィールド
      // （"exp" / "gpusnap" / "prod" / "ckpt" / "wan"）で切り替える。
      // URL 自体はクライアントから受け取らず、ここの許可リストでのみ解決する。既定は実験版
      const endpoints = {
        exp: env.KREA2_ENDPOINT_EXP
          || 'https://rabitteru--krea2-comfy-api-exp-comfyapi-generate.modal.run',
        gpusnap: env.KREA2_ENDPOINT_GPUSNAP
          || 'https://rabitteru--krea2-comfy-api-gpusnap-comfyapi-generate.modal.run',
        prod: env.KREA2_ENDPOINT
          || 'https://rabitteru--krea2-comfy-api-comfyapi-generate.modal.run',
        ckpt: env.KREA2_ENDPOINT_CKPT
          || 'https://rabitteru--krea2-comfy-api-ckpt-comfyapi-generate.modal.run',
        // 統合版（wan_vace_app）。編集エンドポイントとコンテナを共有するので、
        // どちらかが動いていればもう一方もウォームになる
        wan: env.WAN_ENDPOINT_GENERATE
          || 'https://rabitteru--wan-vace-api-comfyapi-generate.modal.run',
        // LanPaint 版（lanpaint_app）。画像編集の LanPaint インペイントと
        // コンテナを共有するので、生成もこちらに寄せれば 1 コンテナで済む
        lanpaint: env.LANPAINT_ENDPOINT_GENERATE
          || 'https://rabitteru--lanpaint-api-comfyapi-generate.modal.run',
      };
      // Object.hasOwn で見る（'constructor' のような継承プロパティを
      // 許可リストの当たりと取り違えないため）
      const endpointKey = Object.hasOwn(endpoints, payload.endpoint) ? payload.endpoint : 'exp';
      delete payload.endpoint; // Modal API には存在しないフィールドなので転送しない

      await stub.startKrea2Job(jobId, payload, endpoints[endpointKey], 'generate', endpointKey);
      return Response.json({ queued: true, jobId });
    }

    // マスク編集（modal_comfy の /edit・/inpaint）。生成と同じくジョブにして
    // すぐ応答する。編集は 900 秒級で 150 秒を超えると 303 が返るため、長い HTTP
    // 接続を保持する作りにはできない（INTEGRATION.md 参照）。
    // 送るものは prompt / image / mask で共通なので、endpoint フィールドで
    // Wan2.2 + VACE（/edit）と LanPaint（/inpaint）を切り替える
    if (url.pathname === '/api/modal/edit') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!isJson) return new Response('Content-Type must be application/json', { status: 415 });
      if (!env.MODAL_PROXY_KEY || !env.MODAL_PROXY_SECRET) {
        return new Response('MODAL_PROXY_KEY / MODAL_PROXY_SECRET is not configured', { status: 500 });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      if (typeof payload?.prompt !== 'string' || payload.prompt.trim() === '') {
        return new Response('prompt is required', { status: 422 });
      }
      // 画像とマスクは必須。base64（data URL 接頭辞付きも可）で受ける
      for (const field of ['image', 'mask']) {
        if (typeof payload?.[field] !== 'string' || payload[field] === '') {
          return new Response(`${field} is required`, { status: 422 });
        }
      }
      const jobId = payload.jobId;
      if (typeof jobId !== 'string' || !/^[0-9a-f]{32}$/.test(jobId)) {
        return new Response('jobId is required', { status: 422 });
      }
      delete payload.jobId;

      // 生成と同じく、URL はクライアントから受け取らずここの許可リストで解決する
      const endpoints = {
        wan: {
          url: env.WAN_ENDPOINT_EDIT
            || 'https://rabitteru--wan-vace-api-comfyapi-edit.modal.run',
          kind: 'edit',
          key: 'wan-edit',
        },
        // LanPaint 版（lanpaint_app の /inpaint）。マスクの外は元画像とピクセル
        // 一致で返り、Krea 2 の LoRA がそのまま効く。別コンテナなので、生成も
        // 揃えたいときは生成側の endpoint に 'lanpaint' を選ぶ
        lanpaint: {
          url: env.LANPAINT_ENDPOINT_INPAINT
            || 'https://rabitteru--lanpaint-api-comfyapi-inpaint.modal.run',
          kind: 'inpaint',
          key: 'lanpaint',
        },
      };
      const target = Object.hasOwn(endpoints, payload.endpoint)
        ? endpoints[payload.endpoint] : endpoints.wan;
      delete payload.endpoint; // Modal API には存在しないフィールドなので転送しない

      await stub.startKrea2Job(jobId, payload, target.url, target.kind, target.key);
      return Response.json({ queued: true, jobId });
    }

    // 生成ジョブの状態取得（クライアントはこれをポーリングして結果を受け取る）
    const jobMatch = url.pathname.match(/^\/api\/krea2\/job\/([0-9a-f]{32})$/);
    if (jobMatch) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const job = await stub.getKrea2Job(jobMatch[1]);
      if (!job) return new Response('Job not found', { status: 404 });
      return Response.json(job);
    }

    // 保存済み画像に焼き込まれている設定を、正規化した形（v:1）で返す。
    // ComfyUI や A1111 で作った画像を取り込んだときも、同じ形で読める
    const imageMetaMatch = url.pathname.match(/^\/api\/image\/([0-9a-f]{64}|[0-9a-f]{32})\/meta$/);
    if (imageMetaMatch) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const obj = await env.IMAGES.get(`${imageMetaMatch[1]}.png`);
      if (!obj) return new Response('Not found', { status: 404 });
      const meta = readImageMeta(await obj.arrayBuffer());
      if (!meta) return new Response('No metadata', { status: 404 });
      return Response.json(meta);
    }

    // 保存済み生成画像の配信（/api/krea2/image/ は旧 URL 互換）。
    // R2 を正とし、見つからなければ旧 DO ストレージ（R2 移行前の画像）を辿る。
    const imageMatch = url.pathname.match(/^\/api(?:\/krea2)?\/image\/([0-9a-f]{64}|[0-9a-f]{32})$/);
    if (imageMatch) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const obj = await env.IMAGES.get(`${imageMatch[1]}.png`);
      // /api/upload は PNG 以外（JPEG の元画像など）も置くので、保存時の
      // Content-Type を優先する（旧画像はメタデータなし = PNG）
      const headers = {
        'Content-Type': obj?.httpMetadata?.contentType || 'image/png',
        'Cache-Control': 'private, max-age=31536000, immutable',
      };
      if (obj) return new Response(obj.body, { headers });
      // 後方互換: R2 に無い画像は旧 DO ストレージから配信する
      const buf = await stub.loadImage(imageMatch[1]);
      if (!buf) return new Response('Not found', { status: 404 });
      return new Response(buf, { headers });
    }

    if (url.pathname !== '/api/state') return new Response('Not found', { status: 404 });

    // 端末間同期（LoRA ライブラリなど）。Access で保護されている前提で認証なし
    if (request.method === 'GET') {
      return Response.json(await stub.load());
    }

    if (request.method === 'PUT') {
      if (!isJson) return new Response('Content-Type must be application/json', { status: 415 });
      const body = await request.text();
      if (body.length > 512 * 1024) return new Response('Payload too large', { status: 413 });
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      await stub.save(parsed);
      return Response.json({ ok: true });
    }

    return new Response('Method not allowed', { status: 405 });
  },
};
