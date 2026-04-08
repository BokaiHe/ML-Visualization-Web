/**
 * chart.js — ChartManager
 *
 * Owns both Chart.js instances (main chart + secondary chart).
 * Algorithm render() functions use only this API — never touch Chart.js directly.
 * This decouples algorithm code from Chart.js internals.
 *
 * API:
 *   ChartManager.init(mainCanvasId, secondaryCanvasId)
 *   ChartManager.setDataset(chartKey, index, config)
 *   ChartManager.commit(chartKey)
 *   ChartManager.setXLabels(labels, chartKey)
 *   ChartManager.clear(chartKey)
 *   ChartManager.clearAll()
 *   ChartManager.addPlugin(chartKey, plugin)  — for incident bands etc.
 */
(function () {
  'use strict';

  window.MLViz = window.MLViz || {};

  // ── Shared Chart.js defaults ───────────────────────────────────────────────
  function applyGlobalDefaults() {
    const style = getComputedStyle(document.documentElement);
    const fontBody = style.getPropertyValue('--font-body').trim() ||
      "'SF Pro Text', 'Helvetica Neue', -apple-system, sans-serif";

    Chart.defaults.font.family = fontBody;
    Chart.defaults.font.size   = 12;
    Chart.defaults.color       = '#6E6E73';   // --color-text-secondary

    // Remove default border on all elements
    Chart.defaults.elements.point.borderWidth  = 0;
    Chart.defaults.elements.line.borderCapStyle = 'round';
    Chart.defaults.elements.line.borderJoinStyle = 'round';
  }

  // ── Internal state ─────────────────────────────────────────────────────────
  const _charts   = {};   // { main: ChartInstance, secondary: ChartInstance }
  const _pending  = { main: new Map(), secondary: new Map() };
  const _labels   = { main: [], secondary: [] };
  const _overlays = { main: [], secondary: [] };  // custom draw callbacks

  // ── Factory ────────────────────────────────────────────────────────────────
  function _createChart(canvasId, isSecondary) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const ctx = canvas.getContext('2d');

    return new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        animation: { duration: isSecondary ? 200 : 400, easing: 'easeInOutQuart' },
        interaction: { mode: 'index', intersect: false },

        plugins: {
          legend: { display: false },   // we build custom legend
          ...(isSecondary ? {} : {
            zoom: {
              pan:  { enabled: true, mode: 'x' },
              zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
            },
          }),
          tooltip: {
            backgroundColor:  'rgba(255,255,255,0.94)',
            titleColor:       '#1D1D1F',
            bodyColor:        '#6E6E73',
            borderColor:      'rgba(0,0,0,0.08)',
            borderWidth:      1,
            padding:          12,
            cornerRadius:     10,
            boxPadding:       4,
            usePointStyle:    true,
            callbacks: {
              label: function (ctx) {
                const val = ctx.parsed.y;
                if (val === null || val === undefined) return null;
                const unit = ctx.dataset.unit || '';
                return ` ${ctx.dataset.label}: ${Number(val).toLocaleString('en-US', {
                  maximumFractionDigits: 2
                })}${unit ? ' ' + unit : ''}`;
              }
            }
          }
        },

        scales: {
          x: {
            grid:   { color: 'rgba(0,0,0,0.04)', drawBorder: false },
            ticks:  {
              maxTicksLimit:  isSecondary ? 6 : 12,
              maxRotation:    0,
              font:           { size: 11 },
              color:          '#98989D',
            },
            border: { display: false },
          },
          y: {
            grid:   { color: 'rgba(0,0,0,0.04)', drawBorder: false },
            ticks:  {
              font:   { size: 11 },
              color:  '#98989D',
              callback: (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v,
            },
            border: { display: false },
          }
        }
      },

      plugins: [{
        // Custom overlay drawing plugin (for incident bands, boundary lines)
        id: 'mlviz-overlay',
        afterDraw(chart) {
          const key = chart === _charts.main ? 'main' : 'secondary';
          _overlays[key].forEach(fn => {
            try { fn(chart); } catch (e) { /* ignore */ }
          });
        }
      }]
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Initialize both chart instances.
   * Must be called once after DOM is ready.
   */
  function init(mainCanvasId, secondaryCanvasId) {
    applyGlobalDefaults();
    _charts.main      = _createChart(mainCanvasId,      false);
    _charts.secondary = _createChart(secondaryCanvasId, true);
  }

  /**
   * Stage a dataset for later commit.
   * @param {string} chartKey  'main' | 'secondary'
   * @param {number} index     Dataset slot index (0 = raw data, 1 = result, etc.)
   * @param {object} config    { label, data, color, pointRadius, tension, spanGaps,
   *                             fill, borderDash, backgroundColor, unit, showInTooltip }
   */
  function setDataset(chartKey, index, config) {
    _pending[chartKey].set(index, config);
  }

  /**
   * Apply all staged datasets and update the chart.
   * @param {string} chartKey  'main' | 'secondary'
   * @param {string} [mode]    Chart.js update mode ('active' | 'none' | 'reset')
   */
  function commit(chartKey, mode) {
    const chart = _charts[chartKey];
    if (!chart) return;

    const updateMode = mode || 'active';

    // Rebuild dataset array from pending map
    const maxIdx = Math.max(..._pending[chartKey].keys(), -1);
    const datasets = [];

    for (let i = 0; i <= maxIdx; i++) {
      const cfg = _pending[chartKey].get(i);
      if (!cfg) continue;

      const ds = {
        label:            cfg.label || '',
        data:             cfg.data  || [],
        borderColor:      cfg.color || '#007AFF',
        backgroundColor:  cfg.backgroundColor || 'transparent',
        borderWidth:      cfg.borderWidth ?? 2,
        pointRadius:      cfg.pointRadius ?? 0,
        pointHoverRadius: cfg.pointHoverRadius ?? (cfg.pointRadius || 0) + 2,
        tension:          cfg.tension ?? 0.3,
        spanGaps:         cfg.spanGaps ?? false,
        fill:             cfg.fill !== undefined ? cfg.fill : false,
        borderDash:       cfg.borderDash || [],
        segment:          cfg.segment,
        unit:             cfg.unit || '',
        order:            cfg.order ?? i,
        showLine:         cfg.showLine !== undefined ? cfg.showLine : true,
      };

      // Line chart with showLine:false = scatter-style (no type override needed)
      if (cfg.showLine === false) {
        ds.showLine    = false;
        ds.pointRadius = cfg.pointRadius ?? 5;
        ds.borderWidth = 0;
      }

      // Explicit scatter type
      if (cfg.type === 'scatter') {
        ds.type        = 'scatter';
        ds.data        = cfg.data;
        ds.pointRadius = cfg.pointRadius ?? 5;
      }

      if (cfg.type === 'bar') {
        ds.type         = 'bar';
        ds.borderWidth  = cfg.borderWidth ?? 0;
        ds.borderRadius = cfg.borderRadius ?? 2;
        // Use pre-computed color arrays if provided, otherwise auto-color by sign
        ds.backgroundColor = Array.isArray(cfg.backgroundColor)
          ? cfg.backgroundColor
          : cfg.data.map(v => v >= 0 ? 'rgba(0,122,255,0.65)' : 'rgba(255,59,48,0.65)');
        ds.borderColor = Array.isArray(cfg.borderColor)
          ? cfg.borderColor
          : cfg.data.map(v => v >= 0 ? 'rgba(0,122,255,0.9)' : 'rgba(255,59,48,0.9)');
      }

      datasets.push(ds);
    }

    // Apply x-axis labels
    if (_labels[chartKey].length > 0) {
      chart.data.labels = _labels[chartKey];
    }

    chart.data.datasets = datasets;
    chart.update(updateMode);

    _pending[chartKey].clear();
  }

  /**
   * Set x-axis tick labels.
   * @param {string[]} labels
   * @param {string} [chartKey]  defaults to 'main'
   */
  function setXLabels(labels, chartKey) {
    const key = chartKey || 'main';
    _labels[key] = labels;
  }

  /**
   * Clear all datasets from a chart (no animation).
   * @param {string} chartKey
   */
  function clear(chartKey) {
    const chart = _charts[chartKey];
    if (!chart) return;
    chart.data.datasets = [];
    chart.data.labels   = [];
    // Reset y-axis constraints so they don't bleed between algorithm switches
    delete chart.options.scales.y.min;
    delete chart.options.scales.y.max;
    delete chart.options.scales.y.title;
    // Reset zoom state (main chart only — secondary has no zoom configured)
    if (chartKey === 'main' && chart.resetZoom) chart.resetZoom();
    chart.update('none');
    _pending[chartKey].clear();
    _labels[chartKey]   = [];
    _overlays[chartKey] = [];
    // Remove any algorithm-specific controls injected into the chart header
    if (chartKey === 'main') {
      document.querySelectorAll('.chart-algo-controls').forEach(el => el.remove());
    }
  }

  /** Clear both charts. */
  function clearAll() {
    clear('main');
    clear('secondary');
  }

  /**
   * Register a custom canvas draw callback (for incident bands, boundary lines).
   * The callback receives the Chart instance as its argument.
   * @param {string}   chartKey
   * @param {Function} drawFn  (chart) => void
   */
  function addOverlay(chartKey, drawFn) {
    _overlays[chartKey].push(drawFn);
  }

  /**
   * Update y-axis options dynamically.
   * @param {string} chartKey
   * @param {object} options   e.g. { min, max, title }
   */
  function setYAxis(chartKey, options) {
    const chart = _charts[chartKey];
    if (!chart) return;
    if (options.min !== undefined) chart.options.scales.y.min = options.min;
    if (options.max !== undefined) chart.options.scales.y.max = options.max;
    if (options.title) {
      chart.options.scales.y.title = { display: true, text: options.title,
        font: { size: 11 }, color: '#98989D' };
    }
  }

  /**
   * Get the chart instance (for advanced use by overlays).
   * @param {string} chartKey
   * @returns {Chart|null}
   */
  function getInstance(chartKey) {
    return _charts[chartKey] || null;
  }

  /**
   * Reset zoom/pan to the full data range.
   * @param {string} chartKey
   */
  function resetZoom(chartKey) {
    const chart = _charts[chartKey];
    if (chart && chart.resetZoom) chart.resetZoom();
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  window.MLViz.ChartManager = {
    init,
    setDataset,
    commit,
    setXLabels,
    clear,
    clearAll,
    addOverlay,
    setYAxis,
    getInstance,
    resetZoom,
  };

})();
