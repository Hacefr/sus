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
    charts: {},      
    assets: {},      
    shaders: {}      
};

const dropOverlay = document.getElementById('drop-overlay');
const stagedList = document.getElementById('staged-files-list');
const startBtn = document.getElementById('start-engine-btn');
const statusBox = document.getElementById('status-box');
const freeplayScreen = document.getElementById('freeplay-screen');
const songGrid = document.getElementById('song-grid');
const modCounter = document.getElementById('mod-counter');

const stagedFiles = [];

// --- 3. STAGING DRAG AND DROP ---
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);

    files.forEach(file => {
        if (file.name.endsWith('.zip') || file.name.endsWith('.imp')) {
            if (!stagedFiles.some(f => f.name === file.name)) {
                stagedFiles.push(file);
            }
        }
    });

    updateStagingUI();
});

function updateStagingUI() {
    if (stagedFiles.length === 0) return;

    stagedList.innerHTML = '';
    stagedFiles.forEach(file => {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        const item = document.createElement('div');
        item.className = 'staged-item';
        item.innerHTML = `<span>✔ ${file.name}</span><span style="color:#747d8c">${sizeMB} MB</span>`;
        stagedList.appendChild(item);
    });

    startBtn.classList.remove('hidden');
    startBtn.innerText = `LOAD MODS & START (${stagedFiles.length} File${stagedFiles.length > 1 ? 's' : ''} Ready)`;
}

startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.classList.add('hidden');
    statusBox.classList.remove('hidden');

    for (const file of stagedFiles) {
        if (file.name.endsWith('.zip')) {
            await ingestZip(file);
        }
    }

    refreshFreeplayUI();
});

// --- 4. UNIVERSAL SCANNER (V-Slice, Codename & Psych) ---
async function ingestZip(file) {
    statusBox.innerText = `Scanning: ${file.name}...`;
    const zip = await JSZip.loadAsync(file);

    statusBox.innerText = `Indexing charts & assets...`;
    const scanPromises = [];
    const vsliceMeta = {};
    const vsliceCharts = {};

    zip.forEach((rawPath, entry) => {
        if (entry.dir) return;

        const path = rawPath.toLowerCase().replace(/\\/g, '/');
        VirtualFS.assets[path] = entry;

        // Catch Shaders (.frag)
        if (path.endsWith('.frag')) {
            const p = entry.async('string').then(shaderCode => {
                const shaderName = path.split('/').pop().replace('.frag', '');
                VirtualFS.shaders[shaderName] = shaderCode;
            });
            scanPromises.push(p);
        }

        // --- A. V-SLICE FORMAT: <song>-metadata.json ---
        if (path.endsWith('-metadata.json')) {
            const p = entry.async('string').then(text => {
                try {
                    const parsed = JSON.parse(text.replace(/\/\/.*$/gm, ''));
                    const songName = path.split('/').pop().replace('-metadata.json', '');
                    vsliceMeta[songName] = parsed;
                } catch(e) {}
            });
            scanPromises.push(p);
        }

        // --- B. V-SLICE FORMAT: <song>-chart.json ---
        if (path.endsWith('-chart.json')) {
            const p = entry.async('string').then(text => {
                try {
                    const parsed = JSON.parse(text.replace(/\/\/.*$/gm, ''));
                    const songName = path.split('/').pop().replace('-chart.json', '');
                    vsliceCharts[songName] = { parsed, path };
                } catch(e) {}
            });
            scanPromises.push(p);
        }

        // --- C. CODENAME & PSYCH FORMATS ---
        if (path.endsWith('.json') && !path.includes('/stages/') && !path.includes('events.json') && !path.endsWith('-metadata.json') && !path.endsWith('-chart.json')) {
            const p = entry.async('string').then(jsonText => {
                try {
                    const cleanJson = jsonText.replace(/\/\/.*$/gm, '');
                    const parsed = JSON.parse(cleanJson);
                    const songData = parsed.song ? parsed.song : parsed;

                    const hasNotes = Array.isArray(songData.notes) || (songData.notes && typeof songData.notes === 'object') || Array.isArray(parsed.strumLines);
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
                        }
                    }
                } catch(err) {}
            });
            scanPromises.push(p);
        }
    });

    await Promise.all(scanPromises);

    // Merge V-Slice Charts into VirtualFS
    for (const [songKey, cObj] of Object.entries(vsliceCharts)) {
        const meta = vsliceMeta[songKey] || {};
        const parsed = cObj.parsed;

        let cleanSpeed = 2.5;
        if (parsed.scrollSpeed) {
            cleanSpeed = (typeof parsed.scrollSpeed === 'object') 
                ? (parsed.scrollSpeed.normal || parsed.scrollSpeed.hard || 2.5) 
                : parsed.scrollSpeed;
        }

        const songName = meta.songName || meta.name || songKey;
        const bpm = meta.bpm || (meta.timeChanges && meta.timeChanges[0] ? meta.timeChanges[0].bpm : 150);

        VirtualFS.charts[songKey] = {
            id: songKey,
            name: String(songName),
            bpm: bpm,
            speed: parseFloat(cleanSpeed) || 2.5,
            chartData: parsed,
            chartPath: cObj.path
        };

        console.log(`%c[V-SLICE CHART LOADED] ${songName.toUpperCase()} -> ${cObj.path}`, "color: #00d2d3; font-weight: bold;");
    }
}

// --- 5. FREEPLAY MENU ---
function refreshFreeplayUI() {
    const songKeys = Object.keys(VirtualFS.charts);
    if (songKeys.length === 0) {
        statusBox.innerText = "No charts detected in dropped files!";
        return;
    }

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
// --- CONDUCTOR, STRUMBAR & GAMEPLAY ---
// ========================================================

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

const Conductor = {
    bpm: 100,
    crochet: 600,
    stepCrochet: 150,
    songPosition: 0,
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
        this.songPosition = (audioCtx.currentTime - this.startTime) * 1000;
        this.curStep = Math.floor(this.songPosition / this.stepCrochet);
        this.curBeat = Math.floor(this.curStep / 4);

        if (this.curStep > this.lastStep) {
            this.lastStep = this.curStep;
        }

        if (this.curBeat > this.lastBeat) {
            this.lastBeat = this.curBeat;
            onBeatHit(this.curBeat);
        }
    }
};

const NOTE_COLORS = [0xc24b99, 0x00ffff, 0x12fa05, 0xf9393f]; 
const ARROW_ANGLES = [-Math.PI / 2, Math.PI, 0, Math.PI / 2];

function drawArrowShape(graphics, color, size = 32) {
    graphics.clear();
    graphics.beginFill(color);
    graphics.moveTo(0, -size);
    graphics.lineTo(size * 0.8, size * 0.7);
    graphics.lineTo(0, size * 0.4);
    graphics.lineTo(-size * 0.8, size * 0.7);
    graphics.closePath();
    graphics.endFill();
}

let playState = null;

class PlayStateScene {
    constructor(songItem) {
        this.songItem = songItem;
        this.speed = songItem.speed || 2.5;
        this.container = new PIXI.Container();

        this.notes = [];
        this.receptors = [];
        this.score = 0;
        this.combo = 0;
        this.ratingText = null;
        this.scoreText = null;

        this.setupStrumlines();
        this.parseChartNotes(songItem.chartData);
        this.setupHUD();

        app.stage.addChild(this.container);
    }

    setupStrumlines() {
        const startX_Opponent = 120;
        const startX_Player = 760;
        const receptorY = 100;
        const spacing = 110;

        for (let i = 0; i < 8; i++) {
            const isPlayer = i >= 4;
            const dir = i % 4;
            const x = (isPlayer ? startX_Player : startX_Opponent) + (dir * spacing);

            const receptor = new PIXI.Container();
            receptor.position.set(x, receptorY);

            const base = new PIXI.Graphics();
            base.lineStyle(4, 0x444d63, 1);
            base.drawCircle(0, 0, 42);
            receptor.addChild(base);

            const arrow = new PIXI.Graphics();
            drawArrowShape(arrow, 0x8a95aa, 28);
            arrow.rotation = ARROW_ANGLES[dir];
            receptor.addChild(arrow);

            this.receptors.push({ container: receptor, dir, isPlayer, arrow, base });
            this.container.addChild(receptor);
        }
    }

    // --- UNIVERSAL NOTE PARSER (V-Slice, Codename & Psych) ---
    parseChartNotes(chart) {
        this.notes = [];
        if (!chart) return;

        const data = chart.chartData || chart;
        const songObj = (data.song && typeof data.song === 'object') ? data.song : data;

        // --- 1. V-SLICE FORMAT ({ notes: { normal: [ { t, d, l }, ... ] } }) ---
        if (data.notes && typeof data.notes === 'object' && !Array.isArray(data.notes)) {
            const diffNotes = data.notes.normal || data.notes.hard || data.notes.default || Object.values(data.notes)[0];
            if (Array.isArray(diffNotes)) {
                diffNotes.forEach(n => {
                    const rawDir = n.d !== undefined ? n.d : (n.dir || 0);
                    this.notes.push({
                        time: n.t !== undefined ? n.t : n.time,
                        dir: rawDir % 4,
                        isPlayer: (rawDir < 4),
                        sustain: n.l !== undefined ? n.l : (n.sLen || 0),
                        hit: false, missed: false, sprite: null, tailSprite: null
                    });
                });
            }
        }

        // --- 2. CODENAME ENGINE STRUM LINES ---
        const strumLines = data.strumLines || (data.song && data.song.strumLines);
        if (this.notes.length === 0 && Array.isArray(strumLines)) {
            strumLines.forEach((strum, lineIndex) => {
                const isPlayer = (strum.type === 1) || (lineIndex === 1);
                if (Array.isArray(strum.notes)) {
                    strum.notes.forEach(n => {
                        this.notes.push({
                            time: n.time || 0,
                            dir: (n.id !== undefined ? n.id : (n.dir || 0)) % 4,
                            isPlayer: isPlayer,
                            sustain: n.sLen || n.sustain || 0,
                            hit: false, missed: false, sprite: null, tailSprite: null
                        });
                    });
                }
            });
        }

        // --- 3. PSYCH / NMV2 / SECTION NOTES ---
        if (this.notes.length === 0) {
            let sections = songObj.notes || data.notes || [];
            if (sections && typeof sections === 'object' && !Array.isArray(sections)) {
                sections = Object.values(sections);
            }

            if (Array.isArray(sections)) {
                sections.forEach(section => {
                    if (!section) return;

                    if (Array.isArray(section.sectionNotes)) {
                        section.sectionNotes.forEach(n => {
                            if (!Array.isArray(n) || n.length < 2) return;
                            const rawDir = n[1];
                            if (rawDir < 0) return;

                            this.notes.push({
                                time: n[0],
                                dir: rawDir % 4,
                                isPlayer: (rawDir < 4),
                                sustain: n[2] || 0,
                                hit: false, missed: false, sprite: null, tailSprite: null
                            });
                        });
                    }
                });
            }
        }

        // Sort chronologically
        this.notes.sort((a, b) => a.time - b.time);

        // Build sprites
        this.notes.forEach(n => {
            const spr = new PIXI.Graphics();
            drawArrowShape(spr, NOTE_COLORS[n.dir], 32);
            spr.rotation = ARROW_ANGLES[n.dir];
            spr.visible = false;
            this.container.addChild(spr);
            n.sprite = spr;

            if (n.sustain > 50) {
                const tail = new PIXI.Graphics();
                tail.visible = false;
                this.container.addChildAt(tail, 0);
                n.tailSprite = tail;
            }
        });

        console.log(`[GAMEPLAY] Parsed ${this.notes.length} notes for this song!`);
    }

    setupHUD() {
        this.scoreText = new PIXI.Text('Score: 0 | Combo: 0', {
            fontFamily: 'Segoe UI, sans-serif',
            fontSize: 22,
            fill: 0xffffff,
            align: 'center'
        });
        this.scoreText.anchor.set(0.5);
        this.scoreText.position.set(1280 / 2, 670);
        this.container.addChild(this.scoreText);

        this.ratingText = new PIXI.Text('', {
            fontFamily: 'Segoe UI, sans-serif',
            fontSize: 36,
            fontWeight: 'bold',
            fill: 0x00d2d3,
            align: 'center'
        });
        this.ratingText.anchor.set(0.5);
        this.ratingText.position.set(1280 / 2, 350);
        this.container.addChild(this.ratingText);
    }

    update() {
        const songPos = Conductor.songPosition;
        const receptorY = 100;
        const scrollMult = 0.32 * this.speed;

        this.receptors.forEach(r => {
            r.container.scale.x += (1.0 - r.container.scale.x) * 0.2;
            r.container.scale.y += (1.0 - r.container.scale.y) * 0.2;
        });

        for (let i = 0; i < this.notes.length; i++) {
            const n = this.notes[i];
            if (n.hit || n.missed) continue;

            const diff = n.time - songPos;

            // Opponent Auto-play
            if (!n.isPlayer && diff <= 0) {
                n.hit = true;
                n.sprite.visible = false;
                if (n.tailSprite) n.tailSprite.visible = false;
                this.hitReceptor(n.dir, false);
                continue;
            }

            // Player Note Miss
            if (n.isPlayer && diff < -150) {
                n.missed = true;
                n.sprite.visible = false;
                if (n.tailSprite) n.tailSprite.visible = false;
                this.combo = 0;
                this.score = Math.max(0, this.score - 100);
                this.showRating("MISS", 0xff334b);
                this.updateScore();
                continue;
            }

            // Render Notes in Viewport
            if (diff > -200 && diff < 1600) {
                const targetReceptor = this.receptors[n.isPlayer ? n.dir + 4 : n.dir];
                const noteY = receptorY + (diff * scrollMult);

                n.sprite.position.set(targetReceptor.container.x, noteY);
                n.sprite.visible = true;

                if (n.tailSprite) {
                    const tailHeight = n.sustain * scrollMult;
                    n.tailSprite.clear();
                    n.tailSprite.beginFill(NOTE_COLORS[n.dir], 0.6);
                    n.tailSprite.drawRect(-8, 0, 16, tailHeight);
                    n.tailSprite.endFill();
                    n.tailSprite.position.set(targetReceptor.container.x, noteY);
                    n.tailSprite.visible = true;
                }
            } else {
                n.sprite.visible = false;
                if (n.tailSprite) n.tailSprite.visible = false;
            }
        }
    }

    hitReceptor(dir, isPlayer) {
        const r = this.receptors[isPlayer ? dir + 4 : dir];
        r.container.scale.set(1.22);
        drawArrowShape(r.arrow, NOTE_COLORS[dir], 32);
        setTimeout(() => {
            drawArrowShape(r.arrow, 0x8a95aa, 28);
        }, 110);
    }

    onKeyPress(dir) {
        const songPos = Conductor.songPosition;
        this.hitReceptor(dir, true);

        let closest = null;
        let minDiff = Infinity;

        for (let i = 0; i < this.notes.length; i++) {
            const n = this.notes[i];
            if (n.isPlayer && n.dir === dir && !n.hit && !n.missed) {
                const diff = Math.abs(n.time - songPos);
                if (diff < minDiff && diff <= 150) {
                    minDiff = diff;
                    closest = n;
                }
            }
        }

        if (closest) {
            closest.hit = true;
            closest.sprite.visible = false;
            if (closest.tailSprite) closest.tailSprite.visible = false;
            this.combo++;

            if (minDiff <= 45) {
                this.score += 350;
                this.showRating("SICK!", 0x00d2d3);
            } else if (minDiff <= 90) {
                this.score += 200;
                this.showRating("GOOD", 0x2ed573);
            } else {
                this.score += 50;
                this.showRating("BAD", 0xffa502);
            }

            this.updateScore();
        }
    }

    showRating(text, color) {
        this.ratingText.text = text;
        this.ratingText.style.fill = color;
        this.ratingText.scale.set(1.35);
    }

    updateScore() {
        this.scoreText.text = `Score: ${this.score} | Combo: ${this.combo}`;
    }

    destroy() {
        app.stage.removeChild(this.container);
        this.container.destroy({ children: true });
    }
}

function onBeatHit(beat) {
    if (playState) {
        playState.receptors.forEach(r => {
            r.container.scale.set(1.08);
        });
    }
}

app.ticker.add((delta) => {
    Conductor.update();

    if (playState && Conductor.isPlaying) {
        playState.update();
        if (playState.ratingText && playState.ratingText.scale.x > 1.0) {
            playState.ratingText.scale.x -= delta * 0.05;
            playState.ratingText.scale.y -= delta * 0.05;
        }
    }
});

const KEY_MAP = {
    'KeyD': 0, 'ArrowLeft': 0,
    'KeyF': 1, 'ArrowDown': 1,
    'KeyJ': 2, 'ArrowUp': 2,
    'KeyK': 3, 'ArrowRight': 3
};

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        returnToFreeplay();
        return;
    }

    if (playState && KEY_MAP[e.code] !== undefined) {
        if (!e.repeat) {
            playState.onKeyPress(KEY_MAP[e.code]);
        }
    }
});

// --- AUDIO RESOLVER & LAUNCHER ---
async function launchSong(item) {
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }

    freeplayScreen.classList.add('hidden');
    gameContainer.classList.remove('hidden');

    if (playState) playState.destroy();

    const songId = item.id.toLowerCase();
    const cleanId = songId.replace(/[^a-z0-9]/g, '');

    const audioToLoad = [];

    // Finds matching audio regardless of folder structure
    for (const [path, entry] of Object.entries(VirtualFS.assets)) {
        const cleanPath = path.replace(/[^a-z0-9\/\.]/g, '');
        if (cleanPath.includes(`/${cleanId}/`) || cleanPath.includes(`songs/${cleanId}`) || cleanPath.includes(`/${cleanId}-inst`) || cleanPath.includes(`/${cleanId}-voices`)) {
            if (cleanPath.endsWith('.ogg')) {
                audioToLoad.push({ path, entry });
            }
        }
    }

    if (audioToLoad.length === 0) {
        alert(`No .ogg audio files found for song: ${item.name}`);
        returnToFreeplay();
        return;
    }

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
        }

        playState = new PlayStateScene(item);

        const playTime = audioCtx.currentTime + 0.1;
        Conductor.activeSources.forEach(s => s.start(playTime));
        Conductor.start();

    } catch(err) {
        console.error("Audio playback error:", err);
        alert("Failed to start song. Check console (F12).");
        returnToFreeplay();
    }
}

function returnToFreeplay() {
    Conductor.stop();
    if (playState) {
        playState.destroy();
        playState = null;
    }

    gameContainer.classList.add('hidden');
    freeplayScreen.classList.remove('hidden');
}
