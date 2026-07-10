// 端末間同期用の最小 API（/api/state）。静的アセット（index.html など）は
// このコードより先に配信されるため、ここに来るのはアセットに一致しないパスのみ。
// 認証: Authorization: Bearer <SYNC_TOKEN>（Worker の Secret に設定した値）
import { DurableObject } from 'cloudflare:workers';

// Modal 生成画像の保存設定。SQLite バックエンドの値上限（2MiB）より小さく分割し、
// 古いものから一定件数を超えた分を自動削除する
const IMAGE_CHUNK_BYTES = 1024 * 1024;
const IMAGE_KEEP = 60;

// Modal 生成ジョブの設定。ジョブは Durable Object の alarm でサーバー側完結で
// 処理する（クライアントとの接続が切れても結果を取りこぼさないため）
const JOB_TTL_MS = 60 * 60 * 1000; // 完了・失敗ジョブの保持期間
const JOB_POLL_DELAY_MS = 2000;
const JOB_MAX_SUBMIT_ATTEMPTS = 2; // 送信自体の再試行上限（多重生成・多重課金の防止）

export class SyncState extends DurableObject {
  async load() {
    return (await this.ctx.storage.get('state')) ?? null;
  }

  async save(value) {
    await this.ctx.storage.put('state', value);
  }

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

      const png = await res.arrayBuffer();
      const imageId = crypto.randomUUID().replaceAll('-', '');
      await this.saveImage(imageId, png);
      const seed = Number(res.headers.get('X-Seed'));
      job.status = 'done';
      job.url = `/api/krea2/image/${imageId}`;
      job.seed = Number.isFinite(seed) ? seed : null;
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

    // Hugging Face 公開リポジトリのファイル一覧の中継。
    // ブラウザから huggingface.co を直接叩くと CORS 等で失敗するため、
    // 同一オリジンの API として提供する（公開データのみ・repo 形式を厳密に検証）
    if (url.pathname === '/api/hf/tree') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const repo = url.searchParams.get('repo') || '';
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return new Response('Invalid repo', { status: 400 });
      const res = await fetch(
        `https://huggingface.co/api/models/${repo}/tree/main?recursive=true`,
        { headers: { 'User-Agent': 'fal-playground' } },
      );
      return new Response(res.body, {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Modal 上の Krea 2 Turbo API（modal_comfy）への生成ジョブ投入。
    // Proxy Auth Token をブラウザに置かないよう Worker 経由で呼ぶ（INTEGRATION.md 参照）。
    // 呼び出しの認証には端末間同期と同じ SYNC_TOKEN を使う。
    // ここではジョブを登録してすぐ応答し、実際の Modal 呼び出しは Durable Object の
    // alarm で行う。長い HTTP 接続を保持しないため、生成中にクライアントとの接続が
    // 切れても（モバイルのタブ休止など）結果を取りこぼさない
    if (url.pathname === '/api/krea2/generate') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!env.SYNC_TOKEN) return new Response('SYNC_TOKEN is not configured', { status: 401 });
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${env.SYNC_TOKEN}`) return new Response('Unauthorized', { status: 401 });
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

      const stub = env.STATE.get(env.STATE.idFromName('singleton'));
      await stub.startKrea2Job(jobId, payload, endpoint);
      return Response.json({ queued: true, jobId });
    }

    // 生成ジョブの状態取得（クライアントはこれをポーリングして結果を受け取る）
    const jobMatch = url.pathname.match(/^\/api\/krea2\/job\/([0-9a-f]{32})$/);
    if (jobMatch) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      if (!env.SYNC_TOKEN) return new Response('SYNC_TOKEN is not configured', { status: 401 });
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${env.SYNC_TOKEN}`) return new Response('Unauthorized', { status: 401 });
      const stub = env.STATE.get(env.STATE.idFromName('singleton'));
      const job = await stub.getKrea2Job(jobMatch[1]);
      if (!job) return new Response('Job not found', { status: 404 });
      return Response.json(job);
    }

    // 保存済み生成画像の配信（id は推測困難な乱数。古いものはサーバー側で自動削除）
    const imageMatch = url.pathname.match(/^\/api\/krea2\/image\/([0-9a-f]{32})$/);
    if (imageMatch) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const stub = env.STATE.get(env.STATE.idFromName('singleton'));
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

    // Secret 未設定時も 401 にして、クライアント側で設定不備として案内する
    if (!env.SYNC_TOKEN) return new Response('SYNC_TOKEN is not configured', { status: 401 });
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${env.SYNC_TOKEN}`) return new Response('Unauthorized', { status: 401 });

    const stub = env.STATE.get(env.STATE.idFromName('singleton'));

    if (request.method === 'GET') {
      return Response.json(await stub.load());
    }

    if (request.method === 'PUT') {
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
