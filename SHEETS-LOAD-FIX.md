## Sheets load timeout fix

Client-side fix for intermittent Sheets load failures:
- Raise fetch timeouts from 8s to 25s for portfolio/history/save
- Retry once on abort/timeout (`fetchSheets`)
- Serialize history load after portfolio load on startup (Apps Script concurrency)
- Clearer timeout error messages

Patched `index.html` is ready locally; pushing via API next.
