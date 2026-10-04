// --- 1. INITIALIZE PIXI.JS (Hardware-Accelerated WebGL) ---
const app = new PIXI.Application({
    width: 1280,
    height: 720,
    backgroundColor: 0x07080c,
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

// --- 4. UNIVERSAL SCANNER ---
async function ingestZip(file) {
    statusBox.innerText = `Scanning: ${file.name}...`;
    const zip = await JSZip.loadAsync(file);

    statusBox.innerText = `Indexing charts & visual assets...`;
    const scanPromises = [];
    const vsliceMeta = {};
    const vsliceCharts = {};

    zip.forEach((rawPath, entry) => {
        if (entry.dir) return;

        const path = rawPath.toLowerCase().replace(/\\/g, '/');
        VirtualFS.assets[path] = entry;

        if (path.endsWith('.frag')) {
            const p = entry.async('string').then(shaderCode => {
                const shaderName = path.split('/').pop().replace('.frag', '');
                VirtualFS.shaders[shaderName] = shaderCode;
            });
            scanPromises.push(p);
        }

        if (path.endsWith('-metadata.json')) {
            const p = entry.async('string').then(text => {
                try {
                    const parsed = JSON.parse(text.replace(/^\uFEFF/, '').replace(/\/\/.*$/gm, ''));
                    const songName = path.split('/').pop().replace('-metadata.json', '');
                    vsliceMeta[songName] = parsed;
                } catch(e) {}
            });
            scanPromises.push(p);
        }

        if (path.endsWith('-chart.json')) {
            const p = entry.async('string').then(text => {
                try {
                    const parsed = JSON.parse(text.replace(/^\uFEFF/, '').replace(/\/\/.*$/gm, ''));
                    const songName = path.split('/').pop().replace('-chart.json', '');
                    vsliceCharts[songName] = { parsed, path };
                } catch(e) {}
            });
            scanPromises.push(p);
        }

        if (path.endsWith('.json') && !path.includes('/stages/') && !path.includes('events.json') && !path.endsWith('-metadata.json') && !path.endsWith('-chart.json')) {
            const p = entry.async('string').then(jsonText => {
                try {
                    const cleanJson = jsonText.replace(/^\uFEFF/, '').replace(/\/\/.*$/gm, '');
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
                                stage: songData.stage || parsed.stage || 'security',
                                player1: songData.player1 || parsed.player1 || 'bf',
                                player2: songData.player2 || parsed.player2 || 'noob49',
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

        const playData = meta.playData || {};
        const chars = playData.characters || {};

        let opponent = chars.opponent || meta.opponent || parsed.player2;
        if (!opponent) {
            if (songKey.includes('49')) opponent = 'noob49';
            else if (songKey.includes('trot')) opponent = 'horsemate';
            else if (songKey.includes('threat')) opponent = 'maroonthreat';
            else opponent = 'noob49';
        }

        const player = chars.player || meta.player || parsed.player1 || 'bf';
        const stage = playData.stage || meta.stage || parsed.stage || 'security';

        VirtualFS.charts[songKey] = {
            id: songKey,
            name: String(songName),
            bpm: bpm,
            speed: parseFloat(cleanSpeed) || 2.5,
            stage: stage,
            player1: player,
            player2: opponent,
            chartData: parsed,
            chartPath: cObj.path
        };
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
                <span>Opponent: <strong>${item.player2}</strong></span>
                <span>BPM: <strong>${item.bpm}</strong></span>
            </div>
        `;

        card.onclick = () => launchSong(item);
        songGrid.appendChild(card);
    });
}

// ========================================================
// --- CONDUCTOR & TIMING ---
// ========================================================

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

const Conductor = {
    bpm: 100,
    crochet: 600,
    stepCrochet: 150,
    songPosition: 0,
    lastBeat: -1,
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

        if (this.curBeat > this.lastBeat) {
            this.lastBeat = this.curBeat;
            onBeatHit(this.curBeat);
        }
    }
};

// ========================================================
// --- DYNAMIC TEXTURE ATLAS CHARACTER (MX + M3D SUPPORT) ---
// ========================================================

const NOTE_COLORS = [0xc24b99, 0x00ffff, 0x12fa05, 0xf9393f]; 
const ARROW_ANGLES = [-Math.PI / 2, Math.PI, 0, Math.PI / 2];

function extractMatrix(el) {
    if (el.MX) {
        return new PIXI.Matrix(...el.MX);
    } else if (el.M3D) {
        return new PIXI.Matrix(el.M3D[0], el.M3D[1], el.M3D[4], el.M3D[5], el.M3D[12], el.M3D[13]);
    }
    return new PIXI.Matrix();
}

class DynamicAtlasCharacter {
    constructor(baseTexture, animJson, spritemapJson, isPlayer = false, isGF = false) {
        this.isPlayer = isPlayer;
        this.isGF = isGF;
        this.container = new PIXI.Container();
        this.displayContainer = new PIXI.Container();
        this.container.addChild(this.displayContainer);

        this.spritemap = {};
        for (const item of spritemapJson.ATLAS.SPRITES) {
            const s = item.SPRITE;
            this.spritemap[s.name] = new PIXI.Texture(baseTexture, new PIXI.Rectangle(s.x, s.y, s.w, s.h));
        }

        this.symbols = {};
        if (animJson.SD && animJson.SD.S) {
            for (const s of animJson.SD.S) {
                this.symbols[s.SN] = s;
            }
        }

        const rootMatrices = {};
        if (animJson.AN && animJson.AN.TL && animJson.AN.TL.L) {
            for (const layer of animJson.AN.TL.L) {
                for (const fr of layer.FR || []) {
                    for (const el of fr.E || []) {
                        if (el.SI && el.SI.SN) {
                            rootMatrices[el.SI.SN] = extractMatrix(el.SI);
                        }
                    }
                }
            }
        }

        this.animMap = {};
        this.animMatrices = {};
        
        for (const symName of Object.keys(this.symbols)) {
            const lower = symName.toLowerCase();
            const isCopyOrAlt = lower.includes('copy') || lower.includes('alt') || lower.includes('shift') || lower.includes('dark');

            const assignAnim = (key) => {
                this.animMap[key] = symName;
                this.animMatrices[key] = rootMatrices[symName] || new PIXI.Matrix();
            };

            if (this.isGF) {
                if (lower.includes('idle1') || lower.includes('idleleft')) assignAnim('idleleft');
                if (lower.includes('idle2') || lower.includes('idleright')) assignAnim('idleright');
                if (lower.includes('cheer')) assignAnim('cheer');
                if (lower.includes('sad')) assignAnim('sad');
            } else {
                if (lower.includes('idle') && !isCopyOrAlt && !this.animMap['idle']) assignAnim('idle');
                else if (lower.includes('left') && !lower.includes('miss') && !isCopyOrAlt && !this.animMap['left']) {
                    assignAnim('left'); assignAnim('singleft');
                }
                else if (lower.includes('down') && !lower.includes('miss') && !isCopyOrAlt && !this.animMap['down']) {
                    assignAnim('down'); assignAnim('singdown');
                }
                else if (lower.includes('up') && !lower.includes('miss') && !isCopyOrAlt && !this.animMap['up']) {
                    assignAnim('up'); assignAnim('singup');
                }
                else if (lower.includes('right') && !lower.includes('miss') && !isCopyOrAlt && !this.animMap['right']) {
                    assignAnim('right'); assignAnim('singright');
                }

                if (lower.includes('miss')) {
                    if (lower.includes('left')) assignAnim('singleftmiss');
                    if (lower.includes('down')) assignAnim('singdownmiss');
                    if (lower.includes('up')) assignAnim('singupmiss');
                    if (lower.includes('right')) assignAnim('singrightmiss');
                }
            }
        }

        this.currentAnim = this.isGF ? 'idleleft' : 'idle';
        this.frame = 0;
        this.frameTimer = 0;
        this.holdTimer = 0;
        this.fps = 24;

        const scale = 0.65;
        this.container.scale.set(this.isPlayer ? scale : (this.isGF ? scale : -scale), scale);

        this.renderCurrentFrame();
    }

    playAnim(animName, forced = false) {
        const clean = animName.toLowerCase().replace(/[^a-z0-9]/g, '');
        let targetKey = Object.keys(this.animMap).find(k => k === clean || clean.includes(k));

        if (!targetKey && animName.includes('idle')) targetKey = this.isGF ? 'idleleft' : 'idle';
        if (!targetKey) targetKey = this.isGF ? 'idleleft' : 'idle';

        if (this.animMap[targetKey]) {
            this.currentAnim = targetKey;
            this.frame = 0;
            this.frameTimer = 0;
            if (!targetKey.includes('idle')) {
                this.holdTimer = 0.35;
            }
            this.renderCurrentFrame();
        }
    }

    renderCurrentFrame() {
        const symName = this.animMap[this.currentAnim];
        const sym = this.symbols[symName];
        if (!sym) return;

        this.displayContainer.removeChildren();

        const self = this;
        function renderSymbol(name, frameNum, parentMat, target) {
            const currentSym = self.symbols[name];
            if (!currentSym || !currentSym.TL || !currentSym.TL.L) return;

            for (let l = currentSym.TL.L.length - 1; l >= 0; l--) {
                const layer = currentSym.TL.L[l];
                if (!layer.FR || layer.FR.length === 0) continue;

                let activeFR = null;
                for (const fr of layer.FR) {
                    if (frameNum >= fr.I && frameNum < fr.I + fr.DU) {
                        activeFR = fr;
                        break;
                    }
                }

                if (!activeFR) activeFR = layer.FR[layer.FR.length - 1];
                if (!activeFR || !activeFR.E) continue;

                for (const el of activeFR.E) {
                    if (el.ASI) {
                        const tex = self.spritemap[el.ASI.N];
                        if (tex) {
                            const spr = new PIXI.Sprite(tex);
                            const localMat = extractMatrix(el.ASI);
                            const finalMat = parentMat.clone().append(localMat);
                            spr.transform.setFromMatrix(finalMat);
                            target.addChild(spr);
                        }
                    } else if (el.SI) {
                        let subFrame = 0;
                        if (el.SI.LP === "SF") {
                            subFrame = el.SI.FF || 0;
                        } else {
                            subFrame = (frameNum - activeFR.I + (el.SI.FF || 0));
                        }

                        const localMat = extractMatrix(el.SI);
                        const finalMat = parentMat.clone().append(localMat);
                        renderSymbol(el.SI.SN, subFrame, finalMat, target);
                    }
                }
            }
        }

        const animMatrix = this.animMatrices[this.currentAnim] || new PIXI.Matrix();
        const rootMat = animMatrix.clone();
        
        if (this.isPlayer) {
            rootMat.translate(-405, -280);
        } else if (this.isGF) {
            rootMat.translate(-350, -320);
        } else {
            rootMat.translate(-200, -320);
        }

        renderSymbol(symName, this.frame, rootMat, this.displayContainer);
    }

    update(deltaSec) {
        if (this.holdTimer > 0) {
            this.holdTimer -= deltaSec;
            if (this.holdTimer <= 0) {
                this.playAnim(this.isGF ? 'idleleft' : 'idle');
            }
        }

        this.frameTimer += deltaSec;
        if (this.frameTimer >= (1 / this.fps)) {
            this.frameTimer = 0;
            this.frame++;

            const symName = this.animMap[this.currentAnim];
            const sym = this.symbols[symName];
            if (sym) {
                let maxFrames = 1;
                for (const layer of sym.TL.L || []) {
                    for (const fr of layer.FR || []) {
                        maxFrames = Math.max(maxFrames, fr.I + fr.DU);
                    }
                }

                if (this.frame >= maxFrames) {
                    this.frame = (this.currentAnim.includes('idle')) ? 0 : maxFrames - 1;
                }
            }

            this.renderCurrentFrame();
        }
    }
}

function createFallbackCharacter(colorHex, isPlayer) {
    const cont = new PIXI.Container();
    const g = new PIXI.Graphics();
    
    g.beginFill(colorHex, 0.8);
    g.drawRoundedRect(isPlayer ? 35 : -95, -180, 60, 110, 16);
    g.endFill();

    g.beginFill(colorHex);
    g.drawRoundedRect(-60, -220, 120, 220, 45);
    g.endFill();

    g.beginFill(0x80dfff);
    g.drawRoundedRect(isPlayer ? -75 : 5, -170, 70, 45, 18);
    g.endFill();

    cont.addChild(g);
    return {
        container: cont,
        playAnim: () => {
            cont.scale.set(1.08);
            setTimeout(() => cont.scale.set(1.0), 100);
        },
        update: () => {}
    };
}

// ========================================================
// --- STAGE & GAMEPLAY SCENE ---
// ========================================================

let playState = null;

class PlayStateScene {
    constructor(songItem, dadChar, bfChar, gfChar, stageData) {
        this.songItem = songItem;
        this.speed = songItem.speed || 2.5;

        this.worldContainer = new PIXI.Container();
        this.hudContainer = new PIXI.Container();

        this.dad = dadChar;
        this.bf = bfChar;
        this.gf = gfChar;

        this.notes = [];
        this.receptors = [];
        this.score = 0;
        this.combo = 0;
        this.gfDanceLeft = false;

        this.camTargetX = 640;
        this.camZoom = 1.05;
        this.baseZoom = 1.05;

        this.setupStage(stageData);
        this.setupCharacters();
        this.setupStrumlines();
        this.parseChartNotes(songItem.chartData);
        this.setupHUD();

        app.stage.addChild(this.worldContainer);
        app.stage.addChild(this.hudContainer);
    }

    setupStage(stageData) {
        this.stageBack = new PIXI.Container();
        this.stageFront = new PIXI.Container();

        if (stageData && stageData.wall) {
            // PROPORTION CALCULATOR: Fits 1080p artwork to 720p canvas
            const rawWidth = stageData.wall.width || 1920;
            const stageScale = 1280 / rawWidth;

            // 1. Wall, Floor & Carpet
            const wall = new PIXI.Sprite(stageData.wall);
            wall.anchor.set(0.5);
            wall.position.set(640, 360);
            wall.scale.set(stageScale);
            this.stageBack.addChild(wall);

            // 2. Wall Shelf with Party Hat & Frame (props.png)
            if (stageData.props) {
                const wallProps = new PIXI.Sprite(stageData.props);
                wallProps.anchor.set(0.5);
                wallProps.position.set(640, 360);
                wallProps.scale.set(stageScale);
                this.stageBack.addChild(wallProps);
            }

            // 3. Cabinets (Spans left shelf and right cabinet in 1 image!)
            if (stageData.cabinets) {
                const cabs = new PIXI.Sprite(stageData.cabinets);
                cabs.anchor.set(0.5);
                cabs.position.set(640, 360);
                cabs.scale.set(stageScale);
                this.stageBack.addChild(cabs);
            }

            // 4. Security Desk with Laptop & Flower Pot (Snaps right onto desk shadow!)
            if (stageData.table) {
                const desk = new PIXI.Sprite(stageData.table);
                desk.anchor.set(0.5);
                desk.position.set(640, 360);
                desk.scale.set(stageScale);
                this.stageBack.addChild(desk);
            }

            // 5. Overhead Spotlight Beam (Overlay)
            if (stageData.light) {
                const light = new PIXI.Sprite(stageData.light);
                light.anchor.set(0.5);
                light.position.set(640, 360);
                light.scale.set(stageScale);
                light.blendMode = PIXI.BLEND_MODES.ADD;
                light.alpha = 0.55;
                this.stageFront.addChild(light);
            }

            // 6. Vignette Shadow Overlay
            if (stageData.vignette) {
                const vig = new PIXI.Sprite(stageData.vignette);
                vig.anchor.set(0.5);
                vig.position.set(640, 360);
                vig.scale.set(stageScale);
                this.stageFront.addChild(vig);
            }
        } else {
            const bg = new PIXI.Graphics();
            bg.beginFill(0x0c0f18);
            bg.drawRect(-400, -200, 2080, 1120);
            bg.endFill();

            for (let i = 0; i < 70; i++) {
                bg.beginFill(0xffffff, Math.random() * 0.8 + 0.2);
                bg.drawCircle(Math.random() * 1920 - 320, Math.random() * 1080 - 180, Math.random() * 2.5 + 1);
                bg.endFill();
            }

            bg.beginFill(0x191e2b);
            bg.drawRect(-400, 520, 2080, 600);
            bg.endFill();
            this.stageBack.addChild(bg);
        }

        this.worldContainer.addChild(this.stageBack);
    }

    setupCharacters() {
        // 1. Centerpiece: Girlfriend on Speakers (Sitting between desk and carpet!)
        if (this.gf) {
            this.gf.container.position.set(620, 560);
            this.worldContainer.addChild(this.gf.container);
        }

        // 2. Noob49 on the Front Left Floor!
        this.dad.container.position.set(230, 640);
        this.worldContainer.addChild(this.dad.container);

        // 3. Boyfriend on the Front Right Carpet!
        this.bf.container.position.set(980, 640);
        this.worldContainer.addChild(this.bf.container);

        this.worldContainer.addChild(this.stageFront);
    }

    setupStrumlines() {
        const startX_Opponent = 120;
        const startX_Player = 760;
        const receptorY = 90;
        const spacing = 110;

        for (let i = 0; i < 8; i++) {
            const isPlayer = i >= 4;
            const dir = i % 4;
            const x = (isPlayer ? startX_Player : startX_Opponent) + (dir * spacing);

            const receptor = new PIXI.Container();
            receptor.position.set(x, receptorY);

            const base = new PIXI.Graphics();
            base.lineStyle(4, 0x3d4457, 1);
            base.drawCircle(0, 0, 42);
            receptor.addChild(base);

            const arrow = new PIXI.Graphics();
            drawArrowShape(arrow, 0x8a95aa, 28);
            arrow.rotation = ARROW_ANGLES[dir];
            receptor.addChild(arrow);

            this.receptors.push({ container: receptor, dir, isPlayer, arrow, base });
            this.hudContainer.addChild(receptor);
        }
    }

    parseChartNotes(chart) {
        this.notes = [];
        if (!chart) return;

        const data = chart.chartData || chart;
        const songObj = (data.song && typeof data.song === 'object') ? data.song : data;

        // V-SLICE
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

        // CODENAME
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

        // PSYCH / NMV2
        if (this.notes.length === 0) {
            let sections = songObj.notes || data.notes || [];
            if (sections && typeof sections === 'object' && !Array.isArray(sections)) {
                sections = Object.values(sections);
            }

            if (Array.isArray(sections)) {
                sections.forEach(section => {
                    if (section && Array.isArray(section.sectionNotes)) {
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

        this.notes.sort((a, b) => a.time - b.time);

        this.notes.forEach(n => {
            const spr = new PIXI.Graphics();
            drawArrowShape(spr, NOTE_COLORS[n.dir], 32);
            spr.rotation = ARROW_ANGLES[n.dir];
            spr.visible = false;
            this.hudContainer.addChild(spr);
            n.sprite = spr;

            if (n.sustain > 50) {
                const tail = new PIXI.Graphics();
                tail.visible = false;
                this.hudContainer.addChildAt(tail, 0);
                n.tailSprite = tail;
            }
        });
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
        this.hudContainer.addChild(this.scoreText);

        this.ratingText = new PIXI.Text('READY!', {
            fontFamily: 'Segoe UI, sans-serif',
            fontSize: 48,
            fontWeight: 'bold',
            fill: 0x00d2d3,
            align: 'center'
        });
        this.ratingText.anchor.set(0.5);
        this.ratingText.position.set(1280 / 2, 350);
        this.hudContainer.addChild(this.ratingText);
    }

    update(deltaSec) {
        const songPos = Conductor.songPosition;
        const receptorY = 90;
        const scrollMult = 0.32 * this.speed;

        this.dad.update(deltaSec);
        this.bf.update(deltaSec);
        if (this.gf) this.gf.update(deltaSec);

        const currentCamX = this.worldContainer.position.x;
        const targetX = 640 - (this.camTargetX - 640) * this.camZoom;
        this.worldContainer.position.x += (targetX - currentCamX) * 0.05;

        this.camZoom += (this.baseZoom - this.camZoom) * 0.08;
        this.worldContainer.scale.set(this.camZoom);
        this.worldContainer.pivot.set(640, 360);
        this.worldContainer.position.set(640, 360);

        this.receptors.forEach(r => {
            r.container.scale.x += (1.0 - r.container.scale.x) * 0.2;
            r.container.scale.y += (1.0 - r.container.scale.y) * 0.2;
        });

        for (let i = 0; i < this.notes.length; i++) {
            const n = this.notes[i];
            if (n.hit || n.missed) continue;

            const diff = n.time - songPos;

            // Opponent Sings
            if (!n.isPlayer && diff <= 0) {
                n.hit = true;
                n.sprite.visible = false;
                if (n.tailSprite) n.tailSprite.visible = false;
                this.hitReceptor(n.dir, false);

                const anims = ['left', 'down', 'up', 'right'];
                this.dad.playAnim(anims[n.dir], true);
                this.camTargetX = 500;
                continue;
            }

            // Player Miss
            if (n.isPlayer && diff < -150) {
                n.missed = true;
                n.sprite.visible = false;
                if (n.tailSprite) n.tailSprite.visible = false;
                this.combo = 0;
                this.score = Math.max(0, this.score - 100);
                this.showRating("MISS", 0xff334b);
                this.updateScore();

                const missAnims = ['singleftmiss', 'singdownmiss', 'singupmiss', 'singrightmiss'];
                this.bf.playAnim(missAnims[n.dir] || 'singleftmiss', true);
                continue;
            }

            // Draw Note
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
        
        const anims = ['left', 'down', 'up', 'right'];
        this.bf.playAnim(anims[dir], true);
        this.camTargetX = 820;

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
        app.stage.removeChild(this.worldContainer);
        app.stage.removeChild(this.hudContainer);
        this.worldContainer.destroy({ children: true });
        this.hudContainer.destroy({ children: true });
    }
}

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

function onBeatHit(beat) {
    if (playState) {
        playState.camZoom = playState.baseZoom + 0.035;

        // Girlfriend dances left and right alternating beats!
        if (playState.gf) {
            playState.gfDanceLeft = !playState.gfDanceLeft;
            playState.gf.playAnim(playState.gfDanceLeft ? 'idleleft' : 'idleright', true);
        }

        if (playState.dad.holdTimer <= 0) playState.dad.playAnim('idle');
        if (playState.bf.holdTimer <= 0) playState.bf.playAnim('idle');

        playState.receptors.forEach(r => {
            r.container.scale.set(1.06);
        });
    }
}

app.ticker.add((delta) => {
    const deltaSec = delta / 60;
    Conductor.update();

    if (playState) {
        playState.update(deltaSec);
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

// --- ADVANCED UNIVERSAL CHARACTER LOADER ---
async function loadCharacter(charName, isPlayer, isGF = false) {
    const clean = charName.toLowerCase().trim();

    let animJsonEntry = null;
    let spritemapJsonEntry = null;
    let spritemapPngEntry = null;

    for (const [path, entry] of Object.entries(VirtualFS.assets)) {
        let isMatch = false;

        if (isGF) {
            isMatch = path.includes('characters/cosmicube/gf') || path.includes('characters/gf') || path.includes('/gf/');
        } else if (isPlayer) {
            isMatch = path.includes('characters/cosmicube/bf') || path.includes('characters/bf') || path.includes('/bf/');
        } else {
            isMatch = path.includes(`/${clean}/`) || path.includes(`characters/dlc/${clean}/`);
        }

        if (isMatch) {
            if (path.endsWith('animation.json')) animJsonEntry = entry;
            if (path.endsWith('spritemap1.json')) spritemapJsonEntry = entry;
            if (path.endsWith('spritemap1.png')) spritemapPngEntry = entry;
        }
    }

    if (animJsonEntry && spritemapJsonEntry && spritemapPngEntry) {
        try {
            // FIXED: Strips UTF-8 BOM (\uFEFF) so JSON.parse never crashes!
            const animText = (await animJsonEntry.async('string')).replace(/^\uFEFF/, '').trim();
            const spritemapText = (await spritemapJsonEntry.async('string')).replace(/^\uFEFF/, '').trim();

            const animJson = JSON.parse(animText);
            const spritemapJson = JSON.parse(spritemapText);
            const pngBlob = await spritemapPngEntry.async('blob');

            const img = new Image();
            img.src = URL.createObjectURL(pngBlob);
            await new Promise(res => img.onload = res);

            const baseTexture = new PIXI.BaseTexture(img);
            console.log(`%c[TEXTURE ATLAS LOADED] ${charName.toUpperCase()}`, "color: #00d2d3; font-weight: bold;");
            
            return new DynamicAtlasCharacter(baseTexture, animJson, spritemapJson, isPlayer, isGF);
        } catch(err) {
            console.warn(`Failed loading Texture Atlas for ${charName}:`, err);
        }
    }

    return createFallbackCharacter(isPlayer ? 0x00d2d3 : (isGF ? 0xa55eea : 0xff334b), isPlayer);
}

// --- LAUNCH SONG ---
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

        // 1. Load All 3 Characters: Noob49, BF, and GF!
        const dadChar = await loadCharacter(item.player2, false, false);
        const bfChar = await loadCharacter('bf', true, false);
        const gfChar = await loadCharacter('gf', false, true);

        // 2. Load Stage Pieces
        const stageData = {};
        const stageAssets = ['wall', 'cabinets', 'table', 'props', 'light', 'vignette'];

        for (const [path, entry] of Object.entries(VirtualFS.assets)) {
            if (path.includes('bg/security/')) {
                for (const key of stageAssets) {
                    if (path.endsWith(`${key}.png`)) {
                        const blob = await entry.async('blob');
                        const img = new Image();
                        img.src = URL.createObjectURL(blob);
                        await new Promise(res => img.onload = res);
                        stageData[key] = PIXI.Texture.from(img);
                    }
                }
            }
        }

        playState = new PlayStateScene(item, dadChar, bfChar, gfChar, stageData);

        setTimeout(() => {
            if (playState) {
                playState.showRating("GO!", 0x2ed573);
                const playTime = audioCtx.currentTime + 0.05;
                Conductor.activeSources.forEach(s => s.start(playTime));
                Conductor.start();
            }
        }, 1500);

    } catch(err) {
        console.error("Launch error:", err);
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
