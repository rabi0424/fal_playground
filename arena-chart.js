'use strict';

/* ==========================================================================
 * 比較アリーナ: Elo グラフ
 *
 * リーダーボードの数字だけでは「どの学習ステップでピークか」「その後は
 * 落ちているのか」といった傾向がつかみにくいので、チェックポイントを
 * 学習ステップ順（= セッション参加順）に並べた折れ線で併記する。
 *
 * - 点: 各チェックポイントの Elo。試合数が目安未満のものは中抜きで示す
 * - 帯: ブートストラップ（投票を復元抽出して Elo を計算し直す）の 90% 区間。
 *   帯が重なっている同士は「投票の揺らぎの範囲で差がない」と読める
 * - 並び: ステップ順 / Elo 降順を切り替えられる
 *
 * Elo の計算関数は arena.js のものを受け取って使う（同じ式で揺らぎを出すため）。
 * ブラウザ用の IIFE だが、描画結果は SVG 文字列なので Node のテストからも
 * 中身を確かめられる。
 * ========================================================================== */

(function () {

const BOOTSTRAP_SAMPLES = 200;
const BAND_LOW = 0.05;
const BAND_HIGH = 0.95;

const MARGIN = { top: 14, right: 12, bottom: 44, left: 40 };
const PLOT_HEIGHT = 150;
const MIN_LABEL_SLOT = 46; // 目盛りラベル 1 つに要る横幅（回転して表示する）

/* ---------- 乱数（決まった種から同じ列を返す） ----------
 * 投票のたびに描き直すので、同じ投票結果からは同じ帯が出るようにしておく。
 * 毎回違う帯が出ると、揺らいでいるのが表示なのか結果なのか分からなくなる */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- ブートストラップ ---------- */

// 投票を復元抽出して Elo を計算し直し、各参加者の 90% 区間を返す。
//   elo(matches) -> { ratings: { pid: number } }
// 抽出した投票は元の時系列順に並べ直して再生する（Elo は順序に依存するため）。
// 返り値: { pid: { lo, hi } }。投票が 2 件未満なら null（揺らぎを出しようがない）
function bootstrapBands(participants, matches, elo, options = {}) {
  const samples = options.samples ?? BOOTSTRAP_SAMPLES;
  if (matches.length < 2 || participants.length === 0) return null;
  const rng = options.rng ?? mulberry32(matches.length * 2654435761 + participants.length);
  const n = matches.length;
  const sums = {};
  for (const p of participants) sums[p.id] = [];
  for (let s = 0; s < samples; s++) {
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = Math.floor(rng() * n);
    idx.sort((a, b) => a - b);
    const { ratings } = elo(idx.map((i) => matches[i]));
    for (const p of participants) sums[p.id].push(ratings[p.id]);
  }
  const bands = {};
  for (const p of participants) {
    const sorted = sums[p.id].sort((a, b) => a - b);
    bands[p.id] = {
      lo: quantile(sorted, BAND_LOW),
      hi: quantile(sorted, BAND_HIGH),
    };
  }
  return bands;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/* ---------- 目盛り ---------- */

// 値の範囲をきりのいい数で割る。返り値は昇順の目盛り値
function niceTicks(min, max, count = 5) {
  const span = max - min;
  if (!(span > 0)) return [Math.round(min)];
  const rough = span / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Math.round(v));
  return ticks;
}

/* ---------- レイアウト ---------- */

// 描画に必要な座標をすべて計算する（SVG に依存しないのでテストしやすい）。
//   rows: [{ id, label, title, elo, lo, hi, games, low, plotted }]
//   order: 'step'（参加順 = 学習ステップ順） | 'elo'（降順）
function layout({ rows, order, width, minGamesOk }) {
  const sorted = order === 'elo'
    ? [...rows].sort((a, b) => (b.plotted - a.plotted) || (b.elo - a.elo))
    : rows;
  const plotW = Math.max(60, width - MARGIN.left - MARGIN.right);
  const slot = sorted.length > 0 ? plotW / sorted.length : plotW;

  const plotted = sorted.filter((r) => r.plotted);
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const r of plotted) {
    yMin = Math.min(yMin, r.elo, r.lo ?? r.elo);
    yMax = Math.max(yMax, r.elo, r.hi ?? r.elo);
  }
  if (!Number.isFinite(yMin)) { yMin = 950; yMax = 1050; }
  // 上下に少し余白。全部同じ値のときも潰れないよう最低幅を持たせる
  const pad = Math.max(10, (yMax - yMin) * 0.08);
  yMin -= pad;
  yMax += pad;
  const ticks = niceTicks(yMin, yMax);

  const y = (v) => MARGIN.top + (yMax - v) / (yMax - yMin) * PLOT_HEIGHT;
  const x = (i) => MARGIN.left + slot * (i + 0.5);

  // 横のラベルは全部は入らないので、slot が狭いときは等間隔に間引く
  //（出ていない名前はホバーで確かめられる）
  const every = Math.max(1, Math.ceil(MIN_LABEL_SLOT / slot));

  const points = sorted.map((r, i) => ({
    ...r,
    x: x(i),
    y: r.plotted ? y(r.elo) : null,
    yLo: r.plotted && r.lo != null ? y(r.lo) : null,
    yHi: r.plotted && r.hi != null ? y(r.hi) : null,
    showLabel: i % every === 0,
    low: r.plotted && r.games < minGamesOk,
  }));

  // 最大の点にだけ値を添える（全点に数字を付けると読めなくなる）
  let best = null;
  for (const p of points) {
    if (p.plotted && (best === null || p.elo > best.elo)) best = p;
  }

  return {
    width,
    height: MARGIN.top + PLOT_HEIGHT + MARGIN.bottom,
    plot: { left: MARGIN.left, top: MARGIN.top, width: plotW, height: PLOT_HEIGHT, slot },
    ticks: ticks.map((v) => ({ value: v, y: y(v) })),
    points,
    best,
  };
}

/* ---------- SVG ---------- */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const fmt = (v) => String(Math.round(v));

// 線は点のある区間だけを結ぶ（生成に失敗した等で点がない所は途切れさせる）
function linePath(points) {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p.plotted) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

// 帯も同じく途切れる。連続した区間ごとに上辺→下辺の閉じた面にする
function bandPath(points) {
  const runs = [];
  let run = [];
  for (const p of points) {
    if (p.plotted && p.yLo != null) run.push(p);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  let d = '';
  for (const r of runs) {
    if (r.length === 1) {
      // 1 点だけの帯は縦線にする
      const p = r[0];
      d += `M${(p.x - 3).toFixed(1)},${p.yHi.toFixed(1)}H${(p.x + 3).toFixed(1)}V${p.yLo.toFixed(1)}H${(p.x - 3).toFixed(1)}Z`;
      continue;
    }
    d += r.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.yHi.toFixed(1)}`).join('');
    d += [...r].reverse().map((p) => `L${p.x.toFixed(1)},${p.yLo.toFixed(1)}`).join('');
    d += 'Z';
  }
  return d;
}

function svgMarkup(lay) {
  const { width, height, plot, ticks, points, best } = lay;
  const parts = [];
  parts.push(`<svg class="lb-chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="チェックポイントごとの Elo レート">`);

  // 目盛り線（控えめな実線）と目盛り値
  for (const t of ticks) {
    parts.push(`<line class="lb-grid" x1="${plot.left}" x2="${plot.left + plot.width}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/>`);
    parts.push(`<text class="lb-tick" x="${plot.left - 6}" y="${t.y.toFixed(1)}" text-anchor="end" dominant-baseline="middle">${fmt(t.value)}</text>`);
  }

  parts.push(`<path class="lb-band" d="${bandPath(points)}"/>`);
  parts.push(`<path class="lb-line" d="${linePath(points)}"/>`);

  points.forEach((p, i) => {
    if (p.showLabel) {
      const lx = p.x.toFixed(1);
      const ly = plot.top + plot.height + 8;
      parts.push(`<text class="lb-xlabel" x="${lx}" y="${ly}" transform="rotate(-45 ${lx} ${ly})" text-anchor="end" dominant-baseline="middle">${esc(p.label)}</text>`);
    }
    if (!p.plotted) return;
    const cls = p.low ? 'lb-dot low' : 'lb-dot';
    parts.push(`<circle class="${cls}" data-index="${i}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4"/>`);
  });

  if (best) {
    parts.push(`<text class="lb-best" x="${best.x.toFixed(1)}" y="${(best.y - 9).toFixed(1)}" text-anchor="middle">${fmt(best.elo)}</text>`);
  }

  // 十字線（ホバーで動かす）
  parts.push(`<line class="lb-cross" x1="0" x2="0" y1="${plot.top}" y2="${plot.top + plot.height}" hidden/>`);
  parts.push('</svg>');
  return parts.join('');
}

/* ---------- 描画とホバー ---------- */

// container に描く。ホバーで最寄りの点の中身を tooltip に出し、
// onHover(pid|null) で呼び出し側（表の行の強調など）に知らせる
function render(container, lay, { onHover } = {}) {
  container.innerHTML = svgMarkup(lay);
  const svg = container.querySelector('svg');
  const cross = svg.querySelector('.lb-cross');

  let tip = container.querySelector('.lb-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'lb-tip';
    tip.hidden = true;
    container.appendChild(tip);
  }

  const dots = [...svg.querySelectorAll('.lb-dot')];
  let current = -1;

  function show(i) {
    if (i === current) return;
    current = i;
    for (const d of dots) d.classList.toggle('active', Number(d.dataset.index) === i);
    const p = lay.points[i];
    if (!p || !p.plotted) {
      hide();
      return;
    }
    cross.setAttribute('x1', p.x.toFixed(1));
    cross.setAttribute('x2', p.x.toFixed(1));
    cross.hidden = false;

    tip.replaceChildren();
    const val = document.createElement('div');
    val.className = 'lb-tip-value';
    val.textContent = `Elo ${fmt(p.elo)}`;
    tip.appendChild(val);
    const name = document.createElement('div');
    name.className = 'lb-tip-name';
    name.textContent = p.title;
    tip.appendChild(name);
    const meta = document.createElement('div');
    meta.className = 'lb-tip-meta';
    const range = p.lo != null ? `90% 区間 ${fmt(p.lo)}–${fmt(p.hi)} ・ ` : '';
    meta.textContent = `${range}${p.games} 試合 ${p.w}-${p.d}-${p.l}`;
    tip.appendChild(meta);
    tip.hidden = false;

    // 右端では左に出す
    const flip = p.x > lay.width * 0.6;
    tip.style.left = flip ? '' : `${Math.round(p.x + 10)}px`;
    tip.style.right = flip ? `${Math.round(lay.width - p.x + 10)}px` : '';
    tip.style.top = `${Math.round(Math.max(0, p.y - 12))}px`;

    onHover?.(p.id);
  }

  function hide() {
    current = -1;
    cross.hidden = true;
    tip.hidden = true;
    for (const d of dots) d.classList.remove('active');
    onHover?.(null);
  }

  // 点そのものではなく X 位置で最寄りの点を選ぶ（2px の線を狙わせない）
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (lay.width / rect.width);
    let bestI = -1;
    let bestD = Infinity;
    lay.points.forEach((p, i) => {
      if (!p.plotted) return;
      const d = Math.abs(p.x - px);
      if (d < bestD) { bestD = d; bestI = i; }
    });
    if (bestI >= 0 && bestD <= Math.max(lay.plot.slot, 12)) show(bestI);
    else hide();
  });
  svg.addEventListener('pointerleave', hide);

  return { show, hide };
}

window.falArenaChart = { bootstrapBands, niceTicks, layout, svgMarkup, render, mulberry32 };

})();
