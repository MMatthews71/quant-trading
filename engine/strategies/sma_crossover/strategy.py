"""SMA crossover — the signal logic for the demo strategy.

A deliberately simple, fully generic plug-in so you can exercise every part of
the program (backtest, live signal, CSV export, the app's tabs, Telegram
alerts) without a Bloomberg terminal. The rules are a textbook moving-average
crossover with an optional RSI gate:

    long  while the fast SMA is above the slow SMA
    short while the fast SMA is below the slow SMA   (if shorts are allowed)

The generic engine (core/rules.py) turns the named conditions below into
positions; this module only has to say WHEN each condition is true. Three hooks
are all the engine needs:

    features(df, p)      -> (df, signals)   the per-bar numbers the rules use
    rules(df, signals, p)-> rules.Rules     entry/exit conditions
    live_fields(last, p) -> dict            extra tiles for the app's Live tab
"""
from __future__ import annotations

import pandas as pd

from core import rules as rules_mod


# --------------------------------------------------------------------------- #
# Indicators
# --------------------------------------------------------------------------- #
def _sma(price: pd.Series, length: int) -> pd.Series:
    return price.rolling(int(length), min_periods=int(length)).mean()


def _rsi(price: pd.Series, length: int) -> pd.Series:
    """Wilder's RSI (0-100). NaN until `length` changes are seen."""
    length = int(length)
    delta = price.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0.0, pd.NA)
    rsi = 100.0 - 100.0 / (1.0 + rs)
    # A run with no losses is RSI 100; with no gains, RSI 0.
    rsi = rsi.where(avg_loss != 0.0, 100.0).where(avg_gain != 0.0, 0.0)
    return rsi.astype(float)


# --------------------------------------------------------------------------- #
# Engine hooks
# --------------------------------------------------------------------------- #
def features(df: pd.DataFrame, p):
    """Compute the per-bar numbers the rules read.

    Returns the (unchanged) frame plus a dict of named Series. Each one is
    written to a ``signal_<name>`` column, so it shows up in the live payload,
    the exported CSV and anything the app plots.
    """
    price = df["price"].astype(float)   # column name fixed by the manifest
    signals = {
        "sma_fast": _sma(price, p.fast),
        "sma_slow": _sma(price, p.slow),
        "rsi": _rsi(price, p.rsi_period),
    }
    return df, signals


def rules(df: pd.DataFrame, signals: dict, p):
    """Entry/exit conditions as named boolean Series.

    long/short ENTRY fire when ALL of their conditions are true; long/short
    EXIT fire when ANY of theirs is true. `valid` marks the bars where the
    signal is defined (both SMAs — and RSI when the filter is on — exist).
    """
    fast, slow, rsi = signals["sma_fast"], signals["sma_slow"], signals["rsi"]
    idx = df.index
    above = fast > slow
    below = fast < slow
    valid = fast.notna() & slow.notna()

    filter_on = str(p.rsi_filter) == "on"
    shorts_on = str(p.allow_short) == "yes"

    long_entry = [("fast>slow", above)]
    short_entry = [("fast<slow", below)]
    if filter_on:
        valid = valid & rsi.notna()
        long_entry.append((f"rsi<{int(p.rsi_overbought)}", rsi < p.rsi_overbought))
        short_entry.append((f"rsi>{int(p.rsi_oversold)}", rsi > p.rsi_oversold))
    if not shorts_on:
        # An always-false condition keeps the short side flat (ALL-true entry).
        short_entry = [("shorts off", pd.Series(False, index=idx))]

    return rules_mod.Rules(
        long_entry=long_entry,
        long_exit=[("fast<slow", below)],
        short_entry=short_entry,
        short_exit=[("fast>slow", above)],
        valid=valid,
    )


def live_fields(last: pd.Series, p) -> dict:
    """Extra numbers for the app's Live tab market card (optional hook).

    Keys land next to price/ts in the live payload's ``market`` block; the
    strategy's ui.js decides how to show them.
    """
    fast = last.get("signal_sma_fast")
    slow = last.get("signal_sma_slow")
    rsi = last.get("signal_rsi")

    def num(v):
        return None if v is None or pd.isna(v) else float(v)

    gap = None
    if fast is not None and slow is not None and not (pd.isna(fast) or pd.isna(slow)):
        gap = float(fast) - float(slow)
    return {
        "sma_fast": num(fast),
        "sma_slow": num(slow),
        "sma_gap": gap,
        "rsi": num(rsi),
        "regime": None if gap is None else ("up" if gap >= 0 else "down"),
    }
