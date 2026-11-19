/* AQUANEX application controller + CSV replay controls.
   Keeps the existing Dashboard, Chatbot and AlertSystem modules. */
const App = (() => {
    let isInitialized = false;

    function initTabs() {
        const tabNav = document.getElementById('tabNav');
        const panels = document.querySelectorAll('.tab-panel');
        const buttons = document.querySelectorAll('.tab-btn');

        tabNav.addEventListener('click', event => {
            const btn = event.target.closest('.tab-btn');
            if (!btn) return;

            buttons.forEach(button => button.classList.remove('active'));
            panels.forEach(panel => panel.classList.remove('active'));
            btn.classList.add('active');

            const panel = document.getElementById(
                `panel${btn.dataset.tab.charAt(0).toUpperCase()}${btn.dataset.tab.slice(1)}`
            );
            if (panel) panel.classList.add('active');
        });
    }

    function addReplayControls() {
        const dashboardPanel = document.getElementById('panelDashboard');
        if (!dashboardPanel || document.getElementById('csvReplayPanel')) return;

        const panel = document.createElement('section');
        panel.id = 'csvReplayPanel';
        panel.style.cssText = [
            'display:flex', 'flex-wrap:wrap', 'align-items:center', 'gap:10px',
            'padding:14px 18px', 'margin:0 0 18px', 'background:#fff',
            'border:1px solid #dce6f1', 'border-radius:14px',
            'box-shadow:0 3px 12px rgba(20,50,90,.07)'
        ].join(';');

        panel.innerHTML = `
            <div style="flex:1 1 220px;min-width:200px">
                <strong style="display:block;color:#172b4d;font-size:14px">CSV Simulation</strong>
                <span id="replayStatus" style="font-size:12px;color:#64748b">
                    Upload your AquaNex synthetic CSV to replay readings.
                </span>
            </div>
            <input id="replayFile" type="file" accept=".csv,text/csv"
                style="max-width:230px;font-size:12px">
            <select id="replaySpeed" aria-label="Replay interval"
                style="padding:9px 10px;border:1px solid #cbd5e1;border-radius:8px">
                <option value="2000">Every 2 seconds</option>
                <option value="1000">Every 1 second</option>
                <option value="500">Every 0.5 second</option>
                <option value="5000">Every 5 seconds</option>
            </select>
            <button id="replayStart" type="button">Start</button>
            <button id="replayPause" type="button">Pause</button>
            <button id="replayReset" type="button">Reset</button>
        `;

        const buttonStyle = 'padding:9px 15px;border:0;border-radius:8px;background:#087fc1;color:white;font-weight:600;cursor:pointer';
        ['replayStart', 'replayPause', 'replayReset'].forEach(id => {
            const button = panel.querySelector('#' + id);
            button.style.cssText = buttonStyle;
        });
        panel.querySelector('#replayPause').style.background = '#64748b';
        panel.querySelector('#replayReset').style.background = '#e78b19';

        dashboardPanel.insertBefore(panel, dashboardPanel.firstChild);

        const fileInput = panel.querySelector('#replayFile');
        const status = panel.querySelector('#replayStatus');
        const speed = panel.querySelector('#replaySpeed');

        fileInput.addEventListener('change', async () => {
            const file = fileInput.files[0];
            if (!file) return;
            try {
                const total = await DataManager.loadCSVFile(file);
                status.textContent = `${file.name} loaded — ${total} readings ready. Press Start.`;
            } catch (error) {
                status.textContent = error.message;
                console.error('[AQUANEX] CSV load error:', error);
            }
        });

        panel.querySelector('#replayStart').addEventListener('click', () => {
            try {
                DataManager.startReplay(Number(speed.value));
                status.textContent = 'Replaying synthetic readings…';
            } catch (error) {
                status.textContent = error.message;
            }
        });

        panel.querySelector('#replayPause').addEventListener('click', () => {
            DataManager.pauseReplay();
            status.textContent = 'Replay paused. Press Start to continue.';
        });

        panel.querySelector('#replayReset').addEventListener('click', () => {
            DataManager.resetReplay();
            status.textContent = 'Replay reset. Press Start to replay from the beginning.';
        });
    }

    function onDataEvent(event, data) {
        if (event === 'data-updated') {
            const readings = DataManager.getReadings();
            Dashboard.update(readings);
            if (readings.length) AlertSystem.evaluate(readings);
            console.log(`[AQUANEX] ${data.source}: ${readings.length} readings`);
        }

        if (event === 'connection-change') {
            const status = DataManager.getStatus();
            console.log(`[AQUANEX] Connection: ${status.connected ? 'Live' : 'Disconnected'}`);
        }

        if (event === 'replay-complete') {
            const status = document.getElementById('replayStatus');
            if (status) status.textContent = `Replay complete — ${data.total} readings processed. Press Reset to run again.`;
        }

        if (event === 'replay-state') {
            const status = document.getElementById('replayStatus');
            if (status && data.playing) {
                status.textContent = `Replaying ${data.index} of ${data.total} readings…`;
            }
        }
    }

    async function init() {
        if (isInitialized) return;
        isInitialized = true;

        try {
            Dashboard.init();
            AlertSystem.init();
            Chatbot.init();
            initTabs();
            addReplayControls();
            DataManager.subscribe(onDataEvent);
            DataManager.startAutoRefresh();
            console.log('[AQUANEX] Ready. CSV replay controls enabled.');
        } catch (error) {
            console.error('[AQUANEX] Initialization error:', error);
            const toastContainer = document.getElementById('toastContainer');
            if (toastContainer) {
                const toast = document.createElement('div');
                toast.className = 'toast danger';
                toast.textContent = `Initialization Error: ${error.message}`;
                toastContainer.appendChild(toast);
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { init };
})();
