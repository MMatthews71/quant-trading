# Strategies

A **strategy** is a self-contained plug-in in `engine/strategies/<name>/`. The
generic engine (`engine/core/`) and the Electron app (`app/`) stay
instrument-agnostic; everything specific to one instrument or signal lives in
its strategy folder. The active strategy is `$QUANT_STRATEGY`, else
`{"strategy": "<name>"}` in `engine/config.json`, else the only folder here.

`engine/config.json` selects **`strategy_1`** — the ABC strategy. `sma_crossover/`
is a complete, offline-runnable reference strategy (a moving average crossover on
a synthetic instrument); run it with `--strategy sma_crossover`.

## Plugging in strategy_1

strategy_1's own views live **outside** the strategy folder, in the base repo's
shareable `strategy-ui/` folder (`ui.js` + `ui.css`) — they name nothing about
the strategy, so they are safe to keep in the public base. The private strategy
folder holds only `__init__.py` and the files you copy in:

```
engine/strategies/strategy_1/
  __init__.py            ← add (empty; makes it an importable package)
  manifest.json          ← copy in (point "ui_dir" at ../../../strategy-ui and
                           fill in "ui_config"; see below)
  strategy.py            ← copy in
  feed.py                ← copy in (needed for `quant.py update`)
  backtest_params.json   ← copy in if you have one (optional)
  live_params.json       ← copy in if you have one (optional)
  data/quant.db          ← copy in to keep your stored bars (optional; the
                           updater builds it otherwise)
  telegram_credentials.py ← copy in for Telegram alerts (optional; start from
                           ../telegram_credentials.example.py; git-ignored)
```

Nothing else changes: start the app (or `python engine/quant.py live`) and it
runs strategy_1, loading its views from `strategy-ui/`. The UI reads everything
instrument-specific from the manifest at runtime (via `QT.config`): its bar-table
columns and forecast inputs from `ui_config` (below), the instrument label from
`symbol`, plus the signals `s` and `m`, params `T V E G U D F H`, and the
`live_fields` market values (`revenue`, `delta_price`, `delta_rev`, `base_time`,
`base_time_price`, `base_time_rev`, `active_contract`) the strategy already
provides. Until `manifest.json` is in place the engine and app stop with a
message naming the missing file.

## Layout

```
<name>/
  manifest.json          what the engine and app need to know (below)
  strategy.py            the signal logic            — features / rules / live_fields
  feed.py                how the updater builds bars — only needed to run `update`
  ui/ui.js, ui/ui.css    the strategy's own app views (optional; may be moved
                         out of the folder with manifest "ui_dir" — see below)
  backtest_params.json   starter params for the Backtest tab (optional)
  live_params.json       starter params for the Live tab (optional)
  data/quant.db          the bar database + everything the engine generates
  telegram_credentials.py  Telegram bot token + chat id for its alerts
                         (optional, git-ignored; see telegram_credentials.example.py)
  seed.py                (demo only) build data/quant.db without Bloomberg
```

The folder name must be a valid Python identifier (it is imported as
`strategies.<name>.strategy`), so use `snake_case`, not hyphens, and keep the
empty `__init__.py`.

## manifest.json

```jsonc
{
  "title": "SMA Crossover (demo)",   // shown in the app
  "symbol": "DEMO",                  // the strategy tab label
  "timezone": "America/New_York",    // IANA zone the bars are stamped in
  "timezone_label": "ET",            // short label for the UI
  "bar_minutes": 5,                  // bar size
  "market_table": "bars",            // the bar table in quant.db
  "columns": {                       // which columns hold what
    "ts": "ts", "price": "price",
    "open": "is_open",               // optional: 0/1 market-open flag
    "source": "source",              // optional: which feed priced the bar
    "closed_reason": "closed_reason" // optional: why a bar is marked closed
  },
  "params": [ /* see below */ ],
  "param_groups": [                  // optional: how the app groups the inputs
    {"title": "Signal", "keys": ["fast", "slow"]}
  ],
  "data_tables": [                   // optional: hand-maintained tables
    {"table": "holidays", "key": "day",
     "columns": {"day": "text", "label": "text"}}
  ],
  "ui_dir": "../../../strategy-ui",  // optional: where the app loads ui.js +
                                     // ui.css from, relative to this folder
                                     // (default "ui"). Point it at the base
                                     // repo's shareable strategy-ui/ to keep
                                     // the UI out of the private folder.
  "ui_config": { /* see below */ }   // optional: strategy-specific detail the
                                     // detached UI needs, surfaced as
                                     // QT.config.uiConfig
}
```

Every param is `{"key", "default", "step"?, "min"?, "max"?, "choices"?,
"label"?, "title"?}`. `choices` makes it a dropdown; a numeric param is snapped
to `step` and clamped to `min`/`max` (an integer `step` makes it an `int`). Two
keys are reserved and every strategy should declare them: **`bps`** (cost per
unit turnover, basis points) and **`exec_lag`** (execution lag in minutes, a
multiple of the bar size).

## strategy.py — the signal logic

```python
def features(df, p):
    # df: the bar table (UTC timestamps, float price, bool open flag)
    # p:  the params (attribute or item access: p.fast, p["bps"])
    # return (df, signals) where signals is {name: per-bar Series}.
    # Each becomes a signal_<name> column (live payload + exported CSV).
    return df, {"sma_fast": ..., "sma_slow": ...}

def rules(df, signals, p):
    # return core.rules.Rules with four lists of (name, bool-Series):
    #   long_entry / short_entry fire when ALL of their conditions are true
    #   long_exit  / short_exit  fire when ANY  of theirs is true
    # plus `valid` (bool per bar: is the signal defined here?).
    return core.rules.Rules(long_entry=..., long_exit=...,
                            short_entry=..., short_exit=..., valid=...)

def live_fields(last, p):   # optional
    # extra numbers for the app's Live market card; merged into the payload.
    return {"regime": "up", "sma_gap": 1.2}
```

The engine applies `exec_lag`, costs, and the flat/long/short state machine for
you (`core/rules.py`, `core/backtest.py`), the same way for every strategy.

## feed.py — the live feed (only `quant.py update` uses it)

Needs `blpapi` + a Bloomberg terminal, so it is imported only by the updater.
Provides:

```python
STORED_COLUMNS = ["ts", "price", "is_open", "source", "closed_reason"]
SOURCE_COLUMN  = {"DEMO": "demo"}     # optional: source label -> wide column
def resolve_tickers(client): ...      # [{"fetch", "column", "scale"?}, ...]
def load_context(db_path):   ...      # anything transform() needs
def transform(wide, context):...      # wide gridded bars -> rows in the schema
```

No Bloomberg? Use `sma_crossover/seed.py` as a template to write `data/quant.db`
directly — the backtest, live signal, export and app all read the stored table.

## ui/ — the strategy's app views (optional)

By default the app loads `ui.js` + `ui.css` from the strategy folder's `ui/`.
A strategy may instead set `"ui_dir"` in its manifest (a path relative to the
strategy folder) to load them from anywhere else — for example the base repo's
shareable `strategy-ui/`, so the non-proprietary UI lives in the public base
while the signal logic stays in the private strategy folder. The views learn
the strategy's identity from `QT.config` at runtime, so a detached UI folder
never has to name or reveal anything about the strategy.

Anything instrument-specific the views need (which is otherwise the only place
the strategy's identity would leak into the UI) comes from the manifest's
`"ui_config"` block, surfaced to the UI as `QT.config.uiConfig`. It is
free-form — put whatever that strategy's views read in it. strategy_1's views,
for instance, expect:

```jsonc
"ui_config": {
  "priceColumn": "<bar-table column: stitched price, USD/share>",
  "revColumn":   "<bar-table column: modelled revenue, USD/yr>",
  "forecastTable": "<the data_tables table the Input tab edits>",
  "commodities": [                 // the forecast inputs, one per commodity
    {"label": "<shown name>", "unit": "<shown unit>",
     "low": "<row key>", "high": "<row key>", "avg": "<row key>"}
  ]
}
```

`ui.js` calls `QT.register({ live, input })`:

- `live:  { mount(el), onShow(), onLive(sig) }` — the strategy's parts of the
  Live tab; `onLive` receives each new live payload (every new live price).
  In `mount` it fills the app's one-screen layout through `QT.live` — every
  part is optional, and any it leaves alone stays hidden:
  - `QT.live.tiles` — the element beside the signal, for tiles
    (`QT.ui.liveTile(label, value, tone)` builds one in the app's style).
  - `QT.live.panel(title)` — claims the next strategy panel and returns its
    body. Two at most: one per panel row, beside "Position & performance" and
    "Live parameters", so they line up and fold with those rows. With just one,
    the Live parameters take the full width of the row below it. Fill a panel
    with rows of label-over-value cells —
    `QT.ui.kvRow(QT.ui.kv(label, value, tone) + …)` — so it reads like the
    app's own panels.
  - `QT.live.details(title)` — adds the strategy's own rows under the app's in
    the "Position & performance" box (retitled `title`, e.g. "Position &
    market") and returns the element for them — `QT.ui.kvRow(...)` rows. Use
    it instead of a panel for context that belongs with the position (e.g.
    what the signal is measured against).
  - `QT.live.chart(title)` — claims the chart card at the top of the chart
    column, over the profit and loss curve. Returns `{ body, title, sub, stat }`:
    draw the chart in `body` (a `.lv-canvas` child fills it), and put the
    legend / subtitle / headline number in the head's `title` / `sub` / `stat`.

  A UI that claims no panels may instead put free-form views in `el`; they
  span both panel rows and scroll within them.
- `input: { mount(el), onShow() }` — the Input sub-tab for editing the
  `data_tables` (it only appears when a strategy provides it).

Data access and shared widgets come through `QT.api` (`getSeries`, `listRows`,
`addRow`, `updateRow`, `deleteRow`, `reloadDb`), `QT.ui`, `QT.config` and
`QT.onDbChanged`.

## Running it

```bash
python engine/strategies/sma_crossover/seed.py   # build a demo quant.db (no Bloomberg)
python engine/quant.py backtest                   # -> data/backtest.json
python engine/quant.py live                        # -> data/live_signal.json
python engine/quant.py export backtest out.csv    # full per-bar CSV
python engine/quant.py table holidays add --row '{"day":"2026-12-25","label":"Christmas"}'
python engine/quant.py update --loop               # Bloomberg -> quant.db (needs blpapi)
```

Each command takes `--strategy <name>` (default: the active strategy, set in
`engine/config.json`); the demo commands above need `--strategy sma_crossover`.
