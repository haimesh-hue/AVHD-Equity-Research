# Equity Research Hub

A fast, private, no-build web app for organizing equity research: a searchable company library with
auto-populated financials, an annotatable thesis per company, and a notebook for **typed and
handwritten** notes (pen, stylus, touch), including markup over PDFs, charts and screenshots.

Everything runs in the browser. Your research is stored locally (IndexedDB) and can be exported, imported,
or committed to the repo as a backup. Company data is refreshed automatically by a scheduled GitHub Action.

## Features

**Organize**
- Company library with status pipeline (Idea → Researching → Watchlist → Owned → Passed / Sold), 1–5 conviction stars, tags, pinning
- Table view (sortable columns: price, fair value, upside, market cap, P/E, growth, margin…) or card view; filter by status, sector and tag; CSV export
- Per company: Overview (valuation inputs, price vs. fair value chart, key metrics, profile, links & SEC filings), Thesis, Financials, Notes, Files
- Dashboard: pipeline counts, biggest upside to fair value, "trading below your buy price" alerts, recent companies/notes/annotations, quick capture

**Search** — one box (`/` or `Ctrl+K`) across tickers, names, sectors, tags, thesis, notes and annotation comments, with filters:

| Filter | Example |
|---|---|
| tag / status / sector / ticker | `tag:moat status:owned sector:software ticker:aapl` |
| numeric comparisons | `rating:>=4 upside:>25 pe:<15 roe:>20 growth:>10 margin:>15` |
| kinds | `type:note is:pinned is:annotated is:handwritten` |
| phrases | `"pricing power"` |

**Annotate & take notes**
- Rich-text notes: headings, lists, checklists, quotes, links, date stamps, pasted images; Markdown-style shortcuts (`#`, `-`, `1.`, `[]`, `>` + space)
- Highlights in 4 colours with optional comments (`Ctrl+Shift+H`, `Ctrl+Shift+M`); click any highlight to edit; an annotations side panel lists them all
- Handwritten notes: pressure-sensitive pen, highlighter (auto-straightens for underlining), stroke eraser (also the stylus eraser end), undo/redo, zoom, blank/lined/grid/dot paper, multiple pages, "stylus only" palm rejection
- Annotate files: open a PDF (every page becomes an ink page), chart or screenshot and write on top of it
- Searchable transcription field for handwritten pages; export notes as HTML or pages as PNG
- Attach files (10-Ks, decks, models) to a company — stored locally

**Auto-populate data**
1. **SEC EDGAR (free, automatic):** `.github/workflows/update-data.yml` runs every weekday after the US close.
   It reads `data/watchlist.txt` and writes `data/companies/<TICKER>.json` (profile, sector, ~10 years of annual
   financials, recent filings, 2 years of weekly prices) plus `data/tickers.json` for ticker autocomplete.
   The app pulls newer snapshots in automatically each time it opens.
2. **Instant (optional):** add a free [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs)
   API key in *Settings* to fetch data the moment you add a company.

Your own edits (name, sector, description…) are never overwritten by auto-data. Each refresh also
appends to a per-company price log, so price history builds up over time.

## Getting started

### Run locally
```bash
python3 -m http.server 8000   # any static server works
# open http://localhost:8000
```
(Opening `index.html` directly via `file://` won't work because browsers block ES modules there.)

### Host on GitHub Pages
Repository **Settings → Pages → Build and deployment → Deploy from a branch**, pick your default branch and `/ (root)`.

### Turn on automatic data
1. (Recommended) add a repository secret **`SEC_USER_AGENT`** such as `Jane Doe jane@example.com` — the SEC asks automated clients to identify themselves.
2. **Actions → Update company data → Run workflow**. Optionally type tickers (e.g. `ASML, CPRT`) to add them to the watchlist.
3. Keep `data/watchlist.txt` in sync with your library: *Settings → Watchlist for the data Action* gives you the full list to paste.

Run the updater yourself: `python3 scripts/update_data.py [TICKERS…] [--add]` (standard library only).

### Back up / move between devices
*Settings → Export everything* downloads a JSON backup (including attached files).
*Export without files* produces `research.json` — commit it as `data/research.json` and a fresh browser loads it automatically on first run.

> Note: if the repo or Pages site is public, anything you commit (including `data/research.json`) is public too.

## Keyboard shortcuts
| Key | Action |
|---|---|
| `/` or `Ctrl+K` | Search |
| `c` | Add company |
| `n` | New note |
| `Ctrl+Shift+H` / `Ctrl+Shift+M` | Highlight / highlight with comment |
| `P` / `H` / `E` | Pen / highlighter / eraser (handwriting) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo ink |

## Project layout
```
index.html               app shell
css/styles.css           styles (light + dark)
js/app.js                router & views
js/db.js                 IndexedDB storage, backup/restore
js/data.js               auto-populate (repo snapshots, FMP), derived metrics
js/search.js             query parser + ranking
js/editor.js             rich-text editor with highlight/comment annotations
js/ink.js                handwriting canvas, PDF/image underlays
js/charts.js             dependency-free SVG charts
scripts/update_data.py   SEC EDGAR + price fetcher used by the Action
data/watchlist.txt       tickers the Action refreshes
```
