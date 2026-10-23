"""Live feed for the demo strategy — how core/updater.py builds the bar table.

The generic updater (core/updater.py) pulls raw intraday bars from Bloomberg,
grids them, and hands the wide frame to ``transform`` here. This module is the
ONLY strategy piece that knows about the instrument and the data source; it is
imported only when you run ``quant.py update`` (which itself needs blpapi and a
Bloomberg terminal), so nothing here imports blpapi directly.

It provides exactly what the updater expects:

    resolve_tickers(client) -> [{"fetch", "column", "scale"?}, ...]
    load_context(db_path)   -> anything transform() needs (here: holiday days)
    transform(wide, context)-> rows in the strategy's table schema
    STORED_COLUMNS          -> the columns written to the bar table (order)
    SOURCE_COLUMN           -> {source label: wide column} for print-gating

For the demo there is a single synthetic instrument, "DEMO Index", and the
market is open on weekday US-equity regular trading hours (09:30-16:00 ET).

If you don't have Bloomberg, build the same table with the bundled
``seed.py`` instead — it writes data/quant.db in this exact stored format so
the backtest, live signal, CSV export and the app all work offline.
"""
from __future__ import annotations

import sqlite3

import pandas as pd

# The Bloomberg security this strategy trades, and the wide-frame column it
# lands in. `scale` would convert units (e.g. cents -> dollars); 1.0 here.
SECURITY = "DEMO Index"
PRICE_COLUMN = "demo"

# What `to_stored_rows` selects, in order. Must match the bar table's columns
# (minus row_id, which the updater adds) and the manifest's "columns".
STORED_COLUMNS = ["ts", "price", "is_open", "source", "closed_reason"]

# source label -> the wide column that must have actually printed for a forming
# bar to count as "traded" (used by the updater's print-gating). One source.
SOURCE_COLUMN = {"DEMO": PRICE_COLUMN}

# Regular trading hours for the synthetic market, in the strategy timezone.
TZ = "America/New_York"
OPEN_T = pd.Timestamp("09:30").time()
CLOSE_T = pd.Timestamp("16:00").time()


def resolve_tickers(client) -> list[dict]:
    """Which securities to fetch and where each lands in the wide frame.

    `client` is the updater's live BloombergClient; a strategy that rolls
    futures would use it to resolve the front contract. The demo is static.
    """
    return [{"fetch": SECURITY, "column": PRICE_COLUMN, "scale": 1.0}]


def load_context(db_path) -> set[str]:
    """Context passed to transform(): the hand-maintained holiday days.

    Read from the strategy's own ``holidays`` data table (edited in the app's
    Input tab via ``quant.py table``). Missing table -> no holidays.
    """
    try:
        with sqlite3.connect(db_path, timeout=30) as con:
            rows = con.execute("SELECT day FROM holidays").fetchall()
        return {str(r[0])[:10] for r in rows if r[0]}
    except sqlite3.OperationalError:
        return set()


def _is_open(ts_utc: pd.Series, holidays: set[str]) -> pd.Series:
    """Weekday RTH bars (labelled by close) that aren't on a holiday."""
    local = ts_utc.dt.tz_convert(TZ)
    day = local.dt.strftime("%Y-%m-%d")
    t = local.dt.time
    weekday = local.dt.dayofweek < 5
    # Bars are labelled by their CLOSE: the first RTH bar closes after 09:30,
    # the last one closes at 16:00.
    in_session = (t > OPEN_T) & (t <= CLOSE_T)
    return weekday & in_session & ~day.isin(holidays)


def transform(wide: pd.DataFrame, context) -> pd.DataFrame:
    """Wide gridded bars -> the strategy's table rows.

    `wide` has a 'ts' string column (local wall clock + offset) and one price
    column per security (dense/ffilled by the updater). We emit tz-aware UTC
    timestamps and the strategy's columns; the updater handles storage format.
    """
    holidays = context or set()
    out = pd.DataFrame()
    out["ts"] = pd.to_datetime(wide["ts"], utc=True, format="mixed", errors="coerce")
    out["price"] = pd.to_numeric(wide[PRICE_COLUMN], errors="coerce")
    out = out.dropna(subset=["ts"]).reset_index(drop=True)

    open_flag = _is_open(out["ts"], holidays)
    out["is_open"] = open_flag
    out["source"] = "DEMO"
    out["closed_reason"] = open_flag.map(lambda o: None if o else "market closed")
    return out
