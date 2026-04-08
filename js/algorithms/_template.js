/**
 * _template.js — Algorithm Module Starter Template
 * ═══════════════════════════════════════════════════════════════
 *
 * HOW TO ADD A NEW ALGORITHM IN 2 STEPS:
 *
 *   Step 1: Copy this file → rename to your-algorithm.js
 *   Step 2: Add one line to index.html before </body>:
 *           <script src="js/algorithms/your-algorithm.js"></script>
 *
 *   That's it. The algorithm appears automatically in the nav tabs.
 *   No changes needed in app.js, ui.js, chart.js, or data.js.
 *
 * ═══════════════════════════════════════════════════════════════
 * DATA SOURCES
 * ═══════════════════════════════════════════════════════════════
 *
 * Set `dataSource` to tell app.js which dataset to pass to run():
 *
 *   'ad'  → run() receives: { adRows, incidents }
 *             adRows[i]:  { date, dateStr, energy, proForma,
 *                           measuredInsolation, expectedInsolation }
 *             incidents:  { start, end, type, desc }[]
 *
 *   'tsf' → run() receives: { tsfRows, incidents }
 *             tsfRows[i]: { date, dateStr, energy (null=missing),
 *                           measuredInsolation, expectedInsolation }
 *
 * For completely custom data, implement getData(DataManager) instead.
 *
 * ═══════════════════════════════════════════════════════════════
 * PARAM TYPES
 * ═══════════════════════════════════════════════════════════════
 *
 *   type: 'slider'   → { min, max, step, default, unit?, format? }
 *   type: 'select'   → { options: [{ value, label }][], default }
 *   type: 'toggle'   → { default: boolean }
 *
 * ═══════════════════════════════════════════════════════════════
 * CHART API (use inside render() only)
 * ═══════════════════════════════════════════════════════════════
 *
 *   chartManager.setDataset(chartKey, index, config)
 *     chartKey:  'main' | 'secondary'
 *     index:     slot (0 = raw, 1 = result, 2 = extra, ...)
 *     config:    { label, data, color, borderWidth, pointRadius,
 *                  tension, spanGaps, fill, borderDash, type,
 *                  backgroundColor, unit, order }
 *
 *   chartManager.commit(chartKey)   — apply staged datasets & animate
 *   chartManager.clear(chartKey)    — wipe all datasets (no animation)
 *   chartManager.setXLabels(labels, chartKey)
 *   chartManager.addOverlay(chartKey, (chart) => void)  — canvas drawing
 *   chartManager.setYAxis(chartKey, { min, max, title })
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // 1. DEFINE YOUR ALGORITHM
  // ─────────────────────────────────────────────────────────────
  const algorithm = {

    // Unique identifier — URL-safe, lowercase, no spaces
    id: 'my-algorithm',

    // Display name shown in the nav tab
    name: '我的算法',

    // 'Beginner' | 'Intermediate' | 'Advanced'
    difficulty: 'Beginner',

    // Plain-text explanation shown in the info panel (no markdown)
    description: '在这里用简单的语言解释这个算法的工作原理……',

    // Text shown in the status chip after each run
    // result = the object returned by run()
    statusLabel(result) {
      if (!result || !result.stats) return '等待数据';
      return `结果: ${result.stats.someValue}`;
    },

    // Which dataset to use: 'ad' (anomaly detection) | 'tsf' (forecasting)
    dataSource: 'ad',

    // ── Parameters ──────────────────────────────────────────────
    params: [
      {
        id:      'myParam',
        label:   '我的参数',
        hint:    '这个参数控制……',
        type:    'slider',
        min:     1,
        max:     100,
        step:    1,
        default: 10,
        unit:    '',
        // Optional: custom value display (e.g. convert to percentage)
        // format: v => (v * 100).toFixed(0) + '%',
      },
      // Add more params here — they auto-appear as sliders in the sidebar
    ],

    // ── run(data, params) ────────────────────────────────────────
    // PURE FUNCTION: no DOM access, no chart access, no side effects.
    // Must return { result, stats, metadata }.
    //
    // data.adRows[i] or data.tsfRows[i]:
    //   { date: Date, energy: number|null, ... }
    //
    run(data, params) {
      const rows = data.adRows || data.tsfRows || [];

      if (rows.length === 0) {
        return { result: null, stats: { someValue: '—' }, metadata: {} };
      }

      const values = rows.map(r => r.energy ?? 0);

      // ── YOUR ALGORITHM LOGIC HERE ────────────────────────────
      const outputValues = values.map(v => v * (params.myParam / 10));  // example
      const someValue    = outputValues.reduce((a, b) => a + b, 0) / outputValues.length;
      // ─────────────────────────────────────────────────────────

      return {
        result: {
          outputValues,
          dates: rows.map(r => r.date),
        },
        stats: {
          someValue: Math.round(someValue),   // shown in stats panel
          // Add more key-value pairs — they auto-appear as stat cards
        },
        metadata: {},   // extra data for render() if needed
      };
    },

    // ── render(chartManager, data, runResult, params) ────────────
    // Updates charts using ChartManager API only.
    // Called automatically after run() completes.
    //
    render(chartManager, data, runResult, params) {
      const { result } = runResult;
      const rows = data.adRows || data.tsfRows || [];

      if (!result || rows.length === 0) {
        chartManager.clearAll();
        return;
      }

      const dateLabels  = result.dates.map(d =>
        d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
      );
      const rawValues   = rows.map(r => r.energy ?? 0);

      // ── Main chart ──────────────────────────────────────────────
      chartManager.clear('main');
      chartManager.setXLabels(dateLabels, 'main');

      // Raw data series (slot 0)
      chartManager.setDataset('main', 0, {
        label:       '实际产能 (kWh)',
        data:        rawValues,
        color:       'rgba(29, 29, 31, 0.7)',
        borderWidth: 1.5,
        tension:     0.2,
        pointRadius: 0,
        unit:        'kWh',
        order:       2,
      });

      // Algorithm output (slot 1)
      chartManager.setDataset('main', 1, {
        label:       '算法输出',
        data:        result.outputValues,
        color:       '#007AFF',
        borderWidth: 2,
        tension:     0.3,
        pointRadius: 0,
        unit:        'kWh',
        order:       1,
      });

      chartManager.setYAxis('main', { title: '日产能 (kWh)' });
      chartManager.commit('main');

      // ── Secondary chart (optional) ──────────────────────────────
      chartManager.clear('secondary');
      chartManager.setXLabels(dateLabels, 'secondary');
      // Add secondary datasets here or leave clear for an empty secondary chart
      chartManager.commit('secondary');

      // Update HTML legend
      _updateLegend();
    },
  };

  // ─────────────────────────────────────────────────────────────
  // 2. UPDATE HTML LEGEND (optional — matches your datasets)
  // ─────────────────────────────────────────────────────────────
  function _updateLegend() {
    const el = document.getElementById('chart-legend');
    if (!el) return;
    el.innerHTML = `
      <div class="legend-item">
        <div class="legend-swatch" style="background: rgba(29,29,31,0.7)"></div>
        <span>实际产能</span>
      </div>
      <div class="legend-item">
        <div class="legend-swatch" style="background: #007AFF"></div>
        <span>算法输出</span>
      </div>
    `;
  }

  // ─────────────────────────────────────────────────────────────
  // 3. SELF-REGISTER — do not change this block
  // ─────────────────────────────────────────────────────────────
  window.MLViz = window.MLViz || {};
  window.MLViz.algorithms = window.MLViz.algorithms || {};
  window.MLViz.algorithms[algorithm.id] = algorithm;

})();
