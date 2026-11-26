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
    '.scrim{position:fixed;inset:0;background:rgba(0,0,0,.25);opacity:0;transition:opacity .2s}',
    '.panel{position:fixed;top:0;right:0;bottom:0;width:min(440px,100vw);display:flex;flex-direction:column;background:color-mix(in srgb,var(--bg) 88%,transparent);-webkit-backdrop-filter:blur(24px) saturate(1.4);backdrop-filter:blur(24px) saturate(1.4);border-left:1px solid var(--bd);box-shadow:-20px 0 60px rgba(0,0,0,.45);transform:translateX(100%);transition:transform .28s cubic-bezier(.2,.8,.2,1)}',
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
    '.mini-row i{flex:1;border-radius:min(var(--r),10px);background:var(--s);border:1px solid color-mix(in srgb,var(--t) 10%,transparent)}',
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
      html += '<h3>Page d\'accueil</h3>';
      html += toggleHtml('showHomeHero', 'Grande bannière façon cinéma', 'Grande image en haut de l\'accueil avec les films à reprendre et les nouveautés. Chaque utilisateur peut la masquer.', s.showHomeHero !== false);
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
      panelHost.style.cssText = 'position:fixed;inset:0;z-index:2147483000;';
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
    '.tsh{position:relative;height:clamp(380px,70vh,860px);overflow:hidden;margin-bottom:1.2em;background:var(--ts-bg,#101010);color:#fff;isolation:isolate}',
    '.tsh-slide{position:absolute;inset:0;opacity:0;visibility:hidden;transition:opacity .9s ease,visibility 0s linear .9s}',
    '.tsh-slide.on{opacity:1;visibility:visible;transition:opacity .9s ease}',
    '.tsh-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 20%;transform:scale(1.02)}',
    '.tsh-slide.on .tsh-bg{animation:tsh-zoom 14s ease-out forwards}',
    '@keyframes tsh-zoom{from{transform:scale(1.02)}to{transform:scale(1.09)}}',
    '.tsh-shade{position:absolute;inset:0;background:linear-gradient(to top,var(--ts-bg,#101010) 0%,color-mix(in srgb,var(--ts-bg,#101010) 60%,transparent) 22%,transparent 55%),linear-gradient(to right,rgba(0,0,0,.82) 0%,rgba(0,0,0,.45) 35%,transparent 65%),linear-gradient(to bottom,rgba(0,0,0,.55) 0%,transparent 18%)}',
    '.tsh-info{position:absolute;left:4.5vw;bottom:15%;width:min(620px,88vw);z-index:2}',
    '.tsh-tag{display:inline-flex;align-items:center;gap:.5em;font-size:.82em;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--ts-accent,#00a4dc);margin-bottom:.9em}',
    '.tsh-tag::before{content:"";width:18px;height:3px;border-radius:2px;background:currentColor}',
    '.tsh-logo{display:block;max-width:min(440px,70vw);max-height:150px;object-fit:contain;object-position:left bottom;margin-bottom:.7em;filter:drop-shadow(0 4px 24px rgba(0,0,0,.6))}',
    '.tsh-title{font-size:clamp(2em,4.4vw,3.6em);font-weight:800;line-height:1.02;letter-spacing:-.02em;margin:0 0 .25em;text-shadow:0 2px 20px rgba(0,0,0,.5)}',
    '.tsh-sub{font-size:1.15em;font-weight:600;margin:0 0 .5em;opacity:.95}',
    '.tsh-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.35em .9em;font-size:.95em;color:rgba(255,255,255,.85);margin-bottom:.8em}',
    '.tsh-meta .tsh-pill{border:1px solid rgba(255,255,255,.45);border-radius:4px;padding:0 .4em;font-size:.85em}',
    '.tsh-meta .tsh-star{color:#ffd166}',
    '.tsh-ov{font-size:1.02em;line-height:1.5;color:rgba(255,255,255,.88);margin:0 0 1.3em;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;text-shadow:0 1px 8px rgba(0,0,0,.5)}',
    '.tsh-progress{display:flex;align-items:center;gap:.8em;margin:-.4em 0 1.2em;font-size:.9em;color:rgba(255,255,255,.8)}',
    '.tsh-progress span{flex:0 0 180px;height:4px;border-radius:2px;background:rgba(255,255,255,.25);overflow:hidden}',
    '.tsh-progress i{display:block;height:100%;background:var(--ts-accent,#00a4dc)}',
    '.tsh-btns{display:flex;gap:.8em;flex-wrap:wrap}',
    '.tsh-btn{display:inline-flex;align-items:center;gap:.5em;border:0;border-radius:var(--ts-radius-sm,6px);padding:.75em 1.6em;font:inherit;font-size:1.05em;font-weight:700;cursor:pointer;transition:transform .15s,filter .15s,background .15s}',
    '.tsh-btn:hover{transform:scale(1.04)}',
    '.tsh-btn:focus-visible{outline:3px solid var(--ts-accent,#00a4dc);outline-offset:3px}',
    '.tsh-play{background:#fff;color:#000}',
    '.tsh-play:hover{filter:brightness(.88)}',
    '.tsh-more{background:rgba(109,109,110,.6);color:#fff;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}',
    '.tsh-more:hover{background:rgba(109,109,110,.4)}',
    '.tsh-btn svg{width:1.4em;height:1.4em}',
    '.tsh-dots{position:absolute;right:4.5vw;bottom:15%;display:flex;gap:6px;z-index:3}',
    '.tsh-dot{width:22px;height:4px;border:0;border-radius:2px;background:rgba(255,255,255,.35);cursor:pointer;padding:0;transition:width .3s,background .3s}',
    '.tsh-dot.on{width:38px;background:#fff}',
    '.tsh-arrow{position:absolute;top:50%;transform:translateY(-50%);z-index:3;width:48px;height:96px;border:0;background:rgba(0,0,0,.25);color:#fff;cursor:pointer;opacity:0;transition:opacity .2s;display:grid;place-items:center}',
    '.tsh:hover .tsh-arrow{opacity:1}',
    '.tsh-arrow:hover{background:rgba(0,0,0,.5)}',
    '.tsh-prev{left:0;border-radius:0 8px 8px 0}.tsh-next{right:0;border-radius:8px 0 0 8px}',
    '.tsh-arrow svg{width:30px;height:30px}',
    '.tsh-skeleton{position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.04) 50%,transparent 70%) var(--ts-surface,#1c1c1c);background-size:200% 100%;animation:tsh-sk 1.4s linear infinite}',
    '@keyframes tsh-sk{to{background-position:-200% 0}}',
    '@media (max-width:700px){.tsh{height:clamp(380px,66vh,620px)}.tsh-info{bottom:12%}.tsh-ov{display:none}.tsh-dots{left:4.5vw;right:auto;bottom:4%}.tsh-arrow{display:none}.tsh-btn{padding:.65em 1.2em}}',
    '@media (prefers-reduced-motion:reduce){.tsh-slide.on .tsh-bg{animation:none}.tsh-slide{transition:none}}',
  ].join('\n');

  var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>';
  var ICON_INFO = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  var ICON_PREV = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>';
  var ICON_NEXT = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z"/></svg>';

  var HERO_FIELDS = 'Overview,Genres,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks,ParentBackdropItemId,ParentBackdropImageTags,ParentLogoItemId,ParentLogoImageTag,SeriesName,ParentIndexNumber,IndexNumber,UserData';
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
      }
      return;
    }
    if (!document.getElementById('theme-studio-hero-css')) {
      var st = document.createElement('style');
      st.id = 'theme-studio-hero-css';
      st.textContent = HERO_CSS;
      document.head.insertBefore(st, document.head.firstChild);
    }
    if (!hero.el) {
      hero.el = document.createElement('section');
      hero.el.className = 'tsh';
      hero.el.setAttribute('aria-roledescription', 'carrousel');
      hero.el.setAttribute('aria-label', 'À la une');
      hero.el.innerHTML = '<div class="tsh-skeleton"></div>';
      hero.el.addEventListener('click', onHeroClick);
      hero.el.addEventListener('mouseenter', function () { hero.hover = true; });
      hero.el.addEventListener('mouseleave', function () { hero.hover = false; });
    }
    if (hero.el.nextElementSibling !== target) {
      target.parentNode.insertBefore(hero.el, target);
      layoutHero();
    }
    var key = state.userId + '|' + (state.boot.homeHeroSource || 'mixed');
    if (key !== hero.key || Date.now() - hero.loadedAt > HERO_TTL) loadHero(key);
    if (!hero.timer && hero.items.length > 1) startHero();
  }

  // Full-bleed: stretch to the window edges and slide under the (glass) header.
  function layoutHero() {
    var el = hero.el;
    if (!el) return;
    el.style.marginLeft = el.style.marginRight = el.style.marginTop = '';
    el.style.width = '';
    var r = el.getBoundingClientRect();
    var top = r.top + window.scrollY;
    if (r.left > 0 && r.left < 200) el.style.marginLeft = -r.left + 'px';
    el.style.width = document.documentElement.clientWidth + 'px';
    if (top > 0 && top < 220) el.style.marginTop = -top + 'px';
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
      recursive: true, limit: 12, fields: HERO_FIELDS, imageTypes: 'Backdrop', enableImageTypes: 'Backdrop,Logo', imageTypeLimit: 1,
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
      '</div></div></div>';
  }

  function renderHero() {
    if (!hero.el) return;
    stopHero();
    if (!hero.items.length) { hero.el.remove(); hero.el = null; return; }
    if (hero.idx >= hero.items.length) hero.idx = 0;
    var html = hero.items.map(slideHtml).join('');
    if (hero.items.length > 1) {
      html += '<button type="button" class="tsh-arrow tsh-prev" data-step="-1" aria-label="Précédent">' + ICON_PREV + '</button>' +
        '<button type="button" class="tsh-arrow tsh-next" data-step="1" aria-label="Suivant">' + ICON_NEXT + '</button><div class="tsh-dots">';
      hero.items.forEach(function (_, n) {
        html += '<button type="button" class="tsh-dot' + (n === hero.idx ? ' on' : '') + '" data-go="' + n + '" aria-label="Diapositive ' + (n + 1) + '"></button>';
      });
      html += '</div>';
    }
    hero.el.innerHTML = html;
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
  }

  function showSlide(n) {
    if (!hero.el || !hero.items.length) return;
    hero.idx = (n + hero.items.length) % hero.items.length;
    hero.el.querySelectorAll('.tsh-slide').forEach(function (s, k) { s.classList.toggle('on', k === hero.idx); });
    hero.el.querySelectorAll('.tsh-dot').forEach(function (d, k) { d.classList.toggle('on', k === hero.idx); });
  }

  function startHero() {
    stopHero();
    if (hero.items.length < 2) return;
    hero.timer = setInterval(function () {
      if (!hero.el || hero.el.offsetParent === null || hero.hover || document.hidden) return;
      if (hero.el.contains(document.activeElement)) return;
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
    if (b.dataset.play) {
      // Jellyfin Web has no public playback API for scripts: open the item and press its Play button.
      try { sessionStorage.setItem('themestudio:autoplay', JSON.stringify({ id: b.dataset.play, at: Date.now() })); } catch (err) { /* ignore */ }
      location.hash = detailsHash(b.dataset.play, b.dataset.server);
      waitAutoplay();
    }
  }

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


  window.ThemeStudio = {
    version: 1,
    open: open,
    mountAdmin: mountAdmin,
    refresh: function () { state.boot = null; return bootstrap(); },
    _buildCss: buildCss,
    _variables: variables,
  };
})();
