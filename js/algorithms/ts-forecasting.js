/**
 * ts-forecasting.js — LightGBM Forecasting Module
 *
 * Runs the trained LightGBM model in the browser via onnxruntime-web (ONNX format).
 *
 * Two modes:
 *   Demo mode   — rows[0]._isDemo is true → loads pre-computed Python results from
 *                 lightgbm_demo.json (real LightGBM predictions on the real dataset)
 *   Real data   — user uploaded Excel → computes features in JS → runs ONNX inference
 *                 with the exact same feature engineering as the Python training script
 *
 * Feature order MUST match Python FEATURE_COLS exactly:
 *   pro_forma | meas_insolation | exp_insolation |
 *   month | day_of_year | day_of_week | quarter |
 *   lag_1 | lag_7 | rolling_mean_7 | rolling_mean_30
 *
 * Self-registers to window.MLViz.algorithms on load.
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // ONNX SESSION CACHE
  // ═══════════════════════════════════════════════════════════════

  let _ortSession = null;
  let _ortPromise = null;

  async function _getSession() {
    if (_ortSession) return _ortSession;
    if (_ortPromise) return _ortPromise;
    _ortPromise = ort.InferenceSession.create('./lightgbm_model.onnx', {
      executionProviders: ['wasm'],
    }).then(s => { _ortSession = s; return s; });
    return _ortPromise;
  }

  // ═══════════════════════════════════════════════════════════════
  // DEMO DATA CACHE (pre-computed Python LightGBM results)
  // ═══════════════════════════════════════════════════════════════

  let _demoData    = null;
  let _demoPromise = null;

  async function _getDemoData() {
    if (_demoData) return _demoData;
    if (_demoPromise) return _demoPromise;
    _demoPromise = fetch('./js/lightgbm_demo.json')
      .then(r => { if (!r.ok) throw new Error('lightgbm_demo.json not found'); return r.json(); })
      .then(d => { _demoData = d; return d; });
    return _demoPromise;
  }

  // ═══════════════════════════════════════════════════════════════
  // FEATURE ENGINEERING  (must match Python training script exactly)
  // ═══════════════════════════════════════════════════════════════

  // day_of_year: 1 for Jan 1  →  matches Python dt.dayofyear
  function _dayOfYear(d) {
    return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  }

  // rolling mean of arr[i-window .. i-1]  →  matches Python energy.shift(1).rolling(window)
  function _rollingMean(arr, window) {
    return arr.map((_, i) => {
      if (i < window) return null;
      const slice = arr.slice(i - window, i);
      const valid = slice.filter(v => v !== null && !isNaN(v));
      return valid.length === window ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
    });
  }

  function _computeFeatures(rows) {
    const energy = rows.map(r => r.energy);

    const lag1  = energy.map((_, i) => i >= 1 ? energy[i - 1] : null);
    const lag7  = energy.map((_, i) => i >= 7 ? energy[i - 7] : null);
    const roll7  = _rollingMean(energy, 7);
    const roll30 = _rollingMean(energy, 30);

    return rows.map((r, i) => {
      const d     = r.date;
      const month = d.getMonth() + 1;       // 1-12   (Python: dt.month)
      const doy   = _dayOfYear(d);          // 1-366  (Python: dt.dayofyear)
      const dow   = (d.getDay() + 6) % 7;  // 0=Mon  (Python: dt.dayofweek)
      const qtr   = Math.ceil(month / 3);   // 1-4    (Python: dt.quarter)

      return [
        r.proForma           ?? 0,    // pro_forma
        r.measuredInsolation ?? 0,    // meas_insolation
        r.expectedInsolation ?? 0,    // exp_insolation
        month, doy, dow, qtr,
        lag1[i],   lag7[i],           // lag_1, lag_7
        roll7[i],  roll30[i],         // rolling_mean_7, rolling_mean_30
      ];
    });
  }

  // Replace null/NaN with training medians  →  matches Python: fillna(median)
  function _imputeFeatures(features, medians) {
    return features.map(row =>
      row.map((v, j) => (v === null || v !== v) ? medians[j] : v)
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // STATS HELPERS
  // ═══════════════════════════════════════════════════════════════

  function _mean(arr) {
    return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function rmse(actual, predicted) {
    if (actual.length === 0) return 0;
    return Math.sqrt(actual.reduce((s, a, i) => s + (a - predicted[i]) ** 2, 0) / actual.length);
  }

  function mae(actual, predicted) {
    if (actual.length === 0) return 0;
    return actual.reduce((s, a, i) => s + Math.abs(a - predicted[i]), 0) / actual.length;
  }

  function r2(actual, predicted) {
    const mean  = _mean(actual);
    const ssTot = actual.reduce((s, a) => s + (a - mean) ** 2, 0);
    const ssRes = actual.reduce((s, a, i) => s + (a - predicted[i]) ** 2, 0);
    return ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  }

  // ═══════════════════════════════════════════════════════════════
  // HISTOGRAM BUILDER (residuals distribution chart)
  // ═══════════════════════════════════════════════════════════════

  function _buildHistogram(values, numBins) {
    if (values.length === 0) return { labels: [], counts: [], colors: [] };

    const min   = Math.min(...values);
    const max   = Math.max(...values);
    const range = max - min || 1;
    const binW  = range / numBins;

    const counts = new Array(numBins).fill(0);
    for (const v of values) {
      const idx = Math.min(Math.floor((v - min) / binW), numBins - 1);
      counts[idx]++;
    }

    const labels = counts.map((_, i) => {
      const lo  = min + i * binW;
      const hi  = lo + binW;
      const mid = Math.round((lo + hi) / 2 / 100) * 100;
      return mid >= 0 ? `+${mid}` : `${mid}`;
    });

    const zeroBin = Math.floor((0 - min) / binW);
    const colors  = counts.map((_, i) =>
      i < zeroBin
        ? 'rgba(255, 59, 48, 0.65)'    // negative residual (model over-predicted)
        : 'rgba(0, 122, 255, 0.65)'    // positive residual (model under-predicted)
    );

    return { labels, counts, colors };
  }

  // ═══════════════════════════════════════════════════════════════
  // CHART OVERLAY — forecast boundary vertical line
  // ═══════════════════════════════════════════════════════════════

  function drawForecastBoundary(chart, boundaryIdx) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.x) return;

    const x = scales.x.getPixelForValue(boundaryIdx);
    if (!x || x < chartArea.left || x > chartArea.right) return;

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(110, 110, 115, 0.55)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.font      = '11px var(--font-body, sans-serif)';
    ctx.fillStyle = 'rgba(110, 110, 115, 0.8)';
    ctx.textAlign = 'left';
    ctx.fillText('Forecast Start', x + 4, chartArea.top + 16);
    ctx.restore();
  }

  // ═══════════════════════════════════════════════════════════════
  // RUN — DEMO MODE (pre-computed Python LightGBM results)
  // ═══════════════════════════════════════════════════════════════

  async function _runDemo(rows, ciLevel) {
    const demo = await _getDemoData();

    const boundaryIdx    = demo.boundaryIdx;
    const trainResiduals = demo.residuals.filter(v => v !== null);

    // Residual standard deviation for confidence band
    const resStd = Math.sqrt(
      trainResiduals.reduce((s, r) => s + r * r, 0) / trainResiduals.length
    );

    // Rebuild CI bands with the user-selected ciLevel
    const upperBand = demo.forecastPredicted.map(v =>
      v !== null ? v + ciLevel * resStd : null
    );
    const lowerBand = demo.forecastPredicted.map(v =>
      v !== null ? Math.max(0, v - ciLevel * resStd) : null
    );

    const residHist = _buildHistogram(trainResiduals, 25);

    return {
      result: {
        rows,
        actualValues: demo.actual,           // real historical data from Python run
        trainLine:    demo.trainPredicted,
        forecastLine: demo.forecastPredicted,
        upperBand,
        lowerBand,
        residuals:    trainResiduals,
        residHist,
        trainIdx:     null,
        boundaryIdx,
      },
      stats: {
        trainR2:      Number(demo.stats.trainR2).toFixed(3),
        trainRMSE:    Math.round(demo.stats.trainRMSE) + ' kWh',
        trainMAE:     Math.round(demo.stats.trainMAE)  + ' kWh',
        forecastDays: demo.stats.forecastDays,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // RUN — ONNX INFERENCE (real uploaded Excel data)
  // ═══════════════════════════════════════════════════════════════

  async function _runONNX(rows, ciLevel) {
    // Load ONNX session + demo data in parallel (demo needed for feature medians)
    const [session, demo] = await Promise.all([_getSession(), _getDemoData()]);

    // Compute feature matrix
    let features = _computeFeatures(rows);

    // Impute NaN features with training medians from Python run
    const medians = demo.featureCols.map(col => demo.featureMedians[col]);
    features = _imputeFeatures(features, medians);

    // Pack into Float32 tensor  [numRows × numFeats]
    const numRows  = features.length;
    const numFeats = features[0].length;
    const inputData = new Float32Array(numRows * numFeats);
    for (let i = 0; i < numRows; i++) {
      for (let j = 0; j < numFeats; j++) {
        inputData[i * numFeats + j] = features[i][j];
      }
    }

    const tensor  = new ort.Tensor('float32', inputData, [numRows, numFeats]);
    const outputs = await session.run({ 'float_input': tensor });
    const allPred = Array.from(outputs['variable'].data);

    // Split training rows (known energy) vs forecast rows (energy = null)
    const trainIdx    = [];
    const forecastIdx = [];
    rows.forEach((r, i) => {
      if (r.energy !== null && r.energy !== undefined) trainIdx.push(i);
      else forecastIdx.push(i);
    });

    const boundaryIdx  = forecastIdx[0] ?? trainIdx[trainIdx.length - 1] + 1;
    const trainActual  = trainIdx.map(i => rows[i].energy);
    const trainPreds   = trainIdx.map(i => allPred[i]);
    const residuals    = trainPreds.map((p, pi) => p - trainActual[pi]);

    const resStd = Math.sqrt(
      residuals.reduce((s, r) => s + r * r, 0) / residuals.length
    );

    const trainLine    = new Array(numRows).fill(null);
    const forecastLine = new Array(numRows).fill(null);
    const upperBand    = new Array(numRows).fill(null);
    const lowerBand    = new Array(numRows).fill(null);

    trainIdx.forEach((ri, pi) => { trainLine[ri] = trainPreds[pi]; });
    forecastIdx.forEach(ri => {
      const p = Math.max(0, allPred[ri]);
      forecastLine[ri] = p;
      upperBand[ri]    = p + ciLevel * resStd;
      lowerBand[ri]    = Math.max(0, p - ciLevel * resStd);
    });

    const residHist = _buildHistogram(residuals, 25);

    return {
      result: {
        rows,
        trainLine, forecastLine, upperBand, lowerBand,
        residuals, residHist, trainIdx, boundaryIdx,
      },
      stats: {
        trainR2:      r2(trainActual, trainPreds).toFixed(3),
        trainRMSE:    Math.round(rmse(trainActual, trainPreds)) + ' kWh',
        trainMAE:     Math.round(mae(trainActual, trainPreds))  + ' kWh',
        forecastDays: forecastIdx.length,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ALGORITHM MODULE
  // ═══════════════════════════════════════════════════════════════

  const algorithm = {

    id:         'ts-forecasting',
    name:       'LightGBM',
    difficulty: 'Advanced',

    description: `LightGBM is a gradient boosting framework developed by Microsoft that builds an ensemble of decision trees to learn complex patterns. This page runs the actual trained LightGBM model in your browser via WebAssembly (ONNX Runtime). Features used: expected output (pro_forma), solar irradiance, lag-1/7-day production, 7/30-day rolling averages, and seasonal date encodings. Trained on 2023–2024 data, it forecasts the 90 missing days (Jan–Mar 2025). Adjust the confidence interval slider to see how forecast uncertainty changes.`,

    statusLabel(result) {
      if (!result || !result.stats) return 'Awaiting data';
      return `Train R² = ${result.stats.trainR2} · ${result.stats.forecastDays}-day forecast`;
    },

    // Data source: 'tsf' (TSF Task sheet)
    dataSource: 'tsf',

    params: [
      {
        id:      'ciLevel',
        label:   'Confidence Interval',
        hint:    'Forecast band width: 1.0 = ±1σ (68%), 1.645 = 90%, 2.0 = 95%.',
        type:    'slider',
        min:     1.0,
        max:     2.0,
        step:    0.1,
        default: 1.645,
      },
    ],

    // ── run() — async: loads ONNX model or demo JSON, returns result ──────────
    async run(data, params) {
      const rows = data.tsfRows;
      if (!rows || rows.length === 0) {
        return {
          result: null,
          stats: { trainR2: '—', trainRMSE: '—', trainMAE: '—', forecastDays: 0 },
        };
      }

      const ciLevel = params.ciLevel ?? 1.645;

      // Demo mode: use pre-computed Python LightGBM results
      if (rows[0]._isDemo) {
        return _runDemo(rows, ciLevel);
      }

      // Real data: ONNX inference in browser
      return _runONNX(rows, ciLevel);
    },

    // ── render() — updates charts via ChartManager ────────────────────────
    render(chartManager, data, runResult, params) {
      const { result } = runResult;
      const rows = data.tsfRows;

      if (!result || !rows || rows.length === 0) {
        chartManager.clearAll();
        return;
      }

      const { trainLine, forecastLine, upperBand, lowerBand, residuals,
              residHist, trainIdx, boundaryIdx } = result;

      const dateLabels = rows.map(r =>
        r.date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
      );

      // Demo mode supplies real actual values from Python run; otherwise use row data
      const actualValues = result.actualValues || rows.map(r => r.energy);

      // ── Main chart ────────────────────────────────────────────────────────

      chartManager.clear('main');
      chartManager.setXLabels(dateLabels, 'main');

      // Dataset 0: actual values — scatter dots (no line) for clean look
      chartManager.setDataset('main', 0, {
        label:            'Actual Production (kWh)',
        data:             actualValues,
        color:            'rgba(110, 110, 115, 0.50)',
        showLine:         false,
        pointRadius:      1.8,
        pointHoverRadius: 4,
        unit:             'kWh',
        order:            3,
      });

      // Dataset 1: training fit
      chartManager.setDataset('main', 1, {
        label:       'Training Fit',
        data:        trainLine,
        color:       '#007AFF',
        borderWidth: 2,
        tension:     0.3,
        pointRadius: 0,
        spanGaps:    false,
        unit:        'kWh',
        order:       2,
      });

      // Dataset 2: forecast line (dashed)
      chartManager.setDataset('main', 2, {
        label:       '90-Day Forecast',
        data:        forecastLine,
        color:       '#007AFF',
        borderWidth: 2,
        borderDash:  [6, 4],
        tension:     0.3,
        pointRadius: 0,
        spanGaps:    false,
        unit:        'kWh',
        order:       2,
      });

      // Dataset 3: confidence band upper (fill to lower)
      chartManager.setDataset('main', 3, {
        label:           'Confidence Interval',
        data:            upperBand,
        color:           'rgba(0, 122, 255, 0)',
        borderWidth:     0,
        backgroundColor: 'rgba(0, 122, 255, 0.13)',
        fill:            '+1',
        tension:         0.3,
        pointRadius:     0,
        spanGaps:        false,
        order:           4,
      });

      // Dataset 4: confidence band lower
      chartManager.setDataset('main', 4, {
        label:           '',
        data:            lowerBand,
        color:           'rgba(0, 122, 255, 0)',
        borderWidth:     0,
        backgroundColor: 'rgba(0, 122, 255, 0.13)',
        fill:            false,
        tension:         0.3,
        pointRadius:     0,
        spanGaps:        false,
        order:           4,
      });

      chartManager.addOverlay('main', (chart) => {
        drawForecastBoundary(chart, boundaryIdx);
      });

      chartManager.setYAxis('main', { title: 'Daily Production (kWh)' });
      chartManager.commit('main');

      _injectZoomControls(chartManager, boundaryIdx, rows.length);

      // ── Secondary chart: residuals histogram ──────────────────────────────

      chartManager.clear('secondary');

      const { labels: histLabels, counts: histCounts, colors: histColors } = residHist;
      chartManager.setXLabels(histLabels, 'secondary');

      chartManager.setDataset('secondary', 0, {
        label:           'Residual Distribution',
        data:            histCounts,
        type:            'bar',
        backgroundColor: histColors,
        borderColor:     histColors.map(c => c.replace('0.65', '0.9')),
        borderWidth:     0,
        borderRadius:    3,
        unit:            'days',
        order:           1,
      });

      chartManager.setYAxis('secondary', { title: 'Count (days)' });
      chartManager.commit('secondary');

      _updateLegend(chartManager);
    },
  };

  // ── Legend (clickable — toggles dataset visibility) ───────────────────────
  function _updateLegend(chartManager) {
    const legendEl = document.getElementById('chart-legend');
    if (!legendEl) return;

    const chart = chartManager ? chartManager.getInstance('main') : null;

    legendEl.innerHTML = '';

    function addItem(swatchHtml, label, indices) {
      const item = document.createElement('div');
      item.className = 'legend-item';

      if (chart && indices) {
        item.style.cursor = 'pointer';
        item.title = 'Click to show / hide';
        item.addEventListener('click', () => {
          const nowVisible = chart.isDatasetVisible(indices[0]);
          indices.forEach(i => chart.setDatasetVisibility(i, !nowVisible));
          chart.update('active');
          item.style.opacity = nowVisible ? '0.4' : '1';
        });
      }

      item.innerHTML = swatchHtml + `<span>${label}</span>`;
      legendEl.appendChild(item);
    }

    addItem(
      '<div class="legend-swatch" style="background: rgba(110,110,115,0.50); border-radius:50%; width:8px; height:8px;"></div>',
      'Actual', [0]
    );
    addItem(
      '<div class="legend-swatch" style="background: #007AFF"></div>',
      'Training Fit', [1]
    );
    addItem(
      '<div class="boundary-legend"><div class="boundary-swatch"></div></div>',
      'Forecast (90 days)', [2, 3, 4]
    );
    addItem(
      '<div class="legend-swatch" style="background: rgba(0,122,255,0.22); height:8px; border-radius:2px"></div>',
      'Confidence Band', [3, 4]
    );
  }

  // ── Zoom controls (injected into chart header, cleaned up on clear) ────────
  function _injectZoomControls(chartManager, boundaryIdx, totalLen) {
    const existing = document.getElementById('tsf-zoom-controls');
    if (existing) existing.remove();

    const chartHeader = document.querySelector('#chart-card .chart-header');
    if (!chartHeader) return;

    const wrap = document.createElement('div');
    wrap.id = 'tsf-zoom-controls';
    wrap.className = 'chart-zoom-controls chart-algo-controls';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'zoom-btn zoom-btn--ghost';
    resetBtn.textContent = 'Reset View';
    resetBtn.addEventListener('click', () => chartManager.resetZoom('main'));

    const jumpBtn = document.createElement('button');
    jumpBtn.className = 'zoom-btn zoom-btn--accent';
    jumpBtn.textContent = 'Jump to Forecast ›';
    jumpBtn.addEventListener('click', () => {
      const c = chartManager.getInstance('main');
      if (c) c.zoomScale('x', { min: boundaryIdx - 20, max: totalLen - 1 }, 'active');
    });

    wrap.appendChild(resetBtn);
    wrap.appendChild(jumpBtn);
    chartHeader.appendChild(wrap);
  }

  // ── Self-register ──────────────────────────────────────────────────────────
  window.MLViz = window.MLViz || {};
  window.MLViz.algorithms = window.MLViz.algorithms || {};
  window.MLViz.algorithms[algorithm.id] = algorithm;

})();
