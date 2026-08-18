const SHEET_NAME = 'Sheet1';          // legacy single-cell blob (kept only for one-time migration)
const HOLDINGS_SHEET = 'Holdings';    // one row per position — human-editable
const SETTINGS_SHEET = 'Settings';    // key/value pairs for accounts, gold, etc.
const HISTORY_SHEET = 'History';
const TX_SHEET = 'Transactions';
const WATCHLIST_SHEET = 'Watchlist'; // one row per tracked stock — human-editable

const HOLDINGS_HEADER = ['Key','Symbol','Name','Account','Shares','Price','Currency','Prev Price','Yahoo Symbol','Day Prev Close','Custom'];
const WATCHLIST_HEADER = ['Symbol','Name','Market'];
const C_KEY=0, C_SYM=1, C_NAME=2, C_ACCT=3, C_SHARES=4, C_PRICE=5, C_CURR=6, C_PREV=7, C_YAHOO=8, C_DAYPC=9, C_CUSTOM=10;

// ─── GET handler ──────────────────────────────────────────────
function doGet(e) {
  try {
    const action = e.parameter.action || 'load';

    // 1. Ticker search — proxies Yahoo Finance (no CORS!)
    if (action === 'search') {
      const q = e.parameter.q || '';
      if (!q) return json({quotes: []});
      const url = 'https://query1.finance.yahoo.com/v1/finance/search?q='
        + encodeURIComponent(q) + '&quotesCount=10&newsCount=0';
      try {
        const resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
        const data = JSON.parse(resp.getContentText());
        const quotes = (data.quotes || []).filter(function(q) {
          return q.symbol && q.quoteType !== 'OPTION' && q.quoteType !== 'FUTURE';
        });
        return json({quotes: quotes});
      } catch(err) {
        return json({quotes: [], error: err.message});
      }
    }

    // 2. Live price refresh
    if (action === 'prices') {
      var symbols = e.parameter.symbols || '';
      if (!symbols) return json({prices: {}});

      var prices = {};
      var prevCloses = {};
      var errors = [];

      // Browser-like headers that Yahoo accepts
      var headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com'
      };

      // Split symbols and fetch individually to avoid batch 500 errors
      var symList = symbols.split(',');
      var resp, code, parsed, result, price;

      // Optional historical date — if provided, fetch closing price on that date
      var dateStr = e.parameter.date || '';
      var histPeriod1 = 0, histPeriod2 = 0;
      if (dateStr) {
        try {
          var targetDate = new Date(dateStr + 'T00:00:00Z');
          histPeriod2 = Math.floor(targetDate.getTime() / 1000) + 2 * 86400; // +2 days covers IST offset
          histPeriod1 = histPeriod2 - 9 * 86400; // 9 days back handles weekends + holidays
        } catch(de) {}
      }

      symList.forEach(function(sym) {
        sym = sym.trim();
        if (!sym) return;
        try {
          // Chart endpoint — supports both current (range=1d) and historical (period1/period2)
          var url = histPeriod1
            ? 'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&period1=' + histPeriod1 + '&period2=' + histPeriod2
            : 'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&range=1d';
          resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true, headers: headers});
          code = resp.getResponseCode();
          if (code === 200) {
            parsed = JSON.parse(resp.getContentText());
            var chartResult = ((parsed.chart || {}).result || [{}])[0];
            var meta = chartResult.meta || {};
            if (histPeriod1) {
              // Historical: try close[], then adjclose[], then meta price as last resort
              var timestamps = chartResult.timestamp || [];
              var closes    = ((chartResult.indicators || {}).quote    || [{}])[0].close    || [];
              var adjcloses = ((chartResult.indicators || {}).adjclose || [{}])[0].adjclose || [];
              price = null;
              for (var ti = timestamps.length - 1; ti >= 0; ti--) {
                if (timestamps[ti] < histPeriod2) {
                  var c = (closes[ti] != null) ? closes[ti] : (adjcloses[ti] != null ? adjcloses[ti] : null);
                  if (c != null) { price = c; break; }
                }
              }
              // If chart gave no usable close, fall back to meta (current price)
              if (!price) price = meta.regularMarketPrice || meta.previousClose || meta.chartPreviousClose;
            } else {
              price = meta.regularMarketPrice || meta.previousClose;
            }
            if (price) {
              var clean = sym.replace(/\.(NS|BO)$/i, '');
              prices[clean] = price;
              prices[sym] = price;
              if (!histPeriod1) {
                var pc = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPreviousClose;
                if (pc) { prevCloses[clean] = pc; prevCloses[sym] = pc; }
              }
              return;
            }
          }
          // In historical mode keep trying fallbacks — they return current price but better than nothing
          // Fallback 1: v8 quote endpoint (stocks + some mutual funds)
          url = 'https://query2.finance.yahoo.com/v8/finance/quote?symbols=' + sym
              + '&fields=regularMarketPrice,navPrice,price,regularMarketPreviousClose,previousClose';
          resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true, headers: headers});
          code = resp.getResponseCode();
          if (code === 200) {
            parsed = JSON.parse(resp.getContentText());
            result = ((parsed.quoteResponse || {}).result || [])[0] || {};
            price = result.regularMarketPrice || result.navPrice || result.price;
            if (price) {
              var clean2 = sym.replace(/\.(NS|BO)$/i, '');
              prices[clean2] = price;
              prices[sym] = price;
              var pc = result.regularMarketPreviousClose || result.previousClose;
              if (pc) { prevCloses[clean2] = pc; prevCloses[sym] = pc; }
              return;
            }
          }
          // Fallback 2: v7 quote endpoint (better for mutual funds / NAVs)
          try {
            var url7 = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + sym;
            var resp7 = UrlFetchApp.fetch(url7, {muteHttpExceptions: true, headers: headers});
            if (resp7.getResponseCode() === 200) {
              var p7 = JSON.parse(resp7.getContentText());
              var r7 = ((p7.quoteResponse || {}).result || [])[0] || {};
              var px7 = r7.regularMarketPrice || r7.navPrice;
              if (px7) {
                var cl7 = sym.replace(/\.(NS|BO)$/i, '');
                prices[cl7] = px7;
                prices[sym] = px7;
                return;
              }
            }
          } catch(e7) { /* ignore */ }
          errors.push(sym + ':HTTP' + code);
        } catch(err) {
          errors.push(sym + ':' + err.message.slice(0, 40));
        }
      });

      // ── Twelve Data fallback for symbols Yahoo couldn't price ──────
      var tdKey = PropertiesService.getScriptProperties().getProperty('TWELVE_DATA_KEY') || '';
      var failedNSE = symList.filter(function(s) {
        s = s.trim();
        if (!s) return false;
        var clean = s.replace(/\.(NS|BO)$/i, '');
        return /\.NS$/i.test(s) && !prices[clean] && !prices[s];
      });
      if (tdKey && failedNSE.length > 0) {
        var tdPairs = failedNSE.map(function(s) {
          return {ns: s.trim(), td: s.trim().replace(/\.NS$/i, ':NSE')};
        });
        var tdSymStr = tdPairs.map(function(p){ return p.td; }).join(',');
        try {
          var tdUrl = 'https://api.twelvedata.com/price?symbol='
            + encodeURIComponent(tdSymStr) + '&apikey=' + tdKey;
          var tdResp = UrlFetchApp.fetch(tdUrl, {muteHttpExceptions: true});
          if (tdResp.getResponseCode() === 200) {
            var tdData = JSON.parse(tdResp.getContentText());
            if (tdPairs.length === 1) {
              if (tdData.price && !tdData.code) {
                var cl = tdPairs[0].ns.replace(/\.NS$/i, '');
                prices[cl] = parseFloat(tdData.price);
                prices[tdPairs[0].ns] = parseFloat(tdData.price);
              }
            } else {
              tdPairs.forEach(function(pair) {
                var r = tdData[pair.td];
                if (r && r.price && !r.code) {
                  var cl2 = pair.ns.replace(/\.NS$/i, '');
                  prices[cl2] = parseFloat(r.price);
                  prices[pair.ns] = parseFloat(r.price);
                }
              });
            }
          }
        } catch(tdErr) {
          errors.push('TwelveData:' + tdErr.message.slice(0, 40));
        }
      }

      // ── Google Finance fallback (via Sheets formula) for anything still missing ──
      var stillMissing = symList.filter(function(s) {
        s = s.trim();
        if (!s) return false;
        var clean = s.replace(/\.(NS|BO)$/i, '');
        return /\.NS$/i.test(s) && !prices[clean] && !prices[s];
      });
      if (stillMissing.length > 0) {
        try {
          var ss = SpreadsheetApp.getActiveSpreadsheet();
          var tmpName = '_PriceTemp';
          var tmp = ss.getSheetByName(tmpName);
          if (!tmp) { tmp = ss.insertSheet(tmpName); tmp.hideSheet(); }
          // Build a date tuple for GOOGLEFINANCE historical if dateStr was provided
          var gfDateParts = null;
          if (dateStr) {
            var dp = dateStr.split('-');
            if (dp.length === 3) gfDateParts = [parseInt(dp[0]), parseInt(dp[1]), parseInt(dp[2])];
          }
          stillMissing.forEach(function(s, i) {
            var sym = s.trim().replace(/\.NS$/i, '').replace(/-SM$/i, '');
            var formula;
            if (gfDateParts) {
              // Historical: INDEX picks the close value from the 2-row result
              formula = '=IFERROR(INDEX(GOOGLEFINANCE("NSE:' + sym + '","close",'
                + 'DATE(' + gfDateParts[0] + ',' + gfDateParts[1] + ',' + gfDateParts[2] + ')'
                + '),2,2),0)';
            } else {
              formula = '=IFERROR(GOOGLEFINANCE("NSE:' + sym + '","price"),0)';
            }
            tmp.getRange(i + 1, 1).setFormula(formula);
          });
          SpreadsheetApp.flush();
          Utilities.sleep(2500);
          stillMissing.forEach(function(s, i) {
            var sym = s.trim();
            var clean = sym.replace(/\.NS$/i, '');
            var val = Number(tmp.getRange(i + 1, 1).getValue());
            if (val > 0) { prices[clean] = val; prices[sym] = val; }
          });
          tmp.getRange(1, 1, stillMissing.length, 1).clearContent();
        } catch(gfErr) {
          errors.push('GoogleFinance:' + gfErr.message.slice(0, 40));
        }
      }

      return json({
        prices: prices,
        prevCloses: prevCloses,
        updatedAt: new Date().toISOString(),
        count: Object.keys(prices).length / 2,
        errors: errors
      });
    }

    // 3a. Save / delete Twelve Data API key
    if (action === 'saveTdKey') {
      var k = (e.parameter.key || '').trim();
      if (k) {
        PropertiesService.getScriptProperties().setProperty('TWELVE_DATA_KEY', k);
      } else {
        PropertiesService.getScriptProperties().deleteProperty('TWELVE_DATA_KEY');
      }
      return json({ok: true});
    }

    // 3b. Check whether a Twelve Data key is stored
    if (action === 'getTdKey') {
      var stored = PropertiesService.getScriptProperties().getProperty('TWELVE_DATA_KEY');
      return json({
        hasKey: !!stored,
        masked: stored ? stored.substring(0,4) + '…' + stored.substring(stored.length - 4) : null
      });
    }

    // 3. Forex — live INR/USD rate
    if (action === 'forex') {
      try {
        const url = 'https://api.exchangerate-api.com/v4/latest/USD';
        const resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
        const data = JSON.parse(resp.getContentText());
        return json({INR: data.rates.INR, updatedAt: new Date().toISOString()});
      } catch(err) {
        try {
          const url2 = 'https://open.er-api.com/v6/latest/USD';
          const resp2 = UrlFetchApp.fetch(url2, {muteHttpExceptions: true});
          const data2 = JSON.parse(resp2.getContentText());
          return json({INR: data2.rates.INR, updatedAt: new Date().toISOString()});
        } catch(err2) {
          return json({INR: null, error: err.message});
        }
      }
    }

    // 4. Load history snapshots
    if (action === 'loadHistory') {
      try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        let sheet = ss.getSheetByName(HISTORY_SHEET);
        if (!sheet) return json({history: []});
        const rows = sheet.getDataRange().getValues();
        const history = rows.slice(1).map(function(r) {
          return {date: r[0], total: r[1], us: r[2], retirement: r[3], india: r[4], gold: r[5]};
        }).filter(function(r){ return r.date && r.total; });
        return json({history: history});
      } catch(err) {
        return json({history: [], error: err.message});
      }
    }

    // 5. Load transactions
    if (action === 'loadTransactions') {
      try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        let sheet = ss.getSheetByName(TX_SHEET);
        if (!sheet) return json({transactions: []});
        const rows = sheet.getDataRange().getValues();
        const txns = rows.slice(1).map(function(r) {
          return {date: r[0], action: r[1], sym: r[2], acct: r[3], shares: r[4], price: r[5], value: r[6], note: r[7]};
        }).filter(function(r){ return r.date; });
        return json({transactions: txns});
      } catch(err) {
        return json({transactions: [], error: err.message});
      }
    }

    // 5b. Watchlist quotes.
    // US symbols come from Robinhood's public quotes endpoint (no auth), which
    // carries both the regular and the overnight (extended-hours) trade. Yahoo's
    // v7/v8 *quote* endpoints are now crumb-gated (401), but the v8 *chart*
    // endpoint still works without auth — so international symbols (and any US
    // symbol Robinhood misses) are fetched from there.
    if (action === 'quotes') {
      var wsyms = (e.parameter.symbols || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
      if (!wsyms.length) return json({quotes: {}});
      var quotes = {}, werrors = [];
      var wheaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      };

      // Yahoo chart endpoint: not crumb-gated. meta carries regularMarketPrice,
      // chartPreviousClose, currency and the long name for every exchange suffix.
      function yahooChart(sym) {
        var u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=5d';
        var r = UrlFetchApp.fetch(u, {muteHttpExceptions:true, headers:wheaders});
        if (r.getResponseCode() !== 200) return null;
        var d = JSON.parse(r.getContentText());
        var res = d.chart && d.chart.result && d.chart.result[0];
        var meta = res && res.meta;
        if (!meta) return null;
        var price = meta.regularMarketPrice;
        // chartPreviousClose with range=5d is the close ~5 sessions ago, NOT
        // yesterday's close — using it would turn the day-change into a
        // multi-day change. The second-to-last close in the series is the
        // prior trading session's close, which is the correct base.
        var closes = ((res.indicators || {}).quote || [{}])[0].close || [];
        var prev = null;
        if (closes.length >= 2 && closes[closes.length - 2] > 0) prev = closes[closes.length - 2];
        if (!(prev > 0)) prev = meta.chartPreviousClose; // fallback (e.g. new listing)
        return {
          price: price != null ? price : null,
          changePct: (price != null && prev && prev > 0) ? ((price - prev) / prev) * 100 : null,
          prevClose: prev || null,
          postPrice: null, postChangePct: null, prePrice: null, preChangePct: null,
          currency: meta.currency || '',
          name: meta.longName || meta.shortName || sym,
          exchange: meta.exchangeName || meta.fullExchangeName || '',
          marketState: ''
        };
      }

      var usSyms = wsyms.filter(function(s){ return !/\.[A-Z]{2,3}$/i.test(s); });
      var intlSyms = wsyms.filter(function(s){ return /\.[A-Z]{2,3}$/i.test(s); });

      // International symbols → Yahoo chart
      intlSyms.forEach(function(sym){
        try {
          var q = yahooChart(sym);
          if (q && q.price != null) quotes[sym] = q;
          else werrors.push(sym + ':noquote');
        } catch(e1) { werrors.push(sym + ':' + e1.message.slice(0,30)); }
      });

      // US symbols → Robinhood (regular + overnight), Yahoo chart as fallback
      if (usSyms.length) {
        try {
          var rhUrl = 'https://api.robinhood.com/quotes/?symbols=' + encodeURIComponent(usSyms.join(','));
          var rhResp = UrlFetchApp.fetch(rhUrl, {muteHttpExceptions:true, headers:wheaders});
          if (rhResp.getResponseCode() === 200) {
            var rhData = JSON.parse(rhResp.getContentText());
            (rhData.results || (rhData.symbol ? [rhData] : [])).forEach(function(r){
              var sym = r.symbol;
              if (!sym) return;
              var reg = parseFloat(r.last_trade_price);
              var prev = parseFloat(r.previous_close || r.adjusted_previous_close);
              var overnight = parseFloat(r.last_extended_hours_trade_price || r.last_non_reg_trade_price);
              if (!(reg > 0)) return;
              var regT = r.venue_last_trade_time || '';
              var extT = r.venue_last_non_reg_trade_time || r.last_non_reg_trade_time || '';
              // Robinhood's headline price is the most recent trade — the
              // extended-hours trade once the regular session ends (pre-mkt
              // 4–9:30am, after-hrs 4–8pm, overnight 8pm–4am). Its "Today" %
              // is ALWAYS the regular-session close vs the previous close
              // (verified live: page showed MU $1,017 extended but "Today
              // +4.16%" = 1012.08 vs 971.66 — the day % never follows the
              // extended price). Mirror that so the watchlist matches
              // Robinhood's own page.
              var inExt = (overnight > 0) && (extT > regT);
              var headline = inExt ? overnight : reg;
              quotes[sym] = {
                price: headline,
                changePct: (prev > 0) ? ((reg - prev) / prev) * 100 : null,
                prevClose: prev > 0 ? prev : null,
                regularClose: reg,
                postPrice: null, postChangePct: null, prePrice: null, preChangePct: null,
                // Overnight % is the extended-hours move vs the regular-session
                // close (matches Robinhood's "After-hours" line), not the
                // previous day's close.
                overnightPrice: overnight > 0 ? overnight : null,
                overnightChangePct: (overnight > 0 && reg > 0) ? ((overnight - reg) / reg) * 100 : null,
                extLabel: rhSessionLabel(extT),
                extTime: rhTimeLabel(extT),
                inExtendedHours: inExt,
                currency: 'USD',
                name: '',
                exchange: '',
                marketState: ''
              };
            });
          }
        } catch(rhErr) { werrors.push('robinhood:' + rhErr.message.slice(0,40)); }

        // Fallback for any US symbol Robinhood didn't return
        usSyms.forEach(function(sym){
          if (quotes[sym]) return;
          try {
            var q = yahooChart(sym);
            if (q && q.price != null) quotes[sym] = q;
            else werrors.push(sym + ':noquote');
          } catch(e2) { werrors.push(sym + ':' + e2.message.slice(0,30)); }
        });
      }

      return json({quotes: quotes, errors: werrors, updatedAt: new Date().toISOString()});
    }

    // 6. Timestamp-only check — cheap freshness probe for the app's pre-save guard
    if (action === 'ts') {
      const s = readSettings();
      return json({savedAt: s.savedAt || ''});
    }

    // Default: load portfolio — assemble the JSON payload from relational sheets
    return json(buildPortfolioPayload());

  } catch(err) {
    return json({error: err.message});
  }
}

// ─── POST handler ─────────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body._action || 'save';

    // Save history snapshot
    if (action === 'saveHistory') {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let sheet = ss.getSheetByName(HISTORY_SHEET);
      if (!sheet) {
        sheet = ss.insertSheet(HISTORY_SHEET);
        sheet.appendRow(['Date', 'Total (USD)', 'US Taxable', 'Retirement', 'India', 'Gold only', 'INR/USD']);
        sheet.getRange(1,1,1,7).setFontWeight('bold').setBackground('#1E3A5F').setFontColor('#FFFFFF');
      }
      sheet.appendRow([body.date, body.total, body.us, body.retirement, body.india, body.gold, body.forex]);
      return json({ok: true});
    }

    // Save transaction
    if (action === 'saveTransaction') {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let sheet = ss.getSheetByName(TX_SHEET);
      if (!sheet) {
        sheet = ss.insertSheet(TX_SHEET);
        sheet.appendRow(['Date', 'Action', 'Symbol', 'Account', 'Shares', 'Price', 'Value (USD)', 'Note']);
        sheet.getRange(1,1,1,8).setFontWeight('bold').setBackground('#1E3A5F').setFontColor('#FFFFFF');
      }
      sheet.appendRow([body.date, body.action, body.sym, body.acct, body.shares, body.price, body.value, body.note||'']);
      return json({ok: true});
    }

    // Default: save portfolio — write the JSON payload into relational sheets
    ensureSchema();
    writeHoldings(getOrCreateSheet(HOLDINGS_SHEET, HOLDINGS_HEADER), body.holdings);
    writeSettings(body);
    if (Array.isArray(body.watchlist)) writeWatchlist(body.watchlist);
    return json({ok: true});

  } catch(err) {
    return json({error: err.message});
  }
}

// ─── Relational portfolio storage ─────────────────────────────
// The JSON payload is still the wire format between the app and this script;
// these helpers translate between that payload and the row-based sheets so
// you can read/edit the data directly in Google Sheets.

function getOrCreateSheet(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (header) {
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
      sheet.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#1E3A5F').setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function num(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return isFinite(n) ? n : v;
}

function ensureSchema() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(HOLDINGS_SHEET)) return; // already relational
  const hSheet = getOrCreateSheet(HOLDINGS_SHEET, HOLDINGS_HEADER);
  getOrCreateSheet(SETTINGS_SHEET, ['Key', 'Value']);

  // One-time migration from the legacy single-cell blob in Sheet1
  const legacy = ss.getSheetByName(SHEET_NAME);
  if (!legacy) return;
  try {
    const raw = legacy.getRange('A1').getValue();
    if (!raw || typeof raw !== 'string') return;
    const obj = JSON.parse(raw);
    if (obj && obj.holdings) {
      writeHoldings(hSheet, obj.holdings);
      writeSettings(obj);
      migrateTransactions(obj.transactions);
    }
  } catch (e) { /* legacy blob unreadable — ignore */ }
}

function migrateTransactions(txns) {
  if (!txns || !txns.length) return;
  const sheet = getOrCreateSheet(TX_SHEET, ['Date', 'Action', 'Symbol', 'Account', 'Shares', 'Price', 'Value (USD)', 'Note']);
  if (sheet.getLastRow() > 1) return; // already populated — don't duplicate
  const rows = txns.map(function(t) {
    return [t.date, t.action, t.sym, t.acct, t.shares, t.price, t.value, t.note || ''];
  });
  sheet.getRange(2, 1, rows.length, 8).setValues(rows);
}

// Mirror of the client's getYahooSym: derive the Yahoo ticker from the symbol
// (India -> .NS suffix, US -> as-is). Blank when the symbol isn't refreshable.
function deriveYahooSym(sym, inr) {
  sym = String(sym || '').trim();
  if (!sym) return '';
  const skipSyms = ['CASH','SPAXX','FDRXX','MONEY MARKET','ML DIRECT'];
  if (sym.includes(' ') || skipSyms.some(function(s){ return sym.toUpperCase().includes(s); })) return '';
  if (inr) return sym.replace(/\.(NS|BO)$/i,'') + '.NS';
  return sym;
}

function writeHoldings(sheet, holdings) {
  // Yahoo Symbol is the one column users edit directly in the sheet (to fix
  // tickers). Read the current values so a stale in-memory save can't clobber
  // them back to the auto-derived ticker — the app only sets yahooSym on initial
  // import, never during a normal save/refresh.
  const existingYahoo = {}; // 'sym|acct' -> current Yahoo Symbol cell
  const curLast = sheet.getLastRow();
  if (curLast > 1) {
    const curRows = sheet.getRange(2, 1, curLast - 1, HOLDINGS_HEADER.length).getValues();
    curRows.forEach(function(r) {
      const sym = String(r[C_SYM] || '').trim();
      if (!sym) return;
      const k = sym + '|' + String(r[C_ACCT] || '').trim();
      existingYahoo[k] = String(r[C_YAHOO] || '').trim();
    });
  }

  const rows = [];
  Object.entries(holdings || {}).forEach(function(entry) {
    const key = entry[0], h = entry[1];
    if (!h) return;
    const matchKey = (h.sym || '') + '|' + (h.acct || '');
    const savedYahoo = existingYahoo[matchKey];
    const derived = deriveYahooSym(h.sym, h.inr);
    let yahooCell;
    if (savedYahoo != null && savedYahoo !== '' && savedYahoo !== derived) {
      yahooCell = savedYahoo; // genuine user edit (differs from derivation) — preserve
    } else {
      yahooCell = h.yahooSym || derived; // blank/echo cell → app value (override or derive)
    }
    rows.push([
      key,
      h.sym || '',
      h.name || h.sym || '',
      h.acct || '',
      num(h.shares),
      num(h.price),
      h.inr ? 'INR' : 'USD',
      num(h.prevPrice),
      yahooCell,
      num(h.dayPrevClose),
      h.custom ? 'Y' : ''
    ]);
  });
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, HOLDINGS_HEADER.length).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, HOLDINGS_HEADER.length).setValues(rows);
}

function readHoldings(sheet) {
  const holdings = {};
  const last = sheet.getLastRow();
  if (last <= 1) return holdings;
  const data = sheet.getRange(2, 1, last - 1, HOLDINGS_HEADER.length).getValues();
  const seen = {};
  data.forEach(function(r) {
    const sym = String(r[C_SYM] || '').trim();
    if (!sym) return; // skip blank rows
    let key = String(r[C_KEY] || '').trim();
    if (!key) key = sym + '-' + String(r[C_ACCT] || '').trim();
    seen[key] = (seen[key] || 0) + 1;
    if (seen[key] > 1) key = key + '-' + seen[key];
    const h = {
      sym: sym,
      name: String(r[C_NAME] || '').trim() || sym,
      shares: num(r[C_SHARES]) || 0,
      price: num(r[C_PRICE]) || 0,
      acct: String(r[C_ACCT] || '').trim()
    };
    const curr = String(r[C_CURR] || '').trim().toUpperCase();
    if (curr === 'INR') h.inr = true;
    const prev = num(r[C_PREV]); if (prev !== '') h.prevPrice = prev;
    // Only keep the Yahoo Symbol as an override when it differs from what we'd
    // derive from Symbol — a value that merely echoes the derivation stays
    // derived, so editing the Symbol column later re-derives correctly.
    const yahoo = String(r[C_YAHOO] || '').trim();
    if (yahoo && yahoo !== deriveYahooSym(sym, curr === 'INR')) h.yahooSym = yahoo;
    const daypc = num(r[C_DAYPC]); if (daypc !== '') h.dayPrevClose = daypc;
    const cust = r[C_CUSTOM];
    if (cust === 'Y' || cust === 'y' || cust === true || cust === 'TRUE') h.custom = true;
    holdings[key] = h;
  });
  return holdings;
}

function readSettings() {
  const settings = {};
  const sheet = getOrCreateSheet(SETTINGS_SHEET, ['Key', 'Value']);
  const last = sheet.getLastRow();
  if (last <= 1) return settings;
  const rows = sheet.getRange(2, 1, last - 1, 2).getValues();
  rows.forEach(function(r) {
    if (r[0] !== '' && r[0] != null) settings[String(r[0]).trim()] = r[1];
  });
  return settings;
}

function writeSettings(obj) {
  const sheet = getOrCreateSheet(SETTINGS_SHEET, ['Key', 'Value']);
  const s = obj || {};

  // Read what's currently stored so a real value can't be silently wiped by a
  // stale/empty save (e.g. the app pushing goldGrams: 0 before it has loaded).
  const existing = {};
  const curLast = sheet.getLastRow();
  if (curLast > 1) {
    const curRows = sheet.getRange(2, 1, curLast - 1, 2).getValues();
    curRows.forEach(function(r) {
      if (r[0] !== '' && r[0] != null) existing[String(r[0]).trim()] = r[1];
    });
  }

  // Keep a non-zero stored number when the incoming value is 0/empty — the app
  // uses 0 as its "not set yet" default, so overwriting real data with it is
  // how gold.grams (and pension, Niveshaay…) kept getting reset to zero.
  const keepIfReal = function(key, incoming) {
    const inc = num(incoming);
    const cur = num(existing[key]);
    if ((inc === 0 || inc === '') && typeof cur === 'number' && isFinite(cur) && cur !== 0) return cur;
    return inc === '' ? 0 : inc;
  };

  const rows = [
    ['version', '2'],
    ['savedAt', s.savedAt || new Date().toISOString()],
    ['niveshaay.val', keepIfReal('niveshaay.val', s.acctOverrides && s.acctOverrides.niveshaay)],
    ['niveshaay.units', keepIfReal('niveshaay.units', s.niveshaayData && s.niveshaayData.units)],
    ['niveshaay.nav', keepIfReal('niveshaay.nav', s.niveshaayData && s.niveshaayData.nav)],
    ['niveshaay.costINR', keepIfReal('niveshaay.costINR', s.niveshaayData && s.niveshaayData.costINR)],
    ['niveshaay.asOf', (s.niveshaayData && s.niveshaayData.asOf) || ''],
    ['pension.val', keepIfReal('pension.val', s.acctOverrides && s.acctOverrides.pension)],
    ['stallion.asOf', (s.stallionData && s.stallionData.asOf) || ''],
    ['gold.price', keepIfReal('gold.price', s.goldPrice)],
    ['gold.grams', keepIfReal('gold.grams', s.goldGrams)],
    ['excluded', (s.excluded || []).join(',')]
  ];
  // Preserve any extra keys the user added directly in the Settings tab — only
  // the canonical keys above are rewritten from the app payload.
  const canon = {};
  rows.forEach(function(r) { canon[r[0]] = true; });
  Object.keys(existing).forEach(function(k) {
    if (!canon[k]) rows.push([k, existing[k]]);
  });
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, 2).clearContent();
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

function readTransactions() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TX_SHEET);
    if (!sheet) return [];
    const rows = sheet.getDataRange().getValues();
    return rows.slice(1).map(function(r) {
      return {date: r[0], action: r[1], sym: r[2], acct: r[3], shares: r[4], price: r[5], value: r[6], note: r[7]};
    }).filter(function(r) { return r.date; }).slice(0, 200);
  } catch (err) {
    return [];
  }
}

function readWatchlist() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(WATCHLIST_SHEET);
    if (!sheet) return null; // no tab yet → omit the field so the app seeds defaults
    const last = sheet.getLastRow();
    if (last <= 1) return [];
    const rows = sheet.getRange(2, 1, last - 1, 3).getValues();
    const out = [];
    rows.forEach(function(r) {
      const sym = String(r[0] || '').trim();
      if (!sym) return;
      out.push({sym: sym, name: String(r[1] || '').trim() || sym, market: String(r[2] || '').trim().toLowerCase() || 'us'});
    });
    return out;
  } catch (err) { return null; }
}

function writeWatchlist(list) {
  const sheet = getOrCreateSheet(WATCHLIST_SHEET, WATCHLIST_HEADER);
  const rows = (list || []).map(function(w) {
    return [w.sym, w.name || w.sym, w.market || 'us'];
  });
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, 3).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 3).setValues(rows);
}

function buildPortfolioPayload() {
  ensureSchema();
  const holdings = readHoldings(getOrCreateSheet(HOLDINGS_SHEET, HOLDINGS_HEADER));
  const s = readSettings();
  const nv = function(k) { const v = num(s[k]); return v === '' ? 0 : v; };
  const payload = {
    version: 2,
    savedAt: s.savedAt || new Date().toISOString(),
    holdings: holdings,
    acctOverrides: {
      niveshaay: nv('niveshaay.val'),
      pension: nv('pension.val')
    },
    niveshaayData: {
      units: nv('niveshaay.units'),
      nav: nv('niveshaay.nav'),
      costINR: nv('niveshaay.costINR'),
      asOf: s['niveshaay.asOf'] || ''
    },
    stallionData: {
      asOf: s['stallion.asOf'] || ''
    },
    excluded: s.excluded ? String(s.excluded).split(',').map(function(x) { return x.trim(); }).filter(Boolean) : [],
    goldPrice: nv('gold.price'),
    goldGrams: nv('gold.grams'),
    transactions: readTransactions()
  };
  // Omit watchlist when no Watchlist tab exists yet — a missing tab must not be
  // mistaken for an empty (user-cleared) list, or the app's seeded defaults get
  // wiped on the very first load.
  const wl = readWatchlist();
  if (wl !== null) payload.watchlist = wl;
  return payload;
}

function updateSetting(key, value) {
  const sheet = getOrCreateSheet(SETTINGS_SHEET, ['Key', 'Value']);
  const last = sheet.getLastRow();
  let target = -1;
  if (last > 1) {
    const keys = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0]).trim() === key) { target = i + 2; break; }
    }
  }
  if (target === -1) sheet.appendRow([key, value]);
  else sheet.getRange(target, 2).setValue(value);
}

// Simple trigger: when the user edits Holdings or Settings directly, mark the
// sheet newer so the app's pre-save freshness check pulls those edits down
// before its next write (otherwise a stale in-memory save could clobber them).
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sheetName = e.range.getSheet().getName();
    if (sheetName !== HOLDINGS_SHEET && sheetName !== SETTINGS_SHEET) return;
    updateSetting('savedAt', new Date().toISOString());
  } catch (err) { /* silent */ }
}

// ── Run this from the Apps Script editor to authorize + test ──
function authorizeAndTest() {
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': 'https://finance.yahoo.com/'
  };
  var resp = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d', {
    muteHttpExceptions: true,
    headers: headers
  });
  var code = resp.getResponseCode();
  Logger.log('HTTP status: ' + code);
  var data = JSON.parse(resp.getContentText());
  var meta = ((data.chart || {}).result || [{}])[0].meta || {};
  Logger.log('AAPL price: ' + (meta.regularMarketPrice || meta.previousClose));
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Classify a Robinhood extended-hours trade by US Eastern time of day.
// Robinhood's 24-hour market: pre-market 4–9:30am, regular 9:30am–4pm,
// after-hours 4–8pm, overnight 8pm–4am (all ET). The user draws the
// after-hours vs overnight line at 8pm, so this never blurs the two.
function rhSessionLabel(isoUtc) {
  if (!isoUtc) return 'After-hrs';
  var ms = Date.parse(isoUtc);
  if (!isFinite(ms)) return 'After-hrs';
  var year = new Date(ms).getUTCFullYear();
  // US Eastern DST: 2nd Sunday of March → 1st Sunday of November.
  var mar1 = new Date(Date.UTC(year, 2, 1));
  var firstSunMar = ((7 - mar1.getUTCDay()) % 7) + 1;
  var dstStart = Date.UTC(year, 2, firstSunMar + 7, 7);  // 7:00 UTC = 3am EDT boundary
  var nov1 = new Date(Date.UTC(year, 10, 1));
  var firstSunNov = ((7 - nov1.getUTCDay()) % 7) + 1;
  var dstEnd = Date.UTC(year, 10, firstSunNov, 6);       // 6:00 UTC = 2am EDT boundary
  var offset = (ms >= dstStart && ms < dstEnd) ? 4 : 5;  // hours behind UTC
  var d = new Date(ms - offset * 3600000);
  var h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (h >= 16 && h < 20) return 'After-hrs';
  if (h >= 20 || h < 4) return 'Overnight';
  if (h >= 4 && h < 9.5) return 'Pre-mkt';
  return 'After-hrs';
}

// Format a Robinhood trade timestamp as US Eastern wall-clock time, e.g.
// "7:59 PM". Shown next to the extended-hours label so a stale after-hours
// print is never mistaken for the live overnight price (Robinhood's public
// API stops at 8 PM ET — the 8pm–4am overnight session is not exposed).
function rhTimeLabel(isoUtc) {
  if (!isoUtc) return '';
  var ms = Date.parse(isoUtc);
  if (!isFinite(ms)) return '';
  var year = new Date(ms).getUTCFullYear();
  var mar1 = new Date(Date.UTC(year, 2, 1));
  var firstSunMar = ((7 - mar1.getUTCDay()) % 7) + 1;
  var dstStart = Date.UTC(year, 2, firstSunMar + 7, 7);
  var nov1 = new Date(Date.UTC(year, 10, 1));
  var firstSunNov = ((7 - nov1.getUTCDay()) % 7) + 1;
  var dstEnd = Date.UTC(year, 10, firstSunNov, 6);
  var offset = (ms >= dstStart && ms < dstEnd) ? 4 : 5;
  var d = new Date(ms - offset * 3600000);
  var h = d.getUTCHours(), m = d.getUTCMinutes();
  var ampm = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12 || 12;
  return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
}
