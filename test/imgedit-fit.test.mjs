// 画像編集の「縦横比が合わないときの送り方」のテスト:
//   node test/imgedit-fit.test.mjs
//
// imgedit.js はブラウザ用の巨大な 1 枚もので、そのままは Node に読み込めない。
// 幾何の計算だけは純粋な関数にしてあるので、ソースから切り出して確かめる。
// 見るのは:
//   - 帯の枠（letterbox）が、中身を歪めずに送信サイズへ収めて中央へ置くこと
//   - 比が同じ（丸め誤差の範囲）なら帯を付けないこと
//   - 縁の余白（padFrame）が、既にある帯のぶんを差し引いて足すこと
//     （帯があるのに同じだけ広げると、要らない余白で中身が痩せる）
//   - 余白を足した枠でも、中身の縦横比が保たれること
//   - 結果を入力の比へ戻すか（fitBack）の判定と、戻したときの大きさ
//     （restoredSize。詰まった軸を伸ばし返す＝モデルが描いた画素を捨てない）
//   - アップスケール生成の送信サイズ（n 倍してから上限へ収める順序）
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const SRC = readFileSync(new URL('../imgedit.js', import.meta.url), 'utf8');

// `function 名(` から、対応する閉じ括弧までを切り出す
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

const CONST = /const (FIT_MIN_STRETCH|RUNWARE_MAX_PX|MAX_ORIGINAL_PX|MAX_ORIGINAL_AREA) = [^;]+;/g;
const consts = SRC.match(CONST);
assert.equal(consts?.length, 4, '定数の切り出しに失敗しました');

// padFrame はマスクの画素を読む maskEdgeGaps を呼ぶので、そこだけ差し替える
const build = new Function('gaps', `
  ${consts.join('\n')}
  const maskEdgeGaps = () => gaps;
  ${pick('letterbox')}
  ${pick('padFrame')}
  ${pick('fitWithin')}
  ${pick('restoredSize')}
  ${pick('fitBack')}
  ${SRC.match(/const UPSCALE_STEPS = \[[\s\S]*?\n\];/)[0]}
  ${SRC.match(/const upscaleScale = [^;]+;/)[0]}
  // sendSize のうち、アップスケールを選んだときの計算だけを写したもの
  const upscaledSize = (from, choice, max) => {
    const scale = upscaleScale(choice);
    return scale ? fitWithin({ width: from.width * scale, height: from.height * scale }, max) : null;
  };
  return { letterbox, padFrame, restoredSize, fitBack, upscaleScale, upscaledSize };
`);

const { letterbox, restoredSize, fitBack, upscaleScale, upscaledSize } = build(null);
const aspect = (r) => r.width / r.height;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

/* ---- 帯の枠 ---- */

// 4:3 の写真を 1:1 で送る → 上下に帯
{
  const fit = letterbox({ width: 1328, height: 1328 }, { width: 4000, height: 3000 });
  assert.deepEqual(fit.outer, { width: 1328, height: 1328 });
  assert.equal(fit.inner.width, 1328, '長辺は送信サイズいっぱいに使う');
  assert.equal(fit.inner.height, 996);
  assert.equal(fit.inner.x, 0);
  assert.equal(fit.inner.y, 166, '中央に置く（上下の帯は同じ幅）');
  near(aspect(fit.inner), 4 / 3, 0.002, '中身の比が保たれる');
}

// 縦長の写真を 16:9 で送る → 左右に帯
{
  const fit = letterbox({ width: 1664, height: 928 }, { width: 1080, height: 1920 });
  assert.equal(fit.inner.height, 928);
  assert.equal(fit.inner.width, 522);
  assert.equal(fit.inner.y, 0);
  assert.equal(fit.inner.x, Math.round((1664 - 522) / 2));
  near(aspect(fit.inner), 1080 / 1920, 0.002, '中身の比が保たれる');
}

// 比が同じなら帯は要らない（丸めで数 px ずれただけのときも）
assert.equal(letterbox({ width: 1328, height: 1328 }, { width: 2000, height: 2000 }), null);
assert.equal(letterbox({ width: 1328, height: 1328 }, { width: 1330, height: 1328 }), null,
  '0.5% 未満の食い違いは帯にしない（丸めで数 px ずれただけ）');
assert.equal(letterbox({ width: 1024, height: 1024 }, { width: 0, height: 0 }), null);

// Qwen の「4:3」プリセットは厳密な 4:3 ではない（1472×1140 = 1.291）。
// 3% の食い違いは引き伸ばすと分かるので、ここは帯になる
{
  const fit = letterbox({ width: 1472, height: 1140 }, { width: 4000, height: 3000 });
  assert.equal(fit.inner.height, 1104);
  assert.equal(fit.inner.y, 18);
}

/* ---- 縁の余白（帯との足し引き） ---- */

const mask = { strokes: [], feather: 0 };
const size = { width: 1328, height: 1328 };
// マスクが左の縁に貼り付いている（gap 0）・ほかの辺は十分離れている
const atLeft = { left: 0, right: 0.5, top: 0.5, bottom: 0.5 };

// 帯が無いときは、これまで通り左へ amount ぶん足す
{
  const { padFrame } = build(atLeft);
  const frame = padFrame(size, mask, 0, 96);
  assert.ok(frame.outer.width > size.width, '左へ広げたぶん横に伸びる');
  assert.equal(frame.pad.left, 96);
  assert.equal(frame.pad.right, 0);
  assert.ok(frame.inner.x > 0, '元画像は広げたぶんだけ内側へ');
}

// 上下に帯がある（左右には無い）→ 左はこれまで通り足す
{
  const { padFrame } = build(atLeft);
  const base = { x: 0, y: 166, width: 1328, height: 996 };
  const frame = padFrame(size, mask, 0, 96, base);
  assert.equal(frame.pad.left, 96);
  near(aspect(frame.inner), aspect(base), 0.01, '帯の内側の比は変わらない');
}

// 左右に 120px の帯がある → 既にある帯で足りるので、これ以上広げない
{
  const { padFrame } = build(atLeft);
  const base = { x: 120, y: 0, width: 1088, height: 1328 };
  assert.equal(padFrame(size, mask, 0, 96, base), null,
    '帯が amount より広ければ、余白を足す必要はない');
}

// 左右に 40px の帯がある → 足りないぶん（96 - 40）だけ足す
{
  const { padFrame } = build(atLeft);
  const base = { x: 40, y: 0, width: 1248, height: 1328 };
  const frame = padFrame(size, mask, 0, 96, base);
  assert.equal(frame.pad.left, 56);
  assert.equal(frame.pad.right, 0);
}

// マスクが無ければ（gaps が null）何もしない
assert.equal(build(null).padFrame(size, mask, 0, 96), null);
assert.equal(build(atLeft).padFrame(size, mask, 0, 0), null, 'amount 0 は無効');

/* ---- 結果を入力の比へ戻すかの判定 ---- */

const src43 = { width: 4000, height: 3000 };
assert.equal(fitBack({ crop: { x: 0, y: 166, width: 1328, height: 996 } }), 'trim',
  '帯を付けて送ったなら、帯の内側を切り出す');
assert.equal(
  fitBack({ sentSize: { width: 1328, height: 1328 }, sourceSize: src43 }), 'unstretch',
  '引き伸ばして送ったなら、伸ばし返す',
);
assert.equal(
  fitBack({ sentSize: { width: 1328, height: 996 }, sourceSize: src43 }), null,
  '比が同じなら何もしない',
);
assert.equal(fitBack({ sentSize: null, sourceSize: src43 }), null, '古い記録は触らない');

/* ---- 戻したときの大きさ ---- */

// 4:3 を 1:1 で送った（横が詰まっている）→ 横を伸ばし返す。
// 縦を 996 まで縮めてしまうと、モデルが実際に描いた画素を捨てることになる
assert.deepEqual(restoredSize({ width: 1328, height: 1328 }, src43),
  { width: 1771, height: 1328 });

// 縦長を 16:9 で送った（縦が詰まっている）→ 縦を伸ばし返す
assert.deepEqual(restoredSize({ width: 1664, height: 928 }, { width: 1080, height: 1920 }),
  { width: 1664, height: 2958 });

// 既に比が合っていればそのまま（帯を切り出しただけのとき）
assert.deepEqual(restoredSize({ width: 1328, height: 996 }, src43),
  { width: 1328, height: 996 });

// 伸ばし返した結果が大きくなりすぎるときは、比を保ったまま上限へ収める
{
  const out = restoredSize({ width: 2048, height: 2048 }, { width: 4000, height: 800 });
  assert.ok(out.width <= 4096 && out.width * out.height <= 16 * 1024 * 1024);
  near(out.width / out.height, 5, 0.01, '比は保ったまま収める');
}

/* ---- アップスケール生成 ---- */

assert.equal(upscaleScale('up_2'), 2);
assert.equal(upscaleScale('up_1_5'), 1.5);
assert.equal(upscaleScale('auto'), null, 'プリセットはアップスケールではない');
assert.equal(upscaleScale('none'), null);

// 各辺を n 倍する（比はそのままなので、帯も引き伸ばしも起きない）
assert.deepEqual(upscaledSize({ width: 768, height: 1024 }, 'up_2', 4096),
  { width: 1536, height: 2048 });
assert.deepEqual(upscaledSize({ width: 800, height: 600 }, 'up_1_5', 4096),
  { width: 1200, height: 900 });

// 上限で頭打ちになっても比は保つ
{
  const out = upscaledSize({ width: 1500, height: 1000 }, 'up_4', 2048);
  assert.deepEqual(out, { width: 2048, height: 1365 });
  near(out.width / out.height, 1.5, 0.01, '頭打ちでも比はそのまま');
}

// fitWithin は縮めるだけなので、先に n 倍してから収める順序でないと効かない
assert.deepEqual(upscaledSize({ width: 512, height: 512 }, 'up_3', 4096),
  { width: 1536, height: 1536 });

console.log('ok: 画像編集の帯・縁の余白・縦横比の戻し・アップスケール');
