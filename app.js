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
    charts: {},      // songName -> chart JSON
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

// --- 4. SMART DEEP SCANNER ---
async function ingestZip(file) {
    statusBox.innerText = `Scanning: ${file.name}...`;
    const zip = await JSZip.loadAsync(file);

    statusBox.innerText = `Parsing charts & assets from: ${file.name}...`;
    const chartPromises = [];

    zip.forEach((rawPath, entry) => {
        if (entry.dir) return;

        // Normalize path: lowercase and forward slashes
        const path = rawPath.toLowerCase().replace(/\\/g, '/');

        // Store reference in VirtualFS by its clean relative filename
        VirtualFS.assets[path] = entry;

        // SMART CHART DETECTOR:
        // Finds anything like ".../data/songname/songname.json" or ".../data/songname/songname-hard.json"
        // regardless of parent folders (assets/, mods/, SecurityDLC/, etc.)
        const chartMatch = path.match(/(?:^|\/)data\/([^\/]+)\/([^\/]+)\.json$/);

        if (chartMatch) {
            const folderName = chartMatch[1];
            const fileName = chartMatch[2];

            // Ignore event-only files
            if (fileName !== 'events' && fileName !== 'picospeaker') {
                const p = entry.async('string').then(jsonText => {
                    try {
                        const parsed = JSON.parse(jsonText);
                        
                        // Handle standard Psych Engine / FNF chart format
                        let songData = parsed.song ? parsed.song : parsed;

                        // Verify it's actually a chart with notes/bpm
                        if (songData && (songData.notes || songData.bpm)) {
                            const songName = (typeof songData.song === 'string') 
                                ? songData.song.toLowerCase().trim() 
                                : folderName.toLowerCase().trim();

                            // Prefer normal chart, fallback to -hard if normal doesn't exist
                            if (!VirtualFS.charts[songName] || !fileName.includes('-easy')) {
                                VirtualFS.charts[songName] = songData;
                                console.log(`[CHART FOUND] ${songData.song || folderName} (${path})`);
                            }
                        }
                    } catch(err) {
                        console.warn("Skipping invalid JSON:", path);
                    }
                });
                chartPromises.push(p);
            }
        }

        // Cache shaders (.frag files)
        if (path.endsWith('.frag')) {
            const p = entry.async('string').then(shaderCode => {
                const shaderName = path.split('/').pop().replace('.frag', '');
                VirtualFS.shaders[shaderName] = shaderCode;
                console.log(`[SHADER FOUND] ${shaderName}`);
            });
            chartPromises.push(p);
        }
    });

    await Promise.all(chartPromises);
}

// --- 5. BUILD THE FREEPLAY MENU ---
function refreshFreeplayUI() {
    const songKeys = Object.keys(VirtualFS.charts);
    
    if (songKeys.length === 0) {
        statusBox.innerText = "No charts detected! Open DevTools (F12) to see indexed files.";
        return;
    }

    dropOverlay.classList.add('hidden');
    freeplayScreen.classList.remove('hidden');

    songGrid.innerHTML = '';
    modCounter.innerText = `${songKeys.length} Songs Loaded`;

    // Sort alphabetically
    songKeys.sort().forEach(key => {
        const chart = VirtualFS.charts[key];
        const displayName = chart.song || key;
        
        const card = document.createElement('div');
        card.className = 'song-card';
        card.innerHTML = `
            <h3>${displayName.toUpperCase()}</h3>
            <div class="song-meta">
                <span>Opponent: <strong>${chart.player2 || 'Unknown'}</strong></span>
                <span>BPM: <strong>${chart.bpm || 100}</strong></span>
                <span>Speed: <strong>${chart.speed || 1}</strong></span>
            </div>
        `;

        card.onclick = () => selectSong(chart);
        songGrid.appendChild(card);
    });
}

// --- 6. SONG SELECTION & AUDIT ---
function selectSong(chart) {
    console.log("=== SONG SELECTED ===", chart.song);
    console.log("Stage:", chart.stage || "default");
    console.log("Player 1 (BF):", chart.player1);
    console.log("Player 2 (Opponent):", chart.player2);
    console.log("BPM:", chart.bpm);
    
    alert(`Ready for Milestone 2!\nLoaded: ${chart.song}\nBPM: ${chart.bpm}\nOpponent: ${chart.player2}\nStage: ${chart.stage || 'default'}`);
}
