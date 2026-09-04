/* sheets-load-fix.js — retries Sheets loads aborted by short client timeouts */
(function () {
  function fetchWithTimeout(url, options, ms) {
    ms = ms || 25000;
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      ctrl.abort(new Error('Sheets request timed out after ' + ms + 'ms'));
    }, ms);
    var opts = Object.assign({}, options || {}, { signal: ctrl.signal });
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }
  async function fetchSheets(url, options, ms) {
    try {
      return await fetchWithTimeout(url, options, ms);
    } catch (e) {
      var msg = (e && e.message) || String(e);
      if (/abort|timed out|TimeoutError/i.test(msg)) {
        await new Promise(function (r) { setTimeout(r, 700); });
        return await fetchWithTimeout(url, options, ms);
      }
      throw e;
    }
  }
  function sheetsErrMsg(e) {
    var msg = (e && e.message) || String(e);
    if (/abort|timed out|TimeoutError/i.test(msg)) {
      return 'Sheets timed out — Apps Script was slow or busy. Try Refresh again.';
    }
    return msg;
  }
  window.fetchWithTimeout = fetchWithTimeout;
  window.fetchSheets = fetchSheets;
  window.sheetsErrMsg = sheetsErrMsg;

  async function recover() {
    var gsUrl = '';
    try {
      var cfgR = await fetch('./config.json', { cache: 'no-cache' });
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

    try {
      var r = await fetchSheets(gsUrl + '?load=1', {}, 25000);
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
