# Apps Script — Net Worth Tracker Backend

`Code.gs` is the Google Apps Script that powers the server-side features of the tracker.

## Setup

1. Open your Google Sheet → **Extensions → Apps Script**
2. Delete any existing code
3. Paste the contents of `Code.gs`
4. Click **Save** (Ctrl+S), then **Deploy → New deployment**
5. Type: **Web app** · Execute as: **Me** · Who has access: **Anyone**
6. Copy the deployment URL into `config.json` as `gsUrl`

## Actions (GET)

| action | params | description |
|--------|--------|-------------|
| `load` | — | Returns saved portfolio JSON from Sheet1 A1 |
| `search` | `q` | Proxies Yahoo Finance ticker search (avoids CORS) |
| `prices` | `symbols` | Fetches live prices for comma-separated symbols |
| `histPrice` | `sym`, `date` (YYYY-MM-DD) | Returns closing price for a symbol on a given date |
| `forex` | — | Returns live USD/INR rate |
| `loadHistory` | — | Returns net worth history snapshots |
| `loadTransactions` | — | Returns transaction log |
| `saveTdKey` | `key` | Saves Twelve Data API key to Script Properties |
| `getTdKey` | — | Returns whether a Twelve Data key is stored |

## Actions (POST)

| `_action` | description |
|-----------|-------------|
| `saveHistory` | Appends a net worth snapshot row to the History sheet |
| `saveTransaction` | Appends a transaction row to the Transactions sheet |
| *(default)* | Saves raw portfolio JSON string to Sheet1 A1 |

## Redeploying

After any code change, go to **Deploy → Manage deployments → Edit → New version → Deploy**.
The deployment URL stays the same.
