'use strict';

/* ==========================================================================
 * 端末間同期のマージ（ブラウザと Worker で共用）
 *
 * 以前の同期は、セクション（LoRA ライブラリなど）を 1 つの塊として
 * 「最後に変更した端末の内容で丸ごと置き換える」作りだった。そのため、
 * 古い一覧を持った端末で★を 1 つ付けるだけで、ほかの端末で入れた設定が
 * 消えていた（トリガーワードの自動挿入の設定で報告）。
 *
 * LoRA / チェックポイントのライブラリは、項目（path で識別）ごとに
 * 「最後に変更した時刻（updatedAt）」を持ち、**1 件ずつ新しい方を採る**。
 * 削除は「消した時刻」を墓標（deleted: { path: 時刻 }）として残し、
 * それより古い版が別の端末から届いても生き返らないようにする。
 *
 * 比較アリーナは中身が入れ子で項目単位に割れないので、これまでどおり
 * セクション単位で新しい方を採る（ts の大きい方）。ただし、サーバーは
 * セクションごとに別々にマージするので、ほかのセクションの巻き添えには
 * ならない。
 *
 * ■ 移行（updatedAt を持たない項目）
 * 既存の項目にはいつ変更されたかの記録が無い。これらは時刻 0 として扱い、
 * 同時刻（0 同士など）のときは次の規則で決める:
 *   - サーバーのセクションがまだ新形式（v: 2）でなければ、送ってきた側を採る
 *   - 新形式になっていれば、サーバー側を採る
 * つまり**移行後に最初に同期した端末の内容**が基準になり、そのあと古い一覧を
 * 持った端末が同期しても上書きしない。
 *
 * ブラウザでは window.falSyncMerge、Worker では import して globalThis から使う。
 * ========================================================================== */

(() => {

// 項目単位でマージするセクションと、項目を識別するキー
const ITEM_KEYS = { loras: 'path', ckpts: 'path', endpoints: 'key' };

// 墓標はこれより古くなったら捨てる（ずっと持つと増え続けるため）。
// これより長く同期していなかった端末から届いた古い版は生き返りうるが、実害は小さい
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const isItemSection = (name) => Object.hasOwn(ITEM_KEYS, name);

function parseItems(value) {
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const timeOf = (item) => (Number.isFinite(item?.updatedAt) ? item.updatedAt : 0);

// キーの順番に左右されない JSON（端末ごとにプロパティの並びが違っても同じ文字列になる）
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// 「中身が変わったか」の判定用。updatedAt 自体は比べない
function contentOf(item) {
  const { updatedAt: _ignored, ...rest } = item ?? {};
  return stableStringify(rest);
}

/**
 * 項目単位のマージ。
 * @param {{items: object[], deleted: Record<string, number>}} a  優先側（同時刻なら preferA で決める）
 * @param {{items: object[], deleted: Record<string, number>}} b
 * @param {string} key 項目を識別するプロパティ名
 * @param {{preferA?: boolean, now?: number}} opts
 * @returns {{items: object[], deleted: Record<string, number>}}
 *   items の並びは a の順、そのあとに b にしか無いものを b の順で
 */
function mergeItems(a, b, key, { preferA = true, now = Date.now() } = {}) {
  const mapA = new Map();
  const mapB = new Map();
  for (const item of a.items ?? []) if (typeof item?.[key] === 'string') mapA.set(item[key], item);
  for (const item of b.items ?? []) if (typeof item?.[key] === 'string') mapB.set(item[key], item);
  const delA = a.deleted ?? {};
  const delB = b.deleted ?? {};

  const order = [...mapA.keys(), ...[...mapB.keys()].filter((k) => !mapA.has(k))];
  const items = [];
  const deleted = {};

  for (const k of order) {
    const ia = mapA.get(k);
    const ib = mapB.get(k);
    let pick;
    if (ia && ib) {
      const ta = timeOf(ia);
      const tb = timeOf(ib);
      pick = ta > tb || (ta === tb && preferA) ? ia : ib;
    } else {
      pick = ia ?? ib;
    }
    const tomb = Math.max(delA[k] ?? 0, delB[k] ?? 0);
    if (tomb > 0 && tomb >= timeOf(pick)) continue; // 消したあとに変更されていないなら消えたまま
    items.push(pick);
  }

  // 墓標は、生き残った項目より新しいものだけ残す（期限切れは捨てる）
  const alive = new Set(items.map((item) => item[key]));
  for (const src of [delA, delB]) {
    for (const [k, t] of Object.entries(src)) {
      if (!Number.isFinite(t) || alive.has(k) || now - t > TOMBSTONE_TTL_MS) continue;
      deleted[k] = Math.max(deleted[k] ?? 0, t);
    }
  }
  return { items, deleted };
}

/**
 * 同期ドキュメントの 1 セクションをマージする。
 * セクションの形は { value: string, ts: number, deleted?: object, v?: 2 }。
 * @param {string} name セクション名
 * @param {object|undefined} primary 優先側（同時刻のとき primaryWinsTie で決める）
 * @param {object|undefined} secondary
 * @param {{primaryWinsTie?: boolean, now?: number}} opts
 */
function mergeSection(name, primary, secondary, { primaryWinsTie = true, now = Date.now() } = {}) {
  if (!primary) return secondary;
  if (!secondary) return isItemSection(name) ? normalizeSection(name, primary) : primary;

  if (!isItemSection(name)) {
    const tp = primary.ts || 0;
    const ts = secondary.ts || 0;
    return tp > ts || (tp === ts && primaryWinsTie) ? primary : secondary;
  }

  const merged = mergeItems(
    { items: parseItems(primary.value), deleted: primary.deleted },
    { items: parseItems(secondary.value), deleted: secondary.deleted },
    ITEM_KEYS[name],
    { preferA: primaryWinsTie, now },
  );
  return {
    value: JSON.stringify(merged.items),
    ts: Math.max(primary.ts || 0, secondary.ts || 0),
    deleted: merged.deleted,
    v: 2,
  };
}

function normalizeSection(name, section) {
  return {
    value: section.value ?? '',
    ts: section.ts || 0,
    deleted: section.deleted ?? {},
    v: 2,
  };
}

/**
 * サーバーでのマージ。届いたもの（incoming）と保存済み（stored）をセクションごとに合わせる。
 * 項目単位のセクションは、保存済みがまだ新形式でなければ届いた側を、
 * 新形式なら保存済み側を同時刻で優先する（上の「移行」を参照）。
 * 比較アリーナなどは従来どおり、同時刻なら届いた側。
 */
function mergeDocs(stored, incoming, { now = Date.now() } = {}) {
  const out = {};
  const names = new Set([...Object.keys(stored ?? {}), ...Object.keys(incoming ?? {})]);
  for (const name of names) {
    const s = stored?.[name];
    const i = incoming?.[name];
    out[name] = isItemSection(name)
      ? mergeSection(name, i, s, { primaryWinsTie: !(s?.v >= 2), now })
      : mergeSection(name, i, s, { primaryWinsTie: true, now });
  }
  return out;
}

// 2 つのセクションが同じ内容か（並びやプロパティ順の違いは無視する）
function sameSection(name, x, y) {
  if (!x || !y) return !x && !y;
  if (!isItemSection(name)) return (x.value ?? '') === (y.value ?? '') && (x.ts || 0) === (y.ts || 0);
  const key = ITEM_KEYS[name];
  const canon = (s) => stableStringify(
    parseItems(s.value).slice().sort((p, q) => String(p?.[key]).localeCompare(String(q?.[key]))),
  );
  return canon(x) === canon(y) && stableStringify(x.deleted ?? {}) === stableStringify(y.deleted ?? {});
}

const api = {
  ITEM_KEYS,
  isItemSection,
  parseItems,
  contentOf,
  mergeItems,
  mergeSection,
  mergeDocs,
  sameSection,
};

globalThis.falSyncMerge = api;

})();
