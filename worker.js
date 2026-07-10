// 端末間同期用の最小 API（/api/state）。静的アセット（index.html など）は
// このコードより先に配信されるため、ここに来るのはアセットに一致しないパスのみ。
// 認証: Authorization: Bearer <SYNC_TOKEN>（Worker の Secret に設定した値）
import { DurableObject } from 'cloudflare:workers';

// Modal 生成画像の保存設定。SQLite バックエンドの値上限（2MiB）より小さく分割し、
// 古いものから一定件数を超えた分を自動削除する
const IMAGE_CHUNK_BYTES = 1024 * 1024;
const IMAGE_KEEP = 60;

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

    // Modal 上の Krea 2 Turbo API（modal_comfy）への生成プロキシ。
    // Proxy Auth Token をブラウザに置かないよう Worker 経由で呼ぶ（INTEGRATION.md 参照）。
    // 呼び出しの認証には端末間同期と同じ SYNC_TOKEN を使う
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

      const endpoint = env.KREA2_ENDPOINT
        || 'https://rabitteru--krea2-comfy-api-comfyapi-generate.modal.run';
      // 処理が約 150 秒を超えると 303 で結果ポーリング URL が返るが、fetch が自動追跡する
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Modal-Key': env.MODAL_PROXY_KEY,
          'Modal-Secret': env.MODAL_PROXY_SECRET,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!upstream.ok) {
        const text = await upstream.text();
        // 認証エラー（401）をこの API 自体の認証失敗と区別できるよう 502 に包む
        return new Response(`Krea2 API error ${upstream.status}: ${text.slice(0, 500)}`, { status: 502 });
      }

      const png = await upstream.arrayBuffer();
      const id = crypto.randomUUID().replaceAll('-', '');
      const stub = env.STATE.get(env.STATE.idFromName('singleton'));
      await stub.saveImage(id, png);
      const seed = Number(upstream.headers.get('X-Seed'));
      return Response.json({
        url: `/api/krea2/image/${id}`,
        seed: Number.isFinite(seed) ? seed : null,
      });
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
