// 端末間同期（device-sync.js + sync-merge.js）の単体テスト:  node test/device-sync.test.mjs
//
// 複数の端末（それぞれ別の localStorage を持つ）と、Worker と同じマージを行う
// サーバーを模擬して、以前は設定が消えていた状況を再現する。
//
// 見るのは:
//   - LoRA / チェックポイントは項目ごとに新しい方が残る（古い一覧で上書きされない）
//   - 消した項目は、古い一覧を持った端末からの送信で生き返らない
//   - 移行: 時刻を持たない既存の項目は、最初に同期した端末の内容が基準になる
//   - keepalive は離脱前の小さな送信だけ（64KB を超えると送れないため）
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

const SRC_MERGE = readFileSync(new URL('../sync-merge.js', import.meta.url), 'utf8');
const SRC_SYNC = readFileSync(new URL('../device-sync.js', import.meta.url), 'utf8');

// Worker と同じマージを使う模擬サーバー
function makeServer({ doc = null, status = 200 } = {}) {
  const ctx = createContext({});
  runInContext(SRC_MERGE, ctx);
  const merge = ctx.falSyncMerge;
  const server = {
    doc,
    status,
    now: 1_000,
    puts: [],
    handle(init) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body);
        server.puts.push({ keepalive: !!init.keepalive });
        if (server.status !== 200) return new Response('no', { status: server.status });
        server.doc = merge.mergeDocs(server.doc, body, { now: server.now });
        return Response.json(server.doc);
      }
      return Response.json(server.doc);
    },
  };
  return server;
}

function makeDevice(server, { library = null, ckpts = null, arena = null, ts = null } = {}) {
  const store = new Map();
  if (library !== null) store.set('fal_lora_library', JSON.stringify(library));
  if (ckpts !== null) store.set('fal_ckpt_library', JSON.stringify(ckpts));
  if (arena !== null) store.set('fal_arena', JSON.stringify(arena));
  if (ts !== null) store.set('fal_sync_ts', JSON.stringify(ts));
  const warnings = [];
  const listeners = {};
  let applies = 0;
  const device = {
    clock: 1_000,
    canApply: true,
    store,
    warnings,
    get applies() { return applies; },
    listeners,
  };
  const sandbox = {
    console: { ...console, warn: (...a) => warnings.push(a.join(' ')) },
    TextEncoder,
    Response,
    JSON,
    Date: { now: () => device.clock },
    // 送信の遅延はテストから直接 pull / flush を呼ぶので、タイマーは走らせない
    setTimeout: () => 1,
    clearTimeout: () => {},
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    falStore: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => store.set(k, v),
      remove: (k) => store.delete(k),
    },
    loraLib: { migrate() {} },
    fetch: async (url, init = {}) => {
      if (init.method === 'PUT' && init.keepalive
        && new TextEncoder().encode(init.body).length > 64 * 1024) {
        // 本物のブラウザと同じく、64KB を超える keepalive は送らずに失敗させる
        throw new TypeError('Failed to fetch');
      }
      return server.handle(init);
    },
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(SRC_MERGE, sandbox);
  runInContext(SRC_SYNC, sandbox);
  sandbox.deviceSync.init({ onRemote: () => { applies += 1; }, canApply: () => device.canApply });
  device.sync = sandbox.deviceSync;
  device.library = () => JSON.parse(store.get('fal_lora_library') ?? '[]');
  device.item = (path) => device.library().find((i) => i.path === path);
  // 画面がライブラリを丸ごと保存して markDirty する、の再現
  device.save = (items, section = 'loras') => {
    store.set(section === 'loras' ? 'fal_lora_library' : 'fal_ckpt_library', JSON.stringify(items));
    device.sync.markDirty(section);
  };
  device.edit = (path, patch) => {
    device.save(device.library().map((i) => (i.path === path ? { ...i, ...patch } : i)));
  };
  return device;
}

const lora = (path, extra = {}) => ({ name: path, path, ...extra });
const serverItems = (server, section = 'loras') => JSON.parse(server.doc[section].value);
const serverItem = (server, path) => serverItems(server).find((i) => i.path === path);
const tick = () => new Promise((r) => setTimeout(r, 0));

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/* ---------- 以前は設定が消えていた状況 ---------- */

test('タブを開きっぱなしの端末が別の LoRA を触っても、ほかの端末の設定は消えない', async () => {
  const server = makeServer();
  const a = makeDevice(server, { library: [lora('x'), lora('y')] });
  const b = makeDevice(server);
  await a.sync.pull(); // A の一覧がサーバーへ
  await b.sync.pull(); // B が取り寄せる（ここで B は画面を開きっぱなしにする）

  a.clock = 2_000;
  a.edit('x', { triggerAuto: true }); // A で x の自動挿入を入れる
  await a.sync.pull();

  b.clock = 3_000;
  b.edit('y', { fav: true }); // B は x の変更を知らないまま y に★
  await b.sync.pull();

  assert.equal(serverItem(server, 'x').triggerAuto, true, 'A の設定がサーバーに残る');
  assert.equal(serverItem(server, 'y').fav, true, 'B の★もサーバーに残る');
  assert.equal(b.item('x').triggerAuto, true, 'B にも A の設定が届く');
  await a.sync.pull();
  assert.equal(a.item('y').fav, true, 'A にも B の★が届く');
});

test('同じ LoRA を 2 台で変えたら、あとから変えた方が残る', async () => {
  const server = makeServer();
  const a = makeDevice(server, { library: [lora('x')] });
  const b = makeDevice(server);
  await a.sync.pull();
  await b.sync.pull();

  a.clock = 2_000;
  a.edit('x', { scale: 0.5 });
  b.clock = 3_000;
  b.edit('x', { scale: 0.8 });
  await b.sync.pull();
  await a.sync.pull();

  assert.equal(serverItem(server, 'x').scale, 0.8);
  assert.equal(a.item('x').scale, 0.8);
});

test('消した LoRA は、古い一覧を持った端末からの送信で生き返らない', async () => {
  const server = makeServer();
  const a = makeDevice(server, { library: [lora('x'), lora('z')] });
  const b = makeDevice(server);
  await a.sync.pull();
  await b.sync.pull();

  a.clock = 2_000;
  a.save(a.library().filter((i) => i.path !== 'z')); // A で z を削除
  await a.sync.pull();

  b.clock = 3_000;
  b.edit('x', { fav: true }); // B は z を持ったまま別の変更
  await b.sync.pull();

  assert.equal(serverItem(server, 'z'), undefined, 'サーバーでも消えたまま');
  assert.equal(b.item('z'), undefined, 'B からも消える');
  assert.equal(serverItem(server, 'x').fav, true);
});

test('消したあとに登録し直したものは残る', async () => {
  const server = makeServer();
  const a = makeDevice(server, { library: [lora('z')] });
  const b = makeDevice(server);
  await a.sync.pull();
  await b.sync.pull();

  a.clock = 2_000;
  a.save([]);
  await a.sync.pull();
  b.clock = 3_000;
  await b.sync.pull(); // B にも削除が届く
  assert.equal(b.item('z'), undefined);
  b.save([lora('z', { trigger: 'again' })]); // B で登録し直す
  await b.sync.pull();
  await a.sync.pull();

  assert.equal(a.item('z')?.trigger, 'again');
});

/* ---------- 移行（時刻を持たない既存のデータ） ---------- */

test('移行: 最初に同期した端末の内容が基準になり、あとから古い一覧で上書きされない', async () => {
  // 旧形式のサーバー（送信が失敗していたので古いまま）
  const server = makeServer({ doc: { loras: { value: JSON.stringify([lora('x')]), ts: 100 } } });
  // A: 自動挿入を入れた端末（送れていなかった）
  const a = makeDevice(server, { library: [lora('x', { triggerAuto: true })], ts: { loras: 500 } });
  // B: 古い一覧のまま、自分でも★を付けていた（こちらも送れていなかった）端末
  const b = makeDevice(server, { library: [lora('x'), lora('w')], ts: { loras: 900 } });

  await a.sync.pull(); // 先に A を開く
  assert.equal(serverItem(server, 'x').triggerAuto, true);
  assert.equal(server.doc.loras.v, 2, 'サーバーが新形式になる');

  await b.sync.pull(); // あとから B を開く
  assert.equal(serverItem(server, 'x').triggerAuto, true, 'B の古い x で上書きされない');
  assert.equal(b.item('x').triggerAuto, true, 'B にも届く');
  assert.ok(serverItem(server, 'w'), 'B にしか無かった w は残る');
});

test('移行: 時刻を持たない項目を画面が保存し直しても、変更とはみなさない', async () => {
  const server = makeServer();
  const a = makeDevice(server, { library: [lora('x'), lora('y')] });
  await a.sync.pull();
  // library.js は手元の配列（updatedAt を持たない古い読み込み）を丸ごと保存する
  a.clock = 2_000;
  a.save([lora('x'), lora('y', { fav: true })]);
  assert.equal(a.item('x').updatedAt, 0, '変わっていない x は時刻が付かない');
  assert.equal(a.item('y').updatedAt, 2_000, '変わった y だけ時刻が付く');
});

/* ---------- チェックポイント・アリーナ ---------- */

test('チェックポイントも項目ごとにマージされる', async () => {
  const server = makeServer();
  const a = makeDevice(server, { ckpts: [lora('c1')] });
  const b = makeDevice(server);
  await a.sync.pull();
  await b.sync.pull();
  a.clock = 2_000;
  a.save([lora('c1'), lora('c2')], 'ckpts');
  b.clock = 3_000;
  b.save([lora('c1'), lora('c3')], 'ckpts');
  await a.sync.pull();
  await b.sync.pull();
  assert.deepEqual(serverItems(server, 'ckpts').map((i) => i.path).sort(), ['c1', 'c2', 'c3']);
});

test('アリーナは新しい方を採り、LoRA の送信の巻き添えで古いものに戻らない', async () => {
  const server = makeServer();
  const a = makeDevice(server, { arena: { sessions: [] }, ts: { arena: 100 } });
  const b = makeDevice(server);
  await a.sync.pull();
  await b.sync.pull();

  a.clock = 2_000;
  a.store.set('fal_arena', JSON.stringify({ sessions: [{ id: 's1' }] }));
  a.sync.markDirty('arena');
  await a.sync.pull();

  b.clock = 3_000;
  b.save([lora('x')]); // B はアリーナの変更を知らないまま LoRA を送る
  await b.sync.pull();

  assert.deepEqual(JSON.parse(server.doc.arena.value), { sessions: [{ id: 's1' }] });
  assert.deepEqual(JSON.parse(b.store.get('fal_arena')), { sessions: [{ id: 's1' }] });
});

/* ---------- 画面の都合 ---------- */

test('保存待ちの編集がある画面には書き込まない（古い配列で上書きされるのを防ぐ）', async () => {
  const server = makeServer();
  const a = makeDevice(server, { library: [lora('x')] });
  const b = makeDevice(server);
  await a.sync.pull();
  b.canApply = false;
  await b.sync.pull();
  assert.equal(b.store.get('fal_lora_library'), undefined);
  assert.equal(b.applies, 0);
  b.canApply = true;
  await b.sync.pull();
  assert.ok(b.item('x'));
  assert.equal(b.applies, 1);
});

test('取り寄せた結果が手元と同じなら、送り直さず画面も描き直さない', async () => {
  const server = makeServer();
  const a = makeDevice(server, { library: [lora('x')] });
  await a.sync.pull();
  const before = server.puts.length;
  await a.sync.pull();
  assert.equal(server.puts.length, before);
  assert.equal(a.applies, 0);
});

/* ---------- 送信の方式 ---------- */

const big = Array.from({ length: 600 }, (_, i) => lora(
  `https://huggingface.co/u/r/resolve/main/lora_${i}.safetensors`,
  { base: 'Qwen-Image 2.1', trigger: 'ohwx man', triggerAuto: true },
));

test('普段の送信は keepalive を使わない（大きなライブラリでも送れる）', async () => {
  assert.ok(JSON.stringify(big).length > 64 * 1024, 'テスト用ライブラリは 64KB を超えている');
  const server = makeServer();
  const a = makeDevice(server, { library: big });
  await a.sync.pull();
  assert.equal(server.puts.length, 1);
  assert.equal(server.puts[0].keepalive, false);
  assert.equal(serverItems(server).length, 600);
});

test('離脱前の flush は、64KB を超えるなら keepalive を外して送る', async () => {
  const server = makeServer();
  const a = makeDevice(server, { library: big });
  a.sync.markDirty('loras');
  a.sync.flush();
  await tick();
  assert.equal(server.puts.length, 1);
  assert.equal(server.puts[0].keepalive, false);
  assert.deepEqual(a.warnings, []);
});

test('小さければ離脱前の flush は keepalive で送る', async () => {
  const server = makeServer();
  const a = makeDevice(server, { library: [lora('x')] });
  a.sync.markDirty('loras');
  a.sync.flush();
  await tick();
  assert.equal(server.puts.length, 1);
  assert.equal(server.puts[0].keepalive, true);
});

test('サーバーが拒否したら（413 など）黙らずに残す', async () => {
  const server = makeServer({ status: 413 });
  const a = makeDevice(server, { library: [lora('x')] });
  await a.sync.pull();
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0], /413/);
});

test('bfcache から復元されたときにも取り寄せる（通常の表示では二重に取らない）', async () => {
  const server = makeServer({ doc: { loras: { value: JSON.stringify([lora('x')]), ts: 1, v: 2 } } });
  const a = makeDevice(server);
  for (const fn of a.listeners.pageshow ?? []) fn({ persisted: false });
  await tick();
  assert.equal(a.item('x'), undefined);
  for (const fn of a.listeners.pageshow ?? []) fn({ persisted: true });
  await tick();
  await tick();
  assert.ok(a.item('x'));
});

for (const [name, fn] of cases) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`device-sync: ${passed}/${cases.length} passed`);
