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
const HISTORY_KEEP = 1000; // 履歴レコードの上限。超過分は画像ごと古い順に自動削除

// Modal 生成ジョブの設定。ジョブは Durable Object の alarm でサーバー側完結で
// 処理する（クライアントとの接続が切れても結果を取りこぼさないため）
const JOB_TTL_MS = 60 * 60 * 1000; // 完了・失敗ジョブの保持期間
const JOB_POLL_DELAY_MS = 2000;
const JOB_MAX_SUBMIT_ATTEMPTS = 2; // 送信自体の再試行上限（多重生成・多重課金の防止）

// 履歴追加時に取り込む外部画像のホスト（fal の CDN）。それ以外は取り込まず URL のまま残す
const CAPTURE_HOSTS = /(^|\.)fal\.(media|ai|run)$/;

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
const LORA_IMPORT_MAX_ATTEMPTS = 4; // ジョブ全体の実行回数上限（途中断は続きから再開する）
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
      const res = await fetch(`${o}/api/v1${path}`, { headers });
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
function embedPngMetadata(buf, text) {
  const src = new Uint8Array(buf);
  if (src.length < 33 || !PNG_SIGNATURE.every((b, i) => src[i] === b)) return buf;
  const ihdrLen = new DataView(buf).getUint32(8);
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
  return out.buffer;
}

/* ---------- helpers ---------- */

function randomId() {
  return crypto.randomUUID().replaceAll('-', '');
}

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

// このアプリが配信している画像 URL から id を取り出す（/api/krea2/image/ は旧 URL 互換）
function localImageId(u) {
  const m = typeof u === 'string' ? u.match(/^\/api(?:\/krea2)?\/image\/([0-9a-f]{32})$/) : null;
  return m ? m[1] : null;
}

export class SyncState extends DurableObject {
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

  /* ---- 生成履歴（サーバーが正） ---- */

  async listHistory() {
    return (await this.ctx.storage.get('history:list')) ?? [];
  }

  async addHistory(record) {
    const list = await this.listHistory();
    const next = list.filter((r) => r.id !== record.id); // 同 id は差し替え
    next.unshift(record);
    const removed = next.splice(HISTORY_KEEP);
    await this.deleteRecordImages(removed);
    await this.ctx.storage.put('history:list', next);
  }

  async deleteHistory(id) {
    const list = await this.listHistory();
    await this.deleteRecordImages(list.filter((r) => r.id === id));
    await this.ctx.storage.put('history:list', list.filter((r) => r.id !== id));
  }

  async clearHistory() {
    await this.deleteRecordImages(await this.listHistory());
    await this.ctx.storage.put('history:list', []);
  }

  async deleteRecordImages(records) {
    const ids = [];
    for (const record of records) {
      for (const { images } of recordImageLists(record)) {
        for (const img of images) {
          const id = localImageId(img?.url);
          if (id) ids.push(id);
        }
      }
    }
    if (ids.length === 0) return;
    // 新方式（R2）の画像を削除。存在しないキーの delete は R2 では無害なので
    // 旧 DO 側の画像と一括で消してよい。R2 の delete は 1 回 1000 キーまでなので分割する
    const keys = ids.map((id) => `${id}.png`);
    for (let i = 0; i < keys.length; i += 1000) {
      await this.env.IMAGES.delete(keys.slice(i, i + 1000));
    }
    // 旧 DO ストレージに残る画像（R2 移行前）も掃除する
    await this.deleteImages(ids);
  }

  /* ---- Modal 生成ジョブ ---- */

  // ジョブを登録して alarm を仕込む。同じ id の再送は無視する（多重生成防止）
  async startKrea2Job(id, payload, endpoint) {
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
      pollUrl: null,
      attempts: 0,
      created: Date.now(),
    });
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 50);
    }
  }

  async getKrea2Job(id) {
    const job = await this.ctx.storage.get(`krea2:job:${id}`);
    if (!job) return null;
    return {
      status: job.status,
      url: job.url ?? null,
      seed: job.seed ?? null,
      elapsedMs: job.elapsedMs ?? null, // 実処理時間（DO のキュー待ちを含まない）
      error: job.error ?? null,
    };
  }

  // 未完了ジョブを順に処理する（順次実行なので Modal 側のウォーム状態も保ちやすい）。
  // lora:job: は数分かかりうるため専用の DO インスタンス（'lora-import'）にのみ
  // 登録され、singleton 側の生成ジョブのポーリングを妨げない
  async alarm() {
    let pendingLeft = false;
    for (const prefix of ['krea2:job:', 'poe:job:', 'lora:job:']) {
      const jobs = await this.ctx.storage.list({ prefix });
      for (const [key, job] of jobs) {
        if (job.status !== 'pending') continue;
        if (prefix === 'poe:job:') await this.runPoeJob(key, job);
        else if (prefix === 'lora:job:') await this.runLoraImportJob(key, job);
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
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 50);
    }
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
      const meta = {
        app: 'fal playground',
        source: 'poe-edit',
        model,
        prompt,
        created: new Date(job.created).toISOString(),
      };
      const buf = embedPngMetadata(await imgRes.arrayBuffer(), JSON.stringify(meta));
      const resultId = randomId();
      await this.env.IMAGES.put(`${resultId}.png`, buf, {
        httpMetadata: { contentType: imgRes.headers.get('Content-Type') || 'image/png' },
      });
      job.status = 'done';
      job.url = `/api/image/${resultId}`;
      await this.ctx.storage.put(key, job);
    } catch {
      // ネットワーク断など。pending のまま次の alarm で再試行する（attempts 上限で打ち切り）
    }
  }

  // 1 ジョブを進める。Modal が 303（処理継続中）を返したらポーリング URL を保存して
  // pending のまま戻り、次の alarm で続きを確認する
  async runKrea2Job(key, job) {
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
        job.error = `Krea2 API error ${res.status}: ${(await res.text()).slice(0, 300)}`;
        await this.ctx.storage.put(key, job);
        return;
      }

      const seedHeader = Number(res.headers.get('X-Seed'));
      const seed = Number.isFinite(seedHeader) ? seedHeader : null;
      // 生成設定を画像に焼き込んでから保存する
      const meta = {
        app: 'fal playground',
        source: 'krea2-modal',
        endpoint: job.endpoint.includes('-exp-') ? 'exp'
          : job.endpoint.includes('-gpusnap-') ? 'gpusnap'
            : job.endpoint.includes('-ckpt-') ? 'ckpt' : 'prod',
        ...job.payload,
        seed: seed ?? job.payload.seed ?? null,
        created: new Date(job.created).toISOString(),
      };
      const png = embedPngMetadata(await res.arrayBuffer(), JSON.stringify(meta));
      const imageId = randomId();
      await this.env.IMAGES.put(`${imageId}.png`, png, {
        httpMetadata: { contentType: 'image/png' },
      });
      job.status = 'done';
      job.url = `/api/image/${imageId}`;
      job.seed = seed;
      job.elapsedMs = job.submittedAt ? Date.now() - job.submittedAt : null;
      await this.ctx.storage.put(key, job);
    } catch {
      // ネットワーク断など。pending のまま次の alarm で再試行する
      //（送信済みで pollUrl 未取得の場合は attempts 上限で打ち切られる）
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
      if (Date.now() - j.created > JOB_TTL_MS) {
        await this.abortStagingMultipart(k, j); // やりかけの multipart は破棄してから消す
        await this.ctx.storage.delete(k);
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
      created: Date.now(),
    });
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 50);
    }
  }

  async getLoraImport(id) {
    const job = await this.ctx.storage.get(`lora:job:${id}`);
    if (!job) return null;
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
      await this.ctx.storage.put(key, job);
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
          await this.ctx.storage.put(key, job);
        }
        controller.enqueue(chunk);
      },
    });
  }

  async failLoraImport(key, job, message) {
    job.status = 'error';
    job.error = message;
    await this.abortStagingMultipart(key, job);
    await this.ctx.storage.put(key, job);
    await this.deleteLoraStaging(key);
  }

  loraStagingKey(key) {
    return `${LORA_STAGING_PREFIX}${key.slice('lora:job:'.length)}`;
  }

  async deleteLoraStaging(key) {
    try {
      await this.env.IMAGES.delete(this.loraStagingKey(key));
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
    await this.ctx.storage.put(key, job);

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
    await this.ctx.storage.put(key, job);
  }

  // ステップを進められるだけ進める。ネットワーク断などの例外は pending のまま抜けて
  // 次の alarm で再試行する（attempts 上限で打ち切り）
  async runLoraImportJob(key, job) {
    try {
      if (job.attempts >= LORA_IMPORT_MAX_ATTEMPTS) {
        await this.failLoraImport(key, job, '取り込みを完了できませんでした（エラーが続いています）');
        return;
      }
      job.attempts += 1;
      await this.ctx.storage.put(key, job);

      while (job.status === 'pending') {
        if (job.step === 'resolve') await this.loraStepResolve(key, job);
        else if (job.step === 'download') await this.loraStepDownload(key, job);
        else if (job.step === 'upload') await this.loraStepUpload(key, job);
        else if (job.step === 'commit') await this.loraStepCommit(key, job);
        else {
          await this.failLoraImport(key, job, `不明なステップです: ${job.step}`);
          return;
        }
      }
    } catch {
      // pending のまま次の alarm で再試行
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
        await this.ctx.storage.put(key, job);
        return;
      }
    }
    job.step = 'download';
    await this.ctx.storage.put(key, job);
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
  //（署名付き URL の期限切れ対策として、リトライのたびにここから引き直す）
  async civitaiOpen(sourceUrl, range) {
    let dlUrl = sourceUrl;
    let res = null;
    for (let hop = 0; hop < 5; hop++) {
      const headers = this.civitaiDlHeaders(dlUrl);
      if (range) headers.Range = range;
      res = await fetch(dlUrl, { headers, redirect: 'manual' });
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
  async loraStepDownload(key, job) {
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
    await this.ctx.storage.put(key, job);

    if (ranged && job.meta.sha256 && size > CHUNKED_DL_MIN_BYTES) {
      // 並列分割ダウンロード。逐次の SHA256 計算はできないため oid には公称値を使う
      //（各パートは長さ検証つき。内容が公称値と食い違っていれば HF 側の検証で弾かれる）
      await res.body?.cancel();
      await this.chunkedStagingDownload(key, job, finalUrl, size);
      job.sha256 = job.meta.sha256;
    } else {
      // 逐次ストリーム経路。探りが 200（Range 非対応）ならその応答をそのまま使い、
      // 206 なら全体を取り直す
      let body = res.body;
      if (ranged) {
        await res.body?.cancel();
        const full = await this.civitaiOpen(job.meta.downloadUrl);
        if (!full.res.ok) {
          throw new Error(`download error ${full.res.status}`); // pending のまま次の alarm で再試行
        }
        body = full.res.body;
      }
      // 並列経路のやりかけが残っていれば破棄してから単発ストリームで保存する
      await this.abortStagingMultipart(key, job);
      job.bytesDone = 0;
      await this.ctx.storage.put(key, job);

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
    }
    job.size = size;
    job.step = 'upload';
    await this.ctx.storage.put(key, job);
  }

  // Range 並列ダウンロード + R2 multipart 保存。完了済みパートはジョブ記録に控え、
  // 途中断・リトライ時は残りのパートだけをやり直す（巨大ファイルでも全体の
  // やり直しが発生しない）。パートごとに進捗が出るたび attempts を戻すので、
  // 完全に停滞したときだけ打ち切りになる
  async chunkedStagingDownload(key, job, finalUrl, size) {
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
      await this.ctx.storage.put(key, job);
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
    await this.ctx.storage.put(key, job);

    const tally = this.makeProgressTally(key, job);
    const worker = async () => {
      while (pending.length > 0) {
        const n = pending.shift();
        const offset = (n - 1) * partSize;
        const len = partLen(n);
        let lastErr = null;
        for (let retry = 0; retry < 3; retry++) {
          const counter = { n: 0 };
          try {
            const res = await fetch(finalUrl, {
              headers: { ...this.civitaiDlHeaders(finalUrl), Range: `bytes=${offset}-${offset + len - 1}` },
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
            job.attempts = 0; // 進捗があったら打ち切りカウントを戻す
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

    const parts = Object.values(job.stagingParts).sort((a, b) => a.partNumber - b.partNumber);
    await upload.complete(parts);
    job.stagingUploadId = null;
    job.bytesDone = size;
    await this.ctx.storage.put(key, job);
  }

  // HF の LFS プロトコルでアップロードする: batch API で転送先を取得し、
  // multipart（応答 header の chunk_size + 連番 URL）なら分割 PUT + 完了通知、
  // そうでなければ単発 PUT。verify アクションがあれば最後に呼ぶ
  async loraStepUpload(key, job) {
    const stagingKey = `${LORA_STAGING_PREFIX}${key.slice('lora:job:'.length)}`;
    job.bytesDone = 0;
    job.bytesTotal = job.size;
    await this.ctx.storage.put(key, job);
    const lfsHeaders = {
      Accept: 'application/vnd.git-lfs+json',
      'Content-Type': 'application/vnd.git-lfs+json',
      ...hfAuthHeaders(this.env),
    };
    const batchRes = await fetch(`${HF_BASE}/${job.repo}.git/info/lfs/objects/batch`, {
      method: 'POST',
      headers: lfsHeaders,
      body: JSON.stringify({
        operation: 'upload',
        transfers: ['basic', 'multipart'],
        objects: [{ oid: job.sha256, size: job.size }],
        hash_algo: 'sha256',
      }),
    });
    if (!batchRes.ok) {
      if (batchRes.status >= 400 && batchRes.status < 500) {
        await this.failLoraImport(key, job,
          `Hugging Face LFS API がリクエストを拒否しました（HTTP ${batchRes.status}: ${(await batchRes.text()).slice(0, 200)}）`);
        return;
      }
      throw new Error(`LFS batch error ${batchRes.status}`);
    }
    const object = (await batchRes.json())?.objects?.[0];
    if (object?.error) {
      await this.failLoraImport(key, job, `Hugging Face LFS error: ${object.error.message ?? 'unknown'}`);
      return;
    }

    const upload = object?.actions?.upload;
    if (upload) {
      const header = upload.header ?? {};
      const chunkSize = Number(header.chunk_size);
      if (Number.isFinite(chunkSize) && chunkSize > 0) {
        // multipart: header の連番キーが各パートの PUT 先 URL。パートは並列で送り、
        // 完了ごとに etag を保存して再開できるようにする。進捗が出るたび attempts を
        // 戻すので、完全に停滞したときだけ打ち切りになる
        const parts = Object.keys(header)
          .filter((k) => /^\d+$/.test(k))
          .sort((a, b) => Number(a) - Number(b));
        const uploadPartLen = (p) => Math.min(chunkSize, job.size - (Number(p) - 1) * chunkSize);
        const pending = parts.filter((p) => !job.etags[p]); // 再開時はアップロード済みを飛ばす
        // 再開時はアップロード済みパートのバイト数から数え直す
        job.bytesDone = parts.filter((p) => job.etags[p])
          .reduce((sum, p) => sum + uploadPartLen(p), 0);
        await this.ctx.storage.put(key, job);
        const tally = this.makeProgressTally(key, job);
        let stagingLost = false;
        const uploadWorker = async () => {
          while (pending.length > 0 && !stagingLost) {
            const part = pending.shift();
            const offset = (Number(part) - 1) * chunkSize;
            const length = uploadPartLen(part);
            const counter = { n: 0 };
            try {
              const obj = await this.env.IMAGES.get(stagingKey, { range: { offset, length } });
              if (!obj) {
                stagingLost = true;
                return;
              }
              const putRes = await fetch(header[part], {
                method: 'PUT',
                body: obj.body.pipeThrough(tally.stream(counter)).pipeThrough(new FixedLengthStream(length)),
              });
              if (!putRes.ok) throw new Error(`part ${part} upload error ${putRes.status}`);
              job.etags[part] = putRes.headers.get('ETag') ?? '';
              job.attempts = 0; // 進捗があったら打ち切りカウントを戻す
              await tally.save(true);
            } catch (err) {
              await tally.rollback(counter);
              throw err;
            }
          }
        };
        await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, uploadWorker));
        if (stagingLost) {
          // 一時ファイルが消えている（R2 掃除など）。download からやり直す
          job.step = 'download';
          job.etags = {};
          await this.abortStagingMultipart(key, job);
          await this.ctx.storage.put(key, job);
          return;
        }
        const completeRes = await fetch(upload.href, {
          method: 'POST',
          headers: lfsHeaders,
          body: JSON.stringify({
            oid: job.sha256,
            parts: parts.map((p) => ({ partNumber: Number(p), etag: job.etags[p] })),
          }),
        });
        if (!completeRes.ok) throw new Error(`multipart complete error ${completeRes.status}`);
      } else {
        // basic: 応答の header をそのまま付けて単発 PUT
        const obj = await this.env.IMAGES.get(stagingKey);
        if (!obj) {
          job.step = 'download';
          await this.ctx.storage.put(key, job);
          return;
        }
        const putRes = await fetch(upload.href, {
          method: 'PUT',
          headers: { ...header },
          body: obj.body
            .pipeThrough(this.loraProgressStream(key, job))
            .pipeThrough(new FixedLengthStream(job.size)),
        });
        if (!putRes.ok) throw new Error(`upload error ${putRes.status}`);
      }

      const verify = object.actions?.verify;
      if (verify) {
        const verifyRes = await fetch(verify.href, {
          method: 'POST',
          headers: { ...lfsHeaders, ...(verify.header ?? {}) },
          body: JSON.stringify({ oid: job.sha256, size: job.size }),
        });
        if (!verifyRes.ok) throw new Error(`verify error ${verifyRes.status}`);
      }
    }
    // actions が無い場合は同一オブジェクトがサーバー側に既にある（コミットだけでよい）

    job.step = 'commit';
    await this.ctx.storage.put(key, job);
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
    await this.ctx.storage.put(key, job);
    await this.deleteLoraStaging(key);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.STATE.get(env.STATE.idFromName('singleton'));
    // 変更系 API は JSON の Content-Type を必須にする（クロスサイトの form 送信対策）
    const isJson = (request.headers.get('Content-Type') || '').includes('application/json');

    // Hugging Face 公開リポジトリのファイル一覧の中継。
    // ブラウザから huggingface.co を直接叩くと CORS 等で失敗するため、
    // 同一オリジンの API として提供する（公開データのみ・repo 形式を厳密に検証）
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
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return new Response('Invalid repo', { status: 400 });
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
        repoError = `アップロード先リポジトリ ${repo} にアクセスできません（HTTP ${err.status ?? '?'}）`;
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

    // 取り込みジョブの状態取得（クライアントはこれをポーリングする）
    const loraJobMatch = url.pathname.match(/^\/api\/lora-import\/job\/([0-9a-f]{32})$/);
    if (loraJobMatch) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const importStub = env.STATE.get(env.STATE.idFromName('lora-import'));
      const job = await importStub.getLoraImport(loraJobMatch[1]);
      if (!job) return new Response('Job not found', { status: 404 });
      return Response.json(job);
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
      if (request.method === 'GET') {
        return Response.json(await stub.listHistory());
      }
      if (request.method === 'POST') {
        if (!isJson) return new Response('Content-Type must be application/json', { status: 415 });
        let record;
        try {
          record = await request.json();
        } catch {
          return new Response('Invalid JSON', { status: 400 });
        }
        if (typeof record?.id !== 'string' || record.id === '' || record.id.length > 100) {
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
            if (src.protocol !== 'https:' || !CAPTURE_HOSTS.test(src.hostname)) continue;
            try {
              const res = await fetch(src);
              if (!res.ok) continue;
              const meta = {
                app: 'fal playground',
                source: 'fal',
                model: record.model,
                prompt: record.prompt,
                seed: record.seed ?? null,
                ...(loras?.length ? { loras } : {}),
                ...(record.input ? { input: record.input } : {}),
                created: new Date(record.ts || Date.now()).toISOString(),
              };
              const buf = embedPngMetadata(await res.arrayBuffer(), JSON.stringify(meta));
              const id = randomId();
              await env.IMAGES.put(`${id}.png`, buf, {
                httpMetadata: { contentType: 'image/png' },
              });
              img.url = `/api/image/${id}`;
            } catch {
              // 取得できなければ元の URL のまま残す（表示は CDN の失効まで可能）
            }
          }
        }
        await stub.addHistory(record);
        return Response.json(record);
      }
      if (request.method === 'DELETE') {
        await stub.clearHistory();
        return Response.json({ ok: true });
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // 履歴 1 件の削除（保存済み画像も一緒に消す）
    const historyMatch = url.pathname.match(/^\/api\/history\/([\w.-]{1,100})$/);
    if (historyMatch) {
      if (request.method !== 'DELETE') return new Response('Method not allowed', { status: 405 });
      await stub.deleteHistory(historyMatch[1]);
      return Response.json({ ok: true });
    }

    // クライアント側で生成した画像（部分編集の切り抜き・合成結果など）の保存先。
    // base64 の JSON で受け取り R2 に置いて /api/image/<id> の URL を返す（README の案 A）。
    // meta があれば PNG に生成設定として焼き込む（fal 経由の履歴取り込みと同じ扱い）
    if (url.pathname === '/api/upload') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!isJson) return new Response('Content-Type must be application/json', { status: 415 });
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      const decoded = decodeImageDataUri(body?.image);
      if (!decoded) return new Response('image must be a base64 image data URI', { status: 422 });
      if (decoded.bytes.length > UPLOAD_MAX_BYTES) {
        return new Response('Image too large', { status: 413 });
      }
      let buf = decoded.bytes.buffer;
      if (body.meta && typeof body.meta === 'object') {
        buf = embedPngMetadata(buf, JSON.stringify(body.meta));
      }
      const id = randomId();
      await env.IMAGES.put(`${id}.png`, buf, {
        httpMetadata: { contentType: decoded.mime },
      });
      return Response.json({ url: `/api/image/${id}` });
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
      if (typeof imageId !== 'string' || !/^[0-9a-f]{32}$/.test(imageId)) {
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

      // エンドポイントはクライアントの endpoint フィールド（"exp" / "gpusnap" / "prod" / "ckpt"）で切り替える。
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
      };
      const endpoint = endpoints[payload.endpoint] ?? endpoints.exp;
      delete payload.endpoint; // Modal API には存在しないフィールドなので転送しない

      await stub.startKrea2Job(jobId, payload, endpoint);
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

    // 保存済み生成画像の配信（/api/krea2/image/ は旧 URL 互換）。
    // R2 を正とし、見つからなければ旧 DO ストレージ（R2 移行前の画像）を辿る。
    const imageMatch = url.pathname.match(/^\/api(?:\/krea2)?\/image\/([0-9a-f]{32})$/);
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
