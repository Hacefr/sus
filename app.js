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
// Holds charts, audio, textures, and XMLs in memory
const VirtualFS = {
    charts: {},      // songName -> chart JSON
    audioEntries: {}, // relativePath -> JSZip Entry or Blob
    assets: {},      // relativePath -> JSZip Entry
    shaders: {}      // name -> GLSL code string
};

const dropOverlay = document.getElementById('drop-overlay');
const statusBox = document.getElementById('status-box');
const freeplayScreen = document.getElementById('freeplay-screen');
const songGrid = document.getElementById('song-grid');
const modCounter = document.getElementById('mod-counter');

// --- 3. DRAG AND DROP HANDLER (Supports Multiple Zips) ---
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    
    if (files.length === 0) return;

    for (const file of files) {
        if (file.name.endsWith('.zip')) {
            await ingestZip(file);
        } else if (file.name.endsWith('.imp')) {
            statusBox.innerText = `Loading fast package: ${file.name}...`;
            // .imp handler will plug in here in Milestone 5
        }
    }

    refreshFreeplayUI();
});

// --- 4. MOD INGESTION & LAZY REGISTRY ---
async function ingestZip(file) {
    statusBox.innerText = `Reading: ${file.name}...`;
    const zip = await JSZip.loadAsync(file);

    statusBox.innerText = `Indexing songs & assets from: ${file.name}...`;

    const chartPromises = [];

    zip.forEach((path, entry) => {
        if (entry.dir) return;
        const cleanPath = path.toLowerCase().replace(/\\/g, '/');

        // Store asset reference without decompressing yet (saves RAM)
        VirtualFS.assets[cleanPath] = entry;

        // Chart discovery: looks inside data/
        if (cleanPath.startsWith('data/') && cleanPath.endsWith('.json')) {
            // Avoid event JSON files, we only want song charts
            if (!cleanPath.includes('events') && !cleanPath.includes('-hard') && !cleanPath.includes('-easy')) {
                const p = entry.async('string').then(jsonText => {
                    try {
                        const parsed = JSON.parse(jsonText);
                        if (parsed && parsed.song) {
                            const songName = parsed.song.song.toLowerCase();
                            VirtualFS.charts[songName] = parsed.song;
                        }
                    } catch(err) {
                        // Skip non-chart JSONs
                    }
                });
                chartPromises.push(p);
            }
        }

        // Cache shaders if present
        if (cleanPath.endsWith('.frag')) {
            const p = entry.async('string').then(shaderCode => {
                const shaderName = cleanPath.split('/').pop().replace('.frag', '');
                VirtualFS.shaders[shaderName] = shaderCode;
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
        statusBox.innerText = "No charts found. Did you drop the full mod zip?";
        return;
    }

    dropOverlay.classList.add('hidden');
    freeplayScreen.classList.remove('hidden');

    songGrid.innerHTML = '';
    modCounter.innerText = `${songKeys.length} Songs Loaded`;

    // Alphabetical sort
    songKeys.sort().forEach(key => {
        const chart = VirtualFS.charts[key];
        const card = document.createElement('div');
        card.className = 'song-card';
        card.innerHTML = `
            <h3>${chart.song}</h3>
            <div class="song-meta">
                <span>Opponent: <strong>${chart.player2 || 'Unknown'}</strong></span>
                <span>BPM: <strong>${chart.bpm}</strong></span>
                <span>Speed: <strong>${chart.speed}</strong></span>
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
    console.log("Player 2 (Dad):", chart.player2);
    console.log("Note Count in Chart:", chart.notes ? chart.notes.length : 0);

    alert(`Ready for Milestone 2!\nSelected: ${chart.song}\nBPM: ${chart.bpm}\nOpponent: ${chart.player2}`);
}
