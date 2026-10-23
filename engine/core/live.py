"""Generic live signal: the strategy's current signal off the latest data.

Uses the SAME math as the backtest (core.backtest.prepare) with the strategy's
live parameter set, modelling INSTANT fills (exec lag 0). Writes
the strategy's data/live_signal.json for the app's Live tab.

The latest data is the stored bar table plus data/live_tail.json — the newest
row, carrying the latest traded price, which the updater rewrites within ~1s
of each trade (the stored table only gets that row every bar_minutes, for the
backtest). The signal is computed on the stored history WITH that live row
appended, so it reflects the most up-to-date price; the Live tab shows it and
Telegram alerts fire on it. Because the latest price moves continuously, a
signal near a threshold can change several times between stored bars, so an
alert only goes out once a new position has held for notify.HOLD_SECONDS.

Without a fresh live row (the updater is stopped, or the tail is older than
TAIL_MAX_AGE) it falls back to the stored bars alone. Alerts are held while the
tail is stale: the feed is down, so a position that differs from the last alert
only reflects missing data, not a new signal.
"""
from __future__ import annotations

import os
import sys
import json
import time

import pandas as pd

from . import notify
from .backtest import prepare, evaluate, build_equity, clean, write_json
from .data import load_market_data, load_rows_after, normalize, ts_string
from .rules import POSITION

# Ignore a live tail the updater hasn't rewritten for this long (updater stopped
# or the feed is down) — its forming bar would otherwise linger as "current".
TAIL_MAX_AGE = pd.Timedelta(minutes=10)
WATCH_POLL_SECONDS = 0.2
# Between recomputes, re-offer the latest signal to the alerter this often, so
# a position that has held long enough (notify.HOLD_SECONDS) is alerted, and a
# failed send retried, even while no new price arrives.
ALERT_RECHECK_SECONDS = 5


def local_iso(ts, tz):
    """Timestamp -> ISO string in `tz` (None-safe)."""
    if ts is None or pd.isna(ts):
        return None
    ts = pd.Timestamp(ts)
    ts = ts.tz_convert(tz) if ts.tzinfo is not None else ts
    return ts.isoformat()


def mtime(path):
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return None


def load_live_tail(strat, after):
    """The forming bar(s) from the updater, newer than `after` (the last stored
    ts), in the engine's frame format, plus whether the tail file is stale.
    Rows are None when missing, stale, empty or unreadable; stale is True only
    for a tail the updater has stopped rewriting (the feed is down)."""
    try:
        tail = json.loads(strat.live_tail_json.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None, False
    written = pd.Timestamp(tail.get('written_at'))
    if pd.isna(written) or pd.Timestamp.now(tz='UTC') - written > TAIL_MAX_AGE:
        return None, True
    rows = pd.DataFrame(tail.get('rows') or [])
    if rows.empty:
        return None, False
    rows = normalize(strat, rows)
    if after is not None:
        rows = rows[rows[strat.ts_col] > after]
    return (rows if not rows.empty else None), False


def with_tail(history, tail):
    """History + the forming bar(s): a new frame, so `history` is never mutated."""
    if tail is None:
        return history.copy()
    return pd.concat([history, tail.reindex(columns=history.columns)], ignore_index=True)


def _text(v):
    return None if v is None or pd.isna(v) else str(v)


def compute(strat, df, p):
    """Bars (history + forming bar) + live params -> the live payload."""
    df = prepare(strat, df, p, exec_lag_bars=0)   # instant fills

    last = df.iloc[-1]
    label = str(last['entry_exit'])
    position = POSITION.get(label, 0)

    # Trades of this (instant-fill) live signal — same breakdown as the backtest.
    df_bt, _, trades = evaluate(strat, df, bps=p.bps, mask_when_closed=False)
    trades_list = [{k: clean(v) for k, v in t.items()}
                   for t in trades.to_dict(orient='records')]

    signals = {c[len('signal_'):]: clean(last[c]) for c in df.columns if c.startswith('signal_')}
    # Strategy-specific numbers for its own UI (optional hook).
    extra = strat.logic.live_fields(last, p) if hasattr(strat.logic, 'live_fields') else {}

    return {
        'strategy': strat.name,
        'symbol': strat.symbol,
        'signal': {
            'label': label,                                  # Long / Short / Nothing / *Entry / *Exit
            'position': position,                             # +1 / -1 / 0
            'position_text': {1: 'Long', -1: 'Short', 0: 'Flat'}[position],
            'is_event': 'Entry' in label or 'Exit' in label, # a change happened on this bar
            'reason': str(last['entry_exit_reason'] or ''),
        },
        'market': {
            'ts': local_iso(last[strat.ts_col], strat.tz),
            'active_open': bool(last[strat.open_col]) if strat.open_col else True,
            'closed_reason': _text(last.get(strat.closed_reason_col)) if strat.closed_reason_col else None,
            'source': _text(last.get(strat.source_col)) if strat.source_col else None,
            'price': clean(last[strat.price_col]),
            **extra,
        },
        'signals': signals,
        'trades': trades_list,
        # Theoretical equity curve of trading instantly on these signals.
        'equity': build_equity(df_bt, strat.ts_col, strat.tz),
        'params': {k: clean(p[k]) for k in strat.params.names},
        'rows': int(len(df)),
        'generated_at': pd.Timestamp.now(tz=strat.tz).isoformat(),
    }


def as_published(payload, live_row):
    """The file the app reads. The signal is the live one; it is also written
    as the 'confirmed' block the app's signal card reads, and 'provisional' is
    off (there is no second signal to show). `live_row` says whether the
    latest live price was included."""
    out = dict(payload)
    out['confirmed'] = {**payload['signal'],
                        'ts': payload['market']['ts'],
                        'price': payload['market']['price']}
    out['provisional'] = False
    out['live_price'] = bool(live_row)
    return out


def publish(strat, payload):
    """Write live_signal.json, swapped in whole so the app never reads half a file."""
    write_json(strat.live_signal_json, payload)
    s = payload['signal']
    src = 'live price' if payload['live_price'] else 'stored bars only'
    print(f"live signal: {s['label']} @ {payload['market']['ts']} "
          f"price {payload['market']['price']} ({src})", flush=True)


def run_once(strat):
    p = strat.params.load('live')
    history = load_market_data(strat)
    last = history[strat.ts_col].iloc[-1] if len(history) else None
    tail, stale = load_live_tail(strat, last)
    payload = compute(strat, with_tail(history, tail), p)
    publish(strat, as_published(payload, tail is not None))
    # No alert here: alerts come only from watch(), which can see a new
    # position hold for notify.HOLD_SECONDS (a one-off run can't).


class History:
    """The bar table kept in memory; refresh() pulls in only newly appended rows
    (a full reload if the table changed any other way)."""

    def __init__(self, strat):
        self.strat = strat
        self.df = load_market_data(strat)

    @property
    def last_ts(self):
        return self.df[self.strat.ts_col].iloc[-1] if len(self.df) else None

    def refresh(self):
        last = self.last_ts
        after = '' if last is None else ts_string(last, self.strat.tz)
        new, count = load_rows_after(self.strat, after)
        if len(self.df) + len(new) != count:
            self.df = load_market_data(self.strat)      # rows edited/removed: start over
        elif len(new):
            self.df = pd.concat([self.df, new], ignore_index=True)


def wait_for_history(strat):
    """The stored bars, once there are any. A new strategy has no quant.db (or
    an empty one) until the updater's first fetch builds it; wait for that,
    saying so once, rather than crash and be restarted over and over."""
    said = False
    while True:
        try:
            if strat.db_path.exists():
                history = History(strat)
                if len(history.df):
                    return history
                why = "no bars stored yet"
            else:
                why = f"{strat.db_path.name} doesn't exist yet"
        except Exception as e:   # e.g. no such table yet
            why = str(e)
        if not said:
            print(f"live signal watch [{strat.name}]: waiting for the updater to store bars ({why})",
                  flush=True)
            said = True
        time.sleep(5)


def watch(strat):
    """Recompute whenever an input changes, as fast as the math allows."""
    history = wait_for_history(strat)
    print(f"live signal watch [{strat.name}]: {len(history.df)} stored rows loaded", flush=True)
    print(f"telegram alerts: {notify.config_status(strat)}", flush=True)
    alerter = notify.Alerter(strat, log=lambda line: print(line, flush=True))
    held = False
    payload, checked = None, 0.0
    params_path = strat.params.path('live')
    seen = None
    while True:
        # What the signal depends on: the DB, the params, the live price row,
        # and whether that live row has gone stale.
        tail_m = mtime(strat.live_tail_json)
        state = (mtime(strat.db_path), mtime(params_path), tail_m,
                 tail_m is not None and time.time() - tail_m / 1e9 < TAIL_MAX_AGE.total_seconds())
        if state != seen:
            try:
                if seen is None or state[0] != seen[0]:
                    history.refresh()
                p = strat.params.load('live')
                # Recomputed on every new live price; alerts fire on it too
                # (notify only sends when the position actually changes, and
                # in the background, so a slow Telegram never delays this).
                tail, stale = load_live_tail(strat, history.last_ts)
                payload = compute(strat, with_tail(history.df, tail), p)
                publish(strat, as_published(payload, tail is not None))
                if stale != held:
                    held = stale
                    if stale:
                        alerter.reset()   # a hold must be seen on live data
                    print("telegram alerts held: live feed stale" if stale
                          else "telegram alerts resumed: live feed fresh", flush=True)
                if not stale:
                    alerter(payload)
                checked = time.time()
                seen = state
            except Exception as e:  # keep watching across a bad read / DB lock
                print(f"live signal failed: {e!r}", file=sys.stderr, flush=True)
                time.sleep(1)
        elif payload is not None and not held and time.time() - checked > ALERT_RECHECK_SECONDS:
            alerter(payload)
            checked = time.time()
        time.sleep(WATCH_POLL_SECONDS)
