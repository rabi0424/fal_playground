/*
 * 外観（配色とアクセント色）の切り替え。3画面で共通。
 *
 * 以前は同じテーマ切替が app.js / arena.js / edit.js に3つ書かれていた
 * （コメントにも「app.js と同じ」とあった）。アクセント色を足すと同じ
 * 重複がもう一組増えるため、ここへ集約した。
 *
 * DOM の約束:
 *   data-theme  = 利用者の選択（auto / light / dark）。ボタンの表示に使う
 *   data-scheme = 実際に描く配色（light / dark）。CSS はこちらだけを見る
 *   data-accent = アクセント色のID
 *
 * 初期値は各ページの <head> のインラインスクリプトが描画前に入れている
 * （後から入れると、保存した設定と違う配色が一瞬見えてしまう）。
 * このファイルは、その続きとしてボタンの組み立てと切り替えを受け持つ。
 *
 * ビルド工程を持たない構成なので、モジュールではなく素のスクリプトとして
 * 読み込む（各ページで app.js などより先に置く）。
 */

(function () {

const LS_THEME = 'fal_theme';
const LS_ACCENT = 'fal_accent';

const THEME_LABELS = { auto: '自動', light: 'ライト', dark: 'ダーク' };
const THEME_ORDER = ['auto', 'light', 'dark'];

/** macOS のシステム設定と同じ並び。 */
const ACCENTS = [
  { id: 'blue', label: 'ブルー', swatch: '#007aff' },
  { id: 'cyan', label: 'シアン', swatch: '#32ade6' },
  { id: 'purple', label: 'パープル', swatch: '#af52de' },
  { id: 'pink', label: 'ピンク', swatch: '#ff2d55' },
  { id: 'red', label: 'レッド', swatch: '#ff3b30' },
  { id: 'orange', label: 'オレンジ', swatch: '#ff9500' },
  { id: 'yellow', label: 'イエロー', swatch: '#ffcc00' },
  { id: 'green', label: 'グリーン', swatch: '#34c759' },
  { id: 'graphite', label: 'グラファイト', swatch: '#8e8e93' },
];

const DEFAULT_ACCENT = 'blue';

const root = document.documentElement;
const media = window.matchMedia('(prefers-color-scheme: dark)');

/** 選択（auto を含む）から、実際に描く配色を決めて反映する。 */
function applyScheme() {
  const choice = root.dataset.theme || 'auto';
  const dark = choice === 'dark' || (choice === 'auto' && media.matches);
  root.dataset.scheme = dark ? 'dark' : 'light';
}

function applyTheme(theme, btn) {
  root.dataset.theme = theme;
  applyScheme();
  if (btn) btn.textContent = THEME_LABELS[theme];
}

function applyAccent(id) {
  root.dataset.accent = id;
}

/**
 * アクセント色のピッカー。押すと色見本を並べたポップオーバーが開く。
 * 文字を持たないボタンなので、現在の色そのものを見本として出す。
 */
function buildAccentPicker(btn) {
  const pop = document.createElement('div');
  pop.className = 'accent-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'listbox');
  pop.setAttribute('aria-label', 'アクセントカラー');

  const swatches = ACCENTS.map((a) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'accent-swatch';
    sw.style.setProperty('--swatch', a.swatch);
    sw.title = a.label;
    sw.setAttribute('role', 'option');
    sw.setAttribute('aria-label', a.label);
    sw.addEventListener('click', () => {
      applyAccent(a.id);
      try {
        localStorage.setItem(LS_ACCENT, a.id);
      } catch {
        /* 保存できなくても切り替え自体は効く */
      }
      mark();
      close();
    });
    pop.appendChild(sw);
    return { id: a.id, el: sw };
  });

  const mark = () => {
    const current = root.dataset.accent || DEFAULT_ACCENT;
    for (const s of swatches) {
      const on = s.id === current;
      s.el.classList.toggle('is-selected', on);
      s.el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  };

  const close = () => {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };

  const onOutside = (e) => {
    if (!pop.contains(e.target) && e.target !== btn) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      btn.focus();
    }
  };

  btn.addEventListener('click', () => {
    if (pop.hidden) {
      mark();
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      // 開いた直後の同じクリックで閉じないよう、次のフレームから見張る
      requestAnimationFrame(() => {
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
      });
    } else {
      close();
    }
  });

  btn.setAttribute('aria-expanded', 'false');
  btn.insertAdjacentElement('afterend', pop);
  mark();
}

function initAppearance() {
  const themeBtn = document.querySelector('#themeBtn');
  const accentBtn = document.querySelector('#accentBtn');

  // 描画前のインラインスクリプトが入れた値をそのまま引き継ぐ
  applyTheme(root.dataset.theme || 'auto', themeBtn);

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const next =
        THEME_ORDER[(THEME_ORDER.indexOf(root.dataset.theme) + 1) % THEME_ORDER.length];
      try {
        localStorage.setItem(LS_THEME, next);
      } catch {
        /* 保存できなくても切り替え自体は効く */
      }
      applyTheme(next, themeBtn);
    });
  }

  if (accentBtn) buildAccentPicker(accentBtn);

  // auto のときだけ、OS の設定変更に追従する
  media.addEventListener('change', () => {
    if ((root.dataset.theme || 'auto') === 'auto') applyScheme();
  });
}

initAppearance();

})();
