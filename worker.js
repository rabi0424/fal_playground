// 端末間同期用の最小 API（/api/state）。静的アセット（index.html など）は
// このコードより先に配信されるため、ここに来るのはアセットに一致しないパスのみ。
// 認証: Authorization: Bearer <SYNC_TOKEN>（Worker の Secret に設定した値）
import { DurableObject } from 'cloudflare:workers';

export class SyncState extends DurableObject {
  async load() {
    return (await this.ctx.storage.get('state')) ?? null;
  }

  async save(value) {
    await this.ctx.storage.put('state', value);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
