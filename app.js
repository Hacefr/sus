// --- 1. INITIALIZE PIXI.JS (Hardware-Accelerated WebGL) ---
const app = new PIXI.Application({
    width: 1280,
    height: 720,
    backgroundColor: 0x0c0d14,
    antialias: true,
    powerPreference: "high-performance"
});

document.getElementById('game-container').appendChild(app.view);

// --- 2. ADDITIVE VIRTUAL FILE SYSTEM ---
const VirtualFS = {
    charts: {},      // songName -> { chartData, meta }
    assets: {},      // relativePath -> JSZip Entry
    shaders: {}      // name -> GLSL code string
};

const dropOverlay = document.getElementById('drop-overlay');
const statusBox = document.getElementById('status-box');
const freeplayScreen = document.getElementById('freeplay-screen');
const songGrid = document.getElementById('song-grid');
const modCounter = document.getElementById('mod-counter');

// --- 3. DRAG AND DROP HANDLER ---
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    
    if (files.length === 0) return;

    for (const file of files) {
        if (file.name.endsWith('.zip')) {
            await ingestZip(file);
        } else if (file.name.endsWith('.imp')) {
            statusBox.innerText = `Loading .imp package: ${file.name}...`;
        }
    }

    refreshFreeplayUI();
});

// --- 4. CODENAME & PSYCH ENGINE SCANNER ---
async function ingestZip(file) {
    statusBox.innerText = `Scanning: ${file.name}...`;
    const zip = await JSZip.loadAsync(file);

    statusBox.innerText = `Parsing charts & assets from: ${file.name}...`;
    const scanPromises = [];

    // Temporary storage to merge meta.json and normal.json
    const pendingSongs = {};

    zip.forEach((rawPath, entry) => {
        if (entry.dir) return;

        const path = rawPath.toLowerCase().replace(/\\/g, '/');
        VirtualFS.assets[path] = entry;

        // --- A. DETECT CODENAME CHARTS: songs/<songName>/data/normal.json ---
        const codenameChartMatch = path.match(/(?:^|\/)songs\/([^\/]+)\/data\/(normal|hard)\.json$/);
        if (codenameChartMatch) {
            const songFolder = codenameChartMatch[1].toLowerCase().trim();
            const diff = codenameChartMatch[2];

            const p = entry.async('string').then(jsonText => {
                try {
                    const parsed = JSON.parse(jsonText.replace(/\/\/.*$/gm, ''));
                    if (!pendingSongs[songFolder]) pendingSongs[songFolder] = {};
                    // Prefer hard or normal
                    if (!pendingSongs[songFolder].chart || diff === 'normal' || diff === 'hard') {
                        pendingSongs[songFolder].chart = parsed;
                        pendingSongs[songFolder].chartPath = path;
                    }
                } catch(err) {
                    console.warn("Failed parsing chart:", path);
                }
            });
            scanPromises.push(p);
        }

        // --- B. DETECT CODENAME METADATA: songs/<songName>/meta.json ---
        const metaMatch = path.match(/(?:^|\/)songs\/([^\/]+)\/meta\.json$/);
        if (metaMatch) {
            const songFolder = metaMatch[1].toLowerCase().trim();
            const p = entry.async('string').then(jsonText => {
                try {
                    const meta = JSON.parse(jsonText.replace(/\/\/.*$/gm, ''));
                    if (!pendingSongs[songFolder]) pendingSongs[songFolder] = {};
                    pendingSongs[songFolder].meta = meta;
                } catch(err) {}
            });
            scanPromises.push(p);
        }

        // --- C. DETECT STANDARD PSYCH CHARTS: data/<songName>/<songName>.json ---
        const psychChartMatch = path.match(/(?:^|\/)data\/([^\/]+)\/([^\/]+)\.json$/);
        if (psychChartMatch && !path.includes('/stages/')) {
            const songFolder = psychChartMatch[1].toLowerCase().trim();
            const fileName = psychChartMatch[2];

            if (fileName !== 'events' && fileName !== 'picospeaker') {
                const p = entry.async('string').then(jsonText => {
                    try {
                        const parsed = JSON.parse(jsonText.replace(/\/\/.*$/gm, ''));
                        const songData = parsed.song ? parsed.song : parsed;
                        if (songData && (songData.notes || songData.bpm)) {
                            if (!pendingSongs[songFolder]) pendingSongs[songFolder] = {};
                            pendingSongs[songFolder].chart = songData;
                            pendingSongs[songFolder].chartPath = path;
                        }
                    } catch(err) {}
                });
                scanPromises.push(p);
            }
        }

        // --- D. DETECT SHADERS ---
        if (path.endsWith('.frag')) {
            const p = entry.async('string').then(shaderCode => {
                const shaderName = path.split('/').pop().replace('.frag', '');
                VirtualFS.shaders[shaderName] = shaderCode;
                console.log(`%c[SHADER FOUND] ${shaderName}`, "color: #00d2d3;");
            });
            scanPromises.push(p);
        }
    });

    await Promise.all(scanPromises);

    // Merge pending chart data into VirtualFS.charts
    for (const [songKey, data] of Object.entries(pendingSongs)) {
        if (data.chart) {
            const meta = data.meta || {};
            const chart = data.chart;

            // Normalize song title and BPM between Codename & Psych
            const displayName = meta.name || chart.song || songKey;
            const bpm = meta.bpm || chart.bpm || (chart.meta ? chart.meta.bpm : 150);
            const speed = chart.scrollSpeed || chart.speed || 2.5;

            VirtualFS.charts[songKey] = {
                id: songKey,
                name: displayName,
                bpm: bpm,
                speed: speed,
                chartData: chart,
                chartPath: data.chartPath,
                meta: meta
            };

            console.log(`%c[CHART FOUND] ${displayName.toUpperCase()} (Path: ${data.chartPath})`, "color: #2ed573; font-weight: bold;");
        }
    }
}

// --- 5. BUILD THE FREEPLAY MENU ---
function refreshFreeplayUI() {
    const songKeys = Object.keys(VirtualFS.charts);
    
    if (songKeys.length === 0) {
        statusBox.innerText = "No charts detected! Open F12 Console to see indexed files.";
        return;
    }

    dropOverlay.classList.add('hidden');
    freeplayScreen.classList.remove('hidden');

    songGrid.innerHTML = '';
    modCounter.innerText = `${songKeys.length} Songs Loaded`;

    // Sort alphabetically
    songKeys.sort().forEach(key => {
        const item = VirtualFS.charts[key];
        
        const card = document.createElement('div');
        card.className = 'song-card';
        card.innerHTML = `
            <h3>${item.name.toUpperCase()}</h3>
            <div class="song-meta">
                <span>BPM: <strong>${item.bpm}</strong></span>
                <span>Speed: <strong>${item.speed}</strong></span>
            </div>
        `;

        card.onclick = () => selectSong(item);
        songGrid.appendChild(card);
    });
}

// --- 6. SONG SELECTION & AUDIT ---
function selectSong(item) {
    console.log("=== SONG SELECTED ===", item.name);
    console.log("Song ID:", item.id);
    console.log("Chart Path:", item.chartPath);
    console.log("BPM:", item.bpm);
    console.log("Full Chart Data:", item.chartData);

    alert(`Ready for Milestone 2!\nLoaded: ${item.name}\nBPM: ${item.bpm}\nSpeed: ${item.speed}`);
}
