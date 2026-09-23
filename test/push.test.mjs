// 生成完了のプッシュ通知（worker.js の Web Push と SyncState の通知まわり）のテスト:
//   node test/push.test.mjs
//
// 送った通知を、ブラウザと同じ手順（RFC 8291）で復号して中身を確かめ、VAPID の
// 署名（RFC 8292）も公開鍵で検証する。暗号化を自前で書いているので、
// 「送れた」だけでなく「受け手が読める」ことまで見る。
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeStorage, makeBucket, makeD1 } from './harness.mjs';

const { subtle } = globalThis.crypto;
const WORKER = new URL('../worker.js', import.meta.url);
const OUT = new URL('./.push.test.mjs', import.meta.url);

let src = readFileSync(WORKER, 'utf8');
src = src.replace("import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
writeFileSync(OUT, src);
const mod = await import(`${OUT.href}?v=${Date.now()}`);
rmSync(OUT);

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const fromB64url = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

// サーバーの VAPID 鍵（scripts/generate-vapid-keys.mjs と同じ形式）
const vapid = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const VAPID_PUBLIC_KEY = b64url(new Uint8Array(await subtle.exportKey('raw', vapid.publicKey)));
const VAPID_PRIVATE_KEY = (await subtle.exportKey('jwk', vapid.privateKey)).d;

// 端末側（ブラウザが作る購読の鍵）
async function makeDevice(name) {
  const keys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys,
    pub,
    auth,
    subscription: {
      endpoint: `https://push.example.com/${name}`,
      keys: { p256dh: b64url(pub), auth: b64url(auth) },
    },
  };
}

async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// RFC 8291 の受け手側の手順で復号する
async function decrypt(device, body) {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const cipher = body.subarray(21 + idLen);
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, device.keys.privateKey, 256));
  const enc = new TextEncoder();
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...device.pub, ...asPublic]);
  const ikm = await hkdf(device.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  assert.equal(plain[plain.length - 1], 2, 'パディングの区切り（0x02）');
  return JSON.parse(new TextDecoder().decode(plain.subarray(0, -1)));
}

// VAPID の JWT を公開鍵で検証する
async function verifyVapid(header, audience) {
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, `Authorization の形: ${header}`);
  assert.equal(m[2], VAPID_PUBLIC_KEY);
  const [h, p, sig] = m[1].split('.');
  const ok = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    vapid.publicKey,
    fromB64url(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  assert.ok(ok, 'VAPID の署名が検証できる');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.aud, audience);
  assert.ok(claims.exp > Date.now() / 1000);
  assert.ok(/^(https:|mailto:)/.test(claims.sub));
}

function makeEnv() {
  const storage = makeStorage();
  const bucket = makeBucket({ sub: 0 });
  const stub = new mod.SyncState({ storage }, {
    IMAGES: bucket, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, FAL_KEY: 'k',
  });
  const env = {
    STATE: { idFromName: () => 'singleton', get: () => stub },
    IMAGES: bucket, DB: makeD1(), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, FAL_KEY: 'k',
  };
  return { env, stub, storage };
}

const call = (env, path, body) => mod.default.fetch(new Request(`https://app.example${path}`, body === undefined
  ? {}
  : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, { waitUntil() {} });

// 外への fetch（プッシュサービスと fal）を差し替える
const realFetch = globalThis.fetch;
let sent = [];
let pushStatus = 201;
let falStatus = 'IN_PROGRESS';
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://push.example.com/')) {
    sent.push({ url, headers: init.headers, body: new Uint8Array(init.body) });
    return new Response(null, { status: pushStatus });
  }
  if (url.startsWith('https://queue.fal.run/')) return Response.json({ status: falStatus });
  return realFetch(input, init);
};

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('鍵を返し、購読を登録して、見ていない端末にだけ暗号化した通知を送る', async () => {
  const { env, stub, storage } = makeEnv();
  assert.deepEqual(await (await call(env, '/api/push/key')).json(), { key: VAPID_PUBLIC_KEY });

  const phone = await makeDevice('phone');
  const pc = await makeDevice('pc');
  const { deviceId: phoneId } = await (await call(env, '/api/push/subscribe', { subscription: phone.subscription })).json();
  await call(env, '/api/push/subscribe', { subscription: pc.subscription });
  await call(env, '/api/push/active', { deviceId: phoneId, active: false }); // iPhone は閉じた

  sent = [];
  await stub.queuePushNotice('gen');
  await stub.queuePushNotice('gen');
  await stub.queuePushNotice('imgeditFail');
  const pending = await storage.get('push:pending');
  pending.dueAt = Date.now() - 1; // 待ち合わせを飛ばす
  await storage.put('push:pending', pending);
  await stub.alarm();

  assert.equal(sent.length, 1, '開いている PC には送らない');
  assert.equal(sent[0].url, phone.subscription.endpoint);
  assert.equal(sent[0].headers['Content-Encoding'], 'aes128gcm');
  await verifyVapid(sent[0].headers.Authorization, 'https://push.example.com');
  const payload = await decrypt(phone, sent[0].body);
  assert.deepEqual(payload, { title: '完了しました', count: 2, body: '1 件は失敗しました', tag: 'fal-done', url: '/' });
});

test('1 つの画面のぶんだけなら、その画面の文面と行き先になる', async () => {
  const { env, stub, storage } = makeEnv();
  const phone = await makeDevice('p2');
  const { deviceId } = await (await call(env, '/api/push/subscribe', { subscription: phone.subscription })).json();
  await call(env, '/api/push/active', { deviceId, active: false });
  sent = [];
  await stub.queuePushNotice('edit');
  const pending = await storage.get('push:pending');
  pending.dueAt = 0;
  await storage.put('push:pending', pending);
  await stub.alarm();
  const payload = await decrypt(phone, sent[0].body);
  assert.equal(payload.title, '部分AI編集が完了しました');
  assert.equal(payload.url, '/edit');
});

test('購読切れ（410）は片付ける。鍵が無ければ何も送らない', async () => {
  const { env, stub, storage } = makeEnv();
  const phone = await makeDevice('gone');
  const { deviceId } = await (await call(env, '/api/push/subscribe', { subscription: phone.subscription })).json();
  await call(env, '/api/push/active', { deviceId, active: false });
  pushStatus = 410;
  await stub.sendPushToDevices({ title: 'x' });
  pushStatus = 201;
  assert.equal(await storage.get(`push:sub:${deviceId}`), undefined);

  const noKey = new mod.SyncState({ storage: makeStorage() }, {});
  sent = [];
  await noKey.sendPushToDevices({ title: 'x' });
  assert.equal(sent.length, 0);
});

test('fal のジョブを見張り、完了したら通知を積む（queue.fal.run 以外は拒む）', async () => {
  const { env, stub, storage } = makeEnv();
  const phone = await makeDevice('w');
  await call(env, '/api/push/subscribe', { subscription: phone.subscription });

  assert.equal((await call(env, '/api/push/watch', { statusUrl: 'https://evil.example/x' })).status, 403);
  const statusUrl = 'https://queue.fal.run/fal-ai/x/requests/1/status';
  assert.equal((await call(env, '/api/push/watch', { statusUrl, kind: 'imgedit' })).status, 200);
  await call(env, '/api/push/watch', { statusUrl, kind: 'imgedit' }); // 二重登録しない
  assert.equal((await storage.list({ prefix: 'push:watch:' })).size, 1);

  const expire = async () => {
    for (const [k, w] of await storage.list({ prefix: 'push:watch:' })) {
      w.nextPollAt = 0;
      await storage.put(k, w);
    }
  };
  falStatus = 'IN_PROGRESS';
  await expire();
  await stub.alarm();
  assert.equal((await storage.list({ prefix: 'push:watch:' })).size, 1, 'まだ見張っている');

  falStatus = 'COMPLETED';
  await expire();
  await stub.alarm();
  assert.equal((await storage.list({ prefix: 'push:watch:' })).size, 0);
  assert.deepEqual((await storage.get('push:pending')).counts, { imgedit: 1 });
});

test('通知先が 1 台も無ければ、見張りも通知も積まない', async () => {
  const { env, stub, storage } = makeEnv();
  await call(env, '/api/push/watch', { statusUrl: 'https://queue.fal.run/a/requests/1/status' });
  await stub.queuePushNotice('gen');
  assert.equal((await storage.list({ prefix: 'push:watch:' })).size, 0);
  assert.equal(await storage.get('push:pending'), undefined);
});

for (const [name, fn] of cases) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.stack}`);
    process.exitCode = 1;
  }
}
globalThis.fetch = realFetch;
console.log(`push: ${passed}/${cases.length} passed`);
