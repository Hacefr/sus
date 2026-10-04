// --- 1. INITIALIZE PIXI.JS (Hardware-Accelerated WebGL) ---
const app = new PIXI.Application({
    width: 1280,
    height: 720,
    backgroundColor: 0x0c0d14,
    antialias: true,
    powerPreference: "high-performance"
});

const gameContainer = document.getElementById('game-container');
gameContainer.appendChild(app.view);

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

// --- 4. CODENAME & PSYCH SCANNER ---
async function ingestZip(file) {
    statusBox.innerText = `Scanning: ${file.name}...`;
    const zip = await JSZip.loadAsync(file);

    statusBox.innerText = `Indexing charts & assets...`;
    const scanPromises = [];
    const songMeta = {};

    zip.forEach((rawPath, entry) => {
        if (entry.dir) return;

        const path = rawPath.toLowerCase().replace(/\\/g, '/');
        VirtualFS.assets[path] = entry;

        // Metadata detection
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

        // Shader detection
        if (path.endsWith('.frag')) {
            const p = entry.async('string').then(shaderCode => {
                const shaderName = path.split('/').pop().replace('.frag', '');
                VirtualFS.shaders[shaderName] = shaderCode;
            });
            scanPromises.push(p);
        }

        // Chart detection
        if (path.endsWith('.json') && !path.includes('/stages/') && !path.includes('events.json')) {
            const p = entry.async('string').then(jsonText => {
                try {
                    const cleanJson = jsonText.replace(/\/\/.*$/gm, '');
                    const parsed = JSON.parse(cleanJson);
                    const songData = parsed.song ? parsed.song : parsed;

                    const hasNotes = Array.isArray(songData.notes) || Array.isArray(parsed.strumLines);
                    const hasTiming = songData.bpm || parsed.bpm || songData.speed || parsed.scrollSpeed;

                    if (hasNotes || hasTiming) {
                        const parts = path.split('/');
                        const fileName = parts[parts.length - 1];
                        
                        let folderName = parts[parts.length - 2];
                        if (folderName === 'data' && parts.length >= 3) {
                            folderName = parts[parts.length - 3];
                        }

                        if (!fileName.includes('-easy') && fileName !== 'easy.json') {
                            const songKey = folderName.toLowerCase().trim();
                            
                            let rawName = songKey;
                            if (typeof songData.song === 'string') rawName = songData.song;
                            else if (songData.song && typeof songData.song.song === 'string') rawName = songData.song.song;
                            else if (songMeta[songKey] && typeof songMeta[songKey].name === 'string') rawName = songMeta[songKey].name;

                            // Clean scroll speed object if in Codename format
                            let cleanSpeed = songData.speed || parsed.scrollSpeed || 2.5;
                            if (typeof cleanSpeed === 'object' && cleanSpeed !== null) {
                                cleanSpeed = cleanSpeed.normal || cleanSpeed.hard || cleanSpeed.default || Object.values(cleanSpeed)[0] || 2.5;
                            }

                            VirtualFS.charts[songKey] = {
                                id: songKey,
                                name: String(rawName),
                                bpm: songData.bpm || parsed.bpm || 150,
                                speed: parseFloat(cleanSpeed) || 2.5,
                                chartData: parsed,
                                chartPath: path
                            };

                            console.log(`%c[CHART FOUND] ${String(rawName).toUpperCase()} (Speed: ${cleanSpeed})`, "color: #2ed573; font-weight: bold;");
                        }
                    }
                } catch(err) {}
            });
            scanPromises.push(p);
        }
    });

    await Promise.all(scanPromises);
}

// --- 5. FREEPLAY MENU ---
function refreshFreeplayUI() {
    const songKeys = Object.keys(VirtualFS.charts);
    if (songKeys.length === 0) return;

    dropOverlay.classList.add('hidden');
    freeplayScreen.classList.remove('hidden');

    songGrid.innerHTML = '';
    modCounter.innerText = `${songKeys.length} Songs Loaded`;

    songKeys.sort().forEach(key => {
        const item = VirtualFS.charts[key];
        const card = document.createElement('div');
        card.className = 'song-card';
        card.innerHTML = `
            <h3>${String(item.name).toUpperCase()}</h3>
            <div class="song-meta">
                <span>BPM: <strong>${item.bpm}</strong></span>
                <span>Speed: <strong>${item.speed}</strong></span>
            </div>
        `;

        card.onclick = () => launchSong(item);
        songGrid.appendChild(card);
    });
}

// ========================================================
// --- MILESTONE 2: AUDIO ENGINE & HIGH-PRECISION CONDUCTOR ---
// ========================================================

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

const Conductor = {
    bpm: 100,
    crochet: 600,       // ms per beat
    stepCrochet: 150,   // ms per step
    songPosition: 0,    // current ms in song
    lastBeat: -1,
    lastStep: -1,
    curBeat: 0,
    curStep: 0,
    isPlaying: false,
    startTime: 0,
    activeSources: [],

    setBPM(newBpm) {
        this.bpm = newBpm;
        this.crochet = (60 / newBpm) * 1000;
        this.stepCrochet = this.crochet / 4;
    },

    start() {
        this.startTime = audioCtx.currentTime;
        this.songPosition = 0;
        this.lastBeat = -1;
        this.lastStep = -1;
        this.isPlaying = true;
    },

    stop() {
        this.isPlaying = false;
        for (const src of this.activeSources) {
            try { src.stop(); } catch(e) {}
        }
        this.activeSources = [];
    },

    update() {
        if (!this.isPlaying) return;

        // Hardware-accurate audio position in milliseconds
        this.songPosition = (audioCtx.currentTime - this.startTime) * 1000;

        this.curStep = Math.floor(this.songPosition / this.stepCrochet);
        this.curBeat = Math.floor(this.curStep / 4);

        if (this.curStep > this.lastStep) {
            this.lastStep = this.curStep;
            onStepHit(this.curStep);
        }

        if (this.curBeat > this.lastBeat) {
            this.lastBeat = this.curBeat;
            onBeatHit(this.curBeat);
        }
    }
};

// --- VISUAL ELEMENTS FOR BEAT TESTING ---
let testContainer = null;
let speakerVisual = null;
let hudText = null;

function setupBeatTestScene(songName) {
    if (testContainer) app.stage.removeChild(testContainer);

    testContainer = new PIXI.Container();

    // 1. Stylized Among Us Beat Speaker Circle
    speakerVisual = new PIXI.Graphics();
    speakerVisual.beginFill(0xff334b);
    speakerVisual.drawCircle(0, 0, 70);
    speakerVisual.endFill();
    speakerVisual.lineStyle(4, 0x00d2d3, 1);
    speakerVisual.drawCircle(0, 0, 85);
    speakerVisual.position.set(1280 / 2, 720 / 2);
    testContainer.addChild(speakerVisual);

    // 2. HUD Info Text
    hudText = new PIXI.Text('', {
        fontFamily: 'Segoe UI, sans-serif',
        fontSize: 22,
        fill: 0xffffff,
        align: 'center'
    });
    hudText.anchor.set(0.5);
    hudText.position.set(1280 / 2, 120);
    testContainer.addChild(hudText);

    // 3. Back Hint
    const backHint = new PIXI.Text('Press [ESC] to return to Freeplay', {
        fontFamily: 'Segoe UI, sans-serif',
        fontSize: 16,
        fill: 0x747d8c
    });
    backHint.position.set(20, 20);
    testContainer.addChild(backHint);

    app.stage.addChild(testContainer);
}

// Bumps on every beat!
function onBeatHit(beat) {
    if (speakerVisual) {
        speakerVisual.scale.set(1.35); // Pop out on beat hit
    }
}

function onStepHit(step) {
    // Reserved for step events
}

// Smooth scale down lerp loop
app.ticker.add((delta) => {
    Conductor.update();

    if (speakerVisual) {
        // Smoothly shrink back to 1.0 size between beats
        speakerVisual.scale.x += (1.0 - speakerVisual.scale.x) * 0.15;
        speakerVisual.scale.y += (1.0 - speakerVisual.scale.y) * 0.15;
    }

    if (hudText && Conductor.isPlaying) {
        const sec = (Math.max(0, Conductor.songPosition) / 1000).toFixed(1);
        hudText.text = `SONG: ${currentSongItem.name.toUpperCase()}\nBPM: ${Conductor.bpm}  |  TIME: ${sec}s\nBEAT: ${Conductor.curBeat}  |  STEP: ${Conductor.curStep}`;
    }
});

// --- AUDIO RESOLVER & LAUNCHER ---
let currentSongItem = null;

async function launchSong(item) {
    currentSongItem = item;
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }

    freeplayScreen.classList.add('hidden');
    gameContainer.classList.remove('hidden');

    setupBeatTestScene(item.name);
    hudText.text = `Loading Audio for ${item.name.toUpperCase()}...`;

    // 1. Locate Inst and Voices in VirtualFS
    const songId = item.id.toLowerCase();
    const audioToLoad = [];

    for (const [path, entry] of Object.entries(VirtualFS.assets)) {
        if (path.includes(`/${songId}/`) || path.includes(`songs/${songId}`)) {
            if (path.endsWith('.ogg')) {
                // Inst or Voices
                audioToLoad.push({ path, entry });
            }
        }
    }

    if (audioToLoad.length === 0) {
        alert(`No .ogg audio files found for song: ${item.name}`);
        returnToFreeplay();
        return;
    }

    // 2. Decode Audio Buffers via Web Audio API
    Conductor.stop();
    Conductor.setBPM(item.bpm);

    try {
        for (const audioFile of audioToLoad) {
            const buffer = await audioFile.entry.async('arraybuffer');
            const decoded = await audioCtx.decodeAudioData(buffer.slice(0));

            const source = audioCtx.createBufferSource();
            source.buffer = decoded;
            source.connect(audioCtx.destination);

            Conductor.activeSources.push(source);
            console.log(`[AUDIO LOADED] ${audioFile.path}`);
        }

        // 3. Start all audio tracks at the exact same millisecond
        const playTime = audioCtx.currentTime + 0.05;
        Conductor.activeSources.forEach(s => s.start(playTime));
        Conductor.start();

    } catch(err) {
        console.error("Audio playback error:", err);
        alert("Failed to decode audio. Check console (F12).");
        returnToFreeplay();
    }
}

// --- EXIT BACK TO FREEPLAY ---
function returnToFreeplay() {
    Conductor.stop();
    if (testContainer) app.stage.removeChild(testContainer);
    testContainer = null;
    speakerVisual = null;
    hudText = null;

    gameContainer.classList.add('hidden');
    freeplayScreen.classList.remove('hidden');
}

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        returnToFreeplay();
    }
});
