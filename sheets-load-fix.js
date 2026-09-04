/* sheets-load-fix.js — keep Apps Script fetches from aborting on cold starts */
(function () {
  var SCRIPT_RE = /script\.google\.com/i;
  var MIN_SCRIPT_MS = 60000;
  // Capture the browser's real fetch BEFORE we wrap it.
  var nativeFetch = window.fetch.bind(window);

  function sheetsErrMsg(e) {
    var msg = (e && e.message) || String(e);
    if (/abort|timed out|TimeoutError/i.test(msg)) {
      return 'Sheets timed out — Apps Script was slow or busy. Try Refresh again.';
    }
    return msg;
  }

  function scriptUrl(input) {
    if (typeof input === 'string') return input;
    try { return String(input && input.url || ''); } catch (e) { return ''; }
  }

  // index.html's fetchWithTimeout is a classic-script function declaration, so
  // assigning window.fetchWithTimeout does NOT change what Refresh calls.
  // Wrapping window.fetch does — we replace short AbortSignals with a 60s one.
  window.fetch = function (input, init) {
    var url = scriptUrl(input);
    if (!SCRIPT_RE.test(url)) return nativeFetch(input, init);

    function once() {
      var ctrl = new AbortController();
      var timer = setTimeout(function () {
        ctrl.abort(new Error('Sheets request timed out after ' + MIN_SCRIPT_MS + 'ms'));
      }, MIN_SCRIPT_MS);
      var opts = Object.assign({}, init || {}, { signal: ctrl.signal });
      return nativeFetch(url, opts).finally(function () { clearTimeout(timer); });
    }

    return once().catch(function (e) {
      var msg = (e && e.message) || String(e);
      if (!/abort|timed out|TimeoutError/i.test(msg)) throw e;
      return new Promise(function (r) { setTimeout(r, 800); }).then(once);
    });
  };

  function rawFetchWithTimeout(url, options, ms) {
    ms = ms || 25000;
    if (SCRIPT_RE.test(String(url || ''))) ms = Math.max(ms, MIN_SCRIPT_MS);
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      ctrl.abort(new Error('Sheets request timed out after ' + ms + 'ms'));
    }, ms);
    var opts = Object.assign({}, options || {}, { signal: ctrl.signal });
    return nativeFetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  async function fetchWithTimeout(url, options, ms) {
    try {
      return await rawFetchWithTimeout(url, options, ms);
    } catch (e) {
      var msg = (e && e.message) || String(e);
      if (!/abort|timed out|TimeoutError/i.test(msg)) throw e;
      await new Promise(function (r) { setTimeout(r, 800); });
      return await rawFetchWithTimeout(url, options, ms);
    }
  }

  async function fetchSheets(url, options, ms) {
    return fetchWithTimeout(url, options, ms || MIN_SCRIPT_MS);
  }

  function install() {
    window.fetchWithTimeout = fetchWithTimeout;
    window.fetchSheets = fetchSheets;
    window.sheetsErrMsg = sheetsErrMsg;
  }

  install();

  async function recover() {
    install();
    var gsUrl = '';
    try {
      var cfgR = await nativeFetch('./config.json', { cache: 'no-cache' });
      if (cfgR.ok) {
        var cfg = await cfgR.json();
        gsUrl = cfg.gsUrl || '';
      }
    } catch (e) {}
    if (!gsUrl) {
      try { gsUrl = localStorage.getItem('nw_sheets_url') || ''; } catch (e2) {}
    }
    if (!gsUrl) return;

    await new Promise(function (r) { setTimeout(r, 9500); });
    install();

    try {
      var r = await fetchSheets(gsUrl + '?load=1', {}, MIN_SCRIPT_MS);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var text = await r.text();
      if (!text || text === '{}') return;
      if (typeof applyPayload === 'function') {
        var ok = applyPayload(text, 'remote');
        if (ok && typeof setSaveStatus === 'function') setSaveStatus('loaded');
      }
    } catch (e) {
      console.warn('sheets-load-fix portfolio:', sheetsErrMsg(e));
    }

    try {
      if (typeof loadHistory === 'function') await loadHistory();
    } catch (e) {
      console.warn('sheets-load-fix history:', sheetsErrMsg(e));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { recover(); });
  } else {
    recover();
  }
})();
