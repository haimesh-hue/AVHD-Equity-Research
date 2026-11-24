#!/usr/bin/env python3
"""Refresh company data for the Equity Research Hub.

Reads tickers from data/watchlist.txt (one per line, '#' comments allowed) plus any passed on the
command line, and writes:

  data/tickers.json             – every SEC-registered ticker, for autocomplete in the app
  data/companies/<TICKER>.json  – profile, ~10 years of annual financials, recent filings, price

Sources: SEC EDGAR (free, official) for profile/financials/filings; Yahoo Finance chart API with a
Stooq fallback for prices. Standard library only, so it runs anywhere (GitHub Actions, cron, laptop).

SEC asks automated clients to identify themselves: set SEC_USER_AGENT="Your Name your@email.com".
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
COMPANIES = DATA / "companies"
UA = os.environ.get("SEC_USER_AGENT") or "EquityResearchHub research-bot admin@example.com"


def get(url: str, *, sec: bool = False, retries: int = 3) -> bytes:
    headers = {"User-Agent": UA if sec else "Mozilla/5.0 (EquityResearchHub data refresher)", "Accept-Encoding": "identity"}
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            if sec:
                time.sleep(0.15)  # stay well under SEC's 10 req/s fair-access limit
            return data
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 404:
                raise
            time.sleep(1.5 * (attempt + 1))
        except Exception as e:  # network hiccup
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def get_json(url: str, **kw):
    return json.loads(get(url, **kw))


# --------------------------------------------------------------------------- ticker index

def load_ticker_map() -> dict[str, dict]:
    j = get_json("https://www.sec.gov/files/company_tickers_exchange.json", sec=True)
    fields = j["fields"]
    out = {}
    rows = []
    for row in j["data"]:
        rec = dict(zip(fields, row))
        t = str(rec["ticker"]).upper()
        out.setdefault(t, rec)
        rows.append([t, rec["name"], str(rec["cik"]), rec.get("exchange") or ""])
    DATA.mkdir(exist_ok=True)
    (DATA / "tickers.json").write_text(json.dumps({"updated": date.today().isoformat(), "data": rows}, separators=(",", ":")))
    return out


# --------------------------------------------------------------------------- SEC helpers

SECTORS = [
    ((3570, 3579), "Technology"), ((3600, 3699), "Technology"), ((7370, 7379), "Technology"), ((3820, 3829), "Technology"),
    ((2830, 2836), "Healthcare"), ((3840, 3851), "Healthcare"), ((8000, 8099), "Healthcare"), ((8730, 8734), "Healthcare"),
    ((1300, 1399), "Energy"), ((2900, 2999), "Energy"), ((4900, 4999), "Utilities"), ((4800, 4899), "Communication Services"),
    ((6000, 6411), "Financials"), ((6500, 6553), "Real Estate"), ((6798, 6798), "Real Estate"), ((6700, 6799), "Financials"),
    ((5200, 5999), "Consumer"), ((2000, 2199), "Consumer Staples"), ((7000, 7999), "Consumer Services"),
    ((1000, 1499), "Materials"), ((2600, 2699), "Materials"), ((2800, 2829), "Materials"), ((3300, 3399), "Materials"),
    ((3700, 3799), "Industrials"), ((3400, 3569), "Industrials"), ((1500, 1799), "Industrials"), ((4000, 4799), "Industrials"),
    ((5000, 5199), "Industrials"), ((8700, 8799), "Industrials"),
]


def sector_for(sic) -> str | None:
    try:
        s = int(sic)
    except (TypeError, ValueError):
        return None
    for (lo, hi), name in SECTORS:
        if lo <= s <= hi:
            return name
    return None


FLOW = {
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax",
                "SalesRevenueNet", "SalesRevenueGoodsNet", "RevenuesNetOfInterestExpense", "Revenue"],
    "grossProfit": ["GrossProfit"],
    "operatingIncome": ["OperatingIncomeLoss", "ProfitLossFromOperatingActivities"],
    "netIncome": ["NetIncomeLoss", "ProfitLossAttributableToOwnersOfParent", "ProfitLoss"],
    "eps": ["EarningsPerShareBasic", "BasicEarningsLossPerShare"],
    "epsDiluted": ["EarningsPerShareDiluted", "DilutedEarningsLossPerShare"],
    "ocf": ["NetCashProvidedByUsedInOperatingActivities", "CashFlowsFromUsedInOperatingActivities"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"],
    "shares": ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"],
    "dividendsPerShare": ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"],
    "buybacks": ["PaymentsForRepurchaseOfCommonStock"],
}
INSTANT = {
    "totalAssets": ["Assets"],
    "totalLiabilities": ["Liabilities"],
    "equity": ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "EquityAttributableToOwnersOfParent", "Equity"],
    "cash": ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "CashAndCashEquivalents"],
    "debt": ["LongTermDebt", "LongTermDebtNoncurrent", "LongTermBorrowings"],
}
ANNUAL_FORMS = {"10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A", "10-KT"}


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _units(fact: dict):
    u = fact.get("units", {})
    for k in ("USD", "USD/shares", "shares"):
        if k in u:
            return u[k]
    # foreign filers: first currency unit
    return next(iter(u.values()), [])


def annual_series(facts: dict, names: list[str], flow: bool) -> dict[str, float]:
    """Return {period_end: value} for annual periods, preferring the first concept with good coverage."""
    best: dict[str, float] = {}
    for ns in ("us-gaap", "ifrs-full"):
        for name in names:
            fact = facts.get(ns, {}).get(name)
            if not fact:
                continue
            series: dict[str, tuple[str, float]] = {}
            for v in _units(fact):
                if v.get("form") not in ANNUAL_FORMS:
                    continue
                end = v.get("end")
                if not end:
                    continue
                if flow:
                    start = v.get("start")
                    if not start or not (340 <= _days(start, end) <= 380):
                        continue
                filed = v.get("filed", "")
                if end not in series or filed > series[end][0]:  # latest filing wins (restatements)
                    series[end] = (filed, v["val"])
            vals = {k: x[1] for k, x in series.items()}
            # merge: keep values from earlier-listed concepts, fill gaps from later ones
            for k, x in vals.items():
                best.setdefault(k, x)
    return best


def build_financials(facts_json: dict, years: int = 10) -> list[dict]:
    facts = facts_json.get("facts", {})
    flows = {k: annual_series(facts, v, True) for k, v in FLOW.items()}
    insts = {k: annual_series(facts, v, False) for k, v in INSTANT.items()}
    anchor = flows["revenue"] or flows["netIncome"]
    ends = sorted(anchor.keys())
    # collapse period ends that are within a week of each other (52/53-week years)
    periods: list[str] = []
    for e in ends:
        if periods and abs(_days(periods[-1], e)) < 20:
            periods[-1] = e
        else:
            periods.append(e)
    periods = periods[-years:]

    def near(series: dict[str, float], end: str):
        if end in series:
            return series[end]
        for k, v in series.items():
            if abs(_days(k, end)) <= 10:
                return v
        return None

    rows = []
    for end in periods:
        fy = int(end[:4]) if int(end[5:7]) > 3 else int(end[:4]) - 1  # Jan–Mar year-ends belong to prior fiscal year
        r = {"fy": fy, "end": end}
        for k, s in {**flows, **insts}.items():
            v = near(s, end)
            if v is not None:
                r[k] = v
        if "ocf" in r and "capex" in r:
            r["fcf"] = r["ocf"] - r["capex"]
        rows.append(r)
    return rows


def shares_outstanding(facts_json: dict):
    f = facts_json.get("facts", {}).get("dei", {}).get("EntityCommonStockSharesOutstanding")
    if not f:
        return None
    vals = f.get("units", {}).get("shares", [])
    if not vals:
        return None
    latest = max(vals, key=lambda v: (v.get("end", ""), v.get("filed", "")))
    # sum multiple share classes reported for the same date
    same = {v.get("frame") or id(v): v["val"] for v in vals if v.get("end") == latest.get("end") and v.get("filed") == latest.get("filed")}
    return sum(same.values()) or latest["val"]


# --------------------------------------------------------------------------- prices

def price_yahoo(ticker: str):
    sym = ticker.replace(".", "-")
    j = get_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=2y&interval=1wk&includePrePost=false")
    res = j["chart"]["result"][0]
    meta = res["meta"]
    ts = res.get("timestamp") or []
    closes = res["indicators"]["quote"][0].get("close") or []
    hist = [{"date": datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat(), "price": round(c, 4)} for t, c in zip(ts, closes) if c]
    last = meta.get("regularMarketPrice") or (hist[-1]["price"] if hist else None)
    prev = meta.get("chartPreviousClose") or meta.get("previousClose")
    day = datetime.fromtimestamp(meta.get("regularMarketTime", time.time()), tz=timezone.utc).date().isoformat()
    j2 = None
    try:
        j2 = get_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=5d&interval=1d")
        q = j2["chart"]["result"][0]["indicators"]["quote"][0]["close"]
        q = [x for x in q if x]
        if len(q) >= 2:
            prev = q[-2]
    except Exception:
        pass
    change = (last / prev - 1) * 100 if last and prev else None
    if hist and hist[-1]["date"] != day and last:
        hist.append({"date": day, "price": round(last, 4)})
    return {"last": last, "date": day, "changePct": round(change, 3) if change is not None else None, "currency": meta.get("currency")}, hist


def price_stooq(ticker: str):
    sym = ticker.lower().replace(".", "-") + ".us"
    raw = get(f"https://stooq.com/q/d/l/?s={sym}&i=w").decode()
    rows = list(csv.DictReader(io.StringIO(raw)))
    rows = [r for r in rows if r.get("Close") not in (None, "", "N/D")][-104:]
    if not rows:
        raise RuntimeError("no stooq data")
    hist = [{"date": r["Date"], "price": float(r["Close"])} for r in rows]
    last = hist[-1]
    prev = hist[-2]["price"] if len(hist) > 1 else None
    return {"last": last["price"], "date": last["date"], "changePct": None}, hist


def fetch_price(ticker: str):
    for fn in (price_yahoo, price_stooq):
        try:
            return fn(ticker)
        except Exception as e:
            print(f"  price via {fn.__name__} failed: {e}", file=sys.stderr)
    return None, None


# --------------------------------------------------------------------------- main

def build_company(ticker: str, tmap: dict) -> dict | None:
    rec = tmap.get(ticker) or tmap.get(ticker.replace(".", "-")) or tmap.get(ticker.replace("-", "."))
    out: dict = {"ticker": ticker, "source": "SEC EDGAR", "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    if rec:
        cik = int(rec["cik"])
        cik10 = f"{cik:010d}"
        out.update(cik=str(cik), name=rec["name"], exchange=rec.get("exchange"))
        try:
            sub = get_json(f"https://data.sec.gov/submissions/CIK{cik10}.json", sec=True)
            out["name"] = sub.get("name") or out["name"]
            out["sic"] = sub.get("sic")
            out["industry"] = (sub.get("sicDescription") or "").title() or None
            out["sector"] = sector_for(sub.get("sic"))
            out["website"] = sub.get("website") or None
            out["fiscalYearEnd"] = sub.get("fiscalYearEnd")
            biz = (sub.get("addresses") or {}).get("business") or {}
            out["country"] = biz.get("stateOrCountryDescription")
            recent = sub.get("filings", {}).get("recent", {})
            filings = []
            for form, acc, d, doc in zip(recent.get("form", []), recent.get("accessionNumber", []), recent.get("filingDate", []), recent.get("primaryDocument", [])):
                if form in {"10-K", "10-Q", "8-K", "20-F", "40-F", "6-K", "DEF 14A", "S-1"}:
                    filings.append({"form": form, "date": d, "url": f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc}"})
                if len(filings) >= 15:
                    break
            out["filings"] = filings
        except Exception as e:
            print(f"  submissions failed: {e}", file=sys.stderr)
        try:
            facts = get_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik10}.json", sec=True)
            out["financials"] = {"annual": build_financials(facts)}
            out["sharesOutstanding"] = shares_outstanding(facts)
        except Exception as e:
            print(f"  companyfacts failed: {e}", file=sys.stderr)
    else:
        print(f"  {ticker}: not an SEC registrant; price only", file=sys.stderr)
    price, hist = fetch_price(ticker)
    if price:
        out["price"] = price
        out["priceHistory"] = hist
        if out.get("sharesOutstanding") and price.get("last"):
            out["marketCap"] = round(out["sharesOutstanding"] * price["last"])
    if not rec and not price:
        return None
    return {k: v for k, v in out.items() if v is not None}


def read_watchlist() -> list[str]:
    p = DATA / "watchlist.txt"
    if not p.exists():
        return []
    out = []
    for line in p.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        out += [t.strip().upper() for t in line.replace(",", " ").split() if t.strip()]
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tickers", nargs="*", help="extra tickers to refresh")
    ap.add_argument("--add", action="store_true", help="also append the given tickers to data/watchlist.txt")
    args = ap.parse_args()

    extra = [t.upper() for raw in args.tickers for t in raw.replace(",", " ").split() if t]
    watch = read_watchlist()
    if args.add and extra:
        new = [t for t in extra if t not in watch]
        if new:
            with open(DATA / "watchlist.txt", "a") as f:
                f.write("\n" + "\n".join(new) + "\n")
            print(f"Added to watchlist: {', '.join(new)}")
    tickers = list(dict.fromkeys(watch + extra))
    print(f"Refreshing {len(tickers)} tickers")

    tmap = load_ticker_map()
    print(f"Ticker index: {len(tmap)} symbols")
    COMPANIES.mkdir(parents=True, exist_ok=True)
    ok = failed = 0
    for t in tickers:
        print(f"- {t}")
        try:
            data = build_company(t, tmap)
        except Exception as e:
            print(f"  error: {e}", file=sys.stderr)
            data = None
        if not data:
            failed += 1
            continue
        (COMPANIES / f"{t}.json").write_text(json.dumps(data, indent=1))
        ok += 1
    (DATA / "companies" / "index.json").write_text(json.dumps(sorted(p.stem for p in COMPANIES.glob("*.json") if p.stem != "index")))
    print(f"Done: {ok} updated, {failed} failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
