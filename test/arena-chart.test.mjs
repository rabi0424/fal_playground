// 比較アリーナの Elo グラフのテスト:  node test/arena-chart.test.mjs
//
// arena-chart.js はブラウザ用の IIFE なので、window だけ用意して読み込む。見るのは:
//   - ブートストラップの帯が点推定を挟み、同じ投票からは同じ帯が出ること
//   - 結果が安定した投票では帯が狭く、コイン投げのような投票では広いこと
//     （Elo は K 幅で揺れ続けるので、投票数を増やしても帯は縮まない。
//       縮まるのは「同じ相手に同じ結果」が積み上がったときだけ）
//   - 並び順: ステップ順は参加順のまま、Elo 順は降順で、点のないものは末尾
//   - 点のないチェックポイントで線と帯が途切れること
//   - 目盛りがきりのいい値になり、横のラベルが幅に応じて間引かれること
//   - 名前が SVG に入るときエスケープされること
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const SRC = readFileSync(new URL('../arena-chart.js', import.meta.url), 'utf8');
const window = {};
new Function('window', SRC)(window);
const chart = window.falArenaChart;

/* ---- arena.js と同じ Elo（初期値 1000・K=32） ---- */
function makeElo(participants) {
  return (matches) => {
    const ratings = Object.fromEntries(participants.map((p) => [p.id, 1000]));
    for (const m of matches) {
      const ea = 1 / (1 + 10 ** ((ratings[m.b] - ratings[m.a]) / 400));
      const sa = m.winner === 'a' ? 1 : m.winner === 'b' ? 0 : 0.5;
      ratings[m.a] += 32 * (sa - ea);
      ratings[m.b] += 32 * ((1 - sa) - (1 - ea));
    }
    return { ratings };
  };
}

const IDS = ['p1', 'p2', 'p3'];

// 総当たりを n 試合ぶん。winner は (a, b, 乱数) から決める
function makeMatches(n, decide, seed = 1) {
  const rng = chart.mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = IDS[i % 3];
    const b = IDS[(i + 1) % 3];
    out.push({ a, b, winner: decide(a, b, rng()) });
  }
  return out;
}

// 番号が大きい方が必ず勝つ / コイン投げ
const decisive = (a, b) => (a > b ? 'a' : 'b');
const coin = (a, b, r) => (r < 0.5 ? 'a' : 'b');

const participants = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
const elo = makeElo(participants);

/* ---- ブートストラップ ---- */
{
  const matches = makeMatches(60, decisive);
  const point = elo(matches).ratings;
  const bands = chart.bootstrapBands(participants, matches, elo);
  for (const p of participants) {
    const { lo, hi } = bands[p.id];
    assert.ok(lo < hi, `${p.id}: 帯に幅がある`);
    assert.ok(lo - 10 <= point[p.id] && point[p.id] <= hi + 10, `${p.id}: 帯が点推定を挟む`);
  }
  // 結果が一貫していれば帯は重ならず、順位もそのまま
  assert.ok(bands.p3.lo > bands.p2.hi && bands.p2.lo > bands.p1.hi, '一貫した投票では帯が離れる');

  const again = chart.bootstrapBands(participants, matches, elo);
  assert.deepEqual(again, bands, '同じ投票からは同じ帯（描き直しで揺れない）');

  const width = (b) => participants.reduce((s, p) => s + b[p.id].hi - b[p.id].lo, 0);
  const noisy = chart.bootstrapBands(participants, makeMatches(60, coin), elo);
  assert.ok(width(noisy) > width(bands) * 1.5, `コイン投げの帯は広い（${width(noisy)} vs ${width(bands)}）`);
  // 帯が重なる = 揺らぎの範囲で差がない、と読めること
  const overlap = (x, y) => x.lo < y.hi && y.lo < x.hi;
  assert.ok(overlap(noisy.p1, noisy.p2) || overlap(noisy.p2, noisy.p3), 'コイン投げでは帯が重なる');

  assert.equal(chart.bootstrapBands(participants, matches.slice(0, 1), elo), null, '1 票では帯を出さない');
  assert.equal(chart.bootstrapBands([], matches, elo), null, '参加者なし');
}

/* ---- 目盛り ---- */
{
  assert.deepEqual(chart.niceTicks(930, 1070), [950, 1000, 1050]);
  assert.deepEqual(chart.niceTicks(990, 1012), [990, 995, 1000, 1005, 1010]);
  assert.deepEqual(chart.niceTicks(1000, 1000), [1000], '幅がないときは 1 本');
}

/* ---- レイアウト ---- */
const rows = [
  { id: 'p1', label: '…1000', title: 'lora-1000', elo: 980, lo: 950, hi: 1010, games: 8, w: 3, d: 1, l: 4, plotted: true },
  { id: 'p2', label: '…2000', title: 'lora-2000', elo: 1040, lo: 1010, hi: 1070, games: 8, w: 5, d: 1, l: 2, plotted: true },
  { id: 'p3', label: '…3000', title: 'lora-3000', elo: 1000, lo: null, hi: null, games: 0, w: 0, d: 0, l: 0, plotted: false },
  { id: 'p4', label: '…4000', title: 'lora-4000', elo: 1015, lo: 990, hi: 1040, games: 3, w: 2, d: 0, l: 1, plotted: true },
];

{
  const lay = chart.layout({ rows, order: 'step', width: 340, minGamesOk: 6 });
  assert.deepEqual(lay.points.map((p) => p.id), ['p1', 'p2', 'p3', 'p4'], 'ステップ順は参加順のまま');
  assert.equal(lay.points[2].y, null, '点のないものは座標を持たない');
  assert.equal(lay.best.id, 'p2', '最大の点に値を添える');
  assert.ok(lay.points[3].low && !lay.points[1].low, '試合数が目安未満の点に印');
  assert.ok(lay.points.every((p) => p.showLabel), '4 点なら全部にラベル');
  // Elo が高いほど上（y が小さい）
  assert.ok(lay.points[1].y < lay.points[3].y && lay.points[3].y < lay.points[0].y);
  // 帯は点を挟む
  assert.ok(lay.points[0].yHi < lay.points[0].y && lay.points[0].y < lay.points[0].yLo);
  // 帯まで含めて描画域に収まり、目盛りはきりのいい値
  const inPlot = (v) => v >= lay.plot.top && v <= lay.plot.top + lay.plot.height;
  assert.ok(lay.points.filter((p) => p.plotted).every((p) => inPlot(p.yHi) && inPlot(p.yLo)));
  assert.deepEqual(lay.ticks.map((t) => t.value), [950, 1000, 1050]);
  assert.ok(lay.ticks.every((t) => inPlot(t.y)));
  assert.ok(lay.points.every((p) => p.x > lay.plot.left && p.x < lay.plot.left + lay.plot.width));
}

{
  const lay = chart.layout({ rows, order: 'elo', width: 340, minGamesOk: 6 });
  assert.deepEqual(lay.points.map((p) => p.id), ['p2', 'p4', 'p1', 'p3'], 'Elo 順は降順で、点のないものは末尾');
}

{
  // 30 体を 340px に詰めると、ラベルは間引かれる
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `p${i}`, label: `…${i}`, title: `lora-${i}`, elo: 1000 + i, lo: 990 + i, hi: 1010 + i,
    games: 8, w: 4, d: 0, l: 4, plotted: true,
  }));
  const lay = chart.layout({ rows: many, order: 'step', width: 340, minGamesOk: 6 });
  const shown = lay.points.filter((p) => p.showLabel);
  assert.ok(shown.length >= 4 && shown.length < 30, `ラベルは間引かれる（${shown.length} 個）`);
  assert.ok(shown[0].id === 'p0', '先頭のラベルは残す');
  const gaps = shown.slice(1).map((p, i) => p.x - shown[i].x);
  assert.ok(gaps.every((g) => g >= 40), '残したラベル同士は重ならない間隔');
  // 広ければ全部出る
  const wide = chart.layout({ rows: many, order: 'step', width: 1600, minGamesOk: 6 });
  assert.ok(wide.points.every((p) => p.showLabel));
}

/* ---- SVG ---- */
{
  const lay = chart.layout({ rows, order: 'step', width: 340, minGamesOk: 6 });
  const svg = chart.svgMarkup(lay);
  assert.equal((svg.match(/<circle /g) || []).length, 3, '点は試合のある 3 体ぶん');
  assert.equal((svg.match(/class="lb-dot low"/g) || []).length, 1);
  // 線は p2 と p4 の間（p3 が欠けている）で途切れる: M が 2 回
  const line = svg.match(/class="lb-line" d="([^"]*)"/)[1];
  assert.equal((line.match(/M/g) || []).length, 2, `線が途切れる: ${line}`);
  const band = svg.match(/class="lb-band" d="([^"]*)"/)[1];
  assert.equal((band.match(/Z/g) || []).length, 2, `帯も途切れる: ${band}`);
  assert.ok(svg.includes('class="lb-best"') && svg.includes('>1040<'), '最大値のラベル');

  const evil = chart.layout({
    rows: [{ ...rows[0], label: '<b>"x"</b>&' }], order: 'step', width: 340, minGamesOk: 6,
  });
  const out = chart.svgMarkup(evil);
  assert.ok(!out.includes('<b>') && out.includes('&lt;b&gt;&quot;x&quot;&lt;/b&gt;&amp;'), 'ラベルはエスケープ');
}

console.log('arena-chart: ok');
