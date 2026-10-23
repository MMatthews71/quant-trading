# strategy-ui

The strategy's own app views (`ui.js` + `ui.css`), kept here in the shareable
base repo rather than inside the private `engine/strategies/<name>/` folder.

Nothing in this folder names or reveals the strategy. Everything
instrument-specific — the bar-table column names, the instrument label, the
list of commodities the Input tab forecasts — is read at runtime from
`QT.config` (which the app builds from the strategy's own `manifest.json`), not
hardcoded here. The CSS is scoped to a neutral `.strat-ui` class that `ui.js`
applies to the containers it mounts into.

## How it's wired

A strategy loads these views by pointing at this folder from its (private)
`manifest.json`:

```jsonc
{
  "ui_dir": "../../../strategy-ui",   // relative to the strategy folder
  "ui_config": {                      // surfaced to the UI as QT.config.uiConfig
    "priceColumn": "…",               // bar-table column: price
    "revColumn":   "…",               // bar-table column: revenue
    "forecastTable": "…",             // the data_tables table the Input tab edits
    "commodities": [                  // forecast inputs, one per commodity
      {"label": "…", "unit": "…", "low": "…", "high": "…", "avg": "…"}
    ]
  }
}
```

The app resolves `ui_dir` relative to the strategy folder (default `ui`), so the
files can live anywhere. See `engine/strategies/README.md` for the full manifest
and `QT` API reference.
