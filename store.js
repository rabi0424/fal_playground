/*
  localStorage への書き込みを、ここ 1 か所にまとめる。

  localStorage はブラウザごとに 5MB 前後で頭打ちになり、超えると
  QuotaExceededError（Safari の文言は "The quota has been exceeded."）を投げる。
  素の setItem をそのまま呼んでいたので、いっぱいになった端末では

    - 生成の途中（送信済みジョブの控えを書くところ）で例外が飛び、走っている
      ジョブがエラー扱いになって落ちる。fal 側では成功しているのに結果を
      取り逃がし、画面には英語のまま "The quota has been exceeded." が出る
    - 入力のたびに走る下書き保存が、未処理の例外を投げ続ける

  という壊れ方をしていた。保存できないこと自体は困らない（サーバーにあるもの、
  次に開けば取り直せるものばかり）ので、ここを通した書き込みは例外を投げない。

  書けなかったときは、捨ててよいキャッシュを落として一度だけ書き直す。
  それでも駄目なら false を返すので、失って困るものだけを呼び出し側で伝える。
*/
(function () {
  'use strict';

  // 容量が足りないときに落としてよいキー。消えても次に開けば取り直せる
  // ものだけを、諦めのつく順に並べる
  const DISPOSABLE = ['fal_history'];

  // 名前は Chrome / Firefox / Safari で揃っていないので、番号も見る
  function isQuotaError(err) {
    return err instanceof DOMException
      && (err.name === 'QuotaExceededError'
        || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || err.code === 22 || err.code === 1014);
  }

  // true = 書けた / false = 書けないので諦める / null = 空ければ入るかもしれない
  function write(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (err) {
      return isQuotaError(err) ? null : false;
    }
  }

  window.falStore = {
    /** 保存する。書けたら true。容量あふれ・ストレージ無効などでは false */
    set(key, value) {
      const first = write(key, value);
      if (first !== null) return first;
      for (const victim of DISPOSABLE) {
        if (victim === key) continue;
        try {
          if (localStorage.getItem(victim) === null) continue;
          localStorage.removeItem(victim);
        } catch {
          return false; // 読み書きごと使えない環境
        }
        const retry = write(key, value);
        if (retry !== null) return retry;
      }
      return false;
    },

    /** 読み出す。使えない環境では null（呼び出し側は既定値にフォールバックする） */
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },

    /**
     * 失うと困るもの（ライブラリへの登録など）を保存する。
     * 書けなかったときは、何が起きたのか分かる文言で投げる
     */
    setOrThrow(key, value) {
      if (this.set(key, value)) return;
      throw new Error('この端末の保存領域がいっぱいで、保存できませんでした。'
        + 'ブラウザの設定でこのサイトのデータを空けてから、もう一度お試しください。');
    },

    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        // 消せなくても支障はない
      }
    },
  };

  /* ---------- 古い HTML を掴んでいないかの確認 ---------- */
  //
  // _headers で HTML にもキャッシュの猶予を持たせているので、デプロイ後しばらくは
  // 前の版の HTML が出る（ホーム画面に追加したアプリだと長く持ち続けることがある）。
  // あとから足した共有スクリプトは、古い HTML には script タグごと無いため、
  // それを使うところだけが黙って壊れる（履歴が表示キャッシュのぶんしか出ない、
  // 画像を保存できない、など）。原因が画面から見えないのが厄介なので、
  // 「読めているはずのものが無い」を検出して 1 度だけ読み直す。
  //
  // これを store.js に置いてあるのは、どの画面の HTML にも最初期から入っていて、
  // 古い HTML でも必ず読まれるからで、新しいファイルに置くと意味がない。
  const RELOAD_ONCE_KEY = 'fal_stale_reload';

  function requireShared(names) {
    const missing = names.filter((name) => !window[name]);
    if (missing.length === 0) {
      // 無事だったので、読み直しの印と URL の細工を片付ける
      try {
        sessionStorage.removeItem(RELOAD_ONCE_KEY);
      } catch {
        // 使えない環境。消せなくても支障はない
      }
      if (location.search.startsWith('?r=')) {
        history.replaceState(null, '', location.pathname + location.hash);
      }
      return true;
    }

    let already = '1'; // sessionStorage が使えない環境では読み直しに頼らない
    try {
      already = sessionStorage.getItem(RELOAD_ONCE_KEY);
      sessionStorage.setItem(RELOAD_ONCE_KEY, '1');
    } catch {
      // プライベートモードなど
    }
    if (!already) {
      // 同じ URL の再読み込みでは古い HTML がそのまま出ることがあるので、
      // 問い合わせを変えてキャッシュを迂回する
      location.replace(`${location.pathname}?r=${Date.now()}${location.hash}`);
      return false;
    }
    console.error(`共有スクリプトが読めていません: ${missing.join(', ')}`);
    return false;
  }

  window.falBoot = { requireShared };
})();
