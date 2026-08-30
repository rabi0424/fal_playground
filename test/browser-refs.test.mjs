// ブラウザ用スクリプトの「呼んでいるのに定義が無い関数」の検出:
//   node test/browser-refs.test.mjs
//
// これらの画面は Node のテストからそのままは動かせないので、読み込み時に落ちる類の
// 間違いがテストをすり抜ける。実際、統計まわりを書き換えたときに renderSweepStats を
// 巻き込んで消してしまい、openStats がそれを呼び続けて「統計ボタンを押しても
// 何も開かない」状態になった（例外で showModal に到達しない）。
//
// 構文解析まではせず、コメント・文字列・正規表現リテラルを落としたうえで
// 「name( の形で呼ばれていて、そのファイルにもほかのスクリプトの window.* にも
// 定義が無いもの」を挙げる。取りこぼしはあるが、消し忘れの検出には足りる。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const at = (name) => new URL(`../${name}`, import.meta.url);

const FILES = ['app.js','edit.js','imgedit.js','arena.js','library.js','store.js','gallery-pager.js',
  'history-feed.js','image-upload.js','device-sync.js','hf-import.js','civitai-import.js',
  'lora-library.js','runware-lora.js','shell.js'];

// ほかのスクリプトが window に置くもの
const shared = new Set();
for (const f of FILES) {
  for (const m of readFileSync(at(f),'utf8').matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) shared.add(m[1]);
}

const KEYWORDS = new Set(['if','for','while','switch','catch','return','typeof','new','await','of','in','do','else','function','class','delete','void','yield','case','throw','try','instanceof','async']);
// Node には無いがブラウザにはあるもの
const BROWSER = new Set(['Image','FileReader','IntersectionObserver','ResizeObserver','DOMParser',
  'getSelection','getComputedStyle','confirm','alert','matchMedia','requestAnimationFrame',
  'FormData','FileList','DataTransfer','OffscreenCanvas','createImageBitmap','indexedDB']);

// コメントと引用符つきの文字列を落とす（説明文の中の name( を拾わないため）。
// テンプレートリテラルは ${...} に本物の呼び出しが入るので残す
const strip = (code) => code
  // ブロックコメント → 文字列 → 正規表現 → 行コメント の順。順番が要る:
  // 行コメントを先に落とすと、/\/api\/image\// のような正規表現の中の // を
  // コメントの始まりと見て行末まで消してしまう
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
  .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
  // 正規表現リテラル。除算と紛れないよう、直前が演算子・括弧・return のときだけ
  .replace(/([=(,:[!&|?{;]|\breturn)(\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuyd]*/g,
    (all, before, space) => `${before}${space}RE`)
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failed = 0;
let checked = 0;

for (const f of FILES) {
  const src = strip(readFileSync(at(f), 'utf8'));
  const defined = new Set(shared);
  // 宣言
  for (const m of src.matchAll(/\b(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  // 分割代入・引数っぽいもの（誤検出を減らすため広めに拾う）
  for (const m of src.matchAll(/[({,[]\s*([A-Za-z_$][\w$]*)\s*(?=[,)}\]=:])/g)) defined.add(m[1]);
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) defined.add(m[1]);
  // オブジェクトのメソッド定義 name(...) {
  for (const m of src.matchAll(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) defined.add(m[1]);

  const missing = new Map();
  for (const m of src.matchAll(/(?<![.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const n = m[1];
    if (defined.has(n) || KEYWORDS.has(n) || BROWSER.has(n) || n in globalThis) continue;
    missing.set(n, (missing.get(n) ?? 0) + 1);
  }
  if (missing.size > 0) {
    failed += 1;
    console.error(`✗ ${f}: 定義の無い呼び出し ${[...missing.keys()].join(', ')}`);
  } else {
    checked += 1;
  }
}

console.log(failed === 0
  ? `ok: ${checked} files checked`
  : `\n${failed} 件のファイルに定義の無い呼び出しがあります`);
process.exit(failed === 0 ? 0 : 1);
