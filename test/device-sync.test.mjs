// 端末間同期（device-sync.js）の単体テスト:  node test/device-sync.test.mjs
//
// keepalive 付きの fetch は本文が 64KB を超えると送らずに失敗する。以前は同期の
// PUT を常に keepalive で送っていたため、LoRA ライブラリが育つと送信が全部
// 黙って失敗し、ほかの端末に設定が届かなかった。
// 見るのは「普段の送信は keepalive を使わない」「離脱前の送信は収まるときだけ
// keepalive」「失敗を黙って飲み込まない」こと。
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

function loadSync({ library = '[]', remote = null, status = 200 } = {}) {
  const store = new Map([['fal_lora_library', library]]);
  const puts = [];
  const warnings = [];
  const sandbox = {
    console: { ...console, warn: (...a) => warnings.push(a.join(' ')) },
    TextEncoder,
    Response,
    setTimeout,
    clearTimeout,
    falStore: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => store.set(k, v),
      remove: (k) => store.delete(k),
    },
    loraLib: { migrate() {} },
    fetch: async (url, init = {}) => {
      if (init.method === 'PUT') {
        // 本物のブラウザと同じく、64KB を超える keepalive は送らずに失敗させる
        if (init.keepalive && new TextEncoder().encode(init.body).length > 64 * 1024) {
          throw new TypeError('Failed to fetch');
        }
        puts.push({ keepalive: !!init.keepalive, bytes: init.body.length });
        return new Response('{}', { status });
      }
      return Response.json(remote);
    },
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(new URL('../device-sync.js', import.meta.url), 'utf8'), sandbox);
  return { deviceSync: sandbox.deviceSync, store, puts, warnings };
}

const big = JSON.stringify(Array.from({ length: 600 }, (_, i) => ({
  name: `lora_${i}`, path: `https://huggingface.co/u/r/resolve/main/lora_${i}.safetensors`,
  base: 'Qwen-Image 2.1', trigger: 'ohwx man', triggerAuto: true,
})));
assert.ok(big.length > 64 * 1024, 'テスト用ライブラリは 64KB を超えている');

let passed = 0;

// 1. 普段の同期（pull で手元が新しいと分かったときの送信）は keepalive を使わない
{
  const s = loadSync({ library: big });
  s.store.set('fal_sync_ts', JSON.stringify({ loras: Date.now() }));
  await s.deviceSync.pull();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.puts.length, 1, '大きなライブラリでも送信される');
  assert.equal(s.puts[0].keepalive, false);
  passed++;
}

// 2. 離脱前の flush は、64KB を超えるなら keepalive を外して送る（送信自体は行う）
{
  const s = loadSync({ library: big });
  s.deviceSync.markDirty('loras');
  s.deviceSync.flush();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.puts.length, 1);
  assert.equal(s.puts[0].keepalive, false);
  assert.deepEqual(s.warnings, []);
  passed++;
}

// 3. 小さければ離脱前の flush は keepalive で送る
{
  const s = loadSync({ library: '[{"path":"a"}]' });
  s.deviceSync.markDirty('loras');
  s.deviceSync.flush();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.puts.length, 1);
  assert.equal(s.puts[0].keepalive, true);
  passed++;
}

// 4. サーバーが拒否したら（413 など）黙らずに残す
{
  const s = loadSync({ library: big, status: 413 });
  s.store.set('fal_sync_ts', JSON.stringify({ loras: Date.now() }));
  await s.deviceSync.pull();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /413/);
  passed++;
}

console.log(`device-sync: ${passed} checks passed`);
