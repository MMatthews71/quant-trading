'use strict';

// The strategy's own Live views and Input sub-tab, kept in the shareable base
// repo rather than inside the (private) strategy folder. Nothing here names or
// reveals the strategy: everything instrument-specific is read at runtime from
// QT.config, which the app builds from the strategy's own manifest.json —
//   config.symbol       the instrument label shown in the UI
//   config.tzLabel      the strategy's timezone label
//   config.uiConfig     the manifest's "ui_config" block, holding this view's
//                       strategy-specific detail:
//     priceColumn       bar-table column with the stitched price (USD/share)
//     revColumn         bar-table column with the modelled revenue (USD/yr)
//     forecastTable     the data_tables table the Input tab edits
//     commodities       [{label, unit, low, high, avg}, ...] forecast inputs,
//                       where low/high/avg are the row keys for each commodity
// A strategy plugs this UI in by setting manifest "ui_dir" to this folder and
// filling in "ui_config"; see engine/strategies/README.md.

(function () {
  const { api, ui, config } = window.QT;
  const { esc, num, pct, time, tone, liveTile, kvRow, kv } = ui;

  const CFG = config.uiConfig || {};
  const PRICE_COL = CFG.priceColumn;           // stitched price (USD/share)
  const REV_COL = CFG.revColumn;               // modelled revenue (USD/yr)
  const REV = '#a371f7';                       // revenue line (violet)
  const bn = (v) => (v == null || !Number.isFinite(v) ? '—' : '$' + (v / 1e9).toFixed(2) + 'bn');
  const sig4 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(4));
  // A fraction centered on 0 (the s and m signals), shown as a percent.
  const pctd = (v) => (v == null || !Number.isFinite(v) ? '—' : pct(v * 100));

  // ------------------------------------------------------------------------ //
  // Tiles + panels (from the live payload)
  // ------------------------------------------------------------------------ //
  function tiles(sig) {
    const m = sig.market || {};
    const s = (sig.signals || {}).s, mm = (sig.signals || {}).m;
    // Delta = (live rev / base rev) / (live price / base price) - 1
    const revRel = m.revenue / m.base_time_rev, pxRel = m.price / m.base_time_price;
    const delta = Number.isFinite(revRel) && Number.isFinite(pxRel) && pxRel !== 0 ? (revRel / pxRel - 1) * 100 : null;
    // The base levels behind the Δs, on hover (the base time is in the
    // Position & market box).
    const baseTip = `Base: price ${num(m.base_time_price)} · revenue ${bn(m.base_time_rev)}`;
    return `<div class="lv-tile" title="${esc(baseTip)}"><table class="strat-mvb"><thead><tr><th>${esc(config.symbol)} vs base</th><th>Live</th><th>Δ</th></tr></thead><tbody>` +
        `<tr><td>Price (USD)</td><td>${num(m.price)}</td><td class="${tone(m.delta_price)}">${pct(m.delta_price)}</td></tr>` +
        `<tr><td>Revenue / yr</td><td>${bn(m.revenue)}</td><td class="${tone(m.delta_rev)}">${pct(m.delta_rev)}</td></tr>` +
      `</tbody></table></div>` +
      liveTile('Delta', pct(delta), tone(delta)) +
      liveTile('Signal 1 (s)', pctd(s), tone(s)) +
      liveTile('Signal 2 (m)', pctd(mm), tone(mm));
  }

  // ------------------------------------------------------------------------ //
  // The strategy's rows in the app's Position box: the context the signal
  // depends on.
  // ------------------------------------------------------------------------ //
  // The production forecast feeding the revenue model: the latest row whose
  // quarterly date is at or before the latest bar. A stale one quietly biases
  // s and m, so its age is shown.
  let liveForecasts = [];
  const tsMs = (ts) => (ts ? Date.parse(String(ts).replace(' ', 'T')) : NaN);
  async function loadLiveForecasts() {
    if (!TABLE) return;
    try { liveForecasts = (await api.listRows(TABLE)).rows || []; } catch { liveForecasts = []; }
    if (lastSig) renderDetail(lastSig);
  }
  function forecastInUse(m) {
    const at = tsMs(m.ts);
    let best = null;
    for (const r of liveForecasts) {
      const t = tsMs(r.qtrly_date);
      if (Number.isFinite(t) && (!Number.isFinite(at) || t <= at) && (!best || t > best.t)) best = { r, t };
    }
    if (!best) return '—';
    const days = Number.isFinite(at) ? Math.floor((at - best.t) / 86400000) : null;
    return `${esc(best.r.fy || '—')}<small class="dim">from ${esc(String(best.r.qtrly_date).slice(0, 10))}` +
           (days != null ? ` · ${days} d old` : '') + `</small>`;
  }

  function renderDetail(sig) {
    const m = sig.market || {};
    // One row: what the signal is measured against.
    detailEl.innerHTML = kvRow(
      kv('Base time', time(m.base_time)) +
      kv('Contract', `${esc(m.active_contract || '—')}<small class="dim">${esc(m.source || '')}</small>`) +
      kv('Forecast in use', forecastInUse(m)));
  }

  // ------------------------------------------------------------------------ //
  // Chart: price vs modelled revenue, both indexed to 100 at the strategy's
  // base time (the lookback reference carried in the live payload) when we have
  // one, else at the start of the window. With a base, the window is set when
  // the base time changes: the base BASE_AT (a quarter) of the way across and
  // the newest bar at the right edge (or, for a base newer than that allows,
  // a WINDOW_DAYS window with room to fill on the right). After that the window
  // keeps its length and scrolls with new data, so the base line drifts left
  // until the base time updates and it starts over (it stops at the left edge).
  // Without a base the chart is the last WINDOW_DAYS. Bars before the base read
  // relative to it, the dashed 100 line marks the base level and a dashed
  // vertical line the base time.
  // ------------------------------------------------------------------------ //
  const BASE_AT = 0.25;       // how far across the chart the base point sits
  const WINDOW_DAYS = 8;      // window with no base point; the shortest one with a base
  // The stored ranges getSeries accepts (RANGE_DAYS in app/main.js), smallest first.
  const RANGES = [['1W', 7], ['1M', 30], ['3M', 90], ['1Y', 365], ['ALL', Infinity]];
  let chart = null, priceSeries = null, revSeries = null;
  let card = null;            // QT.live.chart(): { body, title, sub, stat }
  let chartEl = null, tipEl = null, lgPriceEl = null;
  let drawSeq = 0;            // newest refreshChart wins when two overlap
  let priceBase = null, revBase = null, lastT = null;   // for live updates (onLive)
  let baseRef = null;         // {time, price, rev} base-time reference from the payload
  let drawnBaseSec = null;    // base time (sec) the current draw is indexed to
  let frameTimes = [];        // every plotted time (both lines), ascending
  let frame = null;           // {base, left, width} in wall seconds: the base's window; null: fit all
  // The window survives a restart (it only resets when the base time changes).
  const FRAME_KEY = `stratui.chartFrame.${config.strategy || config.symbol}`;
  const rawPrice = new Map(), rawRev = new Map();   // time -> original value (tooltip/stat)
  const signed = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
  const fmtIdx = (v) => `${v.toFixed(1)} (${signed(v - 100)})`;
  // Seconds for a bar timestamp, read as wall clock like the stored series.
  const tsSec = (ts) => {
    if (ts == null) return null;
    if (typeof ts === 'number') return Math.floor(ts);
    const ms = Date.parse(String(ts).slice(0, 19) + 'Z');
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  };

  // A dashed vertical line across the pane at a given time, marking the base
  // point. Lightweight Charts has no built-in vertical line, so this is a
  // minimal series primitive (v4.1+); its time is null when there is no base.
  let baseLine = null;
  class BaseLineView {
    constructor(src) { this._src = src; this._x = null; }
    update() {
      const t = this._src._time;
      this._x = t == null ? null : this._src._chart.timeScale().timeToCoordinate(t);
    }
    renderer() {
      const x = this._x, o = this._src._options;
      return {
        draw: (target) => {
          if (x == null) return;
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context, pr = scope.horizontalPixelRatio;
            const px = Math.round(x * pr);
            ctx.save();
            ctx.strokeStyle = o.color;
            ctx.lineWidth = Math.max(1, Math.floor(o.width * pr));
            ctx.setLineDash([4 * pr, 4 * pr]);
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, scope.bitmapSize.height);
            ctx.stroke();
            ctx.restore();
          });
        },
      };
    }
  }
  class BaseLine {
    constructor(chart, time, options) {
      this._chart = chart;
      this._time = time;
      this._options = options;
      this._views = [new BaseLineView(this)];
    }
    updateAllViews() { this._views.forEach((v) => v.update()); }
    paneViews() { return this._views; }
    setTime(t) { this._time = t; this.updateAllViews(); }
  }

  // The app's chart card: the legend is the head's title, the move since the
  // reference its stat; the chart fills the body.
  function mountChart(c) {
    card = c;
    c.body.classList.add('strat-ui');
    c.title.innerHTML =
      `<span class="lv-legend"><span class="lv-key">${esc(config.symbol)} price</span>` +
      `<span class="lv-key" style="--key:${REV}">Revenue</span></span>`;
    lgPriceEl = c.title.querySelector('.lv-key');
    c.body.innerHTML = `<div class="lv-canvas"></div><div class="tip strat-tip hidden"></div>`;
    chartEl = c.body.querySelector('.lv-canvas');
    tipEl = c.body.querySelector('.tip');
    const made = ui.makeChart(chartEl);
    chart = made.chart;
    priceSeries = made.series;
    // Both lines are indexed to 100, so they share the right axis.
    revSeries = chart.addLineSeries({
      color: REV, lineWidth: 2, priceScaleId: 'right',
      priceLineVisible: false, lastValueVisible: true,
      lineType: LightweightCharts.LineType.WithSteps,
    });
    chart.applyOptions({
      // keep the framing (base a quarter across) when the pane is resized
      timeScale: { lockVisibleTimeRangeOnResize: true },
      leftPriceScale: { visible: false },
      localization: { priceFormatter: (v) => v.toFixed(1) },
    });
    priceSeries.createPriceLine({
      price: 100, color: '#4a5566', lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false,
    });
    // Vertical line marking the base time (set in refreshChart).
    baseLine = new BaseLine(chart, null, { color: '#6b7a90', width: 1 });
    priceSeries.attachPrimitive(baseLine);
    chart.subscribeCrosshairMove(showTip);
    // A drag or zoom is only for a quick look: RESET_AFTER_MS after the last
    // one, the chart goes back to the full, up-to-date view (also what every
    // new session starts with).
    const later = () => { clearTimeout(resetTimer); resetTimer = setTimeout(frameChart, RESET_AFTER_MS); };
    let pressed = false;   // released anywhere (a drag can end off the chart)
    chartEl.addEventListener('pointerdown', () => { pressed = true; });
    window.addEventListener('pointerup', () => { if (pressed) { pressed = false; later(); } });
    chartEl.addEventListener('wheel', later, { passive: true });
  }
  const RESET_AFTER_MS = 10000;
  let resetTimer = null;

  // Index points to 100 within [startSec, endSec]. `baseValue` sets the 100
  // mark (the strategy's base-time level); pass null to index to the window
  // start instead. The left edge is pinned to the last value at or before
  // startSec so a stepped line (revenue) spans the whole window and old steps
  // don't stretch the time axis backwards. Returns the indexed points and the
  // base value used (so live point updates index the same way).
  function indexWindow(points, startSec, endSec, raw, baseValue) {
    raw.clear();
    let before = null;
    const inWin = [];
    for (const p of points || []) {
      if (p.value == null || !Number.isFinite(p.value)) continue;
      if (p.time <= startSec) { before = p; continue; }
      if (p.time > endSec) continue;
      inWin.push(p);
    }
    const base = baseValue != null ? baseValue
               : (before ? before.value : (inWin[0] && inWin[0].value));
    if (!base) return { pts: [], base: null };
    const pinned = before ? [{ time: startSec, value: before.value }] : [];
    const pts = [...pinned, ...inWin].map((p) => {
      raw.set(p.time, p.value);
      return { time: p.time, value: (p.value / base) * 100 };
    });
    return { pts, base };
  }

  // The stored range to fetch: the smallest reaching back to the window's left
  // edge (for a new base, enough run-up for it to sit a quarter across), plus a
  // day to spare. Everything fetched is drawn; the window shows part. Bar times
  // are wall clock, up to 14h ahead of UTC, so "now" is the later of that and
  // the newest bar drawn so far.
  function fetchRange(baseSec) {
    if (baseSec == null) return '1M';
    const nowSec = Math.max(Date.now() / 1000 + 14 * 3600, lastT || 0);
    const back = frame && frame.base === baseSec
      ? nowSec - Math.min(frame.left, baseSec)
      : Math.max(2 * (nowSec - baseSec), nowSec - baseSec + BASE_AT * WINDOW_DAYS * 86400);
    return RANGES.find(([, d]) => d >= back / 86400 + 1)[0];
  }

  // Wall time <-> fractional logical index among frameTimes (the chart spaces
  // points evenly, not by time), extrapolated past either end at the average
  // spacing.
  function logicalAt(t) {
    const ts = frameTimes, n = ts.length;
    const step = n > 1 ? (ts[n - 1] - ts[0]) / (n - 1) : 300;
    if (t <= ts[0]) return (t - ts[0]) / step;
    if (t >= ts[n - 1]) return n - 1 + (t - ts[n - 1]) / step;
    let lo = 0, hi = n - 1;   // ts[lo] <= t < ts[hi]
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
    return lo + (t - ts[lo]) / (ts[hi] - ts[lo]);
  }
  function timeAt(l) {
    const ts = frameTimes, n = ts.length;
    const step = n > 1 ? (ts[n - 1] - ts[0]) / (n - 1) : 300;
    if (l <= 0) return ts[0] + l * step;
    if (l >= n - 1) return ts[n - 1] + (l - (n - 1)) * step;
    const i = Math.floor(l);
    return ts[i] + (l - i) * (ts[i + 1] - ts[i]);
  }

  // A new base's window: the base BASE_AT across with the newest bar at the
  // right edge, kept as times so it holds up when the drawn points change.
  function newFrame(baseSec) {
    const last = frameTimes.length - 1;
    const from = (logicalAt(baseSec) - BASE_AT * last) / (1 - BASE_AT);
    let left = timeAt(from), width = frameTimes[last] - left;
    const min = WINDOW_DAYS * 86400;
    if (width < min) { width = min; left = baseSec - BASE_AT * min; }   // too new a base
    return { base: baseSec, left, width };
  }

  // Show the window: its length, ending at the newest bar (or its first right
  // edge, while data hasn't reached it yet). Once the base has drifted to the
  // left edge it stays there and the window grows instead.
  function frameChart() {
    if (!frame || !frameTimes.length) { chart.timeScale().fitContent(); return; }
    const last = frameTimes.length - 1;
    const right = Math.max(frameTimes[last], frame.left + frame.width);
    let from = logicalAt(right - frame.width), to = logicalAt(right);
    const baseL = logicalAt(frame.base);
    if (from > baseL - 1) { from = baseL - 1; to = Math.max(to, last); }
    chart.timeScale().setVisibleLogicalRange({ from, to });
  }

  function showTip(param) {
    const tip = tipEl;
    if (!param.point || !param.time || !param.seriesData) { tip.classList.add('hidden'); return; }
    const p = param.seriesData.get(priceSeries);
    const r = param.seriesData.get(revSeries);
    if (!p && !r) { tip.classList.add('hidden'); return; }
    let html = '';
    if (p) {
      const raw = rawPrice.get(param.time);
      html += `<span class="tip-price">${fmtIdx(p.value)}${raw != null ? ' · ' + ui.formatPrice(raw) : ''}</span>`;
    }
    if (r) {
      const raw = rawRev.get(param.time);
      html += `<span class="tip-rev">${fmtIdx(r.value)}${raw != null ? ' · ' + bn(raw) : ''}</span>`;
    }
    html += `<span class="tip-time">${ui.formatTime(param.time, true)}</span>`;
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    // The tip sits in the card body; the canvas is inset within it.
    const x = param.point.x + chartEl.offsetLeft, y = param.point.y + chartEl.offsetTop;
    let left = x + 8;
    if (left + tip.offsetWidth > card.body.clientWidth - 8) left = x - tip.offsetWidth - 8;
    tip.style.left = left + 'px';
    tip.style.top = y + 'px';
  }

  // The head's stat: the latest price and its move since the 100 reference.
  function renderStat(price, chg) {
    const cls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
    card.stat.innerHTML = `<span class="lv-stat-v">${ui.formatPrice(price)}</span>` +
                          `<span class="lv-stat-chg ${cls}">${signed(chg)}</span>`;
  }

  // The stored window for this base time, if there is one.
  function savedFrame(baseSec) {
    if (baseSec == null) return null;
    try {
      const f = JSON.parse(localStorage.getItem(FRAME_KEY));
      if (f && f.base === baseSec && Number.isFinite(f.left) && f.width > 0) return f;
    } catch {}
    return null;
  }

  async function refreshChart() {
    if (!chart || !PRICE_COL) return;
    const seq = ++drawSeq;
    const useBase = !!(baseRef && Number.isFinite(baseRef.price));
    const baseSec = useBase ? tsSec(baseRef.time) : null;
    if (!frame || frame.base !== baseSec) frame = savedFrame(baseSec);
    const range = fetchRange(baseSec);
    const [res, rev] = await Promise.all([
      api.getSeries({ column: PRICE_COL, range, maxPoints: 2000 }),
      api.getSeries({ column: REV_COL, range, maxPoints: 2000 }),   // raw USD; indexing makes scale irrelevant
    ]);
    if (seq !== drawSeq) return;   // a newer redraw started meanwhile
    const pricePts = res.points || [];
    const endSec = pricePts.length ? pricePts[pricePts.length - 1].time : null;

    // Index to the strategy's base time when the payload has given us one,
    // otherwise to the window start. With a base everything fetched is drawn
    // (frameChart picks what shows); without one, the last WINDOW_DAYS.
    const startSec = endSec == null ? null
      : baseSec != null ? pricePts[0].time - 1
                        : Math.floor(endSec - WINDOW_DAYS * 86400);
    const priceR = endSec != null
      ? indexWindow(pricePts, startSec, endSec, rawPrice, useBase ? baseRef.price : null)
      : { pts: [], base: null };
    const price = priceR.pts;
    // The base point itself (indexed 100 by definition), in case downsampling
    // dropped it: it anchors the framing and the vertical line.
    if (useBase && baseSec > startSec && baseSec <= endSec && !price.some((p) => p.time === baseSec)) {
      price.splice(price.findIndex((p) => p.time > baseSec), 0, { time: baseSec, value: 100 });
      rawPrice.set(baseSec, baseRef.price);
    }

    if (!price.length) {
      priceSeries.setData([]);
      revSeries.setData([]);
      card.stat.innerHTML = `<span class="lv-stat-chg">no data</span>`;
      card.sub.textContent = '';
      priceBase = revBase = lastT = drawnBaseSec = null;
      frameTimes = [];
      if (baseLine) baseLine.setTime(null);
      return;
    }

    const revBaseVal = useBase && Number.isFinite(baseRef.rev) ? baseRef.rev : null;
    const revR = indexWindow(rev.points, startSec, endSec, rawRev, revBaseVal);
    const revIdx = revR.pts;
    // Carry revenue's last step to the end of the price data so it spans the window.
    const lastRev = revIdx[revIdx.length - 1];
    if (lastRev && lastRev.time < endSec) {
      revIdx.push({ time: endSec, value: lastRev.value });
      rawRev.set(endSec, rawRev.get(lastRev.time));
    }

    priceSeries.setData(price);
    revSeries.setData(revIdx);
    priceBase = priceR.base;
    revBase = revR.base;
    lastT = endSec;
    drawnBaseSec = baseSec;
    if (baseLine) baseLine.setTime(drawnBaseSec);

    const pChg = price[price.length - 1].value - 100;   // move since the 100 reference
    const priceColor = ui.colorFor({ ...res.meta, change: pChg, changePct: pChg });
    priceSeries.applyOptions({ color: priceColor });
    lgPriceEl.style.setProperty('--key', priceColor);

    // Frame on the base: a new base gets a new window (kept across restarts).
    frameTimes = [...new Set([...price, ...revIdx].map((p) => p.time))].sort((a, b) => a - b);
    if (baseSec == null) frame = null;
    else if (!frame) {
      frame = newFrame(baseSec);
      try { localStorage.setItem(FRAME_KEY, JSON.stringify(frame)); } catch {}
    }
    frameChart();
    // Again once layout settles: a chart whose pane was just shown only picks
    // up its real width on the next frame, and would otherwise stay squashed.
    requestAnimationFrame(frameChart);

    renderStat(rawPrice.get(endSec), pChg);
    const revTxt = lastRev ? ` · revenue ${signed(lastRev.value - 100)}` : '';
    const ref = useBase ? `since base ${time(baseRef.time)}` : `${WINDOW_DAYS}-day change`;
    card.sub.textContent = `${ref}${revTxt} · last bar ${time(res.meta && res.meta.lastTs)}`;
  }

  // The stored series only grows once per bar; between bars the live payload
  // carries the latest price (and the revenue modelled off it), so move the
  // newest point of both lines with it and refresh the header.
  function liveChartPoint(sig) {
    const m = sig.market || {};
    if (!chart || priceBase == null || !m.ts) return;
    const t = tsSec(m.ts);   // wall clock, as the stored series
    if (!Number.isFinite(t) || lastT == null || t < lastT) return;
    const hasPrice = Number.isFinite(m.price), hasRev = !!revBase && Number.isFinite(m.revenue);
    if (hasPrice) {
      priceSeries.update({ time: t, value: (m.price / priceBase) * 100 });
      rawPrice.set(t, m.price);
    }
    if (hasRev) {
      revSeries.update({ time: t, value: (m.revenue / revBase) * 100 });
      rawRev.set(t, m.revenue);
    }
    if (t > lastT && (hasPrice || hasRev)) {   // a new point: scroll the window with it
      frameTimes.push(t);
      frameChart();
    }
    lastT = t;
    if (Number.isFinite(m.price)) renderStat(m.price, (m.price / priceBase) * 100 - 100);
  }

  // ------------------------------------------------------------------------ //
  // Input sub-tab: production forecasts (a manifest data_tables table)
  // ------------------------------------------------------------------------ //
  const TABLE = CFG.forecastTable;
  const COMMODITIES = CFG.commodities || [];
  let fcRoot = null, fcRows = [], fcEditId = null;
  const fc = (name) => fcRoot.querySelector(`[data-fc="${name}"]`);
  const fcNum = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString());

  function mountForecasts(el) {
    fcRoot = el;
    el.classList.add('strat-ui');
    el.innerHTML =
      `<div class="panel"><div class="panel-head"><span class="panel-title">Add a production forecast</span>` +
        `<span class="fc-msg" data-fc="msg"></span></div>` +
        `<div class="fc-grid">` +
          `<label class="fc-cell"><span class="fc-lbl">Fiscal year *</span>` +
            `<input class="fc-in" data-fc="fy" placeholder="FY27" /></label>` +
          `<label class="fc-cell"><span class="fc-lbl">Qtrly date * <em>(exact ts, incl. +08:00)</em></span>` +
            `<input class="fc-in" data-fc="qtrly_date" placeholder="2026-02-18 07:00:00+08:00" /></label>` +
          `<div class="fc-contents">` + COMMODITIES.map((c) =>
            `<div class="fc-cell"><span class="fc-lbl">${c.label} <em>(${c.unit})</em></span><div class="fc-ins">` +
            `<input class="fc-in" type="number" step="any" placeholder="Low" data-fc="${c.low}">` +
            `<input class="fc-in" type="number" step="any" placeholder="High" data-fc="${c.high}"></div></div>`).join('') +
          `</div></div>` +
        `<div class="fc-actions"><button class="primary" data-fc="submit">Add forecast</button>` +
          `<button class="ghost hidden" data-fc="cancel">Cancel</button></div></div>` +
      `<div class="section-label">Forecasts (newest last)</div>` +
      `<div class="data-table-wrap"><table class="data-table" data-fc="table"></table></div>`;

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.fc === 'submit') submit();
      else if (btn.dataset.fc === 'cancel') { clearForm(); setEdit(null); msg(''); }
      else if (btn.classList.contains('fc-edit')) edit(btn.dataset.id);
      else if (btn.classList.contains('fc-del')) remove(btn.dataset.id);
    });
  }

  function msg(text, cls) {
    fc('msg').textContent = text;
    fc('msg').className = 'fc-msg' + (cls ? ' ' + cls : '');
  }

  async function loadForecasts() {
    if (!TABLE) return;
    const res = await api.listRows(TABLE);
    fcRows = res.rows || [];
    const table = fc('table');
    if (!fcRows.length) {
      table.innerHTML = '<tbody><tr><td>No forecasts yet.</td></tr></tbody>';
      return;
    }
    // Two-row header: commodity name spanning Low / High / Avg, plus an actions column.
    let h1 = '<tr><th rowspan="2">FY</th><th rowspan="2">Qtrly date</th>';
    let h2 = '<tr>';
    for (const c of COMMODITIES) {
      h1 += `<th colspan="3" class="fc-grp fc-gstart">${c.label} <span>(${c.unit})</span></th>`;
      h2 += '<th class="fc-gstart">Low</th><th>High</th><th>Avg</th>';
    }
    h1 += '<th rowspan="2" class="fc-gstart"></th></tr>';
    h2 += '</tr>';
    let body = '<tbody>';
    for (const r of fcRows) {
      let cells = `<td>${esc(r.fy)}</td><td class="fc-ts">${esc(r.qtrly_date)}</td>`;
      for (const c of COMMODITIES) {
        cells += `<td class="fc-lo fc-gstart">${fcNum(r[c.low])}</td>` +
                 `<td class="fc-lo">${fcNum(r[c.high])}</td>` +
                 `<td class="fc-avg">${fcNum(r[c.avg])}</td>`;
      }
      cells += `<td class="fc-acts fc-gstart">` +
        `<button class="fc-edit" data-id="${esc(r.id)}" title="Edit">✎</button>` +
        `<button class="fc-del" data-id="${esc(r.id)}" title="Delete">✕</button></td>`;
      body += `<tr>${cells}</tr>`;
    }
    table.innerHTML = `<thead>${h1}${h2}</thead>${body}</tbody>`;
  }

  // Read the form into a row; each avg is the mean of the low/high entered.
  // A blank box is null, so updating a row clears it (an add just leaves it out).
  function formRow() {
    const row = { fy: fc('fy').value.trim(), qtrly_date: fc('qtrly_date').value.trim() };
    for (const c of COMMODITIES) {
      const lo = fc(c.low).value, hi = fc(c.high).value;
      row[c.low] = lo !== '' ? Number(lo) : null;
      row[c.high] = hi !== '' ? Number(hi) : null;
      const vals = [lo, hi].filter((v) => v !== '').map(Number);
      row[c.avg] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    return row;
  }

  function clearForm() {
    fcRoot.querySelectorAll('.fc-in').forEach((i) => (i.value = ''));
  }

  function setEdit(id) {
    fcEditId = id;
    fc('submit').textContent = id == null ? 'Add forecast' : 'Update forecast';
    fc('cancel').classList.toggle('hidden', id == null);
  }

  function edit(id) {
    const r = fcRows.find((x) => String(x.id) === String(id));
    if (!r) return;
    fc('fy').value = r.fy || '';
    fc('qtrly_date').value = r.qtrly_date || '';
    for (const c of COMMODITIES) {
      fc(c.low).value = r[c.low] == null ? '' : r[c.low];
      fc(c.high).value = r[c.high] == null ? '' : r[c.high];
    }
    setEdit(id);
    msg(`Editing ${r.fy || 'row'} — change values and press Update`);
    fcRoot.scrollTop = 0;   // fcRoot is the Input sub-tab's scroll area
  }

  async function remove(id) {
    const r = fcRows.find((x) => String(x.id) === String(id));
    if (!confirm(`Delete the ${r ? r.fy + ' ' : ''}forecast (${(r && r.qtrly_date) || ''})?`)) return;
    const res = await api.deleteRow(TABLE, id);
    if (res.ok) {
      if (String(fcEditId) === String(id)) { clearForm(); setEdit(null); }
      await api.reloadDb();
      await loadForecasts();
      msg('Deleted ✓', 'ok');
    } else {
      msg('Error: ' + (res.error || 'failed'), 'err');
    }
  }

  async function submit() {
    const row = formRow();
    if (!row.fy) return msg('Fiscal year is required.', 'err');
    if (!row.qtrly_date) return msg('Qtrly date is required (it is the row key).', 'err');
    const editing = fcEditId != null;
    msg(editing ? 'Updating…' : 'Adding…');
    const res = editing ? await api.updateRow(TABLE, fcEditId, row) : await api.addRow(TABLE, row);
    if (res.ok) {
      msg(editing ? 'Updated ✓' : 'Added ✓', 'ok');
      clearForm();
      setEdit(null);
      await api.reloadDb();
      await loadForecasts();
    } else {
      msg('Error: ' + (res.error || 'failed'), 'err');
    }
  }

  // ------------------------------------------------------------------------ //
  // Live sub-tab: tiles beside the signal, the strategy's rows in the app's
  // Position box (so position and market context read as one box, and the
  // Live parameters take the full width of the row below), and the chart
  // card — all places the app's Live layout provides through QT.live.
  // ------------------------------------------------------------------------ //
  let tilesEl = null, detailEl = null, lastSig = null;

  function mountLive() {
    const L = window.QT.live;
    tilesEl = L.tiles;
    tilesEl.classList.add('strat-ui');
    detailEl = L.details('Position & market');
    detailEl.classList.add('strat-ui');
    loadLiveForecasts();
    mountChart(L.chart(''));
  }

  function onLive(sig) {
    if (!tilesEl) return;
    lastSig = sig;
    tilesEl.innerHTML = tiles(sig);
    renderDetail(sig);
    // Track the base-time reference the chart indexes to. If it moved, the
    // whole indexing changes, so redraw from the DB; otherwise just nudge the
    // newest point with the live price.
    const m = sig.market || {};
    if (m.base_time && Number.isFinite(m.base_time_price)) {
      baseRef = { time: m.base_time, price: m.base_time_price, rev: m.base_time_rev };
    }
    if (lastT != null && baseRef && tsSec(baseRef.time) !== drawnBaseSec) {
      refreshChart();
    } else {
      liveChartPoint(sig);
    }
  }

  window.QT.register({
    // Coming back to Live re-reads the forecasts (the Input tab may have
    // changed them) and redraws the chart.
    live: { mount: mountLive, onShow: () => { loadLiveForecasts(); refreshChart(); }, onLive },
    input: { mount: mountForecasts, onShow: loadForecasts },
  });
  window.QT.onDbChanged(refreshChart);
  window.QT.onDbChanged(loadLiveForecasts);
})();
