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
    charts: {},      // songKey -> { id, name, bpm, speed, chartData, chartPath }
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

// --- 4. MERGED UNIVERSAL & CODENAME SCANNER ---
async function ingestZip(file) {
    statusBox.innerText = `Scanning: ${file.name}...`;
    const zip = await JSZip.loadAsync(file);

    statusBox.innerText = `Parsing charts & assets from: ${file.name}...`;
    const scanPromises = [];

    // Temporary storage for metadata
    const songMeta = {};

    zip.forEach((rawPath, entry) => {
        if (entry.dir) return;

        const path = rawPath.toLowerCase().replace(/\\/g, '/');
        VirtualFS.assets[path] = entry;

        // Catch Codename meta.json files
        if (path.endsWith('meta.json')) {
            const p = entry.async('string').then(text => {
                try {
                    const parsed = JSON.parse(text.replace(/\/\/.*$/gm, ''));
                    const parts = path.split('/');
                    const songKey = parts[parts.length - 2];
                    if (songKey) songMeta[songKey] = parsed;
                } catch(e) {}
            });
            scanPromises.push(p);
        }

        // Catch Shaders (.frag files)
        if (path.endsWith('.frag')) {
            const p = entry.async('string').then(shaderCode => {
                const shaderName = path.split('/').pop().replace('.frag', '');
                VirtualFS.shaders[shaderName] = shaderCode;
                console.log(`%c[SHADER FOUND] ${shaderName}`, "color: #00d2d3;");
            });
            scanPromises.push(p);
        }

        // Catch ALL potential charts (.json)
        if (path.endsWith('.json') && !path.includes('/stages/') && !path.includes('events.json')) {
            const p = entry.async('string').then(jsonText => {
                try {
                    const cleanJson = jsonText.replace(/\/\/.*$/gm, '');
                    const parsed = JSON.parse(cleanJson);
                    const songData = parsed.song ? parsed.song : parsed;

                    // Verify it's an actual chart (Codename strumLines OR Psych notes array)
                    const hasNotes = Array.isArray(songData.notes) || Array.isArray(parsed.strumLines);
                    const hasTiming = songData.bpm || parsed.bpm || songData.speed || parsed.scrollSpeed;

                    if (hasNotes || hasTiming) {
                        const parts = path.split('/');
                        const fileName = parts[parts.length - 1];
                        
                        // Extract clean song folder name
                        // e.g., "assets/songs/sussus-moogus/data/normal.json" -> "sussus-moogus"
                        let folderName = parts[parts.length - 2];
                        if (folderName === 'data' && parts.length >= 3) {
                            folderName = parts[parts.length - 3];
                        }

                        // Avoid registering easy charts over normal/hard
                        if (!fileName.includes('-easy') && fileName !== 'easy.json') {
                            const songKey = folderName.toLowerCase().trim();
                            
                            // Determine display name safely without crashing
                            let rawName = songKey;
                            if (typeof songData.song === 'string') rawName = songData.song;
                            else if (songData.song && typeof songData.song.song === 'string') rawName = songData.song.song;
                            else if (songMeta[songKey] && typeof songMeta[songKey].name === 'string') rawName = songMeta[songKey].name;

                            VirtualFS.charts[songKey] = {
                                id: songKey,
                                name: String(rawName), // Guaranteed to be a string
                                bpm: songData.bpm || parsed.bpm || 150,
                                speed: songData.speed || parsed.scrollSpeed || 2.5,
                                chartData: parsed,
                                chartPath: path
                            };

                            console.log(`%c[CHART FOUND] ${String(rawName).toUpperCase()} -> ${path}`, "color: #2ed573; font-weight: bold;");
                        }
                    }
                } catch(err) {
                    // Ignore invalid JSONs
                }
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
        statusBox.innerText = "No charts detected! Check Console (F12).";
        return;
    }

    dropOverlay.classList.add('hidden');
    freeplayScreen.classList.remove('hidden');

    songGrid.innerHTML = '';
    modCounter.innerText = `${songKeys.length} Songs Loaded`;

    // Alphabetical sort
    songKeys.sort().forEach(key => {
        const item = VirtualFS.charts[key];
        const safeDisplayName = String(item.name || key).toUpperCase();
        
        const card = document.createElement('div');
        card.className = 'song-card';
        card.innerHTML = `
            <h3>${safeDisplayName}</h3>
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

    alert(`Ready for Milestone 2!\nLoaded: ${String(item.name).toUpperCase()}\nBPM: ${item.bpm}\nSpeed: ${item.speed}`);
}
