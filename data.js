/* AQUANEX Data Layer
   Supports Google Sheets polling, CSV replay, and future hardware ingestion.
   Dashboard reading shape is kept compatible:
   { timestamp, temperature, distance, waterLevel, raw }
*/
const DataManager = (() => {
    const SHEET_ID = '1rdkA1_Bq_7J7xv3-VVaDsCz9s-RfIamknqZG4J4OcbY';
    const GID = '28516179';
    const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${GID}`;
    const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

    const SENSOR_HEIGHT_CM = 200;
    const REFRESH_INTERVAL = 30000;
    const MAX_HISTORY = 200;

    let readings = [];
    let refreshTimer = null;
    let replayTimer = null;
    let replayRows = [];
    let replayIndex = 0;
    let replayActive = false;
    let isConnected = false;
    let usingFallback = false;
    let sourceMode = 'sheets';
    let listeners = [];

    function subscribe(callback) {
        listeners.push(callback);
        return () => { listeners = listeners.filter(fn => fn !== callback); };
    }

    function notify(event, data = {}) {
        listeners.forEach(fn => {
            try { fn(event, data); }
            catch (error) { console.error('[AQUANEX] Listener error:', error); }
        });
    }

    function parseCSVLine(line) {
        const values = [];
        let value = '';
        let quoted = false;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (quoted && line[i + 1] === '"') {
                    value += '"';
                    i++;
                } else {
                    quoted = !quoted;
                }
            } else if (ch === ',' && !quoted) {
                values.push(value.trim());
                value = '';
            } else {
                value += ch;
            }
        }
        values.push(value.trim());
        return values;
    }

    function parseCSV(csvText) {
        const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
        if (lines.length < 2) return [];

        const headers = parseCSVLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
        return lines.slice(1).map(line => {
            const values = parseCSVLine(line);
            const row = {};
            headers.forEach((header, index) => {
                row[header] = (values[index] ?? '').trim();
            });
            return row;
        }).filter(row => Object.values(row).some(value => value !== ''));
    }

    function firstNumber(row, keys) {
        for (const key of keys) {
            const value = row[key];
            if (value !== undefined && value !== null && String(value).trim() !== '') {
                const number = Number(value);
                if (Number.isFinite(number)) return number;
            }
        }
        return null;
    }

    function firstText(row, keys) {
        for (const key of keys) {
            if (row[key] !== undefined && String(row[key]).trim() !== '') {
                return String(row[key]).trim();
            }
        }
        return null;
    }

    // Handles both the synthetic CSV schema and common ESP32/Google Sheets headings.
    function normalizeRow(row) {
        const temperature = firstNumber(row, [
            'temperature_c', 'temperature', 'temp', 'temp_c',
            'temperature (°c)', 'temperature(°c)', 'temp (c)', 'dht11', 'dht22'
        ]);

        let waterLevel = firstNumber(row, [
            'water_level_cm', 'water_level', 'water level',
            'water level (cm)', 'waterlevel', 'level', 'level_cm'
        ]);

        let distance = firstNumber(row, [
            'sensor_distance_cm', 'distance_cm', 'distance',
            'dist', 'distance (cm)', 'distance(cm)', 'ultrasonic'
        ]);

        // Older sensor sheets may have only an ultrasonic distance value.
        if (waterLevel === null && distance !== null) {
            waterLevel = Math.max(0, SENSOR_HEIGHT_CM - distance);
        }
        if (distance === null && waterLevel !== null) {
            distance = Math.max(0, SENSOR_HEIGHT_CM - waterLevel);
        }

        const timestamp = firstText(row, [
            'timestamp', 'datetime', 'date_time', 'created_at', 'time', 'date'
        ]) || new Date().toISOString();

        return {
            timestamp,
            temperature,
            distance,
            waterLevel,
            raw: row
        };
    }

    function validReading(reading) {
        return reading.temperature !== null ||
               reading.distance !== null ||
               reading.waterLevel !== null;
    }

    function setReadings(next, source) {
        readings = next.slice(-MAX_HISTORY);
        isConnected = source === 'live' || source === 'hardware';
        usingFallback = source === 'fallback' || source === 'synthetic';
        notify('data-updated', { source, count: readings.length });
    }

    async function fetchFromSheets() {
        for (const url of [CSV_URL, EXPORT_URL]) {
            try {
                const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
                if (!response.ok) continue;
                const csv = await response.text();
                const rows = parseCSV(csv).map(normalizeRow).filter(validReading);
                if (rows.length) return rows;
            } catch (error) {
                console.warn('[AQUANEX] Google Sheets fetch failed:', error.message);
            }
        }
        return null;
    }

    function generateFallbackData() {
        const result = [];
        const now = Date.now();
        for (let i = 99; i >= 0; i--) {
            const phase = 99 - i;
            let waterLevel = 75 + 10 * Math.sin(phase / 9);
            if (phase >= 35 && phase < 65) waterLevel += (phase - 35) * 1.4;
            if (phase >= 65) waterLevel += Math.max(0, 42 - (phase - 65) * 1.5);
            waterLevel = Math.max(5, Math.min(190, waterLevel));
            const temperature = 29 + 1.5 * Math.sin(phase / 13);
            result.push({
                timestamp: new Date(now - i * 60000).toISOString(),
                temperature: Number(temperature.toFixed(1)),
                distance: Number((SENSOR_HEIGHT_CM - waterLevel).toFixed(1)),
                waterLevel: Number(waterLevel.toFixed(1)),
                raw: {}
            });
        }
        return result;
    }

    async function refresh() {
        if (replayActive || sourceMode !== 'sheets') return readings;
        const rows = await fetchFromSheets();
        if (rows && rows.length) {
            setReadings(rows, 'live');
        } else {
            isConnected = false;
            if (!readings.length) setReadings(generateFallbackData(), 'fallback');
            notify('connection-change', { connected: false });
        }
        return readings;
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        sourceMode = 'sheets';
        refresh();
        refreshTimer = setInterval(refresh, REFRESH_INTERVAL);
    }

    function stopAutoRefresh() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
    }

    async function loadCSVFile(file) {
        if (!file) throw new Error('Choose a CSV file first.');
        if (!/\.csv$/i.test(file.name)) throw new Error('Please choose a .csv file.');

        const text = await file.text();
        const rows = parseCSV(text).map(normalizeRow).filter(validReading);
        if (!rows.length) {
            throw new Error('No usable sensor rows found. Check the CSV column headings.');
        }

        stopAutoRefresh();
        stopReplay();
        sourceMode = 'synthetic';
        replayRows = rows;
        replayIndex = 0;
        readings = [];
        isConnected = false;
        usingFallback = true;
        notify('data-updated', { source: 'synthetic-reset', count: 0 });
        notify('replay-loaded', { total: replayRows.length, fileName: file.name });
        return replayRows.length;
    }

    function replayNext() {
        if (replayIndex >= replayRows.length) {
            stopReplay();
            notify('replay-complete', { total: replayRows.length });
            return;
        }

        const row = replayRows[replayIndex++];
        readings = [...readings, { ...row, raw: { ...row.raw, data_source: 'SYNTHETIC' } }].slice(-MAX_HISTORY);
        notify('data-updated', {
            source: 'synthetic',
            index: replayIndex,
            total: replayRows.length
        });

        if (replayIndex >= replayRows.length) {
            stopReplay();
            notify('replay-complete', { total: replayRows.length });
        }
    }

    function startReplay(intervalMs = 2000) {
        if (!replayRows.length) throw new Error('Upload the synthetic CSV file before starting replay.');
        stopAutoRefresh();
        stopReplay();
        sourceMode = 'synthetic';
        replayActive = true;
        replayNext();
        if (replayIndex < replayRows.length) {
            replayTimer = setInterval(replayNext, Math.max(250, Number(intervalMs) || 2000));
        }
        notify('replay-state', { playing: replayActive, index: replayIndex, total: replayRows.length });
    }

    function pauseReplay() {
        stopReplay();
        notify('replay-state', { playing: false, paused: true, index: replayIndex, total: replayRows.length });
    }

    function stopReplay() {
        if (replayTimer) clearInterval(replayTimer);
        replayTimer = null;
        replayActive = false;
    }

    function resetReplay() {
        stopReplay();
        replayIndex = 0;
        readings = [];
        notify('data-updated', { source: 'synthetic-reset', count: 0 });
        notify('replay-state', { playing: false, reset: true, index: 0, total: replayRows.length });
    }

    // Future hardware bridge: call this with each JSON payload received from an API/WebSocket.
    function ingestReading(payload) {
        const reading = normalizeRow(payload || {});
        if (!validReading(reading)) throw new Error('Hardware payload has no valid sensor values.');
        stopReplay();
        stopAutoRefresh();
        sourceMode = 'hardware';
        readings = [...readings, reading].slice(-MAX_HISTORY);
        isConnected = true;
        usingFallback = false;
        notify('data-updated', { source: 'hardware', count: readings.length });
    }

    function getReadings() { return [...readings]; }
    function getLatest() { return readings.length ? readings[readings.length - 1] : null; }
    function getRecentN(n) { return readings.slice(-n); }
    function getStatus() {
        return {
            connected: isConnected,
            usingFallback,
            sourceMode,
            replayActive,
            replayIndex,
            replayTotal: replayRows.length,
            totalReadings: readings.length,
            lastReading: getLatest()
        };
    }

    return {
        subscribe, refresh, startAutoRefresh, stopAutoRefresh,
        getReadings, getLatest, getRecentN, getStatus,
        loadCSVFile, startReplay, pauseReplay, resetReplay,
        ingestReading
    };
})();
