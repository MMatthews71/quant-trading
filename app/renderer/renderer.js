'use strict';

const UP = '#2ec27e';
const DOWN = '#f0616d';
const FLAT = '#4c9aff';

// The active strategy's basics (title, tz label, param groups, its UI files),
// read by main.js at boot. This renderer is strategy-agnostic: everything
// specific to a strategy is drawn by that strategy's own ui/ui.js, which plugs
// in through window.QT (see "Strategy UI plug-in" below).
let CONFIG = { title: '', tzLabel: '', paramGroups: [], ui: {} };

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //
function formatPrice(p) {
  if (p == null) return '—';
  const abs = Math.abs(p);
  const dp = abs >= 1000 ? 1 : abs >= 10 ? 2 : abs >= 1 ? 3 : 4;
  return p.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

// HTML-escape a value for insertion into markup.
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colorFor(meta) {
  if (!meta || meta.change == null) return FLAT;
  return meta.change > 0 ? UP : meta.change < 0 ? DOWN : FLAT;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatTime(sec, withTime) {
  const d = new Date(sec * 1000); // wall-as-UTC (see main.js)
  let s = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (withTime) {
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    s += ` ${hh}:${mm}`;
  }
  return s;
}

function setActiveRange(container, range) {
  container.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.range === range)
  );
}

// Build a lightweight-charts chart (full interactive). Logo always hidden.
function makeChart(el) {
  const chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: {
      background: { color: 'transparent' },
      textColor: '#8b949e',
      attributionLogo: false,
      fontSize: 12,
    },
    grid: { vertLines: { color: 'rgba(42,51,64,0.5)' }, horzLines: { color: 'rgba(42,51,64,0.5)' } },
    rightPriceScale: { visible: true, borderColor: '#2a3340' },
    // minBarSpacing default is 0.5px/point; with ~2000 downsampled points that
    // needs ~1000px to show everything, so on a narrower window fitContent()
    // clips the oldest data off the left. Lower it so the full history (back to
    // 2022) always fits regardless of window width.
    timeScale: {
      visible: true, borderColor: '#2a3340', timeVisible: true, secondsVisible: false,
      minBarSpacing: 0.05,
    },
    handleScroll: true,
    handleScale: true,
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
  const series = chart.addLineSeries({
    color: FLAT,
    lineWidth: 2,
    priceLineVisible: true,
    lastValueVisible: true,
    // The DB stores a row only when the price CHANGES, so hold each price flat
    // until the next recorded change and step there — never slope between them.
    lineType: LightweightCharts.LineType.WithSteps,
  });
  return { chart, series };
}

// --------------------------------------------------------------------------- //
// quant.db changed on disk (the updater wrote new data): reload the snapshot,
// then let the strategy's UI refresh whatever it draws from the DB.
// --------------------------------------------------------------------------- //
const dbListeners = [];
let refreshing = false;
window.api.onDbChanged(async () => {
  if (refreshing) return;
  refreshing = true;
  try {
    await window.api.reloadDb();
    for (const cb of dbListeners) await cb();
  } finally {
    refreshing = false;
  }
});

// --------------------------------------------------------------------------- //
// Tabs
// --------------------------------------------------------------------------- //
// The strategy's sub-tabs: Live / Backtest / Input / Log.
document.getElementById('subtabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('#subtabs .tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active');
  const id = btn.dataset.tab;
  document.getElementById('tab-' + id).classList.add('active');
  if (id === 'backtest') {
    initStrategyParams();
    loadBacktest();
  } else if (id === 'live') {
    showLive();
  } else if (id === 'input') {
    if (plugin.input && plugin.input.onShow) plugin.input.onShow();
  }
});

// --------------------------------------------------------------------------- //
// Parameter forms — shared by the Backtest inputs (backtest_params.json) and
// the Live parameters (live_params.json); the engine reads each file on its
// next run. The fields are the strategy's manifest params; per-input
// `step`/`min`/`max` (from main.js meta) constrain them — e.g. exec_lag only
// accepts whole 5-minute intervals.
// --------------------------------------------------------------------------- //

// The flat key list, split into the labelled sections the strategy's manifest
// declares ("param_groups"). `labels` overrides a field's caption (the section
// title already gives context). Any key not claimed by a section falls through
// into a trailing "Other" section so nothing is ever dropped. Each section lays
// its fields out in `cols` tight label→value pairs per row.
function paramSections(keys) {
  const defined = CONFIG.paramGroups || [];
  const claimed = new Set(defined.flatMap((g) => g.keys));
  const groups = defined
    .map((g) => ({ ...g, keys: g.keys.filter((k) => keys.includes(k)) }))
    .filter((g) => g.keys.length);
  const leftover = keys.filter((k) => !claimed.has(k));
  if (leftover.length) groups.push({ title: 'Other', keys: leftover });
  return groups;
}

// Build one field (label + input) for key `k`, using `meta[k]` for the input's
// constraints. Same markup everywhere; the section grid handles the layout.
function paramField(k, meta, labelOverride) {
  const m = meta[k] || {};
  const label = labelOverride || m.label || k;
  const title = m.title ? ` title="${esc(m.title)}"` : '';
  let control;
  if (Array.isArray(m.choices)) {
    const opts = m.choices.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    control = `<select class="sp-in" data-param="${k}" data-kind="choice"${title}>${opts}</select>`;
  } else {
    const step = Number.isFinite(m.step) ? m.step : 'any';
    const min = Number.isFinite(m.min) ? ` min="${m.min}"` : '';
    const max = Number.isFinite(m.max) ? ` max="${m.max}"` : '';
    control = `<input class="sp-in" type="number" step="${step}"${min}${max}${title} data-param="${k}" data-kind="num" />`;
  }
  return `<label class="sp-field"${title}><span class="sp-lbl">${esc(label)}</span>${control}</label>`;
}

// Snap a committed number to its step (e.g. 5-min intervals) and range.
function snapParam(el) {
  const step = parseFloat(el.step);
  let v = parseFloat(el.value);
  if (!Number.isFinite(v) || !Number.isFinite(step) || step <= 0) return;
  v = Math.round(v / step) * step;
  const min = parseFloat(el.min);
  if (Number.isFinite(min)) v = Math.max(v, min);
  const max = parseFloat(el.max);
  if (Number.isFinite(max)) v = Math.min(v, max);
  el.value = v;
}

// Build a parameter form into `box` (once): the manifest's sections of fields.
// Typing saves `delay` ms after the last keystroke; a commit (blur / Enter /
// spinner) snaps the value and saves at once, so the field shows what's
// stored. Returns { read(), fill(params), cancelPending() }.
function buildParamForm(box, res, { hints, delay, save }) {
  const meta = res.meta || {};
  box.innerHTML = paramSections(res.keys).map((g) => {
    const cols = Math.min(g.cols || 1, g.keys.length);
    const hint = hints && g.hint ? `<span class="sp-hint">${g.hint}</span>` : '';
    const fields = g.keys.map((k) => paramField(k, meta, g.labels && g.labels[k])).join('');
    return `<div class="sp-section">` +
           `<div class="sp-head">${g.title}${hint}</div>` +
           `<div class="sp-grid" style="--sp-cols:${cols}">${fields}</div></div>`;
  }).join('');
  const inputs = Array.from(box.querySelectorAll('[data-param]'));
  let timer = null;
  const cancelPending = () => clearTimeout(timer);
  for (const el of inputs) {
    el.addEventListener('input', () => {
      cancelPending();
      timer = setTimeout(save, delay);
    });
    el.addEventListener('change', () => {
      snapParam(el);
      cancelPending();
      save();
    });
  }
  return {
    read() {
      const patch = {};
      for (const el of inputs) {
        if (el.dataset.kind === 'choice') {
          patch[el.dataset.param] = el.value;              // string (a <select>)
        } else {
          const v = parseFloat(el.value);
          if (Number.isFinite(v)) patch[el.dataset.param] = v;
        }
      }
      return patch;
    },
    // Show the stored values; a field being edited keeps what is typed in it.
    fill(params) {
      for (const el of inputs) {
        const v = params[el.dataset.param];
        if (v != null && el !== document.activeElement) el.value = v;
      }
    },
    cancelPending,
  };
}

// The Backtest tab's strategy inputs.
let btForm = null;

async function saveStrategyParams() {
  if (!btForm) return;
  const msg = document.getElementById('bt-params-msg');
  const res = await window.api.saveParams(btForm.read());
  if (res && res.ok) {
    const t = new Date().toLocaleTimeString();
    msg.textContent = `saved ${t}`;
    msg.classList.remove('err');
  } else {
    msg.textContent = 'save failed: ' + ((res && res.error) || 'unknown');
    msg.classList.add('err');
  }
}

async function initStrategyParams() {
  const res = await window.api.loadParams();
  if (!res || !res.ok) return;
  if (!btForm) {
    btForm = buildParamForm(document.getElementById('bt-params'), res,
      { hints: true, delay: 300, save: saveStrategyParams });
  }
  btForm.fill(res.params);
}

// "Run backtest": flush any pending input edits, then run the Python script.
// It reads backtest_params.json and writes data/backtest.json; on success
// we reload the results into the tab.
(function wireRunBacktest() {
  const btn = document.getElementById('bt-run');
  const msg = document.getElementById('bt-run-msg');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Running…';
    msg.textContent = '';
    msg.classList.remove('err');
    if (btForm) btForm.cancelPending();   // flush debounced param edits first
    await saveStrategyParams();
    const res = await window.api.runBacktest();
    btn.disabled = false;
    btn.textContent = label;
    if (res && res.ok) {
      msg.textContent = 'done ' + new Date().toLocaleTimeString();
      loadBacktest();
    } else {
      msg.textContent = (res && res.error) || 'run failed';
      msg.classList.add('err');
    }
  });
})();

// --------------------------------------------------------------------------- //
// Backtest tab — read-only viewer of data/backtest.json (written by
// `quant.py backtest`). The app doesn't compute anything here; it renders the
// stats, equity curve and trades straight from that file.
// --------------------------------------------------------------------------- //
const btPct = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp) + '%');
const btCls = (v) => (v == null || !Number.isFinite(v) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
let btEqChart = null, btEqSeries = null, btLoaded = false;

function btTile(label, value, cls) {
  return `<div class="bt-tile"><span class="bt-tile-v ${cls || ''}">${value}</span>` +
         `<span class="bt-tile-l">${label}</span></div>`;
}

function initBtChart() {
  if (btEqChart) return;
  const c = makeChart(document.getElementById('bt-eq-chart'));
  btEqChart = c.chart;
  btEqSeries = c.series;
  btEqChart.subscribeCrosshairMove((p) => {
    const tip = document.getElementById('bt-eq-tip');
    if (!p.point || !p.time || !p.seriesData || !p.seriesData.get(btEqSeries)) { tip.classList.add('hidden'); return; }
    const v = p.seriesData.get(btEqSeries).value;
    tip.innerHTML = `<b>×${v.toFixed(2)}</b> &nbsp;<span class="tip-rev">${btPct(v - 1)}</span>&nbsp; ${formatTime(p.time, true)}`;
    tip.classList.remove('hidden');
    const wrap = document.querySelector('#tab-backtest .hero-chart').getBoundingClientRect();
    let left = p.point.x + 8;
    if (left + tip.offsetWidth > wrap.width - 8) left = p.point.x - tip.offsetWidth - 8;
    tip.style.left = left + 'px';
    tip.style.top = p.point.y + 'px';
  });
}

function renderBtStats(s) {
  if (!s) { document.getElementById('bt-stats').innerHTML = ''; return; }
  document.getElementById('bt-stats').innerHTML =
    btTile(`Net return (${s.cost_bps ?? ''} bps)`, btPct(s.net_return), btCls(s.net_return)) +
    (s.buy_hold_raw_return != null ? btTile('Buy & hold', btPct(s.buy_hold_raw_return), btCls(s.buy_hold_raw_return)) : '') +
    btTile('CAGR (net)', btPct(s.cagr), btCls(s.cagr)) +
    (s.equity_multiple != null ? btTile('Equity multiple', '×' + s.equity_multiple.toFixed(2), btCls(s.equity_multiple - 1)) : '') +
    (s.sharpe != null ? btTile('Sharpe (net)', Number.isFinite(s.sharpe) ? s.sharpe.toFixed(2) : '—', btCls(s.sharpe)) : '') +
    (s.max_drawdown != null ? btTile('Max drawdown', '−' + (Math.abs(s.max_drawdown) * 100).toFixed(1) + '%', 'down') : '') +
    (s.exposure != null ? btTile('Exposure', (s.exposure * 100).toFixed(1) + '%', '') : '') +
    btTile('Trades', s.n_trades ?? '—', '') +
    (s.win_rate != null ? btTile('Win rate', (s.win_rate * 100).toFixed(1) + '%', '') : '') +
    (s.avg_trade != null ? btTile('Avg / trade', btPct(s.avg_trade), btCls(s.avg_trade)) : '') +
    (s.best != null || s.worst != null ? btTile('Best / worst', btPct(s.best) + ' / ' + btPct(s.worst), '') : '');
}

function renderBtEquity(equity, s) {
  if (!equity || !equity.length) return;
  initBtChart();
  btEqSeries.setData(equity);
  btEqSeries.applyOptions({ color: (s && s.net_return >= 0) ? UP : DOWN });
  btEqChart.timeScale().fitContent();
  const mult = s && s.equity_multiple != null ? s.equity_multiple : equity[equity.length - 1].value;
  document.getElementById('bt-eq-stat').innerHTML = `<span class="hero-price">×${mult.toFixed(2)}</span>`;
  document.getElementById('bt-eq-sub').textContent = s
    ? `net of ${s.cost_bps ?? '?'} bps · ${s.n_trades ?? '?'} trades · ${btPct(s.net_return)}`
    : '';
}

// Shared trades-table renderer (used by both the Backtest and Live tabs).
const TRADES_MAX = 400;
function tradesCountText(trades, max = TRADES_MAX) {
  const n = (trades || []).length;
  return n > max ? `(newest ${max} of ${n})` : `(${n})`;
}
function renderTradesInto(tableId, trades, max = TRADES_MAX) {
  const rows = (trades || []).slice().reverse().slice(0, max);
  let h = '<thead><tr><th>Dir</th><th>Entry</th><th>Exit</th><th>Entry $</th><th>Exit $</th>' +
          '<th>Return</th><th>Hold</th><th>Entry reason</th><th>Exit reason</th></tr></thead><tbody>';
  for (const t of rows) {
    // An open trade has no exit yet: its exit price is the latest mark.
    const exit = t.open ? '<span class="bt-open">open</span>' : (t.exitTs || '').slice(0, 16).replace('T', ' ');
    h += `<tr><td class="bt-${(t.dir || '').toLowerCase()}">${t.dir || ''}</td>` +
      `<td>${(t.entryTs || '').slice(0, 16).replace('T', ' ')}</td>` +
      `<td>${exit}</td>` +
      `<td>${t.entryPx != null ? formatPrice(t.entryPx) : ''}</td>` +
      `<td>${t.exitPx != null ? formatPrice(t.exitPx) : ''}</td>` +
      `<td class="${btCls(t.ret)}">${btPct(t.ret)}</td>` +
      `<td>${t.holdDays != null ? t.holdDays.toFixed(1) + 'd' : ''}</td>` +
      `<td class="bt-reason">${esc(t.entry_reason)}</td>` +
      `<td class="bt-reason">${esc(t.exit_reason)}</td></tr>`;
  }
  document.getElementById(tableId).innerHTML = h + '</tbody>';
}

function renderBtTrades(trades) {
  trades = trades || [];
  document.getElementById('bt-trades-count').textContent = tradesCountText(trades);
  renderTradesInto('bt-table', trades);
}

// "Export full CSV": generate the full per-bar backtest CSV — every bar, every
// column, so every number in the tab can be audited. Main asks for a save
// location, then recomputes and writes the CSV straight there (nothing is left
// in the data folder); this only kicks it off and reports the outcome. The
// recompute means it can take a little while, hence the "Exporting…" state.
(function wireBtExport() {
  const btn = document.getElementById('bt-export');
  const msg = document.getElementById('bt-export-msg');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Exporting…';
    if (msg) { msg.textContent = ''; msg.classList.remove('err'); }
    try {
      const res = await window.api.exportBacktestCsv();
      if (res && res.ok) {
        if (msg) msg.textContent = 'saved';
      } else if (res && res.error === 'canceled') {
        // user dismissed the save dialog — say nothing
      } else if (msg) {
        msg.textContent = (res && res.error) || 'export failed';
        msg.classList.add('err');
      }
    } catch (e) {
      if (msg) { msg.textContent = e.message || 'export failed'; msg.classList.add('err'); }
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
})();

async function loadBacktest() {
  const empty = document.getElementById('bt-empty');
  const results = document.getElementById('bt-results');
  const res = await window.api.loadBacktest();
  if (!res || !res.ok) {
    results.classList.add('hidden');
    empty.hidden = false;
    empty.textContent = res && res.error === 'no-file'
      ? 'No backtest yet — press Run backtest.'
      : 'Could not read backtest.json: ' + ((res && res.error) || 'unknown error');
    return;
  }
  empty.hidden = true;
  results.classList.remove('hidden');
  renderBtStats(res.stats);
  renderBtEquity(res.equity, res.stats);
  renderBtTrades(res.trades);
  btLoaded = true;
}

window.api.onBacktestChanged(() => {
  if (btLoaded || document.getElementById('tab-backtest').classList.contains('active')) loadBacktest();
});

// --------------------------------------------------------------------------- //
// Live tab — the current signal off the latest data, on one screen (layout in
// index.html). It has its own parameter set (live_params.json); editing it
// re-runs the live signal (`quant.py live`), which writes data/live_signal.json
// and pushes 'live:changed' back here. Everything drawn is a number the
// payload carries — nothing is invented, and a missing field renders as "—".
// --------------------------------------------------------------------------- //
const LIVE_TRADES_MAX = 20;    // the trades table shows at most the 20 newest (as many as fit)
const LIVE_STALE_MIN = 20;     // market open but no new bar for this long → stale-feed warning
const LIVE_COLLAPSE_KEY = 'live.collapsedRows.v2';
const LIVE_CHART_W_KEY = 'live.chartWidth';
const LIVE_CHART_W_MIN = 280;

let liveForm = null;
let liveLoaded = false;
let liveLastSig = null;        // latest payload (staleness re-check, trades refit)
let liveEqChart = null, liveEqSeries = null;
let liveEqN = null;            // points in the P&L curve as last drawn

const lvNum = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(dp));
// 'pct' values arrive already expressed as a percent (e.g. -4.27).
const lvPct = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(dp) + '%');
const lvCls = (v) => (v == null || !Number.isFinite(v) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const lvTime = (ts) => (ts ? ts.slice(0, 16).replace('T', ' ') : '—');
const lvPx = (v) => (v == null || !Number.isFinite(v) ? '—' : formatPrice(v));

function lmRow(label, value, cls) {
  return `<div class="live-metric"><span class="lm-lbl">${label}</span>` +
         `<span class="lm-val ${cls || ''}">${value}</span></div>`;
}

// Panel content: rows of label-over-value cells (strategies use them too, via
// QT.ui.kvRow / QT.ui.kv), so every Live panel reads the same way.
function lvKv(label, value, cls) {
  return `<div class="lv-kv"><span class="lv-kv-l">${label}</span>` +
         `<span class="lv-kv-v ${cls || ''}">${value}</span></div>`;
}
function lvKvRow(cells) {
  return `<div class="lv-kvrow">${cells}</div>`;
}

// One tile beside the signal (strategies build theirs with QT.ui.liveTile).
function lvTile(label, value, cls) {
  return `<div class="lv-tile"><span class="lv-tile-l">${label}</span>` +
         `<span class="lv-tile-v ${cls || ''}">${value}</span></div>`;
}

function liveStateClass(position) {
  return position > 0 ? 'live-long' : position < 0 ? 'live-short' : 'live-flat';
}

// --- Live parameters (same form as the backtest's, packed tight by CSS). ---
async function saveLiveParams() {
  if (!liveForm) return;
  const msg = document.getElementById('live-params-msg');
  const res = await window.api.saveLiveParams(liveForm.read());
  if (res && res.ok) {
    msg.textContent = 'saved — recomputing…';
    msg.classList.remove('err');
  } else {
    msg.textContent = (res && res.error) || 'save failed';
    msg.classList.add('err');
  }
}

async function initLiveParams() {
  const res = await window.api.loadLiveParams();
  if (!res || !res.ok) return;
  if (!liveForm) {
    liveForm = buildParamForm(document.getElementById('live-params'), res,
      { hints: false, delay: 400, save: saveLiveParams });
  }
  liveForm.fill(res.params);
}

// --- The signal: computed off the latest traded price (what alerts fire on).
// Older files may still carry a separate provisional (forming-bar) one. ---
function renderLiveHero(sig) {
  const prov = sig.signal || {};
  const conf = sig.confirmed || prov;   // older files have no confirmed block
  const mkt = sig.market || {};
  const cls = liveStateClass(conf.position || 0);

  document.getElementById('live-signal-card').className = 'lv-hero ' + cls;
  const stateEl = document.getElementById('live-sig-state');
  stateEl.textContent = conf.label || '—';
  stateEl.className = 'lv-sig-state ' + cls;

  document.getElementById('live-sig-reason').textContent = conf.reason || '';

  const provEl = document.getElementById('live-provisional');
  if (sig.provisional) {
    const closes = lvTime(mkt.ts).slice(11);
    const differs = prov.label !== conf.label;
    const what = mkt.closed_reason === 'awaiting first trade'
      ? esc(`awaiting first ${mkt.source || ''} trade`.replace('  ', ' '))
      : `<b class="${liveStateClass(prov.position || 0)}">${esc(prov.label || '—')}</b>` +
        (prov.reason ? ` (${esc(prov.reason)})` : '');
    provEl.innerHTML = `Forming bar → ${closes}: ${what}` +
      (differs ? ' · provisional, confirms when the bar closes' : '');
    provEl.className = 'lv-sig-line' + (differs ? ' differs' : '');
    provEl.hidden = false;
  } else {
    provEl.hidden = true;
  }

  document.getElementById('live-updated').textContent =
    `Latest price ${lvTime(conf.ts || mkt.ts)} ${CONFIG.tzLabel}`.trim();
  document.getElementById('live-computed').textContent =
    sig.generated_at ? `computed ${sig.generated_at.slice(11, 19)}` : '';

  const pill = document.getElementById('live-market-pill');
  const awaiting = mkt.closed_reason === 'awaiting first trade';
  const isOpen = !!mkt.active_open;
  pill.textContent = isOpen ? 'Market open' : awaiting ? 'Opening — no trade yet' : 'Market closed';
  pill.className = 'pill ' + (isOpen ? 'running' : 'idle');
}

// Drawdown of the live run's equity curve: now (from its running peak) and
// the worst it has been, both as negative fractions.
function liveDrawdown(sig) {
  const equity = Array.isArray(sig.equity) ? sig.equity : [];
  let peak = -Infinity, worst = 0, now = null;
  for (const p of equity) {
    if (!Number.isFinite(p.value)) continue;
    peak = Math.max(peak, p.value);
    now = p.value / peak - 1;
    worst = Math.min(worst, now);
  }
  return now == null ? null : { now, worst };
}

// --- "Position & performance": where you stand now, and whether the strategy
// is behaving like itself lately. Long-run statistics (win rate, average
// trade, cumulative) are the Backtest tab's and the P&L card's; the open
// trade's dates and prices are the first row of Previous trades. ---
const LIVE_RECENT_N = 10;
function renderLivePosition(sig) {
  const trades = Array.isArray(sig.trades) ? sig.trades : [];
  const open = trades.find((t) => t.open);
  const closed = trades.filter((t) => !t.open && Number.isFinite(t.ret_net));
  const recent = closed.slice(-LIVE_RECENT_N);
  const recentWins = recent.filter((t) => t.ret_net > 0).length;
  const recentNet = recent.length ? (recent.reduce((acc, t) => acc * (1 + t.ret_net), 1) - 1) * 100 : null;
  const last = closed.length ? closed[closed.length - 1].ret_net * 100 : null;
  const dd = liveDrawdown(sig);
  const ddTxt = dd
    ? `${lvPct(dd.now * 100, 1)}<small class="dim">max ${lvPct(dd.worst * 100, 1)}</small>`
    : '—';

  const now = open
    ? lvKv('Position', (open.dir || '—').replace(/^./, (c) => c.toUpperCase()),
        open.dir === 'long' ? 'up' : open.dir === 'short' ? 'down' : '') +
      lvKv('Unrealised', lvPct(Number.isFinite(open.ret_net) ? open.ret_net * 100 : null), lvCls(open.ret_net)) +
      lvKv('Entry → mark', lvPx(open.entryPx) + ' → ' + lvPx(open.exitPx)) +
      lvKv('Held', open.holdDays != null ? open.holdDays.toFixed(1) + ' d' : '—')
    : lvKv('Position', 'Flat — no open trade', 'dim');
  const lately =
    lvKv('Drawdown', ddTxt, dd && dd.now < 0 ? 'down' : '') +
    lvKv(`Last ${recent.length || LIVE_RECENT_N} closed`,
      recent.length ? `${recentWins} won<small>${lvPct(recentNet)}</small>` : '—', lvCls(recentNet)) +
    lvKv('Last trade', lvPct(last), lvCls(last));
  // One row: the position, then how the strategy has done lately.
  const html = lvKvRow(now + lately);
  document.getElementById('live-position').innerHTML = html;
}

// Warn when the data feed has gone quiet: the market is open but the latest bar
// is old, so the updater/API isn't pushing data. (A lagging bar while the
// market is CLOSED is normal, so no warning then.) Re-checked on a timer so the
// banner appears even when nothing new arrives — precisely the case to catch.
function fmtAge(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
function renderLiveStale(sig) {
  const el = document.getElementById('live-stale');
  const mkt = (sig && sig.market) || {};
  const t = mkt.ts ? Date.parse(mkt.ts) : NaN;
  const ageMin = Number.isFinite(t) ? (Date.now() - t) / 60000 : Infinity;
  const stale = !!mkt.active_open && ageMin > LIVE_STALE_MIN;
  el.hidden = !stale;
  if (stale) el.textContent = `⚠ Data feed is stale — last update was ${fmtAge(ageMin)} ago.`;
}
setInterval(() => { if (liveLastSig) renderLiveStale(liveLastSig); }, 60000);

// --- Profit and loss curve (the backtest's equity chart, on the live run). ---
function initLiveEqChart() {
  if (liveEqChart) return;
  const el = document.getElementById('live-eq-chart');
  const c = makeChart(el);
  liveEqChart = c.chart;
  liveEqSeries = c.series;
  liveEqChart.subscribeCrosshairMove((p) => {
    const tip = document.getElementById('live-eq-tip');
    if (!p.point || !p.time || !p.seriesData || !p.seriesData.get(liveEqSeries)) { tip.classList.add('hidden'); return; }
    const v = p.seriesData.get(liveEqSeries).value;
    tip.innerHTML = `<b>×${v.toFixed(2)}</b> &nbsp;<span class="tip-rev">${btPct(v - 1)}</span>&nbsp; ${formatTime(p.time, true)}`;
    tip.classList.remove('hidden');
    // The tip sits in the card body; the canvas is inset within it.
    const x = p.point.x + el.offsetLeft, y = p.point.y + el.offsetTop;
    const width = el.parentElement.clientWidth;
    let left = x + 8;
    if (left + tip.offsetWidth > width - 8) left = x - tip.offsetWidth - 8;
    tip.style.left = left + 'px';
    tip.style.top = y + 'px';
  });
}

function renderLiveEquity(sig) {
  const card = document.getElementById('live-eq-card');
  const equity = Array.isArray(sig.equity) ? sig.equity : [];
  card.hidden = !equity.length;
  if (!equity.length) return;
  initLiveEqChart();
  // Each live payload redraws the curve; keep following it only while the
  // whole curve is in view, so a zoom or scroll isn't undone a second later.
  const ts = liveEqChart.timeScale(), vr = ts.getVisibleLogicalRange();
  const wasAll = liveEqN == null || !vr || (vr.from <= 0.5 && vr.to >= liveEqN - 1.5);
  liveEqSeries.setData(equity);
  liveEqN = equity.length;
  const mult = equity[equity.length - 1].value;
  const net = mult - 1;
  liveEqSeries.applyOptions({ color: net >= 0 ? UP : DOWN });
  if (wasAll) ts.fitContent();
  document.getElementById('live-eq-stat').innerHTML =
    `<span class="lv-stat-v">×${mult.toFixed(2)}</span>` +
    `<span class="lv-stat-chg ${btCls(net)}">${btPct(net)}</span>`;
  const bps = sig.params && sig.params.bps != null ? sig.params.bps : '?';
  document.getElementById('live-eq-sub').textContent =
    `net of ${bps} bps · ${(sig.trades || []).length} trades`;
}

// --- Previous trades: as many of the newest (up to LIVE_TRADES_MAX) as fit
// the card — whole rows only, nothing scrolls. Re-run whenever the card
// changes size (collapse, splitter, window, stale banner) via a ResizeObserver.
function fitLiveTrades() {
  const trades = (liveLastSig && Array.isArray(liveLastSig.trades)) ? liveLastSig.trades : [];
  const box = document.getElementById('live-trades-box');
  const table = document.getElementById('live-table');
  renderTradesInto('live-table', trades, LIVE_TRADES_MAX);
  const body = table.tBodies[0];
  if (!trades.length) {
    body.innerHTML = '<tr><td class="bt-dim" colspan="9">No trades yet.</td></tr>';
    document.getElementById('live-trades-count').textContent = '(0)';
    return;
  }
  let n = body.rows.length;
  if (box.clientHeight && n) {
    const rowH = body.rows[0].offsetHeight || 1;
    const fit = Math.floor((box.clientHeight - table.tHead.offsetHeight) / rowH);
    n = Math.max(1, Math.min(n, fit));
    while (body.rows.length > n) body.deleteRow(-1);
  }
  document.getElementById('live-trades-count').textContent = tradesCountText(trades, n);
}

function renderLive(sig) {
  liveLastSig = sig;
  renderLiveHero(sig);
  renderLivePosition(sig);
  renderLiveEquity(sig);
  renderLiveStale(sig);
  // The strategy's own live views get the same payload.
  if (plugin.live && plugin.live.onLive) plugin.live.onLive(sig);
  fitLiveTrades();
  const msg = document.getElementById('live-params-msg');
  if (!msg.classList.contains('err')) msg.textContent = '';   // the recompute landed
}

// --------------------------------------------------------------------------- //
// Live layout: the strategy's areas, collapsible panel rows and the draggable
// chart column. Run once at boot, after the strategy's UI has mounted.
// --------------------------------------------------------------------------- //
function setupLiveLayout() {
  const grid = document.getElementById('live-results');

  // The strategy's areas. Two panels → one per panel row beside the app's;
  // one → the top row, with the parameters taking the bottom row's width;
  // none, but free-form views in its element → those span both rows; nothing
  // → the app's panels take the full width.
  const free = document.getElementById('live-strategy');
  document.getElementById('live-free').hidden = !(liveStrategyPanels === 0 && free.childElementCount);
  grid.classList.toggle('lv-no-strat', liveStrategyPanels === 0 && !free.childElementCount);
  grid.classList.toggle('lv-one-strat', liveStrategyPanels === 1);
  if (liveStrategyPanels && free.childElementCount) {
    appendLog({ stream: 'err', line: 'Strategy UI: views mounted outside QT.live.panel() are not shown when it also uses panels.' });
  }

  // Collapsible panel rows. Each row ("top": strategy panel 1 + Position &
  // performance; "bottom": strategy panel 2 + Live parameters) folds to its
  // heads from the caret in any of its cards; the trades grow into the room.
  // Both rows start collapsed; a stored choice per row wins.
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LIVE_COLLAPSE_KEY) || '{}') || {}; } catch {}
  function setCollapsed(row, collapsed) {
    grid.classList.toggle('lv-collapse-' + row, collapsed);
    grid.querySelectorAll(`.lv-caret[data-row="${row}"]`)
      .forEach((b) => b.setAttribute('aria-expanded', String(!collapsed)));
  }
  for (const row of ['top', 'bottom']) setCollapsed(row, row in saved ? !!saved[row] : true);
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.lv-caret');
    if (!btn) return;
    const row = btn.dataset.row;
    const collapsed = !grid.classList.contains('lv-collapse-' + row);
    setCollapsed(row, collapsed);
    saved[row] = collapsed;
    try { localStorage.setItem(LIVE_COLLAPSE_KEY, JSON.stringify(saved)); } catch {}
  });

  // Draggable chart column: the splitter on its left edge sets --chart-w (px),
  // clamped between a minimum and half the grid. `wanted` is the user's width;
  // it is re-clamped whenever the grid resizes, so shrinking the window and
  // growing it back restores it. Double-click returns to the default (half).
  const splitter = document.getElementById('live-splitter');
  let wanted = null;
  try {
    const v = parseFloat(localStorage.getItem(LIVE_CHART_W_KEY));
    if (Number.isFinite(v)) wanted = v;
  } catch {}
  function applyWidth() {
    if (wanted == null) { grid.style.removeProperty('--chart-w'); return; }
    const gw = grid.getBoundingClientRect().width || window.innerWidth;
    const w = Math.max(LIVE_CHART_W_MIN, Math.min(Math.round(gw / 2), Math.round(wanted)));
    grid.style.setProperty('--chart-w', w + 'px');
  }
  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    document.body.classList.add('lv-resizing');
    const right = grid.getBoundingClientRect().right;
    const move = (ev) => {
      const gw = grid.getBoundingClientRect().width;
      wanted = Math.max(LIVE_CHART_W_MIN, Math.min(gw / 2, right - ev.clientX));
      applyWidth();
    };
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      document.body.classList.remove('lv-resizing');
      if (wanted != null) { try { localStorage.setItem(LIVE_CHART_W_KEY, String(Math.round(wanted))); } catch {} }
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });
  splitter.addEventListener('dblclick', () => {
    wanted = null;
    applyWidth();
    try { localStorage.removeItem(LIVE_CHART_W_KEY); } catch {}
  });
  applyWidth();

  // Re-clamp the chart column with the grid, and refit the trades with their
  // card — whatever moved them.
  new ResizeObserver(applyWidth).observe(grid);
  let fitQueued = false;
  new ResizeObserver(() => {
    if (fitQueued || !liveLoaded) return;
    fitQueued = true;
    requestAnimationFrame(() => { fitQueued = false; fitLiveTrades(); });
  }).observe(document.getElementById('live-trades-box'));
}

// Full per-bar CSV of the live recompute — same flow as the backtest's
// "Export full CSV" (recomputes in Python and writes straight to a chosen path).
(function wireLiveExport() {
  const btn = document.getElementById('live-export');
  const msg = document.getElementById('live-export-msg');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Exporting…';
    msg.textContent = '';
    msg.classList.remove('err');
    try {
      const res = await window.api.exportLiveCsv();
      if (res && res.ok) {
        msg.textContent = 'saved';
      } else if (res && res.error === 'canceled') {
        // user dismissed the save dialog — say nothing
      } else {
        msg.textContent = (res && res.error) || 'export failed';
        msg.classList.add('err');
      }
    } catch (e) {
      msg.textContent = e.message || 'export failed';
      msg.classList.add('err');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
})();

async function loadLive() {
  const empty = document.getElementById('live-empty');
  const results = document.getElementById('live-results');
  const res = await window.api.loadLive();
  if (!res || !res.ok) {
    results.classList.add('hidden');
    document.getElementById('live-stale').hidden = true;
    empty.hidden = false;
    empty.textContent = res && res.error === 'no-file'
      ? 'No live signal yet — it computes automatically when data updates.'
      : 'Could not read live_signal.json: ' + ((res && res.error) || 'unknown error');
    return;
  }
  empty.hidden = true;
  results.classList.remove('hidden');
  liveLoaded = true;
  renderLive(res);
}

// Coming (back) to the Live tab: current params and payload, then let the
// strategy's views redraw and the charts refit to the now-visible pane.
async function showLive() {
  initLiveParams();
  await loadLive();
  if (plugin.live && plugin.live.onShow) plugin.live.onShow();
  requestAnimationFrame(() => { if (liveEqChart) liveEqChart.timeScale().fitContent(); });
}

window.api.onLiveChanged(() => {
  if (liveLoaded || document.getElementById('tab-live').classList.contains('active')) loadLive();
});

// --------------------------------------------------------------------------- //
// Log tab
// --------------------------------------------------------------------------- //
const logEl = document.getElementById('log');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const stateEl = document.getElementById('updater-state');

const LOG_MAX_LINES = 5000;   // the app runs for days; keep the panel from growing without bound
function appendLog(data) {
  const div = document.createElement('div');
  if (data.stream === 'err') div.className = 'err';
  else if (data.stream === 'sys') div.className = 'sys';
  div.textContent = data.line;
  logEl.appendChild(div);
  while (logEl.childElementCount > LOG_MAX_LINES) logEl.firstElementChild.remove();
  if (document.getElementById('autoscroll').checked) logEl.scrollTop = logEl.scrollHeight;
}

function setUpdaterState(status) {
  const running = status && status.running;
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  let label = 'stopped';
  if (running) label = status.source === 'external' ? 'running · external' : 'running';
  stateEl.textContent = label;
  stateEl.className = 'pill ' + (running ? 'running' : 'idle');
}

startBtn.addEventListener('click', async () => setUpdaterState(await window.api.startUpdater()));
stopBtn.addEventListener('click', async () => { await window.api.stopUpdater(); });
document.getElementById('clearlog').addEventListener('click', () => { logEl.innerHTML = ''; });

window.api.onUpdaterLog(appendLog);
window.api.onUpdaterStatus(setUpdaterState);


// --------------------------------------------------------------------------- //
// Strategy UI plug-in. The whole window is the strategy's tab (labelled with
// its manifest "symbol"); its sub-tabs Live / Backtest / Log are generic. The
// strategy's ui.js (+ ui.css) adds its own parts by calling QT.register({...})
// with either or both of:
//   live:  { mount(el), onShow(), onLive(sig) }   its views on the Live
//          sub-tab (onLive: each new live payload — signal, market, signals,
//          params, trades, ...). In mount it fills the Live layout through
//          QT.live (every part optional; parts it leaves alone stay hidden):
//            QT.live.tiles          element beside the signal, for tiles
//                                   (QT.ui.liveTile builds one)
//            QT.live.panel(title)   claims the next strategy panel (two at
//                                   most, one per panel row beside the app's
//                                   panels) and returns its body element;
//                                   fill it with QT.ui.kvRow(cells) rows of
//                                   QT.ui.kv(label, value, tone) cells to read
//                                   like the app's panels
//            QT.live.details(title) adds the strategy's own rows under the
//                                   app's in the "Position & performance"
//                                   box (retitled `title`) and returns the
//                                   element for them (QT.ui.kvRow rows)
//            QT.live.chart(title)   claims the chart card at the top of the
//                                   chart column, over the profit and loss
//                                   curve; returns { body, title, sub, stat }
//                                   (draw the chart in body, the head's
//                                   subtitle and stat in sub / stat)
//          A UI that claims no panels may instead put free-form views in
//          `el`; they span both panel rows.
//   input: { mount(el), onShow() }   the Input sub-tab (hand-maintained
//          inputs); the sub-tab only appears when a strategy provides it
// and uses QT.api / QT.ui / QT.onDbChanged for data access and shared widgets.
// --------------------------------------------------------------------------- //
const plugin = {};
const livePanelCards = [document.getElementById('live-strat-top'), document.getElementById('live-strat-bottom')];
let liveStrategyPanels = 0;

window.QT = {
  config: CONFIG,
  api: {
    // One column of the strategy's bar table as a chart series:
    // {column, range: '1D'|'1W'|'1M'|'3M'|'1Y'|'ALL', maxPoints, scale}
    getSeries: (args) => window.api.getSeries(args),
    listRows: (table) => window.api.listRows(table),         // a manifest data_tables table
    addRow: (table, row) => window.api.addRow(table, row),
    updateRow: (table, id, row) => window.api.updateRow(table, id, row),
    deleteRow: (table, id) => window.api.deleteRow(table, id),
    reloadDb: () => window.api.reloadDb(),
  },
  ui: {
    colors: { UP, DOWN, FLAT },
    esc, makeChart, formatPrice, formatTime, colorFor, setActiveRange,
    tile: btTile, liveTile: lvTile, metricRow: lmRow, kvRow: lvKvRow, kv: lvKv,
    num: lvNum, pct: lvPct, time: lvTime, tone: lvCls,
  },
  onDbChanged: (cb) => dbListeners.push(cb),
  // The strategy's places in the Live layout (see above).
  live: {
    tiles: document.getElementById('live-tiles'),
    panel(title) {
      const card = livePanelCards[liveStrategyPanels];
      if (!card) throw new Error('the Live layout has room for two strategy panels');
      liveStrategyPanels += 1;
      card.querySelector('.lv-title').textContent = title || '';
      card.hidden = false;
      return card.querySelector('.lv-body');
    },
    details(title) {
      const el = document.getElementById('live-details');
      if (title) document.querySelector('#live-position-card .lv-title').textContent = title;
      el.hidden = false;
      return el;
    },
    chart(title) {
      const card = document.getElementById('live-strat-chart');
      const head = card.querySelector('.lv-head');
      head.querySelector('.lv-title').textContent = title || '';
      card.hidden = false;
      return {
        body: card.querySelector('.lv-body'),
        title: head.querySelector('.lv-title'),
        sub: head.querySelector('.lv-sub'),
        stat: head.querySelector('.lv-stat'),
      };
    },
  },
  register(p) { Object.assign(plugin, p); },
};

function loadAsset(tag, attrs) {
  return new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement(tag), attrs);
    el.onload = resolve;
    el.onerror = () => reject(new Error(`could not load ${attrs.src || attrs.href}`));
    document.head.appendChild(el);
  });
}

// Let the strategy's UI build its parts.
function mountStrategyUi() {
  if (plugin.live) plugin.live.mount(document.getElementById('live-strategy'));
  if (plugin.input) {
    plugin.input.mount(document.getElementById('input-root'));
    document.querySelector('#subtabs .tab[data-tab="input"]').hidden = false;
  }
}

// --------------------------------------------------------------------------- //
// Boot
// --------------------------------------------------------------------------- //
(async function boot() {
  CONFIG = await window.api.getConfig();
  window.QT.config = CONFIG;
  document.getElementById('strategy-tab').textContent = CONFIG.symbol || CONFIG.title;
  // The strategy's own parts, if it ships a UI.
  try {
    if (CONFIG.ui.style) await loadAsset('link', { rel: 'stylesheet', href: CONFIG.ui.style });
    if (CONFIG.ui.script) {
      await loadAsset('script', { src: CONFIG.ui.script });
      mountStrategyUi();
    }
  } catch (e) {
    appendLog({ stream: 'err', line: `Strategy UI failed to load: ${e.message}` });
  }
  // Lay the Live tab out around whatever the strategy mounted, then populate
  // it (Live is the default sub-tab; this hands the strategy's live views their
  // first payload before they draw).
  setupLiveLayout();
  await showLive();
  setUpdaterState(await window.api.getUpdaterStatus());
})();
