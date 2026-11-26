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
      else { applyCss(null); cache(null); removeHeaderButton(); }
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

  window.ThemeStudio = {
    version: 1,
    open: open,
    mountAdmin: mountAdmin,
    refresh: function () { state.boot = null; return bootstrap(); },
    _buildCss: buildCss,
    _variables: variables,
  };
})();
