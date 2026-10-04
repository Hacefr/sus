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

        if (path.endsWith('.frag')) {
            const p = entry.async('string').then(shaderCode => {
                const shaderName = path.split('/').pop().replace('.frag', '');
                VirtualFS.shaders[shaderName] = shaderCode;
            });
            scanPromises.push(p);
        }

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

// --- ARROW RECEPTOR GRAPHICS & COLORS ---
const NOTE_COLORS = [0xc24b99, 0x00ffff, 0x12fa05, 0xf9393f]; // Left (Purple), Down (Cyan), Up (Green), Right (Red)
const ARROW_ANGLES = [-Math.PI / 2, 0, Math.PI, Math.PI / 2];

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

// --- GAMEPLAY MANAGER ---
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

    parseChartNotes(chart) {
        this.notes = [];

        // 1. CODENAME ENGINE STRUM LINES
        if (chart.strumLines && Array.isArray(chart.strumLines)) {
            chart.strumLines.forEach((strum, lineIndex) => {
                const isPlayer = (strum.type === 1) || (lineIndex === 1);
                if (strum.notes) {
                    strum.notes.forEach(n => {
                        this.notes.push({
                            time: n.time,
                            dir: n.id % 4,
                            isPlayer: isPlayer,
                            sustain: n.sLen || 0,
                            hit: false,
                            missed: false,
                            sprite: null,
                            tailSprite: null
                        });
                    });
                }
            });
        }
        // 2. PSYCH / LEATHER / NMV2 NOTES
        else {
            const songData = chart.song ? chart.song : chart;
            if (songData.notes) {
                songData.notes.forEach(section => {
                    if (section.sectionNotes) {
                        section.sectionNotes.forEach(n => {
                            const rawDir = n[1];
                            if (rawDir < 0) return; // skip events

                            // NMV2 / Psych Rule: 0..3 is Player, 4..7 is Opponent!
                            const isPlayer = (rawDir < 4);
                            const dir = rawDir % 4;

                            this.notes.push({
                                time: n[0],
                                dir: dir,
                                isPlayer: isPlayer,
                                sustain: n[2] || 0,
                                hit: false,
                                missed: false,
                                sprite: null,
                                tailSprite: null
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

            // Hold Trail (Sustain)
            if (n.sustain > 50) {
                const tail = new PIXI.Graphics();
                tail.visible = false;
                this.container.addChildAt(tail, 0); // behind arrow
                n.tailSprite = tail;
            }
        });

        console.log(`[GAMEPLAY] Parsed ${this.notes.length} total notes!`);
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
        
        // Calibrated smooth scroll multiplier (authentic reaction window)
        const scrollMult = 0.32 * this.speed;

        // Reset strum bounces smoothly
        this.receptors.forEach(r => {
            r.container.scale.x += (1.0 - r.container.scale.x) * 0.2;
            r.container.scale.y += (1.0 - r.container.scale.y) * 0.2;
        });

        // Update Note Positions
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

                // Render Hold Trail
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

// --- TICKER LOOP ---
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

// --- KEYBOARD CONTROLS (D-F-J-K & ARROWS) ---
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
    const audioToLoad = [];

    for (const [path, entry] of Object.entries(VirtualFS.assets)) {
        if (path.includes(`/${songId}/`) || path.includes(`songs/${songId}`)) {
            if (path.endsWith('.ogg')) {
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

// --- EXIT BACK TO FREEPLAY ---
function returnToFreeplay() {
    Conductor.stop();
    if (playState) {
        playState.destroy();
        playState = null;
    }

    gameContainer.classList.add('hidden');
    freeplayScreen.classList.remove('hidden');
}
