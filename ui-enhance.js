/* UI enhance — hero, theme toggle, sticky bar, friendlier refresh copy */
(function () {
  var THEME_KEY = 'nw_theme_v1';

  function $(id) { return document.getElementById(id); }

  function applyTheme(theme) {
    var t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    var btn = $('nw-theme-btn');
    if (btn) btn.textContent = t === 'light' ? '☾' : '☀';
    btn && btn.setAttribute('title', t === 'light' ? 'Switch to dark' : 'Switch to light');
  }

  function currentTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; }
  }

  function toast(msg, kind) {
    var el = $('nw-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'nw-toast';
      el.className = 'nw-toast';
      document.body.appendChild(el);
    }
    el.className = 'nw-toast show ' + (kind || '');
    el.textContent = msg;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 2800);
  }

  function ensureHero() {
    if ($('nw-hero')) return;
    var metrics = document.querySelector('.metrics');
    if (!metrics || !metrics.parentNode) return;

    var hero = document.createElement('section');
    hero.id = 'nw-hero';
    hero.className = 'nw-hero';
    hero.innerHTML =
      '<div class="nw-hero-label">Total net worth</div>' +
      '<div class="nw-hero-row">' +
      '  <div>' +
      '    <div class="nw-hero-total" id="nw-hero-total">—</div>' +
      '    <div class="nw-hero-meta">' +
      '      <span class="nw-pill" id="nw-hero-chg">day —</span>' +
      '      <span id="nw-hero-inr">INR —</span>' +
      '      <span id="nw-hero-sub">Connecting…</span>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    metrics.parentNode.insertBefore(hero, metrics);
  }

  function ensureThemeBtn() {
    var right = document.querySelector('.hdr-right .hdr-btns');
    if (!right || $('nw-theme-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'nw-theme-btn';
    btn.className = 'nw-theme-btn';
    btn.type = 'button';
    btn.addEventListener('click', function () {
      applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    });
    right.appendChild(btn);
  }

  function ensureSticky() {
    if ($('nw-sticky')) return;
    var bar = document.createElement('div');
    bar.id = 'nw-sticky';
    bar.className = 'nw-sticky';
    bar.innerHTML =
      '<div><div class="nw-sticky-label">Net worth</div><div class="nw-sticky-val" id="nw-sticky-val">—</div></div>' +
      '<button type="button" class="nw-sticky-btn" id="nw-sticky-refresh">↻ Refresh</button>';
    document.body.appendChild(bar);
    var rb = $('nw-sticky-refresh');
    if (rb) rb.addEventListener('click', function () {
      if (typeof window.refreshAllPrices === 'function') window.refreshAllPrices();
    });
  }

  function syncHeroFromMetrics() {
    var total = $('m-total');
    var inr = $('m-inr');
    var chg = $('m-total-chg');
    var sub = $('m-total-sub');
    var ht = $('nw-hero-total');
    var hi = $('nw-hero-inr');
    var hc = $('nw-hero-chg');
    var hs = $('nw-hero-sub');
    var sv = $('nw-sticky-val');
    if (ht && total) ht.textContent = total.textContent || '—';
    if (sv && total) sv.textContent = total.textContent || '—';
    if (hi && inr) hi.textContent = (inr.textContent || '—') + ' INR';
    if (hs && sub) hs.textContent = (sub.textContent || '').replace(/\s+/g, ' ').trim() || 'Live portfolio';
    if (hc && chg) {
      var raw = (chg.textContent || '').trim();
      var html = chg.innerHTML || '';
      hc.className = 'nw-pill';
      if (/pos|\+|▲/.test(html + raw) || chg.querySelector('.pos')) hc.classList.add('pos');
      if (/neg|\-|▼/.test(html + raw) || chg.querySelector('.neg')) hc.classList.add('neg');
      hc.textContent = raw ? ('Day ' + raw) : 'Day —';
      // Prefer inner text from chips
      var chip = chg.querySelector('.pos, .neg, span');
      if (chip && chip.textContent) hc.textContent = 'Day ' + chip.textContent.trim();
    }
  }

  function wrapRecalc() {
    if (typeof window.recalc !== 'function' || window.recalc.__nwEnhanced) return;
    var orig = window.recalc;
    window.recalc = function () {
      var r = orig.apply(this, arguments);
      try { syncHeroFromMetrics(); } catch (e) {}
      return r;
    };
    window.recalc.__nwEnhanced = true;
  }

  function softenRefreshCopy() {
    if (typeof window.setRefreshStatus !== 'function' || window.setRefreshStatus.__nwEnhanced) return;
    var orig = window.setRefreshStatus;
    window.setRefreshStatus = function (msg) {
      var m = String(msg || '');
      if (/signal is aborted|timed out|AbortError/i.test(m)) {
        m = 'Still fetching prices from Sheets…';
        toast('Price refresh is taking longer than usual', '');
      } else if (/^✓/.test(m)) {
        toast(m.replace(/^✓\s*/, ''), 'ok');
      } else if (/^✗|failed/i.test(m)) {
        toast(m.replace(/^✗\s*/, ''), 'err');
      }
      return orig.call(this, m);
    };
    window.setRefreshStatus.__nwEnhanced = true;
  }

  function boot() {
    applyTheme(currentTheme());
    ensureThemeBtn();
    ensureHero();
    ensureSticky();
    wrapRecalc();
    softenRefreshCopy();
    syncHeroFromMetrics();
    // Re-wrap shortly after main script finishes defining helpers
    setTimeout(function () { wrapRecalc(); softenRefreshCopy(); syncHeroFromMetrics(); }, 0);
    setTimeout(function () { wrapRecalc(); softenRefreshCopy(); syncHeroFromMetrics(); }, 300);
    setTimeout(syncHeroFromMetrics, 1200);
    setTimeout(syncHeroFromMetrics, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
