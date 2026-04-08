/**
 * ui.js — UIManager
 *
 * Reads algorithm.params[] and dynamically builds the sidebar control panel.
 * Also manages the status chip, explanation panel, and stats grid.
 *
 * API:
 *   UIManager.buildControls(algo, currentParams, onChangeFn)
 *   UIManager.buildExplanation(algo)
 *   UIManager.updateStats(stats, algo)
 *   UIManager.updateStatus(text, state)   state: 'idle' | 'running' | 'done' | 'error'
 *   UIManager.updateChartTitles(algo)
 *   UIManager.showEmptyState(chartKey)
 */
(function () {
  'use strict';

  window.MLViz = window.MLViz || {};

  // ── Helpers ────────────────────────────────────────────────────────────────

  function el(tag, className, attrs) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (attrs) Object.assign(e, attrs);
    return e;
  }

  function q(selector) {
    return document.querySelector(selector);
  }

  // ── Slider track fill (CSS linear-gradient trick) ──────────────────────────

  function updateSliderFill(input, min, max) {
    const pct = ((input.value - min) / (max - min)) * 100;
    input.style.background =
      `linear-gradient(to right, var(--color-accent) 0%, var(--color-accent) ${pct}%, var(--color-bg-deep) ${pct}%, var(--color-bg-deep) 100%)`;
  }

  // ── buildControls ──────────────────────────────────────────────────────────

  function buildControls(algo, currentParams, onChangeFn) {
    const container = document.getElementById('controls-container');
    if (!container) return;
    container.innerHTML = '';

    // Header card
    const header = el('div', 'glass-panel controls-header anim-fade-up');
    const badge  = el('span', `difficulty-badge difficulty-badge--${algo.difficulty.toLowerCase()}`);
    badge.textContent = algo.difficulty;

    const name = el('p', 'controls-algo-name');
    name.textContent = algo.name;

    header.appendChild(badge);
    header.appendChild(name);
    container.appendChild(header);

    // One param card per parameter
    algo.params.forEach((param, i) => {
      const card = _buildParamCard(param, currentParams[param.id], onChangeFn, i);
      container.appendChild(card);
    });

    // Run button
    const runBtn = el('button', 'btn btn--run anim-fade-up');
    runBtn.id = 'run-btn';
    runBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Run Analysis
    `;
    runBtn.addEventListener('click', () => {
      // Dispatch a custom event — app.js listens for it
      document.dispatchEvent(new CustomEvent('mlviz:run'));
    });
    container.appendChild(runBtn);

    // Reset link
    const resetBtn = el('button', 'reset-link anim-fade-up');
    resetBtn.textContent = 'Reset to Defaults';
    resetBtn.addEventListener('click', () => {
      algo.params.forEach(p => {
        onChangeFn(p.id, p.default, /* silent */ true);
      });
      // Rebuild with default values
      const defaults = {};
      algo.params.forEach(p => { defaults[p.id] = p.default; });
      buildControls(algo, defaults, onChangeFn);
      document.dispatchEvent(new CustomEvent('mlviz:run'));
    });
    container.appendChild(resetBtn);
  }

  function _buildParamCard(param, currentValue, onChangeFn, animIndex) {
    const card = el('div', 'glass-panel param-card anim-fade-up');
    card.style.animationDelay = `${animIndex * 50}ms`;

    if (param.type === 'slider') {
      const displayValue = param.format
        ? param.format(currentValue)
        : `${currentValue}${param.unit ? ' ' + param.unit : ''}`;

      card.innerHTML = `
        <div class="param-header">
          <label class="param-label" for="param-${param.id}">${param.label}</label>
          <span class="param-value" id="param-val-${param.id}">${displayValue}</span>
        </div>
        ${param.hint ? `<p class="param-hint">${param.hint}</p>` : ''}
        <div class="slider-wrapper">
          <input
            type="range"
            id="param-${param.id}"
            class="slider"
            min="${param.min}"
            max="${param.max}"
            step="${param.step || 1}"
            value="${currentValue}"
          />
          <div class="slider-track-labels">
            <span>${param.min}${param.unit ? ' ' + param.unit : ''}</span>
            <span>${param.max}${param.unit ? ' ' + param.unit : ''}</span>
          </div>
        </div>
      `;

      const input    = card.querySelector(`#param-${param.id}`);
      const valLabel = card.querySelector(`#param-val-${param.id}`);

      // Initial fill
      updateSliderFill(input, param.min, param.max);

      input.addEventListener('input', e => {
        const val = parseFloat(e.target.value);
        valLabel.textContent = param.format
          ? param.format(val)
          : `${val}${param.unit ? ' ' + param.unit : ''}`;
        updateSliderFill(input, param.min, param.max);
        onChangeFn(param.id, val, /* silent */ false);
      });
    }

    if (param.type === 'select') {
      card.innerHTML = `
        <div class="param-header">
          <label class="param-label" for="param-${param.id}">${param.label}</label>
        </div>
        ${param.hint ? `<p class="param-hint">${param.hint}</p>` : ''}
        <select id="param-${param.id}" class="select-input">
          ${(param.options || []).map(opt =>
            `<option value="${opt.value}" ${opt.value == currentValue ? 'selected' : ''}>${opt.label}</option>`
          ).join('')}
        </select>
      `;
      card.querySelector('select').addEventListener('change', e => {
        onChangeFn(param.id, e.target.value, false);
      });
    }

    if (param.type === 'toggle') {
      const checked = currentValue ? 'checked' : '';
      card.innerHTML = `
        <div class="param-header" style="align-items:center">
          <label class="param-label">${param.label}</label>
          <label class="toggle-wrap">
            <input type="checkbox" id="param-${param.id}" ${checked} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>
        </div>
        ${param.hint ? `<p class="param-hint">${param.hint}</p>` : ''}
      `;
      card.querySelector('input').addEventListener('change', e => {
        onChangeFn(param.id, e.target.checked, false);
      });
    }

    return card;
  }

  // ── buildExplanation ───────────────────────────────────────────────────────

  function buildExplanation(algo) {
    const titleEl = document.getElementById('explanation-title');
    const bodyEl  = document.getElementById('explanation-body');
    if (titleEl) titleEl.textContent = algo.name;
    if (bodyEl)  bodyEl.textContent  = algo.description || '';
  }

  // ── updateStats ────────────────────────────────────────────────────────────

  // Stat display config per algorithm — maps stat key → { label, variant, suffix }
  const STAT_CONFIG = {
    'isolation-forest': {
      numAnomalies:      { label: 'Anomalies Found', variant: 'anomaly' },
      incidentMatchRate: { label: 'Incident Match',  variant: 'success' },
      threshold:         { label: 'Score Threshold', variant: 'accent'  },
      firstAnomaly:      { label: 'First Anomaly',   variant: ''        },
    },
    'ts-forecasting': {
      trainRMSE:    { label: 'Train RMSE',     variant: 'accent'  },
      trainMAE:     { label: 'Train MAE',      variant: ''        },
      trainR2:      { label: 'R² Score',       variant: 'success' },
      forecastDays: { label: 'Forecast Days',  variant: 'accent'  },
    },
  };

  function updateStats(stats, algo) {
    const grid = document.getElementById('stats-grid');
    if (!grid || !stats) return;

    grid.innerHTML = '';

    const config = algo ? STAT_CONFIG[algo.id] : null;

    Object.entries(stats).forEach(([key, val], i) => {
      if (val === undefined || val === null) return;

      const cfg     = config ? config[key] : null;
      const label   = cfg?.label  || _formatKey(key);
      const variant = cfg?.variant || '';

      const card = el('div', `glass-panel stat-card stat-card--${variant} anim-fade-up`);
      card.style.animationDelay = `${i * 40}ms`;
      card.innerHTML = `
        <span class="stat-card__label">${label}</span>
        <span class="stat-card__value">${val}</span>
      `;
      grid.appendChild(card);
    });
  }

  function _formatKey(key) {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .replace(/^\w/, c => c.toUpperCase())
      .trim();
  }

  // ── updateStatus ───────────────────────────────────────────────────────────

  function updateStatus(text, state) {
    const chip    = document.getElementById('status-chip');
    const dot     = chip?.querySelector('.status-dot');
    const textEl  = document.getElementById('status-text');

    if (textEl) textEl.textContent = text || '';
    if (dot) {
      dot.className = `status-dot status-dot--${state || 'idle'}`;
    }
  }

  // ── updateChartTitles ──────────────────────────────────────────────────────

  function updateChartTitles(algo) {
    const titleEl    = document.getElementById('chart-title');
    const subtitleEl = document.getElementById('chart-subtitle');
    const secTitle   = document.getElementById('chart-secondary-title');

    if (!algo) return;

    const titles = {
      'isolation-forest': {
        main:      'Isolation Forest — Anomaly Detection',
        sub:       'Daily solar production (orange bands = known incident periods)',
        secondary: 'Anomaly score per day (red bars exceed threshold)',
      },
      'ts-forecasting': {
        main:      'LightGBM — Solar Production Forecast',
        sub:       'Solid blue = training fit · Dashed blue = 90-day forecast',
        secondary: 'Residual distribution (predicted − actual)',
      },
    };

    const t = titles[algo.id] || {
      main: algo.name, sub: '', secondary: ''
    };

    if (titleEl)    titleEl.textContent    = t.main;
    if (subtitleEl) subtitleEl.textContent = t.sub;
    if (secTitle)   secTitle.textContent   = t.secondary;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  window.MLViz.UIManager = {
    buildControls,
    buildExplanation,
    updateStats,
    updateStatus,
    updateChartTitles,
  };

})();
