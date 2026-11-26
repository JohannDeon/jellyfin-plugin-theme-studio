/* Theme Studio client: injected into Jellyfin Web by the plugin.
 * - applies the user's theme (cached in localStorage to avoid a flash on reload)
 * - adds a palette button to the header that opens the theme panel (live preview)
 * - exposes window.ThemeStudio.mountAdmin() for the plugin's admin page
 */
(function () {
  'use strict';
  if (window.ThemeStudio) return;

  var script = document.currentScript;
  var BASE = (script && script.getAttribute('data-base')) || '';
  var CACHE_KEY = 'themestudio:css';
  var STYLE_ID = 'theme-studio-user';
  var DEFAULT_LINK_ID = 'theme-studio-default';

  var state = {
    userId: null,
    boot: null, // response of /ThemeStudio/Bootstrap
    engine: null, // engine.css text
    loading: null,
    previewing: false,
  };

  /* ------------------------------------------------------------------ CSS */

  function safeColor(v) {
    return typeof v === 'string' && /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch)\([0-9a-zA-Z.,%\s/-]+\))$/.test(v) ? v : null;
  }
  function safeFont(v) {
    return typeof v === 'string' && /^[\w\s,"'-]{1,200}$/.test(v) ? v : null;
  }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }

  function merge(base, over) {
    var out = {};
    var k;
    base = base || {};
    over = over || {};
    for (k in base) if (base[k] !== null && base[k] !== undefined) out[k] = base[k];
    for (k in over) if (over[k] !== null && over[k] !== undefined) out[k] = over[k];
    return out;
  }

  function hasAny(o) {
    if (!o) return false;
    for (var k in o) if (o[k] !== null && o[k] !== undefined) return true;
    return false;
  }

  function toRgb(c) {
    if (!c) return null;
    var m;
    if (c.charAt(0) === '#') {
      var h = c.slice(1);
      if (h.length === 3 || h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      if (h.length < 6) return null;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
    return m ? [1, 2, 3].map(function (k) { return clamp(Math.round(Number(m[k])), 0, 255); }) : null;
  }
  function triplet(v) { return v ? v.join(',') : null; }

  // Keep in sync with Themes/ThemeCssBuilder.cs
  function variables(t) {
    var out = '';
    function add(name, value) { if (value !== null && value !== undefined && value !== '') out += '--ts-' + name + ':' + value + ';'; }
    add('accent', safeColor(t.accent));
    add('bg', safeColor(t.background));
    add('surface', safeColor(t.surface));
    add('text', safeColor(t.text));
    add('text-2', safeColor(t.textSecondary));
    add('radius', isNum(t.radius) ? clamp(Math.round(t.radius), 0, 40) + 'px' : null);
    add('blur', isNum(t.blur) ? clamp(Math.round(t.blur), 0, 60) + 'px' : null);
    add('font', safeFont(t.font));
    // Old TV browsers have no color-mix(): expose "r,g,b" triplets for rgba(var(--ts-*-rgb), a).
    var sf = toRgb(safeColor(t.surface)), tx = toRgb(safeColor(t.text));
    add('accent-rgb', triplet(toRgb(safeColor(t.accent))));
    add('bg-rgb', triplet(toRgb(safeColor(t.background))));
    add('surface-rgb', triplet(sf));
    add('text-rgb', triplet(tx));
    add('text-2-rgb', triplet(toRgb(safeColor(t.textSecondary))));
    if (sf && tx) add('surface-2-rgb', triplet([0, 1, 2].map(function (k) { return Math.round(sf[k] * 0.92 + tx[k] * 0.08); })));
    if (t.backgroundImage) {
      // The darkening gradient is part of the image layer so nothing is dimmed when there is no image.
      var dim = String(clamp(isNum(t.backgroundDim) ? t.backgroundDim : 60, 0, 100) / 100);
      var img = String(t.backgroundImage).replace(/\\/g, '\\\\').replace(/"/g, '%22').replace(/\n/g, '');
      add('bg-image', 'linear-gradient(rgba(0,0,0,' + dim + '),rgba(0,0,0,' + dim + ')),url("' + img + '")');
    }
    return out;
  }

  function buildCss(theme, selection) {
    var css = '';
    selection = selection || {};
    if (!theme.stock || hasAny(selection.overrides)) {
      css += ':root{' + variables(merge(theme.tokens, selection.overrides)) + '}\n' + (state.engine || '') + '\n';
    }
    if (theme.css) css += theme.css + '\n';
    if (selection.customCss) css += selection.customCss + '\n';
    return css;
  }

  function findTheme(id) {
    var themes = (state.boot && state.boot.themes) || [];
    for (var i = 0; i < themes.length; i++) if (themes[i].id === id) return themes[i];
    for (var j = 0; j < themes.length; j++) if (themes[j].id === 'jellyfin') return themes[j];
    return { id: 'jellyfin', name: 'Jellyfin', stock: true, tokens: {} };
  }

  /** Applies css as the user layer. null = back to the server default stylesheet. */
  function applyCss(css) {
    var style = document.getElementById(STYLE_ID);
    var link = document.getElementById(DEFAULT_LINK_ID);
    if (css === null) {
      if (style) style.remove();
      if (link) link.disabled = false;
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
    }
    // Always last in <head>, after Jellyfin's own theme stylesheet.
    if (style.parentNode !== document.head || document.head.lastElementChild !== style) document.head.appendChild(style);
    style.textContent = css;
    if (link) link.disabled = true;
  }

  function cache(css) {
    try {
      if (css === null) localStorage.removeItem(CACHE_KEY);
      else localStorage.setItem(CACHE_KEY, css);
    } catch (e) { /* private mode */ }
  }

  function applySelection(selection, persistCache) {
    state.activeSelection = selection || null;
    heroSoon();
    if (!selection) {
      applyCss(null);
      if (persistCache) cache(null);
      return;
    }
    var css = buildCss(findTheme(selection.themeId), selection);
    applyCss(css);
    if (persistCache) cache(css);
  }

  function applyEffective() {
    if (!state.boot) return;
    var sel = state.boot.allowUserThemes ? state.boot.userSelection : null;
    applySelection(sel, true);
  }

  // Instant apply from cache to avoid a flash of the default theme on reload.
  try {
    var cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      if (document.head) applyCss(cached);
      else document.addEventListener('DOMContentLoaded', function () { applyCss(cached); });
    }
  } catch (e) { /* ignore */ }

  /* ------------------------------------------------------------------ API */

  function api() { return window.ApiClient; }

  function currentUserId() {
    try { return api() && api().getCurrentUserId && api().getCurrentUserId(); } catch (e) { return null; }
  }

  function url(path) {
    var c = api();
    if (c && c.getUrl) return c.getUrl('ThemeStudio/' + path);
    return BASE + '/ThemeStudio/' + path;
  }

  function request(method, path, body) {
    var headers = { Accept: 'application/json' };
    var c = api();
    var token = c && c.accessToken && c.accessToken();
    if (token) headers.Authorization = 'MediaBrowser Token="' + token + '"';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(url(path), { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.status === 204 ? null : r.json();
      });
  }

  function loadEngine() {
    if (state.engine) return Promise.resolve(state.engine);
    return fetch(url('engine.css')).then(function (r) { return r.text(); }).then(function (t) { state.engine = t; return t; });
  }

  function bootstrap() {
    if (state.loading) return state.loading;
    state.loading = Promise.all([request('GET', 'Bootstrap'), loadEngine()])
      .then(function (res) {
        state.boot = res[0];
        if (!state.previewing) applyEffective();
        ensureHeaderButton();
        heroSoon(true);
        return state.boot;
      })
      .finally(function () { state.loading = null; });
    return state.loading;
  }

  // Follow login / logout / user switch.
  function watchUser() {
    var id = currentUserId() || null;
    if (id !== state.userId) {
      state.userId = id;
      state.boot = null;
      if (id) bootstrap().catch(function (e) { console.warn('[ThemeStudio]', e); });
      else { applyCss(null); cache(null); removeHeaderButton(); heroSync(); }
    }
  }
  setInterval(watchUser, 1500);
  setTimeout(watchUser, 200);

  /* --------------------------------------------------------- Header button */

  var PALETTE_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="currentColor"><path d="M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>';

  function wantsButton() {
    return !!(state.boot && state.boot.allowUserThemes && state.boot.showHeaderButton && state.userId);
  }

  function ensureHeaderButton() {
    if (!wantsButton()) { removeHeaderButton(); return; }
    var right = document.querySelector('.skinHeader .headerRight') || document.querySelector('.headerRight');
    if (!right || right.querySelector('.themeStudioButton')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'headerButton headerButtonRight paper-icon-button-light themeStudioButton';
    btn.title = 'Thèmes';
    btn.setAttribute('aria-label', 'Thèmes');
    btn.innerHTML = PALETTE_SVG;
    btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;';
    btn.addEventListener('click', function () { open(); });
    right.insertBefore(btn, right.firstChild);
  }

  function removeHeaderButton() {
    document.querySelectorAll('.themeStudioButton').forEach(function (b) { b.remove(); });
  }

  var scheduled = false;
  new MutationObserver(function () {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      if (wantsButton()) ensureHeaderButton();
      heroSync();
      layoutSync();
      // Jellyfin swaps its theme <link> on navigation; keep our layer on top.
      var style = document.getElementById(STYLE_ID);
      if (style && document.head.lastElementChild !== style) document.head.appendChild(style);
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ------------------------------------------------------------------ UI */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function hex6(c, fallback) {
    if (typeof c !== 'string') return fallback;
    if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(c)) return ('#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toLowerCase();
    if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7).toLowerCase();
    return fallback;
  }

  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }

  var FONTS = [
    { label: 'Par défaut du thème', value: '' },
    { label: 'Système', value: 'system-ui' },
    { label: 'Inter / Segoe', value: 'Inter, "Segoe UI"' },
    { label: 'Arrondie', value: '"Nunito", "Varela Round", "Quicksand"' },
    { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
    { label: 'Monospace', value: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' },
  ];

  var COLORS = [
    ['accent', 'Accent'],
    ['background', 'Fond'],
    ['surface', 'Panneaux'],
    ['text', 'Texte'],
    ['textSecondary', 'Texte secondaire'],
  ];

  var UI_CSS = [
    ':host{all:initial;--acc:#8b5cf6;--bg:#0f1117;--sf:#171a23;--sf2:#1f2330;--bd:rgba(255,255,255,.09);--tx:#eef0f6;--tx2:#9aa0b4;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--tx)}',
    '*{box-sizing:border-box}',
    'button,input,select,textarea{font:inherit;color:inherit}',
    '.scrim{position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,.25);opacity:0;transition:opacity .2s}',
    '.panel{position:fixed;top:0;right:0;bottom:0;width:440px;max-width:100vw;display:flex;flex-direction:column;background:var(--bg);background:color-mix(in srgb,var(--bg) 88%,transparent);-webkit-backdrop-filter:blur(24px) saturate(1.4);backdrop-filter:blur(24px) saturate(1.4);border-left:1px solid var(--bd);box-shadow:-20px 0 60px rgba(0,0,0,.45);transform:translateX(100%);transition:transform .28s cubic-bezier(.2,.8,.2,1)}',
    ':host(.open) .panel{transform:none}:host(.open) .scrim{opacity:1}',
    '.inline{display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--bd);border-radius:16px;overflow:hidden;max-width:1100px}',
    'header{display:flex;align-items:center;gap:12px;padding:18px 20px 8px}',
    'header h2{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em;flex:1}',
    'header p{margin:2px 0 0;color:var(--tx2);font-size:12.5px}',
    '.icon{width:36px;height:36px;border-radius:10px;border:0;background:transparent;cursor:pointer;display:grid;place-items:center;color:var(--tx2)}',
    '.icon:hover{background:var(--sf2);color:var(--tx)}',
    'nav{display:flex;gap:4px;padding:8px 16px 12px;border-bottom:1px solid var(--bd)}',
    'nav button{flex:1;padding:8px 6px;border-radius:10px;border:0;background:transparent;color:var(--tx2);cursor:pointer;font-weight:550}',
    'nav button[aria-selected=true]{background:var(--sf2);color:var(--tx)}',
    'nav button:hover{color:var(--tx)}',
    '.body{flex:1;overflow:auto;padding:16px 20px 24px}',
    '.inline .body{max-height:none}',
    'section[hidden]{display:none}',
    '.search{display:flex;gap:8px;margin-bottom:10px}',
    '.search input{flex:1}',
    'input[type=text],input[type=url],input[type=search],select,textarea{width:100%;background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:9px 11px;outline:none}',
    'input:focus,select:focus,textarea:focus{border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 25%,transparent)}',
    'textarea{min-height:260px;font:12.5px/1.5 ui-monospace,"JetBrains Mono",Consolas,monospace;resize:vertical}',
    '.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}',
    '.chip{padding:4px 10px;border-radius:999px;border:1px solid var(--bd);background:transparent;color:var(--tx2);cursor:pointer;font-size:12.5px}',
    '.chip[aria-pressed=true]{background:var(--acc);border-color:var(--acc);color:#fff}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}',
    '.card{all:unset;cursor:pointer;border-radius:14px;background:var(--sf);border:1px solid var(--bd);overflow:hidden;display:flex;flex-direction:column;transition:transform .15s,border-color .15s}',
    '.card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--tx) 25%,transparent)}',
    '.card:focus-visible{outline:2px solid var(--acc);outline-offset:2px}',
    '.card[aria-checked=true]{border-color:var(--acc);box-shadow:0 0 0 2px var(--acc)}',
    '.mini{height:96px;background:var(--b);padding:8px;display:flex;flex-direction:column;gap:7px;position:relative}',
    '.mini-h{height:10px;border-radius:4px;background:var(--s);display:flex;align-items:center;padding:0 4px;gap:3px}',
    '.mini-h i{width:14px;height:3px;border-radius:2px;background:var(--t);opacity:.5}',
    '.mini-h i:first-child{background:var(--a);opacity:1}',
    '.mini-row{display:flex;gap:6px;flex:1}',
    '.mini-row i{flex:1;border-radius:10px;background:var(--s);border:1px solid color-mix(in srgb,var(--t) 10%,transparent)}',
    '.mini-row i:nth-child(2){background:linear-gradient(160deg,var(--a),var(--s) 75%)}',
    '.mini-btn{position:absolute;right:10px;bottom:10px;width:34px;height:12px;border-radius:999px;background:var(--a)}',
    '.meta{padding:9px 11px 11px}',
    '.meta b{display:flex;align-items:center;gap:6px;font-weight:600}',
    '.meta span{display:block;color:var(--tx2);font-size:12px;margin-top:2px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.badge{font-size:10.5px;font-weight:600;padding:1px 6px;border-radius:6px;background:var(--sf2);color:var(--tx2)}',
    '.field{margin-bottom:16px}',
    '.field>label,.label{display:flex;justify-content:space-between;align-items:center;font-weight:550;margin-bottom:7px}',
    '.label small,.field>label small{color:var(--tx2);font-weight:400}',
    '.colors{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px}',
    '.color{display:flex;align-items:center;gap:10px;padding:8px;border-radius:12px;background:var(--sf);border:1px solid var(--bd)}',
    '.color input[type=color]{width:34px;height:34px;border:0;border-radius:9px;padding:0;background:none;cursor:pointer;flex:none}',
    '.color input[type=color]::-webkit-color-swatch-wrapper{padding:0}',
    '.color input[type=color]::-webkit-color-swatch{border:1px solid var(--bd);border-radius:9px}',
    '.color span{flex:1;min-width:0}',
    '.color span small{display:block;color:var(--tx2);font:11.5px ui-monospace,monospace}',
    '.reset{border:0;background:transparent;color:var(--tx2);cursor:pointer;padding:2px 4px;border-radius:6px;font-size:12px}',
    '.reset:hover{color:var(--tx);background:var(--sf2)}',
    '.reset[hidden]{display:none}',
    'input[type=range]{width:100%;accent-color:var(--acc)}',
    '.row{display:flex;gap:8px;align-items:center}',
    '.toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border-radius:12px;background:var(--sf);border:1px solid var(--bd);margin-bottom:8px;cursor:pointer}',
    '.toggle input{width:18px;height:18px;accent-color:var(--acc)}',
    '.toggle small{display:block;color:var(--tx2)}',
    'footer{display:flex;gap:8px;padding:14px 20px;border-top:1px solid var(--bd);align-items:center}',
    'footer .grow{flex:1}',
    '.btn{padding:9px 16px;border-radius:10px;border:1px solid var(--bd);background:var(--sf2);cursor:pointer;font-weight:600}',
    '.btn:hover{filter:brightness(1.15)}',
    '.btn.primary{background:var(--acc);border-color:transparent;color:#fff}',
    '.btn.ghost{background:transparent}',
    '.btn.danger{color:#ff8a8a}',
    '.btn[disabled]{opacity:.5;cursor:default}',
    '.hint{color:var(--tx2);font-size:12.5px;margin:0 0 12px}',
    '.notice{padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--acc) 14%,transparent);border:1px solid color-mix(in srgb,var(--acc) 40%,transparent);margin-bottom:14px;font-size:13px}',
    '.notice.warn{background:rgba(255,170,0,.12);border-color:rgba(255,170,0,.4)}',
    '.list{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}',
    '.list .item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:var(--sf);border:1px solid var(--bd)}',
    '.list .item .dot{width:22px;height:22px;border-radius:7px;flex:none}',
    '.list .item b{flex:1;font-weight:550}',
    '.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--sf2);border:1px solid var(--bd);padding:10px 16px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4);font-weight:550}',
    'h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--tx2);margin:22px 0 10px;font-weight:600}',
    'h3:first-child{margin-top:0}',
    '.empty{color:var(--tx2);text-align:center;padding:30px 0}',
    '@media (max-width:520px){.colors{grid-template-columns:1fr}.grid{grid-template-columns:1fr 1fr}}',
  ].join('\n');

  /**
   * Creates the theme editor.
   * opts.mode: 'user' (panel) or 'admin' (inline in the config page)
   */
  function createEditor(host, opts) {
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var admin = opts.mode === 'admin';
    var themes = opts.themes;
    var draft = clone(opts.selection) || { themeId: 'jellyfin' };
    draft.overrides = draft.overrides || {};
    var server = opts.server ? clone(opts.server) : null; // admin only: settings + custom themes
    var tab = 'gallery';
    var filter = { q: '', tag: '' };
    var dirty = false;

    function theme() {
      for (var i = 0; i < themes.length; i++) if (themes[i].id === draft.themeId) return themes[i];
      return themes[0];
    }
    function tokens() { return merge(theme().tokens, draft.overrides); }

    function preview() {
      dirty = true;
      var t = tokens();
      host.style.setProperty('--acc', hex6(t.accent, '#8b5cf6'));
      opts.onPreview(clone(draft));
      updateFooter();
    }

    function allTags() {
      var tags = {};
      themes.forEach(function (t) { (t.tags || []).forEach(function (g) { tags[g] = true; }); });
      return Object.keys(tags).sort();
    }

    function miniStyle(t) {
      return '--a:' + esc(t.accent || '#00a4dc') + ';--b:' + esc(t.background || '#101010') + ';--s:' + esc(t.surface || '#202020') +
        ';--t:' + esc(t.text || '#fff') + ';--r:' + (isNum(t.radius) ? t.radius : 4) + 'px';
    }

    function galleryHtml() {
      var q = filter.q.toLowerCase();
      var list = themes.filter(function (t) {
        if (filter.tag && (t.tags || []).indexOf(filter.tag) < 0) return false;
        if (!q) return true;
        return (t.name + ' ' + (t.description || '') + ' ' + (t.tags || []).join(' ') + ' ' + (t.author || '')).toLowerCase().indexOf(q) >= 0;
      });
      var html = '<div class="search"><input type="search" id="q" placeholder="Rechercher un thème…" value="' + esc(filter.q) + '" aria-label="Rechercher"></div>';
      html += '<div class="chips" role="group" aria-label="Filtres"><button class="chip" data-tag="" aria-pressed="' + (!filter.tag) + '">Tous</button>';
      allTags().forEach(function (g) {
        html += '<button class="chip" data-tag="' + esc(g) + '" aria-pressed="' + (filter.tag === g) + '">' + esc(g) + '</button>';
      });
      html += '</div><div class="grid" role="radiogroup" aria-label="Thèmes">';
      list.forEach(function (t) {
        var tk = t.id === draft.themeId ? tokens() : t.tokens;
        html += '<button class="card" role="radio" data-id="' + esc(t.id) + '" aria-checked="' + (t.id === draft.themeId) + '">' +
          '<div class="mini" style="' + miniStyle(tk) + '"><div class="mini-h"><i></i><i></i><i></i></div><div class="mini-row"><i></i><i></i><i></i></div><div class="mini-btn"></div></div>' +
          '<div class="meta"><b>' + esc(t.name) + (t.source === 'custom' ? ' <span class="badge">Perso</span>' : '') + '</b><span>' + esc(t.description || '') + '</span></div></button>';
      });
      html += '</div>';
      if (!list.length) html += '<p class="empty">Aucun thème ne correspond.</p>';
      return html;
    }

    function customizeHtml() {
      var t = tokens();
      var o = draft.overrides;
      var html = '<p class="hint">Les réglages s\'appliquent en direct par-dessus le thème « ' + esc(theme().name) + ' ».</p>';
      html += '<h3>Couleurs</h3><div class="colors">';
      COLORS.forEach(function (c) {
        var v = hex6(t[c[0]], '#000000');
        html += '<label class="color"><input type="color" data-token="' + c[0] + '" value="' + v + '"><span>' + c[1] + '<small>' + v + '</small></span>' +
          '<button class="reset" data-reset="' + c[0] + '" title="Revenir à la valeur du thème"' + (o[c[0]] ? '' : ' hidden') + '>↺</button></label>';
      });
      html += '</div><h3>Forme et effets</h3>';
      html += rangeHtml('radius', 'Arrondi des coins', 0, 32, t.radius, 'px');
      html += rangeHtml('blur', 'Effet verre (flou)', 0, 40, t.blur, 'px');
      html += '<h3>Police</h3><div class="field"><select data-token="font">';
      var known = false;
      FONTS.forEach(function (f) {
        var sel = (t.font || '') === f.value;
        if (sel) known = true;
        html += '<option value="' + esc(f.value) + '"' + (sel ? ' selected' : '') + '>' + esc(f.label) + '</option>';
      });
      if (!known) html += '<option value="' + esc(t.font) + '" selected>' + esc(t.font) + '</option>';
      html += '</select></div>';
      html += '<h3>Image de fond</h3><div class="field"><input type="url" data-token="backgroundImage" placeholder="https://… (laisser vide pour aucune)" value="' + esc(t.backgroundImage || '') + '"></div>';
      html += rangeHtml('backgroundDim', 'Assombrir l\'image', 0, 95, t.backgroundDim, '%');
      if (!admin) {
        var hv = draft.homeHero === true ? 'on' : draft.homeHero === false ? 'off' : '';
        html += '<h3>Page d\'accueil</h3><div class="field"><label>Grande bannière (reprendre, nouveautés)</label><select id="homeHero">' +
          '<option value=""' + (hv === '' ? ' selected' : '') + '>Comme le serveur</option>' +
          '<option value="on"' + (hv === 'on' ? ' selected' : '') + '>Afficher</option>' +
          '<option value="off"' + (hv === 'off' ? ' selected' : '') + '>Masquer</option></select></div>';
      }
      html += '<button class="btn ghost" id="resetAll">Tout remettre comme le thème</button>';
      return html;
    }

    function rangeHtml(key, label, min, max, value, unit) {
      var v = isNum(value) ? value : min;
      return '<div class="field"><label>' + label + ' <span class="row"><small id="v-' + key + '">' + v + unit + '</small>' +
        '<button class="reset" data-reset="' + key + '"' + (isNum(draft.overrides[key]) ? '' : ' hidden') + '>↺</button></span></label>' +
        '<input type="range" min="' + min + '" max="' + max + '" value="' + v + '" data-token="' + key + '" data-unit="' + unit + '"></div>';
    }

    function cssHtml() {
      return '<p class="hint">' + (admin ? 'CSS ajouté pour tout le monde, après le thème par défaut.' : 'Ton CSS personnel, appliqué en dernier. Il n\'est visible que pour toi.') + '</p>' +
        '<textarea id="css" spellcheck="false" placeholder="/* ex. */\n.cardText { font-weight: 600; }">' + esc(draft.customCss || '') + '</textarea>';
    }

    function shareHtml() {
      var html = '<h3>Exporter</h3><p class="hint">Enregistre le thème actuel (couleurs, réglages et CSS) dans un fichier à partager.</p>' +
        '<div class="row" style="margin-bottom:8px"><button class="btn" id="exportFile">Télécharger le fichier</button><button class="btn ghost" id="exportCopy">Copier</button></div>' +
        '<h3>Importer</h3><p class="hint">Charge un fichier .json exporté depuis Theme Studio, ou colle son contenu.</p>' +
        '<div class="row" style="margin-bottom:8px"><button class="btn" id="importFile">Choisir un fichier</button><input type="file" id="file" accept=".json,application/json" hidden></div>' +
        '<textarea id="importText" style="min-height:120px" placeholder="Colle ici le contenu du fichier…"></textarea>' +
        '<div class="row" style="margin-top:8px"><button class="btn" id="importPaste">Importer le texte collé</button></div>';
      return html;
    }

    function settingsHtml() {
      var s = server.settings;
      var html = '';
      if (!opts.injectionActive) {
        html += '<div class="notice warn">Le script n\'a pas encore été injecté dans l\'interface web depuis le démarrage du serveur. Recharge la page (Ctrl+F5). Si ce message reste affiché, redémarre Jellyfin.</div>';
      }
      html += '<h3>Utilisateurs</h3>';
      html += toggleHtml('allowUserThemes', 'Chaque utilisateur peut choisir son thème', 'Sinon, tout le monde voit le thème par défaut ci-dessous.', s.allowUserThemes);
      html += toggleHtml('showHeaderButton', 'Bouton palette dans la barre du haut', 'Ouvre le panneau des thèmes en un clic.', s.showHeaderButton);
      html += '<h3>Mise en page</h3>';
      html += toggleHtml('modernLayout', 'Mise en page streaming', 'Barre de navigation fixe à gauche sur ordinateur, accueil en cartes et fiches films/séries plein écran avec onglets de saisons. Sur TV, seule une version allégée du thème s\'applique.', s.modernLayout !== false);
      html += '<h3>Page d\'accueil</h3>';
      html += toggleHtml('showHomeHero', 'Grande bannière façon cinéma', 'Grande image en haut de l\'accueil avec les films à reprendre et les nouveautés. Chaque utilisateur peut la masquer.', s.showHomeHero !== false);
      html += toggleHtml('homeHeroTrailers', 'Bandes-annonces dans la bannière', 'Après quelques secondes, la bande-annonce (YouTube) remplace l\'image, sans le son. Désactivée sur mobile et en mode économie de données.', s.homeHeroTrailers !== false);
      var src = s.homeHeroSource || 'mixed';
      html += '<div class="field"><label>Contenu de la bannière</label><select id="homeHeroSource">' +
        '<option value="mixed"' + (src === 'mixed' ? ' selected' : '') + '>À reprendre, puis nouveautés</option>' +
        '<option value="resume"' + (src === 'resume' ? ' selected' : '') + '>Seulement à reprendre</option>' +
        '<option value="latest"' + (src === 'latest' ? ' selected' : '') + '>Seulement les nouveautés</option></select></div>';
      html += '<h3>Mes thèmes personnalisés</h3>';
      var custom = s.customThemes || [];
      html += '<div class="list">';
      if (!custom.length) html += '<p class="hint">Aucun pour l\'instant. Règle un thème puis enregistre-le ici pour le proposer à tout le monde.</p>';
      custom.forEach(function (t, i) {
        html += '<div class="item"><span class="dot" style="background:linear-gradient(135deg,' + esc(t.tokens.accent || '#888') + ',' + esc(t.tokens.background || '#111') + ')"></span><b>' + esc(t.name) + '</b>' +
          '<button class="btn ghost danger" data-del="' + i + '">Supprimer</button></div>';
      });
      html += '</div><div class="row"><input type="text" id="newName" placeholder="Nom du nouveau thème"><button class="btn" id="saveAsTheme">Ajouter</button></div>';
      return html;
    }

    function toggleHtml(key, title, sub, checked) {
      return '<label class="toggle"><span>' + title + '<small>' + sub + '</small></span><input type="checkbox" data-setting="' + key + '"' + (checked ? ' checked' : '') + '></label>';
    }

    var TABS = [['gallery', 'Galerie'], ['customize', 'Personnaliser'], ['css', 'CSS'], ['share', 'Partager']];
    if (admin) TABS.push(['settings', 'Réglages']);

    function render() {
      var title = admin ? 'Thème par défaut du serveur' : 'Thèmes';
      var sub = admin ? 'Utilisé sur la page de connexion et par tous ceux qui n\'ont pas choisi leur thème.' : 'Les changements s\'affichent en direct. Rien n\'est gardé avant « Enregistrer ».';
      var html = '<style>' + UI_CSS + '</style>';
      if (!admin) html += '<div class="scrim" part="scrim"></div>';
      html += '<div class="' + (admin ? 'inline' : 'panel') + '" role="' + (admin ? 'region' : 'dialog') + '" aria-label="' + title + '">' +
        '<header><div style="flex:1"><h2>' + title + '</h2><p>' + sub + '</p></div>' +
        (admin ? '' : '<button class="icon" id="close" aria-label="Fermer"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button>') +
        '</header><nav role="tablist">';
      TABS.forEach(function (t) { html += '<button role="tab" data-tab="' + t[0] + '" aria-selected="' + (tab === t[0]) + '">' + t[1] + '</button>'; });
      html += '</nav><div class="body" id="body"></div><footer>' +
        (admin ? '' : '<button class="btn ghost danger" id="resetUser" title="Revenir au thème par défaut du serveur">Réinitialiser</button>') +
        '<span class="grow"></span><button class="btn ghost" id="cancel">Annuler</button><button class="btn primary" id="save">Enregistrer</button></footer></div>';
      shadow.innerHTML = html;
      renderBody();
      bind();
      updateFooter();
      var t = tokens();
      host.style.setProperty('--acc', hex6(t.accent, '#8b5cf6'));
    }

    function renderBody() {
      var body = shadow.getElementById('body');
      var map = { gallery: galleryHtml, customize: customizeHtml, css: cssHtml, share: shareHtml, settings: settingsHtml };
      body.innerHTML = '<section>' + map[tab]() + '</section>';
      shadow.querySelectorAll('nav button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    }

    function updateFooter() {
      var cancel = shadow.getElementById('cancel');
      if (cancel) cancel.disabled = !dirty;
    }

    function toast(msg) {
      var el = document.createElement('div');
      el.className = 'toast';
      el.textContent = msg;
      shadow.appendChild(el);
      setTimeout(function () { el.remove(); }, 2200);
    }

    function setToken(key, value) {
      if (value === '' || value === null || value === undefined) delete draft.overrides[key];
      else draft.overrides[key] = value;
      preview();
    }

    function exportData() {
      var t = theme();
      var css = [t.css, draft.customCss].filter(Boolean).join('\n');
      return {
        format: 'theme-studio',
        version: 1,
        name: t.name + (hasAny(draft.overrides) || draft.customCss ? ' (perso)' : ''),
        tokens: tokens(),
        css: css || undefined,
      };
    }

    function importData(text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { toast('Fichier illisible : ce n\'est pas du JSON.'); return; }
      if (!data || data.format !== 'theme-studio' || !data.tokens) { toast('Ce fichier ne vient pas de Theme Studio.'); return; }
      if (admin) {
        server.settings.customThemes = server.settings.customThemes || [];
        var id = 'perso-' + Date.now().toString(36);
        var nt = { id: id, name: String(data.name || 'Thème importé'), author: data.author, description: data.description || 'Thème importé', tags: ['perso'], tokens: data.tokens, css: data.css, source: 'custom' };
        server.settings.customThemes.push(nt);
        themes.push(nt);
        draft = { themeId: id, overrides: {}, customCss: draft.customCss };
      } else {
        draft = { themeId: 'jellyfin', overrides: clone(data.tokens), customCss: data.css || '' };
      }
      preview();
      tab = 'gallery';
      renderBody();
      toast('Thème importé. Pense à enregistrer.');
    }

    function download(name, text) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }

    var cssTimer;

    function bind() {
      shadow.addEventListener('click', function (e) {
        var el = e.target.closest ? e.target.closest('button, .scrim') : null;
        if (!el) return;
        if (el.classList.contains('scrim') || el.id === 'close') { opts.onClose(dirty); return; }
        if (el.dataset.tab) { tab = el.dataset.tab; renderBody(); return; }
        if (el.dataset.tag !== undefined && el.classList.contains('chip')) { filter.tag = el.dataset.tag; renderBody(); return; }
        if (el.dataset.id) {
          if (draft.themeId !== el.dataset.id) {
            draft.themeId = el.dataset.id;
            draft.overrides = {};
            preview();
            renderBody();
          }
          return;
        }
        if (el.dataset.reset) { setToken(el.dataset.reset, null); renderBody(); return; }
        if (el.dataset.del !== undefined) {
          var removed = server.settings.customThemes.splice(Number(el.dataset.del), 1)[0];
          themes = themes.filter(function (t) { return t.id !== removed.id; });
          if (draft.themeId === removed.id) { draft.themeId = 'jellyfin'; }
          preview();
          renderBody();
          return;
        }
        switch (el.id) {
          case 'resetAll': draft.overrides = {}; preview(); renderBody(); break;
          case 'cancel': opts.onCancel(); break;
          case 'save':
            el.disabled = true;
            opts.onSave(clone(draft), server && clone(server.settings)).then(function () {
              dirty = false;
              updateFooter();
              toast('Enregistré ✓');
            }, function (err) {
              toast('Échec de l\'enregistrement (' + err.message + ')');
            }).finally(function () { el.disabled = false; });
            break;
          case 'resetUser': opts.onReset(); break;
          case 'exportFile': download((exportData().name || 'theme').replace(/[^\w\- ]+/g, '') + '.json', JSON.stringify(exportData(), null, 2)); break;
          case 'exportCopy':
            navigator.clipboard.writeText(JSON.stringify(exportData(), null, 2)).then(function () { toast('Copié dans le presse-papiers'); }, function () { toast('Copie impossible'); });
            break;
          case 'importFile': shadow.getElementById('file').click(); break;
          case 'importPaste': importData(shadow.getElementById('importText').value); break;
          case 'saveAsTheme': {
            var name = shadow.getElementById('newName').value.trim();
            if (!name) { toast('Donne un nom au thème.'); return; }
            var base = theme();
            var nt = {
              id: 'perso-' + Date.now().toString(36),
              name: name,
              description: 'Basé sur ' + base.name,
              tags: ['perso'],
              tokens: tokens(),
              css: [base.css, draft.customCss].filter(Boolean).join('\n') || undefined,
              source: 'custom',
            };
            server.settings.customThemes = server.settings.customThemes || [];
            server.settings.customThemes.push(nt);
            themes.push(nt);
            draft = { themeId: nt.id, overrides: {}, customCss: '' };
            preview();
            renderBody();
            toast('Thème ajouté. Enregistre pour le publier.');
            break;
          }
        }
      });

      shadow.addEventListener('input', function (e) {
        var el = e.target;
        if (el.id === 'q') {
          filter.q = el.value;
          var pos = el.selectionStart;
          renderBody();
          var q = shadow.getElementById('q');
          q.focus();
          try { q.setSelectionRange(pos, pos); } catch (err) { /* ignore */ }
          return;
        }
        if (el.id === 'css') {
          draft.customCss = el.value;
          clearTimeout(cssTimer);
          cssTimer = setTimeout(preview, 250);
          return;
        }
        if (el.dataset.setting) { server.settings[el.dataset.setting] = el.checked; dirty = true; updateFooter(); return; }
        var key = el.dataset.token;
        if (!key) return;
        if (el.type === 'range') {
          var n = Number(el.value);
          var out = shadow.getElementById('v-' + key);
          if (out) out.textContent = n + el.dataset.unit;
          setToken(key, n);
          var rb = shadow.querySelector('[data-reset="' + key + '"]');
          if (rb) rb.hidden = false;
        } else if (el.type === 'color') {
          setToken(key, el.value);
          var small = el.parentNode.querySelector('small');
          if (small) small.textContent = el.value;
          var cb = shadow.querySelector('[data-reset="' + key + '"]');
          if (cb) cb.hidden = false;
        } else if (el.type === 'url') {
          clearTimeout(cssTimer);
          var v = el.value.trim();
          cssTimer = setTimeout(function () { setToken(key, v); }, 300);
        }
      });

      shadow.addEventListener('change', function (e) {
        var el = e.target;
        if (el.tagName === 'SELECT' && el.dataset.token) setToken(el.dataset.token, el.value);
        if (el.id === 'homeHero') {
          if (el.value === '') delete draft.homeHero; else draft.homeHero = el.value === 'on';
          preview();
        }
        if (el.id === 'homeHeroSource') { server.settings.homeHeroSource = el.value; dirty = true; updateFooter(); }
        if (el.id === 'file' && el.files && el.files[0]) {
          el.files[0].text().then(importData);
          el.value = '';
        }
      });

      if (!admin) {
        shadow.addEventListener('keydown', function (e) { if (e.key === 'Escape') opts.onClose(dirty); });
      }
    }

    render();
    return {
      reset: function (selection) { draft = clone(selection) || { themeId: 'jellyfin' }; draft.overrides = draft.overrides || {}; dirty = false; render(); },
      focus: function () { var b = shadow.querySelector('nav button'); if (b) b.focus(); },
    };
  }

  /* ------------------------------------------------------------- Panel (user) */

  var panelHost = null;

  function open() {
    if (panelHost) return;
    (state.boot ? Promise.resolve(state.boot) : bootstrap()).then(function (boot) {
      if (!boot.allowUserThemes) return;
      var saved = boot.userSelection || clone(boot.defaultSelection) || { themeId: 'jellyfin' };
      panelHost = document.createElement('div');
      panelHost.id = 'theme-studio-panel';
      panelHost.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;';
      document.body.appendChild(panelHost);
      state.previewing = true;

      function close() {
        if (!panelHost) return;
        panelHost.classList.remove('open');
        var h = panelHost;
        panelHost = null;
        state.previewing = false;
        setTimeout(function () { h.remove(); }, 260);
      }
      function revert() { applyEffective(); }

      var editor = createEditor(panelHost, {
        mode: 'user',
        themes: boot.themes,
        selection: saved,
        onPreview: function (sel) { applySelection(sel, false); },
        onCancel: function () { revert(); editor.reset(boot.userSelection || boot.defaultSelection); },
        onClose: function (dirty) { if (dirty) revert(); close(); },
        onSave: function (sel) {
          return request('PUT', 'Me', sel).then(function () {
            boot.userSelection = sel;
            applyEffective();
            close();
          });
        },
        onReset: function () {
          request('DELETE', 'Me').then(function () {
            boot.userSelection = null;
            applyEffective();
            close();
          });
        },
      });
      requestAnimationFrame(function () { panelHost && panelHost.classList.add('open'); editor.focus(); });
    }).catch(function (e) { console.warn('[ThemeStudio] cannot open panel', e); });
  }

  /* ------------------------------------------------------------- Admin page */

  function mountAdmin(container) {
    container.innerHTML = '<p style="opacity:.7">Chargement…</p>';
    return Promise.all([request('GET', 'Admin'), loadEngine(), state.boot ? Promise.resolve(state.boot) : bootstrap().catch(function () { return null; })])
      .then(function (res) {
        var data = res[0];
        container.innerHTML = '';
        var host = document.createElement('div');
        container.appendChild(host);
        if (!data || !data.settings || !data.builtInThemes) throw new Error('réponse inattendue du serveur');
        var settings = data.settings;
        settings.defaultSelection = settings.defaultSelection || { themeId: 'jellyfin' };
        var themes = data.builtInThemes.concat((settings.customThemes || []).map(function (t) { t.source = 'custom'; return t; }));
        state.previewing = true;
        if (state.boot) state.boot.themes = themes;

        function restore() {
          state.previewing = false;
          applyEffective();
        }
        // Leaving the page puts the user's own theme back.
        var page = container.closest('[data-role="page"]');
        if (page) page.addEventListener('viewhide', restore, { once: true });

        var editor = createEditor(host, {
          mode: 'admin',
          themes: themes,
          selection: settings.defaultSelection,
          server: { settings: settings },
          injectionActive: !!data.lastInjection,
          onPreview: function (sel) {
            if (state.boot) state.boot.themes = themes;
            applySelection(sel, false);
          },
          onCancel: function () {
            applySelection(settings.defaultSelection, false);
            editor.reset(settings.defaultSelection);
          },
          onClose: function () {},
          onReset: function () {},
          onSave: function (sel, newSettings) {
            newSettings.defaultSelection = sel;
            return request('PUT', 'Admin', newSettings).then(function () {
              settings = newSettings;
              var link = document.getElementById(DEFAULT_LINK_ID);
              if (link) link.href = link.href.split('?')[0] + '?t=' + Date.now();
              state.boot = null;
              return bootstrap().then(function () { state.previewing = true; applySelection(sel, false); });
            });
          },
        });
        return editor;
      })
      .catch(function (e) {
        container.innerHTML = '<p>Impossible de charger Theme Studio : ' + esc(e.message) + '</p>';
      });
  }

  /* ------------------------------------------------------- Home hero banner */

  var HERO_CSS = [
    '.tsh{position:relative;height:70vh;height:clamp(380px,70vh,860px);overflow:hidden;margin-bottom:1.2em;background:var(--ts-bg,#101010);color:#fff;isolation:isolate}',
    '.tsh-slide{position:absolute;top:0;right:0;bottom:0;left:0;opacity:0;visibility:hidden;transition:opacity .9s ease,visibility 0s linear .9s}',
    '.tsh-slide.on{opacity:1;visibility:visible;transition:opacity .9s ease}',
    '.tsh-bg{position:absolute;top:0;right:0;bottom:0;left:0;width:100%;height:100%;object-fit:cover;object-position:center 20%;transform:scale(1.02)}',
    '.tsh-slide.on .tsh-bg{animation:tsh-zoom 14s ease-out forwards}',
    '@keyframes tsh-zoom{from{transform:scale(1.02)}to{transform:scale(1.09)}}',
    '.tsh-shade{position:absolute;top:0;right:0;bottom:0;left:0;background:linear-gradient(to top,var(--ts-bg,#101010) 0%,rgba(var(--ts-bg-rgb,16,16,16),.6) 22%,transparent 55%),linear-gradient(to right,rgba(0,0,0,.82) 0%,rgba(0,0,0,.45) 35%,transparent 65%),linear-gradient(to bottom,rgba(0,0,0,.55) 0%,transparent 18%)}',
    '.tsh-info{position:absolute;left:4.5vw;bottom:15%;width:88vw;max-width:620px;z-index:2}',
    '.tsh-tag{display:inline-flex;align-items:center;font-size:.82em;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--ts-accent,#00a4dc);margin-bottom:.9em}',
    '.tsh-tag::before{content:"";margin-right:.5em;width:18px;height:3px;border-radius:2px;background:currentColor}',
    '.tsh-logo{display:block;max-width:70%;max-height:150px;object-fit:contain;object-position:left bottom;margin-bottom:.7em;filter:drop-shadow(0 4px 24px rgba(0,0,0,.6))}',
    '.tsh-title{font-size:3em;font-size:clamp(2em,4.4vw,3.6em);font-weight:800;line-height:1.02;letter-spacing:-.02em;margin:0 0 .25em;text-shadow:0 2px 20px rgba(0,0,0,.5)}',
    '.tsh-sub{font-size:1.15em;font-weight:600;margin:0 0 .5em;opacity:.95}',
    '.tsh-meta{display:flex;flex-wrap:wrap;align-items:center;font-size:.95em;color:rgba(255,255,255,.85);margin-bottom:.8em}',
    '.tsh-meta>*{margin:0 .9em .35em 0}',
    '.tsh-meta .tsh-pill{border:1px solid rgba(255,255,255,.45);border-radius:4px;padding:0 .4em;font-size:.85em}',
    '.tsh-meta .tsh-star{color:#ffd166}',
    '.tsh-ov{font-size:1.02em;line-height:1.5;color:rgba(255,255,255,.88);margin:0 0 1.3em;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;text-shadow:0 1px 8px rgba(0,0,0,.5)}',
    '.tsh-progress{display:flex;align-items:center;margin:-.4em 0 1.2em;font-size:.9em;color:rgba(255,255,255,.8)}',
    '.tsh-progress span{margin-right:.8em;flex:0 0 180px;height:4px;border-radius:2px;background:rgba(255,255,255,.25);overflow:hidden}',
    '.tsh-progress i{display:block;height:100%;background:var(--ts-accent,#00a4dc)}',
    '.tsh-btns{display:flex;flex-wrap:wrap;align-items:center}',
    '.tsh-btns>*{margin:0 .8em .6em 0}',
    '.tsh-btn{display:inline-flex;align-items:center;border:0;border-radius:var(--ts-radius-sm,6px);padding:.75em 1.6em;font:inherit;font-size:1.05em;font-weight:700;cursor:pointer;transition:transform .15s,filter .15s,background .15s}',
    '.tsh-btn:hover{transform:scale(1.04)}',
    '.tsh-btn:focus-visible{outline:3px solid var(--ts-accent,#00a4dc);outline-offset:3px}',
    '.tsh-play{background:#fff;color:#000}',
    '.tsh-play:hover{filter:brightness(.88)}',
    '.tsh-more{background:rgba(109,109,110,.6);color:#fff;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}',
    '.tsh-more:hover{background:rgba(109,109,110,.4)}',
    '.tsh-btn svg{width:1.4em;height:1.4em;margin-right:.5em}',
    '.tsh-trailer{position:absolute;top:0;right:0;bottom:0;left:0;overflow:hidden;opacity:0;transition:opacity 1.2s ease;pointer-events:none}',
    '.tsh-playing .tsh-trailer{opacity:1}',
    '.tsh-playing .tsh-bg{opacity:0;transition:opacity 1.2s ease}',
    '.tsh-trailer iframe{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);border:0}',
    '.tsh-playing .tsh-ov{-webkit-line-clamp:2}',
    '.tsh-round{display:inline-grid;place-items:center;width:2.9em;height:2.9em;border-radius:50%;border:2px solid rgba(255,255,255,.55);background:rgba(20,20,20,.35);color:#fff;cursor:pointer;padding:0;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);transition:transform .15s,border-color .15s,background .15s}',
    '.tsh-round:hover{transform:scale(1.08);border-color:#fff;background:rgba(255,255,255,.12)}',
    '.tsh-round:focus-visible{outline:3px solid var(--ts-accent,#00a4dc);outline-offset:3px}',
    '.tsh-round svg{width:1.45em;height:1.45em}',
    '.tsh-fav[aria-pressed=true]{border-color:var(--ts-accent,#00a4dc);color:var(--ts-accent,#00a4dc)}',
    '.tsh-mute{position:absolute;right:4.5vw;bottom:calc(15% + 2.6em);z-index:3}',
    '.tsh-mute[hidden]{display:none}',
    '.tsh-dots{position:absolute;right:4.5vw;bottom:15%;display:flex;z-index:3}',
    '.tsh-dot{margin-left:6px;width:22px;height:4px;border:0;border-radius:2px;background:rgba(255,255,255,.35);cursor:pointer;padding:0;transition:width .3s,background .3s}',
    '.tsh-dot.on{width:38px;background:#fff}',
    '.tsh-arrow{position:absolute;top:50%;transform:translateY(-50%);z-index:3;width:48px;height:96px;border:0;background:rgba(0,0,0,.25);color:#fff;cursor:pointer;opacity:0;transition:opacity .2s;display:grid;place-items:center}',
    '.tsh:hover .tsh-arrow{opacity:1}',
    '.tsh-arrow:hover{background:rgba(0,0,0,.5)}',
    '.tsh-prev{left:0;border-radius:0 8px 8px 0}.tsh-next{right:0;border-radius:8px 0 0 8px}',
    '.tsh-arrow svg{width:30px;height:30px}',
    '.tsh-skeleton{position:absolute;top:0;right:0;bottom:0;left:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.04) 50%,transparent 70%) var(--ts-surface,#1c1c1c);background-size:200% 100%;animation:tsh-sk 1.4s linear infinite}',
    '@keyframes tsh-sk{to{background-position:-200% 0}}',
    '@media (max-width:700px){.tsh{height:66vh;height:clamp(380px,66vh,620px)}.tsh-info{bottom:12%}.tsh-ov{display:none}.tsh-dots{left:4.5vw;right:auto;bottom:4%}.tsh-arrow{display:none}.tsh-btn{padding:.65em 1.2em}}',
    '@media (prefers-reduced-motion:reduce){.tsh-slide.on .tsh-bg{animation:none}.tsh-slide{transition:none}}',
  ].join('\n');

  var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>';
  var ICON_INFO = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  var ICON_PREV = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>';
  var ICON_NEXT = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z"/></svg>';

  var HERO_FIELDS = 'Overview,Genres,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks,ParentBackdropItemId,ParentBackdropImageTags,ParentLogoItemId,ParentLogoImageTag,SeriesName,ParentIndexNumber,IndexNumber,UserData,RemoteTrailers';
  var HERO_INTERVAL = 9000;
  var HERO_TTL = 120000;

  var hero = { el: null, items: [], idx: 0, timer: null, loadedAt: 0, loading: false, key: '' };

  function heroEnabled() {
    if (!state.boot || !state.userId) return false;
    var sel = state.activeSelection;
    if (state.boot.allowUserThemes && sel && typeof sel.homeHero === 'boolean') return sel.homeHero;
    return state.boot.showHomeHero !== false;
  }

  function homeSections() {
    var pages = document.querySelectorAll('#indexPage, .homePage');
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].classList.contains('hide')) continue;
      var c = pages[i].querySelector('.homeSectionsContainer');
      if (c && c.offsetParent !== null) return c;
    }
    return null;
  }

  var heroTimer = null;
  function heroSoon(force) {
    if (force) hero.loadedAt = 0;
    clearTimeout(heroTimer);
    heroTimer = setTimeout(heroSync, 50);
  }

  function heroSync() {
    var target = heroEnabled() ? homeSections() : null;
    if (!target) {
      if (hero.el && (!heroEnabled() || !document.body.contains(hero.el) || hero.el.offsetParent === null)) {
        if (!heroEnabled()) { hero.el.remove(); hero.el = null; }
        stopHero();
        stopTrailer();
      }
      return;
    }
    ensureUiCss();
    if (!hero.el) {
      hero.el = document.createElement('section');
      hero.el.className = 'tsh';
      hero.el.setAttribute('aria-roledescription', 'carrousel');
      hero.el.setAttribute('aria-label', 'À la une');
      hero.el.innerHTML = '<div class="tsh-skeleton"></div>';
      hero.el.addEventListener('click', onHeroClick);
      hero.el.addEventListener('mouseenter', function () { hero.hover = true; });
      hero.el.addEventListener('mouseleave', function () { hero.hover = false; });
      hero.el.addEventListener('keydown', function (e) {
        if (e.target.closest && e.target.closest('.tsh-btns')) return;
        if (e.key === 'ArrowRight') { showSlide(hero.idx + 1); startHero(); }
        if (e.key === 'ArrowLeft') { showSlide(hero.idx - 1); startHero(); }
      });
    }
    // Always the very first block of the home tab, above any rows other plugins
    // (e.g. Genre Collections) insert before the native sections.
    var tab = target.parentNode;
    if (tab.firstElementChild !== hero.el) {
      tab.insertBefore(hero.el, tab.firstChild);
      layoutHero();
    }
    if (hero.items.length && hero.mode !== cardMode()) renderHero();
    var key = state.userId + '|' + (state.boot.homeHeroSource || 'mixed');
    if (key !== hero.key || Date.now() - hero.loadedAt > HERO_TTL) loadHero(key);
    if (!hero.timer && hero.items.length > 1) startHero();
  }

  // Full-bleed: stretch to the window edges and slide under the (glass) header.
  // With the side bar it becomes a featured card next to tall posters instead.
  function cardMode() { return document.documentElement.classList.contains('ts-side'); }

  function layoutHero() {
    var el = hero.el;
    if (!el) return;
    el.classList.toggle('tsh-card', cardMode());
    if (cardMode()) {
      el.style.marginLeft = el.style.marginRight = el.style.marginTop = el.style.width = '';
      return;
    }
    el.style.marginRight = '';
    bleed(el);
  }
  window.addEventListener('resize', function () { if (hero.el && hero.el.offsetParent) layoutHero(); });

  function jf(path, params) {
    var c = api();
    var headers = { Accept: 'application/json' };
    var token = c.accessToken && c.accessToken();
    if (token) headers.Authorization = 'MediaBrowser Token="' + token + '"';
    return fetch(c.getUrl(path, params), { headers: headers }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function loadResume() {
    var params = { userId: state.userId, limit: 8, fields: HERO_FIELDS, mediaTypes: 'Video', enableImageTypes: 'Backdrop,Logo,Primary,Thumb', imageTypeLimit: 1 };
    return jf('UserItems/Resume', params)
      .catch(function () { return jf('Users/' + state.userId + '/Items/Resume', params); })
      .then(function (r) { return (r.Items || []).map(function (i) { i._ts = 'resume'; return i; }); })
      .catch(function () { return []; });
  }

  function loadLatest() {
    return jf('Items', {
      userId: state.userId, sortBy: 'DateCreated', sortOrder: 'Descending', includeItemTypes: 'Movie,Series',
      recursive: true, limit: 12, fields: HERO_FIELDS, imageTypes: 'Backdrop', enableImageTypes: 'Backdrop,Logo,Primary', imageTypeLimit: 1,
    }).then(function (r) { return (r.Items || []).map(function (i) { i._ts = 'latest'; return i; }); })
      .catch(function () { return []; });
  }

  function loadHero(key) {
    if (hero.loading) return;
    hero.loading = true;
    hero.key = key;
    var src = state.boot.homeHeroSource || 'mixed';
    Promise.all([src === 'latest' ? [] : loadResume(), src === 'resume' ? [] : loadLatest()]).then(function (res) {
      var seen = {};
      var items = [];
      res[0].slice(0, src === 'mixed' ? 4 : 8).concat(res[1]).forEach(function (i) {
        var k = i.SeriesId || i.Id;
        if (seen[k] || !backdropUrl(i)) return;
        seen[k] = true;
        items.push(i);
      });
      hero.items = items.slice(0, 8);
      hero.loadedAt = Date.now();
      renderHero();
    }).finally(function () { hero.loading = false; });
  }

  function img(id, type, tag, maxWidth) {
    return api().getUrl('Items/' + id + '/Images/' + type + (type === 'Backdrop' ? '/0' : ''), { tag: tag, maxWidth: maxWidth, quality: 85 });
  }

  function backdropUrl(i) {
    var w = Math.min(2560, Math.round((window.innerWidth || 1920) * (window.devicePixelRatio || 1)));
    if (i.BackdropImageTags && i.BackdropImageTags.length) return img(i.Id, 'Backdrop', i.BackdropImageTags[0], w);
    if (i.ParentBackdropItemId && i.ParentBackdropImageTags && i.ParentBackdropImageTags.length) return img(i.ParentBackdropItemId, 'Backdrop', i.ParentBackdropImageTags[0], w);
    return null;
  }

  function logoUrl(i) {
    if (i.ImageTags && i.ImageTags.Logo && i.Type !== 'Episode') return img(i.Id, 'Logo', i.ImageTags.Logo, 800);
    if (i.ParentLogoItemId && i.ParentLogoImageTag) return img(i.ParentLogoItemId, 'Logo', i.ParentLogoImageTag, 800);
    return null;
  }

  function runtime(ticks) {
    if (!ticks) return '';
    var m = Math.round(ticks / 600000000);
    return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' min' : '') : m + ' min';
  }

  function slideHtml(i, n) {
    var isEp = i.Type === 'Episode';
    var title = isEp ? (i.SeriesName || i.Name) : i.Name;
    var logo = logoUrl(i);
    var ud = i.UserData || {};
    var pct = ud.PlayedPercentage || 0;
    var resume = i._ts === 'resume' && pct > 0;
    var meta = [];
    if (i.CommunityRating) meta.push('<span class="tsh-star">★ ' + esc(Number(i.CommunityRating).toFixed(1)) + '</span>');
    if (i.ProductionYear) meta.push('<span>' + esc(i.ProductionYear) + '</span>');
    if (i.OfficialRating) meta.push('<span class="tsh-pill">' + esc(i.OfficialRating) + '</span>');
    if (i.RunTimeTicks && !isEp && i.Type !== 'Series') meta.push('<span>' + esc(runtime(i.RunTimeTicks)) + '</span>');
    if (i.Genres && i.Genres.length) meta.push('<span>' + esc(i.Genres.slice(0, 3).join(' · ')) + '</span>');
    var left = resume && i.RunTimeTicks ? runtime(i.RunTimeTicks * (1 - pct / 100)) : '';
    return '<div class="tsh-slide' + (n === hero.idx ? ' on' : '') + '" role="group" aria-roledescription="diapositive" aria-label="' + esc(title) + '">' +
      '<img class="tsh-bg" alt="" src="' + esc(backdropUrl(i)) + '"' + (n === 0 ? '' : ' loading="lazy"') + '>' +
      '<div class="tsh-trailer" aria-hidden="true"></div>' +
      '<div class="tsh-shade"></div>' +
      '<div class="tsh-info">' +
      '<div class="tsh-tag">' + (resume ? 'Reprendre' : i._ts === 'resume' ? 'À suivre' : 'Nouveauté') + '</div>' +
      (logo ? '<img class="tsh-logo" alt="' + esc(title) + '" src="' + esc(logo) + '">' : '<h2 class="tsh-title">' + esc(title) + '</h2>') +
      (isEp ? '<p class="tsh-sub">' + (i.ParentIndexNumber != null ? 'S' + esc(i.ParentIndexNumber) + ' · É' + esc(i.IndexNumber) + ' · ' : '') + esc(i.Name) + '</p>' : '') +
      (meta.length ? '<div class="tsh-meta">' + meta.join('') + '</div>' : '') +
      (resume ? '<div class="tsh-progress"><span><i style="width:' + Math.round(pct) + '%"></i></span>' + (left ? esc(left) + ' restantes' : '') + '</div>' : '') +
      (i.Overview ? '<p class="tsh-ov">' + esc(i.Overview) + '</p>' : '') +
      '<div class="tsh-btns">' +
      '<button type="button" class="tsh-btn tsh-play" data-play="' + esc(i.Id) + '" data-server="' + esc(i.ServerId || '') + '">' + ICON_PLAY + (resume ? 'Reprendre' : 'Lecture') + '</button>' +
      '<button type="button" class="tsh-btn tsh-more" data-info="' + esc(i.Id) + '" data-server="' + esc(i.ServerId || '') + '">' + ICON_INFO + 'Plus d\'infos</button>' +
      '<button type="button" class="tsh-round tsh-fav" data-fav="' + esc(favId(i)) + '" aria-pressed="' + !!favState(i) + '" title="Ma liste" aria-label="' + (favState(i) ? 'Retirer de mes favoris' : 'Ajouter à mes favoris') + '">' + (favState(i) ? ICON_CHECK : ICON_PLUS) + '</button>' +
      '</div></div>' +
      '<button type="button" class="tsh-round tsh-mute" data-mute="1" hidden title="Son" aria-label="Activer le son">' + ICON_MUTED + '</button>' +
      '</div>';
  }

  function renderHero() {
    if (!hero.el) return;
    stopHero();
    if (!hero.items.length) { hero.el.remove(); hero.el = null; return; }
    if (hero.idx >= hero.items.length) hero.idx = 0;
    hero.mode = cardMode();
    layoutHero();
    var html = '<div class="tsh-stage">' + hero.items.map(slideHtml).join('');
    if (hero.items.length > 1) {
      html += '<button type="button" class="tsh-arrow tsh-prev" data-step="-1" aria-label="Précédent">' + ICON_PREV + '</button>' +
        '<button type="button" class="tsh-arrow tsh-next" data-step="1" aria-label="Suivant">' + ICON_NEXT + '</button><div class="tsh-dots">';
      hero.items.forEach(function (_, n) {
        html += '<button type="button" class="tsh-dot' + (n === hero.idx ? ' on' : '') + '" data-go="' + n + '" aria-label="Diapositive ' + (n + 1) + '"></button>';
      });
      html += '</div>';
    }
    html += '</div><div class="tsh-aside" aria-label="À suivre"></div>';
    hero.el.innerHTML = html;
    renderAside();
    // A broken logo falls back to the text title.
    hero.el.querySelectorAll('.tsh-logo').forEach(function (logo) {
      logo.addEventListener('error', function () {
        var h = document.createElement('h2');
        h.className = 'tsh-title';
        h.textContent = logo.alt;
        logo.replaceWith(h);
      });
    });
    startHero();
    scheduleTrailer();
  }

  function showSlide(n) {
    if (!hero.el || !hero.items.length) return;
    hero.idx = (n + hero.items.length) % hero.items.length;
    hero.el.querySelectorAll('.tsh-slide').forEach(function (s, k) { s.classList.toggle('on', k === hero.idx); });
    hero.el.querySelectorAll('.tsh-dot').forEach(function (d, k) { d.classList.toggle('on', k === hero.idx); });
    renderAside();
    scheduleTrailer();
  }

  function posterUrl(i) {
    if (i.Type === 'Episode' && i.SeriesId && i.SeriesPrimaryImageTag) return img(i.SeriesId, 'Primary', i.SeriesPrimaryImageTag, 480);
    if (i.ImageTags && i.ImageTags.Primary) return img(i.Id, 'Primary', i.ImageTags.Primary, 480);
    return null;
  }

  function asideImage(i) {
    var w = 700;
    if (i.BackdropImageTags && i.BackdropImageTags.length) return img(i.Id, 'Backdrop', i.BackdropImageTags[0], w);
    if (i.ParentBackdropItemId && i.ParentBackdropImageTags && i.ParentBackdropImageTags.length) return img(i.ParentBackdropItemId, 'Backdrop', i.ParentBackdropImageTags[0], w);
    return posterUrl(i);
  }

  // Next titles as tall posters beside the featured card; a click brings one to the front.
  function renderAside() {
    var box = hero.el && hero.el.querySelector('.tsh-aside');
    if (!box) return;
    var html = '';
    for (var k = 1; k <= 3 && k < hero.items.length; k++) {
      var n = (hero.idx + k) % hero.items.length;
      var i = hero.items[n];
      var title = i.Type === 'Episode' ? (i.SeriesName || i.Name) : i.Name;
      // Backdrop + logo, like the reference: posters already carry their title, which doubled it.
      var p = asideImage(i);
      var logo = logoUrl(i);
      var sub = i.Type === 'Episode' && i.ParentIndexNumber != null ? 'S' + i.ParentIndexNumber + ' · É' + i.IndexNumber : (i.Genres || []).slice(0, 2).join(' · ');
      html += '<button type="button" class="tsh-ac" data-go="' + n + '" aria-label="' + esc(title) + '">' +
        (p ? '<img class="tsh-acimg" alt="" loading="lazy" src="' + esc(p) + '">' : '') +
        '<span class="tsh-accap">' + (logo ? '<img class="tsh-aclogo" alt="" loading="lazy" src="' + esc(logo) + '">' : '<strong>' + esc(title) + '</strong>') +
        (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span></button>';
    }
    box.innerHTML = html;
    box.querySelectorAll('img').forEach(function (im) { im.addEventListener('error', function () { im.remove(); }); });
  }

  function startHero() {
    stopHero();
    if (hero.items.length < 2) return;
    hero.timer = setInterval(function () {
      if (!hero.el || hero.el.offsetParent === null || hero.hover || document.hidden) return;
      if (hero.el.contains(document.activeElement)) return;
      if (trailer.playing && Date.now() - trailer.startedAt < 60000) return;
      showSlide(hero.idx + 1);
    }, HERO_INTERVAL);
  }

  function stopHero() {
    if (hero.timer) clearInterval(hero.timer);
    hero.timer = null;
  }

  function detailsHash(id, serverId) {
    return '#/details?id=' + encodeURIComponent(id) + (serverId ? '&serverId=' + encodeURIComponent(serverId) : '');
  }

  function onHeroClick(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    if (b.dataset.step) { showSlide(hero.idx + Number(b.dataset.step)); startHero(); return; }
    if (b.dataset.go) { showSlide(Number(b.dataset.go)); startHero(); return; }
    if (b.dataset.info) { location.hash = detailsHash(b.dataset.info, b.dataset.server); return; }
    if (b.dataset.fav) { toggleFavorite(b); return; }
    if (b.dataset.mute) { toggleMute(b); return; }
    if (b.dataset.play) {
      // Jellyfin Web has no public playback API for scripts: open the item and press its Play button.
      try { sessionStorage.setItem('themestudio:autoplay', JSON.stringify({ id: b.dataset.play, at: Date.now() })); } catch (err) { /* ignore */ }
      location.hash = detailsHash(b.dataset.play, b.dataset.server);
      waitAutoplay();
    }
  }

  /* --- Hero: "Ma liste" (favorites) and muted trailers --- */

  var ICON_PLUS = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';
  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 10-10-1.4-1.4z"/></svg>';
  var ICON_MUTED = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>';
  var ICON_SOUND = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';

  // Episodes go to the series' favorites, like on streaming services.
  function favId(i) { return i.Type === 'Episode' && i.SeriesId ? i.SeriesId : i.Id; }
  function favState(i) { return i.Type === 'Episode' ? !!i._seriesFav : !!(i.UserData && i.UserData.IsFavorite); }

  function toggleFavorite(btn) {
    var c = api();
    var id = btn.dataset.fav;
    var on = btn.getAttribute('aria-pressed') !== 'true';
    var headers = { Accept: 'application/json' };
    var token = c.accessToken && c.accessToken();
    if (token) headers.Authorization = 'MediaBrowser Token="' + token + '"';
    function call(path) { return fetch(c.getUrl(path, { userId: state.userId }), { method: on ? 'POST' : 'DELETE', headers: headers }); }
    btn.disabled = true;
    call('UserFavoriteItems/' + id)
      .then(function (r) { return r.ok ? r : call('Users/' + state.userId + '/FavoriteItems/' + id); })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        hero.items.forEach(function (i) {
          if (favId(i) !== id) return;
          if (i.Type === 'Episode') i._seriesFav = on;
          else { i.UserData = i.UserData || {}; i.UserData.IsFavorite = on; }
        });
        if (dx.item && dx.item.Id === id) { dx.item.UserData = dx.item.UserData || {}; dx.item.UserData.IsFavorite = on; }
        document.querySelectorAll('[data-fav="' + id + '"]').forEach(function (b) {
          b.setAttribute('aria-pressed', String(on));
          b.innerHTML = on ? ICON_CHECK : ICON_PLUS;
          b.setAttribute('aria-label', on ? 'Retirer de mes favoris' : 'Ajouter à mes favoris');
        });
      })
      .catch(function (e) { console.warn('[ThemeStudio] favorite', e); })
      .finally(function () { btn.disabled = false; });
  }

  var trailer = { timer: null, frame: null, playing: false, startedAt: 0, muted: true, slide: null };

  function trailersAllowed() {
    if (!state.boot || state.boot.homeHeroTrailers === false) return false;
    if (isTv()) return false;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    if (navigator.connection && navigator.connection.saveData) return false;
    return (window.innerWidth || 0) >= 700;
  }

  function youtubeId(item) {
    var list = item.RemoteTrailers || [];
    for (var k = 0; k < list.length; k++) {
      var m = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(list[k].Url || '');
      if (m) return m[1];
    }
    return null;
  }

  function stopTrailer() {
    clearTimeout(trailer.timer);
    trailer.timer = null;
    if (trailer.frame) trailer.frame.remove();
    if (trailer.slide) {
      trailer.slide.classList.remove('tsh-playing');
      var mb = trailer.slide.querySelector('.tsh-mute');
      if (mb) mb.hidden = true;
    }
    trailer.frame = null;
    trailer.slide = null;
    trailer.playing = false;
  }

  function scheduleTrailer() {
    stopTrailer();
    if (!hero.el || !trailersAllowed()) return;
    var item = hero.items[hero.idx];
    var vid = item && youtubeId(item);
    if (!vid) return;
    // Let the backdrop show first, like streaming apps do.
    trailer.timer = setTimeout(function () { startTrailer(vid); }, 3500);
  }

  function startTrailer(vid) {
    if (!hero.el || hero.el.offsetParent === null || document.hidden) return;
    var slide = hero.el.querySelectorAll('.tsh-slide')[hero.idx];
    var host = slide && slide.querySelector('.tsh-trailer');
    if (!host) return;
    var f = document.createElement('iframe');
    f.src = 'https://www.youtube-nocookie.com/embed/' + vid + '?autoplay=1&mute=1&controls=0&disablekb=1&fs=0&loop=1&playlist=' + vid +
      '&modestbranding=1&playsinline=1&rel=0&iv_load_policy=3&start=8&enablejsapi=1&origin=' + encodeURIComponent(location.origin);
    f.allow = 'autoplay; encrypted-media';
    f.title = 'Bande-annonce';
    f.tabIndex = -1;
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.addEventListener('load', function () {
      // Ask the player to report its state; it is only shown once it really plays.
      try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'ts' }), '*'); } catch (e) { /* ignore */ }
    });
    // Cover the banner like background-size:cover, and crop YouTube's title bar and edges.
    var r = slide.getBoundingClientRect();
    var w = Math.max(r.width, r.height * 16 / 9) * 1.2;
    f.style.width = Math.ceil(w) + 'px';
    f.style.height = Math.ceil(w * 9 / 16) + 'px';
    host.appendChild(f);
    trailer.frame = f;
    trailer.slide = slide;
    trailer.muted = true;
  }

  function ytCommand(func, args) {
    if (!trailer.frame) return;
    try { trailer.frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [] }), '*'); } catch (e) { /* ignore */ }
  }

  window.addEventListener('message', function (e) {
    if (!trailer.frame || e.source !== trailer.frame.contentWindow) return;
    var data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (err) { return; }
    if (!data) return;
    var playerState = data.event === 'onStateChange' ? data.info : (data.info && data.info.playerState);
    if (data.event === 'onError') { stopTrailer(); return; }
    if (playerState === 1 && !trailer.playing) {
      trailer.playing = true;
      trailer.startedAt = Date.now();
      trailer.slide.classList.add('tsh-playing');
      var mb = trailer.slide.querySelector('.tsh-mute');
      if (mb) mb.hidden = false;
    } else if (playerState === 0) {
      // Ended: back to the backdrop and on to the next title.
      stopTrailer();
      if (hero.items.length > 1) showSlide(hero.idx + 1);
    }
  });

  function toggleMute(btn) {
    trailer.muted = !trailer.muted;
    ytCommand(trailer.muted ? 'mute' : 'unMute');
    if (!trailer.muted) ytCommand('setVolume', [60]);
    btn.innerHTML = trailer.muted ? ICON_MUTED : ICON_SOUND;
    btn.setAttribute('aria-label', trailer.muted ? 'Activer le son' : 'Couper le son');
  }

  document.addEventListener('visibilitychange', function () { if (document.hidden) stopTrailer(); });


  function waitAutoplay() {
    var started = Date.now();
    (function tick() {
      var job;
      try { job = JSON.parse(sessionStorage.getItem('themestudio:autoplay') || 'null'); } catch (err) { job = null; }
      if (!job || Date.now() - job.at > 15000) { try { sessionStorage.removeItem('themestudio:autoplay'); } catch (err) { /* ignore */ } return; }
      var page = document.querySelector('#itemDetailPage:not(.hide)') || document.querySelector('.itemDetailPage:not(.hide)');
      var onItem = location.href.indexOf(encodeURIComponent(job.id)) >= 0 || location.href.indexOf(job.id) >= 0;
      var btn = page && onItem && page.querySelector('.btnPlay:not(.hide), .btnResume:not(.hide)');
      if (btn && btn.offsetParent !== null) {
        try { sessionStorage.removeItem('themestudio:autoplay'); } catch (err) { /* ignore */ }
        btn.click();
        return;
      }
      if (Date.now() - started < 15000) setTimeout(tick, 250);
    })();
  }


  /* ------------------------------------------------ Streaming layout (v1.4) */
  // Side bar on desktop, featured-card home and full-screen detail pages for
  // movies and series. Nothing here runs on TV (layout-tv): old TV browsers get
  // the lighter engine.css rules only, and remote focus stays with Jellyfin.

  var SIDE_W = 76; // collapsed: icons only
  var SIDE_OPEN = 248; // on hover or keyboard focus, over the page
  var ICONS = {
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
    movies: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
    tvshows: 'M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z',
    music: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
    books: 'M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z',
    boxsets: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z',
    playlists: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z',
    folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
    admin: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
    check: 'm9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 10-10-1.4-1.4z',
    trailer: 'M18 3v2h-2V3H8v2H6V3H4v18h2v-2h2v2h8v-2h2v2h2V3h-2zM8 17H6v-2h2v2zm0-4H6v-2h2v2zm0-4H6V7h2v2zm10 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2z',
  };
  function icon(name) { return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="' + (ICONS[name] || ICONS.folder) + '"/></svg>'; }

  var LAYOUT_CSS = [
    /* side bar */
    '#ts-side{display:none}',
    'html.ts-side #ts-side{position:fixed;top:0;left:0;bottom:0;width:' + SIDE_W + 'px;z-index:1200;display:flex;flex-direction:column;box-sizing:border-box;padding:20px 12px 14px;overflow-x:hidden;overflow-y:auto;scrollbar-width:none;transition:width .25s cubic-bezier(.2,.8,.2,1),background .25s,box-shadow .25s;color:var(--ts-text,#fff);font-family:var(--ts-font,inherit),system-ui,sans-serif;background:rgba(var(--ts-surface-rgb,24,24,24),.62);-webkit-backdrop-filter:blur(26px) saturate(1.5);backdrop-filter:blur(26px) saturate(1.5);border-right:1px solid rgba(255,255,255,.08);box-shadow:inset -1px 0 0 rgba(255,255,255,.03)}',
    'html.ts-side #ts-side:hover,html.ts-kbd.ts-side #ts-side:focus-within,html.layout-tv.ts-side #ts-side:focus-within{width:' + SIDE_OPEN + 'px;background:rgba(var(--ts-surface-rgb,24,24,24),.92);box-shadow:20px 0 60px rgba(0,0,0,.55)}',
    '.tss-l{opacity:0;transition:opacity .2s ease;white-space:nowrap}',
    '#ts-side:hover .tss-l,html.ts-kbd #ts-side:focus-within .tss-l,html.layout-tv #ts-side:focus-within .tss-l{opacity:1}',
    '.tss-h{opacity:0;transition:opacity .2s;white-space:nowrap}',
    '#ts-side:hover .tss-h,html.ts-kbd #ts-side:focus-within .tss-h,html.layout-tv #ts-side:focus-within .tss-h{opacity:1}',
    /* Jellyfin pages are positioned on their own, so the offset goes on each page, not on <body>. */
    'html.ts-side .page,html.ts-side [data-role=page]{padding-left:' + SIDE_W + 'px!important;box-sizing:border-box}',
    'html.ts-side.ts-home #indexPage,html.ts-side.ts-home .homePage{padding-top:1.4em!important}',
    /* the side bar replaces the top bar: only the right-hand icons stay, floating */
    'html.ts-side .skinHeader,html.ts-side .MuiAppBar-root{left:' + SIDE_W + 'px!important;width:auto!important;right:0!important;background:transparent!important;box-shadow:none!important;border:0!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;pointer-events:none}',
    'html.ts-side .skinHeader *,html.ts-side .MuiAppBar-root *{pointer-events:auto}',
    /* home: Accueil / Favoris are in the side bar; elsewhere keep the tabs but compact */
    'html.ts-side.ts-home .skinHeader .headerTabs,html.ts-side.ts-home .skinHeader .emby-tabs,html.ts-side.ts-home .skinHeader .sectionTabs,html.ts-side.ts-home .MuiAppBar-root .MuiTabs-root,html.ts-side.ts-home .skinHeader .tabs-viewmenubar,html.ts-side.ts-home .skinHeader [role=tablist],html.ts-side.ts-home .MuiAppBar-root [role=tablist]{display:none!important}',
    'html.ts-side .skinHeader .emby-tabs-slider{padding:2px!important}',
    'html.ts-side .skinHeader .emby-tab-button{font-size:.92em!important;padding:.45em 1.1em!important}',
    'html.ts-side .skinHeader .headerLeft>:not(.headerBackButton),html.ts-side .skinHeader .pageTitle,html.ts-side .MuiAppBar-root a[href="#/home"],html.ts-side .MuiAppBar-root a[href="#/"],html.ts-side .skinHeader a[href="#/home"],html.ts-side .skinHeader a[href*="topParentId"],html.ts-side .MuiAppBar-root a[href*="topParentId"],html.ts-side .skinHeader a[href*="parentId="],html.ts-side .MuiAppBar-root a[href*="parentId="],html.ts-side .skinHeader a[href*="tab=1"],html.ts-side .MuiAppBar-root a[href*="tab=1"],html.ts-side .MuiAppBar-root a[href*="favorites"],html.ts-side .skinHeader a[href*="favorites"]{display:none!important}',
    /* header icons live in the side bar now: keep them (hidden) so the side bar can press them */
    'html.ts-side .skinHeader .headerLeft,html.ts-side .skinHeader .headerRight,html.ts-side .MuiAppBar-root button:not([role=tab]),html.ts-side .MuiAppBar-root .MuiAvatar-root{visibility:hidden!important}',
    '.tss-ic{flex:0 0 20px;width:20px;height:20px;margin-right:14px;display:inline-grid;place-items:center;overflow:hidden;border-radius:50%;background-size:cover;background-position:center}',
    '.tss-ic .material-icons,.tss-ic span{font-size:20px!important;line-height:20px}',
    '.tss-ic svg{width:20px;height:20px;margin:0}',
    'button.tss-a{width:100%;border:0;background:none;font-family:inherit;cursor:pointer;text-align:left}',
    'html.ts-side .mainDrawerButton,html.ts-side .headerHomeButton{display:none!important}',
    '.tss-brand{display:flex;align-items:center;padding:4px 9px 18px;white-space:nowrap;color:inherit!important;text-decoration:none!important;font-size:1.35em;font-weight:800;letter-spacing:-.02em}',
    '.tss-brand b{flex:0 0 34px;display:inline-grid;place-items:center;width:34px;height:34px;margin-right:10px;border-radius:10px;background:var(--ts-accent,#00a4dc);color:var(--ts-bg,#000);font-size:.8em}',
    '.tss-search{display:flex;align-items:center;width:100%;margin:0 0 18px;padding:10px 14px;white-space:nowrap;overflow:hidden;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:rgba(255,255,255,.6);font:inherit;font-size:.95em;cursor:pointer;text-align:left}',
    '.tss-search:hover{background:rgba(255,255,255,.1);color:#fff}',
    '.tss-search svg{flex:0 0 18px;width:18px;height:18px;margin-right:12px}',
    '.tss-h{margin:14px 12px 6px;font-size:.78em;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ts-text-2,rgba(255,255,255,.55))}',
    '.tss-a{display:flex;align-items:center;margin:2px 0;padding:10px 14px;border-radius:12px;color:var(--ts-text-2,rgba(255,255,255,.72))!important;text-decoration:none!important;font-weight:600;font-size:.98em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .15s,color .15s}',
    '.tss-a svg{flex:0 0 20px;width:20px;height:20px;margin-right:14px;opacity:.9}',
    '.tss-a:hover{background:rgba(255,255,255,.07);color:var(--ts-text,#fff)!important}',
    '.tss-a.on{background:rgba(255,255,255,.12);color:var(--ts-text,#fff)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}',
    '.tss-a.on svg{color:var(--ts-accent,#00a4dc)}',
    '.tss-a:focus-visible,.tss-search:focus-visible{outline:2px solid var(--ts-accent,#00a4dc);outline-offset:2px}',
    /* TV: opaque (no blur on TV browsers), big focus highlight for the remote */
    'html.layout-tv.ts-side #ts-side{background:rgb(var(--ts-surface-rgb,24,24,24))}',
    'html.layout-tv .tss-a:focus,html.layout-tv .tss-search:focus,html.layout-tv .tss-brand:focus{background:var(--ts-accent,#00a4dc)!important;color:#fff!important;outline:0}',
    'html.layout-tv .tss-a:focus svg{color:#fff}',
    '.tss-foot{margin-top:auto;padding-top:14px;border-top:1px solid rgba(255,255,255,.08)}',
    /* home: posters with the title on the image */
    'html.ts-modern #indexPage .portraitCard .cardBox,html.ts-modern .genreCollectionsSections .portraitCard .cardBox{position:relative}',
    'html.ts-modern #indexPage .portraitCard .cardFooter,html.ts-modern .genreCollectionsSections .portraitCard .cardFooter{position:absolute;left:0;right:0;bottom:0;z-index:3;margin:0!important;padding:3em .75em .7em!important;text-align:left!important;background:linear-gradient(to top,rgba(0,0,0,.92),rgba(0,0,0,.55) 55%,rgba(0,0,0,0));border-radius:0 0 var(--ts-radius,8px) var(--ts-radius,8px);pointer-events:none}',
    'html.ts-modern #indexPage .portraitCard .cardText,html.ts-modern .genreCollectionsSections .portraitCard .cardText{color:rgba(255,255,255,.72)!important;font-size:.8em;padding:0!important;text-shadow:0 1px 6px rgba(0,0,0,.6)}',
    'html.ts-modern #indexPage .portraitCard .cardText-first,html.ts-modern .genreCollectionsSections .portraitCard .cardText-first{color:#fff!important;font-size:.98em;font-weight:800;letter-spacing:.01em;text-transform:uppercase}',
    'html.ts-modern #indexPage .portraitCard .cardBox-bottompadded,html.ts-modern .genreCollectionsSections .portraitCard .cardBox-bottompadded{padding-bottom:0!important;margin-bottom:.4em}',
    'html.ts-modern #indexPage .portraitCard .cardImageContainer,html.ts-modern .genreCollectionsSections .portraitCard .cardImageContainer{border-radius:var(--ts-radius,8px)}',
    /* hero as a featured card next to tall posters */
    '.tsh-stage{position:absolute;top:0;right:0;bottom:0;left:0}',
    '.tsh-aside{display:none}',
    '.tsh.tsh-card{height:auto;overflow:visible;background:none;display:flex;margin:.4em 3.3% 1.8em}',
    '.tsh-card .tsh-stage{position:relative;flex:1 1 auto;min-width:0;height:52vh;height:clamp(340px,52vh,620px);border-radius:22px;overflow:hidden;border:1px solid rgba(255,255,255,.1);box-shadow:0 24px 60px -20px rgba(0,0,0,.7);background:var(--ts-surface,#1c1c1c)}',
    '.tsh-card .tsh-info{left:2.4em;bottom:2.2em;width:auto;right:40%;min-width:320px}',
    '.tsh-card .tsh-dots{right:1.8em;bottom:1.8em}',
    '.tsh-card .tsh-mute{right:1.8em;bottom:4em}',
    '.tsh-card .tsh-logo{max-height:100px;max-height:min(110px,13vh);max-width:60%}',
    '.tsh-card .tsh-title{font-size:2.4em;font-size:clamp(1.7em,2.8vw,2.6em)}',
    '.tsh-card .tsh-meta{font-size:.9em;margin-bottom:.5em}',
    '.tsh-card .tsh-tag{margin-bottom:.6em}',
    '@media (max-height:820px),(max-width:1300px){.tsh-card .tsh-ov{display:none}.tsh-card .tsh-progress{margin-bottom:.8em}}',
    '@media (max-width:1300px){.tsh.tsh-card .tsh-info{right:8%!important;left:1.6em;bottom:1.6em}}',
    '@media (max-width:1050px){.tsh-card .tsh-aside{display:none}}',
    '.tsh.tsh-card .tsh-info{background:none!important;border:0!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;padding:0!important}',
    '.tsh-card .tsh-shade{background:linear-gradient(to right,rgba(0,0,0,.85) 0%,rgba(0,0,0,.55) 38%,rgba(0,0,0,0) 70%),linear-gradient(to top,rgba(0,0,0,.6) 0%,rgba(0,0,0,0) 45%)}',
    '.tsh-card .tsh-info{right:18%}',
    '.tsh-card .tsh-btn{padding:.6em 1.25em;font-size:.98em}',
    '.tsh-card .tsh-ov{-webkit-line-clamp:2}',
    '.tsh-card .tsh-aside{display:flex}',
    '.tsh-ac{position:relative;flex:0 0 auto;width:13vw;max-width:240px;min-width:150px;margin-left:16px;padding:0;border-radius:20px;overflow:hidden;cursor:pointer;border:1px solid rgba(255,255,255,.1);background:var(--ts-surface,#222);color:#fff;font:inherit;text-align:left;box-shadow:0 18px 40px -18px rgba(0,0,0,.7);transition:transform .25s ease,border-color .25s}',
    '.tsh-ac:hover{transform:translateY(-4px);border-color:rgba(255,255,255,.35)}',
    '.tsh-ac:focus-visible{outline:3px solid var(--ts-accent,#00a4dc);outline-offset:3px}',
    '.tsh-ac img.tsh-acimg{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;object-position:center 30%}',
    '.tsh-ac span.tsh-accap{position:absolute;left:0;right:0;bottom:0;padding:4em 1em 1em;background:linear-gradient(to top,rgba(0,0,0,.95),rgba(0,0,0,.6) 50%,rgba(0,0,0,0))}',
    '.tsh-ac img.tsh-aclogo{display:block;max-width:90%;max-height:54px;object-fit:contain;object-position:left bottom;margin-bottom:.45em}',
    '.tsh-ac strong{display:block;font-size:1.05em;font-weight:800;text-transform:uppercase;line-height:1.1;margin-bottom:.35em}',
    '.tsh-ac small{display:block;font-size:.8em;color:rgba(255,255,255,.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '@media (max-width:1500px){.tsh-ac:nth-child(3){display:none}}',
    '@media (max-width:1200px){.tsh-ac:nth-child(2){display:none}}',
    /* detail pages */
    '.ts-dx-hide{display:none!important}',
    '.tsd{position:relative;min-height:92vh;display:flex;flex-direction:column;justify-content:flex-end;box-sizing:border-box;padding:7em 4.5vw 2.2em;color:#fff;isolation:isolate;overflow:hidden;font-family:var(--ts-font,inherit),system-ui,sans-serif}',
    '.tsd-bg{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;object-position:center 18%;z-index:-2;animation:tsd-in 1s ease both}',
    '.tsd-bg.blur{filter:blur(28px) brightness(.7);transform:scale(1.1)}',
    '@keyframes tsd-in{from{opacity:0;transform:scale(1.04)}to{opacity:1}}',
    '.tsd-shade{position:absolute;top:0;left:0;right:0;bottom:0;z-index:-1;background:linear-gradient(to right,rgba(0,0,0,.88) 0%,rgba(0,0,0,.6) 32%,rgba(0,0,0,0) 68%),linear-gradient(to top,var(--ts-bg,#101010) 0%,rgba(var(--ts-bg-rgb,16,16,16),.55) 30%,rgba(0,0,0,0) 58%),linear-gradient(to bottom,rgba(0,0,0,.55),rgba(0,0,0,0) 22%)}',
    '.tsd-info{max-width:640px;margin-bottom:1.6em}',
    '.tsd-logo{display:block;max-width:460px;max-width:min(460px,80%);max-height:170px;object-fit:contain;object-position:left bottom;margin:0 0 .8em;filter:drop-shadow(0 6px 28px rgba(0,0,0,.6))}',
    '.tsd-title{font-size:3.4em;font-size:clamp(2.2em,5vw,4.2em);font-weight:800;line-height:1;letter-spacing:-.02em;margin:0 0 .3em;text-shadow:0 2px 24px rgba(0,0,0,.5)}',
    '.tsd-meta{display:flex;flex-wrap:wrap;align-items:center;margin-bottom:.9em;font-weight:600;color:rgba(255,255,255,.9)}',
    '.tsd-meta>*{margin:0 1.1em .4em 0}',
    '.tsd-pill{border:1.5px solid rgba(255,255,255,.7);border-radius:999px;padding:.1em .75em;font-size:.88em}',
    '.tsd-star{color:#fbbf24;letter-spacing:.08em}',
    '.tsd-genres{display:flex;flex-wrap:wrap;margin:-.2em 0 .9em}',
    '.tsd-genres span{margin:0 .5em .4em 0;padding:.25em .8em;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.14);font-size:.85em;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}',
    '.tsd-tagline{font-style:italic;color:rgba(255,255,255,.75);margin:0 0 .5em}',
    '.tsd-ov{font-size:1.05em;line-height:1.55;color:rgba(255,255,255,.88);margin:0 0 1.5em;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;text-shadow:0 1px 10px rgba(0,0,0,.5)}',
    '.tsd-btns{display:flex;flex-wrap:wrap;align-items:center}',
    '.tsd-btns>*{margin:0 .9em .6em 0}',
    '.tsd-play{display:inline-flex;align-items:center;border:0;background:none;color:#fff;font:inherit;font-size:1.12em;font-weight:700;cursor:pointer;padding:0 .6em 0 0;margin-right:1.4em!important;text-align:left}',
    '.tsd-play i{display:inline-grid;place-items:center;width:3.3em;height:3.3em;margin-right:.75em;border-radius:50%;background:#fff;color:#000;box-shadow:0 10px 30px -6px rgba(0,0,0,.6);transition:transform .2s}',
    '.tsd-play i svg{width:1.6em;height:1.6em;margin-left:.15em}',
    '.tsd-play:hover i{transform:scale(1.08)}',
    '.tsd-play:focus-visible i,.tsd-round:focus-visible{outline:3px solid var(--ts-accent,#00a4dc);outline-offset:3px}',
    '.tsd-play small{display:block;font-size:.72em;font-weight:500;color:rgba(255,255,255,.7)}',
    '.tsd-round{display:inline-grid;place-items:center;width:2.9em;height:2.9em;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);transition:transform .15s,background .15s,border-color .15s}',
    '.tsd-round:hover{transform:scale(1.08);background:rgba(255,255,255,.2);border-color:#fff}',
    '.tsd-round svg{width:1.4em;height:1.4em}',
    '.tsd-round[aria-pressed=true]{color:var(--ts-accent,#00a4dc);border-color:var(--ts-accent,#00a4dc)}',
    '.tsd-eps{position:relative}',
    '.tsd-tabs{display:flex;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid rgba(255,255,255,.18);margin-bottom:1em}',
    '.tsd-tab{flex:0 0 auto;margin-right:2.2em;padding:.7em .2em;border:0;border-bottom:2px solid transparent;background:none;color:rgba(255,255,255,.62);font:inherit;font-size:1.05em;font-weight:600;cursor:pointer;margin-bottom:-1px;white-space:nowrap}',
    '.tsd-tab:hover{color:#fff}',
    '.tsd-tab[aria-selected=true]{color:#fff;border-bottom-color:var(--ts-accent,#00a4dc)}',
    '.tsd-tab:focus-visible{outline:2px solid var(--ts-accent,#00a4dc);outline-offset:2px}',
    '.tsd-row{display:flex;overflow-x:auto;padding:4px 2px 10px;scroll-snap-type:x proximity;scrollbar-width:thin}',
    '.tsd-ep{position:relative;flex:0 0 auto;width:20vw;min-width:230px;max-width:330px;height:11.25vw;min-height:129px;max-height:186px;margin-right:14px;padding:0;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.14);background:var(--ts-surface,#222);color:#fff;font:inherit;text-align:left;cursor:pointer;scroll-snap-align:start;transition:transform .2s ease,border-color .2s}',
    '.tsd-ep:hover{transform:translateY(-3px);border-color:rgba(255,255,255,.45)}',
    '.tsd-ep:focus-visible{outline:3px solid var(--ts-accent,#00a4dc);outline-offset:2px}',
    '.tsd-ep.next{border-color:var(--ts-accent,#00a4dc)}',
    '.tsd-ep img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover}',
    '.tsd-ep span.cap{position:absolute;left:0;right:0;bottom:0;padding:2.4em .9em .75em;background:linear-gradient(to top,rgba(0,0,0,.9),rgba(0,0,0,0));font-weight:700;font-size:.92em;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tsd-ep span.cap small{display:block;font-weight:500;color:rgba(255,255,255,.7);font-size:.85em}',
    '.tsd-ep b.bar{position:absolute;left:0;bottom:0;height:3px;background:var(--ts-accent,#00a4dc)}',
    '.tsd-ep i.seen{position:absolute;top:.5em;right:.5em;display:grid;place-items:center;width:1.7em;height:1.7em;border-radius:50%;background:var(--ts-accent,#00a4dc);color:#fff}',
    '.tsd-ep i.seen svg{width:1.1em;height:1.1em}',
    '.tsd-ep i.play{position:absolute;top:50%;left:50%;width:3em;height:3em;margin:-1.5em 0 0 -1.5em;display:grid;place-items:center;border-radius:50%;background:rgba(0,0,0,.5);opacity:0;transition:opacity .2s}',
    '.tsd-ep:hover i.play{opacity:1}',
    '.tsd-ep i.play svg{width:1.6em;height:1.6em}',
    '.tsd-empty{color:rgba(255,255,255,.6);padding:1em 0}',
    '@media (max-width:700px){.tsd{min-height:78vh;padding:5em 5vw 1.4em}.tsd-ov{-webkit-line-clamp:4}.tsd-ep{width:72vw;height:40.5vw}.tsd-logo{max-height:110px}}',
    '@media (prefers-reduced-motion:reduce){.tsd-bg{animation:none}}',
  ].join('\n');

  function htmlClass() { return document.documentElement.classList; }
  function isTv() { return htmlClass().contains('layout-tv'); }
  function layoutEnabled() { return !!(state.boot && state.userId && state.boot.modernLayout !== false); }

  function route() { return (location.hash || '').replace(/^#!?\/?/, ''); }
  function hashParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&]+)').exec(location.hash || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function ensureUiCss() {
    if (document.getElementById('theme-studio-hero-css')) return;
    var st = document.createElement('style');
    st.id = 'theme-studio-hero-css';
    st.textContent = HERO_CSS + '\n' + LAYOUT_CSS;
    document.head.insertBefore(st, document.head.firstChild);
  }

  /* --- Side bar --- */

  var side = { el: null, views: null, uid: null, loading: false, tools: [], toolSig: '' };

  function sideWanted() {
    if (!layoutEnabled() || htmlClass().contains('layout-mobile')) return false;
    if ((window.innerWidth || 0) < 1000) return false;
    if (/^(dashboard|configurationpage|login|selectserver|addserver|forgotpassword|wizard|startup|video|queue|nowplaying)/i.test(route())) return false;
    return !!document.querySelector('.skinHeader');
  }

  function sideWidth() { return htmlClass().contains('ts-side') ? SIDE_W : 0; }

  function loadViews() {
    if (side.loading || (side.views && side.uid === state.userId)) return;
    side.loading = true;
    jf('UserViews', { userId: state.userId })
      .catch(function () { return jf('Users/' + state.userId + '/Views'); })
      .then(function (r) { side.views = r.Items || []; side.uid = state.userId; renderSide(); })
      .catch(function () { side.views = []; side.uid = state.userId; })
      .finally(function () { side.loading = false; });
  }

  function viewHref(v) {
    // Prefer the link Jellyfin itself built in its drawer, so routes always match the server version.
    var a = document.querySelector('.mainDrawer a[href*="' + v.Id + '"]');
    if (a) return a.getAttribute('href');
    var t = (v.CollectionType || '').toLowerCase();
    if (t === 'movies') return '#/movies?topParentId=' + v.Id + '&collectionType=movies';
    if (t === 'tvshows') return '#/tv?topParentId=' + v.Id + '&collectionType=tvshows';
    if (t === 'music') return '#/music?topParentId=' + v.Id + '&collectionType=music';
    if (t === 'livetv') return '#/livetv';
    return '#/list?parentId=' + v.Id + (v.ServerId ? '&serverId=' + v.ServerId : '');
  }

  function viewIcon(v) {
    var t = (v.CollectionType || '').toLowerCase();
    if (t === 'livetv' || t === 'homevideos') return 'tvshows';
    return ICONS[t] ? t : 'folder';
  }

  function serverName() {
    try { var c = api(); var n = c && ((c.serverName && c.serverName()) || (c.serverInfo && c.serverInfo() && c.serverInfo().Name)); if (n) return n; } catch (e) { /* ignore */ }
    return 'Jellyfin';
  }

  function renderSide() {
    if (!side.el) return;
    var html = '<a class="tss-brand" href="#/home"><b>' + icon('movies').replace('<svg', '<svg width="18" height="18"') + '</b><span class="tss-l">' + esc(serverName()) + '</span></a>' +
      '<button type="button" class="tss-search" data-search="1">' + icon('search') + '<span class="tss-l">Rechercher…</span></button>' +
      '<a class="tss-a" data-k="home" href="#/home" title="Accueil">' + icon('home') + '<span class="tss-l">Accueil</span></a>' +
      '<a class="tss-a" data-k="fav" href="#/home?tab=1" title="Ma liste">' + icon('heart') + '<span class="tss-l">Ma liste</span></a>';
    var views = side.views || [];
    if (views.length) {
      html += '<div class="tss-h">Médiathèques</div>';
      views.forEach(function (v) {
        html += '<a class="tss-a" data-k="' + esc(v.Id) + '" href="' + esc(viewHref(v)) + '" title="' + esc(v.Name) + '">' + icon(viewIcon(v)) + '<span class="tss-l">' + esc(v.Name) + '</span></a>';
      });
    }
    html += '<div class="tss-foot"><div class="tss-tools"></div>' + (wantsButton() ? '<button type="button" class="tss-a" data-theme="1" title="Thèmes">' + PALETTE_SVG.replace('width="24" height="24"', '') + '<span class="tss-l">Thèmes</span></button>' : '') + '<a class="tss-a" data-k="prefs" href="#/mypreferencesmenu">' + icon('settings') + '<span class="tss-l">Paramètres</span></a>' +
      (state.boot && state.boot.isAdmin ? '<a class="tss-a" data-k="admin" href="#/dashboard">' + icon('admin') + '<span class="tss-l">Administration</span></a>' : '') + '</div>';
    side.el.innerHTML = html;
    side.toolSig = '';
    syncTools();
    markSide();
  }

  function markSide() {
    if (!side.el) return;
    var r = route();
    var key = /^home/.test(r) ? (/tab=1/.test(r) ? 'fav' : 'home') : /^mypreferences/.test(r) ? 'prefs' : (hashParam('topParentId') || hashParam('parentId') || '');
    side.el.querySelectorAll('.tss-a').forEach(function (a) {
      var on = a.getAttribute('data-k') === key;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  // Header icons (SyncPlay, cast, profile...) as side bar entries that press the native buttons.
  function headerTools() {
    var list = document.querySelectorAll('.skinHeader .headerRight button, .MuiAppBar-root button:not([role=tab])');
    var out = [];
    for (var k = 0; k < list.length; k++) {
      var b = list[k];
      if (b.classList.contains('hide') || b.classList.contains('themeStudioButton') || b.classList.contains('headerSearchButton') || b.classList.contains('headerBackButton') || b.classList.contains('mainDrawerButton')) continue;
      if (getComputedStyle(b).display === 'none') continue;
      var label = b.getAttribute('aria-label') || b.getAttribute('title') || '';
      if (/recherch|search/i.test(label)) continue;
      out.push(b);
    }
    return out;
  }

  function toolLabel(b) {
    var l = b.getAttribute('aria-label') || b.getAttribute('title') || '';
    if (b.classList.contains('headerUserButton') || /user|utilisateur|profil|account|compte/i.test(l + ' ' + b.className)) return l || 'Mon profil';
    if (b.classList.contains('headerCastButton') || /cast|remote|distance/i.test(l + ' ' + b.className)) return l || 'Diffuser sur un appareil';
    if (b.classList.contains('headerSyncButton') || /sync/i.test(l + ' ' + b.className)) return l || 'SyncPlay';
    return l || 'Action';
  }

  function syncTools() {
    var box = side.el && side.el.querySelector('.tss-tools');
    if (!box) return;
    var tools = headerTools();
    var sig = tools.map(function (b) { return b.className + '|' + toolLabel(b) + '|' + (b.getAttribute('style') || '') + '|' + b.innerHTML.length; }).join(';');
    if (sig === side.toolSig && box.childNodes.length === tools.length) return;
    side.toolSig = sig;
    side.tools = tools;
    box.innerHTML = '';
    tools.forEach(function (b, k) {
      var a = document.createElement('button');
      a.type = 'button';
      a.className = 'tss-a';
      a.setAttribute('data-tool', String(k));
      a.title = toolLabel(b);
      var ic = document.createElement('span');
      ic.className = 'tss-ic';
      ic.innerHTML = b.innerHTML;
      var bg = b.style && b.style.backgroundImage;
      if (bg && bg !== 'none') ic.style.backgroundImage = bg;
      var l = document.createElement('span');
      l.className = 'tss-l';
      l.textContent = toolLabel(b);
      a.appendChild(ic);
      a.appendChild(l);
      box.appendChild(a);
    });
  }

  function sideSync() {
    var want = sideWanted();
    htmlClass().toggle('ts-side', want);
    htmlClass().toggle('ts-home', /^home/.test(route()));
    if (!want) return;
    ensureUiCss();
    if (!side.el) {
      side.el = document.createElement('nav');
      side.el.id = 'ts-side';
      side.el.setAttribute('aria-label', 'Navigation principale');
      side.el.addEventListener('click', function (e) {
        // A mouse click must not leave the bar open through keyboard focus.
        if (e.target.closest && e.target.closest('a') && !isTv()) setTimeout(function () { if (document.activeElement && side.el.contains(document.activeElement)) document.activeElement.blur(); }, 0);
        var th = e.target.closest ? e.target.closest('[data-theme]') : null;
        if (th) { open(); return; }
        var tool = e.target.closest ? e.target.closest('[data-tool]') : null;
        if (tool) { var nb = side.tools[Number(tool.getAttribute('data-tool'))]; if (nb && document.body.contains(nb)) nb.click(); return; }
        var b = e.target.closest ? e.target.closest('[data-search]') : null;
        if (!b) return;
        var native = document.querySelector('.headerSearchButton');
        if (native) native.click(); else location.hash = '#/search';
      });
      renderSide();
    }
    if (side.el.parentNode !== document.body) document.body.appendChild(side.el);
    loadViews();
    syncTools();
    markSide();
  }

  /* --- Detail pages (movies, series and collections) --- */

  var DX_FIELDS = 'Overview,Genres,ProductionYear,EndDate,Status,OfficialRating,CommunityRating,RunTimeTicks,ChildCount,RemoteTrailers,UserData,Taglines,LocalTrailerCount';
  var dx = { id: null, el: null, item: null, pending: null, seasons: [], season: null, episodes: {}, nextUp: null, first: null };

  function detailPage() {
    var p = document.querySelector('#itemDetailPage:not(.hide)') || document.querySelector('.itemDetailPage:not(.hide)');
    return p && p.offsetParent !== null ? p : null;
  }

  // Native parts our header replaces. Never hide a block that holds the rest of the page.
  var DX_HIDE = ['.itemBackdrop', '.detailLogo', '.detailRibbon', '.detailPagePrimaryContainer', '.nameContainer', '.mainDetailButtons', '.itemMiscInfo'];
  var DX_HIDE_SERIES = ['#childrenCollapsible', '#nextUpSection'];

  function hideNative(page) {
    page.classList.add('ts-dx');
    var keep = '.detailPageContent, #castCollapsible, #similarCollapsible, .tsd';
    var list = DX_HIDE.concat(dx.item && dx.item.Type === 'Series' && dx.seasons.length ? DX_HIDE_SERIES : []);
    list.forEach(function (sel) {
      page.querySelectorAll(sel).forEach(function (el) {
        if (el.classList.contains('ts-dx-hide') || el.closest('.tsd') || el.querySelector(keep)) return;
        el.classList.add('ts-dx-hide');
      });
    });
  }

  function clearDetail() {
    document.querySelectorAll('.tsd').forEach(function (el) { el.remove(); });
    document.querySelectorAll('.ts-dx-hide').forEach(function (el) { el.classList.remove('ts-dx-hide'); });
    document.querySelectorAll('.ts-dx').forEach(function (el) { el.classList.remove('ts-dx'); });
    dx.id = null; dx.el = null; dx.item = null;
  }

  function detailSync() {
    var page = layoutEnabled() && !isTv() && /^details/.test(route()) ? detailPage() : null;
    var id = page && hashParam('id');
    if (!page || !id) { if (dx.el) clearDetail(); return; }
    if (dx.el && dx.id === id && page.contains(dx.el)) { hideNative(page); return; }
    if (dx.pending === id) return;
    if (dx.el) clearDetail();
    dx.pending = id;
    ensureUiCss();
    jf('Items', { userId: state.userId, ids: id, fields: DX_FIELDS, enableImageTypes: 'Backdrop,Logo,Primary,Thumb' })
      .then(function (r) {
        var item = r.Items && r.Items[0];
        if (!item || (item.Type !== 'Movie' && item.Type !== 'Series' && item.Type !== 'BoxSet')) return null;
        if (item.Type !== 'Series') return { item: item };
        return Promise.all([
          jf('Shows/' + item.Id + '/Seasons', { userId: state.userId, fields: 'UserData' }).then(function (s) { return s.Items || []; }).catch(function () { return []; }),
          jf('Shows/NextUp', { userId: state.userId, seriesId: item.Id, limit: 1, fields: 'UserData', enableImageTypes: 'Primary,Thumb' }).then(function (n) { return (n.Items || [])[0] || null; }).catch(function () { return null; }),
        ]).then(function (res) { return { item: item, seasons: res[0], nextUp: res[1] }; });
      })
      .then(function (data) {
        dx.pending = null;
        if (!data || hashParam('id') !== id) return;
        var p = detailPage();
        if (!p) return;
        dx.id = id;
        dx.item = data.item;
        // Specials last, like streaming apps.
        dx.seasons = (data.seasons || []).filter(function (x) { return x.IndexNumber !== 0; }).concat((data.seasons || []).filter(function (x) { return x.IndexNumber === 0; }));
        dx.nextUp = data.nextUp || null;
        dx.episodes = {};
        dx.first = null;
        renderDetail(p);
      })
      .catch(function (e) { dx.pending = null; console.warn('[ThemeStudio] details', e); });
  }

  function seasonLabel(s) {
    if (s.IndexNumber === 0) return 'Spéciaux';
    return s.IndexNumber != null ? 'Saison ' + s.IndexNumber : (s.Name || 'Saison');
  }

  function epCode(e) {
    return (e.ParentIndexNumber != null ? 'S' + e.ParentIndexNumber + ' ' : '') + (e.IndexNumber != null ? 'É' + e.IndexNumber : '');
  }

  function playLabel() {
    var i = dx.item;
    if (i.Type === 'Series') {
      var e = dx.nextUp || dx.first;
      if (!e) return { text: 'Lecture', sub: '' };
      var resume = e.UserData && e.UserData.PlaybackPositionTicks > 0;
      return { text: (resume ? 'Reprendre ' : 'Lecture ') + epCode(e), sub: e.Name || '' };
    }
    var pct = i.UserData && i.UserData.PlayedPercentage;
    if (pct > 0 && pct < 100) return { text: 'Reprendre', sub: i.RunTimeTicks ? runtime(i.RunTimeTicks * (1 - pct / 100)) + ' restantes' : '' };
    return { text: i.Type === 'BoxSet' ? 'Tout regarder' : 'Lecture', sub: i.RunTimeTicks && i.Type !== 'BoxSet' ? runtime(i.RunTimeTicks) : '' };
  }

  function renderDetail(page) {
    var i = dx.item;
    var bd = backdropUrl(i);
    var poster = !bd && i.ImageTags && i.ImageTags.Primary ? img(i.Id, 'Primary', i.ImageTags.Primary, 900) : null;
    var logo = logoUrl(i);
    var meta = [];
    if (i.ProductionYear) meta.push('<span>' + esc(i.ProductionYear) + (i.Type === 'Series' && i.EndDate && i.Status === 'Ended' ? '–' + esc(String(i.EndDate).slice(0, 4)) : '') + '</span>');
    if (i.Type === 'Series') {
      var n = dx.seasons.filter(function (s) { return s.IndexNumber !== 0; }).length;
      if (n) meta.push('<span>' + n + (n > 1 ? ' saisons' : ' saison') + '</span>');
    } else if (i.Type === 'BoxSet') {
      if (i.ChildCount) meta.push('<span>' + i.ChildCount + (i.ChildCount > 1 ? ' films' : ' film') + '</span>');
    } else if (i.RunTimeTicks) meta.push('<span>' + esc(runtime(i.RunTimeTicks)) + '</span>');
    if (i.OfficialRating) meta.push('<span class="tsd-pill">' + esc(i.OfficialRating) + '</span>');
    if (i.CommunityRating) {
      var r = Number(i.CommunityRating);
      var stars = Math.round(r / 2);
      meta.push('<span class="tsd-star" aria-label="Note ' + r.toFixed(1) + ' sur 10">' + '★★★★★'.slice(0, stars) + '<span style="opacity:.3">' + '★★★★★'.slice(stars) + '</span> <span style="color:#fff;letter-spacing:0">' + r.toFixed(1) + '</span></span>');
    }
    var genres = (i.Genres || []).slice(0, 4).map(function (g) { return '<span>' + esc(g) + '</span>'; }).join('');
    var fav = !!(i.UserData && i.UserData.IsFavorite);
    var hasTrailer = (i.LocalTrailerCount > 0) || (i.RemoteTrailers && i.RemoteTrailers.length);
    var html = (bd ? '<img class="tsd-bg" alt="" src="' + esc(bd) + '">' : poster ? '<img class="tsd-bg blur" alt="" src="' + esc(poster) + '">' : '') +
      '<div class="tsd-shade"></div>' +
      '<div class="tsd-info">' +
      (logo ? '<img class="tsd-logo" alt="' + esc(i.Name) + '" src="' + esc(logo) + '">' : '<h1 class="tsd-title">' + esc(i.Name) + '</h1>') +
      (meta.length ? '<div class="tsd-meta">' + meta.join('') + '</div>' : '') +
      (genres ? '<div class="tsd-genres">' + genres + '</div>' : '') +
      (i.Taglines && i.Taglines[0] ? '<p class="tsd-tagline">' + esc(i.Taglines[0]) + '</p>' : '') +
      (i.Overview ? '<p class="tsd-ov">' + esc(i.Overview) + '</p>' : '') +
      '<div class="tsd-btns">' +
      '<button type="button" class="tsd-play" data-dx="play"><i>' + ICON_PLAY + '</i><span class="tsd-pl"></span></button>' +
      '<button type="button" class="tsd-round" data-dx="fav" data-fav="' + esc(i.Id) + '" aria-pressed="' + fav + '" title="Ma liste" aria-label="' + (fav ? 'Retirer de mes favoris' : 'Ajouter à mes favoris') + '">' + (fav ? ICON_CHECK : ICON_PLUS) + '</button>' +
      (hasTrailer ? '<button type="button" class="tsd-round" data-dx="trailer" title="Bande-annonce" aria-label="Bande-annonce">' + icon('trailer') + '</button>' : '') +
      '<button type="button" class="tsd-round" data-dx="info" title="Plus d\'infos" aria-label="Plus d\'infos">' + ICON_INFO + '</button>' +
      '</div></div>' +
      (i.Type === 'Series' && dx.seasons.length ? '<div class="tsd-eps"><div class="tsd-tabs" role="tablist" aria-label="Saisons"></div><div class="tsd-row" role="list"></div></div>' : '');
    var el = document.createElement('section');
    el.className = 'tsd';
    el.innerHTML = html;
    el.addEventListener('click', onDetailClick);
    var logoImg = el.querySelector('.tsd-logo');
    if (logoImg) logoImg.addEventListener('error', function () { var h = document.createElement('h1'); h.className = 'tsd-title'; h.textContent = logoImg.alt; logoImg.replaceWith(h); });
    var bgImg = el.querySelector('.tsd-bg');
    if (bgImg) bgImg.addEventListener('error', function () { bgImg.remove(); });
    page.insertBefore(el, page.firstChild);
    dx.el = el;
    hideNative(page);
    bleed(el);
    updatePlay();
    if (i.Type === 'Series' && dx.seasons.length) {
      var start = dx.nextUp && dx.nextUp.SeasonId;
      var def = dx.seasons.filter(function (s) { return s.Id === start; })[0] || dx.seasons.filter(function (s) { return s.IndexNumber !== 0; })[0] || dx.seasons[0];
      renderTabs(def.Id);
      showSeason(def.Id);
    }
  }

  // Stretch a block to the window edges (minus the side bar) and under the header.
  function bleed(el) {
    el.style.marginLeft = el.style.marginTop = el.style.width = '';
    var r = el.getBoundingClientRect();
    var x0 = sideWidth();
    var top = r.top + window.scrollY;
    if (r.left > x0 && r.left - x0 < 200) el.style.marginLeft = -(r.left - x0) + 'px';
    el.style.width = (document.documentElement.clientWidth - x0) + 'px';
    if (top > 0 && top < 220) el.style.marginTop = -top + 'px';
  }
  window.addEventListener('resize', function () { if (dx.el && dx.el.offsetParent) bleed(dx.el); });

  function updatePlay() {
    if (!dx.el) return;
    var l = playLabel();
    var span = dx.el.querySelector('.tsd-pl');
    if (span) span.innerHTML = esc(l.text) + (l.sub ? '<small>' + esc(l.sub) + '</small>' : '');
  }

  function renderTabs(activeId) {
    var tabs = dx.el && dx.el.querySelector('.tsd-tabs');
    if (!tabs) return;
    tabs.innerHTML = dx.seasons.map(function (s) {
      return '<button type="button" class="tsd-tab" role="tab" data-season="' + esc(s.Id) + '" aria-selected="' + (s.Id === activeId) + '">' + esc(seasonLabel(s)) + '</button>';
    }).join('');
  }

  function showSeason(seasonId) {
    dx.season = seasonId;
    var row = dx.el && dx.el.querySelector('.tsd-row');
    if (!row) return;
    dx.el.querySelectorAll('.tsd-tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.getAttribute('data-season') === seasonId)); });
    var cached = dx.episodes[seasonId];
    if (cached) { renderEpisodes(row, cached); return; }
    row.innerHTML = '<div class="tsd-empty">Chargement…</div>';
    var seriesId = dx.item.Id;
    jf('Shows/' + seriesId + '/Episodes', { userId: state.userId, seasonId: seasonId, fields: 'Overview,UserData', enableImageTypes: 'Primary,Thumb' })
      .then(function (r) {
        var eps = r.Items || [];
        dx.episodes[seasonId] = eps;
        if (!dx.first && eps.length && !dx.nextUp) { dx.first = eps[0]; updatePlay(); }
        if (dx.item && dx.item.Id === seriesId && dx.season === seasonId) renderEpisodes(row, eps);
      })
      .catch(function () { row.innerHTML = '<div class="tsd-empty">Impossible de charger les épisodes.</div>'; });
  }

  function epImage(e) {
    if (e.ImageTags && e.ImageTags.Primary) return img(e.Id, 'Primary', e.ImageTags.Primary, 520);
    if (e.ImageTags && e.ImageTags.Thumb) return img(e.Id, 'Thumb', e.ImageTags.Thumb, 520);
    return backdropUrl(dx.item);
  }

  function renderEpisodes(row, eps) {
    if (!eps.length) { row.innerHTML = '<div class="tsd-empty">Aucun épisode.</div>'; return; }
    var nextId = dx.nextUp && dx.nextUp.Id;
    row.innerHTML = eps.map(function (e, k) {
      var ud = e.UserData || {};
      var pct = ud.PlayedPercentage || 0;
      var src = epImage(e);
      return '<button type="button" role="listitem" class="tsd-ep' + (e.Id === nextId ? ' next' : '') + '" data-ep="' + k + '" title="' + esc(e.Name) + '">' +
        (src ? '<img alt="" loading="lazy" decoding="async" src="' + esc(src) + '">' : '') +
        '<i class="play">' + ICON_PLAY + '</i>' +
        (ud.Played ? '<i class="seen" title="Vu">' + icon('check') + '</i>' : '') +
        '<span class="cap">' + (e.IndexNumber != null ? 'Épisode ' + esc(e.IndexNumber) + ' : ' : '') + esc(e.Name) +
        (e.RunTimeTicks ? '<small>' + esc(runtime(e.RunTimeTicks)) + '</small>' : '') + '</span>' +
        (pct > 0 && !ud.Played ? '<b class="bar" style="width:' + Math.round(pct) + '%"></b>' : '') +
        '</button>';
    }).join('');
    var next = row.querySelector('.tsd-ep.next');
    if (next) row.scrollLeft = Math.max(0, next.offsetLeft - 40);
    row.querySelectorAll('img').forEach(function (im) { im.addEventListener('error', function () { im.remove(); }); });
  }

  function playVia(id, serverId) {
    // Jellyfin Web has no public playback API for scripts: open the item and press its Play button.
    try { sessionStorage.setItem('themestudio:autoplay', JSON.stringify({ id: id, at: Date.now() })); } catch (err) { /* ignore */ }
    location.hash = detailsHash(id, serverId);
    waitAutoplay();
  }

  function nativeButton(sel) {
    var page = detailPage();
    var b = page && page.querySelector(sel);
    return b && !b.classList.contains('hide') ? b : null;
  }

  function onDetailClick(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !dx.item) return;
    var i = dx.item;
    if (b.hasAttribute('data-season')) { showSeason(b.getAttribute('data-season')); return; }
    if (b.hasAttribute('data-ep')) {
      var ep = (dx.episodes[dx.season] || [])[Number(b.getAttribute('data-ep'))];
      if (ep) playVia(ep.Id, ep.ServerId || i.ServerId);
      return;
    }
    var act = b.getAttribute('data-dx');
    if (act === 'fav') { toggleFavorite(b); return; }
    if (act === 'info') {
      var c = detailPage() && detailPage().querySelector('.detailPageContent');
      if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (act === 'trailer') {
      var t = nativeButton('.btnPlayTrailer');
      if (t) t.click();
      else if (i.RemoteTrailers && i.RemoteTrailers[0]) window.open(i.RemoteTrailers[0].Url, '_blank', 'noopener');
      return;
    }
    if (act === 'play') {
      if (i.Type === 'Series') {
        var e2 = dx.nextUp || dx.first;
        if (e2) { playVia(e2.Id, e2.ServerId || i.ServerId); return; }
      }
      var nb = nativeButton('.btnResume') || nativeButton('.btnPlay');
      if (nb) nb.click();
    }
  }

  function layoutSync() {
    if (!state.boot) return;
    var on = layoutEnabled() && !isTv();
    htmlClass().toggle('ts-modern', on);
    if (on) ensureUiCss();
    sideSync();
    detailSync();
  }
  window.addEventListener('hashchange', function () { setTimeout(layoutSync, 30); });
  window.addEventListener('resize', function () { sideSync(); });
  // The bar opens on keyboard focus only when the keyboard is actually used.
  document.addEventListener('keydown', function (e) { if (e.key === 'Tab' || (e.keyCode >= 37 && e.keyCode <= 40)) htmlClass().add('ts-kbd'); }, true);
  document.addEventListener('mousedown', function () { htmlClass().remove('ts-kbd'); }, true);

  // TV remote: Jellyfin's own focus navigation does not know about the side bar,
  // so arrows inside it are handled here, and Left at the page's edge opens it.
  function sideFocusables() {
    return side.el ? Array.prototype.slice.call(side.el.querySelectorAll('a[href], button')) : [];
  }
  function focusPage() {
    var page = document.querySelector('.page:not(.hide)');
    var cands = (hero.el && hero.el.offsetParent ? Array.prototype.slice.call(hero.el.querySelectorAll('.tsh-slide.on .tsh-play')) : [])
      .concat(page ? Array.prototype.slice.call(page.querySelectorAll('.card, button:not(.hide), a[href]')) : []);
    for (var k = 0; k < cands.length; k++) {
      var r = cands[k].getBoundingClientRect();
      if (r.width && r.height && r.bottom > 0 && r.top < window.innerHeight) { cands[k].focus(); return; }
    }
  }
  window.addEventListener('keydown', function (e) {
    if (!htmlClass().contains('ts-side') || !side.el) return;
    var k = e.keyCode;
    if (k < 37 || k > 40) return;
    var active = document.activeElement;
    if (side.el.contains(active)) {
      e.preventDefault();
      e.stopPropagation();
      if (k === 39) { active.blur(); focusPage(); return; }
      if (k === 37) return;
      var list = sideFocusables();
      var i = list.indexOf(active) + (k === 40 ? 1 : -1);
      if (i >= 0 && i < list.length) list[i].focus();
      return;
    }
    if (k === 37 && isTv()) {
      // If Jellyfin did not move focus (nothing more to the left), go to the side bar.
      setTimeout(function () {
        if (document.activeElement !== active) return;
        var on = side.el.querySelector('.tss-a.on') || sideFocusables()[0];
        if (on) on.focus();
      }, 80);
    }
  }, true);


  window.ThemeStudio = {
    version: 1,
    open: open,
    mountAdmin: mountAdmin,
    refresh: function () { state.boot = null; return bootstrap(); },
    _buildCss: buildCss,
    _variables: variables,
  };
})();
