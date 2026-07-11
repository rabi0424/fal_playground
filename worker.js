// 個人用 playground のバックエンド（Cloudflare Workers + Durable Object）。
// 静的アセット（index.html など）はこのコードより先に配信されるため、
// ここに来るのはアセットに一致しないパス（/api/*）のみ。
//
// 認証について: このアプリは Cloudflare Access（メール認証）で保護される前提で、
// アプリ内の認証は持たない。Access を有効にせずデプロイすると fal プロキシ等の
// API が誰でも使える状態になるので注意（README 参照）。
import { DurableObject } from 'cloudflare:workers';

// 生成画像・履歴の保存設定
const IMAGE_CHUNK_BYTES = 1024 * 1024; // SQLite バックエンドの値上限（2MiB）より小さく分割
const HISTORY_KEEP = 150; // 履歴レコードの上限。超過分は画像ごと古い順に削除
const IMAGE_KEEP = 600; // 履歴の削除で消し損ねた画像を拾う保険（古い順に削除）

// Modal 生成ジョブの設定。ジョブは Durable Object の alarm でサーバー側完結で
// 処理する（クライアントとの接続が切れても結果を取りこぼさないため）
const JOB_TTL_MS = 60 * 60 * 1000; // 完了・失敗ジョブの保持期間
const JOB_POLL_DELAY_MS = 2000;
const JOB_MAX_SUBMIT_ATTEMPTS = 2; // 送信自体の再試行上限（多重生成・多重課金の防止）

// 履歴追加時に取り込む外部画像のホスト（fal の CDN）。それ以外は取り込まず URL のまま残す
const CAPTURE_HOSTS = /(^|\.)fal\.(media|ai|run)$/;

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

  /* ---- 生成画像 ---- */

  async saveImage(id, buf) {
    const index = (await this.ctx.storage.get('krea2:index')) ?? [];
    const chunks = Math.max(1, Math.ceil(buf.byteLength / IMAGE_CHUNK_BYTES));
    const entries = {};
    for (let i = 0; i < chunks; i++) {
      entries[`krea2:img:${id}:${i}`] = buf.slice(i * IMAGE_CHUNK_BYTES, (i + 1) * IMAGE_CHUNK_BYTES);
    }
    await this.ctx.storage.put(entries);
    index.push({ id, chunks });
    while (index.length > IMAGE_KEEP) {
      const old = index.shift();
      await this.ctx.storage.delete(
        Array.from({ length: old.chunks }, (_, i) => `krea2:img:${old.id}:${i}`),
      );
    }
    await this.ctx.storage.put('krea2:index', index);
  }

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
      error: job.error ?? null,
    };
  }

  // 未完了ジョブを順に処理する（順次実行なので Modal 側のウォーム状態も保ちやすい）
  async alarm() {
    const jobs = await this.ctx.storage.list({ prefix: 'krea2:job:' });
    let pendingLeft = false;
    for (const [key, job] of jobs) {
      if (job.status !== 'pending') continue;
      await this.runKrea2Job(key, job);
      const after = await this.ctx.storage.get(key);
      if (after?.status === 'pending') pendingLeft = true;
    }
    if (pendingLeft) await this.ctx.storage.setAlarm(Date.now() + JOB_POLL_DELAY_MS);
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
        // 途中で落ちても際限なく再送されないよう、送信前に回数を記録する
        job.attempts += 1;
        await this.ctx.storage.put(key, job);
        res = await fetch(job.endpoint, {
          method: 'POST',
          headers: { ...this.modalHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(job.payload),
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
        endpoint: job.endpoint.includes('-exp-') ? 'exp' : 'prod',
        ...job.payload,
        seed: seed ?? job.payload.seed ?? null,
        created: new Date(job.created).toISOString(),
      };
      const png = embedPngMetadata(await res.arrayBuffer(), JSON.stringify(meta));
      const imageId = randomId();
      await this.saveImage(imageId, png);
      job.status = 'done';
      job.url = `/api/image/${imageId}`;
      job.seed = seed;
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
      //（クライアント側で「追加日の新しい順」に並べるため）。expand 付きの応答は
      // ページングされるので、Link ヘッダの rel="next" を辿って全件集める
      const entries = [];
      let next = `https://huggingface.co/api/models/${repo}/tree/main?recursive=true&expand=true`;
      for (let page = 0; page < 20 && next; page++) {
        const res = await fetch(next, { headers: { 'User-Agent': 'fal-playground' } });
        if (!res.ok) {
          if (entries.length > 0) break; // 途中で失敗したら取れた分だけ返す
          return new Response(res.body, {
            status: res.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const batch = await res.json();
        if (Array.isArray(batch)) entries.push(...batch);
        const link = res.headers.get('Link') || '';
        next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
      }
      return Response.json(entries);
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
              await stub.saveImage(id, buf);
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

      // エンドポイントはクライアントの endpoint フィールド（"exp" / "prod"）で切り替える。
      // URL 自体はクライアントから受け取らず、ここの許可リストでのみ解決する。既定は実験版
      const endpoints = {
        exp: env.KREA2_ENDPOINT_EXP
          || 'https://rabitteru--krea2-comfy-api-exp-comfyapi-generate.modal.run',
        prod: env.KREA2_ENDPOINT
          || 'https://rabitteru--krea2-comfy-api-comfyapi-generate.modal.run',
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

    // 保存済み生成画像の配信（/api/krea2/image/ は旧 URL 互換）
    const imageMatch = url.pathname.match(/^\/api(?:\/krea2)?\/image\/([0-9a-f]{32})$/);
    if (imageMatch) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const buf = await stub.loadImage(imageMatch[1]);
      if (!buf) return new Response('Not found', { status: 404 });
      return new Response(buf, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      });
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
