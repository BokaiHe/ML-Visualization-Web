/**
 * app.js — Central Controller (loads last)
 *
 * Orchestrates: data loading → algorithm switching → run → render.
 * All user interactions (file upload, tab click, slider move, run button)
 * eventually call _runAndRender() — the single pipeline entry point.
 *
 * Reads from window.MLViz.algorithms (auto-populated by algorithm files).
 * Uses window.MLViz.DataManager, ChartManager, UIManager.
 */
(function () {
  'use strict';

  const { algorithms, ChartManager, DataManager, UIManager } = window.MLViz;

  // ── State ──────────────────────────────────────────────────────────────────
  let _activeId    = null;   // currently active algorithm id
  let _params      = {};     // { [paramId]: value }
  let _running     = false;  // debounce guard

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    // Init charts
    ChartManager.init('chart-main', 'chart-secondary');

    // Build nav tabs from registered algorithms
    _buildTabs();

    // Wire file upload
    _wireUpload();

    // Wire run button / keyboard shortcut
    document.addEventListener('mlviz:run', _onRunRequest);

    // Load demo data immediately so the page isn't empty on open
    DataManager.loadDemo();
    DataManager.onChange(_onDataChange);

    // Activate first algorithm
    const firstId = Object.keys(algorithms)[0];
    if (firstId) _activateAlgorithm(firstId);
  }

  // ── Tab builder ────────────────────────────────────────────────────────────

  function _buildTabs() {
    const container = document.getElementById('algo-tabs');
    if (!container) return;
    container.innerHTML = '';

    Object.values(algorithms).forEach(algo => {
      const btn = document.createElement('button');
      btn.className       = 'tab';
      btn.dataset.algoId  = algo.id;
      btn.setAttribute('role', 'tab');

      // Difficulty badge
      const badge = document.createElement('span');
      badge.className = `tab-difficulty tab-difficulty--${algo.difficulty.toLowerCase()}`;
      badge.textContent = algo.difficulty;

      btn.appendChild(badge);
      btn.appendChild(document.createTextNode(' ' + algo.name));

      btn.addEventListener('click', () => _activateAlgorithm(algo.id));
      container.appendChild(btn);
    });
  }

  // ── Algorithm switching ────────────────────────────────────────────────────

  function _activateAlgorithm(id) {
    if (!algorithms[id]) return;
    _activeId = id;
    const algo = algorithms[id];

    // Reset params to defaults
    _params = {};
    algo.params.forEach(p => { _params[p.id] = p.default; });

    // Update tab active state
    document.querySelectorAll('.tab').forEach(btn => {
      btn.classList.toggle('tab--active', btn.dataset.algoId === id);
    });

    // Rebuild sidebar and explanation
    UIManager.buildControls(algo, _params, _onParamChange);
    UIManager.buildExplanation(algo);
    UIManager.updateChartTitles(algo);
    UIManager.updateStatus('Ready — click Run Analysis', 'idle');

    // Clear charts then run
    ChartManager.clearAll();

    if (DataManager.isLoaded()) {
      _runAndRender();
    }
  }

  // ── Param change handler ────────────────────────────────────────────────────

  function _onParamChange(paramId, newValue, silent) {
    _params[paramId] = newValue;
    // Silent = called from reset, let app run manually.
    // Non-silent = slider drag, do NOT auto-run (wait for run button).
    // For a smoother UX, we auto-run on slider changes with a small debounce.
    if (!silent) {
      _debouncedRun();
    }
  }

  // Debounce: wait 300ms after last slider move before running
  let _debounceTimer = null;
  function _debouncedRun() {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(_runAndRender, 300);
  }

  function _onRunRequest() {
    clearTimeout(_debounceTimer);
    _runAndRender();
  }

  // ── Data change handler ─────────────────────────────────────────────────────

  function _onDataChange() {
    if (_activeId) _runAndRender();
  }

  // ── Core pipeline ──────────────────────────────────────────────────────────

  async function _runAndRender() {
    if (!_activeId || _running) return;
    const algo = algorithms[_activeId];
    if (!algo) return;

    _running = true;
    UIManager.updateStatus('Running…', 'running');

    // Yield so the status update paints before heavy computation / async load
    await new Promise(r => requestAnimationFrame(r));

    try {
      // Route data to the correct dataset based on algorithm's dataSource
      const data = _getDataForAlgorithm(algo);

      // Support both synchronous and async run() (e.g. ONNX inference)
      const runResult = await Promise.resolve(algo.run(data, { ..._params }));

      // Chart update
      algo.render(ChartManager, data, runResult, { ..._params });

      // Stats + status
      UIManager.updateStats(runResult.stats, algo);
      UIManager.updateStatus(algo.statusLabel(runResult), 'done');

    } catch (err) {
      console.error('Algorithm error:', err);
      UIManager.updateStatus('Error: ' + err.message, 'error');
    } finally {
      _running = false;
    }
  }

  /**
   * Routes data to the correct DataManager getter based on algorithm.dataSource.
   * Each algorithm declares which dataset it needs via the `dataSource` property:
   *   'ad'  → Anomaly Detection sheet + Incidents log
   *   'tsf' → Time Series Forecasting sheet
   *   (algorithms can declare custom sources for future use)
   */
  function _getDataForAlgorithm(algo) {
    const source = algo.dataSource || 'ad';

    if (source === 'ad') {
      return {
        adRows:    DataManager.getADData(),
        incidents: DataManager.getIncidents(),
      };
    }

    if (source === 'tsf') {
      return {
        tsfRows:   DataManager.getTSFData(),
        incidents: DataManager.getIncidents(),
      };
    }

    // Future: custom data sources
    if (typeof algo.getData === 'function') {
      return algo.getData(DataManager);
    }

    return {};
  }

  // ── File upload ────────────────────────────────────────────────────────────

  function _wireUpload() {
    const zone       = document.getElementById('upload-zone');
    const fileInput  = document.getElementById('file-input');
    const uploadBtn  = document.getElementById('upload-btn');
    const reuploadBtn = document.getElementById('reupload-btn');
    const uploadContent = document.getElementById('upload-content');
    const uploadSuccess = document.getElementById('upload-success');
    const filenameEl = document.getElementById('upload-filename');

    if (!zone) return;

    // Click to open file picker
    uploadBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput?.click();
    });

    reuploadBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput?.click();
    });

    zone.addEventListener('click', () => fileInput?.click());

    // File selected
    fileInput?.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) _handleFile(file);
    });

    // Drag and drop
    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) _handleFile(file);
    });

    function _handleFile(file) {
      if (!file.name.match(/\.xlsx?$/i)) {
        UIManager.updateStatus('Please upload an .xlsx Excel file', 'error');
        return;
      }

      UIManager.updateStatus('Parsing data…', 'running');

      DataManager.loadExcel(file)
        .then(meta => {
          // Show success state
          if (uploadContent) uploadContent.hidden = true;
          if (uploadSuccess) uploadSuccess.hidden = false;
          if (filenameEl)   filenameEl.textContent = file.name;

          UIManager.updateStatus(
            `Loaded ${meta.adRows} rows · ${meta.incidents} incidents`, 'done'
          );
          // _onDataChange will be called via DataManager.onChange
        })
        .catch(err => {
          UIManager.updateStatus('Parse failed: ' + err.message, 'error');
          console.error('Excel parse error:', err);
        });

      // Reset file input so same file can be re-uploaded
      fileInput.value = '';
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

})();
