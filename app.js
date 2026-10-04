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

// --- 4. UNIVERSAL JSON & ASSET SCANNER ---
async function ingestZip(file) {
    statusBox.innerText = `Scanning: ${file.name}...`;
    const zip = await JSZip.loadAsync(file);

    statusBox.innerText = `Parsing charts & assets from: ${file.name}...`;
    const scanPromises = [];

    zip.forEach((rawPath, entry) => {
        if (entry.dir) return;

        const path = rawPath.toLowerCase().replace(/\\/g, '/');
        VirtualFS.assets[path] = entry;

        // 1. Log and check ALL JSON files
        if (path.endsWith('.json')) {
            const p = entry.async('string').then(jsonText => {
                // Strip comments if present (some FNF mods use // in JSON)
                const cleanJson = jsonText.replace(/\/\/.*$/gm, '');
                
                try {
                    const parsed = JSON.parse(cleanJson);
                    const songData = parsed.song ? parsed.song : parsed;

                    // A real FNF chart always has a notes array or section list + bpm
                    if (songData && (Array.isArray(songData.notes) || songData.notes) && (songData.bpm || songData.speed)) {
                        
                        let songName = typeof songData.song === 'string' ? songData.song : null;
                        
                        // Fallback: extract song name from the folder name
                        if (!songName) {
                            const parts = path.split('/');
                            songName = parts[parts.length - 2] || parts[parts.length - 1].replace('.json', '');
                        }

                        songName = songName.toLowerCase().trim();

                        // Avoid registering event-only files or overwriting standard charts with easy
                        if (!path.includes('events') && !path.includes('-easy')) {
                            VirtualFS.charts[songName] = songData;
                            console.log(`%c[CHART FOUND] ${songName.toUpperCase()} -> ${path}`, "color: #2ed573; font-weight: bold;");
                        }
                    }
                } catch(err) {
                    // Ignore stage / dialogue / non-standard JSONs silently
                }
            });
            scanPromises.push(p);
        }

        // 2. Cache Shaders (.frag files)
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
}

// --- 5. BUILD THE FREEPLAY MENU ---
function refreshFreeplayUI() {
    const songKeys = Object.keys(VirtualFS.charts);
    
    if (songKeys.length === 0) {
        statusBox.innerText = "No charts detected yet. Open F12 Console to see details.";
        console.warn("Total indexed files in zip:", Object.keys(VirtualFS.assets).length);
        return;
    }

    dropOverlay.classList.add('hidden');
    freeplayScreen.classList.remove('hidden');

    songGrid.innerHTML = '';
    modCounter.innerText = `${songKeys.length} Songs Loaded`;

    // Alphabetical sort
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
