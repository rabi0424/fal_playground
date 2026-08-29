// worker.js を Node のテストから動かすためのモック一式。
// Durable Object のストレージ、R2 バケット（multipart 対応）、Civitai / Hugging Face の
// エンドポイントを最低限だけ再現する。
import { createHash } from 'node:crypto';

/* ---- Durable Object storage のモック ---- */
export function makeStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    // 一括版（配列 / オブジェクト）も本物と同じく受ける。1 回 128 件の上限も再現して、
    // 分割し忘れをテストで捕まえられるようにしておく
    async get(k) {
      if (!Array.isArray(k)) return map.has(k) ? structuredClone(map.get(k)) : undefined;
      if (k.length > 128) throw new Error(`storage.get は 1 回 128 件まで（${k.length} 件）`);
      const out = new Map();
      for (const key of k) if (map.has(key)) out.set(key, structuredClone(map.get(key)));
      return out;
    },
    async put(k, v) {
      if (v === undefined && k && typeof k === 'object') {
        const entries = Object.entries(k);
        if (entries.length > 128) throw new Error(`storage.put は 1 回 128 件まで（${entries.length} 件）`);
        for (const [key, val] of entries) map.set(key, structuredClone(val));
        return;
      }
      map.set(k, structuredClone(v));
    },
    async delete(k) {
      if (!Array.isArray(k)) return map.delete(k);
      if (k.length > 128) throw new Error(`storage.delete は 1 回 128 件まで（${k.length} 件）`);
      let n = 0;
      for (const key of k) if (map.delete(key)) n += 1;
      return n;
    },
    // 本物はキーの辞書順に返す。startAfter / limit も同じく再現しておく
    //（履歴のページ送りはこの並びと打ち切りに乗っているため）
    async list({ prefix, startAfter, limit } = {}) {
      const out = new Map();
      for (const k of [...map.keys()].sort()) {
        if (prefix && !k.startsWith(prefix)) continue;
        if (startAfter !== undefined && k <= startAfter) continue;
        if (limit !== undefined && out.size >= limit) break;
        out.set(k, structuredClone(map.get(k)));
      }
      return out;
    },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
    async deleteAlarm() { alarm = null; },
  };
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/* ---- R2 バケットのモック（multipart 対応） ---- */
export function makeBucket(counters) {
  const objects = new Map(); // key -> { body: Buffer, uploaded: Date }
  const uploads = new Map(); // uploadId -> { key, parts: Map<n, Buffer> }
  let uploadSeq = 0;

  const handle = (key, uploadId) => ({
    uploadId,
    async uploadPart(n, body) {
      counters.sub++;
      const up = uploads.get(uploadId);
      if (!up) throw new Error('no such multipart upload');
      const buf = body instanceof Uint8Array ? Buffer.from(body) : await drain(body);
      up.parts.set(Number(n), buf);
      return { partNumber: Number(n), etag: `etag-${n}-${buf.length}` };
    },
    async complete(parts) {
      counters.sub++;
      const up = uploads.get(uploadId);
      if (!up) throw new Error('no such multipart upload');
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const body = Buffer.concat(ordered.map((p) => {
        const buf = up.parts.get(p.partNumber);
        if (!buf) throw new Error(`missing part ${p.partNumber}`);
        return buf;
      }));
      objects.set(up.key, { body, uploaded: new Date() });
      uploads.delete(uploadId);
      return { key: up.key, size: body.length };
    },
    async abort() {
      counters.sub++;
      uploads.delete(uploadId);
    },
  });

  return {
    objects,
    uploads,
    async put(key, value) {
      counters.sub++;
      const body = typeof value === 'string' ? Buffer.from(value)
        : value instanceof Uint8Array ? Buffer.from(value)
          : value instanceof ArrayBuffer ? Buffer.from(new Uint8Array(value))
            : await drain(value);
      objects.set(key, { body, uploaded: new Date() });
    },
    async get(key, opts) {
      counters.sub++;
      const obj = objects.get(key);
      if (!obj) return null;
      let body = obj.body;
      if (opts?.range) body = body.subarray(opts.range.offset, opts.range.offset + opts.range.length);
      return {
        size: obj.body.length,
        get body() {
          return new ReadableStream({
            start(c) { c.enqueue(new Uint8Array(body)); c.close(); },
          });
        },
        async json() { return JSON.parse(body.toString()); },
        async text() { return body.toString(); },
      };
    },
    async delete(keys) {
      counters.sub++;
      for (const k of [].concat(keys)) objects.delete(k);
    },
    async list({ prefix } = {}) {
      counters.sub++;
      return {
        objects: [...objects.entries()]
          .filter(([k]) => !prefix || k.startsWith(prefix))
          .map(([key, o]) => ({ key, uploaded: o.uploaded, size: o.body.length })),
      };
    },
    async createMultipartUpload(key) {
      counters.sub++;
      const uploadId = `up-${++uploadSeq}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return handle(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      return handle(key, uploadId);
    },
  };
}

/* ---- Civitai / Hugging Face のモック ---- */
export function makeFetch(opts) {
  const {
    counters,
    fileBytes,
    chunkSize,          // HF LFS multipart の chunk_size（0 なら basic）
    failPartOnce = null, // このパート番号だけ 1 回失敗させる
    hangOn = null,       // このパスを含むリクエストには永久に応答しない
  } = opts;
  const sha256 = createHash('sha256').update(fileBytes).digest('hex');
  // HF 側の状態はリポジトリごとに持つ（取り込みを同時に 2 本走らせるテストのため）
  const repos = new Map();
  const hf = (repo) => {
    if (!repos.has(repo)) {
      repos.set(repo, { sessions: 0, parts: new Map(), completed: null, verified: false });
    }
    return repos.get(repo);
  };
  const first = () => repos.values().next().value ?? { sessions: 0, parts: new Map() };
  const state = {
    sha256,
    repos,
    batchCalls: 0,
    committed: null,
    failedOnce: new Set(),
    // 単一リポジトリのテスト向けの近道
    get hfParts() { return first().parts; },
    get completed() { return first().completed; },
    get verified() { return first().verified; },
    get uploadSessions() { return first().sessions; },
  };

  const json = (obj, init = {}) => new Response(JSON.stringify(obj), {
    status: 200, headers: { 'Content-Type': 'application/json' }, ...init,
  });

  state.fetch = async (url, init = {}) => {
    counters.sub++;
    const u = new URL(typeof url === 'string' ? url : url.url);
    const path = u.pathname;

    // 応答が返らない相手のシミュレーション。AbortSignal が発火するまで待たされる
    if (hangOn && u.toString().includes(hangOn)) {
      state.hangs = (state.hangs ?? 0) + 1;
      return await new Promise((_, reject) => {
        const signal = init.signal;
        if (!signal) return; // シグナルが無ければ本当に永久に返らない
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }

    // --- Civitai API ---
    if (path.startsWith('/api/v1/model-versions/')) {
      return json({
        id: 123, modelId: 45, name: 'v1', baseModel: 'SDXL',
        model: { name: 'Test CKPT', type: 'Checkpoint' },
        files: [{
          primary: true, name: 'test-ckpt.safetensors',
          sizeKB: fileBytes.length / 1024,
          hashes: { SHA256: sha256.toUpperCase() },
          downloadUrl: 'https://civitai.com/api/download/models/123',
        }],
        images: [],
      });
    }
    if (path.startsWith('/api/v1/models/')) {
      return json({ id: 45, name: 'Test CKPT', type: 'Checkpoint', tags: [], creator: { username: 'x' } });
    }

    // --- Civitai ダウンロード（Range 対応） ---
    if (path.startsWith('/api/download/models/')) {
      const range = init.headers?.Range;
      if (range) {
        const [, a, b] = range.match(/bytes=(\d+)-(\d+)/);
        const slice = fileBytes.subarray(Number(a), Number(b) + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${a}-${b}/${fileBytes.length}`,
            'Content-Length': String(slice.length),
          },
        });
      }
      return new Response(fileBytes, {
        status: 200, headers: { 'Content-Length': String(fileBytes.length) },
      });
    }

    // --- HF: ツリー一覧（アップロード済み判定） ---
    if (/\/api\/models\/.+\/tree\/main/.test(path)) return json([]);

    // --- HF: LFS batch ---
    if (path.endsWith('/info/lfs/objects/batch')) {
      state.batchCalls++;
      const repo = path.slice(1).replace(/\.git\/info\/lfs\/objects\/batch$/, '');
      const q = `repo=${encodeURIComponent(repo)}`;
      if (!chunkSize) {
        return json({
          objects: [{
            oid: sha256, size: fileBytes.length,
            actions: {
              upload: { href: `https://s3.example/basic-put?${q}`, header: {} },
              verify: { href: `https://huggingface.co/lfs/verify?${q}`, header: {} },
            },
          }],
        });
      }
      // batch を叩き直すと multipart セッションが変わる（実サービスと同じ想定）
      const entry = hf(repo);
      entry.sessions++;
      const session = entry.sessions;
      const header = { chunk_size: chunkSize };
      const count = Math.ceil(fileBytes.length / chunkSize);
      for (let n = 1; n <= count; n++) header[String(n)] = `https://s3.example/part?n=${n}&session=${session}&${q}`;
      return json({
        objects: [{
          oid: sha256, size: fileBytes.length,
          actions: {
            upload: { href: `https://huggingface.co/lfs/complete?session=${session}&${q}`, header },
            verify: { href: `https://huggingface.co/lfs/verify?${q}`, header: {} },
          },
        }],
      });
    }

    // --- HF: パート PUT（S3 相当） ---
    if (u.host === 's3.example' && path === '/part') {
      const entry = hf(u.searchParams.get('repo'));
      const n = Number(u.searchParams.get('n'));
      const session = Number(u.searchParams.get('session'));
      if (session !== entry.sessions) {
        return new Response('stale upload session', { status: 400 });
      }
      if (failPartOnce === n && !state.failedOnce.has(n)) {
        state.failedOnce.add(n);
        return new Response('flaky', { status: 500 });
      }
      const body = Buffer.from(await new Response(init.body).arrayBuffer());
      entry.parts.set(n, { body, session });
      return new Response(null, { status: 200, headers: { ETag: `hf-etag-${n}` } });
    }
    if (u.host === 's3.example' && path === '/basic-put') {
      const entry = hf(u.searchParams.get('repo'));
      entry.parts.set(1, { body: Buffer.from(await new Response(init.body).arrayBuffer()), session: 1 });
      return new Response(null, { status: 200, headers: { ETag: 'hf-etag-1' } });
    }

    // --- HF: multipart complete / verify / commit ---
    if (path === '/lfs/complete') {
      const entry = hf(u.searchParams.get('repo'));
      const session = Number(u.searchParams.get('session'));
      const body = JSON.parse(init.body);
      for (const p of body.parts) {
        const got = entry.parts.get(p.partNumber);
        if (!got) return new Response(`missing part ${p.partNumber}`, { status: 400 });
        if (got.session !== session) return new Response(`part ${p.partNumber} from another session`, { status: 400 });
        if (p.etag !== `hf-etag-${p.partNumber}`) return new Response('etag mismatch', { status: 400 });
      }
      const ordered = [...entry.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.body);
      entry.completed = Buffer.concat(ordered);
      return json({ ok: true });
    }
    if (path === '/lfs/verify') {
      hf(u.searchParams.get('repo')).verified = true;
      return json({ ok: true });
    }
    if (/\/api\/models\/.+\/commit\/main/.test(path)) {
      state.committed = init.body;
      return json({ commitUrl: 'https://huggingface.co/commit/abc' });
    }

    return new Response(`unexpected fetch: ${u}`, { status: 599 });
  };
  return state;
}
