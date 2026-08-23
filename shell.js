/*
  全画面共通のシェル（左サイドバー + ページバー）。

  以前は各 HTML が同じ <header class="topbar"> を手書きし、テーマ切替のコードも
  5 つの JS に丸ごと重複していた。項目を 1 つ足すだけで 5 ファイルを直す必要があり、
  実際にズレていたので、ナビゲーションとテーマはこのファイルだけが持つ。

  HTML 側に必要なのは次の 3 つだけ:
    - <html> に data-theme / data-sidebar（<head> のインラインスクリプトが先に置く）
    - <div class="shell"> … <aside id="appSidebar"> と <div class="shell-body"> … </div>
    - このファイルの読み込み（各ページの JS より前）
*/
(function () {
  'use strict';

  const LS_THEME = 'fal_theme';
  const LS_SIDEBAR = 'fal_sidebar';
  /* サイドバーが常設からドロワーに変わる幅。1 カラム化の 900px に合わせる */
  const DRAWER_MQ = window.matchMedia('(max-width: 900px)');

  /* ---------- アイコン ---------- */

  const ICONS = {
    sparkles:
      '<path d="M11 3.5 12.8 8.2 17.5 10 12.8 11.8 11 16.5 9.2 11.8 4.5 10 9.2 8.2Z"/>' +
      '<path d="M18 14.5 18.8 16.7 21 17.5 18.8 18.3 18 20.5 17.2 18.3 15 17.5 17.2 16.7Z"/>',
    pencil:
      '<path d="M4 20h4L19.5 8.5a2.83 2.83 0 0 0-4-4L4 16Z"/><path d="m14.5 6 3.5 3.5"/>',
    crop:
      '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/>',
    compare:
      '<rect x="3" y="4.5" width="7.5" height="15" rx="1.5"/>' +
      '<rect x="13.5" y="4.5" width="7.5" height="15" rx="1.5"/>',
    layers:
      '<path d="M12 3 21 7.5 12 12 3 7.5Z"/><path d="m3 12.5 9 4.5 9-4.5"/>' +
      '<path d="m3 16.75 9 4.5 9-4.5"/>',
    chart: '<path d="M5 20v-8"/><path d="M12 20V4"/><path d="M19 20v-5"/>',
    panel: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
    close: '<path d="m6 6 12 12"/><path d="M18 6 6 18"/>',
    sun:
      '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2"/><path d="M12 19.5v2"/>' +
      '<path d="m4.6 4.6 1.4 1.4"/><path d="m18 18 1.4 1.4"/><path d="M2.5 12h2"/>' +
      '<path d="M19.5 12h2"/><path d="m4.6 19.4 1.4-1.4"/><path d="m18 6 1.4-1.4"/>',
    moon: '<path d="M20 14.6A8.5 8.5 0 0 1 9.4 4 8.5 8.5 0 1 0 20 14.6Z"/>',
    /* 自動 = 半分だけ塗った円。ライト/ダークの中間であることを形で示す */
    auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none"/>',
  };

  function icon(name) {
    return (
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      ICONS[name] +
      '</svg>'
    );
  }

  /* ---------- ページ ---------- */

  const NAV = [
    {
      file: 'index.html',
      href: './',
      label: '生成',
      icon: 'sparkles',
      hint: 'プロンプトから画像を生成する',
    },
    {
      file: 'imgedit.html',
      href: 'imgedit.html',
      label: '画像編集',
      icon: 'pencil',
      hint: '画像 1 枚を指示文で編集する（Qwen Image Edit + LoRA / FLUX.1 Fill の修復）',
    },
    {
      file: 'edit.html',
      href: 'edit.html',
      label: '部分AI編集',
      icon: 'crop',
      hint: '画像の一部を選択して Poe の画像編集ボットで編集し、元画像にはめ込む',
    },
    {
      file: 'arena.html',
      href: 'arena.html',
      label: '比較アリーナ',
      icon: 'compare',
      hint: 'LoRA チェックポイントの匿名比較と Elo ランキング',
    },
    {
      file: 'library.html',
      href: 'library.html',
      label: 'LoRA ライブラリ',
      icon: 'layers',
      hint: '表示名・トリガーワード・既定 scale をまとめて編集する',
    },
  ];

  const THEMES = [
    { value: 'auto', label: '自動', icon: 'auto' },
    { value: 'light', label: 'ライト', icon: 'sun' },
    { value: 'dark', label: 'ダーク', icon: 'moon' },
  ];

  function currentFile() {
    const last = location.pathname.split('/').pop();
    return last === '' ? 'index.html' : last;
  }

  const here = currentFile();
  const isIndex = here === 'index.html';
  const current = NAV.find((n) => n.file === here) || NAV[0];

  /* ---------- 組み立て ---------- */

  const root = document.documentElement;
  /* 画面ごとの微調整（見出しの最大幅など）は CSS 側で data-page を見る */
  root.dataset.page = current.file;
  const sidebar = document.getElementById('appSidebar');
  const body = document.querySelector('.shell-body');
  if (!sidebar || !body) return;
  /* 引き出しを開いたときの移動先。タブ順には入れない */
  sidebar.tabIndex = -1;

  function navItem(n) {
    const active = n.file === here;
    return (
      `<a class="nav-item${active ? ' active' : ''}" href="${n.href}"` +
      `${active ? ' aria-current="page"' : ''} title="${n.hint}" data-label="${n.label}">` +
      icon(n.icon) +
      `<span class="nav-label">${n.label}</span></a>`
    );
  }

  sidebar.innerHTML =
    '<div class="sidebar-head">' +
    '<a class="sidebar-brand" href="./">fal <span>playground</span></a>' +
    '<button type="button" class="sidebar-btn" id="sidebarToggle" aria-controls="appSidebar">' +
    icon('panel') +
    '</button>' +
    '<button type="button" class="sidebar-btn drawer-only" id="sidebarClose" aria-label="サイドバーを閉じる">' +
    icon('close') +
    '</button>' +
    '</div>' +
    `<nav class="sidebar-nav" aria-label="ツール">${NAV.map(navItem).join('')}</nav>` +
    '<div class="sidebar-foot">' +
    `<${isIndex ? 'button type="button"' : 'a href="./#stats"'} class="nav-item" id="statsNav" ` +
    'title="アクセスポイント別の生成所要時間の統計" data-label="統計">' +
    icon('chart') +
    `<span class="nav-label">統計</span></${isIndex ? 'button' : 'a'}>` +
    '<div class="theme-seg" role="group" aria-label="テーマ">' +
    THEMES.map(
      (t) =>
        `<button type="button" class="theme-btn" data-theme-value="${t.value}" ` +
        `title="${t.label}" aria-label="${t.label}">${icon(t.icon)}` +
        `<span class="theme-label">${t.label}</span></button>`,
    ).join('') +
    '</div>' +
    '</div>';

  /* ページバー: モバイルではハンバーガー付きの固定バー、PC では見出しだけ */
  const pagebar = document.createElement('header');
  pagebar.className = 'pagebar';
  pagebar.innerHTML =
    '<button type="button" class="pagebar-menu" id="drawerOpen" aria-controls="appSidebar" ' +
    'aria-expanded="false" aria-label="サイドバーを開く">' +
    icon('menu') +
    '</button>' +
    `<h1 class="pagebar-title">${current.label}</h1>`;
  body.prepend(pagebar);

  const scrim = document.createElement('div');
  scrim.className = 'shell-scrim';
  scrim.hidden = true;
  document.querySelector('.shell').appendChild(scrim);

  /* ---------- テーマ ---------- */

  function applyTheme(theme) {
    root.dataset.theme = theme;
    for (const btn of sidebar.querySelectorAll('.theme-btn')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.themeValue === theme));
    }
  }

  applyTheme(root.dataset.theme || 'auto');
  for (const btn of sidebar.querySelectorAll('.theme-btn')) {
    btn.addEventListener('click', () => {
      try {
        localStorage.setItem(LS_THEME, btn.dataset.themeValue);
      } catch { /* プライベートブラウズなどで書けなくても切替自体は効かせる */ }
      applyTheme(btn.dataset.themeValue);
    });
  }

  /* ---------- 開閉 ---------- */

  function setCollapsed(collapsed) {
    root.dataset.sidebar = collapsed ? 'rail' : 'open';
    try {
      localStorage.setItem(LS_SIDEBAR, root.dataset.sidebar);
    } catch { /* 保存できなくても今のセッションでは効く */ }
    syncToggle();
  }

  function syncToggle() {
    const collapsed = root.dataset.sidebar === 'rail';
    const btn = document.getElementById('sidebarToggle');
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = collapsed ? 'サイドバーを開く（⌘/Ctrl + B）' : 'サイドバーを畳む（⌘/Ctrl + B）';
    btn.setAttribute('aria-label', btn.title);
  }

  syncToggle();
  document.getElementById('sidebarToggle').addEventListener('click', () => {
    if (DRAWER_MQ.matches) closeDrawer();
    else setCollapsed(root.dataset.sidebar !== 'rail');
  });

  /* ---------- ドロワー（900px 以下） ---------- */

  let lastFocus = null;

  function openDrawer() {
    if (root.dataset.drawer === 'open') return;
    lastFocus = document.activeElement;
    root.dataset.drawer = 'open';
    scrim.hidden = false;
    document.getElementById('drawerOpen').setAttribute('aria-expanded', 'true');
    /* 背後のページはスクロールさせない */
    document.body.style.overflow = 'hidden';
    /* フォーカスは引き出し本体へ移す。項目に当てるとリングが出て、
       現在地のハイライトと見分けがつかなくなる */
    sidebar.focus({ preventScroll: true });
  }

  function closeDrawer() {
    if (root.dataset.drawer !== 'open') return;
    delete root.dataset.drawer;
    scrim.hidden = true;
    document.getElementById('drawerOpen').setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  document.getElementById('drawerOpen').addEventListener('click', openDrawer);
  document.getElementById('sidebarClose').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  /* リンクで移動するときは畳んでおく（戻ってきたときに開いたままにしない） */
  sidebar.addEventListener('click', (e) => {
    if (e.target.closest('a')) closeDrawer();
  });
  DRAWER_MQ.addEventListener('change', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.dataset.drawer === 'open') {
      e.stopPropagation();
      closeDrawer();
      return;
    }
    /* 入力中は横取りしない（⌘+B は太字などに割り当てられていることがある） */
    if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
      const t = e.target;
      const typing =
        t instanceof HTMLElement &&
        (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
      if (typing) return;
      e.preventDefault();
      if (DRAWER_MQ.matches) {
        if (root.dataset.drawer === 'open') closeDrawer();
        else openDrawer();
      } else {
        setCollapsed(root.dataset.sidebar !== 'rail');
      }
    }
  });

  /* ドロワーの外へフォーカスが出ないようにする（開いている間だけ） */
  document.addEventListener('focusin', (e) => {
    if (root.dataset.drawer !== 'open') return;
    if (sidebar.contains(e.target)) return;
    sidebar.focus({ preventScroll: true });
  });

  /* 左端からの払いで開く / 開いているときは左向きの払いで閉じる。
     右端はブラウザの「進む」と衝突するので使わない */
  let swipe = null;
  document.addEventListener(
    'touchstart',
    (e) => {
      if (!DRAWER_MQ.matches) return;
      const t = e.touches[0];
      if (!t) return;
      swipe = { x: t.clientX, y: t.clientY, fromEdge: t.clientX <= 28 };
    },
    { passive: true },
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!swipe) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - swipe.x;
      const dy = t.clientY - swipe.y;
      /* 縦に動き始めたらスクロールとみなして判定をやめる */
      if (Math.abs(dy) > 16 && Math.abs(dy) > Math.abs(dx)) {
        swipe = null;
        return;
      }
      const open = root.dataset.drawer === 'open';
      if (!open && swipe.fromEdge && dx > 50) {
        openDrawer();
        swipe = null;
      } else if (open && dx < -50) {
        closeDrawer();
        swipe = null;
      }
    },
    { passive: true },
  );
  for (const ev of ['touchend', 'touchcancel']) {
    document.addEventListener(ev, () => { swipe = null; }, { passive: true });
  }

  /* ---------- 貼り付く要素のためのオフセット ---------- */

  /* ページバーは幅の狭いときだけ固定される。その実高さ（Dynamic Island ぶんを含む）を
     公開して、ライブラリのツールバーなど「その下に貼り付く」要素が使えるようにする */
  function syncTop() {
    const h = DRAWER_MQ.matches ? pagebar.offsetHeight : 0;
    root.style.setProperty('--shell-top', `${h}px`);
  }
  syncTop();
  window.addEventListener('resize', syncTop);
  DRAWER_MQ.addEventListener('change', syncTop);
})();
