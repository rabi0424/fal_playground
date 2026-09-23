// 端末間同期の保存先（worker.js の /api/state と SyncState）のテスト:  node test/state.test.mjs
//
// 以前は PUT の内容で丸ごと置き換えていたので、古い一覧を持った端末が送ると
// ほかの端末の変更が消えた。いまは保存済みのものとマージして、結果を返す。
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeStorage, makeBucket, makeD1 } from './harness.mjs';

const WORKER = new URL('../worker.js', import.meta.url);
const OUT = new URL('./.state.test.mjs', import.meta.url);

let src = readFileSync(WORKER, 'utf8');
src = src.replace("import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
writeFileSync(OUT, src);
const mod = await import(`${OUT.href}?v=${Date.now()}`);
rmSync(OUT);

const storage = makeStorage();
const bucket = makeBucket({ sub: 0 });
const stub = new mod.SyncState({ storage }, { IMAGES: bucket });
const env = { STATE: { idFromName: () => 'singleton', get: () => stub }, IMAGES: bucket, DB: makeD1() };

const put = (doc) => mod.default.fetch(new Request('https://x/api/state', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(doc),
}), env, { waitUntil() {} });
const get = async () => (await mod.default.fetch(new Request('https://x/api/state'), env, { waitUntil() {} })).json();
const items = (doc, s = 'loras') => JSON.parse(doc[s].value);
const section = (list, extra = {}) => ({ value: JSON.stringify(list), ts: 1, ...extra });

// 墓標は 180 日で捨てるので、時刻は今の近くにしておく
const T = Date.now();

let passed = 0;

// 1. 別々の端末が別々の LoRA を変えても、両方残る。PUT はマージ結果を返す
{
  let res = await put({ loras: section([{ path: 'x', updatedAt: T + 10 }, { path: 'y', updatedAt: T + 10 }]) });
  assert.equal(res.status, 200);
  res = await put({ loras: section([{ path: 'x', updatedAt: T + 20, triggerAuto: true }, { path: 'y', updatedAt: T + 10 }]) });
  res = await put({ loras: section([{ path: 'x', updatedAt: T + 10 }, { path: 'y', updatedAt: T + 30, fav: true }]) });
  const merged = await res.json();
  const byPath = Object.fromEntries(items(merged).map((i) => [i.path, i]));
  assert.equal(byPath.x.triggerAuto, true, '古い x で上書きされない');
  assert.equal(byPath.y.fav, true);
  assert.deepEqual(items(await get()), items(merged), 'GET も同じ内容');
  passed++;
}

// 2. 墓標があれば、古い版が届いても生き返らない
{
  await put({ loras: section([{ path: 'y', updatedAt: T + 30, fav: true }], { deleted: { x: T + 40 } }) });
  await put({ loras: section([{ path: 'x', updatedAt: T + 20, triggerAuto: true }, { path: 'y', updatedAt: T + 30 }]) });
  const doc = await get();
  assert.equal(items(doc).find((i) => i.path === 'x'), undefined);
  assert.equal(doc.loras.deleted.x, T + 40);
  passed++;
}

// 3. アリーナはセクション単位で ts の新しい方。LoRA だけ送る端末の巻き添えにならない
{
  await put({ arena: { value: '{"sessions":[1]}', ts: 50 } });
  await put({ arena: { value: '{"sessions":[]}', ts: 5 }, loras: section([]) });
  assert.equal((await get()).arena.value, '{"sessions":[1]}');
  passed++;
}

// 4. 壊れた本文は 400
{
  const res = await mod.default.fetch(new Request('https://x/api/state', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '[1,2]',
  }), env, { waitUntil() {} });
  assert.equal(res.status, 400);
  passed++;
}

console.log(`state: ${passed} checks passed`);
