/**
 * data.js — DataManager
 *
 * Reads the Excel file via SheetJS (FileReader API).
 * Parses all 3 sheets into structured JS arrays.
 * Emits onChange events after successful parse.
 *
 * API:
 *   DataManager.loadExcel(file)           — parse an uploaded File object
 *   DataManager.loadDemo()                — load built-in demo data (no upload needed)
 *   DataManager.getADData()               — anomaly detection dataset
 *   DataManager.getIncidents()            — 28 incident records
 *   DataManager.getTSFData()              — forecasting dataset
 *   DataManager.isLoaded()                — boolean
 *   DataManager.onChange(fn)             — register change listener
 *   DataManager.getFilename()             — last loaded filename
 */
(function () {
  'use strict';

  window.MLViz = window.MLViz || {};

  // ── Internal state ─────────────────────────────────────────────────────────
  let _adData      = [];   // { date: Date, energy: number, proForma: number, ... }[]
  let _incidents   = [];   // { start: Date, end: Date, type: string, desc: string }[]
  let _tsfData     = [];   // { date: Date, energy: number|null, measuredInsolation: number, expectedInsolation: number }[]
  let _loaded      = false;
  let _filename    = '';
  const _listeners = [];

  // Month name → 0-indexed number
  const MONTH_MAP = {
    January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
    July: 6, August: 7, September: 8, October: 9, November: 10, December: 11
  };

  // ── Date helpers ───────────────────────────────────────────────────────────

  function _parseRowDate(row) {
    // Columns: Year, Month (name), Day
    const year  = row['Date - Year'] || row['Year']  || row[1];
    const month = row['Date - Month'] || row['Month'] || row[2];
    const day   = row['Date - Day']   || row['Day']   || row[3];

    if (!year || !month || !day) return null;

    const m = typeof month === 'string'
      ? MONTH_MAP[month.trim()]
      : (Number(month) - 1);

    return new Date(Number(year), m, Number(day));
  }

  function _parseExcelDate(val) {
    // Handles both Excel serial numbers and date strings
    if (!val) return null;
    if (val instanceof Date) return val;
    if (typeof val === 'number') {
      // Excel serial date (days since 1900-01-01, with leap year bug)
      return new Date((val - 25569) * 86400 * 1000);
    }
    const d = new Date(val);
    return isNaN(d) ? null : d;
  }

  function _toDateStr(date) {
    if (!date) return '';
    return date.toISOString().slice(0, 10);
  }

  // ── Sheet parsers ──────────────────────────────────────────────────────────

  function _parseADSheet(ws) {
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    const result = [];

    for (const row of rows) {
      const date = _parseRowDate(row);
      if (!date || isNaN(date)) continue;

      const energy    = _toNum(row['Sum of measured_energy'] ?? row['E'] ?? row[4]);
      const proForma  = _toNum(row['Sum of pro_forma']       ?? row['F'] ?? row[5]);
      const measInso  = _toNum(row['Measured Insolation [kWh/m²]'] ?? row['G'] ?? row[6]);
      const expInso   = _toNum(row['Expected Insolation [kWh/m²]'] ?? row['H'] ?? row[7]);

      if (energy === null) continue;  // skip completely empty rows

      result.push({
        date,
        dateStr:        _toDateStr(date),
        energy,
        proForma:       proForma ?? 0,
        measuredInsolation: measInso ?? 0,
        expectedInsolation: expInso ?? 0,
      });
    }

    return result.sort((a, b) => a.date - b.date);
  }

  function _parseIncidentsSheet(ws) {
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
    const result = [];

    for (const row of rows) {
      // Try multiple possible column names
      const startRaw = row['Event Start Date'] ?? row['Start Date'] ?? row['start_date'] ?? null;
      const endRaw   = row['Event End Date']   ?? row['End Date']   ?? row['end_date']   ?? null;
      const desc     = row['Primary Incident Description'] ?? row['Description'] ?? '';
      const type     = row['Primary Incident Type']        ?? row['Type']        ?? 'Unknown';

      const start = _parseExcelDate(startRaw);
      const end   = _parseExcelDate(endRaw)   || start;

      if (!start || isNaN(start)) continue;

      result.push({
        start,
        end:  end || start,
        desc: String(desc).slice(0, 80),
        type: String(type),
        startStr: _toDateStr(start),
        endStr:   _toDateStr(end || start),
      });
    }

    return result.sort((a, b) => a.start - b.start);
  }

  function _parseTSFSheet(ws) {
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    const result = [];

    for (const row of rows) {
      const date = _parseRowDate(row);
      if (!date || isNaN(date)) continue;

      // Column E — may be null for forecast rows
      const energy = _toNum(
        row['Sum of measured_energy'] ?? row['measured_energy'] ?? row['E'] ?? row[4]
      );

      // TSF sheet: Col F = Measured Insolation, Col G = Expected Insolation
      const measInso = _toNum(
        row['Measured Insolation [kWh/m²]'] ?? row['F'] ?? row[5]
      );
      const expInso  = _toNum(
        row['Expected Insolation [kWh/m²]'] ?? row['G'] ?? row[6]
      );

      result.push({
        date,
        dateStr:            _toDateStr(date),
        energy,             // null = missing (forecast rows)
        measuredInsolation: measInso ?? 0,
        expectedInsolation: expInso  ?? 0,
      });
    }

    return result.sort((a, b) => a.date - b.date);
  }

  function _toNum(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return isNaN(n) ? null : n;
  }

  // ── Sheet name resolution ──────────────────────────────────────────────────

  function _findSheet(workbook, keywords) {
    // Case-insensitive search for the best matching sheet name
    const names = workbook.SheetNames;
    for (const kw of keywords) {
      const found = names.find(n => n.toLowerCase().includes(kw.toLowerCase()));
      if (found) return found;
    }
    return names[0]; // fallback to first sheet
  }

  // ── Load from Excel ────────────────────────────────────────────────────────

  function loadExcel(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = function (e) {
        try {
          const data     = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array', cellDates: false });

          const adSheetName  = _findSheet(workbook, ['AD Task', 'Production Data', 'AD-Task']);
          const incSheetName = _findSheet(workbook, ['Incidents', 'Incident', 'Log']);
          const tsfSheetName = _findSheet(workbook, ['TSF', 'Forecast', 'TSF Task']);

          _adData    = _parseADSheet(workbook.Sheets[adSheetName]);
          _incidents = _parseIncidentsSheet(workbook.Sheets[incSheetName]);
          _tsfData   = _parseTSFSheet(workbook.Sheets[tsfSheetName]);

          // Merge proForma from AD sheet into TSF rows by date (needed for ONNX features)
          const adByDate = new Map(_adData.map(r => [r.dateStr, r.proForma]));
          _tsfData = _tsfData.map(r => ({ ...r, proForma: adByDate.get(r.dateStr) ?? 0 }));

          _loaded    = true;
          _filename  = file.name;

          if (_adData.length === 0 && _tsfData.length === 0) {
            throw new Error('No valid data rows found. Check column names match expected format.');
          }

          _notifyListeners();
          resolve({ adRows: _adData.length, incidents: _incidents.length, tsfRows: _tsfData.length });

        } catch (err) {
          _loaded = false;
          reject(err);
        }
      };

      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsArrayBuffer(file);
    });
  }

  // ── Demo data (built-in, no upload needed) ─────────────────────────────────

  function loadDemo() {
    _adData    = _generateDemoAD();
    _incidents = _generateDemoIncidents();
    _tsfData   = _generateDemoTSF();
    _loaded    = true;
    _filename  = 'Demo Data';
    _notifyListeners();
  }

  function _generateDemoAD() {
    // Simulate 821 days of solar production (2023-01-01 to 2025-03-31)
    const rows = [];
    let d = new Date(2023, 0, 1);

    const seed = _seededRng(42);

    for (let i = 0; i < 821; i++) {
      const month     = d.getMonth(); // 0-11
      const seasonal  = 4500 + 3000 * Math.sin((month - 2) * Math.PI / 6);
      const noise     = (seed() - 0.5) * 1200;

      // Inject anomalies at specific periods
      const isAnomaly = (i >= 210 && i <= 295) || (i >= 360 && i <= 365) ||
                        (i >= 490 && i <= 493) || i === 550;
      const energy = isAnomaly
        ? Math.max(0, seasonal * 0.2 + noise * 0.3)
        : Math.max(0, seasonal + noise);

      rows.push({
        date:               new Date(d),
        dateStr:            _toDateStr(d),
        energy:             Math.round(energy),
        proForma:           Math.round(seasonal * 1.05),
        measuredInsolation: Math.max(0, 5.5 + 2.5 * Math.sin((month - 2) * Math.PI / 6) + (seed() - 0.5) * 1.5),
        expectedInsolation: Math.max(0, 5.5 + 2.5 * Math.sin((month - 2) * Math.PI / 6)),
      });

      d.setDate(d.getDate() + 1);
    }
    return rows;
  }

  function _generateDemoIncidents() {
    return [
      { start: new Date(2023, 0, 13), end: new Date(2023, 0, 20), type: 'Hardware',       desc: 'Site investigation — constant production issues', startStr: '2023-01-13', endStr: '2023-01-20' },
      { start: new Date(2023, 7,  3), end: new Date(2023, 9, 25), type: 'Down',           desc: 'Compressor failure preventing tracking', startStr: '2023-08-03', endStr: '2023-10-25' },
      { start: new Date(2023, 0,  2), end: new Date(2023, 9, 30), type: 'Manufacturer',   desc: 'SunFolding bladder failure (100–150 bladders)', startStr: '2023-01-02', endStr: '2023-10-30' },
      { start: new Date(2024, 5, 10), end: new Date(2024, 5, 12), type: 'Underproduction', desc: 'Bladder maintenance', startStr: '2024-06-10', endStr: '2024-06-12' },
      { start: new Date(2024, 8, 27), end: new Date(2024, 9,  5), type: 'Down',           desc: 'No production due to Hurricane Helene', startStr: '2024-09-27', endStr: '2024-10-05' },
      { start: new Date(2024, 10,19), end: new Date(2024, 11,20), type: 'Underproduction', desc: 'Air compressor replacement', startStr: '2024-11-19', endStr: '2024-12-20' },
    ];
  }

  function _generateDemoTSF() {
    // Same date range as AD, last 90 rows (2025-01-01 to 2025-03-31) have null energy
    const rows = [];
    let d       = new Date(2023, 0, 1);
    const seed  = _seededRng(123);

    for (let i = 0; i < 821; i++) {
      const month    = d.getMonth();
      const seasonal = 4500 + 3000 * Math.sin((month - 2) * Math.PI / 6);
      const noise    = (seed() - 0.5) * 1000;
      const isFuture = d >= new Date(2025, 0, 1);

      rows.push({
        date:               new Date(d),
        dateStr:            _toDateStr(d),
        energy:             isFuture ? null : Math.round(Math.max(0, seasonal + noise)),
        proForma:           Math.round(seasonal * 1.05),   // needed for ONNX feature engineering
        measuredInsolation: Math.max(0, 5.5 + 2.5 * Math.sin((month - 2) * Math.PI / 6) + (seed() - 0.5)),
        expectedInsolation: Math.max(0, 5.5 + 2.5 * Math.sin((month - 2) * Math.PI / 6)),
        _isDemo:            true,   // signals ts-forecasting to use pre-computed JSON results
      });

      d.setDate(d.getDate() + 1);
    }
    return rows;
  }

  // Simple seeded LCG RNG (reproducible demo data)
  function _seededRng(seed) {
    let s = seed;
    return function () {
      s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
      return (s >>> 0) / 0xFFFFFFFF;
    };
  }

  // ── Listeners ──────────────────────────────────────────────────────────────

  function _notifyListeners() {
    _listeners.forEach(fn => {
      try { fn(); } catch (e) { console.error('DataManager listener error:', e); }
    });
  }

  function onChange(fn) {
    _listeners.push(fn);
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  function getADData()    { return _adData.slice(); }
  function getIncidents() { return _incidents.slice(); }
  function getTSFData()   { return _tsfData.slice(); }
  function isLoaded()     { return _loaded; }
  function getFilename()  { return _filename; }

  // ── Export ─────────────────────────────────────────────────────────────────
  window.MLViz.DataManager = {
    loadExcel,
    loadDemo,
    getADData,
    getIncidents,
    getTSFData,
    isLoaded,
    getFilename,
    onChange,
  };

})();
