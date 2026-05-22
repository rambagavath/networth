const SHEET_NAME = 'Sheet1';
const HISTORY_SHEET = 'History';
const TX_SHEET = 'Transactions';

// ─── GET handler ──────────────────────────────────────────────
function doGet(e) {
  try {
    const action = e.parameter.action || 'load';

    // 1. Ticker search — proxies Yahoo Finance (no CORS!)
    if (action === 'search') {
      const q = e.parameter.q || '';
      if (!q) return json({quotes: []});
      const url = 'https://query1.finance.yahoo.com/v1/finance/search?q='
        + encodeURIComponent(q) + '"esCount=10&newsCount=0';
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

      symList.forEach(function(sym) {
        sym = sym.trim();
        if (!sym) return;
        try {
          // Use the chart endpoint — more reliable than quote for Apps Script
          var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&range=1d';
          resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true, headers: headers});
          code = resp.getResponseCode();
          if (code === 200) {
            parsed = JSON.parse(resp.getContentText());
            var meta = ((parsed.chart || {}).result || [{}])[0].meta || {};
            price = meta.regularMarketPrice || meta.previousClose;
            if (price) {
              var clean = sym.replace(/\.(NS|BO)$/i, '');
              prices[clean] = price;
              prices[sym] = price;
              var pc = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPreviousClose;
              if (pc) { prevCloses[clean] = pc; prevCloses[sym] = pc; }
              return;
            }
          }
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
      var tdKey = PropertiesService.getScriptProperties().getProperty('TWELVE_DATA_KEY')
                  || '7d9a4575d3104cae88dd178c9448d22b';
      var failedNSE = symList.filter(function(s) {
        s = s.trim();
        if (!s) return false;
        var clean = s.replace(/\.(NS|BO)$/i, '');
        return /\.NS$/i.test(s) && !prices[clean] && !prices[s];
      });
      if (failedNSE.length > 0) {
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
          stillMissing.forEach(function(s, i) {
            // Strip .NS and -SM suffix so Google Finance gets the plain NSE symbol
            var sym = s.trim().replace(/\.NS$/i, '').replace(/-SM$/i, '');
            tmp.getRange(i + 1, 1).setFormula('=IFERROR(GOOGLEFINANCE("NSE:' + sym + '","price"),0)');
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
      // ────────────────────────────────────────────────────────────────

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

    // 2b. Historical price for a symbol on a given date
    if (action === 'histPrice') {
      var histSym  = e.parameter.sym  || '';
      var histDate = e.parameter.date || ''; // YYYY-MM-DD
      if (!histSym || !histDate) return json({error: 'sym and date required'});
      try {
        var histD  = new Date(histDate + 'T12:00:00Z');
        var histP1 = Math.floor(histD.getTime() / 1000);
        var histP2 = histP1 + 86400 * 4; // look ahead a few days in case of weekend/holiday
        var histUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(histSym)
          + '?period1=' + histP1 + '&period2=' + histP2 + '&interval=1d';
        var histHeaders = {'User-Agent':'Mozilla/5.0','Accept':'application/json','Referer':'https://finance.yahoo.com/'};
        var histResp = UrlFetchApp.fetch(histUrl, {muteHttpExceptions: true, headers: histHeaders});
        var histData = JSON.parse(histResp.getContentText());
        var histResult = ((histData.chart || {}).result || [null])[0];
        if (!histResult) return json({error: 'No data for ' + histSym});
        var histCloses = ((histResult.indicators || {}).quote || [{}])[0].close || [];
        var histTimestamps = histResult.timestamp || [];
        // find closest trading day at or after the requested date
        var histPriceVal = null, histActualDate = null;
        for (var hi = 0; hi < histCloses.length; hi++) {
          if (histCloses[hi] != null) {
            histPriceVal = histCloses[hi];
            histActualDate = new Date(histTimestamps[hi] * 1000).toISOString().slice(0, 10);
            break;
          }
        }
        if (histPriceVal == null) return json({error: 'No closing price found near ' + histDate});
        return json({price: histPriceVal, date: histActualDate, sym: histSym});
      } catch(err) {
        return json({error: err.message});
      }
    }

    // 3. Forex — live INR/USD rate
    if (action === 'forex') {
      try {
        const url = 'https://api.exchangerate-api.com/v4/latest/USD';
        const resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
        const data = JSON.parse(resp.getContentText());
        return json({INR: data.rates.INR, updatedAt: new Date().toISOString()});
      } catch(err) {
        // Fallback: try another free API
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

    // Default: load portfolio
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const data = sheet.getRange('A1').getValue();
    return json(data ? JSON.parse(data) : {});

  } catch(err) {
    return json({error: err.message});
  }
}

// ─── POST handler ─────────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body._action || 'save';

    // Save history snapshot (append)
    if (action === 'saveHistory') {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let sheet = ss.getSheetByName(HISTORY_SHEET);
      if (!sheet) {
        sheet = ss.insertSheet(HISTORY_SHEET);
        sheet.appendRow(['Date', 'Total (USD)', 'US Taxable', 'Retirement', 'India+Gold', 'Gold only', 'INR/USD']);
        sheet.getRange(1,1,1,7).setFontWeight('bold').setBackground('#1E3A5F').setFontColor('#FFFFFF');
      }
      sheet.appendRow([body.date, body.total, body.us, body.retirement, body.india, body.gold, body.forex]);
      return json({ok: true});
    }

    // Upsert history snapshot — update existing row for this date, or append
    if (action === 'upsertHistory') {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let sheet = ss.getSheetByName(HISTORY_SHEET);
      if (!sheet) {
        sheet = ss.insertSheet(HISTORY_SHEET);
        sheet.appendRow(['Date', 'Total (USD)', 'US Taxable', 'Retirement', 'India+Gold', 'Gold only', 'INR/USD']);
        sheet.getRange(1,1,1,7).setFontWeight('bold').setBackground('#1E3A5F').setFontColor('#FFFFFF');
      }
      var newRow = [body.date, body.total, body.us, body.retirement, body.india, body.gold, body.forex];
      var data = sheet.getDataRange().getValues();
      var found = false;
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][0]).trim() === String(body.date).trim()) {
          sheet.getRange(i + 1, 1, 1, newRow.length).setValues([newRow]);
          found = true;
          break;
        }
      }
      if (!found) sheet.appendRow(newRow);
      return json({ok: true, updated: found});
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

    // Default: save portfolio (raw JSON string posted)
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    sheet.getRange('A1').setValue(e.postData.contents);
    return json({ok: true});

  } catch(err) {
    // Also try treating body as raw portfolio string
    try {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
      sheet.getRange('A1').setValue(e.postData.contents);
      return json({ok: true});
    } catch(e2) {
      return json({error: err.message});
    }
  }
}


// ── Run THIS function from the editor to trigger authorization + test ──
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
