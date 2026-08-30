'use strict';

/* ==========================================================================
 * 画像のアップロード（共有コンポーネント）
 *
 * R2 のキーは中身の sha256（内容アドレス）なので、同じ画像は同じキーに収まる。
 * そこで送る前に「持っているか」を聞き、持っていれば本文を送らない。
 *
 *   1) POST /api/upload { hash }          → { url } なら送らずに済む
 *   2) 無かったときだけ { image, meta }    → キーはサーバーが計算し直す
 *
 * 同じ写真を選び直したとき、下書きから復元したとき、塗り直しで同じ合成結果に
 * なったときに効く。とくに部分AI編集は原本バイトをそのまま上げるので、
 * 端末をまたいでも一致する。
 *
 *   const url = await falUpload.put(dataUri, meta);
 * ========================================================================== */

(() => {

const isHtml = (res) => (res.headers.get('Content-Type') ?? '').includes('text/html');

async function post(body) {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (isHtml(res)) throw new Error('画像の保存に失敗しました（ログインし直してください）');
  if (!res.ok) {
    const err = new Error(`画像の保存に失敗しました（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// data URI のバイト列。base64 を自前で解かず fetch に任せる（速いうえに短い）
const bytesOf = async (dataUri) => new Uint8Array(await (await fetch(dataUri)).arrayBuffer());

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {string} dataUri 送る画像
 * @param {object|null} meta PNG に焼き込む生成設定（JPEG のときは無視される）
 * @returns {Promise<string>} /api/image/<sha256>
 */
async function put(dataUri, meta = null) {
  let bytes = null;
  try {
    bytes = await bytesOf(dataUri);
    const found = await post({ hash: await sha256Hex(bytes) });
    if (found.url) return found.url; // 送らずに済んだ
  } catch {
    // 問い合わせに失敗しても、本文を送れば済む話なので握りつぶす
    // （crypto.subtle が無い・一時的な通信断など）
  }
  try {
    return (await post({ image: dataUri, ...(meta ? { meta } : {}) })).url;
  } catch (err) {
    // 大きすぎて弾かれたときは、どれくらいだったのかが分かる文言にする
    if (err.status === 413 && bytes) {
      const mb = (bytes.length / 1024 / 1024).toFixed(1);
      throw new Error(`画像の保存に失敗しました（${mb}MB・大きすぎます）`);
    }
    throw err;
  }
}

window.falUpload = { put, sha256Hex };

})();
