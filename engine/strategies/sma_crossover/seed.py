"""Generate a synthetic bar database for the demo strategy (no Bloomberg needed).

``quant.py update`` builds data/quant.db from a live Bloomberg feed. When you
just want to exercise the program, run this instead:

    python engine/strategies/sma_crossover/seed.py            # ~45 days of bars
    python engine/strategies/sma_crossover/seed.py --days 120 --seed 7

It writes data/quant.db in exactly the stored format the engine reads (local
wall-clock + offset timestamps, a 0/1 open flag, source and closed_reason), so
the backtest, live signal, CSV export and the Electron app all work offline.
The price is a deterministic random walk that only moves during regular trading
hours, so the fast/slow SMAs actually cross and the demo produces trades.
"""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

import feed  # same folder; reuses the market-hours and column definitions

HERE = Path(__file__).resolve().parent
DB_PATH = HERE / "data" / "quant.db"
BAR_MINUTES = 5
TZ = feed.TZ


def _ts_strings(ts_utc: pd.Series) -> pd.Series:
    """tz-aware UTC -> stored strings 'YYYY-MM-DD HH:MM:SS+HH:MM' in TZ."""
    local = ts_utc.dt.tz_convert(TZ)
    return (local.dt.strftime("%Y-%m-%d %H:%M:%S%z")
            .str.replace(r"([+-]\d\d)(\d\d)$", r"\1:\2", regex=True))


def build(days: int, seed: int) -> pd.DataFrame:
    end = pd.Timestamp.now(tz="UTC").floor(f"{BAR_MINUTES}min")
    start = end - pd.Timedelta(days=days)
    grid = pd.date_range(start, end, freq=f"{BAR_MINUTES}min", tz="UTC")
    df = pd.DataFrame({"ts": grid})

    open_flag = feed._is_open(df["ts"], holidays=set())

    # A trending random walk that only moves while the market is open. A slow
    # sinusoidal drift makes the SMAs cross several times over the window.
    rng = np.random.default_rng(seed)
    n = len(df)
    steps = np.arange(n)
    drift = 0.00025 * np.sin(2 * np.pi * steps / max(n / 6, 1))  # gentle regime swings
    shock = rng.normal(0.0, 0.0022, n)                           # dominant per-bar noise
    ret = np.where(open_flag.to_numpy(), drift + shock, 0.0)     # frozen overnight
    price = 100.0 * np.exp(np.cumsum(ret))

    df["price"] = np.round(price, 4)
    df["is_open"] = open_flag.astype(int)
    df["source"] = "DEMO"
    df["closed_reason"] = np.where(open_flag, None, "market closed")
    df["ts"] = _ts_strings(df["ts"])
    df.insert(0, "row_id", range(n))
    return df


def write(df: pd.DataFrame, db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as con:
        con.execute("DROP TABLE IF EXISTS bars")
        con.execute(
            "CREATE TABLE bars ("
            "row_id INTEGER PRIMARY KEY, ts TEXT, price REAL, "
            "is_open INTEGER, source TEXT, closed_reason TEXT)")
        df.to_sql("bars", con, if_exists="append", index=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=45, help="calendar days of bars to generate")
    ap.add_argument("--seed", type=int, default=42, help="RNG seed (reproducible)")
    ap.add_argument("--db", type=Path, default=DB_PATH, help="output quant.db path")
    args = ap.parse_args(argv)

    df = build(args.days, args.seed)
    write(df, args.db)
    opened = int(df["is_open"].sum())
    print(f"wrote {len(df)} bars ({opened} open) to {args.db}")
    print(f"  {df['ts'].iloc[0]}  ->  {df['ts'].iloc[-1]}")


if __name__ == "__main__":
    main()
