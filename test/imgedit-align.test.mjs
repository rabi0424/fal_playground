// 画像編集の「ずれの補正（重ね合わせ）」のテスト:
//   node test/imgedit-align.test.mjs
//
// imgedit.js はブラウザ用の巨大な 1 枚もので、そのままは Node に読み込めない。
// 探索の部分は canvas を使わない純粋な関数にしてあるので、ソースから切り出して
// 確かめる（imgedit-fit.test.mjs と同じやり方）。見るのは:
//   - 既知の拡縮・平行移動をかけた絵から、その変換を 1/4 画素ほどの精度で取り戻すこと
//   - 帯を付けて送った枠（中身が画像の一部）でも、帯の側へはみ出した位置を拾えること
//   - 比べてよい画素（weights）を絞っても探せること
//   - 似ていない絵では当たりを出さないこと（決め打ちの枠に戻る）
//   - はみ出した矩形を画像の内側へ収めること
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const SRC = readFileSync(new URL('../imgedit.js', import.meta.url), 'utf8');

function pick(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} が見つかりません`);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}' && (depth -= 1) === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`${name} の終わりが見つかりません`);
}

const CONST = /const ALIGN_[A-Z_]+ = [^;]+;/g;
const consts = SRC.match(CONST);
assert.ok(consts?.length >= 6, '定数の切り出しに失敗しました');

const lib = new Function(`
  ${consts.join('\n')}
  ${['sampleField', 'alignSamples', 'transformScore', 'gridSearch', 'parabolaPeak',
    'findTransform', 'transformedRect', 'clampRect'].map(pick).join('\n')}
  return { findTransform, transformedRect, clampRect };
`)();

const { findTransform, transformedRect, clampRect } = lib;

/* ---- 合成した絵 ---- */

// なめらかな模様（連続座標で定義しておくと、どんな変換でもきっちり描ける）
function texture(seed) {
  const waves = [];
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 24; i++) {
    waves.push({ fx: (rnd() - 0.5) * 0.25, fy: (rnd() - 0.5) * 0.25, p: rnd() * 6.28, a: 0.5 + rnd() });
  }
  return (x, y) => waves.reduce((s, w) => s + w.a * Math.sin(w.fx * x + w.fy * y + w.p), 0);
}

// 連続座標の関数 g（元画像の座標 0..W）を、w×h の勾配の場にする（gradientField と同じ式）
function field(g, w, h, map) {
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [u, v] = map(x + 0.5, y + 0.5);
      lum[y * w + x] = u === null ? 0 : g(u, v) * 40;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + w] - lum[i - w]);
    }
  }
  return out;
}

// 元画像 W×H を送り、返ってきた画像（EW×EH）の中で、決め打ちの枠 nominal の
// 中身が「枠の中心まわりに s 倍して (dx, dy) 動いた」位置に描かれていた、という状況を作る。
// 返ってきた画像の帯の部分には別の模様（モデルが帯を勝手に描いた、の代わり）
function scenario({ W, H, EW, EH, nominal, s, dx, dy, weightsFn = null, other = null }) {
  const g = texture(7);
  const band = texture(99);
  const actual = {
    x: nominal.x + (nominal.width * (1 - s)) / 2 + dx,
    y: nominal.y + (nominal.height * (1 - s)) / 2 + dy,
    width: nominal.width * s,
    height: nominal.height * s,
  };
  // 返ってきた画像の座標 (px, py) → 元画像の座標（中身の外なら帯）
  const editedAt = (px, py) => {
    const u = ((px - actual.x) / actual.width) * W;
    const v = ((py - actual.y) / actual.height) * H;
    if (u < 0 || v < 0 || u > W || v > H) return [null, null];
    return [u, v];
  };
  const src = other ?? g;
  const edited = (px, py) => {
    const [u, v] = editedAt(px, py);
    return u === null ? band(px, py) : src(u, v);
  };

  const level = (target) => {
    const aspect = W / H;
    const w = aspect >= 1 ? target : Math.max(16, Math.round(target * aspect));
    const h = aspect >= 1 ? Math.max(16, Math.round(target / aspect)) : target;
    const fw = Math.max(16, Math.round((EW * w) / nominal.width));
    const fh = Math.max(16, Math.round((EH * h) / nominal.height));
    const gx = EW / fw;
    const gy = EH / fh;
    const weights = new Uint8Array(w * h).fill(1);
    if (weightsFn) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) weights[y * w + x] = weightsFn(x / w, y / h);
    }
    return {
      ref: field(g, w, h, (x, y) => [(x / w) * W, (y / h) * H]),
      weights,
      w,
      h,
      field: fieldOf(edited, fw, fh, gx, gy),
      fw,
      fh,
      origin: { x: nominal.x / gx, y: nominal.y / gy },
      rx: nominal.width / w / gx,
      ry: nominal.height / h / gy,
      gx,
      gy,
    };
  };
  const found = findTransform(level);
  return { found, actual, rect: found && transformedRect(nominal, found, found.level.gx, found.level.gy) };
}

// 返ってきた画像を fw×fh に縮めた勾配の場（edited は返ってきた画像の px で定義）
function fieldOf(edited, fw, fh, gx, gy) {
  const lum = new Float32Array(fw * fh);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) lum[y * fw + x] = edited((x + 0.5) * gx, (y + 0.5) * gy) * 40;
  }
  const out = new Float32Array(fw * fh);
  for (let y = 1; y < fh - 1; y++) {
    for (let x = 1; x < fw - 1; x++) {
      const i = y * fw + x;
      out[i] = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + fw] - lum[i - fw]);
    }
  }
  return out;
}

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}（許容 ${tol}）`);
function expectRect(rect, actual, tol, label) {
  for (const k of ['x', 'y', 'width', 'height']) near(rect[k], actual[k], tol, `${label} ${k}`);
}

/* ---- 帯なし（全面）: 平行移動だけ ---- */
{
  const nominal = { x: 0, y: 0, width: 1024, height: 768 };
  const { found, actual, rect } = scenario({
    W: 1024, H: 768, EW: 1024, EH: 768, nominal, s: 1, dx: 5.4, dy: -3.2,
  });
  assert.ok(found, '平行移動を見つける');
  expectRect(rect, actual, 0.5, '平行移動');
}

/* ---- 帯あり: 中身が帯の側へずれて、少し縮められている ---- */
// 4:3 を 1:1 で送った → 上下に帯。返りでは中身が 2% 縮み、上へ 9px ずれた
{
  const nominal = { x: 0, y: 166, width: 1328, height: 996 };
  const { found, actual, rect } = scenario({
    W: 4000, H: 3000, EW: 1328, EH: 1328, nominal, s: 0.98, dx: 3, dy: -9,
  });
  assert.ok(found, '帯の側へのずれと縮みを見つける');
  near(found.s, 0.98, 0.001, '倍率');
  expectRect(rect, actual, 1, '帯あり');
}

/* ---- 帯あり: 中身が拡大されて、帯へはみ出している ---- */
{
  const nominal = { x: 571, y: 0, width: 522, height: 928 };
  const { found, actual, rect } = scenario({
    W: 1080, H: 1920, EW: 1664, EH: 928, nominal, s: 1.03, dx: -6, dy: 2,
  });
  assert.ok(found, '拡大を見つける');
  near(found.s, 1.03, 0.001, '倍率');
  expectRect(rect, actual, 1, '拡大');
}

/* ---- 比べる場所を絞る（マスクの外側だけ） ---- */
{
  const nominal = { x: 0, y: 0, width: 1024, height: 1024 };
  const { found, actual, rect } = scenario({
    W: 1024, H: 1024, EW: 1024, EH: 1024, nominal, s: 1.01, dx: -4, dy: 4,
    // 真ん中を塗った（比べない）
    weightsFn: (u, v) => (Math.abs(u - 0.5) < 0.25 && Math.abs(v - 0.5) < 0.25 ? 0 : 1),
  });
  assert.ok(found, 'マスクの外側だけで見つける');
  expectRect(rect, actual, 1, 'マスクの外側');
}

/* ---- 似ていない絵では当たりを出さない ---- */
{
  const nominal = { x: 0, y: 0, width: 1024, height: 768 };
  const { found } = scenario({
    W: 1024, H: 768, EW: 1024, EH: 768, nominal, s: 1, dx: 0, dy: 0, other: texture(12345),
  });
  assert.equal(found, null, '別の絵なら決め打ちの枠に戻す');
}

/* ---- はみ出した矩形を収める ---- */
{
  // 左上へはみ出した → 内側へ寄せる（大きさは変えない）
  assert.deepEqual(clampRect({ x: -3, y: -2, width: 100, height: 50 }, 200, 200),
    { x: 0, y: 0, width: 100, height: 50 });
  // 画像より大きい → 比を保って縮め、中心に置く
  const r = clampRect({ x: -10, y: 5, width: 220, height: 110 }, 200, 200);
  near(r.width, 200, 1e-9, '幅');
  near(r.height, 100, 1e-9, '高さ');
  near(r.x, 0, 1e-9, 'x');
  // 右下へはみ出した
  const b = clampRect({ x: 150, y: 180, width: 60, height: 30 }, 200, 200);
  assert.deepEqual(b, { x: 140, y: 170, width: 60, height: 30 });
}

console.log('imgedit-align: ok');
