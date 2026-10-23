// SMA Crossover — the strategy's own views in the Electron app.
//
// The generic app gives every strategy a Live / Backtest / Input / Log layout
// and the live signal card. This file adds the instrument-specific parts by
// calling QT.register({ live, input }). It uses only the documented QT API:
//   QT.config                       strategy/title/symbol/tzLabel
//   QT.api.getSeries({column,...})  one bar-table column as {points, meta}
//   QT.api.listRows/addRow/deleteRow(table, ...)   a manifest data_tables table
//   QT.ui.*                         shared widgets (makeChart, tiles, helpers)
//   QT.live.chart(title) / .tiles   its places in the app's Live layout
//   QT.onDbChanged(cb)              the bar DB changed on disk
'use strict';

(function () {
  const { api, ui, onDbChanged, config } = window.QT;
  const RANGES = ['1W', '1M', '3M', '1Y', 'ALL'];

  // Simple trailing SMA over the fetched price points (the stored table has no
  // SMA column — the engine computes it — so the Live chart mirrors it here).
  function sma(points, length) {
    const n = Math.max(1, Math.round(length));
    const out = [];
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      sum += points[i].value;
      if (i >= n) sum -= points[i - n].value;
      if (i >= n - 1) out.push({ time: points[i].time, value: sum / n });
    }
    return out;
  }

  // ------------------------------------------------------------------- Live --
  // The app's Live layout gives the strategy a chart card (top of the chart
  // column) and the tiles beside the signal, through QT.live. No panels are
  // claimed, so the app's own panels take the full width.
  const live = (function () {
    let chart, priceSeries, fastSeries, slowSeries, rangeEl, tilesEl;
    let range = '1M';
    let params = { fast: 20, slow: 60 };

    function mount() {
      const card = window.QT.live.chart('');
      card.title.innerHTML =
        '<span class="lv-legend">' +
          '<span class="lv-key" style="--key:#8b949e">' + ui.esc(config.symbol || 'DEMO') + ' price</span>' +
          '<span class="lv-key" style="--key:#f0b429">fast SMA</span>' +
          '<span class="lv-key" style="--key:#4f9bff">slow SMA</span>' +
        '</span>';
      card.stat.innerHTML =
        '<span class="sma-ranges">' +
          RANGES.map((r) => '<button data-range="' + r + '">' + r + '</button>').join('') +
        '</span>';
      card.body.innerHTML = '<div class="lv-canvas"></div>';

      const made = ui.makeChart(card.body.querySelector('.lv-canvas'));
      chart = made.chart;
      priceSeries = made.series;                       // the shared stepped line
      priceSeries.applyOptions({ color: '#8b949e' });
      fastSeries = chart.addLineSeries({ color: '#f0b429', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      slowSeries = chart.addLineSeries({ color: '#4f9bff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

      rangeEl = card.stat.querySelector('.sma-ranges');
      rangeEl.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        range = b.dataset.range;
        ui.setActiveRange(rangeEl, range);
        draw();
      });
      ui.setActiveRange(rangeEl, range);
      tilesEl = window.QT.live.tiles;

      onDbChanged(draw);   // redraw when the updater appends bars
      draw();
    }

    async function draw() {
      if (!chart) return;
      let res;
      try {
        res = await api.getSeries({ column: 'price', range, maxPoints: 1500 });
      } catch (e) {
        return; // DB not built yet — the signal card already explains that
      }
      const pts = res.points || [];
      priceSeries.setData(pts);
      fastSeries.setData(sma(pts, params.fast));
      slowSeries.setData(sma(pts, params.slow));
      chart.timeScale().fitContent();
    }

    // A fresh live payload: refresh the strategy metric tiles and the overlays.
    function onLive(sig) {
      if (sig && sig.params) params = sig.params;
      const m = (sig && sig.market) || {};
      const regime = m.regime ? m.regime.toUpperCase() : '—';
      const tone = m.sma_gap == null ? '' : (m.sma_gap >= 0 ? 'up' : 'down');
      if (tilesEl) {
        tilesEl.innerHTML =
          ui.liveTile('Regime', regime, tone) +
          ui.liveTile('Fast SMA', ui.num(m.sma_fast)) +
          ui.liveTile('Slow SMA', ui.num(m.sma_slow)) +
          ui.liveTile('Fast − Slow', ui.num(m.sma_gap), tone) +
          ui.liveTile('RSI', ui.num(m.rsi));
      }
      draw();
    }

    function onShow() { draw(); }
    return { mount, onShow, onLive };
  })();

  // ------------------------------------------------------------------ Input --
  // Edit the hand-maintained `holidays` table (manifest data_tables). The feed
  // reads these days and marks their bars closed when it builds the bar table.
  const input = (function () {
    let root;

    function mount(el) {
      root = el;
      root.innerHTML =
        '<div class="sma-input">' +
          '<h3>Market holidays</h3>' +
          '<p class="sma-hint">Days the demo market is closed. The live feed ' +
            'marks every bar on these days closed, so no new positions open.</p>' +
          '<form class="sma-holiday-form" id="sma-hol-form">' +
            '<input type="date" id="sma-hol-day" required />' +
            '<input type="text" id="sma-hol-label" placeholder="label (e.g. Thanksgiving)" />' +
            '<button type="submit">Add</button>' +
          '</form>' +
          '<div class="sma-hol-msg" id="sma-hol-msg"></div>' +
          '<table class="data-table" id="sma-hol-table"></table>' +
        '</div>';

      root.querySelector('#sma-hol-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const day = root.querySelector('#sma-hol-day').value;
        const label = root.querySelector('#sma-hol-label').value;
        if (!day) return;
        const res = await api.addRow('holidays', { day, label });
        msg(res.ok ? '' : (res.error || 'could not add'), !res.ok);
        if (res.ok) { root.querySelector('#sma-hol-form').reset(); refresh(); }
      });

      onDbChanged(refresh);
      refresh();
    }

    function msg(text, isErr) {
      const el = root.querySelector('#sma-hol-msg');
      el.textContent = text || '';
      el.className = 'sma-hol-msg' + (isErr ? ' err' : '');
    }

    async function refresh() {
      const { rows } = await api.listRows('holidays');
      const tbl = root.querySelector('#sma-hol-table');
      if (!rows.length) {
        tbl.innerHTML = '<tr><td class="sma-empty">No holidays yet.</td></tr>';
        return;
      }
      tbl.innerHTML =
        '<tr><th>Day</th><th>Label</th><th></th></tr>' +
        rows.map((r) =>
          '<tr><td>' + ui.esc(r.day) + '</td><td>' + ui.esc(r.label || '') + '</td>' +
          '<td><button class="sma-del" data-id="' + ui.esc(r.id) + '">Remove</button></td></tr>'
        ).join('');
      tbl.querySelectorAll('.sma-del').forEach((b) =>
        b.addEventListener('click', async () => {
          const res = await api.deleteRow('holidays', b.dataset.id);
          msg(res.ok ? '' : (res.error || 'could not remove'), !res.ok);
          if (res.ok) refresh();
        })
      );
    }

    function onShow() { refresh(); }
    return { mount, onShow };
  })();

  window.QT.register({ live, input });
})();
