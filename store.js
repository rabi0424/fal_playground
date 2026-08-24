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
})();
