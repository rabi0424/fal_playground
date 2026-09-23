'use strict';

/* ==========================================================================
 * LoRA ライブラリ（共有）
 *
 * 登録済み LoRA の保存先（localStorage の 'fal_lora_library'）と、表示名・
 * トリガーワード・既定 scale・ベースモデルの扱いをまとめる。生成画面・画像編集・
 * ライブラリ管理・比較アリーナのすべてがここを通す。
 *
 * レコードは { path, name } だけの古い形でも動く。path（ダウンロード URL）は
 * この LoRA の識別子で、生成時に Modal へ渡す指定も path から作るため書き換えない。
 * label はあくまで表示用。
 *
 * 保存のたびに端末間同期へ知らせる必要があるが、同期の実装はページごとに持って
 * いるので loraLib.onChange に登録してもらう。
 * ========================================================================== */

(() => {

const LS_LORAS = 'fal_lora_library';
const LS_BASE_MIGRATED = 'fal_lora_base_migrated';

let onChange = null;

function load() {
  try {
    return JSON.parse(falStore.get(LS_LORAS)) || [];
  } catch {
    return [];
  }
}

// 読むだけの問い合わせ（entry / sorted / forBase）用。**呼び出し側で書き換えないこと。**
//
// entry() は LoRA 行ごと・選択肢ごとに何度も呼ばれ、そのたびにライブラリ全体
// （100 件を超える）の JSON を parse し直していた。保存文字列が変わらない限り
// 同じ parse 結果を使い回す。書き換える側（register など）は従来どおり load() で
// 自分用の配列を取るので、ここを汚さない
let cachedRaw = null;
let cachedItems = [];
function view() {
  const raw = falStore.get(LS_LORAS);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cachedItems = JSON.parse(raw) || [];
    } catch {
      cachedItems = [];
    }
  }
  return cachedItems;
}

// 表示名の並べ替え。**localeCompare(…, 'ja', {…}) は呼ぶたびに照合器を作り直す**
// ので、100 件超の並べ替え（LoRA 行を足すたび・モデルを変えるたびに走る）が
// 実機で目に見えて重かった。照合器は 1 つ作って使い回す
const JA_COLLATOR = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const compareLabels = (a, b) => JA_COLLATOR.compare(a, b);

// 利用者が起こした登録・削除は、書けなかったことを黙って飲み込まない
// （消えたと気づけないまま使い続けることになる）。
// 自動移行のように諦めてよい書き込みだけ quiet で通す
function save(items, { quiet = false } = {}) {
  const json = JSON.stringify(items);
  if (quiet) falStore.set(LS_LORAS, json);
  else falStore.setOrThrow(LS_LORAS, json);
  onChange?.();
}

// URL 末尾のファイル名（.safetensors 抜き）。生成時に Modal へ渡す名前でもある
function fileName(path) {
  const seg = String(path).split('?')[0].split('/').filter(Boolean).pop() || path;
  try {
    return decodeURIComponent(seg).replace(/\.safetensors$/i, '');
  } catch {
    return seg.replace(/\.safetensors$/i, '');
  }
}

// Hugging Face の resolve / blob URL（modal_comfy がそのまま受け付ける形）。
// 判定は modal_comfy 側の HF_URL_RE に合わせてある
const HF_RESOLVE_RE = /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/(?:resolve|blob)\/[^/]+\/.+$/i;

// Modal 系 API（modal_comfy）へ渡す LoRA の識別子。
//
// あちらはファイル名でも HF の resolve URL でも受け取るが、ファイル名だけで渡すと
// Volume にあるものか、既定リポジトリ（tottie2215/temp_str）の直下にあるものしか
// 解決できない。別のリポジトリから取り込んだ LoRA や、サブフォルダに置かれた
// ファイルは「lora '...' not found in volume」の 404 になる。
// URL のまま渡せば Modal 側が初回リクエスト時に取り込めるので、URL を持つものは
// URL で渡す（「名前を直接入力…」で打たれた素の名前はそのまま名前で渡す）
function modalRef(path) {
  const s = String(path ?? '').trim();
  return HF_RESOLVE_RE.test(s) ? s : fileName(s);
}

function entry(path) {
  return view().find((item) => item.path === path) ?? null;
}

// 画面に出す名前。未設定なら取り込み時の自動名にフォールバックする
function label(path) {
  const item = entry(path);
  return item?.label?.trim() || item?.name || fileName(path);
}

function labelOf(item) {
  return item?.label?.trim() || item?.name || fileName(item?.path ?? '');
}

function defaultScale(path) {
  const scale = entry(path)?.scale;
  return Number.isFinite(scale) ? scale : 1;
}

function triggerWords(path) {
  return (entry(path)?.trigger || '').split(',').map((w) => w.trim()).filter(Boolean);
}

// Civitai のベースモデル表記はゆれるので（"Qwen"／"Qwen-Image"／"Krea 2"／
// "Wan Video 14B t2v" など）、使う側が判定しやすい大まかな種類に寄せる
function baseKind(base) {
  const s = String(base ?? '').toLowerCase();
  if (s === '') return null;
  // "qwen" に "wan" は含まれない（wen）ので、この順で取り違えは起きない
  if (s.includes('wan')) return 'wan';
  // **Qwen-Image 2.1 は Qwen-Image（20B）とは別アーキテクチャ**で、LoRA に
  // 互換は無い。"qwen" だけで見ると同じ枠に混ざって、効かない LoRA が候補に
  // 出てしまうので、先に 2.1 を判定する。
  // 2509 / 2511（Qwen-Image Edit の版）を 2.1 と読まないよう、"2" と "1" の
  // 前後に数字が続かないことまで見る
  if (s.includes('qwen') && /(?:^|[^\d])2[._-]?1(?:[^\d]|$)/.test(s)) return 'qwen21';
  if (s.includes('qwen')) return 'qwen';
  if (s.includes('krea')) return 'krea2';
  return 'other';
}

const BASE_LABELS = { qwen: 'Qwen', krea2: 'Krea 2', wan: 'Wan', qwen21: 'Qwen-Image 2.1', other: 'その他' };

// 画面に出すベースモデルの種類。**一覧を持つ場所をここ以外に作らないこと。**
// 以前 hf-import.js が独自に 3 つ固定で持っていて、Qwen-Image 2.1 を足したときに
// 候補から漏れ、<select> が黙って「指定しない」へ落ちてベースモデル無しで
// 登録される不具合になった。'other' は分類の受け皿で、選ばせるものではないので出さない
const BASE_KINDS = ['krea2', 'qwen', 'qwen21', 'wan'];

// 選択肢に selected を必ず含める。<select> は一致する option が無い値を
// 代入されると空へ落ちるので、補わないと既存の値が黙って消える。
// extras には「ライブラリで実際に使われている表記」を渡す想定
// （Civitai 由来の "Qwen-Image" のような、種類の代表名と違う文字列を残すため）
function baseChoices(selected, extras = []) {
  const out = [];
  for (const v of [...BASE_KINDS.map((k) => BASE_LABELS[k]), ...extras, selected]) {
    const label = String(v ?? '').trim();
    if (label !== '' && !out.includes(label)) out.push(label);
  }
  return out;
}

// 印（fav / hidden）の付け外し。false は持たせずキーごと消すので、
// 付けていないものは今までどおり項目が増えない
function setFlag(path, key, on) {
  const items = load();
  const item = items.find((i) => i.path === path);
  if (!item) return false;
  if (on) item[key] = true;
  else delete item[key];
  save(items); // 利用者の操作なので、書けなかったことは飲み込まない
  return !!on;
}

// 一括用。何件でも保存は 1 回（同期にも 1 回ぶんしか流れない）
function setFlagMany(paths, key, on) {
  const want = new Set(paths);
  const items = load();
  let changed = 0;
  for (const item of items) {
    if (!want.has(item.path) || !!item[key] === !!on) continue;
    if (on) item[key] = true;
    else delete item[key];
    changed++;
  }
  if (changed > 0) save(items);
  return changed;
}

// お気に入り（★）。付けたものは sorted() が先頭へ回すので、どの画面でも
// 候補の上に並ぶ。付け外しはライブラリ管理画面と各画面の LoRA 行から行う
function isFav(path) {
  return !!entry(path)?.fav;
}

const setFav = (path, on) => setFlag(path, 'fav', on);
const toggleFav = (path) => setFav(path, !isFav(path));

// トリガーワードの挿入位置。既定は末尾で、'head' を選んだものだけ冒頭に入る
// （構図や画風を決める語のように、先頭にあるほど効く指定のためのもの）
function triggerPlace(path) {
  return entry(path)?.triggerPlace === 'head' ? 'head' : 'end';
}

// その LoRA を行に選んだとき、トリガーワードを自動で入れるか
function triggerAuto(path) {
  return !!entry(path)?.triggerAuto;
}

// まだ入っていない語だけを place 側に足した本文を返す。足すものが無ければ null
//（＝呼ぶ側は何もしない）。プロンプト欄を持つ画面が同じ挙動になるよう、
// 文字列の組み立てはここに 1 つだけ置く
function insertTriggers(text, words, place = 'end') {
  const current = String(text ?? '');
  const lower = current.toLowerCase();
  const missing = (words ?? []).filter((w) => w && !lower.includes(String(w).toLowerCase()));
  if (missing.length === 0) return null;

  const add = missing.join(', ');
  if (current.trim() === '') return add;
  if (place === 'head') {
    // 先頭の区切り文字は食わせる（", , foo" にしない）
    return `${add}, ${current.replace(/^[\s,、]+/, '')}`;
  }
  return current + (/[,、]\s*$/.test(current) ? ' ' : ', ') + add;
}

// 非表示。**候補から外すだけ**で、レコードも付けた情報（表示名・トリガー
// ワード・既定 scale・メモ）もそのまま残る。使わなくなったチェックポイントを
// 削除せずに畳んでおくためのもので、戻すのはライブラリ管理画面の「非表示」から
function isHidden(path) {
  return !!entry(path)?.hidden;
}

const setHidden = (path, on) => setFlag(path, 'hidden', on);
const toggleHidden = (path) => setHidden(path, !isHidden(path));
const setHiddenMany = (paths, on) => setFlagMany(paths, 'hidden', on);

// ★ を先頭に、あとは表示名順（数字は数値として比較する）
function sorted(items = view()) {
  return [...items].sort((a, b) => {
    if (!!a.fav !== !!b.fav) return a.fav ? -1 : 1;
    return compareLabels(labelOf(a), labelOf(b));
  });
}

// そのモデルで使えるものだけ。want が null なら制限しない。
// 非表示にしたものは既定で外す（一覧に出すのはライブラリ管理画面だけ）
function forBase(want, { includeHidden = false } = {}) {
  const all = sorted().filter((item) => includeHidden || !item.hidden);
  return want ? all.filter((item) => baseKind(item.base) === want) : all;
}

function register(path, meta = null) {
  const items = load();
  if (!items.some((item) => item.path === path)) {
    items.push({
      name: fileName(path),
      path,
      addedAt: Date.now(),
      // 取り込み時に Civitai から分かっている情報はそのまま初期値にする
      // （あとで「情報を取得」を押さなくても、ベースモデルで絞り込める）
      ...(meta?.base ? { base: meta.base } : {}),
      ...(meta?.trigger ? { trigger: meta.trigger } : {}),
      ...(meta?.source ? { source: meta.source } : {}),
      ...(meta?.base || meta?.trigger ? { metaAt: Date.now() } : {}),
    });
    save(items);
  }
  return true;
}

function unregister(path) {
  save(load().filter((item) => item.path !== path));
}

/* ---------- 移行 ---------- */

function migrate() {
  const items = load();
  let changed = false;

  // 過去の Civitai 取り込みがサブフォルダのパスを %2F にエンコードした URL で
  // 登録していた不具合の補正。%2F だと HF 一括登録経由の URL と食い違い、
  // Modal 生成へ渡る LoRA 名が変わって効かなくなる
  for (const item of items) {
    if (/^https:\/\/huggingface\.co\/.*%2F/i.test(item.path)) {
      item.path = item.path.replace(/%2F/gi, '/');
      item.name = fileName(item.path);
      changed = true;
    }
  }

  // ベースモデルでの絞り込みを入れる前に登録された LoRA は、すべて Krea 2 用。
  // 一度だけ印を付ける（あとからライブラリ画面で直せる）。
  // 空のときは印を付けない。別端末から同期でデータが流れてくる前に印だけ消費すると、
  // 届いた LoRA がベースモデル無しのまま候補から消えてしまう
  if (items.length > 0 && !falStore.get(LS_BASE_MIGRATED)) {
    for (const item of items) {
      if (!item.base) {
        item.base = 'Krea 2';
        changed = true;
      }
    }
    falStore.set(LS_BASE_MIGRATED, String(Date.now()));
  }

  if (changed) save(items, { quiet: true }); // 移行は起動時に走る。ここで止めない
}

window.loraLib = {
  load,
  compareLabels,
  save,
  entry,
  fileName,
  modalRef,
  label,
  labelOf,
  defaultScale,
  triggerWords,
  triggerPlace,
  triggerAuto,
  insertTriggers,
  baseKind,
  baseLabel: (kind) => BASE_LABELS[kind] ?? kind,
  baseKinds: () => [...BASE_KINDS],
  baseChoices,
  sorted,
  forBase,
  isFav,
  setFav,
  toggleFav,
  isHidden,
  setHidden,
  toggleHidden,
  setHiddenMany,
  register,
  unregister,
  migrate,
  set onChange(fn) { onChange = fn; },
};

})();
