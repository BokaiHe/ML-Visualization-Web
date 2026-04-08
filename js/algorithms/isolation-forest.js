/**
 * isolation-forest.js — Anomaly Detection Algorithm Module
 *
 * Implements a pure 1D Isolation Forest on solar production data.
 * Self-registers to window.MLViz.algorithms on load.
 *
 * HOW TO ADD A NEW ALGORITHM: see js/algorithms/_template.js
 */
(function () {
  'use strict';

  // ── Core Isolation Forest math ─────────────────────────────────────────────

  /**
   * Expected average path length in a BST (normalization constant).
   * @param {number} n  sample size
   * @returns {number}
   */
  function c(n) {
    if (n <= 1) return 0;
    if (n === 2) return 1;
    return 2 * (Math.log(n - 1) + 0.5772156649) - 2 * (n - 1) / n;
  }

  /**
   * Build one isolation tree by recursively splitting random subsets.
   * @param {number[]} data
   * @param {number}   maxDepth
   * @param {number}   depth
   * @returns {object}  tree node
   */
  function buildTree(data, maxDepth, depth) {
    if (depth >= maxDepth || data.length <= 1) {
      return { leaf: true, size: data.length };
    }

    const min = Math.min(...data);
    const max = Math.max(...data);

    if (min === max) {
      return { leaf: true, size: data.length };
    }

    const splitVal = min + Math.random() * (max - min);
    const left     = data.filter(x => x <= splitVal);
    const right    = data.filter(x => x >  splitVal);

    return {
      leaf:     false,
      splitVal,
      left:     buildTree(left,  maxDepth, depth + 1),
      right:    buildTree(right, maxDepth, depth + 1),
    };
  }

  /**
   * Compute path length for a single value through one tree.
   * @param {object} node
   * @param {number} x
   * @param {number} depth
   * @returns {number}
   */
  function pathLength(node, x, depth) {
    if (node.leaf) return depth + c(node.size);
    return x <= node.splitVal
      ? pathLength(node.left,  x, depth + 1)
      : pathLength(node.right, x, depth + 1);
  }

  /**
   * Compute anomaly score: 1 = very anomalous, 0 = very normal.
   * @param {number} avgPathLen
   * @param {number} n  dataset size
   * @returns {number}
   */
  function anomalyScore(avgPathLen, n) {
    const cn = c(n);
    if (cn === 0) return 0.5;
    return Math.pow(2, -avgPathLen / cn);
  }

  /**
   * Run the full Isolation Forest.
   * @param {number[]} values        1D array of production values
   * @param {number}   numTrees      number of trees
   * @param {number}   subsampleSize max samples per tree
   * @returns {number[]}  anomaly scores (same length as values)
   */
  function runIsolationForest(values, numTrees, subsampleSize) {
    const n         = values.length;
    const sampleSz  = Math.min(subsampleSize, n);
    const maxDepth  = Math.ceil(Math.log2(sampleSz));

    // Build forest
    const trees = [];
    for (let t = 0; t < numTrees; t++) {
      // Random subsample (without replacement)
      const shuffled = values.slice().sort(() => Math.random() - 0.5);
      const sample   = shuffled.slice(0, sampleSz);
      trees.push(buildTree(sample, maxDepth, 0));
    }

    // Score each point
    return values.map(x => {
      const avgLen = trees.reduce((sum, tree) => sum + pathLength(tree, x, 0), 0) / numTrees;
      return anomalyScore(avgLen, sampleSz);
    });
  }

  // ── Incident matching helper ───────────────────────────────────────────────

  /**
   * For each date, check if it falls within ±toleranceDays of any incident.
   * @param {Date[]}   dates
   * @param {object[]} incidents  { start: Date, end: Date }[]
   * @param {number}   toleranceDays
   * @returns {boolean[]}
   */
  function matchIncidents(dates, incidents, toleranceDays) {
    const tol = toleranceDays * 86400000; // ms
    return dates.map(d => incidents.some(inc => {
      const start = inc.start.getTime() - tol;
      const end   = inc.end.getTime()   + tol;
      return d.getTime() >= start && d.getTime() <= end;
    }));
  }

  // ── Chart overlay: incident bands ─────────────────────────────────────────

  function drawIncidentBands(chart, incidents, dates) {
    if (!incidents || incidents.length === 0) return;
    const { ctx, chartArea, scales } = chart;
    if (!chartArea) return;

    ctx.save();
    ctx.fillStyle   = 'rgba(255, 149, 0, 0.10)';
    ctx.strokeStyle = 'rgba(255, 149, 0, 0.30)';
    ctx.lineWidth   = 1;

    const dateMs = dates.map(d => d.getTime());
    const totalMs = dateMs[dateMs.length - 1] - dateMs[0];
    const pxPerMs = (chartArea.right - chartArea.left) / totalMs;

    incidents.forEach(inc => {
      const startX = chartArea.left + (inc.start.getTime() - dateMs[0]) * pxPerMs;
      const endX   = chartArea.left + (inc.end.getTime()   - dateMs[0]) * pxPerMs;
      const w      = Math.max(endX - startX, 2);

      ctx.fillRect(startX, chartArea.top, w, chartArea.bottom - chartArea.top);
      ctx.beginPath();
      ctx.moveTo(startX, chartArea.top);
      ctx.lineTo(startX, chartArea.bottom);
      ctx.stroke();
    });

    ctx.restore();
  }

  // ── Algorithm module ───────────────────────────────────────────────────────

  const algorithm = {

    id:         'isolation-forest',
    name:       'Isolation Forest',
    difficulty: 'Intermediate',

    description: `Isolation Forest detects anomalies by randomly "isolating" each data point through successive splits. Anomalous points are different from the rest and get isolated faster — they have shorter average path lengths through the trees. The contamination rate controls what fraction of days are flagged: higher values flag more points as anomalous.`,

    statusLabel(result) {
      if (!result) return 'Awaiting data';
      return `${result.stats.numAnomalies} anomalies detected (${(result.stats.contamination * 100).toFixed(0)}% contamination)`;
    },

    // Data source: 'ad' (Anomaly Detection sheet)
    dataSource: 'ad',

    params: [
      {
        id:      'contamination',
        label:   'Contamination Rate',
        hint:    'Expected fraction of anomalous days. 0.05 = 5% flagged as anomalies.',
        type:    'slider',
        min:     0.01,
        max:     0.30,
        step:    0.01,
        default: 0.05,
        unit:    '',
        format:  v => (v * 100).toFixed(0) + '%',
      },
      {
        id:      'numTrees',
        label:   'Number of Trees',
        hint:    'More trees give more stable scores but take slightly longer.',
        type:    'slider',
        min:     10,
        max:     150,
        step:    10,
        default: 100,
        unit:    'trees',
      },
    ],

    // ── run() — pure computation, no DOM, no chart ─────────────────────────
    run(data, params) {
      // data: { adRows, incidents }
      const rows      = data.adRows;
      const incidents = data.incidents;

      if (!rows || rows.length === 0) {
        return { result: null, stats: { numAnomalies: 0, contamination: params.contamination }, metadata: {} };
      }

      const values     = rows.map(r => r.energy);
      const dates      = rows.map(r => r.date);
      const numTrees   = Math.round(params.numTrees);
      const contamination = params.contamination;

      // Run isolation forest
      const scores = runIsolationForest(values, numTrees, 256);

      // Determine threshold from contamination rate
      const sorted    = scores.slice().sort((a, b) => b - a);
      const threshIdx = Math.floor(contamination * sorted.length);
      const threshold = sorted[threshIdx] ?? sorted[sorted.length - 1];

      // Flag anomalies
      const anomalyFlags = scores.map(s => s >= threshold);
      const numAnomalies = anomalyFlags.filter(Boolean).length;

      // Match against incident log (±5 days)
      let incidentMatchRate = null;
      if (incidents && incidents.length > 0) {
        const anomalyDates   = dates.filter((_, i) => anomalyFlags[i]);
        const incidentCover  = matchIncidents(anomalyDates, incidents, 5);
        const matched        = incidentCover.filter(Boolean).length;
        incidentMatchRate    = anomalyDates.length > 0 ? matched / anomalyDates.length : 0;
      }

      // Date range of anomalies
      const anomalyDatesList = dates.filter((_, i) => anomalyFlags[i]);
      const firstAnomaly = anomalyDatesList[0]?.toLocaleDateString('en-US') || '—';
      const lastAnomaly  = anomalyDatesList[anomalyDatesList.length - 1]?.toLocaleDateString('en-US') || '—';

      // Mean anomaly score of flagged points
      const flaggedScores = scores.filter((_, i) => anomalyFlags[i]);
      const meanScore = flaggedScores.length > 0
        ? flaggedScores.reduce((a, b) => a + b, 0) / flaggedScores.length
        : 0;

      return {
        result: {
          scores,
          anomalyFlags,
          threshold,
          dates,
          values,
        },
        stats: {
          numAnomalies,
          contamination,
          threshold:         threshold.toFixed(3),
          incidentMatchRate: incidentMatchRate !== null
            ? (incidentMatchRate * 100).toFixed(1) + '%'
            : '—',
          meanScore:         meanScore.toFixed(3),
          firstAnomaly,
          lastAnomaly,
        },
        metadata: { incidents },
      };
    },

    // ── render() — updates ChartManager, no direct DOM/Chart.js access ──────
    render(chartManager, data, runResult, params) {
      const { result, metadata } = runResult;
      const rows      = data.adRows;
      const incidents = data.incidents || [];

      if (!result || !rows || rows.length === 0) {
        chartManager.clearAll();
        return;
      }

      const { scores, anomalyFlags, dates, values } = result;
      const dateLabels = dates.map(d => {
        // Show month-year for x-axis ticks (Chart.js will thin them)
        return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      });

      // ── Main chart ────────────────────────────────────────────────────────

      chartManager.clear('main');
      chartManager.setXLabels(dateLabels, 'main');

      // Dataset 0: raw energy time series
      chartManager.setDataset('main', 0, {
        label:       'Actual Production (kWh)',
        data:        values,
        color:       'rgba(29, 29, 31, 0.7)',
        borderWidth: 1.5,
        tension:     0.2,
        pointRadius: 0,
        unit:        'kWh',
        order:       2,
      });

      // Dataset 1: anomaly scatter points (only anomalous rows)
      const anomalyData = values.map((v, i) => anomalyFlags[i] ? v : null);
      chartManager.setDataset('main', 1, {
        label:       'Anomaly',
        data:        anomalyData,
        color:       '#FF3B30',
        pointRadius: 5,
        pointHoverRadius: 7,
        borderWidth: 0,
        tension:     0,
        spanGaps:    false,
        showLine:    false,
        unit:        'kWh',
        order:       1,
      });

      // Incident band overlay
      chartManager.addOverlay('main', (chart) => {
        drawIncidentBands(chart, incidents, dates);
      });

      chartManager.setYAxis('main', { title: 'Daily Production (kWh)' });
      chartManager.commit('main');

      // ── Secondary chart: anomaly scores ───────────────────────────────────

      chartManager.clear('secondary');
      chartManager.setXLabels(dateLabels, 'secondary');

      // Color each bar: red if anomaly, blue if normal
      chartManager.setDataset('secondary', 0, {
        label:           'Anomaly Score',
        data:            scores,
        type:            'bar',
        backgroundColor: anomalyFlags.map(f => f ? 'rgba(255,59,48,0.65)' : 'rgba(0,122,255,0.45)'),
        borderColor:     anomalyFlags.map(f => f ? 'rgba(255,59,48,0.9)' : 'rgba(0,122,255,0.7)'),
        borderWidth:     0,
        borderRadius:    1,
        order:           1,
      });

      chartManager.setYAxis('secondary', { min: 0, max: 1, title: 'Anomaly Score' });
      chartManager.commit('secondary');

      // Update legend in HTML
      _updateLegend(incidents.length > 0);
    },

  };

  // ── Update HTML legend ─────────────────────────────────────────────────────
  function _updateLegend(hasIncidents) {
    const legendEl = document.getElementById('chart-legend');
    if (!legendEl) return;

    legendEl.innerHTML = `
      <div class="legend-item">
        <div class="legend-swatch" style="background: rgba(29,29,31,0.7)"></div>
        <span>Actual Production</span>
      </div>
      <div class="legend-item">
        <div class="legend-swatch" style="background: #FF3B30; border-radius: 50%; width: 8px; height: 8px;"></div>
        <span>Anomaly</span>
      </div>
      ${hasIncidents ? `
      <div class="legend-item incident-legend">
        <div class="incident-swatch"></div>
        <span>Incident Periods</span>
      </div>` : ''}
    `;
  }

  // ── Self-register ──────────────────────────────────────────────────────────
  window.MLViz = window.MLViz || {};
  window.MLViz.algorithms = window.MLViz.algorithms || {};
  window.MLViz.algorithms[algorithm.id] = algorithm;

})();
